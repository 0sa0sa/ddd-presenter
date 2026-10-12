/**
 * Authentication, authorization and rate limiting (`security`, docs/09 §20): model-level checks and the helpers the
 * validator and both generators share (who may run what, which rate limit applies, the principal a scenario runs as).
 */
import type { PrincipalEnv } from "./checker.ts";
import type { DiagnosticBag } from "./diagnostics.ts";
import {
  JWT_ALGORITHMS,
  PERMISSION_PATTERN,
  PRINCIPAL_CLAIM_TYPES,
  RATE_LIMIT_UNIT_SECONDS,
  type AggregateIR,
  type AuthorizeIR,
  type ContextIR,
  type ModelIR,
  type RateLimitIR,
  type RoleDefIR,
  type ScenarioValue,
  type SecurityIR,
  type StepIR,
  type UseCaseIR,
  type UseCaseScenarioIR,
} from "./ir.ts";
import { closest, T, type Type } from "./types.ts";

const SNAKE = /^[a-z][a-z0-9_]*$/;
/** Members of every principal; claims cannot use these names. */
export const PRINCIPAL_BUILTIN_MEMBERS = ["id", "roles"] as const;
/** Names the generated security modules define next to the model's types (reserved once `security` is declared). */
export const SECURITY_TYPE_NAMES = ["Principal", "PrincipalInput", "Role", "NotAuthorized", "Unauthenticated", "RateLimit", "RateLimiter"] as const;
/** Names the generated security module adds with permissions (map-form roles) or tenancy. */
export const RBAC_TYPE_NAMES = ["Permission", "PlatformRole", "Requirement", "TenantId", "TenantContext", "TenantMismatch", "CrossTenantAudit", "CrossTenantAccess"] as const;
/** Claim names the generated Principal class / schema uses for itself. */
const RESERVED_CLAIMS = new Set(["id", "roles", "has_role", "parse", "create"]);
/** Principal members added by tenancy and permissions. */
const TENANCY_RESERVED_CLAIMS = new Set(["tenant_id", "platform_roles", "has_permission"]);

/** Type of a declared principal claim (`List[String]` is the only list), or undefined when not allowed. */
export function claimType(src: string): Type | undefined {
  const s = src.replace(/\s+/g, "");
  if (s === "List[String]") return { k: "list", item: T.String };
  if (s === "String" || s === "UUID" || s === "Integer" || s === "Boolean") return { k: "primitive", name: s };
  return undefined;
}

/** `principal.id`, `principal.roles` and the declared claims with their types, as rules see them. */
export function principalMembers(security: SecurityIR): Map<string, Type> {
  const m = new Map<string, Type>([
    ["id", security.principal.idType === "UUID" ? T.UUID : T.String],
    ["roles", { k: "list", item: T.String }],
  ]);
  if (security.tenancy) {
    m.set("tenant_id", { k: "optional", inner: security.tenancy.type === "UUID" ? T.UUID : T.String });
    m.set("platform_roles", { k: "list", item: T.String });
  }
  for (const c of security.principal.claims) {
    const t = claimType(c.type);
    if (t && !m.has(c.name)) m.set(c.name, c.required ? t : { k: "optional", inner: t });
  }
  return m;
}

export function principalEnv(security: SecurityIR): PrincipalEnv {
  const env: PrincipalEnv = { members: principalMembers(security), roles: security.roles };
  if (security.platformRoles.length) env.roles = [...security.roles, ...security.platformRoles.map((d) => d.name)];
  if (security.roleDefs || security.platformRoles.length) env.permissions = allPermissions(security);
  return env;
}

/** Whether running it needs an authenticated principal (`execute(command, principal)`). */
export function requiresPrincipal(owner: { authorize?: AuthorizeIR }): boolean {
  return owner.authorize?.kind === "principal";
}

/** Whether the use case is served over HTTP (everything but `authorize: internal`). */
export function servedOverHttp(uc: UseCaseIR): boolean {
  return uc.authorize?.kind !== "internal";
}

/**
 * The leading `load` steps of a use case: the only steps that may run before `authorize.allow_if` (they read, they do
 * not change anything). `allow_if` may use their variables.
 */
export function leadingLoads(steps: StepIR[]): Extract<StepIR, { kind: "load" }>[] {
  const out: Extract<StepIR, { kind: "load" }>[] = [];
  for (const s of steps) {
    if (s.kind !== "load") break;
    out.push(s);
  }
  return out;
}

/** The rate limit of an endpoint: its own, none (`rate_limit: none`), or `security.rate_limits.default`. */
export function effectiveRateLimit(model: ModelIR, owner: { rateLimit?: RateLimitIR | "none" }): RateLimitIR | undefined {
  if (!model.security) return undefined;
  if (owner.rateLimit === "none") return undefined;
  return owner.rateLimit ?? model.security.rateLimits.default;
}

export function windowSeconds(limit: RateLimitIR): number {
  return RATE_LIMIT_UNIT_SECONDS[limit.per];
}

/** The principal a scenario runs as: `given.principal`, completed with defaults (docs/10 §7). */
export interface ResolvedPrincipal {
  anonymous: boolean;
  id: string;
  roles: string[];
  /** Every declared claim: the given value, or null (optional) / a typed default (required). */
  claims: Record<string, ScenarioValue>;
  /** With `security.tenancy`: the active tenant (null: none) and the platform roles. Absent without tenancy. */
  tenant?: string | null;
  platformRoles?: string[];
}

export const DEFAULT_PRINCIPAL_IDS = { UUID: "00000000-0000-4000-8000-000000000001", String: "test-principal" } as const;
/** The tenant generated tests and scenarios run in (given aggregates are seeded into it), and another one. */
export const DEFAULT_TENANT_IDS = { UUID: "00000000-0000-4000-8000-0000000000a1", String: "tenant-a" } as const;
export const OTHER_TENANT_IDS = { UUID: "00000000-0000-4000-8000-0000000000b2", String: "tenant-b" } as const;

function claimDefault(src: string): ScenarioValue {
  switch (claimType(src)?.k === "list" ? "List" : src.replace(/\s+/g, "")) {
    case "UUID":
      return "00000000-0000-4000-8000-000000000000";
    case "Integer":
      return 0;
    case "Boolean":
      return false;
    case "List":
      return [];
    default:
      return "test";
  }
}

/**
 * The principal of a scenario. Without `given.principal`, a use case that needs one runs as a default principal with
 * every role its `authorize.roles` lists.
 */
export function scenarioPrincipal(security: SecurityIR, owner: { authorize?: AuthorizeIR }, sc: { given: Pick<UseCaseScenarioIR["given"], "principal"> }): ResolvedPrincipal {
  const given = sc.given.principal;
  if (given?.anonymous) return { anonymous: true, id: "", roles: [], claims: {}, ...(security.tenancy ? { tenant: null, platformRoles: [] } : {}) };
  const defaults = given ? undefined : defaultRoles(security, owner.authorize);
  return makePrincipal(security, {
    id: given?.id,
    roles: given ? given.roles : (defaults?.roles ?? []),
    claims: given?.claims ?? {},
    ...(given && "tenant" in given ? { tenant: given.tenant } : {}),
    platformRoles: given ? (given.platformRoles ?? []) : (defaults?.platformRoles ?? []),
  });
}

/**
 * The roles of the default principal of an `authorize`: every listed role (as before permissions existed) and, for
 * each permission no listed role grants, the first declared role granting it — tenant roles in a tenant, platform
 * roles across tenants.
 */
export function defaultRoles(security: SecurityIR, authorize: AuthorizeIR | undefined): { roles: string[]; platformRoles: string[] } {
  const listed = authorize?.roles ?? [];
  const roles = listed.filter((r) => security.roles.includes(r));
  const platformRoles = listed.filter((r) => security.platformRoles.some((p) => p.name === r));
  const platformOnly = !!authorize?.crossTenant;
  for (const p of authorize?.permissions ?? []) {
    const held = [...roles.map((r) => rolePermissions(security, "tenant").get(r) ?? []), ...platformRoles.map((r) => rolePermissions(security, "platform").get(r) ?? [])];
    if (held.some((ps) => ps.includes(p))) continue;
    // The least privileged choice: a role granting it itself before one that inherits it.
    const pick = (kind: "tenant" | "platform") =>
      defsOf(security, kind).find((d) => d.permissions.includes(p))?.name ?? [...rolePermissions(security, kind)].find(([, ps]) => ps.includes(p))?.[0];
    const tenantRole = platformOnly ? undefined : pick("tenant");
    if (tenantRole) {
      roles.push(tenantRole);
      continue;
    }
    const platformRole = pick("platform");
    if (platformRole) platformRoles.push(platformRole);
  }
  return { roles, platformRoles };
}

/** A principal with the given roles (claims and id as in `base`, defaults otherwise). */
export function makePrincipal(
  security: SecurityIR,
  base: { id?: ScenarioValue; roles: string[]; claims: Record<string, ScenarioValue>; tenant?: ScenarioValue; platformRoles?: string[] },
): ResolvedPrincipal {
  const claims: Record<string, ScenarioValue> = {};
  for (const c of security.principal.claims) {
    claims[c.name] = c.name in base.claims ? base.claims[c.name] : c.required ? claimDefault(c.type) : null;
  }
  const id = base.id === undefined || base.id === null ? DEFAULT_PRINCIPAL_IDS[security.principal.idType] : String(base.id);
  const p: ResolvedPrincipal = { anonymous: false, id, roles: [...base.roles], claims };
  if (security.tenancy) {
    p.tenant = base.tenant === undefined ? DEFAULT_TENANT_IDS[security.tenancy.type] : base.tenant === null ? null : String(base.tenant);
    p.platformRoles = [...(base.platformRoles ?? [])];
  }
  return p;
}

/**
 * Roles a principal can hold that satisfy none of `authorize` (for the generated "missing role" test): tenant roles
 * that neither include a listed role (by inheritance) nor grant a listed permission.
 */
export function otherRoles(security: SecurityIR, authorize: AuthorizeIR): string[] {
  if (!security.roleDefs) return security.roles.filter((r) => !authorize.roles.includes(r));
  const includes = roleIncludes(security, "tenant");
  const perms = rolePermissions(security, "tenant");
  return security.roles.filter((r) => !(includes.get(r) ?? []).some((x) => authorize.roles.includes(x)) && !(perms.get(r) ?? []).some((p) => (authorize.permissions ?? []).includes(p)));
}

// ---------------------------------------------------------------------------
// RBAC: role hierarchy and permissions (NIST RBAC1), resolved at generation time
// ---------------------------------------------------------------------------

/** Whether roles are declared in the map form (permissions, inheritance): the generated code checks permissions. */
export function usesPermissions(security: SecurityIR | undefined): boolean {
  return !!security?.roleDefs;
}

function defsOf(security: SecurityIR, kind: "tenant" | "platform"): RoleDefIR[] {
  return kind === "platform" ? security.platformRoles : (security.roleDefs ?? security.roles.map((name) => ({ name, inherits: [], permissions: [], path: security.path })));
}

/**
 * Role → itself and every role it inherits, directly or transitively (in breadth-first order). Cycles and unknown
 * roles are reported by the validator; here they are skipped.
 */
export function roleIncludes(security: SecurityIR, kind: "tenant" | "platform"): Map<string, string[]> {
  const defs = defsOf(security, kind);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out = new Map<string, string[]>();
  for (const d of defs) {
    const seen = [d.name];
    for (let i = 0; i < seen.length; i++) {
      for (const parent of byName.get(seen[i]!)?.inherits ?? []) if (byName.has(parent) && !seen.includes(parent)) seen.push(parent);
    }
    out.set(d.name, seen);
  }
  return out;
}

/** Role → the permissions it grants (its own and its inherited roles'), sorted. */
export function rolePermissions(security: SecurityIR, kind: "tenant" | "platform"): Map<string, string[]> {
  const defs = defsOf(security, kind);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out = new Map<string, string[]>();
  for (const [role, included] of roleIncludes(security, kind)) {
    out.set(role, [...new Set(included.flatMap((r) => byName.get(r)?.permissions ?? []))].sort());
  }
  return out;
}

/**
 * Whether a (scenario) principal passes an authorize block where it runs: tenant roles count in a tenant, platform
 * roles across tenants, both for shared data; a held role passes for itself and every role it inherits.
 */
export function satisfies(security: SecurityIR, authorize: AuthorizeIR, p: ResolvedPrincipal, scope: AccessScope): boolean {
  if (authorize.kind !== "principal" || p.anonymous) return authorize.kind !== "principal";
  if (!authorize.roles.length && !authorize.permissions?.length) return true;
  const roles: string[] = [];
  const perms: string[] = [];
  const add = (kind: "tenant" | "platform", held: string[]) => {
    const includes = roleIncludes(security, kind);
    const granted = rolePermissions(security, kind);
    for (const r of held) {
      roles.push(...(includes.get(r) ?? [r]));
      perms.push(...(granted.get(r) ?? []));
    }
  };
  if (scope !== "cross_tenant") add("tenant", p.roles);
  if (scope === "cross_tenant" || scope === "global") add("platform", p.platformRoles ?? []);
  return authorize.roles.some((r) => roles.includes(r)) || (authorize.permissions ?? []).some((x) => perms.includes(x));
}

/** Every permission some role (tenant or platform) grants, sorted: the permissions authorize may name. */
export function allPermissions(security: SecurityIR): string[] {
  return [...new Set([...(security.roleDefs ?? []), ...security.platformRoles].flatMap((d) => d.permissions))].sort();
}

/** Permissions granted by some role of one kind. */
export function permissionsOf(security: SecurityIR, kind: "tenant" | "platform"): Set<string> {
  return new Set(defsOf(security, kind).flatMap((d) => d.permissions));
}

// ---------------------------------------------------------------------------
// Multi-tenancy (docs/09 §22): which aggregates and operations are tenant-scoped
// ---------------------------------------------------------------------------

/** Whether rows of the aggregate belong to one tenant (with `security.tenancy`, unless `tenancy: global`). */
export function isTenantScoped(security: SecurityIR | undefined, ag: Pick<AggregateIR, "tenancy">): boolean {
  return !!security?.tenancy && ag.tenancy !== "global";
}

/**
 * Where an operation runs: `none` without tenancy (as before); `tenant` in the caller's active tenant (it touches a
 * tenant-scoped aggregate); `cross_tenant` in a tenant its input names (platform roles only); `global` touches only
 * shared data (no tenant needed).
 */
export type AccessScope = "none" | "tenant" | "cross_tenant" | "global";

/** Aggregates a use case loads, creates or saves (with the ones it saves). */
export function touchedAggregates(uc: UseCaseIR): { all: Set<string>; saved: Set<string> } {
  const all = new Set<string>();
  const saved = new Set<string>();
  const vars = new Map<string, string>();
  const walk = (steps: StepIR[]) => {
    for (const s of steps) {
      if (s.kind === "load" || s.kind === "create") {
        all.add(s.aggregate);
        vars.set(s.as, s.aggregate);
      }
      if (s.kind === "save") {
        const ag = vars.get(s.target);
        if (ag) saved.add(ag);
      }
      if (s.kind === "if") {
        walk(s.then);
        walk(s.else);
      }
    }
  };
  walk(uc.steps);
  return { all, saved };
}

export function useCaseScope(security: SecurityIR | undefined, ctx: Pick<ContextIR, "aggregates">, uc: UseCaseIR): AccessScope {
  if (!security?.tenancy) return "none";
  const touched = [...touchedAggregates(uc).all].map((n) => ctx.aggregates.find((a) => a.name === n)).filter((a): a is AggregateIR => !!a);
  const tenant = touched.some((a) => isTenantScoped(security, a));
  if (uc.authorize?.crossTenant) return "cross_tenant";
  return tenant ? "tenant" : "global";
}

/** The scope of reading an aggregate (GET / read access) or a query over it. */
export function aggregateScope(security: SecurityIR | undefined, ag: Pick<AggregateIR, "tenancy">): AccessScope {
  if (!security?.tenancy) return "none";
  return isTenantScoped(security, ag) ? "tenant" : "global";
}

/** Whether a use case receives a tenant (from the principal, the input or a tenant context). */
export function usesTenant(scope: AccessScope): boolean {
  return scope === "tenant" || scope === "cross_tenant";
}

/** The tenancy of the events an aggregate emits: tenant-scoped events carry the tenant id. */
export function eventIsTenantScoped(security: SecurityIR | undefined, ctx: Pick<ContextIR, "aggregates">, sources: { aggregate: string }[]): boolean {
  if (!security?.tenancy || !sources.length) return false;
  return sources.every((s) => {
    const ag = ctx.aggregates.find((a) => a.name === s.aggregate);
    return !!ag && isTenantScoped(security, ag);
  });
}

// ---------------------------------------------------------------------------
// Model-level checks (the security block itself, policies, endpoints without a decision)
// ---------------------------------------------------------------------------

export function checkSecurityBlock(bag: DiagnosticBag, model: ModelIR): void {
  const sec = model.security;
  if (!sec) {
    for (const ctx of model.contexts) checkUndeclaredSecurity(bag, ctx);
    return;
  }
  const el = "Security";
  if (sec.roles.length === 0) {
    bag.error("missing-roles", "security.roles must declare at least one role", [...sec.path, "roles"], { element: el, hint: "e.g. roles: [admin, staff]" });
  }
  const seen = new Set<string>();
  sec.roles.forEach((r, i) => {
    if (!SNAKE.test(r)) bag.error("invalid-name", `Role "${r}" must be snake_case`, [...sec.path, "roles", i], { element: el });
    if (seen.has(r)) bag.error("duplicate-name", `Duplicate role "${r}"`, [...sec.path, "roles", i], { element: el });
    seen.add(r);
  });
  const claimNames = new Set<string>();
  for (const c of sec.principal.claims) {
    if (!SNAKE.test(c.name)) bag.error("invalid-name", `Claim "${c.name}" must be snake_case`, [...c.path, "name"], { element: el });
    else if (RESERVED_CLAIMS.has(c.name)) {
      bag.error("reserved-name", `Claim name "${c.name}" is reserved`, [...c.path, "name"], { element: el, hint: "id and roles are built in; rename the claim (map it from the token with claim: <name>)" });
    }
    else if (sec.tenancy && TENANCY_RESERVED_CLAIMS.has(c.name)) {
      bag.error("reserved-name", `Claim name "${c.name}" is reserved with tenancy`, [...c.path, "name"], { element: el, hint: "principal.tenant_id is the active tenant (security.tenancy.claim) and platform_roles the platform roles; rename the claim" });
    }
    if (claimNames.has(c.name)) bag.error("duplicate-name", `Duplicate claim "${c.name}"`, [...c.path, "name"], { element: el });
    claimNames.add(c.name);
    if (!claimType(c.type)) {
      bag.error("invalid-claim-type", `Claim type "${c.type}" is not supported`, [...c.path, "type"], { element: el, hint: `Use one of ${PRINCIPAL_CLAIM_TYPES.join(", ")}` });
    }
  }
  checkRoleDefs(bag, sec);
  const auth = sec.authentication;
  if (auth) {
    const ael = "Security › authentication";
    if (auth.scheme === "bearer_jwt") {
      if (!auth.algorithms.length) bag.error("invalid-value", "algorithms must list at least one JWS algorithm", [...auth.path, "algorithms"], { element: ael });
      auth.algorithms.forEach((a, i) => {
        if (a.toLowerCase() === "none") {
          bag.error("insecure-algorithm", 'The "none" algorithm is never accepted (RFC 8725 §3.1)', [...auth.path, "algorithms", i], { element: ael, hint: "List the algorithm your identity provider signs with, e.g. RS256" });
        } else if (!(JWT_ALGORITHMS as readonly string[]).includes(a)) {
          const s = closest(a, JWT_ALGORITHMS);
          bag.error("invalid-value", `Unknown JWS algorithm "${a}"`, [...auth.path, "algorithms", i], { element: ael, hint: s ? `Did you mean "${s}"?` : `Use one of ${JWT_ALGORITHMS.join(", ")}` });
        }
      });
      const symmetric = auth.algorithms.filter((a) => a.startsWith("HS"));
      if (symmetric.length && symmetric.length < auth.algorithms.length) {
        bag.error("mixed-algorithms", "Do not mix HMAC (HS*) and public-key algorithms: a public key could then be used as an HMAC secret (RFC 8725 §3.1)", [...auth.path, "algorithms"], {
          element: ael,
          hint: "Accept one family, e.g. [RS256] or [HS256]",
        });
      }
      if (!auth.rolesClaim.trim()) bag.error("invalid-value", "roles_claim must name a JWT claim", [...auth.path, "roles_claim"], { element: ael });
    } else if (auth.issuer !== undefined || auth.audience !== undefined || auth.algorithms.join() !== "RS256") {
      bag.warning("unused-setting", "issuer, audience and algorithms only apply to scheme bearer_jwt", auth.path, { element: ael });
    }
  }
  if (sec.tenancy) checkTenancyClaims(bag, sec);
  const def = sec.rateLimits.default;
  if (def?.by === "tenant" && !sec.tenancy) {
    bag.error("tenancy-not-declared", "rate_limits.default by: tenant needs security.tenancy", [...def.path, "by"], { element: el, hint: "Declare security.tenancy, or count by principal / ip / global" });
  }
  for (const ctx of model.contexts) {
    for (const p of ctx.policies) {
      const uc = ctx.useCases.find((u) => u.name === p.run);
      if (uc && requiresPrincipal(uc)) {
        bag.error("policy-needs-principal", `Policy ${p.name} runs ${uc.name}, which needs an authenticated principal; a policy runs without one`, [...p.path, "run"], {
          element: `${ctx.name} › policy ${p.name}`,
          hint: `Declare authorize: internal on ${uc.name} (run in-process only, never served over HTTP)`,
        });
      }
    }
  }
}

/**
 * The map form of roles and the platform roles: names, inheritance within one kind (a tenant role never inherits a
 * platform role: that would hand cross-tenant power to a tenant), no cycles, dotted lowercase permissions.
 */
function checkRoleDefs(bag: DiagnosticBag, sec: SecurityIR): void {
  const el = "Security";
  const tenantNames = new Set(sec.roles);
  const platformNames = new Set(sec.platformRoles.map((d) => d.name));
  if (sec.platformRoles.length && !sec.tenancy) {
    bag.error("tenancy-not-declared", "platform_roles are cross-tenant roles and need security.tenancy", [...sec.path, "platform_roles"], { element: el, hint: "Declare security.tenancy, or declare these roles under roles" });
  }
  const seenPlatform = new Set<string>();
  for (const d of sec.platformRoles) {
    if (!SNAKE.test(d.name)) bag.error("invalid-name", `Platform role "${d.name}" must be snake_case`, d.path, { element: el });
    if (tenantNames.has(d.name)) {
      bag.error("duplicate-name", `"${d.name}" is both a role and a platform role`, d.path, { element: el, hint: "Tenant roles and platform roles must have different names (a token's roles claim never grants a platform role)" });
    }
    if (seenPlatform.has(d.name)) bag.error("duplicate-name", `Duplicate platform role "${d.name}"`, d.path, { element: el });
    seenPlatform.add(d.name);
  }
  for (const [kind, defs] of [["tenant", sec.roleDefs ?? []], ["platform", sec.platformRoles]] as const) {
    const own = kind === "tenant" ? tenantNames : platformNames;
    const other = kind === "tenant" ? platformNames : tenantNames;
    for (const d of defs) {
      d.inherits.forEach((parent, i) => {
        const p = [...d.path, "inherits", i];
        if (own.has(parent)) return;
        if (other.has(parent)) {
          bag.error("invalid-inheritance", `${kind === "tenant" ? "Role" : "Platform role"} "${d.name}" cannot inherit ${kind === "tenant" ? "platform role" : "role"} "${parent}"`, p, {
            element: el,
            hint: kind === "tenant" ? "A tenant role inheriting a platform role would act across tenants; grant the permissions directly" : "Platform roles inherit platform roles only",
          });
          return;
        }
        const s = closest(parent, [...own]);
        bag.error("unknown-role", `Unknown ${kind === "tenant" ? "role" : "platform role"} "${parent}"`, p, { element: el, hint: s ? `Did you mean "${s}"?` : `Declared: ${[...own].join(", ") || "none"}` });
      });
      const seen = new Set<string>();
      d.permissions.forEach((perm, i) => {
        const p = [...d.path, "permissions", i];
        if (!PERMISSION_PATTERN.test(perm)) {
          bag.error("invalid-name", `Permission "${perm}" must be dotted lowercase (e.g. invitation.issue)`, p, { element: el, hint: "resource.action: lowercase snake_case segments separated by dots" });
        }
        if (seen.has(perm)) bag.error("duplicate-name", `Duplicate permission "${perm}" in ${d.name}`, p, { element: el });
        seen.add(perm);
      });
    }
    // Inheritance cycles (a role inheriting itself, directly or through others).
    const byName = new Map(defs.map((d) => [d.name, d]));
    const state = new Map<string, "visiting" | "done">();
    const reported = new Set<string>();
    const visit = (name: string, trail: string[]): void => {
      if (state.get(name) === "done") return;
      if (state.get(name) === "visiting") {
        const cycle = [...trail.slice(trail.indexOf(name)), name];
        const start = byName.get(name)!;
        if (!reported.has(name)) {
          for (const n of cycle) reported.add(n);
          bag.error("inheritance-cycle", `Role inheritance cycle: ${cycle.join(" → ")}`, [...start.path, "inherits"], { element: el, hint: "A role hierarchy must be acyclic (NIST RBAC1: a partial order)" });
        }
        return;
      }
      state.set(name, "visiting");
      for (const parent of byName.get(name)?.inherits ?? []) if (byName.has(parent)) visit(parent, [...trail, name]);
      state.set(name, "done");
    };
    for (const d of defs) visit(d.name, []);
  }
}

/** The tenant claim must not collide with the claims the generated code already reads. */
function checkTenancyClaims(bag: DiagnosticBag, sec: SecurityIR): void {
  const t = sec.tenancy!;
  const el = "Security › tenancy";
  if (!t.claim.trim()) bag.error("invalid-value", "tenancy.claim must name a JWT claim", [...t.path, "claim"], { element: el });
  const rolesClaim = sec.authentication?.rolesClaim ?? "roles";
  for (const [taken, what] of [["sub", "the principal id"], [rolesClaim, "the roles (roles_claim)"], [t.platformRolesClaim, "the platform roles (platform_roles_claim)"]] as const) {
    if (t.claim === taken) bag.error("invalid-value", `tenancy.claim "${t.claim}" is already read as ${what}`, [...t.path, "claim"], { element: el, hint: "Name the JWT claim carrying the active tenant, e.g. org_id" });
  }
  if (t.platformRolesClaim === rolesClaim || t.platformRolesClaim === "sub") {
    bag.error("invalid-value", `platform_roles_claim "${t.platformRolesClaim}" must differ from the roles claim and sub`, [...t.path, "platform_roles_claim"], { element: el, hint: "Platform roles come from their own claim so a tenant's roles never grant them" });
  }
  const fromClaim = sec.principal.claims.find((c) => (c.claim ?? c.name) === t.claim);
  if (fromClaim && fromClaim.type !== t.type && (fromClaim.type === "UUID" || fromClaim.type === "String")) {
    bag.error("type-mismatch", `tenancy.type ${t.type} differs from the type ${fromClaim.type} of claim ${fromClaim.name}, which reads the same JWT claim`, [...t.path, "type"], { element: el });
  }
}

/** Without a security block, authorize / rate_limit / given.principal have nothing to refer to. */
function checkUndeclaredSecurity(bag: DiagnosticBag, ctx: ContextIR): void {
  const hint = "Declare a top-level security block (roles, principal, authentication, rate_limits) first";
  const owners: { name: string; authorize?: AuthorizeIR; rateLimit?: RateLimitIR | "none"; path: (string | number)[] }[] = [...ctx.useCases, ...ctx.aggregates];
  for (const o of owners) {
    if (o.authorize) bag.error("security-not-declared", "authorize needs a top-level security block", o.authorize.path, { element: `${ctx.name} › ${o.name}`, hint });
    if (o.rateLimit) {
      const path = o.rateLimit === "none" ? [...o.path, "rate_limit"] : o.rateLimit.path;
      bag.error("security-not-declared", "rate_limit needs a top-level security block", path, { element: `${ctx.name} › ${o.name}`, hint });
    }
  }
  for (const uc of ctx.useCases) {
    for (const sc of uc.scenarios) {
      if (sc.given.principal) bag.error("security-not-declared", "given.principal needs a top-level security block", sc.given.principal.path, { element: `${ctx.name} › ${uc.name} › scenario ${sc.name}`, hint });
    }
  }
  for (const q of ctx.queries ?? []) {
    const element = `${ctx.name} › query ${q.name}`;
    if (q.authorize) bag.error("security-not-declared", "authorize needs a top-level security block", q.authorize.path, { element, hint });
    if (q.rateLimit) bag.error("security-not-declared", "rate_limit needs a top-level security block", q.rateLimit === "none" ? [...q.path, "rate_limit"] : q.rateLimit.path, { element, hint });
    for (const f of q.where) {
      if (f.principal !== undefined) bag.error("security-not-declared", "A filter by the principal needs a top-level security block", [...f.path, "principal"], { element, hint });
    }
    for (const sc of q.scenarios) {
      if (sc.given.principal) bag.error("security-not-declared", "given.principal needs a top-level security block", sc.given.principal.path, { element: `${element} › scenario ${sc.name}`, hint });
    }
  }
}

/** What an authorize block guards: the kind of owner and where it runs (docs/09 §22). */
export interface AuthorizeTarget {
  kind: "use case" | "aggregate" | "query";
  scope: AccessScope;
  /** The use case saves a shared (global) aggregate: only platform roles may change shared data. */
  writesGlobal?: boolean;
}

/**
 * Every role and permission an authorize block names must be declared, and fit where it runs: in a tenant only tenant
 * roles count, across tenants (and for changes to shared data) only platform roles, public access needs no tenant.
 */
export function checkRoles(bag: DiagnosticBag, security: SecurityIR, authorize: AuthorizeIR, element: string, target?: AuthorizeTarget): void {
  const platform = security.platformRoles.map((d) => d.name);
  authorize.roles.forEach((r, i) => {
    if (security.roles.includes(r) || platform.includes(r)) return;
    const s = closest(r, [...security.roles, ...platform]);
    bag.error("unknown-role", `Unknown role "${r}"`, [...authorize.path, "roles", i], { element, hint: s ? `Did you mean "${s}"?` : `Declared roles: ${[...security.roles, ...platform].join(", ")}` });
  });
  const known = allPermissions(security);
  (authorize.permissions ?? []).forEach((p, i) => {
    const path = [...authorize.path, "permissions", i];
    if (!security.roleDefs && !security.platformRoles.length) {
      bag.error("unknown-permission", `Permission "${p}" is not granted by any role: roles are declared as a list`, path, {
        element,
        hint: "Declare roles in the map form with permissions, e.g. roles: { staff: { permissions: [invitation.issue] } }",
      });
    } else if (!known.includes(p)) {
      const s = closest(p, known);
      bag.error("unknown-permission", `Permission "${p}" is not granted by any role`, path, { element, hint: s ? `Did you mean "${s}"?` : `Granted permissions: ${known.join(", ") || "none"}` });
    }
  });
  if (authorize.crossTenant && !security.tenancy) {
    bag.error("tenancy-not-declared", "cross_tenant needs security.tenancy", [...authorize.path, "cross_tenant"], { element, hint: "Declare security.tenancy (claim, type) first" });
  }
  if (!target || target.scope === "none") return;
  const scope = target.scope;
  if (authorize.crossTenant && target.kind !== "use case") {
    bag.error("invalid-authorize", "cross_tenant applies to use cases only", [...authorize.path, "cross_tenant"], { element, hint: "Act across tenants through a use case that takes the target tenant as its tenant_id input" });
    return;
  }
  if (authorize.kind === "public" && scope === "tenant") {
    bag.error("tenant-required", `A public ${target.kind} cannot touch tenant-scoped data: without a principal there is no tenant`, authorize.path, {
      element,
      hint: target.kind === "use case" ? "Use authenticated / roles / permissions (the tenant comes from the token), internal, or make the aggregates tenancy: global" : "Use authenticated / roles / permissions, or make the aggregate tenancy: global",
    });
    return;
  }
  if (authorize.kind !== "principal") return;
  const tenantPerms = permissionsOf(security, "tenant");
  const platformPerms = permissionsOf(security, "platform");
  const platformOnly = scope === "cross_tenant" || (scope === "global" && target.writesGlobal);
  if (scope === "cross_tenant" && !(security.platformRoles.length && (authorize.roles.length || authorize.permissions?.length))) {
    bag.error("cross-tenant-needs-platform-role", "A cross_tenant use case must name platform roles or permissions of platform roles", authorize.path, {
      element,
      hint: "Declare security.platform_roles (e.g. operator: { permissions: [...] }) and list the roles or permissions here",
    });
  } else if (platformOnly && !authorize.roles.length && !authorize.permissions?.length) {
    bag.error("global-write-needs-platform-role", `${target.kind === "use case" ? "A use case changing" : "Changing"} shared (tenancy: global) data must be limited to platform roles`, authorize.path, {
      element,
      hint: "List platform roles or their permissions (any tenant's user could change data every tenant shares), or make it internal",
    });
  }
  authorize.roles.forEach((r, i) => {
    const path = [...authorize.path, "roles", i];
    if (platformOnly && security.roles.includes(r)) {
      bag.error(scope === "cross_tenant" ? "tenant-role-across-tenants" : "global-write-needs-platform-role", scope === "cross_tenant" ? `Role "${r}" holds only in its tenant; a cross_tenant use case is limited to platform roles` : `Role "${r}" holds only in its tenant and cannot change shared (global) data`, path, {
        element,
        hint: "Name platform roles (security.platform_roles)",
      });
    } else if (scope === "tenant" && platform.includes(r)) {
      bag.error("platform-role-in-tenant", `Platform role "${r}" does not act inside a tenant's own operations`, path, {
        element,
        hint: "Platform roles act across tenants only through an explicit, audited use case: authorize: { roles: [...], cross_tenant: true }",
      });
    }
  });
  (authorize.permissions ?? []).forEach((p, i) => {
    if (!known.includes(p)) return;
    const path = [...authorize.path, "permissions", i];
    if (platformOnly && !platformPerms.has(p)) {
      bag.error("permission-not-granted", `No platform role grants "${p}"`, path, { element, hint: scope === "cross_tenant" ? "Only platform roles act across tenants; grant the permission to a platform role" : "Only platform roles change shared data" });
    } else if (scope === "tenant" && !tenantPerms.has(p)) {
      bag.error("permission-not-granted", `No tenant role grants "${p}" (only platform roles do), so no caller could pass inside a tenant`, path, {
        element,
        hint: "Grant it to a role, or act across tenants explicitly with cross_tenant: true",
      });
    }
  });
}

/** `rate_limit.by: tenant` needs a tenant: tenancy, and an operation that runs in the caller's tenant. */
export function checkTenantRateLimit(bag: DiagnosticBag, security: SecurityIR, owner: { rateLimit?: RateLimitIR | "none" }, scope: AccessScope, element: string): void {
  const limit = owner.rateLimit;
  if (!limit || limit === "none" || limit.by !== "tenant") return;
  if (!security.tenancy) {
    bag.error("tenancy-not-declared", "rate_limit by: tenant needs security.tenancy", [...limit.path, "by"], { element, hint: "Declare security.tenancy, or count by principal / ip / global" });
  } else if (scope !== "tenant") {
    bag.error("rate-limit-without-tenant", `This endpoint does not run in the caller's tenant (${scope === "cross_tenant" ? "cross_tenant: the tenant comes from the input" : "it touches only shared data or has no principal"}), so it cannot be counted per tenant`, [...limit.path, "by"], {
      element,
      hint: "Use by: principal (or ip / global)",
    });
  }
}

/** The effective `by` of a rate limit: `tenant` falls back to principal (or ip without one) where there is no tenant. */
export function rateLimitKey(limit: RateLimitIR, scope: AccessScope, hasPrincipal: boolean): RateLimitIR["by"] {
  if (limit.by === "tenant" && scope !== "tenant") return hasPrincipal ? "principal" : "ip";
  return limit.by;
}

export function checkRateLimitUse(bag: DiagnosticBag, owner: { authorize?: AuthorizeIR; rateLimit?: RateLimitIR | "none"; path: (string | number)[] }, element: string): void {
  const limit = owner.rateLimit;
  if (!limit || limit === "none") return;
  if (owner.authorize?.kind === "internal") {
    bag.warning("unused-rate-limit", "An internal use case is never served over HTTP, so its rate limit never applies", limit.path, { element });
  } else if (owner.authorize?.kind === "public" && limit.by === "principal") {
    bag.error("rate-limit-without-principal", "A public endpoint has no principal to count requests by", [...limit.path, "by"], { element, hint: "Use by: ip (or global)" });
  }
}

/** Aggregates are read by `public`, `authenticated` or role/rule-based access; `internal` applies to use cases only. */
export function checkAggregateAuthorize(bag: DiagnosticBag, ag: AggregateIR, element: string): void {
  if (ag.authorize?.kind === "internal") {
    bag.error("invalid-authorize", "authorize: internal applies to use cases only", ag.authorize.path, {
      element,
      hint: "Reading an aggregate is public, authenticated or limited by roles / allow_if (e.g. roles: [admin])",
    });
  }
}
