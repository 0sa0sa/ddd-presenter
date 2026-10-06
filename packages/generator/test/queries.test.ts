/**
 * Read side and PostgreSQL persistence (`queries:`): what both targets emit, that they embed the same SQL from the
 * shared emitter, that models without queries are untouched, and — with PGlite (PostgreSQL in WebAssembly, with
 * pg_trgm) — that the generated DDL, repositories and readers really run: keyset paging across pages, trigram results
 * and order equal to the in-memory readers, the trigram GIN index used, optimistic locking.
 */
import { describe, expect, test } from "bun:test";
import { planQuery, validateModelText } from "@ddd/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatePython, generateTypeScript, type GenerationOutput } from "../src/index.ts";
import { psycopgText, queryStatements, repositorySql } from "../src/sql.ts";
import { TS_API_DEPENDENCIES, TS_DEPENDENCIES } from "../src/typescript/index.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const QUERIES = fixture("queries.ddd.yaml");
const OTHERS = ["kitchen-sink.ddd.yaml", "context-map.ddd.yaml", "ordering.ddd.yaml", "long-rules.ddd.yaml", "identities.ddd.yaml"].map(fixture);

function analyze(text: string) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  return r.analysis!;
}

function asTypeScript(text: string, api = true): string {
  return text.replace(/^generation:\n/m, `generation:\n  target: typescript\n  typescript:\n    test_runner: bun\n${api ? "    api: { base_path: /api }\n" : ""}`);
}

const ts = (text = QUERIES, api = true) => generateTypeScript(analyze(asTypeScript(text, api)), asTypeScript(text, api));
const py = (text = QUERIES) => generatePython(analyze(text), text);
const file = (out: GenerationOutput, path: string) => {
  const f = out.files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in ${out.files.map((x) => x.path).join(", ")}`);
  return f.content;
};

describe("queries: what the generators emit", () => {
  test("layout: read side, persistence and DDL for contexts with queries, in both targets", () => {
    const t = ts().files.map((f) => f.path);
    for (const p of [
      "sql/directory.sql",
      "src/member_directory/generated/persistence.ts",
      "src/member_directory/generated/directory/application/queries.ts",
      "src/member_directory/generated/directory/persistence/rows.ts",
      "src/member_directory/generated/directory/persistence/postgres.ts",
      "src/member_directory/generated/api/query-runtime.ts",
      "tests/generated/directory-search-members.test.ts",
      "tests/generated/directory-persistence.test.ts",
    ]) {
      expect(t).toContain(p);
    }
    const p = py().files.map((f) => f.path);
    for (const x of [
      "sql/directory.sql",
      "src/member_directory/generated/_persistence.py",
      "src/member_directory/generated/directory/application/queries.py",
      "src/member_directory/generated/directory/persistence/__init__.py",
      "src/member_directory/generated/directory/persistence/rows.py",
      "src/member_directory/generated/directory/persistence/postgres.py",
      "tests/generated/test_directory_search_members.py",
      "tests/generated/test_directory_persistence.py",
    ]) {
      expect(p).toContain(x);
    }
  });

  test("models without queries get none of it (their output is unchanged)", () => {
    for (const text of OTHERS) {
      const paths = [...py(text).files, ...ts(text).files].map((f) => f.path);
      expect(paths.filter((x) => /(^sql\/|persistence|queries\.(py|ts)$|query-runtime)/.test(x) && !x.endsWith("/api/queries.ts"))).toEqual([]);
      // The API runtime keeps its private `send` (exported only for the query runtime).
      const runtime = ts(text).files.find((f) => f.path.endsWith("/api/runtime.ts"));
      if (runtime) expect(runtime.content).toContain("\nasync function send<");
    }
    expect(file(ts(), "src/member_directory/generated/api/runtime.ts")).toContain("\nexport async function send<");
  });

  test("both targets embed the same SQL: identical DDL, every statement in psycopg form in Python", () => {
    expect(file(py(), "sql/directory.sql")).toBe(file(ts(), "sql/directory.sql"));
    const ca = analyze(QUERIES).contexts.get("Directory")!;
    const tsPg = file(ts(), "src/member_directory/generated/directory/persistence/postgres.ts");
    const pyPg = file(py(), "src/member_directory/generated/directory/persistence/postgres.py");
    const plans = ca.ir.queries.map((q) => planQuery(ca.ir, ca.fieldTypes, q)!);
    const statements = [...plans.flatMap((p) => Object.values(queryStatements(p))), ...Object.values(repositorySql(plans[0]!.table))];
    expect(statements.length).toBe(4 * 3 + 2 + 3);
    for (const s of statements) {
      expect(tsPg).toContain(`\`${s.text}\``);
      expect(pyPg).toContain(`"""${psycopgText(s.text)}"""`);
    }
  });

  test("DDL: pg_trgm, a schema per context, a table per aggregate with version, trigram GIN / prefix / equality / order indexes", () => {
    const ddl = file(ts(), "sql/directory.sql");
    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(ddl).toContain("CREATE SCHEMA IF NOT EXISTS directory;");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS directory.member (");
    expect(ddl).toContain("  status text NOT NULL CHECK (status IN ('active', 'suspended', 'left')),");
    expect(ddl).toContain("  balance_amount numeric NOT NULL,");
    expect(ddl).toContain("  badges jsonb NOT NULL,");
    expect(ddl).toContain("  version bigint NOT NULL\n);");
    expect(ddl).toContain("CREATE INDEX IF NOT EXISTS member_display_name_trgm_idx\n  ON directory.member USING gin (lower(display_name) gin_trgm_ops);");
    expect(ddl).toContain("ON directory.member (lower(display_name) text_pattern_ops);");
    expect(ddl).toContain("ON directory.member (lower(email_value));");
    expect(ddl).toContain('ON directory.member (status COLLATE "C" ASC, points DESC, id DESC);');
  });

  test("keyset SQL: row comparison when directions agree, OR-of-ANDs when they differ, the score as a float4 key", () => {
    const ca = analyze(QUERIES).contexts.get("Directory")!;
    const [search, list] = ca.ir.queries.map((q) => queryStatements(planQuery(ca.ir, ca.fieldTypes, q)!));
    const s = search!.searchNext!.text;
    expect(s).toContain("AND (lower(display_name) % lower($3::text) OR lower(email_value) % lower($3::text))");
    expect(s).toContain("AND _s._score >= 0.3");
    expect(s).toContain("AND (_s._score, member.joined_at, member.id) < ($4::real, $5::timestamptz, $6::uuid)");
    expect(s).toContain("_s._score::float8::text AS _k0");
    expect(s).toContain("ORDER BY _s._score DESC, member.joined_at DESC, member.id DESC");
    expect(s).toContain("LIMIT $7::integer");
    expect(search!.first!.text).not.toContain("_score");
    const l = list!.next!.text;
    expect(l).toContain('(member.status COLLATE "C" > $3::text)');
    expect(l).toContain('OR (member.status COLLATE "C" = $3::text AND member.points < $4::bigint)');
    expect(l).not.toContain("OFFSET");
  });

  test("a threshold below pg_trgm's default drops the % prefilter (it would miss rows) and keeps the exact threshold", () => {
    const low = QUERIES.replace("mode: trigram, min_similarity: 0.3", "mode: trigram, min_similarity: 0.2");
    const ca = analyze(low).contexts.get("Directory")!;
    const text = queryStatements(planQuery(ca.ir, ca.fieldTypes, ca.ir.queries[0]!)!).searchFirst!.text;
    expect(text).not.toContain(" % ");
    expect(text).toContain("_s._score >= 0.2");
  });

  test("TypeScript API: GET endpoint with invalid_cursor 400, client caller, infiniteQueryOptions under lists(), 409 for saving use cases", () => {
    const out = ts();
    const contract = file(out, "src/member_directory/generated/directory/api/contract.ts");
    expect(contract).toContain('path: "/api/directory/queries/search-members",');
    expect(contract).toContain("errors: { constraint_violation: 400, invalid_cursor: 400 },");
    expect(contract).toContain("joined_after: { key: \"joinedAfter\", kind: \"string\" },");
    expect(contract).toContain("errors: { constraint_violation: 400, concurrency_conflict: 409 },");
    expect(contract).toContain("member_already_suspended: 409,\n        concurrency_conflict: 409,");
    const queries = file(out, "src/member_directory/generated/directory/api/queries.ts");
    expect(queries).toContain("infiniteQueryOptions({");
    expect(queries).toContain('queryKey: [{ ...memberKey, kind: "list", query: "search-members", params }] as const,');
    expect(queries).toContain("queryFn: ({ queryKey: [{ params }], pageParam, signal }) =>");
    expect(queries).toContain("initialPageParam: null as string | null,");
    expect(queries).toContain("getNextPageParam: (lastPage) => lastPage.nextCursor,");
    expect(file(out, "src/member_directory/generated/api/client.ts")).toContain("searchMembers: queryCaller(transport, queries.searchMembers, errors),");
    // Without queries, use cases keep their statuses (no concurrency_conflict: there is no PostgreSQL repository).
    const plain = generateTypeScript(analyze(asTypeScript(OTHERS[1]!)), asTypeScript(OTHERS[1]!));
    expect(plain.files.map((f) => f.content).join("\n")).not.toContain("concurrency_conflict");
  });

  test("the reader port, the query service and the Postgres adapters", () => {
    const app = file(ts(), "src/member_directory/generated/directory/application/queries.ts");
    expect(app).toContain("export interface SearchMembersReader {");
    expect(app).toContain("export class SearchMembersQuery {");
    expect(app).toContain("return await runQuery(SEARCH_MEMBERS_SPEC, this.#cursors, params, page, (request) =>");
    const pg = file(ts(), "src/member_directory/generated/directory/persistence/postgres.ts");
    expect(pg).toContain("export class PostgresMemberRepository implements MemberRepository {");
    expect(pg).toContain("export class PostgresSearchMembersReader implements SearchMembersReader {");
    const pyPg = file(py(), "src/member_directory/generated/directory/persistence/postgres.py");
    expect(pyPg).toContain("class PostgresMemberRepository:");
    expect(pyPg).toContain("WHERE id = %(p1)s::uuid");
  });
});

// ---------------------------------------------------------------------------
// PGlite: the generated SQL on a real PostgreSQL (18, in WebAssembly)
// ---------------------------------------------------------------------------

const PGLITE_DEPENDENCIES = { ...TS_DEPENDENCIES, ...TS_API_DEPENDENCIES, "@electric-sql/pglite": "^0.5.8" };

/** Installs the TypeScript dependencies plus PGlite once into a cache directory keyed by their versions. */
function installPglite(): { dir?: string; reason?: string } {
  if (process.env.DDD_SKIP_TS_RUN) return { reason: "DDD_SKIP_TS_RUN is set" };
  if (process.env.DDD_SKIP_PGLITE) return { reason: "DDD_SKIP_PGLITE is set" };
  const dir = join(tmpdir(), `ddd-ts-pglite-${createHash("sha256").update(JSON.stringify(PGLITE_DEPENDENCIES)).digest("hex").slice(0, 12)}`);
  const ready = join(dir, "node_modules/.ddd-ready");
  if (existsSync(ready)) return { dir };
  mkdirSync(dir, { recursive: true });
  const { zod, "decimal.js": decimal, ...dev } = PGLITE_DEPENDENCIES;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ddd-ts-pglite", private: true, type: "module", dependencies: { zod, "decimal.js": decimal }, devDependencies: dev }, null, 2));
  try {
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 240_000 });
    if (r.exitCode !== 0 || !existsSync(join(dir, "node_modules/@electric-sql/pglite/package.json"))) {
      return { reason: `bun install failed (exit ${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}` };
    }
  } catch (e) {
    return { reason: `bun install could not run: ${(e as Error).message}` };
  }
  writeFileSync(ready, "");
  return { dir };
}

const PGLITE = installPglite();
if (!PGLITE.dir) console.warn(`skipping "generated PostgreSQL code runs on PGlite": ${PGLITE.reason} (needs network once to install @electric-sql/pglite)`);

describe.skipIf(!PGLITE.dir)("generated PostgreSQL code runs on PGlite", () => {
  test("DDL applies twice; keyset paging and trigram search equal the in-memory readers; the GIN / order indexes serve the SQL; optimistic locking", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-pglite-"));
    try {
      const text = asTypeScript(QUERIES);
      for (const f of generateTypeScript(analyze(text), text).files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      symlinkSync(join(PGLITE.dir!, "node_modules"), join(dir, "node_modules"));
      writeFileSync(join(dir, "tests/pglite.test.ts"), fixture("queries-pglite.test.ts.txt"));
      const r = Bun.spawnSync(["bun", "test", "tests/pglite.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      const out = r.stdout.toString() + r.stderr.toString();
      expect({ code: r.exitCode, fail: /(\d+) fail/.exec(out)?.[1], out: r.exitCode ? out : "" }).toEqual({ code: 0, fail: "0", out: "" });
      expect(out).toMatch(/\b3 pass/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
