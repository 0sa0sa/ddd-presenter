/**
 * What an edit changes in the model's behaviour, not its text (docs/09 §29): answers of the review questions that
 * flip, states and transitions that change, and — flagged as `weakens` — changes that make the model accept more:
 * a removed invariant, guard, scenario or expected error, a looser constraint, a wider authorization.
 *
 * An edit made to get past a check (by an AI or a person) usually weakens the check itself; listing those first,
 * next to the diff, is how a reviewer catches it ("which inputs does this change accept that were refused before?").
 */
import type { Path } from "./diagnostics.ts";
import type { AggregateIR, AuthorizeIR, Constraints, ContextIR, FieldIR, InvariantIR, ModelIR, UseCaseIR } from "./ir.ts";
import { reviewQuestions, type ModelAnswer } from "./review.ts";
import { stateMachines } from "./statemachine.ts";
import type { Analysis } from "./validate.ts";

export type BehaviorChangeKind = "answer" | "invariant" | "guard" | "scenario" | "constraint" | "access" | "lifecycle";

export interface BehaviorChange {
  kind: BehaviorChangeKind;
  /** The change makes the model accept something it refused before (or check less). */
  weakens: boolean;
  /** What changes, in Japanese. */
  text: string;
  /** `Context › Element`. */
  element: string;
  /** YAML path in the changed model (absent when the element was removed). */
  path?: Path;
}

const ANSWER: Record<ModelAnswer, string> = { yes: "はい", no: "いいえ", undefined: "モデルにない" };

/** Behaviour changes from `before` to `after`, the weakening ones first. */
export function behaviorChanges(before: Analysis, after: Analysis): BehaviorChange[] {
  const out: BehaviorChange[] = [];
  const add = (c: BehaviorChange) => out.push(c);
  for (const ctxB of before.model.contexts) {
    const ctxA = after.model.contexts.find((c) => c.name === ctxB.name);
    if (!ctxA) {
      add({ kind: "invariant", weakens: true, text: `コンテキスト ${ctxB.name} がなくなる（その中のルールもすべて）。`, element: ctxB.name });
      continue;
    }
    contextChanges(ctxB, ctxA, add);
  }
  securityChanges(before.model, after.model, add);
  lifecycleChanges(before, after, add);
  answerChanges(before, after, add);
  return out.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c.weakens) - Number(a.c.weakens) || a.i - b.i).map((x) => x.c);
}

type Add = (c: BehaviorChange) => void;
const el = (...names: string[]) => names.join(" › ");

function contextChanges(b: ContextIR, a: ContextIR, add: Add): void {
  const owners = (c: ContextIR) => [...c.valueObjects, ...c.aggregates.flatMap((x) => [x, ...x.entities])];
  for (const ob of owners(b)) {
    const oa = owners(a).find((x) => x.name === ob.name);
    if (!oa) {
      if (ob.invariants.length) add({ kind: "invariant", weakens: true, text: `${ob.name} がなくなり、その Invariant（${ob.invariants.map((i) => i.name).join("・")}）も確かめなくなる。`, element: el(b.name, ob.name) });
      continue;
    }
    invariantChanges(b.name, ob.name, ob.invariants, oa.invariants, add);
    fieldChanges(b.name, ob.name, ob.fields, oa.fields, add);
  }
  for (const agB of b.aggregates) {
    const agA = a.aggregates.find((x) => x.name === agB.name);
    if (!agA) continue;
    guardChanges(b.name, agB, agA, add);
    scenarioChanges(b.name, agB.name, agB.scenarios, agA.scenarios, add);
    if (agB.authorize && agA.authorize) authorizeChanges(el(b.name, agB.name, "読み取り"), agB.authorize, agA.authorize, add, agA.path);
  }
  for (const ucB of b.useCases) {
    const ucA = a.useCases.find((x) => x.name === ucB.name);
    if (!ucA) continue;
    useCaseChanges(b.name, ucB, ucA, add);
  }
}

function invariantChanges(ctx: string, owner: string, b: InvariantIR[], a: InvariantIR[], add: Add): void {
  for (const ib of b) {
    const ia = a.find((x) => x.name === ib.name);
    if (!ia) add({ kind: "invariant", weakens: true, text: `${owner} の Invariant ${ib.name}（${ib.expression}）がなくなる。破っても ${ib.error} にならない。`, element: el(ctx, owner, ib.name) });
    else if (ia.expression.trim() !== ib.expression.trim())
      add({ kind: "invariant", weakens: true, text: `${owner} の Invariant ${ib.name} の式が変わる: ${ib.expression} → ${ia.expression}（緩くなっていないか確かめる）。`, element: el(ctx, owner, ib.name), path: ia.path });
    else if (ib.checkOn.some((t) => !ia.checkOn.includes(t)))
      add({ kind: "invariant", weakens: true, text: `${owner} の Invariant ${ib.name} を確かめる時が減る: ${ib.checkOn.join("・")} → ${ia.checkOn.join("・")}。`, element: el(ctx, owner, ib.name), path: ia.path });
  }
  for (const ia of a) if (!b.some((x) => x.name === ia.name)) add({ kind: "invariant", weakens: false, text: `${owner} に Invariant ${ia.name}（${ia.expression}）が加わる。`, element: el(ctx, owner, ia.name), path: ia.path });
}

const LOOSER: [keyof Constraints, "min" | "max"][] = [
  ["min", "min"],
  ["max", "max"],
  ["min_length", "min"],
  ["max_length", "max"],
  ["min_items", "min"],
  ["max_items", "max"],
  ["max_digits", "max"],
  ["decimal_places", "max"],
];

function fieldChanges(ctx: string, owner: string, b: FieldIR[], a: FieldIR[], add: Add): void {
  for (const fb of b) {
    const fa = a.find((x) => x.name === fb.name);
    if (!fa) continue;
    const where = el(ctx, owner, fb.name);
    if (fb.required && !fa.required) add({ kind: "constraint", weakens: true, text: `${owner}.${fb.name} が必須でなくなる（空を受け付ける）。`, element: where, path: fa.path });
    for (const [key, side] of LOOSER) {
      const vb = fb.constraints[key] as number | undefined;
      const va = fa.constraints[key] as number | undefined;
      if (vb === undefined || vb === va) continue;
      const looser = va === undefined || (side === "min" ? va < vb : va > vb);
      add({ kind: "constraint", weakens: looser, text: `${owner}.${fb.name} の ${key} が変わる: ${vb} → ${va ?? "なし"}。`, element: where, path: fa.path });
    }
    if (fb.constraints.pattern && fb.constraints.pattern !== fa.constraints.pattern)
      add({ kind: "constraint", weakens: true, text: `${owner}.${fb.name} の pattern が変わる: ${fb.constraints.pattern} → ${fa.constraints.pattern ?? "なし"}。`, element: where, path: fa.path });
  }
}

function guardChanges(ctx: string, b: AggregateIR, a: AggregateIR, add: Add): void {
  for (const gb of b.stateGuards) {
    const ga = a.stateGuards.find((x) => x.name === gb.name);
    if (ga && ga.expression.trim() !== gb.expression.trim())
      add({ kind: "guard", weakens: true, text: `${b.name} の State guard ${gb.name} の式が変わる: ${gb.expression} → ${ga.expression}（緩くなっていないか確かめる）。`, element: el(ctx, b.name, gb.name), path: ga.path });
  }
  for (const ob of b.operations) {
    const oa = a.operations.find((x) => x.name === ob.name);
    if (!oa) continue;
    const norm = (r: string) => r.replace(/\s+/g, "");
    for (const r of ob.require) if (!oa.require.map(norm).includes(norm(r))) add({ kind: "guard", weakens: true, text: `${b.name}.${ob.name} の require から ${r} がなくなる（その条件を満たさなくてもできる）。`, element: el(ctx, b.name, ob.name), path: oa.path });
    for (const r of oa.require) if (!ob.require.map(norm).includes(norm(r))) add({ kind: "guard", weakens: false, text: `${b.name}.${ob.name} の require に ${r} が加わる。`, element: el(ctx, b.name, ob.name), path: oa.path });
  }
  for (const fb of b.factories) {
    const fa = a.factories.find((x) => x.name === fb.name);
    if (!fa) continue;
    for (const r of fb.require) if (!fa.require.includes(r)) add({ kind: "guard", weakens: true, text: `${b.name}.${fb.name}（Factory）の require から ${r} がなくなる。`, element: el(ctx, b.name, fb.name), path: fa.path });
  }
}

function scenarioChanges(ctx: string, owner: string, b: { name: string; then: { raises?: string } }[], a: { name: string; then: { raises?: string }; path: Path }[], add: Add): void {
  for (const sb of b) {
    const sa = a.find((x) => x.name === sb.name);
    if (!sa) {
      add({ kind: "scenario", weakens: true, text: `${owner} のシナリオ ${sb.name}${sb.then.raises ? `（${sb.then.raises} になること）` : ""}がなくなる。生成するテストからも消える。`, element: el(ctx, owner, sb.name) });
      continue;
    }
    if (sb.then.raises && sa.then.raises !== sb.then.raises)
      add({ kind: "scenario", weakens: true, text: `${owner} のシナリオ ${sb.name} の期待が変わる: ${sb.then.raises} になる → ${sa.then.raises ? `${sa.then.raises} になる` : "成功する"}。`, element: el(ctx, owner, sb.name), path: sa.path });
  }
}

function authorizeChanges(where: string, b: AuthorizeIR, a: AuthorizeIR, add: Add, path?: Path): void {
  const rank = { internal: 0, principal: 1, public: 2 } as const;
  if (rank[a.kind] > rank[b.kind]) add({ kind: "access", weakens: true, text: `${where} の公開範囲が広がる: ${b.kind} → ${a.kind}。`, element: where, ...(path ? { path } : {}) });
  if (b.kind === "principal" && a.kind === "principal") {
    const roles = a.roles.filter((r) => !b.roles.includes(r));
    // An empty role list admits every authenticated principal.
    if (b.roles.length && !a.roles.length) add({ kind: "access", weakens: true, text: `${where} をロールに関係なく（ログインした人なら）実行できるようになる。`, element: where, ...(path ? { path } : {}) });
    else if (roles.length) add({ kind: "access", weakens: true, text: `${where} を実行できるロールが増える: ${roles.join("・")}。`, element: where, ...(path ? { path } : {}) });
    const perms = (a.permissions ?? []).filter((p) => !(b.permissions ?? []).includes(p));
    if (perms.length) add({ kind: "access", weakens: true, text: `${where} を許す権限が増える: ${perms.join("・")}。`, element: where, ...(path ? { path } : {}) });
    if (b.allowIf && a.allowIf?.trim() !== b.allowIf.trim()) add({ kind: "access", weakens: true, text: `${where} の allow_if が変わる: ${b.allowIf} → ${a.allowIf ?? "なし"}。`, element: where, ...(path ? { path } : {}) });
  }
}

function useCaseChanges(ctx: string, b: UseCaseIR, a: UseCaseIR, add: Add): void {
  if (b.authorize && a.authorize) authorizeChanges(el(ctx, b.name), b.authorize, a.authorize, add, a.path);
  const fails = (uc: UseCaseIR) => JSON.stringify(uc.steps).match(/"kind":"fail","error":"\w+"/g) ?? [];
  const fb = fails(b);
  const fa = fails(a);
  for (const f of new Set(fb)) {
    const count = (xs: string[]) => xs.filter((x) => x === f).length;
    if (count(fa) < count(fb)) add({ kind: "guard", weakens: true, text: `${b.name} の手順から fail ${/"error":"(\w+)"/.exec(f)![1]} が減る（その場合も止まらずに進む）。`, element: el(ctx, b.name), path: a.path });
  }
  scenarioChanges(ctx, b.name, b.scenarios, a.scenarios, add);
}

function securityChanges(b: ModelIR, a: ModelIR, add: Add): void {
  if (b.security && !a.security) add({ kind: "access", weakens: true, text: "security（認証・認可）がなくなる。", element: "security" });
  if (b.security?.tenancy && a.security && !a.security.tenancy) add({ kind: "access", weakens: true, text: "組織（テナント）の分離がなくなる。", element: "security › tenancy" });
  if (b.security?.tenancy?.rls && a.security?.tenancy && !a.security.tenancy.rls) add({ kind: "access", weakens: true, text: "行レベルセキュリティ（RLS）がなくなる。", element: "security › tenancy" });
}

function lifecycleChanges(before: Analysis, after: Analysis, add: Add): void {
  const ma = stateMachines(after);
  for (const sb of stateMachines(before)) {
    const sa = ma.find((m) => m.context === sb.context && m.aggregate === sb.aggregate && m.field === sb.field);
    if (!sa) continue;
    const where = el(sb.context, sb.aggregate, sb.field);
    for (const tb of sb.transitions) {
      const ta = sa.transitions.find((t) => t.operation === tb.operation);
      if (!ta) continue;
      const gained = ta.from.filter((s) => !tb.from.includes(s) && sa.reachable.includes(s));
      const lost = tb.from.filter((s) => !ta.from.includes(s) && sb.reachable.includes(s));
      if (gained.length) add({ kind: "lifecycle", weakens: true, text: `${tb.operation} が「${gained.join("・")}」の ${sb.aggregate} でもできるようになる。`, element: where });
      if (lost.length) add({ kind: "lifecycle", weakens: false, text: `${tb.operation} が「${lost.join("・")}」の ${sb.aggregate} ではできなくなる。`, element: where });
    }
    const newly = sa.reachable.filter((s) => !sb.reachable.includes(s));
    if (newly.length) add({ kind: "lifecycle", weakens: false, text: `${sb.aggregate} が「${newly.join("・")}」になれるようになる。`, element: where });
  }
}

function answerChanges(before: Analysis, after: Analysis, add: Add): void {
  const qa = new Map(reviewQuestions(after).map((q) => [q.id, q]));
  for (const qb of reviewQuestions(before)) {
    const q = qa.get(qb.id);
    // Lifecycle answers repeat the transitions above; flow and proof ids change with the content anyway.
    if (!q || q.modelAnswer === qb.modelAnswer || q.category === "flows" || q.category === "proofs" || q.category === "lifecycle") continue;
    add({ kind: "answer", weakens: false, text: `「${q.text}」へのモデルの答えが変わる: ${ANSWER[qb.modelAnswer]} → ${ANSWER[q.modelAnswer]}。`, element: q.element, path: q.path });
  }
}
