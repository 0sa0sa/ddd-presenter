/**
 * Operations of the アーキテクチャ tab: each one is a list of structural YAML edits (applyEdits) that is applied only
 * when it keeps the model valid. An edit that adds validation errors is refused with the validator's diagnostics, so the
 * diagram can never break the model.
 */
import {
  applyEdits,
  RATE_LIMIT_KEYS,
  RATE_LIMIT_UNITS,
  RELATIONSHIP_PATTERNS,
  SUBDOMAIN_KINDS,
  templates,
  toSnake,
  validateModelText,
  type ArchCode,
  type Diagnostic,
  type EditOp,
  type GenerationTarget,
  type ModelIR,
  type RateLimitKey,
  type RateLimitUnit,
  type RelationshipPattern,
  type SubdomainKind,
} from "@ddd/core";

export type OpResult = { ok: true; text: string; ops: EditOp[] } | { ok: false; error: string; diagnostics: Diagnostic[] };

const diagKey = (d: Diagnostic) => `${d.code}\u0000${d.message}\u0000${(d.path ?? []).join(".")}`;

/** Applies the edits; refuses them when they add errors (errors the model already had do not block). */
export function checkedEdit(text: string, ops: EditOp[]): OpResult {
  if (!ops.length) return { ok: false, error: "変更がありません", diagnostics: [] };
  const r = applyEdits(text, ops);
  if (!r.ok) return { ok: false, error: r.error, diagnostics: [] };
  const before = new Set(validateModelText(text).diagnostics.filter((d) => d.severity === "error").map(diagKey));
  const added = validateModelText(r.text).diagnostics.filter((d) => d.severity === "error" && !before.has(diagKey(d)));
  if (added.length) return { ok: false, error: "この変更はモデルを不正にするため適用しませんでした", diagnostics: added };
  return { ok: true, text: r.text, ops };
}

const fail = (error: string): OpResult => ({ ok: false, error, diagnostics: [] });
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

export function addContext(text: string, model: ModelIR, name: string, subdomain?: SubdomainKind): OpResult {
  const n = name.trim();
  if (!PASCAL.test(n)) return fail("コンテキスト名は英字で始まる PascalCase にしてください（例: Billing）");
  if (model.contexts.some((c) => c.name === n)) return fail(`コンテキスト ${n} はすでにあります`);
  const value: Record<string, unknown> = { ...templates.context(n) };
  if (subdomain) value.subdomain = subdomain;
  return checkedEdit(text, [{ op: "add", path: ["contexts"], value }]);
}

export function setSubdomain(text: string, model: ModelIR, context: string, subdomain: SubdomainKind | undefined): OpResult {
  const i = model.contexts.findIndex((c) => c.name === context);
  if (i < 0) return fail(`コンテキスト ${context} がありません`);
  if (subdomain && !SUBDOMAIN_KINDS.includes(subdomain)) return fail(`subdomain は ${SUBDOMAIN_KINDS.join(" / ")} のどれかです`);
  if (!subdomain) return model.contexts[i]!.subdomain ? checkedEdit(text, [{ op: "remove", path: ["contexts", i, "subdomain"] }]) : fail("変更がありません");
  return checkedEdit(text, [{ op: "set", path: ["contexts", i, "subdomain"], value: subdomain }]);
}

export interface RelationshipDraft {
  upstream: string;
  downstream: string;
  pattern: RelationshipPattern;
  events: string[];
  description?: string;
}

function relationshipValue(d: RelationshipDraft): Record<string, unknown> {
  const v: Record<string, unknown> = { upstream: d.upstream, downstream: d.downstream, pattern: d.pattern };
  if (d.events.length) v.events = d.events;
  if (d.description?.trim()) v.description = d.description.trim();
  return v;
}

export function addRelationship(text: string, model: ModelIR, d: RelationshipDraft): OpResult {
  if (d.upstream === d.downstream) return fail("同じコンテキスト同士はつなげません");
  if (!RELATIONSHIP_PATTERNS.includes(d.pattern)) return fail("パターンを選んでください");
  if (model.relationships.some((r) => r.upstream === d.upstream && r.downstream === d.downstream)) return fail(`${d.upstream} → ${d.downstream} の関係はすでにあります。線を選んで編集してください`);
  return checkedEdit(text, [{ op: "add", path: ["relationships"], value: relationshipValue(d) }]);
}

export function updateRelationship(text: string, model: ModelIR, index: number, d: RelationshipDraft): OpResult {
  if (!model.relationships[index]) return fail("関係が見つかりません");
  return checkedEdit(text, [{ op: "set", path: ["relationships", index], value: relationshipValue(d) }]);
}

export function removeRelationship(text: string, model: ModelIR, index: number): OpResult {
  if (!model.relationships[index]) return fail("関係が見つかりません");
  return checkedEdit(text, [{ op: "remove", path: ["relationships", index] }]);
}

/** Events a relationship may carry: those emitted in the upstream context. */
export function upstreamEvents(model: ModelIR, upstream: string): string[] {
  const ctx = model.contexts.find((c) => c.name === upstream);
  if (!ctx) return [];
  const out = new Set<string>();
  for (const a of ctx.aggregates) for (const m of [...a.factories, ...a.operations]) for (const e of m.emits) out.add(e.name);
  return [...out].sort();
}

export function setTarget(text: string, model: ModelIR, target: GenerationTarget): OpResult {
  if (model.generation.target === target) return fail("変更がありません");
  return checkedEdit(text, [{ op: "set", path: ["generation", "target"], value: target }]);
}

export function setHttpApi(text: string, model: ModelIR, on: boolean): OpResult {
  if (on === !!model.generation.typescript.api) return fail("変更がありません");
  if (on) return checkedEdit(text, [{ op: "set", path: ["generation", "typescript", "api"], value: { base_path: "/api", client: "tanstack-query" } }]);
  const ops: EditOp[] = [{ op: "remove", path: ["generation", "typescript", "api"] }];
  // `typescript: {}` left behind reads oddly: drop the empty map too.
  const removed = applyEdits(text, ops);
  if (removed.ok && /^ {2}typescript: \{\}\s*$/m.test(removed.text)) ops.push({ op: "remove", path: ["generation", "typescript"] });
  return checkedEdit(text, ops);
}

/** Row level security as defense in depth (`security.tenancy.rls`): on is the default, so turning it on removes the key. */
export function setRls(text: string, model: ModelIR, on: boolean): OpResult {
  const t = model.security?.tenancy;
  if (!t) return fail("マルチテナント（security.tenancy）がないモデルには RLS はありません");
  if (t.rls === on) return fail("変更がありません");
  return checkedEdit(text, [on ? { op: "remove", path: ["security", "tenancy", "rls"] } : { op: "set", path: ["security", "tenancy", "rls"], value: "off" }]);
}

export interface RateLimitDraft {
  requests: number;
  per: RateLimitUnit;
  by: RateLimitKey;
}

export function setDefaultRateLimit(text: string, model: ModelIR, limit: RateLimitDraft | undefined): OpResult {
  if (!model.security) return fail("セキュリティ（security）がないモデルにはレート制限はありません");
  if (!limit) return model.security.rateLimits.default ? checkedEdit(text, [{ op: "remove", path: ["security", "rate_limits", "default"] }]) : fail("変更がありません");
  if (!Number.isInteger(limit.requests) || limit.requests < 1) return fail("リクエスト数は 1 以上の整数にしてください");
  if (!RATE_LIMIT_UNITS.includes(limit.per) || !RATE_LIMIT_KEYS.includes(limit.by)) return fail("単位と数える単位を選んでください");
  return checkedEdit(text, [{ op: "set", path: ["security", "rate_limits", "default"], value: { requests: limit.requests, per: limit.per, by: limit.by } }]);
}

/** An external system the context asks through a customer-implemented extension point. */
export function addExternalSystem(text: string, model: ModelIR, context: string, d: { name: string; description?: string; returns?: string }): OpResult {
  const i = model.contexts.findIndex((c) => c.name === context);
  if (i < 0) return fail(`コンテキスト ${context} がありません`);
  const name = d.name.trim();
  if (!SNAKE.test(name)) return fail("拡張ポイント名は snake_case にしてください（例: check_credit）");
  if (model.contexts[i]!.extensionPoints.some((x) => x.name === name)) return fail(`${context} に ${name} はすでにあります`);
  const returns = d.returns?.trim() || "Boolean";
  const value: Record<string, unknown> = { name };
  if (d.description?.trim()) value.description = d.description.trim();
  value.parameters = [];
  value.returns = returns;
  if (returns === "Boolean") value.test_default = false;
  return checkedEdit(text, [{ op: "add", path: ["contexts", i, "extension_points"], value }]);
}

/**
 * A minimal `security` block (one role, bearer JWT) plus `authorize` where it is missing: `internal` for use cases a
 * policy runs, `authenticated` for every other use case, aggregate and query (security denies by default otherwise).
 */
export function addSecurity(text: string, model: ModelIR, d: { role: string; issuer?: string; audience?: string }): OpResult {
  if (model.security) return fail("セキュリティはすでに宣言されています");
  const role = d.role.trim();
  if (!SNAKE.test(role)) return fail("ロール名は snake_case にしてください（例: member）");
  const authentication: Record<string, unknown> = { scheme: "bearer_jwt" };
  if (d.issuer?.trim()) authentication.issuer = d.issuer.trim();
  if (d.audience?.trim()) authentication.audience = d.audience.trim();
  authentication.algorithms = ["RS256"];
  const ops: EditOp[] = [{ op: "set", path: ["security"], value: { roles: [role], authentication } }];
  const policyRuns = new Set(model.contexts.flatMap((c) => c.policies.map((p) => `${c.name}.${p.run}`)));
  model.contexts.forEach((c, i) => {
    c.useCases.forEach((u, j) => {
      if (!u.authorize) ops.push({ op: "set", path: ["contexts", i, "use_cases", j, "authorize"], value: policyRuns.has(`${c.name}.${u.name}`) ? "internal" : "authenticated" });
    });
    c.aggregates.forEach((a, j) => {
      if (!a.authorize) ops.push({ op: "set", path: ["contexts", i, "aggregates", j, "authorize"], value: "authenticated" });
    });
    c.queries.forEach((q, j) => {
      if (!q.authorize) ops.push({ op: "set", path: ["contexts", i, "queries", j, "authorize"], value: "authenticated" });
    });
  });
  return checkedEdit(text, ops);
}

export const PATTERN_JA: Record<RelationshipPattern, string> = {
  customer_supplier: "顧客/供給者（customer_supplier）",
  conformist: "順応者（conformist）",
  anticorruption_layer: "腐敗防止層（anticorruption_layer）",
  open_host_service: "公開ホストサービス（open_host_service）",
  published_language: "公表された言語（published_language）",
  shared_kernel: "共有カーネル（shared_kernel）",
  partnership: "パートナーシップ（partnership）",
  separate_ways: "別々の道（separate_ways）",
};

/** Small undo stack for the tab's operations (the YAML editor's own history does not span tabs). */
export class OpHistory {
  private stack: { before: string; after: string; label: string }[] = [];
  push(before: string, after: string, label: string): void {
    this.stack.push({ before, after, label });
    if (this.stack.length > 50) this.stack.shift();
  }
  /** The text before the last operation, if the model still is what that operation produced. */
  undo(current: string): { text: string; label: string } | { error: string } | undefined {
    const last = this.stack[this.stack.length - 1];
    if (!last) return undefined;
    if (last.after !== current) {
      this.stack = [];
      return { error: "その後にモデルが編集されたため元に戻せません（YAML エディタで Ctrl/Cmd+Z を使ってください）" };
    }
    this.stack.pop();
    return { text: last.before, label: last.label };
  }
  get size(): number {
    return this.stack.length;
  }
  peek(): string | undefined {
    return this.stack[this.stack.length - 1]?.label;
  }
}

/**
 * Generated files of an element (matched against the preview's file list by the context's directory and the layer):
 * `cleaning_staff/domain/…` (Python) or `cleaning-staff/domain/…` (TypeScript), `sql/<context>.sql`, the security modules.
 */
export function generatedFilesFor(code: ArchCode[] | undefined, paths: string[]): string[] {
  if (!code?.length) return [];
  const out = new Set<string>();
  for (const c of code) {
    const snake = c.context ? toSnake(c.context) : "";
    const dirs = c.context ? [snake, snake.replace(/_/g, "-")] : [];
    const inCtx = (sub: string) => (p: string) => dirs.some((d) => p.includes(`/generated/${d}/${sub}`));
    const match: Record<ArchCode["area"], (p: string) => boolean> = {
      domain: inCtx("domain/"),
      application: inCtx("application/"),
      policies: inCtx("application/policies."),
      persistence: inCtx("persistence/"),
      testing: inCtx("testing."),
      api: c.context ? inCtx("api/") : (p) => /\/generated\/api\/|\/generated\/_?connect\.py$|\/generated\/proto\//.test(p),
      sql: (p) => p === `sql/${snake}.sql`,
      extensions: (p) => dirs.some((d) => p.includes(`/extensions/${d}/`)),
      security: (p) => /\/generated\/(security|authentication|rate_limit)\.(py|ts)$|\/generated\/api\/(authentication|rate-limit)\.ts$/.test(p),
      runtime: (p) => /\/generated\/(_?runtime|adapters)\.(py|ts)$/.test(p),
    };
    for (const p of paths) if (match[c.area](p)) out.add(p);
  }
  return [...out].sort();
}
