/**
 * State machines of aggregates (docs/09 §27): an enum field of the root that factories and operations set is a
 * state field. Its states are the enum values; factories give the initial states, and each operation moves from the
 * states its `require` guards allow to the value its `changes` sets. Everything is derived from the model; nothing
 * new is written in the DSL.
 *
 * Guards are evaluated per state with three-valued logic: only the state field is known, every other field and
 * parameter is unknown, so a guard is "never true in this state" only when it is false whatever the rest is.
 */
import type { TExpr } from "./checker.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { formatPath } from "./diagnostics.ts";
import type { AggregateIR, ContextIR, EnumIR } from "./ir.ts";
import type { Analysis, ContextAnalysis } from "./validate.ts";

export interface StateTransition {
  /** The operation. */
  operation: string;
  /** States the operation may run in (its guards are not definitely false there). */
  from: string[];
  /** Of `from`, the states where it runs only if the rest of its guards holds (other fields, parameters, time). */
  conditional: string[];
  /** States it may leave the aggregate in (the same state when it does not change the field). */
  to: string[];
  /** The operation has no guard that limits it to some states. */
  unguarded: boolean;
  /** The operation does not set the state field (it stays in the state it runs in). */
  keepsState: boolean;
}

export interface StateMachine {
  context: string;
  aggregate: string;
  field: string;
  enumName: string;
  states: string[];
  /** States a factory creates the aggregate in; every state when a factory takes it from a parameter. */
  initial: string[];
  /** The aggregate has factories (without one, any state may come from outside, so reachability is not checked). */
  hasFactory: boolean;
  transitions: StateTransition[];
  /** States reachable from the initial ones (all states without a factory). */
  reachable: string[];
  /** Reachable states no operation leaves (an operation that keeps the state does not count). */
  terminal: string[];
  /** States no factory creates and no operation reaches. */
  unreachable: string[];
  /** Operations whose guards are false in every reachable state. */
  neverEnabled: string[];
  /** YAML path of the state field. */
  path: (string | number)[];
}

/** Every aggregate state machine of the model, context by context. */
export function stateMachines(analysis: Analysis): StateMachine[] {
  return [...analysis.contexts.values()].flatMap((ca) => ca.ir.aggregates.flatMap((ag) => aggregateStateMachines(ca, ag)));
}

export function aggregateStateMachines(ca: ContextAnalysis, ag: AggregateIR): StateMachine[] {
  const ctx = ca.ir;
  const out: StateMachine[] = [];
  for (const field of ag.fields) {
    const en = enumOf(ctx, field.type);
    if (!en || field.name === ag.identity) continue;
    const setBy = [...ag.factories.filter((f) => field.name in f.fields), ...ag.operations.filter((o) => field.name in o.changes)];
    if (!setBy.length) continue;
    const states = en.values;
    const initial = new Set<string>();
    for (const f of ag.factories) {
      const e = ca.exprs.get(formatPath([...f.path, "fields", field.name]));
      for (const v of targets(e, states)) initial.add(v);
    }
    // `to` undefined: the operation keeps the state it runs in.
    const raw = ag.operations.map((op) => {
      const guards = op.require.map((_, i) => ca.exprs.get(formatPath([...op.path, "require", i]))).filter((e): e is TExpr => !!e);
      const verdicts = states.map((s) => ({ s, v: guards.map((g) => evalInState(g, field.name, s, ca, ag, 0)) }));
      const from = verdicts.filter((x) => !x.v.includes(false)).map((x) => x.s);
      const conditional = verdicts.filter((x) => !x.v.includes(false) && x.v.includes(undefined)).map((x) => x.s);
      const to = field.name in op.changes ? targets(ca.exprs.get(formatPath([...op.path, "changes", field.name])), states) : undefined;
      return { operation: op.name, from, conditional, to };
    });
    const hasFactory = ag.factories.length > 0;
    const reachable = new Set<string>(hasFactory ? initial : states);
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of raw) {
        if (!t.to || !t.from.some((s) => reachable.has(s))) continue;
        for (const s of t.to) {
          if (!reachable.has(s)) {
            reachable.add(s);
            changed = true;
          }
        }
      }
    }
    const transitions: StateTransition[] = raw.map((t) => ({
      operation: t.operation,
      from: t.from,
      conditional: t.conditional,
      to: t.to ?? t.from.filter((s) => reachable.has(s)),
      unguarded: t.from.length === states.length,
      keepsState: !t.to,
    }));
    const leaves = (s: string) => transitions.some((t) => !t.keepsState && t.from.includes(s) && t.to.some((x) => x !== s));
    out.push({
      context: ctx.name,
      aggregate: ag.name,
      field: field.name,
      enumName: en.name,
      states,
      initial: states.filter((s) => initial.has(s)),
      hasFactory,
      transitions,
      reachable: states.filter((s) => reachable.has(s)),
      terminal: states.filter((s) => reachable.has(s) && !leaves(s)),
      unreachable: states.filter((s) => !reachable.has(s)),
      neverEnabled: transitions.filter((t) => !t.from.some((s) => reachable.has(s))).map((t) => t.operation),
      path: field.path,
    });
  }
  return out;
}

function enumOf(ctx: ContextIR, type: string): EnumIR | undefined {
  return ctx.enums.find((e) => e.name === type.trim());
}

/** The states an assigned expression may produce: the literal, else (a parameter, a condition, …) any state. */
function targets(e: TExpr | undefined, states: string[]): string[] {
  if (!e) return [];
  if (e.t === "enumValue") return states.includes(e.value) ? [e.value] : [];
  return states;
}

/**
 * A boolean expression with the state field set to `state` and nothing else known: true, false, or undefined
 * (depends on other fields, parameters, the clock, …). Guards called by name are evaluated through their body.
 */
function evalInState(e: TExpr, field: string, state: string, ca: ContextAnalysis, ag: AggregateIR, depth: number): boolean | undefined {
  switch (e.t) {
    case "lit":
      return typeof e.value === "boolean" ? e.value : undefined;
    case "not": {
      const v = evalInState(e.operand, field, state, ca, ag, depth);
      return v === undefined ? undefined : !v;
    }
    case "guard": {
      if (e.receiver || e.aggregate !== ag.name || depth > 8) return undefined;
      const g = ag.stateGuards.find((x) => x.name === e.guard);
      const body = g && ca.exprs.get(formatPath([...g.path, "expression"]));
      return body ? evalInState(body, field, state, ca, ag, depth + 1) : undefined;
    }
    case "binary": {
      if (e.op === "and" || e.op === "or") {
        const l = evalInState(e.left, field, state, ca, ag, depth);
        const r = evalInState(e.right, field, state, ca, ag, depth);
        if (e.op === "and") return l === false || r === false ? false : l === true && r === true ? true : undefined;
        return l === true || r === true ? true : l === false && r === false ? false : undefined;
      }
      if (e.op !== "==" && e.op !== "!=") return undefined;
      const l = stateValue(e.left, field, state);
      const r = stateValue(e.right, field, state);
      if (l === undefined || r === undefined) return undefined;
      return e.op === "==" ? l === r : l !== r;
    }
    default:
      return undefined;
  }
}

/** The value of the state field or an enum literal; undefined for anything else. */
function stateValue(e: TExpr, field: string, state: string): string | undefined {
  if (e.t === "field" && !e.owner && e.name === field) return state;
  if (e.t === "enumValue") return e.value;
  return undefined;
}

/** Warnings for states nothing reaches and operations that can never run (docs/10 §3). */
export function stateMachineDiagnostics(analysis: Analysis): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const sm of stateMachines(analysis)) {
    if (!sm.hasFactory) continue;
    const ag = analysis.contexts.get(sm.context)!.ir.aggregates.find((a) => a.name === sm.aggregate)!;
    const element = `${sm.context} › ${sm.aggregate} › ${sm.field}`;
    for (const s of sm.unreachable) {
      out.push({
        severity: "warning",
        code: "unreachable-state",
        message: `${sm.aggregate}.${sm.field} can never become ${s}: no factory creates it and no operation changes it to ${s}`,
        path: [...sm.path, "type"],
        element,
        hint: `Add an operation that sets ${sm.field}: ${s}, or remove ${s} from ${sm.enumName} if it is not a real state`,
      });
    }
    for (const name of sm.neverEnabled) {
      const op = ag.operations.find((o) => o.name === name)!;
      const t = sm.transitions.find((x) => x.operation === name)!;
      out.push({
        severity: "warning",
        code: "never-enabled-operation",
        message: t.from.length
          ? `Operation ${name} can only run when ${sm.field} is ${t.from.join(" or ")}, which ${sm.aggregate} never reaches`
          : `Operation ${name} can never run: its guards are false for every ${sm.field}`,
        path: [...op.path, "require"],
        element: `${sm.context} › ${sm.aggregate} › ${name}`,
        hint: `Reachable ${sm.field} values: ${sm.reachable.join(", ") || "none"}`,
      });
    }
  }
  return out;
}
