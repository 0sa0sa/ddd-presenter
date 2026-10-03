import type { TExpr } from "./checker.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { formatPath, type Path } from "./diagnostics.ts";
import type { AggregateIR, AggregateScenarioIR, ContextIR, StepIR, UseCaseScenarioIR } from "./ir.ts";
import { deriveViolations } from "./rulecheck.ts";
import { resolveType, type Type } from "./types.ts";
import { toSnake, walkExpr, type Analysis, type ContextAnalysis } from "./validate.ts";

export type RuleKind = "invariant" | "state_guard";

export interface RuleUsage {
  context: string;
  owner: string;
  rule: string;
  kind: RuleKind;
  expression: string;
  error: string;
  path: Path;
  /** Where the rule is evaluated. */
  appliedBy: { kind: "construct" | "factory" | "operation" | "use_case"; name: string; how: string; path: Path }[];
  /**
   * Scenarios that test the rule: they expect its error, and nothing else on their path can raise that error
   * (no other invariant, guard, `fail` step or `not_found` with the same error class).
   */
  scenarios: { owner: string; name: string; path: Path }[];
  /** Scenarios that expect the rule's error but could get it from another source too; not counted as tests. */
  ambiguous: { owner: string; name: string; path: Path; alsoRaisedBy: string[] }[];
  /** Generated test that builds a violating object from a scenario's values and asserts this rule raised (invariants). */
  derived?: { test: string; from: string; changed: string[] };
  /** Generated test function names that exercise the rule (the scenarios above plus the derived test). */
  tests: string[];
}

/** Name of the generated test that constructs a violating `owner` for invariant `rule` (see rulecheck.ts). */
export function derivedTestName(owner: string, rule: string): string {
  return `test_invariant_${toSnake(owner)}_${rule}`;
}

/** Something on a scenario's path that can raise a domain error. */
interface Source {
  error: string;
  /** "Owner.rule" for invariants and guards. */
  rule?: string;
  label: string;
}

/**
 * Traceability: for every named rule, where it is applied and which scenarios test it.
 *
 * Crediting is deliberately conservative. A scenario only says which error class it expects, so it counts as a test
 * of a rule only when that rule is the single thing on the scenario's path that can raise this error class. If two
 * rules share an error (or a `fail` step raises it too), the scenario is listed as ambiguous instead: passing it does
 * not show which rule fired. Invariants can additionally be covered by a derived violating-example test.
 */
export function ruleUsage(analysis: Analysis): RuleUsage[] {
  const out: RuleUsage[] = [];
  for (const [ctxName, ca] of analysis.contexts) {
    const ctx = ca.ir;
    const credit = scenarioCredit(ca);
    const derived = new Map(deriveViolations(ca).map((d) => [`${d.owner}.${d.rule}`, d]));
    const push = (u: Omit<RuleUsage, "scenarios" | "ambiguous" | "tests" | "derived">) => {
      const key = `${u.owner}.${u.rule}`;
      const c = credit.get(key) ?? { scenarios: [], ambiguous: [] };
      const d = u.kind === "invariant" ? derived.get(key) : undefined;
      const dt = d ? { test: derivedTestName(d.owner, d.rule), from: d.from, changed: d.changed } : undefined;
      out.push({ ...u, scenarios: c.scenarios, ambiguous: c.ambiguous, ...(dt ? { derived: dt } : {}), tests: [...c.scenarios.map((s) => `test_${s.name}`), ...(dt ? [dt.test] : [])] });
    };
    for (const vo of ctx.valueObjects) {
      for (const inv of vo.invariants) {
        push({ context: ctxName, owner: vo.name, rule: inv.name, kind: "invariant", expression: inv.expression, error: inv.error, path: inv.path, appliedBy: [{ kind: "construct", name: vo.name, how: "every instantiation", path: vo.path }] });
      }
    }
    for (const ag of ctx.aggregates) {
      const owners = [ag, ...ag.entities];
      for (const owner of owners) {
        for (const inv of owner.invariants) {
          const appliedBy: RuleUsage["appliedBy"] = [];
          if (inv.checkOn.includes("construct")) appliedBy.push({ kind: "construct", name: owner.name, how: "every instantiation", path: owner.path });
          if (owner === ag) {
            for (const f of ag.factories) appliedBy.push({ kind: "factory", name: f.name, how: "on creation", path: f.path });
            for (const op of ag.operations) {
              if (inv.checkOn.includes("transition") || inv.checkOn.includes("construct")) {
                appliedBy.push({ kind: "operation", name: op.name, how: "after transition (candidate state)", path: op.path });
              }
            }
          }
          push({ context: ctxName, owner: owner.name, rule: inv.name, kind: "invariant", expression: inv.expression, error: inv.error, path: inv.path, appliedBy });
        }
      }
      for (const g of ag.stateGuards) {
        const appliedBy: RuleUsage["appliedBy"] = [];
        for (const op of ag.operations) {
          op.require.forEach((_, i) => {
            const e = ca.exprs.get(formatPath([...op.path, "require", i]));
            if (e?.t === "guard" && e.guard === g.name) appliedBy.push({ kind: "operation", name: op.name, how: "require (automatic assert_holds)", path: [...op.path, "require", i] });
          });
        }
        for (const uc of ctx.useCases) {
          visitSteps(uc.steps, (s) => {
            const paths: Path[] = [];
            if (s.kind === "if") paths.push([...s.path, "condition"]);
            if (s.kind === "return") paths.push(s.path);
            if (s.kind === "invoke" || s.kind === "create") for (const k of Object.keys(s.args)) paths.push([...s.path, "args", k]);
            for (const p of paths) {
              const e = ca.exprs.get(formatPath(p));
              if (e && usesGuard(e, ag.name, g.name)) appliedBy.push({ kind: "use_case", name: uc.name, how: "condition (checks)", path: p });
            }
          });
        }
        push({ context: ctxName, owner: ag.name, rule: g.name, kind: "state_guard", expression: g.expression, error: g.error, path: g.path, appliedBy });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which rule does a scenario test?
// ---------------------------------------------------------------------------

type Credit = Map<string, { scenarios: RuleUsage["scenarios"]; ambiguous: RuleUsage["ambiguous"] }>;

function scenarioCredit(ca: ContextAnalysis): Credit {
  const ctx = ca.ir;
  const credit: Credit = new Map();
  const entry = (key: string) => {
    if (!credit.has(key)) credit.set(key, { scenarios: [], ambiguous: [] });
    return credit.get(key)!;
  };
  const judge = (owner: string, sc: AggregateScenarioIR | UseCaseScenarioIR, sources: Source[]) => {
    const error = sc.then.raises;
    if (!error) return;
    const same = dedupe(sources.filter((s) => s.error === error));
    const rules = same.filter((s) => s.rule);
    if (same.length === 1 && rules.length === 1) {
      entry(rules[0]!.rule!).scenarios.push({ owner, name: sc.name, path: sc.path });
      return;
    }
    for (const r of rules) {
      entry(r.rule!).ambiguous.push({ owner, name: sc.name, path: sc.path, alsoRaisedBy: same.filter((s) => s !== r).map((s) => s.label) });
    }
  };
  for (const ag of ctx.aggregates) {
    for (const sc of ag.scenarios) judge(ag.name, sc, aggregateScenarioSources(ctx, ag, sc));
  }
  for (const uc of ctx.useCases) {
    const vars = new Map<string, string>();
    visitSteps(uc.steps, (s) => {
      if (s.kind === "load" || s.kind === "create") vars.set(s.as, s.aggregate);
    });
    const sources: Source[] = [];
    visitSteps(uc.steps, (s) => {
      if (s.kind === "load") sources.push({ error: s.notFound ?? "AggregateNotFound", label: `load ${s.as} (not found)` });
      if (s.kind === "fail") sources.push({ error: s.error, label: `fail step in ${uc.name}` });
      const ag = ctx.aggregates.find((a) => a.name === (s.kind === "create" ? s.aggregate : s.kind === "invoke" ? vars.get(s.target) : undefined));
      if (!ag) return;
      if (s.kind === "create") sources.push(...memberSources(ctx, ag, "factory", s.factory));
      if (s.kind === "invoke") sources.push(...memberSources(ctx, ag, "operation", s.operation));
    });
    for (const sc of uc.scenarios) judge(uc.name, sc, sources);
  }
  return credit;
}

function aggregateScenarioSources(ctx: ContextIR, ag: AggregateIR, sc: AggregateScenarioIR): Source[] {
  const w = sc.when;
  if (w.kind === "construct") return constructSources(ctx, { k: "aggregate", name: ag.name }, new Set());
  return memberSources(ctx, ag, w.kind, w.kind === "operation" ? w.operation : w.factory);
}

/** Everything a factory or operation call can raise: guards, invariants of the result, and of value-object arguments. */
function memberSources(ctx: ContextIR, ag: AggregateIR, kind: "factory" | "operation", name: string): Source[] {
  const member = kind === "operation" ? ag.operations.find((o) => o.name === name) : ag.factories.find((f) => f.name === name);
  if (!member) return [];
  const out: Source[] = [];
  if (kind === "operation") {
    for (const req of member.require) {
      const g = ag.stateGuards.find((x) => x.name === req.split("(")[0]!.trim());
      if (g) out.push({ error: g.error, rule: `${ag.name}.${g.name}`, label: `state guard ${g.name}` });
    }
    for (const inv of ag.invariants) if (!inv.checkOn.includes("construct")) out.push({ error: inv.error, rule: `${ag.name}.${inv.name}`, label: `invariant ${inv.name}` });
  }
  // The new state is validated as a whole, but nested objects it keeps are not re-validated (only arguments are new).
  out.push(...constructSources(ctx, { k: "aggregate", name: ag.name }, new Set(), false));
  for (const p of member.parameters) {
    const r = resolveType(p.type, { context: ctx, aggregate: ag.name });
    if (r.ok) out.push(...constructSources(ctx, r.type, new Set()));
  }
  return out;
}

/** Construct-time invariants of a type and (when `nested`) of every value object / entity it can contain. */
function constructSources(ctx: ContextIR, t: Type, seen: Set<string>, nested = true): Source[] {
  if (t.k === "optional") return constructSources(ctx, t.inner, seen, nested);
  if (t.k === "list") return constructSources(ctx, t.item, seen, nested);
  if ((t.k !== "vo" && t.k !== "entity" && t.k !== "aggregate") || seen.has(t.name)) return [];
  seen.add(t.name);
  const owner =
    t.k === "vo" ? ctx.valueObjects.find((v) => v.name === t.name) : ctx.aggregates.flatMap((a) => [a, ...a.entities]).find((o) => o.name === t.name);
  if (!owner) return [];
  const aggregate = t.k === "entity" ? t.aggregate : t.k === "aggregate" ? t.name : undefined;
  const out: Source[] = owner.invariants.filter((i) => i.checkOn.includes("construct")).map((i) => ({ error: i.error, rule: `${owner.name}.${i.name}`, label: `invariant ${i.name}` }));
  if (!nested) return out;
  for (const f of owner.fields) {
    const r = resolveType(f.type, { context: ctx, aggregate });
    if (r.ok) out.push(...constructSources(ctx, r.type, seen));
  }
  return out;
}

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = s.rule ?? s.label;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Coverage diagnostics (ddd validate --strict)
// ---------------------------------------------------------------------------

/**
 * Gaps a strict review cares about but an editor should not nag about: rules nothing tests, errors nothing raises and
 * extension points nothing calls. `locate` adds line/column (from the parse result of the same text).
 */
export function coverageDiagnostics(analysis: Analysis, locate?: (path: Path) => { line: number; column: number } | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (d: Diagnostic) => out.push({ ...d, ...(locate?.(d.path) ?? {}) });
  for (const u of ruleUsage(analysis)) {
    if (u.tests.length) continue;
    const amb = u.ambiguous[0];
    at({
      severity: "warning",
      code: "untested-rule",
      message: `${u.kind === "invariant" ? "Invariant" : "State guard"} ${u.rule} of ${u.owner} is not exercised by any scenario`,
      path: [...u.path, "name"],
      element: `${u.context} › ${u.owner} › ${u.rule}`,
      hint: amb
        ? `Scenario ${amb.name} expects ${u.error}, but ${amb.alsoRaisedBy.join(", ")} can raise it too; give the rule its own error so the scenario shows which rule fired`
        : `Add a scenario that violates it and expects ${u.error}`,
    });
  }
  for (const [ctxName, ca] of analysis.contexts) {
    const ctx = ca.ir;
    const raised = new Set<string>();
    for (const o of [...ctx.valueObjects, ...ctx.aggregates.flatMap((a) => [a, ...a.entities])]) for (const i of o.invariants) raised.add(i.error);
    for (const ag of ctx.aggregates) for (const g of ag.stateGuards) raised.add(g.error);
    for (const uc of ctx.useCases) {
      visitSteps(uc.steps, (s) => {
        if (s.kind === "fail") raised.add(s.error);
        if (s.kind === "load" && s.notFound) raised.add(s.notFound);
      });
    }
    for (const e of ctx.errors) {
      if (raised.has(e.name)) continue;
      at({
        severity: "warning",
        code: "unused-error",
        message: `Error ${e.name} is never raised (no rule, fail step or not_found uses it)`,
        path: [...e.path, "name"],
        element: `${ctxName} › ${e.name}`,
        hint: "Attach it to the rule it belongs to, or remove it",
      });
    }
    const called = new Set([...ca.useCases.values()].flatMap((i) => i.extensions));
    for (const x of ctx.extensionPoints) {
      if (called.has(x.name)) continue;
      at({
        severity: "warning",
        code: "unused-extension-point",
        message: `Extension point ${x.name} is never called by a use case`,
        path: [...x.path, "name"],
        element: `${ctxName} › ${x.name}`,
        hint: "Call it from a use case condition or argument, or remove it (customers would implement it for nothing)",
      });
    }
  }
  return out;
}

function usesGuard(e: TExpr, aggregate: string, guard: string): boolean {
  let found = false;
  walkExpr(e, (n) => {
    if (n.t === "guard" && n.aggregate === aggregate && n.guard === guard) found = true;
  });
  return found;
}

export function visitSteps(steps: StepIR[], fn: (s: StepIR) => void): void {
  for (const s of steps) {
    fn(s);
    if (s.kind === "if") {
      visitSteps(s.then, fn);
      visitSteps(s.else, fn);
    }
  }
}
