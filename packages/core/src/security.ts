/**
 * Authentication, authorization and rate limiting (`security`, docs/09 §20): model-level checks and the helpers the
 * validator and both generators share (who may run what, which rate limit applies, the principal a scenario runs as).
 */
import type { PrincipalEnv } from "./checker.ts";
import type { DiagnosticBag } from "./diagnostics.ts";
import {
  JWT_ALGORITHMS,
  PRINCIPAL_CLAIM_TYPES,
  RATE_LIMIT_UNIT_SECONDS,
  type AggregateIR,
  type AuthorizeIR,
  type ContextIR,
  type ModelIR,
  type RateLimitIR,
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
/** Claim names the generated Principal class / schema uses for itself. */
const RESERVED_CLAIMS = new Set(["id", "roles", "has_role", "model_config", "schema", "parse", "create"]);

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
  for (const c of security.principal.claims) {
    const t = claimType(c.type);
    if (t && !m.has(c.name)) m.set(c.name, c.required ? t : { k: "optional", inner: t });
  }
  return m;
}

export function principalEnv(security: SecurityIR): PrincipalEnv {
  return { members: principalMembers(security), roles: security.roles };
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
}

export const DEFAULT_PRINCIPAL_IDS = { UUID: "00000000-0000-4000-8000-000000000001", String: "test-principal" } as const;

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
export function scenarioPrincipal(security: SecurityIR, owner: { authorize?: AuthorizeIR }, sc: UseCaseScenarioIR): ResolvedPrincipal {
  const given = sc.given.principal;
  if (given?.anonymous) return { anonymous: true, id: "", roles: [], claims: {} };
  return makePrincipal(security, {
    id: given?.id,
    roles: given ? given.roles : (owner.authorize?.roles ?? []),
    claims: given?.claims ?? {},
  });
}

/** A principal with the given roles (claims and id as in `base`, defaults otherwise). */
export function makePrincipal(security: SecurityIR, base: { id?: ScenarioValue; roles: string[]; claims: Record<string, ScenarioValue> }): ResolvedPrincipal {
  const claims: Record<string, ScenarioValue> = {};
  for (const c of security.principal.claims) {
    claims[c.name] = c.name in base.claims ? base.claims[c.name] : c.required ? claimDefault(c.type) : null;
  }
  const id = base.id === undefined || base.id === null ? DEFAULT_PRINCIPAL_IDS[security.principal.idType] : String(base.id);
  return { anonymous: false, id, roles: [...base.roles], claims };
}

/** Roles a principal can hold that do not satisfy `authorize.roles` (for the generated "missing role" test). */
export function otherRoles(security: SecurityIR, authorize: AuthorizeIR): string[] {
  return security.roles.filter((r) => !authorize.roles.includes(r));
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
    if (claimNames.has(c.name)) bag.error("duplicate-name", `Duplicate claim "${c.name}"`, [...c.path, "name"], { element: el });
    claimNames.add(c.name);
    if (!claimType(c.type)) {
      bag.error("invalid-claim-type", `Claim type "${c.type}" is not supported`, [...c.path, "type"], { element: el, hint: `Use one of ${PRINCIPAL_CLAIM_TYPES.join(", ")}` });
    }
  }
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
}

/** Every role named by an authorize block must be declared. */
export function checkRoles(bag: DiagnosticBag, security: SecurityIR, authorize: AuthorizeIR, element: string): void {
  authorize.roles.forEach((r, i) => {
    if (security.roles.includes(r)) return;
    const s = closest(r, security.roles);
    bag.error("unknown-role", `Unknown role "${r}"`, [...authorize.path, "roles", i], { element, hint: s ? `Did you mean "${s}"?` : `Declared roles: ${security.roles.join(", ")}` });
  });
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
