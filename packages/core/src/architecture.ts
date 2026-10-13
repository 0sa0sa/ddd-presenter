/**
 * Architecture model (C4-style, three levels) derived from a validated model: what the domain model and the generator
 * produce for it, as data the CLI (`ARCHITECTURE.md`), the Web editor (アーキテクチャ tab) and the exports share.
 *
 * - L1 system context: bounded contexts, the context map, external systems (extension points), actors, platform roles.
 * - L2 containers: the deployable / runnable parts the generator emits for this model and target (web client, HTTP API,
 *   application and domain per context, event dispatch, security, PostgreSQL, identity provider, external systems).
 * - L3 components per context: aggregates, use cases, queries, policies, ports and the generated adapters.
 *
 * The conditions mirror the generators exactly (a generator test keeps them in step). Pure, no Node APIs: the Web
 * bundle uses it. Design and sources: docs/09 §23; contract of ARCHITECTURE.md: docs/05.
 */
import type { Path } from "./diagnostics.ts";
import type { AuthorizeIR, ContextIR, GenerationTarget, ModelIR, RateLimitIR, StepIR, UseCaseIR } from "./ir.ts";
import type { Analysis } from "./validate.ts";
import { effectiveRateLimit, isTenantScoped, servedOverHttp, touchedAggregates } from "./security.ts";

export type ArchLevel = "system" | "containers" | `context:${string}`;

export type ArchKind =
  | "person"
  | "role"
  | "context"
  | "external"
  | "container"
  | "database"
  | "idp"
  | "aggregate"
  | "use_case"
  | "query"
  | "policy"
  | "port"
  | "adapter";

/** Where the generated code of an element lives (the Web editor matches it against the preview's file list). */
export interface ArchCode {
  /** Context the files belong to (absent: model-level files). */
  context?: string;
  area: "domain" | "application" | "persistence" | "api" | "sql" | "security" | "testing" | "extensions" | "policies" | "runtime";
}

export interface ArchElement {
  /** Stable id (name based): `ctx:Billing`, `ctr:http-api`, `cmp:Billing/agg:Invoice`. */
  id: string;
  kind: ArchKind;
  label: string;
  /** Technology line (C4 "[Container: …]"), e.g. `TypeScript, TanStack Query`. */
  technology?: string;
  description?: string;
  /** YAML path of the element in the model (for "open in YAML"); absent for elements implied by the target. */
  path?: Path;
  /** Short facts: `RLS`, `trigram`, `JWT`, `rate 60/min by tenant`, `tenant`. */
  badges: string[];
  /** Group (subgraph) of the view it is drawn in. */
  group?: string;
  /** Level a double-click opens (a context's components). */
  drill?: ArchLevel;
  code?: ArchCode[];
}

export interface ArchRelation {
  id: string;
  source: string;
  target: string;
  label: string;
  /** Protocol / data, e.g. `HTTPS JSON`, `SQL`, `in-process events`. */
  technology?: string;
  path?: Path;
  /** Dashed in the diagrams (events, implemented-by, optional dependencies). */
  dashed?: boolean;
  /** Laid out against its direction (an adapter implementing a port sits below the port it points to). */
  upward?: boolean;
}

export interface ArchGroup {
  id: string;
  label: string;
}

export interface ArchView {
  level: ArchLevel;
  title: string;
  description: string;
  elements: ArchElement[];
  relations: ArchRelation[];
  groups: ArchGroup[];
}

export interface Architecture {
  project: string;
  description?: string;
  target: GenerationTarget;
  system: ArchView;
  containers: ArchView;
  /** One component view per context, in model order. */
  contexts: ArchView[];
}

export type ArchLang = "en" | "ja";

/** The view of a level (`context:<Name>` → that context's components). */
export function architectureView(arch: Architecture, level: ArchLevel): ArchView | undefined {
  if (level === "system") return arch.system;
  if (level === "containers") return arch.containers;
  return arch.contexts.find((v) => v.level === level);
}

/** Whether the model generates the TypeScript HTTP API (and its TanStack Query client). */
export function generatesHttpApi(model: ModelIR, target: GenerationTarget = model.generation.target): boolean {
  return target === "typescript" && !!model.generation.typescript.api;
}

/** Whether the generated code verifies bearer JWTs (Python: PyJWT authenticator; TypeScript: only with the HTTP API). */
export function generatesJwt(model: ModelIR, target: GenerationTarget = model.generation.target): boolean {
  if (model.security?.authentication?.scheme !== "bearer_jwt") return false;
  return target === "python" || generatesHttpApi(model, target);
}

/** `rate 60/min by tenant` */
export function rateBadge(limit: RateLimitIR): string {
  const unit = { second: "s", minute: "min", hour: "h", day: "day" }[limit.per];
  return `rate ${limit.requests}/${unit} by ${limit.by}`;
}

/** `public`, `internal`, `authenticated`, `roles: a, b`, `perms: x.y` (+ `allow_if`). */
export function authorizeBadge(a: AuthorizeIR | undefined): string | undefined {
  if (!a) return undefined;
  if (a.kind !== "principal") return a.kind;
  const parts: string[] = [];
  if (a.roles.length) parts.push(`roles: ${a.roles.join(", ")}`);
  if (a.permissions?.length) parts.push(`perms: ${a.permissions.join(", ")}`);
  if (!parts.length) parts.push(a.allowIf ? "allow_if" : "authenticated");
  else if (a.allowIf) parts.push("allow_if");
  return parts.join(" + ");
}

const PATTERN_LABEL: Record<string, string> = {
  customer_supplier: "Customer/Supplier",
  conformist: "Conformist",
  anticorruption_layer: "Anticorruption layer",
  open_host_service: "Open host service",
  published_language: "Published language",
  shared_kernel: "Shared kernel",
  partnership: "Partnership",
  separate_ways: "Separate ways",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABEL[pattern] ?? pattern;
}

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");

/** The event a policy consumes: `Event` (own context) or `Context.Event`. */
function policyEvent(ctx: ContextIR, when: string): { context: string; name: string } {
  const m = /^\s*(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(when);
  return m ? { context: m[1] ?? ctx.name, name: m[2]! } : { context: ctx.name, name: when };
}

function stepStrings(steps: StepIR[], out: string[] = []): string[] {
  for (const s of steps) {
    if (s.kind === "if") {
      out.push(s.condition);
      stepStrings(s.then, out);
      stepStrings(s.else, out);
    } else if (s.kind === "create" || s.kind === "invoke") out.push(...Object.values(s.args));
    else if (s.kind === "let" || s.kind === "return") out.push(s.value);
    else if (s.kind === "load") out.push(s.by);
  }
  return out;
}

function hasStep(steps: StepIR[], kind: StepIR["kind"]): boolean {
  return steps.some((s) => s.kind === kind || (s.kind === "if" && (hasStep(s.then, kind) || hasStep(s.else, kind))));
}

/** Extension points a use case calls (from the analysis when present, else by name in its expressions). */
function extensionsOf(ctx: ContextIR, uc: UseCaseIR, analysis?: Analysis): string[] {
  const info = analysis?.contexts.get(ctx.name)?.useCases.get(uc.name);
  if (info) return info.extensions;
  const text = stepStrings(uc.steps).join("\n");
  return ctx.extensionPoints.filter((x) => new RegExp(`\\b${x.name}\\s*\\(`).test(text)).map((x) => x.name);
}

const PORT_RE = { clock: /\bclock\.now\b/, ids: /\bids\.new\b/ } as const;

/** Whether a use case reads the clock / makes new ids (from the analysis when present, else from its expressions). */
function useCaseUses(ctx: ContextIR, uc: UseCaseIR, analysis: Analysis | undefined, port: "clock" | "ids"): boolean {
  const info = analysis?.contexts.get(ctx.name)?.useCases.get(uc.name);
  if (info) return port === "clock" ? info.usesClock : info.usesIds;
  return PORT_RE[port].test(stepStrings(uc.steps).join("\n"));
}

function usesPort(ctx: ContextIR, analysis: Analysis | undefined, port: "clock" | "ids"): boolean {
  const ca = analysis?.contexts.get(ctx.name);
  if (ca && [...ca.policies.values()].some((p) => (port === "clock" ? p.usesClock : p.usesIds))) return true;
  if (!ca && ctx.policies.some((p) => Object.values(p.args).some((v) => PORT_RE[port].test(v)))) return true;
  return ctx.useCases.some((uc) => useCaseUses(ctx, uc, analysis, port));
}

class ViewBuilder {
  readonly elements: ArchElement[] = [];
  readonly relations: ArchRelation[] = [];
  readonly groups: ArchGroup[] = [];
  constructor(
    readonly level: ArchLevel,
    readonly title: string,
    readonly description: string,
  ) {}
  has(id: string): boolean {
    return this.elements.some((e) => e.id === id);
  }
  add(e: Omit<ArchElement, "badges"> & { badges?: (string | undefined | false)[] }): string {
    if (!this.has(e.id)) this.elements.push({ ...e, badges: (e.badges ?? []).filter((b): b is string => !!b) });
    return e.id;
  }
  group(id: string, label: string): string {
    if (!this.groups.some((g) => g.id === id)) this.groups.push({ id, label });
    return id;
  }
  link(source: string, target: string, label: string, extra: Partial<ArchRelation> = {}): void {
    if (!this.has(source) || !this.has(target) || source === target) return;
    const base = `${source}->${target}`;
    const existing = this.relations.find((r) => r.source === source && r.target === target && r.label === label);
    if (existing) return;
    let id = base;
    for (let i = 2; this.relations.some((r) => r.id === id); i++) id = `${base}#${i}`;
    this.relations.push({ id, source, target, label, ...extra });
  }
  build(): ArchView {
    return { level: this.level, title: this.title, description: this.description, elements: this.elements, relations: this.relations, groups: this.groups };
  }
}

/**
 * Derives the three levels. `analysis` (from a model without errors) refines which ports a use case uses; without it
 * (e.g. the Web editor showing the last valid model) the same picture comes from the IR.
 */
export function deriveArchitecture(model: ModelIR, analysis?: Analysis, options: { lang?: ArchLang; target?: GenerationTarget } = {}): Architecture {
  const ja = options.lang === "ja";
  const t = (en: string, jaText: string) => (ja ? jaText : en);
  const sec = model.security;
  const tenancy = sec?.tenancy;
  /** The generator's target (`ddd generate --target` may differ from `generation.target`). */
  const target = options.target ?? model.generation.target;
  const lang = target === "typescript" ? "TypeScript" : "Python";
  const http = generatesHttpApi(model, target);
  const jwt = generatesJwt(model, target);
  const withQueries = model.contexts.filter((c) => c.queries.length > 0);
  const trigram = withQueries.some((c) => c.queries.some((q) => q.search?.mode === "trigram"));
  const defaultRate = sec?.rateLimits.default;
  const ctxIndex = (name: string) => model.contexts.findIndex((c) => c.name === name);

  // Actors: who runs which use cases (by the `actor` text), in model order.
  const actors = new Map<string, { contexts: Set<string>; useCases: string[]; path: Path; external: boolean }>();
  for (const ctx of model.contexts) {
    for (const uc of ctx.useCases) {
      if (!uc.actor) continue;
      const a = actors.get(uc.actor) ?? { contexts: new Set(), useCases: [], path: [...uc.path, "actor"], external: false };
      a.contexts.add(ctx.name);
      // An actor that only runs internal use cases (policies) is not a caller of the HTTP API / public interface.
      if (servedOverHttp(uc)) a.external = true;
      a.useCases.push(uc.name);
      actors.set(uc.actor, a);
    }
  }
  const crossTenantContexts = model.contexts.filter((c) => c.useCases.some((u) => u.authorize?.crossTenant)).map((c) => c.name);

  const contextBadges = (ctx: ContextIR) => [
    ctx.subdomain,
    tenancy && ctx.aggregates.some((a) => isTenantScoped(sec, a)) && "tenant",
    ctx.queries.length > 0 && "PostgreSQL",
  ];
  const count = (n: number, en: string, enPlural: string, jaText: string) => (ja ? `${jaText} ${n}` : `${n} ${n === 1 ? en : enPlural}`);
  const contextSummary = (ctx: ContextIR) =>
    [
      count(ctx.aggregates.length, "aggregate", "aggregates", "集約"),
      count(ctx.useCases.length, "use case", "use cases", "ユースケース"),
      ctx.queries.length ? count(ctx.queries.length, "query", "queries", "クエリ") : "",
      ctx.policies.length ? count(ctx.policies.length, "policy", "policies", "ポリシー") : "",
    ]
      .filter(Boolean)
      .join(", ");

  // -------------------------------------------------------------------------
  // L1 system context
  // -------------------------------------------------------------------------
  const L1 = new ViewBuilder("system", t(`System context — ${model.project}`, `システム全体 — ${model.project}`), t("Bounded contexts, the context map, actors and external systems.", "境界づけられたコンテキスト・コンテキストマップ・利用者・外部システム"));
  for (const [name, a] of actors) {
    L1.add({ id: `person:${name}`, kind: "person", label: name, technology: a.external ? undefined : t("internal (policies)", "内部（ポリシー）"), description: t(`Runs ${a.useCases.join(", ")}`, `${a.useCases.join("・")} を実行する`), path: a.path });
  }
  for (const r of sec?.platformRoles ?? []) {
    L1.add({
      id: `role:${r.name}`,
      kind: "role",
      label: r.name,
      technology: t("Platform role", "プラットフォームロール"),
      description: r.description ?? t("Global role, acts across tenants (cross_tenant use cases only).", "テナントをまたぐ運用ロール（cross_tenant のユースケースだけで効く）"),
      path: r.path,
      badges: ["cross-tenant", ...r.permissions.map((p) => `perm ${p}`)],
    });
  }
  for (const ctx of model.contexts) {
    L1.add({
      id: `ctx:${ctx.name}`,
      kind: "context",
      label: ctx.name,
      technology: t("Bounded context", "境界づけられたコンテキスト"),
      description: [ctx.description, contextSummary(ctx)].filter(Boolean).join(" — "),
      path: ctx.path,
      badges: contextBadges(ctx),
      drill: `context:${ctx.name}`,
      code: [{ context: ctx.name, area: "domain" }],
    });
  }
  for (const ctx of model.contexts) {
    for (const x of ctx.extensionPoints) {
      L1.add({
        id: `ext:${ctx.name}.${x.name}`,
        kind: "external",
        label: x.name,
        technology: t("External system (extension point)", "外部システム（拡張ポイント）"),
        description: x.description ?? t(`Customer-implemented: ${x.name}(…) → ${x.returns}`, `顧客が実装: ${x.name}(…) → ${x.returns}`),
        path: x.path,
        badges: ["customer code"],
        code: [{ context: ctx.name, area: "extensions" }],
      });
    }
  }
  for (const [name, a] of actors) for (const c of a.contexts) L1.link(`person:${name}`, `ctx:${c}`, t("uses", "使う"));
  for (const r of sec?.platformRoles ?? []) for (const c of crossTenantContexts) L1.link(`role:${r.name}`, `ctx:${c}`, t("operates across tenants", "テナントをまたいで操作"), { technology: "cross_tenant" });
  model.relationships.forEach((r, i) => {
    L1.link(`ctx:${r.upstream}`, `ctx:${r.downstream}`, [patternLabel(r.pattern), r.events.length ? `events: ${r.events.join(", ")}` : ""].filter(Boolean).join(" — "), {
      technology: r.events.length ? t("in-process events", "プロセス内イベント") : undefined,
      path: r.path ?? ["relationships", i],
      dashed: r.pattern === "separate_ways",
    });
  });
  for (const ctx of model.contexts) for (const x of ctx.extensionPoints) L1.link(`ctx:${ctx.name}`, `ext:${ctx.name}.${x.name}`, t("asks", "問い合わせる"), { technology: t("extension point", "拡張ポイント") });

  // -------------------------------------------------------------------------
  // L2 containers
  // -------------------------------------------------------------------------
  const L2 = new ViewBuilder(
    "containers",
    t(`Containers — ${model.project} (${lang})`, `コンテナ — ${model.project}（${lang}）`),
    t("What `ddd generate` produces for this model and target, and how the parts talk.", "このモデルとターゲットで ddd generate が生成するものと、そのつながり"),
  );
  const apiPath: Path = ["generation", "typescript", "api"];
  if (http) {
    L2.add({
      id: "ctr:web-client",
      kind: "container",
      label: t("Web client", "Web クライアント"),
      technology: "TypeScript, TanStack Query",
      description: t("Typed query / mutation options for every endpoint (generated client).", "すべてのエンドポイントの型付きクエリ・ミューテーション（生成されたクライアント）"),
      path: apiPath,
      badges: ["tanstack-query"],
      code: [{ area: "api" }],
    });
    L2.add({
      id: "ctr:http-api",
      kind: "container",
      label: "HTTP API",
      technology: t("TypeScript, Web-standard fetch handler, zod", "TypeScript・Web 標準の fetch ハンドラ・zod"),
      description: t(
        `Contract, server routes and error mapping under ${model.generation.typescript.api!.basePath || "/"}.${sec ? " Authenticates, authorizes and rate limits every request." : ""}${model.generation.typescript.api!.connect ? " Also serves the protobuf contract (generated/proto) over the Connect protocol." : ""}`,
        `${model.generation.typescript.api!.basePath || "/"} 以下の契約・サーバーのルート・エラーの対応づけ。${sec ? "すべてのリクエストを認証・認可・レート制限する。" : ""}${model.generation.typescript.api!.connect ? "protobuf の契約（generated/proto）を Connect プロトコルでも出す。" : ""}`,
      ),
      path: apiPath,
      badges: [model.generation.typescript.api!.basePath || "/", model.generation.typescript.api!.connect && "Connect", jwt && "JWT", defaultRate && rateBadge(defaultRate), tenancy && "tenant"],
      code: [{ area: "api" }],
    });
  }
  const pyConnect = target === "python" && !!model.generation.python?.connect;
  if (pyConnect) {
    L2.add({
      id: "ctr:connect",
      kind: "container",
      label: t("Connect API", "Connect API"),
      technology: t("Python, WSGI application (Connect protocol, JSON and binary)", "Python・WSGI アプリ（Connect プロトコル、JSON とバイナリ）"),
      description: t(
        `The use cases and queries as the rpcs of the protobuf contract (generated/proto) under ${model.generation.python!.basePath || "/"}.`,
        `${model.generation.python!.basePath || "/"} 以下で、Use case とクエリを protobuf の契約（generated/proto）の rpc として出す。`,
      ),
      path: ["generation", "python"],
      badges: [model.generation.python!.basePath || "/", "Connect"],
      code: [{ area: "api" }],
    });
  }
  if (sec) {
    L2.add({
      id: "ctr:security",
      kind: "container",
      label: t("Security", "セキュリティ"),
      technology: target === "typescript" ? "TypeScript, zod" + (jwt ? ", jose" : "") : "Python" + (jwt ? ", PyJWT" : ""),
      description: t(
        `Principal, roles${sec.roleDefs ? " and permissions" : ""}, authorization checks, rate limiting${tenancy ? ", tenant context" : ""}${jwt ? ", bearer JWT authenticator" : ""}.`,
        `プリンシパル・ロール${sec.roleDefs ? "・権限" : ""}・認可チェック・レート制限${tenancy ? "・テナント" : ""}${jwt ? "・Bearer JWT の認証器" : ""}`,
      ),
      path: sec.path,
      badges: [jwt && "JWT", sec.roleDefs ? "RBAC" : "roles", tenancy && `tenant: ${tenancy.claim}`, defaultRate && rateBadge(defaultRate), sec.platformRoles.length > 0 && "platform roles"],
      code: [{ area: "security" }],
    });
  }
  const persons = [...actors.keys()].filter((name) => actors.get(name)!.external);
  for (const name of persons) L2.add({ id: `person:${name}`, kind: "person", label: name, path: actors.get(name)!.path });
  for (const r of sec?.platformRoles ?? []) L2.add({ id: `role:${r.name}`, kind: "role", label: r.name, technology: t("Platform role", "プラットフォームロール"), path: r.path, badges: ["cross-tenant"] });

  for (const ctx of model.contexts) {
    const g = L2.group(`grp:${ctx.name}`, ctx.name);
    const served = ctx.useCases.filter(servedOverHttp);
    L2.add({
      id: `ctr:app:${ctx.name}`,
      kind: "container",
      label: t(`${ctx.name} application`, `${ctx.name} アプリケーション`),
      technology: lang,
      description: t(
        `${[count(ctx.useCases.length, "use case", "use cases", ""), ctx.queries.length ? count(ctx.queries.length, "query", "queries", "") : "", ctx.policies.length ? count(ctx.policies.length, "policy", "policies", "") : ""].filter(Boolean).join(", ")}; ports for repositories and extensions.`,
        `ユースケース ${ctx.useCases.length}${ctx.queries.length ? `・クエリ ${ctx.queries.length}` : ""}${ctx.policies.length ? `・ポリシー ${ctx.policies.length}` : ""}。リポジトリと拡張のポート`,
      ),
      path: ctx.useCases.length ? [...ctx.path, "use_cases"] : ctx.path,
      group: g,
      badges: [ctx.useCases.some((u) => u.idempotencyKey) && "idempotency", ctx.useCases.some((u) => u.authorize?.crossTenant) && "cross-tenant", served.length > 0 && http && `${served.length} endpoints`],
      drill: `context:${ctx.name}`,
      code: [{ context: ctx.name, area: "application" }],
    });
    L2.add({
      id: `ctr:domain:${ctx.name}`,
      kind: "container",
      label: t(`${ctx.name} domain`, `${ctx.name} ドメイン`),
      technology: target === "typescript" ? "TypeScript, zod" : "Python, Pydantic v2",
      description: t(
        `${count(ctx.aggregates.length, "aggregate", "aggregates", "")}, value objects, invariants, state guards and domain events.`,
        `集約 ${ctx.aggregates.length}・値オブジェクト・不変条件・状態ガード・ドメインイベント`,
      ),
      path: ctx.aggregates.length ? [...ctx.path, "aggregates"] : ctx.path,
      group: g,
      badges: [ctx.subdomain, tenancy && ctx.aggregates.some((a) => isTenantScoped(sec, a)) && "tenant"],
      drill: `context:${ctx.name}`,
      code: [{ context: ctx.name, area: "domain" }],
    });
  }
  const anyPolicies = model.contexts.some((c) => c.policies.length > 0);
  if (anyPolicies) {
    const first = model.contexts.find((c) => c.policies.length)!;
    L2.add({
      id: "ctr:events",
      kind: "container",
      label: t("Event dispatch", "イベント配信"),
      technology: t(`${lang}, in-process subscriptions()`, `${lang}・プロセス内の subscriptions()`),
      description: t("Policies subscribe to domain events and run use cases (wire subscriptions() into your event bus).", "ポリシーがドメインイベントを購読してユースケースを実行する（subscriptions() をイベントバスにつなぐ）"),
      path: [...first.path, "policies"],
      badges: [count(model.contexts.reduce((n, c) => n + c.policies.length, 0), "policy", "policies", "ポリシー")],
      code: [{ context: first.name, area: "policies" }],
    });
  }
  if (withQueries.length) {
    const rls = tenancy ? (tenancy.rls ? "RLS on" : "RLS off") : undefined;
    L2.add({
      id: "ctr:postgres",
      kind: "database",
      label: "PostgreSQL",
      technology: t("PostgreSQL (generated DDL)", "PostgreSQL（生成された DDL）"),
      description: t(
        `One table per aggregate of ${withQueries.map((c) => c.name).join(", ")}; keyset paging${trigram ? ", pg_trgm GIN indexes" : ""}${tenancy ? ", tenant_id on tenant-scoped tables" : ""}; optimistic locking (version).`,
        `${withQueries.map((c) => c.name).join("・")} の集約ごとに 1 テーブル。キーセットページング${trigram ? "・pg_trgm の GIN インデックス" : ""}${tenancy ? "・テナントのテーブルに tenant_id" : ""}・楽観的ロック（version）`,
      ),
      path: [...withQueries[0]!.path, "queries"],
      badges: [rls, trigram && "trigram", tenancy && "tenant_id", "optimistic lock"],
      code: withQueries.map((c) => ({ context: c.name, area: "sql" as const })),
    });
  }
  if (jwt) {
    const auth = sec!.authentication!;
    L2.add({
      id: "ctr:idp",
      kind: "idp",
      label: t("Identity provider", "ID プロバイダ"),
      technology: t("OpenID Connect / OAuth 2.0 (external)", "OpenID Connect / OAuth 2.0（外部）"),
      description: t(`Issues the bearer JWTs${auth.issuer ? ` (iss ${auth.issuer})` : ""}; signing keys from its JWKS.`, `Bearer JWT を発行する${auth.issuer ? `（iss ${auth.issuer}）` : ""}。署名鍵は JWKS から`),
      path: auth.path,
      badges: [auth.algorithms.join(", "), auth.audience && `aud ${auth.audience}`, tenancy && `claim ${tenancy.claim}`],
    });
  }
  for (const ctx of model.contexts) {
    for (const x of ctx.extensionPoints) {
      L2.add({ id: `ext:${ctx.name}.${x.name}`, kind: "external", label: x.name, technology: t("External system (extension point)", "外部システム（拡張ポイント）"), description: x.description, path: x.path, badges: ["customer code"], code: [{ context: ctx.name, area: "extensions" }] });
    }
  }
  // L2 relations
  const entry = (ctxName: string) => (http ? "ctr:http-api" : `ctr:app:${ctxName}`);
  if (http) {
    for (const name of persons) L2.link(`person:${name}`, "ctr:web-client", t("uses", "使う"));
    const wire = model.generation.typescript.api!.connect ? "HTTPS JSON / Connect" : "HTTPS JSON";
    L2.link("ctr:web-client", "ctr:http-api", t("calls", "呼び出す"), { technology: jwt ? `${wire}, Bearer JWT` : wire });
    if (jwt) L2.link("ctr:web-client", "ctr:idp", t("signs in, obtains JWT", "サインインして JWT を得る"), { technology: "OIDC" });
    if (sec) L2.link("ctr:http-api", "ctr:security", t("authenticates, authorizes, rate limits", "認証・認可・レート制限"));
  } else {
    for (const [name, a] of actors) if (a.external) for (const c of a.contexts) L2.link(`person:${name}`, entry(c), t("uses (in-process API)", "使う（プロセス内 API）"));
  }
  for (const r of sec?.platformRoles ?? []) for (const c of crossTenantContexts) L2.link(`role:${r.name}`, entry(c), t("operates across tenants", "テナントをまたいで操作"), { technology: "cross_tenant" });
  if (pyConnect) {
    if (sec) L2.link("ctr:connect", "ctr:security", t("authenticates, rate limits", "認証・レート制限"), { technology: t("in-process call", "プロセス内呼び出し") });
    for (const ctx of model.contexts) {
      if (ctx.useCases.some(servedOverHttp) || ctx.queries.length) L2.link("ctr:connect", `ctr:app:${ctx.name}`, t("runs use cases and queries", "ユースケース・クエリを実行"), { technology: t("in-process call", "プロセス内呼び出し") });
    }
  }
  for (const ctx of model.contexts) {
    const app = `ctr:app:${ctx.name}`;
    if (http && (ctx.useCases.some(servedOverHttp) || ctx.aggregates.length)) L2.link("ctr:http-api", app, t("runs use cases and queries", "ユースケース・クエリを実行"), { technology: t("in-process call", "プロセス内呼び出し") });
    L2.link(app, `ctr:domain:${ctx.name}`, t("loads, changes, saves aggregates", "集約を読み込み・変更・保存"), { technology: t("in-process call", "プロセス内呼び出し") });
    if (sec && !http) L2.link(app, "ctr:security", t("authorizes", "認可"), { technology: t("in-process call", "プロセス内呼び出し") });
    if (ctx.queries.length) L2.link(app, "ctr:postgres", t("reads and writes", "読み書き"), { technology: tenancy ? (tenancy.rls ? "SQL, tenant_id filter + RLS (app.tenant_id)" : "SQL, tenant_id filter") : "SQL" });
    for (const x of ctx.extensionPoints) L2.link(app, `ext:${ctx.name}.${x.name}`, t("asks (customer adapter)", "問い合わせる（顧客のアダプタ）"), { technology: t("extension point", "拡張ポイント"), dashed: true });
    const emitsConsumed = model.contexts.some((c) => c.policies.some((p) => policyEvent(c, p.when).context === ctx.name));
    if (emitsConsumed) L2.link(`ctr:domain:${ctx.name}`, "ctr:events", t("domain events", "ドメインイベント"), { technology: t("in-process events", "プロセス内イベント"), dashed: true });
    if (ctx.policies.length) L2.link("ctr:events", app, t("runs policies", "ポリシーを実行"), { technology: t("in-process events", "プロセス内イベント"), dashed: true });
  }
  if (jwt) L2.link("ctr:security", "ctr:idp", t("verifies JWT signatures", "JWT の署名を検証"), { technology: "JWKS (HTTPS)" });

  // -------------------------------------------------------------------------
  // L3 components per context
  // -------------------------------------------------------------------------
  const contexts: ArchView[] = [];
  for (const ctx of model.contexts) {
    const c = ctx.name;
    const id = (k: string, n: string) => `cmp:${c}/${k}:${n}`;
    const V = new ViewBuilder(`context:${c}`, t(`Components — ${c}`, `コンテキストの中身 — ${c}`), [ctx.description, contextSummary(ctx)].filter(Boolean).join(" — "));
    const gEntry = V.group("grp:entry", t("Entry points", "入口"));
    const gApp = V.group("grp:application", t("Application", "アプリケーション"));
    const gDomain = V.group("grp:domain", t("Domain", "ドメイン"));
    const gPorts = V.group("grp:ports", t("Ports", "ポート"));
    const gAdapters = V.group("grp:adapters", t("Generated adapters", "生成されるアダプタ"));
    const served = ctx.useCases.filter(servedOverHttp);
    const httpRoutes = http && (served.length > 0 || ctx.aggregates.length > 0);
    if (httpRoutes) {
      V.add({
        id: id("adapter", "http"),
        kind: "adapter",
        label: t("HTTP routes", "HTTP ルート"),
        technology: t("generated server handler", "生成されたサーバーハンドラ"),
        description: t(`${served.length} use case endpoints, ${ctx.aggregates.length} GET by id, ${ctx.queries.length} query endpoints.`, `ユースケース ${served.length}・ID で GET ${ctx.aggregates.length}・クエリ ${ctx.queries.length} のエンドポイント`),
        path: apiPath,
        group: gEntry,
        badges: [jwt && "JWT", defaultRate && rateBadge(defaultRate)],
        code: [{ context: c, area: "api" }],
      });
    }
    // Upstream contexts whose events this context's policies consume.
    for (const p of ctx.policies) {
      const ev = policyEvent(ctx, p.when);
      if (ev.context !== c) V.add({ id: `ctx:${ev.context}`, kind: "context", label: ev.context, technology: t("Upstream context", "上流のコンテキスト"), path: model.contexts[ctxIndex(ev.context)]?.path, drill: ctxIndex(ev.context) >= 0 ? `context:${ev.context}` : undefined, group: gEntry });
    }
    for (const uc of ctx.useCases) {
      const rl = effectiveRateLimit(model, uc);
      V.add({
        id: id("uc", uc.name),
        kind: "use_case",
        label: uc.name,
        technology: `${pascal(uc.name)}UseCase`,
        description: uc.description,
        path: uc.path,
        group: gApp,
        badges: [authorizeBadge(uc.authorize), uc.authorize?.crossTenant && "cross-tenant", servedOverHttp(uc) && rl && rateBadge(rl), uc.idempotencyKey && `idempotent: ${uc.idempotencyKey}`, uc.transaction === "none" && "no transaction"],
        code: [{ context: c, area: "application" }],
      });
    }
    for (const q of ctx.queries) {
      const rl = effectiveRateLimit(model, q);
      V.add({
        id: id("query", q.name),
        kind: "query",
        label: q.name,
        technology: `${pascal(q.name)}Query`,
        description: q.description,
        path: q.path,
        group: gApp,
        badges: [q.search && (q.search.mode === "trigram" ? "trigram" : `search: ${q.search.mode}`), `page ${q.page.size}/${q.page.maxSize}`, authorizeBadge(q.authorize), rl && rateBadge(rl), q.where.some((w) => w.principal) && "scoped to principal"],
        code: [{ context: c, area: "application" }],
      });
    }
    for (const p of ctx.policies) {
      const ev = policyEvent(ctx, p.when);
      V.add({
        id: id("policy", p.name),
        kind: "policy",
        label: p.name,
        technology: `${pascal(p.name)}Policy`,
        description: p.description ?? t(`When ${ev.context}.${ev.name}, run ${p.run}.`, `${ev.context}.${ev.name} が起きたら ${p.run} を実行`),
        path: p.path,
        group: gApp,
        badges: [`on ${ev.context === c ? ev.name : `${ev.context}.${ev.name}`}`],
        code: [{ context: c, area: "policies" }],
      });
    }
    for (const ag of ctx.aggregates) {
      const rl = effectiveRateLimit(model, ag);
      V.add({
        id: id("agg", ag.name),
        kind: "aggregate",
        label: ag.name,
        technology: t("Aggregate", "集約"),
        description: ag.description,
        path: ag.path,
        group: gDomain,
        badges: [tenancy ? (isTenantScoped(sec, ag) ? "tenant" : "global") : undefined, authorizeBadge(ag.authorize) && `read: ${authorizeBadge(ag.authorize)}`, http && rl && rateBadge(rl), count(ag.operations.length + ag.factories.length, "operation", "operations", "操作")],
        code: [{ context: c, area: "domain" }],
      });
    }
    // Ports
    const port = (name: string, description: string, path?: Path, badges: (string | false | undefined)[] = []) =>
      V.add({ id: id("port", name), kind: "port", label: name, technology: t("Port (interface)", "ポート（インターフェース）"), description, path, group: gPorts, badges, code: [{ context: c, area: "application" }] });
    for (const ag of ctx.aggregates) port(`${ag.name}Repository`, t(`Loads and stores ${ag.name}${isTenantScoped(sec, ag) ? " of one tenant at a time" : ""}.`, `${ag.name} を読み込み・保存する${isTenantScoped(sec, ag) ? "（1 テナントずつ）" : ""}`), ag.path, [isTenantScoped(sec, ag) && "tenant", ctx.queries.length > 0 && "optimistic lock"]);
    for (const q of ctx.queries) port(`${pascal(q.name)}Reader`, t(`Reads pages of ${q.from} for ${q.name}.`, `${q.name} のために ${q.from} をページ単位で読む`), q.path, [q.search?.mode === "trigram" && "trigram", "keyset paging"]);
    if (ctx.extensionPoints.length) port("Extensions", t(`Customer-implemented: ${ctx.extensionPoints.map((x) => x.name).join(", ")}.`, `顧客が実装: ${ctx.extensionPoints.map((x) => x.name).join("・")}`), [...ctx.path, "extension_points"]);
    if (usesPort(ctx, analysis, "clock")) port("Clock", t("Current time (clock.now).", "現在時刻（clock.now）"));
    if (usesPort(ctx, analysis, "ids")) port("IdGenerator", t("New identifiers (ids.new).", "新しい識別子（ids.new）"));
    if (ctx.useCases.some((u) => hasStep(u.steps, "publish"))) port("EventPublisher", t("Publishes domain events (after commit when asked).", "ドメインイベントを発行する（指定時はコミット後）"));
    if (ctx.useCases.some((u) => u.transaction === "required")) port("UnitOfWork", t("Transaction boundary of a use case.", "ユースケースのトランザクション境界"));
    if (ctx.useCases.some((u) => u.idempotencyKey)) port("IdempotencyStore", t("Records results by idempotency key.", "冪等キーごとに結果を記録する"));
    if (ctx.useCases.some((u) => u.authorize?.crossTenant)) port("CrossTenantAudit", t("Audits cross-tenant access by platform roles.", "プラットフォームロールによるテナント横断アクセスを監査する"), sec?.path, ["audit"]);
    const aclUpstreams = [...new Set(ctx.policies.map((p) => policyEvent(ctx, p.when)).filter((ev) => ev.context !== c && model.relationships.some((r) => r.upstream === ev.context && r.downstream === c && r.pattern === "anticorruption_layer")).map((ev) => ev.context))];
    for (const up of aclUpstreams) port(`${up}Translator`, t(`Anticorruption layer: translates ${up} events into commands of ${c}.`, `腐敗防止層: ${up} のイベントを ${c} のコマンドに翻訳する`), undefined, ["ACL"]);
    for (const x of ctx.extensionPoints) V.add({ id: `ext:${c}.${x.name}`, kind: "external", label: x.name, technology: t("External system", "外部システム"), description: x.description, path: x.path, group: gAdapters, badges: ["customer code"], code: [{ context: c, area: "extensions" }] });
    // Adapters
    V.add({
      id: id("adapter", "memory"),
      kind: "adapter",
      label: t("In-memory adapters", "インメモリのアダプタ"),
      technology: t("generated test doubles", "生成されたテストダブル"),
      description: t("Repositories, clock, ids and publisher for tests and prototypes.", "テストと試作のためのリポジトリ・時計・ID・発行"),
      group: gAdapters,
      code: [{ context: c, area: "testing" }],
    });
    if (ctx.queries.length) {
      V.add({
        id: id("adapter", "postgres"),
        kind: "adapter",
        label: t("PostgreSQL adapters", "PostgreSQL のアダプタ"),
        technology: t("generated repositories and readers", "生成されたリポジトリとリーダー"),
        description: t("SQL repositories (optimistic locking) and query readers (keyset paging).", "SQL のリポジトリ（楽観的ロック）とクエリのリーダー（キーセットページング）"),
        group: gAdapters,
        badges: [tenancy && (tenancy.rls ? "RLS" : "RLS off"), ctx.queries.some((q) => q.search?.mode === "trigram") && "trigram"],
        code: [{ context: c, area: "persistence" }, { context: c, area: "sql" }],
      });
      V.add({ id: "ctr:postgres", kind: "database", label: "PostgreSQL", technology: "PostgreSQL", group: gAdapters, badges: [tenancy && (tenancy.rls ? "RLS on" : "RLS off"), ctx.queries.some((q) => q.search?.mode === "trigram") && "trigram"], code: [{ context: c, area: "sql" }] });
    }
    if (ctx.extensionPoints.length || aclUpstreams.length) {
      V.add({ id: id("adapter", "extensions"), kind: "adapter", label: t("Customer extensions", "顧客の拡張"), technology: t("scaffold (customer-owned)", "雛形（顧客が所有）"), description: t("Implements the extension points and translators; never overwritten.", "拡張ポイントと翻訳を実装する。上書きされない"), group: gAdapters, code: [{ context: c, area: "extensions" }] });
    }

    // L3 relations
    const http_ = id("adapter", "http");
    for (const uc of ctx.useCases) {
      const u = id("uc", uc.name);
      if (servedOverHttp(uc)) V.link(http_, u, "POST", { technology: "HTTPS JSON" });
      const touched = touchedAggregates(uc);
      for (const ag of touched.all) {
        const saves = touched.saved.has(ag);
        V.link(u, id("agg", ag), saves ? t("changes", "変更") : t("reads", "読む"));
        V.link(u, id("port", `${ag}Repository`), saves ? t("load / save", "読み込み・保存") : t("load", "読み込み"));
      }
      if (useCaseUses(ctx, uc, analysis, "clock")) V.link(u, id("port", "Clock"), "clock.now");
      if (useCaseUses(ctx, uc, analysis, "ids")) V.link(u, id("port", "IdGenerator"), "ids.new");
      for (const x of extensionsOf(ctx, uc, analysis)) V.link(u, id("port", "Extensions"), x);
      if (uc.idempotencyKey) V.link(u, id("port", "IdempotencyStore"), uc.idempotencyKey);
      if (uc.authorize?.crossTenant) V.link(u, id("port", "CrossTenantAudit"), t("records access", "アクセスを記録"));
      if (hasStep(uc.steps, "publish")) V.link(u, id("port", "EventPublisher"), t("publishes", "発行"), { dashed: true });
    }
    for (const q of ctx.queries) {
      const qi = id("query", q.name);
      V.link(http_, qi, "GET", { technology: "HTTPS JSON" });
      V.link(qi, id("port", `${pascal(q.name)}Reader`), t("reads a page", "ページを読む"));
    }
    if (http) for (const ag of ctx.aggregates) if (ag.authorize) V.link(http_, id("agg", ag.name), t("GET by id", "ID で GET"), { technology: "HTTPS JSON", dashed: true });
    for (const p of ctx.policies) {
      const ev = policyEvent(ctx, p.when);
      const pi = id("policy", p.name);
      if (ev.context !== c) V.link(`ctx:${ev.context}`, pi, ev.name, { technology: t("in-process events", "プロセス内イベント"), dashed: true });
      else {
        const src = ctx.aggregates.find((a) => [...a.factories, ...a.operations].some((m) => m.emits.some((e) => e.name === ev.name)));
        if (src) V.link(id("agg", src.name), pi, ev.name, { technology: t("domain event", "ドメインイベント"), dashed: true });
      }
      V.link(pi, id("uc", p.run), t("runs", "実行"));
      if (ev.context !== c && aclUpstreams.includes(ev.context)) V.link(pi, id("port", `${ev.context}Translator`), t("translates", "翻訳"));
    }
    for (const x of ctx.extensionPoints) V.link(id("adapter", "extensions"), `ext:${c}.${x.name}`, t("calls", "呼び出す"), { dashed: true });
    const memory = id("adapter", "memory");
    const pg = id("adapter", "postgres");
    for (const ag of ctx.aggregates) {
      V.link(memory, id("port", `${ag.name}Repository`), t("implements", "実装"), { dashed: true, upward: true });
      V.link(pg, id("port", `${ag.name}Repository`), t("implements", "実装"), { dashed: true, upward: true });
    }
    for (const q of ctx.queries) V.link(pg, id("port", `${pascal(q.name)}Reader`), t("implements", "実装"), { dashed: true, upward: true });
    V.link(pg, "ctr:postgres", "SQL", { technology: tenancy ? (tenancy.rls ? "SQL, tenant_id + RLS" : "SQL, tenant_id") : "SQL" });
    if (ctx.extensionPoints.length) V.link(id("adapter", "extensions"), id("port", "Extensions"), t("implements", "実装"), { dashed: true, upward: true });
    for (const up of aclUpstreams) V.link(id("adapter", "extensions"), id("port", `${up}Translator`), t("implements", "実装"), { dashed: true, upward: true });
    contexts.push(V.build());
  }

  return { project: model.project, description: model.description, target, system: L1.build(), containers: L2.build(), contexts };
}

/** Every level of an architecture, in display order. */
export function architectureLevels(arch: Architecture): ArchLevel[] {
  return ["system", "containers", ...arch.contexts.map((v) => v.level)];
}

