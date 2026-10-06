/**
 * Canonical domain IR. Produced from YAML by `parseModel`, consumed by the
 * validator, the generators, the CLI and the Web editor. Plain JSON-serializable data.
 */
import type { Path } from "./diagnostics.ts";
import type { QueryIR } from "./queries.ts";

export const SCHEMA_VERSION = 1 as const;

export interface ModelIR {
  schemaVersion: number;
  project: string;
  description?: string;
  generation: GenerationSettings;
  contexts: ContextIR[];
  /** Context map: how bounded contexts depend on each other (top level, between contexts). */
  relationships: RelationshipIR[];
  /** Authentication, authorization and rate limiting (`security`); absent → none is generated (docs/09 §20). */
  security?: SecurityIR;
}

// ---------------------------------------------------------------------------
// Security (docs/09 §20)
// ---------------------------------------------------------------------------

export const AUTH_SCHEMES = ["bearer_jwt", "custom"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];
/** JWS algorithms a bearer JWT may be signed with (RFC 7518; `none` is never accepted, RFC 8725 §3.1). */
export const JWT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "HS256", "HS384", "HS512"] as const;
export const RATE_LIMIT_UNITS = ["second", "minute", "hour", "day"] as const;
export type RateLimitUnit = (typeof RATE_LIMIT_UNITS)[number];
export const RATE_LIMIT_UNIT_SECONDS: Record<RateLimitUnit, number> = { second: 1, minute: 60, hour: 3600, day: 86400 };
/** What a rate limit counts per: the authenticated principal, the client IP, or all callers together. */
export const RATE_LIMIT_KEYS = ["principal", "ip", "global"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];
/** Types a principal claim may have (claims are shared by every context, so only context-free types). */
export const PRINCIPAL_CLAIM_TYPES = ["String", "UUID", "Integer", "Boolean", "List[String]"] as const;
export const PRINCIPAL_ID_TYPES = ["String", "UUID"] as const;
/** Errors every context can raise once `security` is declared (`then.raises` may name them). */
export const SECURITY_ERRORS = ["NotAuthorized", "Unauthenticated"] as const;

export interface SecurityIR extends Located {
  /** Declared roles (snake_case); `authorize.roles` and `has_role` may only name these. */
  roles: string[];
  principal: {
    /** Type of `principal.id` (the JWT `sub`): String (default) or UUID. */
    idType: "String" | "UUID";
    /** Claims rules may read as `principal.<name>`, besides `id` and `roles`. */
    claims: PrincipalClaimIR[];
    path: Path;
  };
  authentication?: AuthenticationIR;
  rateLimits: { default?: RateLimitIR };
}

export interface PrincipalClaimIR extends Located {
  name: string;
  /** One of PRINCIPAL_CLAIM_TYPES. */
  type: string;
  required: boolean;
  /** Name of the JWT claim it is read from (default: `name`), e.g. `https://example.com/company_id`. */
  claim?: string;
  description?: string;
}

export interface AuthenticationIR extends Located {
  scheme: AuthScheme;
  /** Expected `iss` (the generated authenticator's default; overridable at runtime). */
  issuer?: string;
  /** Expected `aud` (default; overridable at runtime). */
  audience?: string;
  /** Accepted JWS algorithms (an allow-list; never `none`). */
  algorithms: string[];
  /** JWT claim holding the roles (a list of strings, or one space-separated string). Default `roles`. */
  rolesClaim: string;
  /** Allowed clock skew in seconds when checking `exp` / `nbf` / `iat` (default 30, at most 300). */
  clockTolerance: number;
}

export interface RateLimitIR extends Located {
  requests: number;
  per: RateLimitUnit;
  by: RateLimitKey;
}

/**
 * Who may run a use case (or read an aggregate through the generated read access): `public` (anyone, no principal),
 * `internal` (in-process only, e.g. a policy; never served over HTTP; use cases only), or `principal` (an
 * authenticated principal with any of `roles` — every role when `roles` is empty — for whom `allowIf` holds).
 */
export interface AuthorizeIR extends Located {
  kind: "public" | "internal" | "principal";
  roles: string[];
  allowIf?: string;
}

export const GENERATION_TARGETS = ["python", "typescript"] as const;
export type GenerationTarget = (typeof GENERATION_TARGETS)[number];
export const TEST_RUNNERS = ["vitest", "bun"] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];
export const API_CLIENTS = ["tanstack-query"] as const;
export type ApiClientKind = (typeof API_CLIENTS)[number];

/** HTTP API (contract, server handler, client) generated for the TypeScript target (`generation.typescript.api`). */
export interface ApiSettings {
  /** Path prefix of every endpoint, e.g. `/api` (starts with `/`, no trailing `/`; `""` for none). */
  basePath: string;
  /** Client library the generated client code targets. */
  client: ApiClientKind;
}

export interface GenerationSettings {
  package: string;
  srcDir: string;
  testsDir: string;
  /** Language of the generated code (`generation.target`, default python). */
  target: GenerationTarget;
  /** Settings of the TypeScript target (`generation.typescript`). */
  typescript: { testRunner: TestRunner; api?: ApiSettings };
}

interface Located {
  /** YAML path of the element; used to attach diagnostics. */
  path: Path;
}

export const SUBDOMAIN_KINDS = ["core", "supporting", "generic"] as const;
export type SubdomainKind = (typeof SUBDOMAIN_KINDS)[number];

export interface ContextIR extends Located {
  name: string;
  description?: string;
  /** Strategic classification: core (where to invest), supporting, generic (buy or reuse). */
  subdomain?: SubdomainKind;
  glossary: GlossaryEntryIR[];
  errors: ErrorIR[];
  enums: EnumIR[];
  valueObjects: ValueObjectIR[];
  aggregates: AggregateIR[];
  extensionPoints: ExtensionPointIR[];
  useCases: UseCaseIR[];
  /** Reactions to domain events: when an event happens, run a use case of this context. */
  policies: PolicyIR[];
  /** Read side: list / search / paging over one aggregate each (`queries:`, see queries.ts). */
  queries: QueryIR[];
}

export interface GlossaryEntryIR {
  term: string;
  definition: string;
}

export interface ErrorIR extends Located {
  name: string;
  code: string;
  message: string;
  description?: string;
  /** Extra diagnostic fields carried by the exception (internal, not shown to end users). */
  details: FieldIR[];
}

export interface EnumIR extends Located {
  name: string;
  description?: string;
  values: string[];
}

export interface Constraints {
  min_length?: number;
  max_length?: number;
  pattern?: string;
  min?: number;
  max?: number;
  max_digits?: number;
  decimal_places?: number;
  min_items?: number;
  max_items?: number;
}

export interface FieldIR extends Located {
  name: string;
  /** Raw type expression, e.g. `String`, `List[EmailAddress]`, `Ref[Order]`. */
  type: string;
  required: boolean;
  description?: string;
  constraints: Constraints;
}

export type NormalizeStep = "strip" | "lower" | "upper";

export interface ValueObjectIR extends Located {
  name: string;
  description?: string;
  fields: FieldIR[];
  normalize: Record<string, NormalizeStep[]>;
  invariants: InvariantIR[];
}

export interface EntityIR extends Located {
  name: string;
  description?: string;
  identity: string;
  fields: FieldIR[];
  invariants: InvariantIR[];
}

export interface AggregateIR extends EntityIR {
  entities: EntityIR[];
  stateGuards: StateGuardIR[];
  factories: FactoryIR[];
  operations: OperationIR[];
  scenarios: AggregateScenarioIR[];
  /** Who may read it by identity (the generated read access / GET endpoint); required once `security` is declared. */
  authorize?: AuthorizeIR;
  /** Rate limit of its GET endpoint; `"none"` opts out of the default. */
  rateLimit?: RateLimitIR | "none";
}

export type CheckTiming = "construct" | "transition";

export interface InvariantIR extends Located {
  name: string;
  description?: string;
  expression: string;
  error: string;
  checkOn: CheckTiming[];
}

export interface ParameterIR extends Located {
  name: string;
  type: string;
  required: boolean;
}

export interface StateGuardIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  expression: string;
  error: string;
}

export interface EventEmissionIR extends Located {
  name: string;
  /** Payload: `name` alone copies a parameter or (post-transition) field; `value` is an expression. */
  fields: { name: string; value?: string; path: Path }[];
  /** Optional condition expression; the event is emitted only when it holds. */
  when?: string;
}

export interface FactoryIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  require: string[];
  /** field name → expression */
  fields: Record<string, string>;
  emits: EventEmissionIR[];
}

export interface OperationIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  /** Guard calls applied automatically before the change, e.g. `pending_until_expiry(at)`. */
  require: string[];
  /** field name → expression evaluated against the pre-transition state. */
  changes: Record<string, string>;
  emits: EventEmissionIR[];
}

export interface ExtensionPointIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  returns: string;
  /** Value returned by the generated test double when a scenario does not stub it. */
  testDefault?: unknown;
}

export type TransactionMode = "required" | "none";

export interface UseCaseIR extends Located {
  name: string;
  description?: string;
  actor?: string;
  command: string;
  input: FieldIR[];
  transaction: TransactionMode;
  idempotencyKey?: string;
  retry: boolean;
  steps: StepIR[];
  scenarios: UseCaseScenarioIR[];
  /** Who may run it (`authorize`); required once `security` is declared. */
  authorize?: AuthorizeIR;
  /** Rate limit of its HTTP endpoint (`rate_limit`); `"none"` opts out of `security.rate_limits.default`. */
  rateLimit?: RateLimitIR | "none";
}

export interface PolicyIR extends Located {
  name: string;
  description?: string;
  /** Consumed event: `Event` (this context) or `Context.Event` (another context, through a relationship). */
  when: string;
  /** Use case of this context that the policy runs. */
  run: string;
  /** Use case input name → expression (`event.<field>`, `clock.now`, `ids.new`, literals, enum values). */
  args: Record<string, string>;
}

export const RELATIONSHIP_PATTERNS = [
  "customer_supplier",
  "conformist",
  "anticorruption_layer",
  "open_host_service",
  "published_language",
  "shared_kernel",
  "partnership",
  "separate_ways",
] as const;
export type RelationshipPattern = (typeof RELATIONSHIP_PATTERNS)[number];

export interface RelationshipIR extends Located {
  upstream: string;
  downstream: string;
  pattern: RelationshipPattern;
  /** Event contract: upstream events the downstream may consume. */
  events: string[];
  description?: string;
}

export type StepIR =
  | ({ kind: "load"; aggregate: string; by: string; as: string; notFound?: string } & Located)
  | ({ kind: "create"; aggregate: string; factory: string; as: string; args: Record<string, string> } & Located)
  | ({ kind: "invoke"; target: string; operation: string; args: Record<string, string> } & Located)
  | ({ kind: "save"; target: string } & Located)
  | ({ kind: "publish"; event: string; afterCommit: boolean } & Located)
  | ({ kind: "if"; condition: string; then: StepIR[]; else: StepIR[] } & Located)
  | ({ kind: "fail"; error: string } & Located)
  | ({ kind: "return"; value: string } & Located)
  /** Names a computed value for later steps. Scoped like `as`: a value named inside an if-branch stays in that branch. */
  | ({ kind: "let"; name: string; value: string } & Located);

/** Literal scenario data as written in YAML (strings, numbers, booleans, nested maps). */
export type ScenarioValue = unknown;

export interface AggregateScenarioIR extends Located {
  name: string;
  description?: string;
  given?: { aggregate: Record<string, ScenarioValue>; path: Path };
  when:
    | { kind: "construct"; fields: Record<string, ScenarioValue>; path: Path }
    | { kind: "operation"; operation: string; args: Record<string, ScenarioValue>; path: Path }
    | { kind: "factory"; factory: string; args: Record<string, ScenarioValue>; path: Path };
  then: ScenarioThenIR;
}

export interface UseCaseScenarioIR extends Located {
  name: string;
  description?: string;
  given: {
    clock?: string;
    ids: string[];
    aggregates: { type: string; fields: Record<string, ScenarioValue>; path: Path }[];
    extensions: Record<string, ScenarioValue>;
    /** Who runs the use case (`given.principal`); `anonymous` for `principal: null`. Absent → a default principal. */
    principal?: ScenarioPrincipalIR;
    path: Path;
  };
  when: { input: Record<string, ScenarioValue>; path: Path };
  then: ScenarioThenIR;
}

export interface ScenarioThenIR extends Located {
  raises?: string;
  /** Aggregate scenarios: single state map. Use case scenarios: list of stored aggregates. */
  state?: Record<string, ScenarioValue> | { aggregate: string; id: ScenarioValue; fields: Record<string, ScenarioValue>; path: Path }[];
  emits?: { event: string; fields: Record<string, ScenarioValue>; path: Path }[];
  hasReturns: boolean;
  returns?: ScenarioValue;
}

export interface ScenarioPrincipalIR extends Located {
  anonymous: boolean;
  id?: ScenarioValue;
  roles: string[];
  claims: Record<string, ScenarioValue>;
}
