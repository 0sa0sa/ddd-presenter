/**
 * Multi-tenancy and RBAC (docs/09 §22): what both targets emit for `security.tenancy` and map-form roles (resolved
 * permission maps, authorization by permission and scope, tenant-bound repositories, the tenant in every statement,
 * RLS DDL and `set_config` per transaction, policies in the event's tenant, the HTTP tenant checks), that models without
 * tenancy and with list-form roles are untouched, and that the generated code really runs: the generated test suites
 * (TypeScript: tsc --strict, Prettier, bun test, typescript-eslint; Python: pytest, mypy --strict, ruff) with
 * `rls: on` and `off`, and on PGlite as a non-superuser role: a raw SELECT sees one tenant, writes of another fail.
 */
import { describe, expect, test } from "bun:test";
import { validateModelText } from "@ddd/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatePython, generateTypeScript, type GenerationOutput } from "../src/index.ts";
import { psycopgText, queryStatements, repositorySql } from "../src/sql.ts";
import { TS_API_DEPENDENCIES, TS_DEPENDENCIES, TS_SECURITY_DEPENDENCIES } from "../src/typescript/index.ts";
import { planQuery, tableOf } from "@ddd/core";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const TENANCY = fixture("tenancy.ddd.yaml");
const RLS_OFF = TENANCY.replace("    isolation: row\n", "    isolation: row\n    rls: off\n");
const EXAMPLE = join(import.meta.dir, "../../../examples/cleaning-platform");

function analyze(text: string) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  return r.analysis!;
}

function asTypeScript(text: string, api = true): string {
  return text.replace(/^generation:\n/m, `generation:\n  target: typescript\n  typescript:\n    test_runner: bun\n${api ? "    api: { base_path: /api }\n" : ""}`);
}

const ts = (text = TENANCY, api = true) => generateTypeScript(analyze(asTypeScript(text, api)), asTypeScript(text, api));
const py = (text = TENANCY) => generatePython(analyze(text), text);
/** Containment ignoring whitespace (the generated code is formatted, lines break where they do not fit). */
const has = (text: string, part: string) => expect(text.replace(/\s+/g, "")).toContain(part.replace(/\s+/g, ""));
const file = (out: GenerationOutput, suffix: string) => {
  const f = out.files.find((x) => x.path.endsWith(suffix));
  if (!f) throw new Error(`no generated file ends with ${suffix}`);
  return f.content;
};

describe("tenancy and RBAC: TypeScript emission", () => {
  const out = ts();

  test("the role hierarchy and permissions are resolved at generation time into frozen maps", () => {
    const sec = file(out, "generated/security.ts");
    has(sec, 'admin: frozen("admin", "staff"),');
    has(sec, 'admin: frozen("invitation.issue", "invitation.list", "invitation.read", "invitation.revoke"),');
    has(sec, 'support: frozen("invitation.read", "invitation.revoke", "template.manage"),');
    has(sec, "export function hasPermission(principal: Principal, permission: Permission): boolean {");
    has(sec, 'if (principal.tenantId === null) throw new Unauthenticated({ action, error: "missing_tenant" });');
    has(sec, "export function authorizeAcrossTenants(");
    has(sec, "export interface CrossTenantAudit {");
    // Tenant roles hold in the active tenant only; platform roles come from their own claim.
    has(sec, 'roles: tenantId === null ? [] : listClaim(claims["roles"]).filter((role) => RoleSchema.safeParse(role).success),');
    has(sec, 'platformRoles: listClaim(claims["platform_roles"]).filter((role) => PlatformRoleSchema.safeParse(role).success');
  });

  test("use cases authorize by permission in the caller's tenant; repositories, factories and idempotency keys are tenant-bound", () => {
    const uc = file(out, "hiring/application/use-cases.ts");
    has(uc, 'authorizeInTenant(principal, "issue_invitation", { permissions: ["invitation.issue"] });');
    has(uc, "const key = `${principal.tenantId}:${principal.id}:${String(command.requestId)}`;");
    has(uc, "tenantId: tenant,");
    has(uc, "await this.#invitationRepository.save(tenant, invitation);");
    has(uc, "await this.#invitationRepository.get(");
    // Cross-tenant: platform roles, the target tenant from the command, audited before anything is loaded.
    has(uc, 'authorizeAcrossTenants(principal, "support_revoke_invitation", { permissions: ["invitation.revoke"]');
    has(uc, 'await this.#audit.record({ action: "support_revoke_invitation", principal, tenantId: command.tenantId');
    // Shared data: no tenant.
    has(uc, 'authorize(principal, "define_template", { permissions: ["template.manage"] });');
    const ports = file(out, "hiring/application/ports.ts");
    has(ports, "get(tenant: TenantId, id: Id<\"Invitation\">): Awaitable<Invitation | null>;");
    has(ports, "save(tenant: TenantId, aggregate: Invitation): Awaitable<void>;");
    has(ports, "get(id: Id<\"InvitationTemplate\">): Awaitable<InvitationTemplate | null>;");
    const ag = file(out, "hiring/domain/aggregates.ts");
    has(ag, "readonly tenantId: TenantId;");
    has(ag, '#with(changes: Partial<Omit<InvitationInput, "tenantId">>): Invitation {');
    has(file(out, "hiring/domain/events.ts"), "tenantId: TenantIdSchema,");
  });

  test("policies run internal use cases in the tenant of their event", () => {
    const p = file(out, "staffing/application/policies.ts");
    has(p, "execute(command: RegisterStaff, context: TenantContext): Promise<unknown>;");
    has(p, "await this.#useCase.execute(command, { tenantId: event.tenantId });");
    has(file(out, "staffing/application/use-cases.ts"), "async execute(command: RegisterStaff, context: TenantContext): Promise<UUID> {");
  });

  test("queries always filter by the caller's tenant and bind cursors to it", () => {
    const q = file(out, "hiring/application/queries.ts");
    has(q, 'authorizeInTenant(principal, "search_invitations", { permissions: ["invitation.list"] });');
    has(q, "tenant: principal.tenantId");
    has(q, 'tenant: "tenant_id",');
    const pg = file(out, "hiring/persistence/postgres.ts");
    has(pg, "WHERE tenant_id = $1::uuid");
    has(pg, "{ tenant: true }");
    has(pg, "constructor(db: SqlTransactions)");
    has(file(out, "generated/persistence.ts"), "export const SET_TENANT = \"SELECT set_config('app.tenant_id', $1::text, true)\";");
  });

  test("the HTTP API checks the token's tenant: 401 without one, 403 for another one in the path, limits by tenant", () => {
    const rt = file(out, "generated/api/runtime.ts");
    has(rt, "if (tenant === null) return unauthenticated(MISSING_TENANT, headers);");
    has(rt, 'details: { error: "tenant_mismatch" },');
    has(rt, 'const subject = limit.by === "tenant" && tenant !== null ? tenant : principal.id;');
    const contract = file(out, "hiring/api/contract.ts");
    has(contract, 'auth: { kind: "principal", roles: [], permissions: ["invitation.issue"], tenant: true },');
    has(contract, 'by: "tenant"');
    has(file(out, "generated/api/rate-limit.ts"), 'readonly by: "principal" | "ip" | "global" | "tenant";');
    has(file(out, "generated/api/server.ts"), "tenantReadRoute(");
  });

  test("generated tests cover permissions, tenant isolation, events, platform roles and HTTP", () => {
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("tests/generated/rbac.test.ts");
    const accept = file(out, "tests/generated/hiring-accept-invitation.test.ts");
    has(accept, "test(\"tenancy: another tenant's Invitation is not found\", async () => {");
    has(file(out, "tests/generated/hiring-issue-invitation.test.ts"), 'test("authorization: a token without an active tenant is refused before any load", async () => {');
    has(file(out, "tests/generated/hiring-support-revoke-invitation.test.ts"), 'test("authorization: tenant roles do not act across tenants", async () => {');
    has(file(out, "tests/generated/hiring-search-invitations.test.ts"), 'test("tenancy: a cursor is rejected in another tenant", async () => {');
    has(file(out, "tests/generated/hiring-persistence.test.ts"), "saving for another tenant is refused");
    has(file(out, "tests/generated/staffing-policies.test.ts"), "expect(useCase.contexts).toEqual([{ tenantId: event.tenantId }]);");
    const api = file(out, "tests/generated/hiring-api.test.ts");
    has(api, 'test("tenancy: a token without an active tenant is 401", async () => {');
    has(api, 'test("tenancy: a path naming another tenant than the token is 403", async () => {');
    has(api, 'test("tenancy: the rate limit of issue_invitation is per tenant", async () => {');
  });
});

describe("tenancy and RBAC: PostgreSQL and Python emission", () => {
  test("DDL: tenant_id, uniqueness and indexes per tenant, row level security that fails closed (rls: on only)", () => {
    const ddl = file(ts(), "sql/hiring.sql");
    has(ddl, "  tenant_id uuid NOT NULL,");
    has(ddl, "  UNIQUE (tenant_id, id)");
    has(ddl, "ALTER TABLE hiring.invitation ENABLE ROW LEVEL SECURITY;");
    has(ddl, "ALTER TABLE hiring.invitation FORCE ROW LEVEL SECURITY;");
    has(ddl, "CREATE POLICY tenant_isolation ON hiring.invitation\n  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)\n  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);");
    has(ddl, "ON hiring.invitation (tenant_id, created_at DESC, id DESC);");
    // Shared data has no tenant and no policy.
    expect(ddl).not.toContain("ALTER TABLE hiring.invitation_template");
    const off = file(ts(RLS_OFF), "sql/hiring.sql");
    expect(off).not.toContain("ROW LEVEL SECURITY");
    has(off, "  tenant_id uuid NOT NULL,");
    // Without RLS the repositories and readers do not set the tenant (the statements still filter by it).
    const offRuntime = file(ts(RLS_OFF), "generated/persistence.ts");
    expect(offRuntime).not.toContain("set_config");
    has(offRuntime, "export class PostgresTenantStore");
  });

  test("both targets embed the same tenant-scoped statements (Python with psycopg placeholders)", () => {
    const a = analyze(TENANCY);
    const ca = a.contexts.get("Hiring")!;
    const plan = planQuery(ca.ir, ca.fieldTypes, ca.ir.queries[0]!, a.model.security)!;
    const repo = repositorySql(tableOf(ca.ir, ca.fieldTypes, ca.ir.aggregates[1]!, a.model.security));
    expect(repo.select.text).toContain("WHERE tenant_id = $1::uuid AND id = $2::uuid");
    expect(repo.update.text).toContain("WHERE tenant_id = $1::uuid\n  AND id = $2::uuid\n  AND version = $");
    expect(repo.update.text.split("WHERE")[0]).not.toContain("tenant_id");
    const pyPg = file(py(), "hiring/persistence/postgres.py");
    for (const s of [...Object.values(queryStatements(plan)), repo.select, repo.insert, repo.update]) has(pyPg, psycopgText(s.text));
  });

  test("Python: permission maps, tenant-bound repositories and queries, policies in the event's tenant", () => {
    const out = py();
    const sec = file(out, "generated/security.py");
    has(sec, 'TenantId = NewType("TenantId", UUID)');
    has(sec, 'ROLE_INCLUDES: Final[Mapping[Role, tuple[Role, ...]]] = MappingProxyType(');
    has(sec, '"admin": ("admin", "staff"),');
    has(sec, "def authorize_in_tenant(");
    has(sec, 'raise Unauthenticated(action=action, error="missing_tenant")');
    const uc = file(out, "hiring/application/use_cases.py");
    has(uc, 'principal, tenant = authorize_in_tenant(principal, "issue_invitation", permissions=("invitation.issue",)');
    has(uc, 'key = f"{tenant}:{principal.id}:{command.request_id}"');
    has(uc, "self._invitation_repository.save(tenant, invitation)");
    has(file(out, "hiring/application/ports.py"), "def get(self, tenant: TenantId, id: UUID) -> Invitation | None: ...");
    has(file(out, "staffing/application/policies.py"), "self._use_case.execute(command, TenantContext(tenant_id=event.tenant_id))");
    has(file(out, "generated/_persistence.py"), "SET_TENANT = \"SELECT set_config('app.tenant_id', %(p1)s::text, true)\"");
    has(file(out, "generated/rate_limit.py"), 'by: Literal["principal", "ip", "global", "tenant"]');
  });
});

describe("models without tenancy and with list-form roles are unchanged", () => {
  test("the security fixture (list-form roles) generates no tenancy or permission code", () => {
    const text = fixture("security.ddd.yaml");
    for (const out of [generatePython(analyze(text), text), generateTypeScript(analyze(asTypeScript(text)), asTypeScript(text))]) {
      const all = out.files.map((f) => f.content).join("\n");
      expect(all).not.toMatch(/tenant|TenantId|PERMISSIONS|hasPermission|has_permission|ROLE_INCLUDES/);
    }
  });
});

// ---------------------------------------------------------------------------
// The generated code runs
// ---------------------------------------------------------------------------

/** Dependencies installed once into a cache directory keyed by their versions. */
function install(deps: Record<string, string>, prefix: string): { dir?: string; reason?: string } {
  if (process.env.DDD_SKIP_TS_RUN) return { reason: "DDD_SKIP_TS_RUN is set" };
  const dir = join(tmpdir(), `${prefix}-${createHash("sha256").update(JSON.stringify(deps)).digest("hex").slice(0, 12)}`);
  const ready = join(dir, "node_modules/.ddd-ready");
  if (existsSync(ready)) return { dir };
  mkdirSync(dir, { recursive: true });
  const { zod, "decimal.js": decimal, ...dev } = deps;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: prefix, private: true, type: "module", dependencies: { zod, "decimal.js": decimal }, devDependencies: dev }, null, 2));
  try {
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 240_000 });
    if (r.exitCode !== 0) return { reason: `bun install failed (exit ${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}` };
  } catch (e) {
    return { reason: `bun install could not run: ${(e as Error).message}` };
  }
  writeFileSync(ready, "");
  return { dir };
}

const DEPS = install({ ...TS_DEPENDENCIES, ...TS_API_DEPENDENCIES, ...TS_SECURITY_DEPENDENCIES, "@electric-sql/pglite": "^0.5.8" }, "ddd-ts-tenancy");
if (!DEPS.dir) console.warn(`skipping the TypeScript runs of the tenancy fixture: ${DEPS.reason}`);
const LINT = !DEPS.dir || process.env.DDD_SKIP_TS_LINT
  ? { reason: DEPS.reason ?? "DDD_SKIP_TS_LINT is set" }
  : install(
      {
        zod: TS_DEPENDENCIES.zod,
        "decimal.js": TS_DEPENDENCIES["decimal.js"],
        typescript: "~6.0.0",
        "@types/bun": TS_DEPENDENCIES["@types/bun"],
        ...TS_API_DEPENDENCIES,
        ...TS_SECURITY_DEPENDENCIES,
        "@electric-sql/pglite": "^0.5.8",
        prettier: "^3.9.0",
        eslint: "^10.0.0",
        "typescript-eslint": "^8.71.0",
      },
      "ddd-ts-tenancy-lint",
    );

const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

function writeProject(out: GenerationOutput, modules: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ddd-tenancy-"));
  for (const f of out.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  symlinkSync(join(modules, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const ESLINT_CONFIG = `import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "eslint.config.mjs"] },
  ...tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
);
`;

describe.skipIf(!DEPS.dir)("the generated TypeScript of the tenancy fixture runs", () => {
  test.each([
    ["rls: on, HTTP API", TENANCY, true, "on"],
    ["rls: off, HTTP API", RLS_OFF, true, "off"],
    ["rls: on, no HTTP API", TENANCY, false, "on"],
  ] as [string, string, boolean, string][])("tsc --strict, Prettier, the generated tests and PGlite (%s)", (_label, text, api, rls) => {
    const dir = writeProject(ts(text, api), DEPS.dir!);
    try {
      const tsc = run(["node_modules/.bin/tsc", "-p", "tsconfig.json"], dir);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
      if (LINT.dir) {
        const prettier = run([join(LINT.dir, "node_modules/.bin/prettier"), "--check", "src/**/*.ts", "tests/**/*.ts"], dir);
        expect({ code: prettier.code, out: prettier.code ? prettier.out : "" }).toEqual({ code: 0, out: "" });
      }
      const tests = run(["bun", "test", "tests/generated"], dir);
      expect(tests.out).toMatch(/\b0 fail/);
      expect(tests.out).toMatch(/[1-9]\d* pass/);
      expect(tests.code).toBe(0);
      // PostgreSQL (PGlite) as a non-superuser application role.
      writeFileSync(join(dir, "tests/pglite.test.ts"), fixture("tenancy-pglite.test.ts.txt"));
      const pg = run(["bun", "test", "tests/pglite.test.ts"], dir, { RLS: rls });
      expect({ code: pg.code, fail: /(\d+) fail/.exec(pg.out)?.[1], out: pg.code ? pg.out : "" }).toEqual({ code: 0, fail: "0", out: "" });
      expect(pg.out).toMatch(rls === "on" ? /\b5 pass/ : /\b4 pass/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  test.skipIf(!LINT.dir)("typescript-eslint strict-type-checked finds nothing (rls: on and off)", () => {
    for (const text of [TENANCY, RLS_OFF]) {
      const dir = writeProject(ts(text), LINT.dir!);
      try {
        writeFileSync(join(dir, "eslint.config.mjs"), ESLINT_CONFIG);
        const eslint = run(["node_modules/.bin/eslint", "--max-warnings", "0", "."], dir);
        expect({ code: eslint.code, out: eslint.out.trim() }).toEqual({ code: 0, out: "" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 600_000);
});

const VENV = join(EXAMPLE, ".venv/bin");

describe.skipIf(!existsSync(join(VENV, "python")))("the generated Python of the tenancy fixture runs", () => {
  test.each([
    ["rls: on", TENANCY],
    ["rls: off", RLS_OFF],
  ])("pytest, mypy --strict, ruff check and ruff format (%s)", (_label, text) => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-tenancy-py-"));
    try {
      for (const f of py(text).files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      writeFileSync(join(dir, "pyproject.toml"), readFileSync(join(EXAMPLE, "pyproject.toml")));
      const pytest = run([join(VENV, "python"), "-m", "pytest", "-q", "-p", "no:cacheprovider"], dir);
      expect(pytest.out).toMatch(/\d+ passed/);
      expect(pytest.code).toBe(0);
      const mypy = run([join(VENV, "python"), "-m", "mypy", "src", "tests"], dir);
      expect(mypy.out).toContain("Success");
      if (existsSync(join(VENV, "ruff"))) {
        expect(run([join(VENV, "ruff"), "check", "src", "tests"], dir).code).toBe(0);
        expect(run([join(VENV, "ruff"), "format", "--check", "src", "tests"], dir).code).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
