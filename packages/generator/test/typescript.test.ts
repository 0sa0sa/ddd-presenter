import { describe, expect, test } from "bun:test";
import { boardToModel, checkExpression, complete, deriveViolations, hover, makeEnv, proposeLocally, sampleBoard, T, validateModelText, type ContextAnalysis, type ContextIR, type ModelIR, type Type } from "@ddd/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan, generate, generatePython, generateTypeScript, renderManifest, sha256 } from "../src/index.ts";
import { TsImports, tsString } from "../src/typescript/code.ts";
import { formatExpression, formatSource, strWidth } from "../src/typescript/format.ts";
import { emitExpr, type ExprContext } from "../src/typescript/expr.ts";
import { TS_API_DEPENDENCIES, TS_DEPENDENCIES, TS_SECURITY_DEPENDENCIES } from "../src/typescript/index.ts";
import { TsLayout } from "../src/typescript/layout.ts";

const ROOT = join(import.meta.dir, "../../..");
const EXAMPLE = join(ROOT, "examples/cleaning-platform-ts");
const MODEL = readFileSync(join(EXAMPLE, "model.ddd.yaml"), "utf8");
const PY_MODEL = readFileSync(join(ROOT, "examples/cleaning-platform/model.ddd.yaml"), "utf8");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const KITCHEN_SINK = fixture("kitchen-sink.ddd.yaml");
const CONTEXT_MAP = fixture("context-map.ddd.yaml");
const ORDERING = fixture("ordering.ddd.yaml");
const LONG_RULES = fixture("long-rules.ddd.yaml");
/** Aggregates identified by a String and by an Integer (the API's keys and paths must not assume UUIDs). */
const IDENTITIES = fixture("identities.ddd.yaml");
/** Roles, a typed principal with claims, bearer JWT, rate limits; public, internal and role / rule protected use cases. */
const SECURITY = fixture("security.ddd.yaml");
/** The model a team gets by reflecting the sample discovery board into an empty project. */
const FROM_BOARD = boardToModel(
  sampleBoard(),
  "schema_version: 1\nproject: staff\ngeneration:\n  package: staff_from_board\n\ncontexts:\n  - name: Core\n    errors: []\n    aggregates: []\n    use_cases: []\n",
).yaml!;

/** The model with `generation.target: typescript` (and optionally the bun test runner). */
function asTypeScript(text: string, runner?: "bun"): string {
  if (/^ {2}target: typescript/m.test(text)) return runner ? text.replace(/test_runner: vitest/, "test_runner: bun") : text;
  const settings = `  target: typescript\n${runner ? "  typescript: { test_runner: bun }\n" : ""}`;
  return /^generation:\n/m.test(text) ? text.replace(/^generation:\n/m, `generation:\n${settings}`) : text.replace(/^contexts:/m, `generation:\n${settings}\ncontexts:`);
}

/** The TypeScript model with the HTTP API enabled (`generation.typescript.api`). */
function withApi(text: string, api = "{ base_path: /api }"): string {
  const ts = asTypeScript(text);
  if (/^ {4}api:/m.test(ts)) return ts;
  if (/^ {2}typescript:\n/m.test(ts)) return ts.replace(/^ {2}typescript:\n/m, `  typescript:\n    api: ${api}\n`);
  if (/^ {2}typescript: \{ test_runner: bun \}\n/m.test(ts)) return ts.replace(/^ {2}typescript: \{ test_runner: bun \}\n/m, `  typescript:\n    test_runner: bun\n    api: ${api}\n`);
  return ts.replace(/^ {2}target: typescript\n/m, `  target: typescript\n  typescript:\n    api: ${api}\n`);
}

/** The model without `generation.typescript.api` (the example enables it). */
function withoutApi(text: string): string {
  return text.replace(/^ {4}api:.*\n/m, "");
}

function analyze(text: string) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  return r.analysis!;
}

const gen = (text = MODEL) => generateTypeScript(analyze(text), text);

describe("TypeScript target: selection", () => {
  test("generation.target defaults to python; typescript and the test runner are read from the model", () => {
    expect(analyze(PY_MODEL).model.generation).toMatchObject({ target: "python", typescript: { testRunner: "vitest" } });
    expect(analyze(MODEL).model.generation).toMatchObject({ target: "typescript", typescript: { testRunner: "vitest" } });
    expect(analyze(asTypeScript(MODEL, "bun")).model.generation.typescript.testRunner).toBe("bun");
  });

  test("generate() follows the model's target unless overridden", () => {
    const ts = analyze(MODEL);
    expect(generate(ts, MODEL).files.some((f) => f.path.endsWith("aggregates.ts"))).toBe(true);
    expect(generate(ts, MODEL, "python").files.some((f) => f.path.endsWith("aggregates.py"))).toBe(true);
    const py = analyze(PY_MODEL);
    expect(JSON.stringify(generate(py, PY_MODEL))).toBe(JSON.stringify(generatePython(py, PY_MODEL)));
  });

  test("generation.typescript.api is opt-in: base path (default /api) and client are read and checked", () => {
    expect(analyze(withoutApi(MODEL)).model.generation.typescript.api).toBeUndefined();
    expect(analyze(MODEL).model.generation.typescript.api).toEqual({ basePath: "/api", client: "tanstack-query" });
    expect(analyze(withApi(withoutApi(MODEL), "{}")).model.generation.typescript.api).toEqual({ basePath: "/api", client: "tanstack-query" });
    expect(analyze(withApi(withoutApi(MODEL), '{ base_path: "" }')).model.generation.typescript.api?.basePath).toBe("");
    const bad = validateModelText(withApi(withoutApi(MODEL), "{ base_path: api/, client: swr, cache: true }"));
    expect(bad.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.path.join(".")}`).sort()).toEqual([
      "invalid-value generation.typescript.api.base_path",
      "invalid-value generation.typescript.api.client",
      "unknown-key generation.typescript.api.cache",
    ]);
    const apiAt = MODEL.indexOf("client: tanstack-query") + "client: ".length;
    expect(complete(MODEL, apiAt).items.map((i) => i.label)).toEqual(["tanstack-query"]);
    expect(hover(MODEL, MODEL.indexOf("base_path") + 2)?.markdown).toContain("/api");
    expect(hover(MODEL, MODEL.indexOf("    api:") + 5)?.markdown).toContain("TanStack Query");
  });

  test("unknown targets and runners are diagnostics", () => {
    const bad = validateModelText(MODEL.replace("target: typescript", "target: rust").replace("test_runner: vitest", "test_runner: jest"));
    expect(bad.diagnostics.filter((d) => d.code === "invalid-value").map((d) => d.path.join("."))).toEqual(["generation.target", "generation.typescript.test_runner"]);
  });

  test("completion and hover offer the generation keys and their values", () => {
    const noTarget = PY_MODEL.replace("  src_dir: src\n", "  src_dir: src\n  \n");
    const at = noTarget.indexOf("  \n", noTarget.indexOf("src_dir")) + 2;
    expect(complete(noTarget, at).items.map((i) => i.label)).toEqual(expect.arrayContaining(["target", "typescript"]));
    const valueAt = MODEL.indexOf("target: typescript") + "target: ".length;
    expect(complete(MODEL, valueAt).items.map((i) => i.label)).toEqual(["python", "typescript"]);
    const runnerAt = MODEL.indexOf("test_runner: vitest") + "test_runner: ".length;
    expect(complete(MODEL, runnerAt).items.map((i) => i.label)).toEqual(["vitest", "bun"]);
    expect(hover(MODEL, MODEL.indexOf("test_runner") + 2)?.markdown).toContain("vitest");
  });

  test("names the generated TypeScript would clash with are rejected for the typescript target only", () => {
    const clash = MODEL.replace("name: EmailAddress\n", "name: Map\n").replace(/type: EmailAddress/g, "type: Map");
    expect(validateModelText(clash).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain('"Map" cannot name a value object');
    expect(validateModelText(clash.replace("target: typescript", "target: python")).ok).toBe(true);
    for (const runtimeName of ["Instant", "InstantSchema", "LocalDateSchema"]) {
      const named = MODEL.replace("name: EmailAddress\n", `name: ${runtimeName}\n`).replace(/type: EmailAddress/g, `type: ${runtimeName}`);
      expect(validateModelText(named).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain(`"${runtimeName}" cannot name a value object`);
    }
    const companion = MODEL.replace("- name: InvitationNotFound\n", "- name: EmailAddressInput\n").replace(/not_found: InvitationNotFound/g, "not_found: EmailAddressInput").replace(/raises: InvitationNotFound/g, "raises: EmailAddressInput");
    expect(validateModelText(companion).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain("the input type of EmailAddress");
    const ctor = MODEL.replace("{ name: accepted_at, type: DateTime, required: false }", "{ name: constructor, type: String, required: false }");
    expect(validateModelText(ctor).diagnostics.some((d) => d.code === "reserved-name" && d.message.includes('"constructor"'))).toBe(true);
    const eventSchema = companion.replace(/EmailAddressInput/g, "InvitationRevokedSchema");
    expect(validateModelText(eventSchema).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain("the schema of InvitationRevoked");
    const typeField = MODEL.replace("              - name: InvitationRevoked\n                fields: [id]", "              - name: InvitationRevoked\n                fields: [id, { name: type, value: status }]");
    expect(validateModelText(typeField).diagnostics.some((d) => d.code === "reserved-name" && d.message.includes('event field cannot be named "type"'))).toBe(true);
  });
});

describe("TypeScript target: golden output", () => {
  test("regenerating the example reproduces the committed files byte for byte", () => {
    const out = gen();
    for (const f of out.files) {
      if (f.ownership !== "generated") continue;
      const committed = readFileSync(join(EXAMPLE, f.path), "utf8");
      expect({ path: f.path, content: f.content }).toEqual({ path: f.path, content: committed });
    }
    expect(renderManifest(out.manifest)).toBe(readFileSync(join(EXAMPLE, out.manifestPath), "utf8"));
  });

  test("without generation.typescript.api the output is exactly the domain code (no api files, same bytes)", () => {
    const text = withoutApi(MODEL);
    const out = gen(text);
    expect(out.files.some((f) => f.path.includes("/generated/api/") || f.path.endsWith("-api.test.ts"))).toBe(false);
    for (const f of out.files) {
      if (f.ownership !== "generated") continue;
      expect({ path: f.path, content: f.content }).toEqual({ path: f.path, content: readFileSync(join(EXAMPLE, f.path), "utf8") });
    }
    const pkg = JSON.parse(out.files.find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies).toEqual({ "decimal.js": TS_DEPENDENCIES["decimal.js"], zod: TS_DEPENDENCIES.zod });
    expect(pkg.devDependencies).toEqual({ "@types/node": TS_DEPENDENCIES["@types/node"], typescript: TS_DEPENDENCIES.typescript, vitest: TS_DEPENDENCIES.vitest });
  });

  test("generation is deterministic", () => {
    expect(JSON.stringify(gen())).toBe(JSON.stringify(gen()));
  });

  test("layout: runtime once, a directory per context, customer-owned scaffolds, tests under tests/generated", () => {
    const out = gen();
    const byPath = new Map(out.files.map((f) => [f.path, f.ownership]));
    for (const p of [
      "src/cleaning_platform/generated/runtime.ts",
      "src/cleaning_platform/generated/index.ts",
      "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts",
      "src/cleaning_platform/generated/cleaning-staff/application/use-cases.ts",
      "src/cleaning_platform/generated/staffing/application/policies.ts",
      "tests/generated/cleaning-staff-invariants.test.ts",
      "tests/generated/staffing-policies.test.ts",
    ]) {
      expect({ p, o: byPath.get(p) }).toEqual({ p, o: "generated" });
    }
    for (const p of ["package.json", "tsconfig.json", ".prettierrc.json", "src/cleaning_platform/index.ts", "src/cleaning_platform/extensions/cleaning-staff/extensions.ts"]) {
      expect({ p, o: byPath.get(p) }).toEqual({ p, o: "scaffold" });
    }
    expect(out.manifest.model_sha256).toBe(sha256(MODEL));
    expect(out.manifestPath).toBe("src/cleaning_platform/generated/model_manifest.json");
    expect(out.files.filter((f) => f.ownership === "generated").every((f) => f.path.endsWith(".md") || f.content.startsWith("// Generated by DDD Presenter"))).toBe(true);
    const pkg = JSON.parse(out.files.find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies).toEqual({
      "@tanstack/react-query": TS_API_DEPENDENCIES["@tanstack/react-query"],
      "decimal.js": TS_DEPENDENCIES["decimal.js"],
      jose: TS_SECURITY_DEPENDENCIES.jose,
      react: TS_API_DEPENDENCIES.react,
      zod: TS_DEPENDENCIES.zod,
    });
    expect(pkg.devDependencies).toEqual({ "@types/node": TS_DEPENDENCIES["@types/node"], "@types/react": TS_API_DEPENDENCIES["@types/react"], typescript: TS_DEPENDENCIES.typescript, vitest: TS_DEPENDENCIES.vitest });
    expect(pkg.scripts).toEqual({ test: "vitest run", typecheck: "tsc --noEmit" });
    const tsconfig = JSON.parse(out.files.find((f) => f.path === "tsconfig.json")!.content);
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, noUnusedParameters: true, module: "NodeNext" });
    expect(JSON.parse(out.files.find((f) => f.path === ".prettierrc.json")!.content)).toEqual({ printWidth: 100 });
    const bun = gen(asTypeScript(MODEL, "bun"));
    expect(JSON.parse(bun.files.find((f) => f.path === "package.json")!.content).scripts.test).toBe("bun test");
    expect(bun.files.find((f) => f.path.endsWith("invariants.test.ts"))!.content).toContain('from "bun:test"');
  });
});

describe("TypeScript target: plan", () => {
  const out = gen();
  const disk = () => new Map(out.files.map((f) => [f.path, f.content]));

  test("hand edits are conflicts; scaffolds are never touched", () => {
    const d = disk();
    const agg = "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts";
    d.set(agg, d.get(agg) + "\n// edited\n");
    d.set("package.json", "{}\n");
    const plan = computePlan(out, out.manifest, (p) => d.get(p));
    expect(plan.conflicts.map((c) => c.path)).toEqual([agg]);
    expect(plan.entries.find((e) => e.path === "package.json")?.action).toBe("keep");
  });

  test("a stale generated test is deleted when untouched (it would import removed code)", () => {
    const text = MODEL.slice(0, MODEL.indexOf("      - name: revoke_invitation")) + MODEL.slice(MODEL.indexOf("\n  - name: Staffing") + 1);
    const next = gen(text);
    const plan = computePlan(next, out.manifest, (p) => disk().get(p));
    expect(plan.stale.map((s) => [s.path, s.autoPrune])).toEqual([["tests/generated/cleaning-staff-revoke-invitation.test.ts", true]]);
    // Removed exports are reported as breaking changes to the generated API (tests are not API).
    // The mutation options are members of `createCleaningStaffMutations`' result, not exports: only the domain symbols.
    expect(plan.breaking.map((b) => b.symbol).sort()).toEqual(["RevokeInvitation", "RevokeInvitationInput", "RevokeInvitationUseCase", "RevokeInvitationUseCase.constructor", "RevokeInvitationUseCase.execute"]);
  });

  test("upgrading a project generated with the old API layout: moved files and hooks are stale (kept until --prune), their exports are breaking", () => {
    // What the previous generator wrote: per-context api files under generated/api/<context>/, hooks and a React context.
    const api = "src/cleaning_platform/generated/api";
    const old = new Map([
      [`${api}/react.ts`, "export const ApiClientContext = createContext<ApiClient | null>(null);\nexport function useApiClient(): ApiClient {\n  return api;\n}\n"],
      [`${api}/cleaning-staff/hooks.ts`, "export function useCleaningStaffInvitation(id: string | undefined) {\n  return useQuery(q);\n}\nexport function useAcceptInvitation() {\n  return useMutation(m);\n}\n"],
      [`${api}/cleaning-staff/queries.ts`, "export const cleaningStaffInvitationKeys = {};\nexport const cleaningStaffInvitationQueries = {};\nexport const cleaningStaffMutations = {};\n"],
      [`${api}/cleaning-staff/contract.ts`, "export const CleaningStaffInvitationJson = z.object({});\nexport const contract = {} as const;\n"],
    ]);
    const previous = { ...out.manifest, files: [...out.manifest.files.filter((f) => !f.path.includes("/api/")), ...[...old].map(([path, content]) => ({ path, sha256: sha256(content) }))] };
    const d = new Map([...[...disk()].filter(([path]) => !path.includes("/api/")), ...old]);
    const plan = computePlan(out, previous, (p) => d.get(p));
    expect(plan.stale.map((s) => [s.path, s.autoPrune, s.modified]).sort()).toEqual([...old.keys()].sort().map((p) => [p, false, false]));
    expect(plan.conflicts).toEqual([]);
    for (const p of ["cleaning-staff/api/queries.ts", "cleaning-staff/api/contract.ts", "api/queries.ts"]) {
      expect(plan.entries.find((e) => e.path === `src/cleaning_platform/generated/${p}`)?.action).toBe("create");
    }
    expect(plan.breaking.filter((b) => b.reason === "module removed").map((b) => b.symbol).sort()).toEqual(
      ["ApiClientContext", "CleaningStaffInvitationJson", "cleaningStaffInvitationKeys", "cleaningStaffInvitationQueries", "cleaningStaffMutations", "contract", "useAcceptInvitation", "useApiClient", "useCleaningStaffInvitation"].sort(),
    );
    // Kept (and recorded as stale in the manifest) until `ddd generate --prune` deletes them.
    const manifest = JSON.parse(plan.entries.find((e) => e.ownership === "manifest")!.after!) as { stale?: { path: string }[] };
    expect(manifest.stale?.map((s) => s.path).sort()).toEqual([...old.keys()].sort());
    const pruned = computePlan(out, previous, (p) => d.get(p), { prune: true });
    expect(JSON.parse(pruned.entries.find((e) => e.ownership === "manifest")!.after!).stale).toBeUndefined();
  });

  test("a changed operation signature is a breaking change", () => {
    const next = gen(MODEL.replace("            parameters:\n              - { name: at, type: DateTime }\n            require: [pending_until_expiry(at)]", "            parameters:\n              - { name: at, type: DateTime }\n              - { name: note, type: String, required: false }\n            require: [pending_until_expiry(at)]"));
    const plan = computePlan(next, out.manifest, (p) => disk().get(p));
    expect(plan.breaking).toEqual([
      {
        path: "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts",
        symbol: "CleaningStaffInvitation.accept",
        reason: "signature changed: (args: {readonly at: Instant}) → (args: {readonly at: Instant; readonly note?: string | null})",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Expression emission
// ---------------------------------------------------------------------------

describe("TypeScript target: expression emission", () => {
  const ctx: ContextIR = {
    name: "X",
    glossary: [],
    errors: [],
    enums: [{ name: "Status", values: ["draft", "placed"], path: [] }],
    valueObjects: [{ name: "Money", fields: [{ name: "amount", type: "Decimal", required: true, constraints: {}, path: [] }], normalize: {}, invariants: [], path: [] }],
    aggregates: [
      {
        name: "Order",
        identity: "id",
        fields: [
          { name: "id", type: "UUID", required: true, constraints: {}, path: [] },
          { name: "customer_id", type: "Ref[Customer]", required: true, constraints: {}, path: [] },
        ],
        entities: [{ name: "Line", identity: "line_id", fields: [{ name: "line_id", type: "Integer", required: true, constraints: {}, path: [] }], invariants: [], path: [] }],
        invariants: [],
        stateGuards: [],
        factories: [],
        operations: [],
        scenarios: [],
        path: [],
      },
      { name: "Customer", identity: "id", fields: [{ name: "id", type: "UUID", required: true, constraints: {}, path: [] }], entities: [], invariants: [], stateGuards: [], factories: [], operations: [], scenarios: [], path: [] },
    ],
    extensionPoints: [],
    useCases: [],
    policies: [],
    path: [],
  };
  const fields = new Map<string, Type>([
    ["id", T.UUID],
    ["customer_id", { k: "ref", target: "Customer" }],
    ["status", { k: "enum", name: "Status" }],
    ["total", T.Integer],
    ["price", T.Decimal],
    ["discount", { k: "optional", inner: T.Decimal }],
    ["note", { k: "optional", inner: T.String }],
    ["name", T.String],
    ["limit", { k: "optional", inner: T.Integer }],
    ["tags", { k: "list", item: T.String }],
    ["lines", { k: "list", item: { k: "entity", name: "Line", aggregate: "Order" } }],
    ["placed_at", T.DateTime],
    ["due", T.Date],
    ["other", { k: "aggregate", name: "Customer" }],
  ]);
  const ca = {
    ir: ctx,
    fieldTypes: new Map([
      ["Order", fields],
      ["Line", new Map<string, Type>([["line_id", T.Integer]])],
      ["Customer", new Map<string, Type>([["id", T.UUID]])],
      ["Money", new Map<string, Type>([["amount", T.Decimal]])],
    ]),
    exprs: new Map(),
    events: new Map(),
    useCases: new Map(),
    policies: new Map(),
  } as unknown as ContextAnalysis;
  const model = { project: "x", generation: { package: "x", srcDir: "src", testsDir: "tests", target: "typescript", typescript: { testRunner: "vitest" } } } as unknown as ModelIR;
  const L = new TsLayout(model, ca);
  const env = makeEnv(ctx, { self: { name: "Order", fields, aggregate: ctx.aggregates[0] }, params: new Map<string, Type>([["at", T.DateTime], ["other_id", T.UUID], ["line", { k: "entity", name: "Line", aggregate: "Order" }]]) });
  const ts = (src: string, expected: Type = T.Boolean) => {
    const r = checkExpression(src, env, expected);
    if (!r.expr) throw new Error(JSON.stringify(r.errors));
    const c: ExprContext = { L, imports: new TsImports("m"), self: "this", selfOwner: "Order" };
    return emitExpr(r.expr, c);
  };

  test("operators, enums, null checks and negation (JavaScript `!` binds tighter than comparisons)", () => {
    expect(ts("status == placed and total >= 1")).toBe("this.status === Status.placed && this.total >= 1");
    expect(ts("note == null or length(note) < 3")).toBe("this.note === null || this.note.length < 3");
    expect(ts("not (status == draft or total > 1)")).toBe("!(this.status === Status.draft || this.total > 1)");
    expect(ts("not total > 1")).toBe("!(this.total > 1)");
    expect(ts("(total > 1 or total < 0) and not is_empty(tags)")).toBe("(this.total > 1 || this.total < 0) && !(this.tags.length === 0)");
    expect(ts("contains(name, 'x') and not is_empty(name) and contains(tags, name)")).toBe('this.name.includes("x") && !(this.name.length === 0) && contains(this.tags, this.name)');
  });

  test("Decimal arithmetic and comparisons are exact decimal.js calls; Integer / Integer is Decimal", () => {
    expect(ts("price * total > 1.5")).toBe('this.price.times(this.total).gt(new Decimal("1.5"))');
    expect(ts("1 < price")).toBe("this.price.gt(1)");
    expect(ts("total / 3 > 1")).toBe("new Decimal(this.total).div(3).gt(1)");
    expect(ts("round(total * 1.08, 0) > max(total, 2.5)")).toBe('new Decimal(this.total).times(new Decimal("1.08")).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).gt(Decimal.max(this.total, new Decimal("2.5")))');
    expect(ts("-(-total) == total and -price < price")).toBe("-(-this.total) === this.total && this.price.neg().lt(this.price)");
    expect(ts("price == 0 and discount != null and discount == price")).toBe("this.price.eq(0) && this.discount !== null && this.discount.eq(this.price)");
  });

  test("instants and calendar dates are canonical ISO strings compared with plain operators; durations are milliseconds", () => {
    expect(ts("at - placed_at < hours(24) and at <= placed_at + days(7)")).toBe("durationBetween(at, this.placedAt) < hours(24) && at <= addDuration(this.placedAt, days(7))");
    expect(ts("at - hours(1) > placed_at and at != placed_at")).toBe("subtractDuration(at, hours(1)) > this.placedAt && at !== this.placedAt");
    expect(ts("due + days(14) >= due and due - due > days(0) and due - days(1) < due")).toBe("addDays(this.due, days(14)) >= this.due && daysBetween(this.due, this.due) > days(0) && subtractDays(this.due, days(1)) < this.due");
    expect(ts("min(at, placed_at) == max(at, placed_at)")).toBe("earliest(at, this.placedAt) === latest(at, this.placedAt)");
    for (const code of [ts("at == placed_at"), ts("at < placed_at")]) expect(code).not.toContain("getTime");
  });

  test("collections: callbacks with `item`, entity removal by identity, nested element functions", () => {
    expect(ts("any(tags, item == 'vip') and all(tags, length(item) < 10)")).toBe('this.tags.some((item) => item === "vip") && this.tags.every((item) => item.length < 10)');
    expect(ts("count(tags, item != 'x') == count(tags)")).toBe('this.tags.filter((item) => item !== "x").length === this.tags.length');
    expect(ts("sum(lines, item.line_id) > 0 and length(remove_where(tags, item == 'a' or item == 'b')) > 0")).toBe(
      'sumOf(this.lines, (item) => item.lineId) > 0 && this.tags.filter((item) => !(item === "a" || item === "b")).length > 0',
    );
    expect(ts("length(remove(lines, line)) < length(append(lines, line))")).toBe("without(this.lines, line).length < [...this.lines, line].length");
    expect(ts("any(lines, any(tags, item == 'x'))")).toBe('this.lines.some((item) => this.tags.some((item) => item === "x"))');
  });

  test("a narrowed optional field used inside a callback gets a non-null assertion", () => {
    expect(ts("limit != null and all(lines, item.line_id < limit)")).toBe("this.limit !== null && this.lines.every((item) => item.lineId < this.limit!)");
  });

  test("ids of different aggregates compare with equals(); the identity carries its owner's brand", () => {
    expect(ts("customer_id == other_id")).toBe("this.customerId === otherId");
    expect(ts("customer_id == other.id")).toBe("this.customerId === this.other.id");
    expect(ts("id == customer_id")).toBe("equals(this.id, this.customerId)");
  });
});

describe("TypeScript target: Prettier-compatible formatting", () => {
  // Every expected output below is what Prettier 3 (printWidth 100) prints for the input; the run suite checks the
  // generated projects with the real Prettier.
  const fmt = (line: string) => formatSource(line).split("\n");

  test("a long boolean return is parenthesized on the same line; operators end the lines (never `return` alone: ASI)", () => {
    expect(fmt("    return command.allowOrdersThatAreCurrentlyOnHold || (purchaseOrder.status === PurchaseOrderStatus.placed);")).toEqual([
      "    return (",
      "      command.allowOrdersThatAreCurrentlyOnHold ||",
      "      purchaseOrder.status === PurchaseOrderStatus.placed",
      "    );",
    ]);
  });

  test("a single object argument hugs the parentheses; broken argument lists get trailing commas", () => {
    const out = fmt("    const aggregate = CleaningStaffInvitation.from({ id: id, email, status: InvitationStatus.pending, createdAt: at });");
    expect(out[0]).toBe("    const aggregate = CleaningStaffInvitation.from({");
    expect(out.at(-1)).toBe("    });");
    expect(out).toContain("      createdAt: at,");
    expect(fmt('    expect(plain(transition.aggregate.total)).toEqual(plain(Money.create({ amount: "10.50", currency: "USD" })));')).toEqual([
      "    expect(plain(transition.aggregate.total)).toEqual(",
      '      plain(Money.create({ amount: "10.50", currency: "USD" })),',
      "    );",
    ]);
  });

  test("a long boolean argument continues indented; a negated condition hugs `if (!(`", () => {
    expect(fmt("      this.status === OrderStatus.delivered && this.deliveredAt !== null && at <= addDuration(this.deliveredAt, days(7)),")).toEqual([
      "      this.status === OrderStatus.delivered &&",
      "        this.deliveredAt !== null &&",
      "        at <= addDuration(this.deliveredAt, days(7)),",
    ]);
    expect(fmt("    if (!(this.refunded === null || (this.captured !== null && this.refunded.amount.lte(this.captured.amount)))) {")).toEqual([
      "    if (!(",
      "      this.refunded === null ||",
      "      (this.captured !== null && this.refunded.amount.lte(this.captured.amount))",
      "    )) {",
    ]);
  });

  test("a ternary's branches are indented by two (Prettier's align(2)), also an arrow's broken body", () => {
    expect(fmt("          queryFn: id === undefined ? skipToken : ({ signal }) => api.cleaningStaff.aggregates.cleaningStaffInvitation(id, { signal }),")).toEqual([
      "          queryFn:",
      "            id === undefined",
      "              ? skipToken",
      "              : ({ signal }) =>",
      "                  api.cleaningStaff.aggregates.cleaningStaffInvitation(id, { signal }),",
    ]);
  });

  test("the last argument expands: arrays, objects and arrow functions (the body breaks after `=>`)", () => {
    expect(fmt('    expect(eventPublisher.published.map((event) => event.type)).toEqual(["Ordering.BigOrderPlaced", "Ordering.OrderPlaced"]);')).toEqual([
      "    expect(eventPublisher.published.map((event) => event.type)).toEqual([",
      '      "Ordering.BigOrderPlaced",',
      '      "Ordering.OrderPlaced",',
      "    ]);",
    ]);
    expect(fmt("    const total: Decimal = sumDecimals(order.lines, (item) => item.unitPrice.amount.times(item.quantity)).minus(order.discount);")).toEqual([
      "    const total: Decimal = sumDecimals(order.lines, (item) =>",
      "      item.unitPrice.amount.times(item.quantity),",
      "    ).minus(order.discount);",
    ]);
  });

  test("member chains with several calls and non-trivial arguments put one call per line", () => {
    expect(fmt("      discount: sumDecimals(this.lines, (item) => item.unitPrice.amount.times(item.quantity)).times(new Decimal(percent).div(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),")).toEqual([
      "      discount: sumDecimals(this.lines, (item) => item.unitPrice.amount.times(item.quantity))",
      "        .times(new Decimal(percent).div(100))",
      "        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP),",
    ]);
  });

  test("parentheses are Prettier's: redundant ones go, clarifying ones are added", () => {
    expect(formatExpression("f((a as T), (await b.c()))")).toBe("f(a as T, await b.c())");
    expect(formatExpression("x(a && b || c, a * b % c, (a + b) - c)")).toBe("x((a && b) || c, (a * b) % c, a + b - c)");
    expect(formatExpression("(a as T).b + -(-c) + (await d).e")).toBe("(a as T).b + -(-c) + (await d).e");
  });

  test("signatures: a sole object type parameter hugs; other parameter lists break one per line", () => {
    expect(fmt("  static start(args: { readonly id: UUID; readonly customerId: Id<\"Customer\">; readonly lines: ReadonlyArray<OrderLine> }): Transition<Order> {")).toEqual([
      "  static start(args: {",
      "    readonly id: UUID;",
      '    readonly customerId: Id<"Customer">;',
      "    readonly lines: ReadonlyArray<OrderLine>;",
      "  }): Transition<Order> {",
    ]);
    expect(fmt('  constructor(details: ErrorDetails = {}, message = "招待の有効期限は作成日時より後である必要があります", options?: ErrorOptions) {')).toEqual([
      "  constructor(",
      "    details: ErrorDetails = {},",
      '    message = "招待の有効期限は作成日時より後である必要があります",',
      "    options?: ErrorOptions,",
      "  ) {",
    ]);
  });

  test("type aliases, import lists, strings and display width", () => {
    expect(fmt("export type SalesEvent = LineAdded | LineRemoved | OrderCancelled | OrderOpened | OrderPlaced | QuantityChanged;")).toEqual([
      "export type SalesEvent =",
      "  LineAdded | LineRemoved | OrderCancelled | OrderOpened | OrderPlaced | QuantityChanged;",
    ]);
    expect(fmt('import { AggregateRoot, InstantSchema, type DomainEvent, type Id, idSchema, parseWith, StateGuard } from "../../runtime.js";')[0]).toBe("import {");
    expect(tsString('currency != "JPY"')).toBe("'currency != \"JPY\"'");
    expect(tsString("it's")).toBe('"it\'s"');
    expect(strWidth("招待")).toBe(4);
  });

  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model", asTypeScript(KITCHEN_SINK)],
    ["the context-map model", asTypeScript(CONTEXT_MAP)],
    ["the ordering model", asTypeScript(ORDERING)],
    ["the long-rules model", asTypeScript(LONG_RULES)],
  ])("%s: lines fit in 100 columns unless Prettier keeps them (one import, one string); never `=>` first or `return` alone", (_label, text) => {
    for (const f of gen(text).files) {
      if (!f.path.endsWith(".ts")) continue;
      const lines = f.content.split("\n");
      const unbreakable = (l: string) => /^(import|export) /.test(l) || /^\s*(?:[\w$]+: )?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),?$/.test(l);
      expect({ path: f.path, long: lines.filter((l) => strWidth(l) > 100 && !unbreakable(l)) }).toEqual({ path: f.path, long: [] });
      expect({ path: f.path, bad: lines.filter((l) => /^\s*=>/.test(l) || /^\s*(return|throw)\s*$/.test(l)) }).toEqual({ path: f.path, bad: [] });
    }
  });

  test("the long invariant is emitted as one real condition", () => {
    const src = gen(asTypeScript(LONG_RULES)).files.find((f) => f.path.endsWith("billing/domain/aggregates.ts"))!.content;
    expect(src).toContain(
      [
        "    if (!(",
        "      this.refunded === null ||",
        "      (this.captured !== null && this.refunded.amount.lte(this.captured.amount))",
        "    )) {",
        '      throw new RefundExceedsCapture({ rule: "refund_not_more_than_captured_amount", id: this.id });',
      ].join("\n"),
    );
  });
});

describe("TypeScript target: policies, context map and idempotency", () => {
  const out = gen(asTypeScript(CONTEXT_MAP));
  const file = (p: string) => out.files.find((f) => f.path === p);

  test("downstream imports the upstream's events; an anticorruption layer gets a translator seam and a scaffold", () => {
    const staffing = file("src/context_map/generated/staffing/application/policies.ts")!.content;
    expect(staffing).toContain('import * as hiringEvents from "../../hiring/domain/events.js";');
    expect(staffing).toContain("static readonly eventType = hiringEvents.CandidateAccepted.type;");
    expect(staffing).toMatch(/RegisterStaff\.create\(\{\s*candidateId: event\.id,\s*email: event\.email\.value,\s*joinedAt: event\.at,\s*source: Source\.hiring,?\s*\}\)/);
    expect(staffing).toContain("[hiringEvents.CandidateAccepted.type, [policies.registerAcceptedCandidate.onEvent]],");
    const payroll = file("src/context_map/generated/payroll/application/policies.ts")!.content;
    expect(payroll).toContain("export interface StaffingTranslator {");
    expect(payroll).toContain("const command = await this.#translator.openAccountForNewStaff(");
    expect(file("src/context_map/extensions/payroll/translators.ts")).toMatchObject({ ownership: "scaffold" });
    expect(file("src/context_map/extensions/payroll/translators.ts")!.content).toContain("export class FromStaffing implements StaffingTranslator {");
    expect(file("src/context_map/generated/hiring/application/policies.ts")).toBeUndefined();
  });

  test("an idempotent use case returns the recorded result and records before commit", () => {
    const src = gen(asTypeScript(KITCHEN_SINK)).files.find((f) => f.path.endsWith("ordering/application/use-cases.ts"))!.content;
    const body = src.slice(src.indexOf("export class RegisterCustomerUseCase"), src.indexOf("async #run", src.indexOf("export class RegisterCustomerUseCase")));
    expect(body).toContain('const key = String(command.requestId);\n    const recorded = await this.#idempotencyStore.get("register_customer", key);\n    if (recorded !== null) return recorded.value as UUID;');
    expect(body.indexOf("await this.#idempotencyStore.record(")).toBeLessThan(body.indexOf("await this.#unitOfWork.commit();"));
    expect(gen().files.some((f) => f.content.includes("IdempotencyStore,") || f.content.includes("#idempotencyStore"))).toBe(false);
  });
});

describe("TypeScript target: HTTP API and TanStack Query client", () => {
  const out = gen();
  const file = (p: string) => out.files.find((f) => f.path === `src/cleaning_platform/generated/${p}`)?.content ?? "";

  test("layout: shared modules in generated/api/, each context's contract and queries next to its domain (vertical); no hooks, no React API; the indexes do not load them", () => {
    const api = out.files.filter((f) => /\/api\/[^/]+\.ts$/.test(f.path)).map((f) => f.path.replace("src/cleaning_platform/generated/", ""));
    expect(api.sort()).toEqual([
      "api/authentication.ts",
      "api/client.ts",
      "api/contract.ts",
      "api/queries.ts",
      "api/rate-limit.ts",
      "api/register.ts",
      "api/runtime.ts",
      "api/server.ts",
      "cleaning-staff/api/contract.ts",
      "cleaning-staff/api/queries.ts",
      "staffing/api/contract.ts",
      "staffing/api/queries.ts",
    ]);
    expect(out.files.filter((f) => f.path.endsWith("-api.test.ts")).map((f) => f.path)).toEqual(["tests/generated/cleaning-staff-api.test.ts", "tests/generated/staffing-api.test.ts"]);
    expect(file("index.ts")).not.toContain("api");
    expect(file("cleaning-staff/index.ts")).not.toContain("api");
    const generated = out.files.filter((f) => f.path.endsWith(".ts") && !f.path.includes("/tests/") && !f.path.startsWith("tests/")).map((f) => f.content).join("\n");
    // No custom hooks and no React API anywhere: queryOptions / mutationOptions are the abstraction.
    expect(generated).not.toMatch(/from "react"|useApiClient|ApiClientContext|export function use(?!Case)[A-Z]/);
    expect(file("api/contract.ts") + file("api/client.ts") + file("api/server.ts") + file("api/runtime.ts")).not.toMatch(/react/);
    expect(file("cleaning-staff/api/contract.ts")).toContain('from "../../api/runtime.js";');
    expect(file("api/contract.ts")).toContain('import * as cleaningStaff from "../cleaning-staff/api/contract.js";');
  });

  test("contract: a POST per use case (command schema in, result out, error statuses), a GET per aggregate", () => {
    const contract = file("cleaning-staff/api/contract.ts");
    expect(contract).toContain('path: "/api/cleaning-staff/accept-invitation",\n      input: AcceptInvitation.schema,\n      output: z.void(),');
    expect(contract).toContain(
      "errors: {\n        constraint_violation: 400,\n        unauthenticated: 401,\n        not_authorized: 403,\n        invitation_not_found: 404,\n        invitation_not_deliverable: 409,\n        invalid_invitation_window: 422,\n      },",
    );
    expect(contract).toContain("output: uuidSchema,");
    expect(contract).toContain("errors: {\n        constraint_violation: 400,\n        unauthenticated: 401,\n        not_authorized: 403,\n        email_blocked: 422,\n        invalid_invitation_window: 422,\n      },");
    expect(contract).toContain('path: "/api/cleaning-staff/cleaning-staff-invitation/:id",\n      id: idSchema("CleaningStaffInvitation"),\n      idType: "string",\n      output: CleaningStaffInvitationJson,');
    expect(contract).toContain("acceptedAt: InstantSchema.nullable(),");
    expect(file("api/contract.ts")).toContain('export const API_BASE_PATH = "/api";');
    const root = gen(withApi(withoutApi(MODEL), '{ base_path: "" }')).files.find((f) => f.path.endsWith("cleaning-staff/api/contract.ts"))!.content;
    expect(root).toContain('path: "/cleaning-staff/issue-invitation",');
  });

  test("entities inside an aggregate's JSON form are plain objects (their own JSON schema)", () => {
    const sales = gen(withApi(ORDERING)).files.find((f) => f.path.endsWith("sales/api/contract.ts"))!.content;
    expect(sales.indexOf("export const OrderLineJson = z.object({")).toBeLessThan(sales.indexOf("export const OrderJson = z.object({"));
    expect(sales).toContain("lines: z.array(OrderLineJson)");
  });

  test("queries: one factory object per aggregate (object keys + queryOptions), created from the API client; the queryFn reads the key", () => {
    const q = file("cleaning-staff/api/queries.ts");
    expect(q).toContain('const cleaningStaffInvitationKey = {\n  scope: "cleaning-staff",\n  entity: "cleaning-staff-invitation",\n} as const;');
    expect(q).toContain("export function createCleaningStaffQueries(api: ApiClient) {\n  return {\n    cleaningStaffInvitation: {\n      all: () => [{ ...cleaningStaffInvitationKey }] as const,");
    expect(q).toContain('lists: () => [{ ...cleaningStaffInvitationKey, kind: "list" }] as const,');
    expect(q).toContain('details: () => [{ ...cleaningStaffInvitationKey, kind: "detail" }] as const,');
    expect(q).toContain('{ ...cleaningStaffInvitationKey, kind: "detail", id: id.toLowerCase() },');
    // The query function takes the id from the key by name (object keys) and passes the AbortSignal.
    expect(q).toContain("queryFn: ({ queryKey: [{ id }], signal }) =>\n            api.cleaningStaff.aggregates.cleaningStaffInvitation(id, { signal }),");
    // Not configurable: no options parameters; skipToken only in detailOrSkip (useSuspenseQuery rejects it).
    expect(q).toContain("detail: (id: string) =>");
    expect(q).toContain("detailOrSkip: (id: string | undefined) =>");
    expect(q.slice(q.indexOf("detail: (id"), q.indexOf("Like `detail`"))).not.toContain("skipToken");
    expect(q).toMatch(/id === undefined\s+\? skipToken/);
    expect(q).not.toMatch(/options\?:|Partial<|UseQueryOptions/);
    const code = q.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code.slice(0, code.indexOf("export function createCleaningStaffMutations"))).not.toMatch(/onSuccess|onError|onSettled|select|staleTime/);
    const all = file("api/queries.ts");
    expect(all).toContain("export function createApiQueries(api: ApiClient) {\n  return {\n    cleaningStaff: createCleaningStaffQueries(api),\n    staffing: createStaffingQueries(api),\n  };\n}");
    // Staffing's only use case is internal (run by a policy): it has no endpoint, so no mutations.
    expect(all).toContain("export function createApiMutations(api: ApiClient) {\n  return {\n    cleaningStaff: createCleaningStaffMutations(api),\n  };\n}");
    expect(all).toContain("export type ApiQueries = ReturnType<typeof createApiQueries>;");
  });

  test("mutations: mutationOptions that invalidate through the same factory object (detail by input id + lists, lists for created) and return the promise", () => {
    const q = file("cleaning-staff/api/queries.ts");
    expect(q).toContain("export function createCleaningStaffMutations(api: ApiClient) {\n  const queries = createCleaningStaffQueries(api);");
    const issue = q.slice(q.indexOf("issueInvitation: mutationOptions("), q.indexOf("acceptInvitation: mutationOptions("));
    expect(issue).toContain('mutationKey: [{ scope: "cleaning-staff", useCase: "issue-invitation" }],');
    expect(issue).toMatch(/onSuccess: \(_data, _input, _result, context\) =>\s+context\.client\.invalidateQueries\(\{ queryKey: queries\.cleaningStaffInvitation\.lists\(\) \}\),/);
    const accept = q.slice(q.indexOf("acceptInvitation: mutationOptions("), q.indexOf("revokeInvitation: mutationOptions("));
    expect(accept).toMatch(/onSuccess: \(_data, input, _result, context\) =>\s+Promise\.all\(\[/);
    expect(accept).toContain("queryKey: queries.cleaningStaffInvitation.detail(input.invitationId).queryKey,");
    expect(accept).not.toContain("setQueryData");
    // apply_to_job creates an Application: only the lists are stale.
    const secure = gen(withApi(SECURITY)).files.find((f) => f.path.endsWith("hiring/api/queries.ts"))!.content;
    expect(secure).toContain("context.client.invalidateQueries({ queryKey: queries.application.lists() }),");
  });

  test("String and Integer identities: keys are not lower-cased, Integer ids are numbers in keys and paths", () => {
    const files = gen(withApi(IDENTITIES)).files;
    const q = files.find((f) => f.path.endsWith("catalog/api/queries.ts"))!.content;
    expect(q).toMatch(/\{ \.\.\.productKey, kind: "detail", id \}/);
    expect(q).toMatch(/\{ \.\.\.shelfKey, kind: "detail", id \}/);
    expect(q).toContain("detail: (id: number) =>");
    expect(q).toContain("detailOrSkip: (id: number | undefined) =>");
    const contract = files.find((f) => f.path.endsWith("catalog/api/contract.ts"))!.content;
    expect(contract).toContain('idType: "number",');
  });

  test("register.ts augments TanStack Query's Register (a module, so it augments instead of replacing)", () => {
    const reg = file("api/register.ts");
    expect(reg).toContain('import type { ApiError } from "./runtime.js";');
    expect(reg).toContain('declare module "@tanstack/react-query" {\n  interface Register {\n    defaultError: DomainError | ApiError;');
  });

  test("server: dependencies are optional per use case / repository; routes are typed against the contract", () => {
    const server = file("api/server.ts");
    expect(server).toContain('readonly acceptInvitation?: Pick<cleaningStaff.AcceptInvitationUseCase, "execute">;');
    expect(server).toMatch(/useCaseRoute\(\s+contract\.cleaningStaff\.useCases\.acceptInvitation,\s+\(d\) => d\.cleaningStaff\?\.useCases\?\.acceptInvitation,\s+\),/);
    expect(server).toContain('import * as cleaningStaff from "../cleaning-staff/index.js";');
  });

  test("generated API tests use the factories like an app and check object-key matching", () => {
    const t = out.files.find((f) => f.path === "tests/generated/cleaning-staff-api.test.ts")!.content;
    expect(t).toContain("const queries = createApiQueries(api);\n  const mutations = createApiMutations(api);");
    expect(t).toContain("const cleaningStaffInvitationQueries = queries.cleaningStaff.cleaningStaffInvitation;");
    expect(t).toContain("new MutationObserver(queryClient, mutations.cleaningStaff.acceptInvitation)");
    expect(t).toContain('test("CleaningStaffInvitation: object query keys match by name", async () => {');
    expect(t).toContain("expect(invalidated()).toEqual([true, false, false, false]);");
    expect(t).not.toMatch(/fetchQuery|ensureQueryData/);
  });
});

describe("TypeScript target: authentication, authorization and rate limiting", () => {
  const out = gen(withApi(SECURITY));
  const file = (p: string) => out.files.find((f) => f.path === `src/secure_hiring/generated/${p}`)?.content ?? "";
  const useCases = file("hiring/application/use-cases.ts");
  const method = (cls: string) => useCases.slice(useCases.indexOf(`export class ${cls}`), useCases.indexOf("\n}\n", useCases.indexOf(`export class ${cls}`)));

  test("files: security.ts once, read access per context, the API's rate limiter and JWT authenticator, the security tests; jose only then", () => {
    const paths = out.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      "src/secure_hiring/generated/security.ts",
      "src/secure_hiring/generated/hiring/application/read-access.ts",
      "src/secure_hiring/generated/api/rate-limit.ts",
      "src/secure_hiring/generated/api/authentication.ts",
      "tests/generated/security.test.ts",
    ]));
    expect(JSON.parse(out.files.find((f) => f.path === "package.json")!.content).dependencies.jose).toBe(TS_SECURITY_DEPENDENCIES.jose);
    const withoutApi = gen(asTypeScript(SECURITY)).files.map((f) => f.path);
    expect(withoutApi).toContain("src/secure_hiring/generated/security.ts");
    expect(withoutApi.filter((p) => p.includes("/api/") || p.endsWith("security.test.ts"))).toEqual([]);
    expect(file("index.ts")).toContain('export * from "./security.js";');
    expect(file("security.ts")).toContain('export const ROLES = ["admin", "staff", "candidate"] as const;');
    expect(file("security.ts")).toContain("companyId: uuidSchema.nullable().default(null),");
    expect(file("security.ts")).toContain('companyId: claims["https://example.com/company_id"] ?? null,');
  });

  test("the role check is the first statement of execute, before idempotency, the transaction and any load", () => {
    const post = method("PostJobUseCase");
    const body = post.slice(post.indexOf("async execute(command: PostJob, principal: Principal | null): Promise<UUID> {"));
    const lines = body.split("\n").map((l) => l.trim());
    expect(lines[1]).toBe('authorize(principal, "post_job", ["admin", "staff"]);');
    // allow_if reads only the inputs: it runs right after the role check, before the idempotency lookup.
    expect(body.indexOf("allowIf(")).toBeLessThan(body.indexOf("this.#idempotencyStore.get("));
    expect(body).toContain("const key = `${principal.id}:${String(command.requestId)}`;");
  });

  test("allow_if over a loaded aggregate runs right after that load and before the first change", () => {
    const close = method("CloseJobUseCase");
    expect(close.indexOf('authorize(principal, "close_job"')).toBeLessThan(close.indexOf("this.#jobRepository.get("));
    expect(close.indexOf("this.#jobRepository.get(")).toBeLessThan(close.indexOf("allowIf("));
    expect(close.indexOf("allowIf(")).toBeLessThan(close.indexOf("job.close("));
    expect(close).toContain("#run(command: CloseJob, principal: Principal, afterCommit: DomainEvent[]): Promise<void>");
    expect(close).toMatch(/allowIf\(\s+hasRole\(principal, "admin"\) \|\|\s+\(principal\.companyId !== null && principal\.companyId === job\.companyId\),\s+"close_job",\s+\);/);
  });

  test("public and internal use cases take no principal; internal ones have no endpoint", () => {
    expect(method("CheckJobOpenUseCase")).toContain("async execute(command: CheckJobOpen): Promise<boolean>");
    expect(method("RecordAuditUseCase")).toContain("async execute(command: RecordAudit): Promise<UUID>");
    expect(file("hiring/api/contract.ts")).not.toContain("recordAudit");
    expect(file("api/server.ts")).not.toContain("recordAudit");
    expect(file("hiring/api/queries.ts")).not.toContain("recordAudit");
  });

  test("read access: roles before loading, allow_if on the loaded aggregate; the GET route reads through it", () => {
    const read = file("hiring/application/read-access.ts");
    expect(read).toContain("export async function readJob(\n  repository: Pick<JobRepository, \"get\">,\n  id: Id<\"Job\">,\n  principal: Principal | null,\n): Promise<Job | null> {");
    expect(read.indexOf('authorize(principal, "read Job"')).toBeLessThan(read.indexOf("await repository.get(id)"));
    expect(file("api/server.ts")).toMatch(/readRoute\(\s+contract\.hiring\.aggregates\.job,\s+\(d\) => d\.hiring\?\.repositories\?\.jobRepository,\s+hiring\.readJob,\s+\)/);
  });

  test("contract: each endpoint records who may call it and its rate limit", () => {
    const contract = file("hiring/api/contract.ts");
    expect(contract).toContain('auth: { kind: "principal", roles: ["admin", "staff"] },\n      rateLimit: { name: "post_job", requests: 5, windowSeconds: 60, by: "principal" },');
    expect(contract).toContain('auth: { kind: "public" },\n      rateLimit: { name: "check_job_open", requests: 100, windowSeconds: 60, by: "ip" },');
    expect(contract).toContain('rateLimit: { name: "apply_to_job", requests: 3, windowSeconds: 3600, by: "principal" },');
    expect(contract).toMatch(/name: "AuditEntry",[\s\S]*?rateLimit: null,/);
    expect(file("api/server.ts")).toContain("options: ApiHandlerOptions<Principal> = {},");
    expect(file("api/client.ts")).toContain("const errors = errorRegistry([...hiringErrors.ALL_ERRORS, ...SECURITY_ERRORS]);");
  });

  test("runtime: 401 challenge, 429 headers, getToken, typed client errors and the retry policy only with security", () => {
    const runtime = file("api/runtime.ts");
    expect(runtime).toContain("export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422;");
    expect(runtime).toContain('const challenge = invalid ? \'Bearer error="invalid_token"\' : "Bearer";');
    expect(runtime).toContain("export class RateLimitedError extends ApiError {");
    expect(runtime).toContain("export function apiRetry(failureCount: number, error: unknown): boolean {");
    expect(runtime).toContain('if (token) headers["authorization"] = "Bearer " + token;');
    expect(runtime).not.toMatch(/\/\/#(if|else|endif)/);
    const plain = gen(withApi(CONTEXT_MAP)).files.find((f) => f.path.endsWith("generated/api/runtime.ts"))!.content;
    expect(plain).not.toMatch(/RateLimit|getToken|Authenticator|\/\/#/);
    expect(plain).toContain("export type ErrorStatus = 400 | 404 | 409 | 422;");
  });

  test("the JWT authenticator verifies with the model's algorithms, issuer, audience and tolerance (jose)", () => {
    const auth = file("api/authentication.ts");
    expect(auth).toContain("algorithms: [...AUTHENTICATION.algorithms],");
    expect(auth).toContain('requiredClaims: ["exp", "sub"],');
    expect(file("security.ts")).toContain('algorithms: ["RS256", "ES256"],');
    expect(file("security.ts")).toContain("clockTolerance: 30,");
  });

  test("generated tests: scenario principals, derived authorization tests with untouched repositories, HTTP 401 / 403 / 429", () => {
    const close = out.files.find((f) => f.path === "tests/generated/hiring-close-job.test.ts")!.content;
    expect(close).toContain('test("authorization: a missing role is refused before any load", async () => {');
    expect(close).toContain('throw new Error("loaded before authorization");');
    expect(close).toContain('expect(error.details).toEqual({ action: "close_job", requiredRoles: ["admin", "staff"] });');
    const api = out.files.find((f) => f.path === "tests/generated/hiring-api.test.ts")!.content;
    expect(api).toContain('expect(missing.headers.get("www-authenticate")).toBe("Bearer");');
    expect(api).toContain('expect(refused.status).toBe(429);');
    expect(api).toContain('getToken: () => "test-token",');
    const security = out.files.find((f) => f.path === "tests/generated/security.test.ts")!.content;
    expect(security).toContain('test("alg none and HS256 signed with the public key are rejected", async () => {');
    expect(security).toContain('test("the bucket empties, refuses with the time to the next token, and refills", () => {');
  });
});

// ---------------------------------------------------------------------------
// Generated TypeScript actually runs
// ---------------------------------------------------------------------------

/**
 * Installs zod, decimal.js, typescript, vitest and the type packages once into a cache directory keyed by the
 * dependency versions; every generated project links its node_modules there.
 */
function installDependencies(deps: Record<string, string> = { ...TS_DEPENDENCIES }, prefix = "ddd-ts-deps"): { dir?: string; reason?: string } {
  const dir = join(tmpdir(), `${prefix}-${createHash("sha256").update(JSON.stringify(deps)).digest("hex").slice(0, 12)}`);
  const ready = join(dir, "node_modules/.ddd-ready");
  if (existsSync(ready)) return { dir };
  mkdirSync(dir, { recursive: true });
  const { zod, "decimal.js": decimal, ...dev } = deps;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ddd-ts-deps", private: true, type: "module", dependencies: { zod, "decimal.js": decimal }, devDependencies: dev }, null, 2));
  try {
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    if (r.exitCode !== 0 || !existsSync(join(dir, "node_modules/.bin/tsc"))) {
      return { reason: `bun install failed (exit ${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}` };
    }
  } catch (e) {
    return { reason: `bun install could not run: ${(e as Error).message}` };
  }
  writeFileSync(ready, "");
  return { dir };
}

const DEPS = process.env.DDD_SKIP_TS_RUN ? { reason: "DDD_SKIP_TS_RUN is set" } : installDependencies({ ...TS_DEPENDENCIES, ...TS_API_DEPENDENCIES, ...TS_SECURITY_DEPENDENCIES });
if (!DEPS.dir) console.warn(`skipping "generated TypeScript actually runs": ${DEPS.reason} (needs network once to install zod, decimal.js, typescript, vitest, react and @tanstack/react-query)`);

/**
 * Prettier and typescript-eslint, installed once like DEPS. typescript-eslint needs the TypeScript 6 compiler API
 * (TypeScript 7 has no programmatic API before 7.1), so this cache pins typescript ~6.0 next to the runtime deps.
 */
const LINT_DEPENDENCIES = {
  zod: TS_DEPENDENCIES.zod,
  "decimal.js": TS_DEPENDENCIES["decimal.js"],
  typescript: "~6.0.0",
  vitest: TS_DEPENDENCIES.vitest,
  "@types/node": TS_DEPENDENCIES["@types/node"],
  ...TS_API_DEPENDENCIES,
  ...TS_SECURITY_DEPENDENCIES,
  prettier: "^3.9.0",
  eslint: "^10.0.0",
  "typescript-eslint": "^8.71.0",
};
const LINT = !DEPS.dir ? { reason: DEPS.reason } : process.env.DDD_SKIP_TS_LINT ? { reason: "DDD_SKIP_TS_LINT is set" } : installDependencies(LINT_DEPENDENCIES, "ddd-ts-lint");
if (DEPS.dir && !LINT.dir) console.warn(`skipping the Prettier / typescript-eslint checks: ${LINT.reason}`);

/**
 * typescript-eslint's strictest type-aware preset (https://typescript-eslint.io/users/configs), with the usual
 * `^_` convention for intentionally unused parameters (the one TypeScript's noUnusedParameters already follows).
 */
const ESLINT_CONFIG = `import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "eslint.config.mjs"] },
  ...tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
);
`;

function writeProject(text: string, deps = DEPS.dir!): string {
  const dir = mkdtempSync(join(tmpdir(), "ddd-ts-gen-"));
  const out = generateTypeScript(analyze(text), text);
  for (const f of out.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  symlinkSync(join(deps, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** `prettier --check` over the generated TypeScript (the scaffolded .prettierrc.json sets printWidth 100). */
function prettierCheck(dir: string) {
  return run([join(LINT.dir!, "node_modules/.bin/prettier"), "--check", "src/**/*.ts", "tests/**/*.ts"], dir);
}

const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe.skipIf(!DEPS.dir)("generated TypeScript actually runs", () => {
  test("the example model: tsc --strict and vitest", () => {
    const dir = writeProject(MODEL);
    try {
      const tsc = run(["node_modules/.bin/tsc", "-p", "tsconfig.json"], dir);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
      const vitest = run(["node_modules/.bin/vitest", "run"], dir);
      expect(vitest.out).toMatch(/Tests\s+48 passed/);
      expect(vitest.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test.each([
    ["the sample model", MODEL, false],
    ["the kitchen-sink model (lists, decimals, dates, refs, entities, conditional events, no-transaction use cases)", KITCHEN_SINK, false],
    ["the context-map model (policies within and across contexts, anticorruption layer, subscriptions; HTTP API)", CONTEXT_MAP, true],
    ["the ordering model (arithmetic, durations, collection functions, constructors, with, let; HTTP API with entities)", ORDERING, true],
    ["the long-rules model (wrapped invariants, guards, emits conditions and use-case conditions must still fire)", LONG_RULES, false],
    ["the identities model (String and Integer aggregate identities through the HTTP API)", IDENTITIES, true],
    ["the security model (roles, allow_if, public / internal use cases, bearer JWT, rate limits; HTTP API)", SECURITY, true],
    ["the security model without the HTTP API (authorized use cases and read access only)", SECURITY, false],
    ["a model reflected from the discovery board", FROM_BOARD, false],
    ["the sample with locally proposed scenarios added", proposeLocally(MODEL, "CleaningStaff", "CleaningStaffInvitation", "scenarios")!.yaml, false],
  ] as [string, string, boolean][])("tsc --strict and bun test pass for %s; every derived violation test fails without the checks", (_label, source, api) => {
    // Every row has all three values: bun treats an extra declared parameter as a `done` callback.
    const text = api ? withApi(asTypeScript(source, "bun")) : asTypeScript(source, "bun");
    const dir = writeProject(text);
    try {
      const tsc = run(["node_modules/.bin/tsc", "-p", "tsconfig.json"], dir);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
      if (LINT.dir) {
        const prettier = prettierCheck(dir);
        expect({ code: prettier.code, out: prettier.code ? prettier.out : "" }).toEqual({ code: 0, out: "" });
      }
      const tests = run(["bun", "test"], dir);
      if (existsSync(join(dir, "tests/generated"))) {
        expect(tests.out).toMatch(/\b0 fail/);
        expect(tests.out).toMatch(/[1-9]\d* pass/);
        expect(tests.code).toBe(0);
      }
      // Mutation check: with every invariant's throw disabled, each derived violation test must fail.
      const analysis = analyze(text);
      for (const ca of analysis.contexts.values()) {
        const derived = deriveViolations(ca).length;
        if (!derived) continue;
        const L = new TsLayout(analysis.model, ca);
        for (const m of ["value-objects", "entities", "aggregates"] as const) {
          const path = join(dir, L.file(L.mod(m)));
          writeFileSync(path, readFileSync(path, "utf8").replace(/throw (new \w+\(\{\s*rule: )/g, "void $1"));
        }
        const mutated = run(["bun", "test", L.file(L.testModule("invariants"))], dir);
        expect({ context: ca.ir.name, fail: /(\d+) fail/.exec(mutated.out)?.[1] }).toEqual({ context: ca.ir.name, fail: String(derived) });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test.skipIf(!LINT.dir)("typescript-eslint strict-type-checked and Prettier find nothing in any generated project", () => {
    const models: [string, string][] = [
      ["sample", MODEL],
      ["kitchen-sink", asTypeScript(KITCHEN_SINK)],
      ["context-map", withApi(CONTEXT_MAP)],
      ["ordering", withApi(ORDERING)],
      ["long-rules", asTypeScript(LONG_RULES)],
      ["identities", withApi(IDENTITIES)],
      ["security", withApi(SECURITY)],
      ["from-board", asTypeScript(FROM_BOARD)],
      ["proposed", proposeLocally(MODEL, "CleaningStaff", "CleaningStaffInvitation", "scenarios")!.yaml],
    ];
    // One project at a time: typed linting loads a whole TypeScript program.
    for (const [name, text] of models) {
      const dir = writeProject(text, LINT.dir!);
      try {
        writeFileSync(join(dir, "eslint.config.mjs"), ESLINT_CONFIG);
        const eslint = run(["node_modules/.bin/eslint", "--max-warnings", "0", "."], dir);
        expect({ name, code: eslint.code, out: eslint.out.trim() }).toEqual({ name, code: 0, out: "" });
        const prettier = prettierCheck(dir);
        expect({ name, code: prettier.code, out: prettier.code ? prettier.out : "" }).toEqual({ name, code: 0, out: "" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 600_000);
});
