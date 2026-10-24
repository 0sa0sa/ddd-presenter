/**
 * Flow diagrams for a human review (docs/11 §12): what each use case and query does, on which part of the generated
 * system (API, application, domain, PostgreSQL, event dispatch), in which order and where it stops; and how events
 * chain use cases across contexts. Derived from the model only, as data the Web editor draws (SVG) and the CLI writes
 * (Mermaid). Pure, no Node APIs.
 */
import type { Path } from "./diagnostics.ts";
import type { AggregateIR, ContextIR, ModelIR, StepIR, UseCaseIR } from "./ir.ts";
import type { QueryIR } from "./queries.ts";
import { generatesHttpApi } from "./architecture.ts";
import { conditionWords, plainName } from "./conditions.ts";
import { isTenantScoped } from "./security.ts";
import type { Analysis } from "./validate.ts";

/** `context`: the application of another context (a policy runs one of its use cases). */
export type SeqParticipantKind = "person" | "server" | "security" | "app" | "aggregate" | "db" | "events" | "context";

export interface SeqParticipant {
  id: string;
  label: string;
  kind: SeqParticipantKind;
  /** Second line: what the part is (`HTTP API`, `集約`, `PostgreSQL`). */
  sub?: string;
}

export type SeqMessageStyle = "call" | "reply" | "async" | "fail";

export type SeqItem =
  | { kind: "msg"; from: string; to: string; text: string; style: SeqMessageStyle; path?: Path }
  | { kind: "note"; over: string[]; text: string; path?: Path }
  /** `alt` (branches), `opt` (one branch: what happens only then). */
  | { kind: "block"; type: "alt" | "opt"; branches: { label: string; items: SeqItem[] }[]; path?: Path };

/** What a diagram is drawn from in the .flow source (the block the editor opens). */
export interface FlowRef {
  context: string;
  kind: "use_case" | "query" | "policy";
  name: string;
}

export interface SequenceDiagram {
  /** `Context.name` */
  id: string;
  ref: FlowRef;
  title: string;
  description?: string;
  participants: SeqParticipant[];
  items: SeqItem[];
  path: Path;
}

export type EventNodeKind = "actor" | "use_case" | "event" | "policy";

export interface EventNode {
  id: string;
  kind: EventNodeKind;
  label: string;
  /** Context the node belongs to (absent: actors). */
  context?: string;
  detail?: string;
  path?: Path;
  ref?: FlowRef;
  /** An event nothing reacts to, a use case nothing runs. */
  dangling?: boolean;
}

export interface EventEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface EventFlowGraph {
  nodes: EventNode[];
  edges: EventEdge[];
}

export interface FlowDiagrams {
  useCases: SequenceDiagram[];
  queries: SequenceDiagram[];
  events: EventFlowGraph;
}

const EVENTS = "events";
const DB = "db";
const SECURITY = "security";
const ACTOR = "actor";

/**
 * Every diagram of the model: one sequence per use case and per query, and the event chain. With the analysis,
 * conditions are put into words where they can be (as in the review questions).
 */
export function flowDiagrams(model: ModelIR, analysis?: Analysis): FlowDiagrams {
  return {
    useCases: model.contexts.flatMap((ctx) => ctx.useCases.map((u) => useCaseSequence(model, ctx, u, analysis))),
    queries: model.contexts.flatMap((ctx) => ctx.queries.map((q) => querySequence(model, ctx, q, analysis))),
    events: eventFlow(model),
  };
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

/** The entry point a request reaches first: the generated HTTP / Connect API, or none (the use case is called in-process). */
function entryOf(model: ModelIR): SeqParticipant | undefined {
  if (generatesHttpApi(model)) return { id: "api", label: "HTTP API", kind: "server", sub: model.generation.typescript.api?.connect ? "HTTPS JSON / Connect" : "HTTPS JSON" };
  if (model.generation.target === "python" && model.generation.python?.connect) return { id: "api", label: "Connect API", kind: "server", sub: "Connect" };
  return undefined;
}

/** Who runs a use case: its actor, the event dispatch (a policy runs it), or a caller. */
function runnersOf(model: ModelIR, ctx: ContextIR, u: UseCaseIR): string[] {
  return model.contexts.flatMap((c) => (c === ctx ? c.policies.filter((p) => p.run === u.name).map((p) => `${c.name}.${p.name}`) : []));
}

const label = (description: string | undefined, name: string) => (description ? `「${description}」${name}` : name);
const argList = (args: Record<string, string>) => Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(", ");
const guardName = (call: string) => call.split("(")[0]!.trim();

class SeqBuilder {
  readonly participants: SeqParticipant[] = [];
  private readonly ids = new Set<string>();
  add(p: SeqParticipant): string {
    if (!this.ids.has(p.id)) {
      this.ids.add(p.id);
      this.participants.push(p);
    }
    return p.id;
  }
}

function errorText(ctx: ContextIR, name: string): string {
  const e = ctx.errors.find((x) => x.name === name);
  return e ? `失敗: ${name}（${e.message}）` : `失敗: ${name}`;
}

/** Participants in a fixed left-to-right order: who calls, the servers, the context's application, aggregates, the database, events. */
const ORDER: SeqParticipantKind[] = ["person", "server", "security", "app", "aggregate", "db", "events", "context"];
function ordered(ps: SeqParticipant[]): SeqParticipant[] {
  const rank = (p: SeqParticipant, i: number) => (i === 0 ? -1 : ORDER.indexOf(p.kind));
  return ps.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p, a.i) - rank(b.p, b.i) || a.i - b.i).map((x) => x.p);
}

/** The opening shared by use cases and queries: the caller, the API with authentication, the role check. */
function opening(model: ModelIR, ctx: ContextIR, b: SeqBuilder, items: SeqItem[], o: { actor: string; request: string; authorize: UseCaseIR["authorize"]; app: string; path: Path; viaEvents: boolean }) {
  // Run by a policy: the request comes from the event dispatch (the same column its own events go to).
  const actor = b.add({ id: o.viaEvents ? EVENTS : ACTOR, label: o.actor, kind: o.viaEvents ? "events" : "person", ...(o.viaEvents ? { sub: "ポリシー" } : {}) });
  // Internal use cases (policies, jobs) have no endpoint: they are called in-process.
  const entry = !o.viaEvents && o.authorize?.kind !== "internal" ? entryOf(model) : undefined;
  const caller = entry ? b.add(entry) : actor;
  if (entry) items.push({ kind: "msg", from: actor, to: caller, text: o.request, style: "call", path: o.path });
  const sec = model.security;
  const a = o.authorize;
  if (entry && sec?.authentication) {
    const s = b.add({ id: SECURITY, label: "セキュリティ", kind: "security", sub: sec.authentication.scheme === "bearer_jwt" ? "JWT" : "認証" });
    items.push({ kind: "msg", from: caller, to: s, text: a?.kind === "public" ? "レート制限" : "認証・レート制限", style: "call", path: sec.path });
    if (a?.kind !== "public") items.push({ kind: "block", type: "opt", branches: [{ label: "ログインしていない", items: [{ kind: "msg", from: s, to: actor, text: "失敗: 認証が必要（401）", style: "fail" }] }] });
  }
  items.push({ kind: "msg", from: caller, to: o.app, text: entry ? o.request : o.request, style: "call", path: o.path });
  if (sec && model.security?.tenancy) items.push({ kind: "note", over: [o.app], text: a?.crossTenant ? "入力の tenant_id の組織で動く（運営側のロール）" : "ログインした人の組織の中で動く", path: sec.tenancy?.path ?? sec.path });
  if (a?.kind === "principal" && (a.roles.length || a.permissions?.length)) {
    const who = [a.roles.length ? `ロール ${a.roles.join("・")}` : "", a.permissions?.length ? `権限 ${a.permissions.join("・")}` : ""].filter(Boolean).join("、");
    const one = a.roles.length + (a.permissions?.length ?? 0) === 1;
    items.push({ kind: "block", type: "opt", branches: [{ label: `${who} を${one ? "" : "どれも"}持っていない`, items: [{ kind: "msg", from: o.app, to: caller, text: "失敗: 権限がない（403）", style: "fail" }] }], path: a.path });
  }
  return { actor, caller, entry };
}

function useCaseSequence(model: ModelIR, ctx: ContextIR, u: UseCaseIR, analysis: Analysis | undefined): SequenceDiagram {
  const b = new SeqBuilder();
  const items: SeqItem[] = [];
  const runners = runnersOf(model, ctx, u);
  const viaEvents = runners.length > 0 && (!u.actor || u.authorize?.kind === "internal");
  const app = `app:${ctx.name}`;
  const request = `${u.command}(${u.input.map((f) => f.name).join(", ")})`;
  const actorName = viaEvents ? "イベント配信" : (u.actor ?? (u.authorize?.kind === "internal" ? "呼び出し元（内部）" : "利用者"));
  const { caller, entry, actor } = opening(model, ctx, b, items, { actor: actorName, request, authorize: u.authorize, app, path: u.path, viaEvents });
  b.add({ id: app, label: `${ctx.name} アプリケーション`, kind: "app", sub: "Use case" });
  if (u.idempotencyKey) {
    items.push({ kind: "block", type: "opt", branches: [{ label: `同じ ${u.idempotencyKey} で実行済み`, items: [{ kind: "msg", from: app, to: caller, text: "記録した結果を返す（何もしない）", style: "reply" }] }], path: [...u.path, "idempotency_key"] });
  }
  if (u.transaction === "required" && u.steps.some((s) => s.kind === "save" || containsSave(s))) items.push({ kind: "note", over: [app, DB], text: "ここから 1 つのトランザクション（失敗したらすべて取り消す）", path: [...u.path, "transaction"] });

  const vars = new Map<string, AggregateIR>();
  const locals: Record<string, string> = Object.fromEntries(u.input.map((f) => [f.name, `入力の ${f.name}`]));
  const cond = (path: Path, source: string) => conditionWords(analysis, ctx.name, path, source, locals);
  const tenantNoted = new Set<string>();
  const db = () => b.add({ id: DB, label: "PostgreSQL", kind: "db", sub: "リポジトリ" });
  const aggId = (v: string, ag: AggregateIR) => b.add({ id: `agg:${v}`, label: ag.name, kind: "aggregate", sub: `集約 ${v}` });
  const tenantNote = (ag: AggregateIR, out: SeqItem[]) => {
    if (!isTenantScoped(model.security, ag) || tenantNoted.has(ag.name)) return;
    tenantNoted.add(ag.name);
    out.push({ kind: "note", over: [DB], text: `${ag.name} は組織（tenant_id）で絞る${model.security?.tenancy?.rls ? "・RLS" : ""}` });
  };
  const guards = (ag: AggregateIR, require: string[], from: string, out: SeqItem[]) => {
    for (const call of require) {
      const g = ag.stateGuards.find((x) => x.name === guardName(call));
      if (!g) continue;
      out.push({ kind: "block", type: "opt", branches: [{ label: `「${g.description ?? conditionWords(analysis, ctx.name, [...g.path, "expression"], g.expression)}」でない`, items: [{ kind: "msg", from, to: caller, text: errorText(ctx, g.error), style: "fail", path: g.path }] }], path: g.path });
    }
  };
  const emits = (emitted: AggregateIR["operations"][number]["emits"], from: string, out: SeqItem[]) => {
    for (const e of emitted) out.push({ kind: "msg", from, to: app, text: `イベントを記録: ${e.name}${e.when ? `（${e.when} のとき）` : ""}`, style: "reply", path: e.path });
  };
  const allowIf = u.authorize?.allowIf;
  let lead = 0;
  while (lead < u.steps.length && u.steps[lead]!.kind === "load") lead++;

  const walk = (steps: StepIR[], out: SeqItem[], top: boolean) => {
    steps.forEach((s, i) => {
      if (top && i === lead && allowIf !== undefined) allow(out);
      step(s, out);
    });
    if (top && lead === steps.length && allowIf !== undefined) allow(out);
  };
  const allow = (out: SeqItem[]) => {
    const path = [...u.authorize!.path, "allow_if"];
    out.push({ kind: "block", type: "opt", branches: [{ label: `「${cond(path, allowIf!)}」でない`, items: [{ kind: "msg", from: app, to: caller, text: "失敗: 権限がない（403）", style: "fail" }] }], path });
  };
  const step = (s: StepIR, out: SeqItem[]) => {
    switch (s.kind) {
      case "load": {
        const ag = ctx.aggregates.find((x) => x.name === s.aggregate);
        const d = db();
        if (ag) tenantNote(ag, out);
        out.push({ kind: "msg", from: app, to: d, text: `読み込む: ${s.aggregate}（${s.by}）`, style: "call", path: s.path });
        out.push({ kind: "msg", from: d, to: app, text: s.as, style: "reply" });
        if (s.notFound) out.push({ kind: "block", type: "opt", branches: [{ label: "見つからない", items: [{ kind: "msg", from: app, to: caller, text: errorText(ctx, s.notFound), style: "fail" }] }], path: s.path });
        if (ag) {
          vars.set(s.as, ag);
          locals[s.as] = plainName(ag);
        }
        break;
      }
      case "create": {
        const ag = ctx.aggregates.find((x) => x.name === s.aggregate);
        if (!ag) break;
        vars.set(s.as, ag);
        locals[s.as] = plainName(ag);
        const f = ag.factories.find((x) => x.name === s.factory);
        const to = aggId(s.as, ag);
        out.push({ kind: "msg", from: app, to, text: `作る: ${label(f?.description, s.factory)}(${argList(s.args)})`, style: "call", path: s.path });
        if (f) guards(ag, f.require, to, out);
        if (f?.emits.length) emits(f.emits, to, out);
        else out.push({ kind: "msg", from: to, to: app, text: s.as, style: "reply" });
        break;
      }
      case "invoke": {
        const ag = vars.get(s.target);
        if (!ag) break;
        const op = ag.operations.find((x) => x.name === s.operation);
        const to = aggId(s.target, ag);
        out.push({ kind: "msg", from: app, to, text: `${label(op?.description, s.operation)}(${argList(s.args)})`, style: "call", path: s.path });
        if (op) {
          guards(ag, op.require, to, out);
          emits(op.emits, to, out);
        }
        break;
      }
      case "save": {
        const ag = vars.get(s.target);
        const d = db();
        if (ag) tenantNote(ag, out);
        out.push({ kind: "msg", from: app, to: d, text: `保存: ${s.target}${ag ? `（${ag.name}）` : ""}`, style: "call", path: s.path });
        out.push({ kind: "block", type: "opt", branches: [{ label: "読み込んだ後にほかの人が更新していた", items: [{ kind: "msg", from: d, to: caller, text: "失敗: 競合（version が違う）", style: "fail" }] }] });
        break;
      }
      case "publish": {
        const ev = b.add({ id: EVENTS, label: "イベント配信", kind: "events", sub: "ポリシー" });
        out.push({ kind: "msg", from: app, to: ev, text: `${s.afterCommit ? "コミット後に発行" : "発行"}: ${s.event}`, style: "async", path: s.path });
        for (const { context, policy } of consumers(model, ctx, s.event)) {
          const target = b.add({ id: `app:${context.name}`, label: `${context.name} アプリケーション`, kind: context === ctx ? "app" : "context", sub: "Use case" });
          out.push({ kind: "msg", from: ev, to: target, text: `${label(policy.description, policy.name)} → ${policy.run}`, style: "async", path: policy.path });
        }
        break;
      }
      case "if": {
        const branches: { label: string; items: SeqItem[] }[] = [];
        let cur: Extract<StepIR, { kind: "if" }> = s;
        for (;;) {
          const then: SeqItem[] = [];
          walk(cur.then, then, false);
          branches.push({ label: cond([...cur.path, "condition"], cur.condition), items: then });
          const nested = cur.else[0];
          if (cur.else.length === 1 && nested?.kind === "if") {
            cur = nested;
            continue;
          }
          if (cur.else.length) {
            const rest: SeqItem[] = [];
            walk(cur.else, rest, false);
            branches.push({ label: "それ以外", items: rest });
          }
          break;
        }
        out.push({ kind: "block", type: branches.length > 1 ? "alt" : "opt", branches, path: s.path });
        break;
      }
      case "fail":
        out.push({ kind: "msg", from: app, to: caller, text: errorText(ctx, s.error), style: "fail", path: s.path });
        break;
      case "return":
        out.push({ kind: "msg", from: app, to: caller, text: `結果: ${s.value}`, style: "reply", path: s.path });
        if (entry) out.push({ kind: "msg", from: caller, to: actor, text: "応答", style: "reply" });
        break;
      case "let":
        out.push({ kind: "note", over: [app], text: `計算: ${s.name} = ${s.value}`, path: s.path });
        break;
    }
  };
  walk(u.steps, items, true);
  if (!u.steps.some((s) => s.kind === "return")) {
    items.push({ kind: "msg", from: app, to: caller, text: "完了", style: "reply" });
    if (entry) items.push({ kind: "msg", from: caller, to: actor, text: "応答", style: "reply" });
  }
  return {
    id: `${ctx.name}.${u.name}`,
    ref: { context: ctx.name, kind: "use_case", name: u.name },
    title: u.description ? `${u.description}（${u.name}）` : u.name,
    ...(u.description ? { description: u.description } : {}),
    participants: ordered(b.participants),
    items,
    path: u.path,
  };
}

function containsSave(s: StepIR): boolean {
  return s.kind === "if" && [...s.then, ...s.else].some((x) => x.kind === "save" || containsSave(x));
}

/** Policies (of any context) that react to `event` published in `ctx`. */
function consumers(model: ModelIR, ctx: ContextIR, event: string) {
  const out: { context: ContextIR; policy: ContextIR["policies"][number] }[] = [];
  for (const c of model.contexts) {
    for (const p of c.policies) {
      if (c === ctx ? p.when === event || p.when === `${ctx.name}.${event}` : p.when === `${ctx.name}.${event}`) out.push({ context: c, policy: p });
    }
  }
  return out;
}

const OP_JA: Record<string, string> = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" };
const MODE_JA: Record<string, string> = { trigram: "あいまい検索", prefix: "前方一致", exact: "完全一致" };

function querySequence(model: ModelIR, ctx: ContextIR, q: QueryIR, analysis: Analysis | undefined): SequenceDiagram {
  const b = new SeqBuilder();
  const items: SeqItem[] = [];
  const app = `app:${ctx.name}`;
  const params = [...q.params.map((p) => p.name), ...(q.search ? [q.search.param] : []), "cursor", "limit"];
  const request = `${q.name}(${params.join(", ")})`;
  const { caller, entry, actor } = opening(model, ctx, b, items, { actor: "利用者", request, authorize: q.authorize, app, path: q.path, viaEvents: false });
  b.add({ id: app, label: `${ctx.name} アプリケーション`, kind: "app", sub: "クエリ" });
  if (q.authorize?.allowIf) {
    items.push({ kind: "block", type: "opt", branches: [{ label: `「${conditionWords(analysis, ctx.name, [...q.authorize.path, "allow_if"], q.authorize.allowIf)}」でない`, items: [{ kind: "msg", from: app, to: caller, text: "失敗: 権限がない（403）", style: "fail" }] }], path: [...q.path, "authorize", "allow_if"] });
  }
  const d = b.add({ id: DB, label: "PostgreSQL", kind: "db", sub: "テーブル" });
  const conds = q.where.map((w) => {
    const right = w.param !== undefined ? `入力の ${w.param}（あれば）` : w.principal !== undefined ? `本人の ${w.principal}` : JSON.stringify(w.value);
    return `${w.field} ${OP_JA[w.op] ?? w.op} ${right}`;
  });
  const ag = ctx.aggregates.find((x) => x.name === q.from);
  if (ag && isTenantScoped(model.security, ag)) conds.unshift(`tenant_id = 本人の組織${model.security?.tenancy?.rls ? "（RLS でも強制）" : ""}`);
  if (q.search) conds.push(`${q.search.param} で ${q.search.fields.join("・")} を${MODE_JA[q.search.mode] ?? q.search.mode}${q.search.mode === "trigram" ? `（類似度 ${q.search.minSimilarity} 以上）` : ""}`);
  items.push({ kind: "msg", from: app, to: d, text: `検索: ${q.from}`, style: "call", path: [...q.path, "from"] });
  if (conds.length) items.push({ kind: "note", over: [d], text: `条件: ${conds.join(" かつ ")}`, path: [...q.path, "where"] });
  const order = [...q.orderBy.map((o) => `${o.field === "relevance" ? "近い順" : o.field}${o.field === "relevance" ? "" : o.direction === "desc" ? " 降順" : " 昇順"}`), "id"];
  items.push({ kind: "note", over: [d], text: `並び: ${order.join("、")}・${q.page.size} 件ずつ（最大 ${q.page.maxSize} 件）`, path: q.page.path });
  items.push({ kind: "msg", from: d, to: app, text: `行（${q.returns ? q.returns.join(", ") : "すべての項目"}）`, style: "reply" });
  items.push({ kind: "msg", from: app, to: caller, text: "一覧と次のページのカーソル", style: "reply" });
  if (entry) items.push({ kind: "msg", from: caller, to: actor, text: "応答", style: "reply" });
  return {
    id: `${ctx.name}.${q.name}`,
    ref: { context: ctx.name, kind: "query", name: q.name },
    title: q.description ? `${q.description}（${q.name}）` : q.name,
    ...(q.description ? { description: q.description } : {}),
    participants: ordered(b.participants),
    items,
    path: q.path,
  };
}

// ---------------------------------------------------------------------------
// Event chain
// ---------------------------------------------------------------------------

function published(steps: StepIR[], out: { event: string; afterCommit: boolean }[] = []) {
  for (const s of steps) {
    if (s.kind === "publish") out.push({ event: s.event, afterCommit: s.afterCommit });
    else if (s.kind === "if") {
      published(s.then, out);
      published(s.else, out);
    }
  }
  return out;
}

/** Actors → use cases → published events → policies → the use cases they run, across contexts. */
export function eventFlow(model: ModelIR): EventFlowGraph {
  const nodes: EventNode[] = [];
  const edges: EventEdge[] = [];
  const has = new Set<string>();
  const node = (n: EventNode) => {
    if (!has.has(n.id)) {
      has.add(n.id);
      nodes.push(n);
    }
    return n.id;
  };
  const ucId = (ctx: string, name: string) => `uc:${ctx}.${name}`;
  const ran = new Set<string>();
  for (const ctx of model.contexts) for (const p of ctx.policies) ran.add(ucId(ctx.name, p.run));
  const consumed = new Set<string>();
  for (const ctx of model.contexts) for (const p of ctx.policies) consumed.add(p.when.includes(".") ? p.when : `${ctx.name}.${p.when}`);

  for (const ctx of model.contexts) {
    for (const u of ctx.useCases) {
      const id = node({ id: ucId(ctx.name, u.name), kind: "use_case", label: u.description ?? u.name, detail: u.name, context: ctx.name, path: u.path, ref: { context: ctx.name, kind: "use_case", name: u.name } });
      if (u.actor && !ran.has(id)) edges.push({ from: node({ id: `actor:${u.actor}`, kind: "actor", label: u.actor }), to: id });
      const seen = new Set<string>();
      for (const p of published(u.steps)) {
        const evKey = `${ctx.name}.${p.event}`;
        const ev = node({ id: `ev:${evKey}`, kind: "event", label: p.event, context: ctx.name, dangling: !consumed.has(evKey), ...(!consumed.has(evKey) ? { detail: "反応するものがない" } : {}) });
        if (seen.has(ev)) continue;
        seen.add(ev);
        edges.push({ from: id, to: ev, label: p.afterCommit ? "コミット後" : "発行", dashed: true });
      }
    }
  }
  for (const ctx of model.contexts) {
    for (const p of ctx.policies) {
      const evKey = p.when.includes(".") ? p.when : `${ctx.name}.${p.when}`;
      const [evCtx, evName] = evKey.split(".") as [string, string];
      const ev = node({ id: `ev:${evKey}`, kind: "event", label: evName, context: evCtx });
      const pol = node({ id: `pol:${ctx.name}.${p.name}`, kind: "policy", label: p.description ?? p.name, detail: p.name, context: ctx.name, path: p.path, ref: { context: ctx.name, kind: "policy", name: p.name } });
      edges.push({ from: ev, to: pol, dashed: true });
      edges.push({ from: pol, to: ucId(ctx.name, p.run), label: Object.keys(p.args).length ? argList(p.args) : undefined });
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/** Text safe inside Mermaid labels (`;` and `#` end statements / start entities). */
function mm(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/#/g, "#35;").replace(/;/g, "#59;").replace(/"/g, "#quot;");
}

const ARROW: Record<SeqMessageStyle, string> = { call: "->>", reply: "-->>", async: "-)", fail: "--x" };

export function sequenceToMermaid(d: SequenceDiagram): string {
  const ids = new Map(d.participants.map((p, i) => [p.id, `p${i}`]));
  const lines = ["sequenceDiagram"];
  for (const p of d.participants) lines.push(`  ${p.kind === "person" ? "actor" : "participant"} ${ids.get(p.id)} as ${mm(p.sub && p.kind !== "person" ? `${p.label}（${p.sub}）` : p.label)}`);
  const write = (items: SeqItem[], depth: number) => {
    const pad = "  ".repeat(depth);
    for (const it of items) {
      if (it.kind === "msg") lines.push(`${pad}${ids.get(it.from)}${ARROW[it.style]}${ids.get(it.to)}: ${mm(it.text)}`);
      else if (it.kind === "note") lines.push(`${pad}Note over ${it.over.map((x) => ids.get(x)).filter(Boolean).join(",")}: ${mm(it.text)}`);
      else {
        it.branches.forEach((br, i) => {
          lines.push(`${pad}${i === 0 ? it.type : "else"} ${mm(br.label)}`);
          write(br.items, depth + 1);
        });
        lines.push(`${pad}end`);
      }
    }
  };
  write(d.items, 1);
  return lines.join("\n") + "\n";
}

export function eventFlowToMermaid(g: EventFlowGraph): string {
  const ids = new Map(g.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["flowchart LR"];
  const shape = (n: EventNode) => {
    const text = mm(n.detail && n.detail !== n.label ? `${n.label}<br/>${n.detail}` : n.label);
    if (n.kind === "actor") return `${ids.get(n.id)}(["${text}"])`;
    if (n.kind === "event") return `${ids.get(n.id)}>"${text}"]`;
    if (n.kind === "policy") return `${ids.get(n.id)}{{"${text}"}}`;
    return `${ids.get(n.id)}["${text}"]`;
  };
  for (const n of g.nodes.filter((x) => !x.context)) lines.push(`  ${shape(n)}`);
  const contexts = [...new Set(g.nodes.flatMap((n) => (n.context ? [n.context] : [])))];
  contexts.forEach((c, i) => {
    lines.push(`  subgraph c${i}["${mm(c)}"]`);
    for (const n of g.nodes.filter((x) => x.context === c)) lines.push(`    ${shape(n)}`);
    lines.push("  end");
  });
  for (const e of g.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    lines.push(`  ${a} ${e.dashed ? "-.->" : "-->"}${e.label ? `|"${mm(e.label)}"|` : ""} ${b}`);
  }
  const dangling = g.nodes.filter((n) => n.dangling).map((n) => ids.get(n.id));
  if (dangling.length) lines.push(`  classDef dangling stroke-dasharray: 4 3`, `  class ${dangling.join(",")} dangling`);
  return lines.join("\n") + "\n";
}

/** The diagrams as one Markdown document (Mermaid blocks) for a review outside the editor. */
export function flowsMarkdown(model: ModelIR, analysis?: Analysis): string {
  const diagrams = flowDiagrams(model, analysis);
  const out: string[] = [`# フロー図 — ${model.project}`, "", "モデルから作った図です（ddd review --flows）。直すときはモデル（.flow）を直してください。", ""];
  out.push("## イベントのつながり", "", "```mermaid", eventFlowToMermaid(diagrams.events).trimEnd(), "```", "");
  for (const [title, list] of [
    ["Use case", diagrams.useCases],
    ["クエリ", diagrams.queries],
  ] as const) {
    if (!list.length) continue;
    out.push(`## ${title}`, "");
    for (const d of list) {
      out.push(`### ${d.ref.context} › ${d.title}`, "", "```mermaid", sequenceToMermaid(d).trimEnd(), "```", "");
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** FNV-1a (32 bit) as 8 hex digits: a short fingerprint of what a reviewer saw. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The content of a diagram without its links into the model (moving an element in the YAML does not change it). */
const content = (v: unknown) => JSON.stringify(v, (k, x: unknown) => (k === "path" ? undefined : x));

/** One "is this flow right?" item of the review: the diagram it is about and the id its answer is stored under. */
export interface FlowReviewTarget {
  /** `flow:<Context>.<name>:<fingerprint>` or `flow:events:<fingerprint>`; a changed diagram gets a new id. */
  id: string;
  diagram: SequenceDiagram | "events";
  title: string;
  element: string;
  path: Path;
}

export function flowReviewTargets(model: ModelIR, diagrams: FlowDiagrams): FlowReviewTarget[] {
  const out: FlowReviewTarget[] = [];
  if (diagrams.events.edges.length) {
    out.push({ id: `flow:events:${fingerprint(content(diagrams.events))}`, diagram: "events", title: "イベントのつながり", element: model.project, path: ["contexts"] });
  }
  for (const d of [...diagrams.useCases, ...diagrams.queries]) {
    out.push({ id: `flow:${d.id}:${fingerprint(content({ participants: d.participants, items: d.items }))}`, diagram: d, title: d.title, element: `${d.ref.context} › ${d.ref.name}`, path: d.path });
  }
  return out;
}
