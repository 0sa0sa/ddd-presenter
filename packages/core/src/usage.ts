import type { TExpr } from "./checker.ts";
import { formatPath, type Path } from "./diagnostics.ts";
import type { StepIR } from "./ir.ts";
import { walkExpr, type Analysis } from "./validate.ts";

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
  /** Scenarios that exercise the rule's error. */
  scenarios: { owner: string; name: string; path: Path }[];
  /** Generated test function names that exercise the rule. */
  tests: string[];
}

/** Traceability: for every named rule, where it is applied and which scenarios test it. */
export function ruleUsage(analysis: Analysis): RuleUsage[] {
  const out: RuleUsage[] = [];
  for (const [ctxName, ca] of analysis.contexts) {
    const ctx = ca.ir;
    const scenariosRaising = (error: string) => [
      ...ctx.aggregates.flatMap((a) => a.scenarios.filter((s) => s.then.raises === error).map((s) => ({ owner: a.name, name: s.name, path: s.path }))),
      ...ctx.useCases.flatMap((u) => u.scenarios.filter((s) => s.then.raises === error).map((s) => ({ owner: u.name, name: s.name, path: s.path }))),
    ];
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
          const scenarios = scenariosRaising(inv.error);
          out.push({
            context: ctxName,
            owner: owner.name,
            rule: inv.name,
            kind: "invariant",
            expression: inv.expression,
            error: inv.error,
            path: inv.path,
            appliedBy,
            scenarios,
            tests: scenarios.map((s) => `test_${s.name}`),
          });
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
        const scenarios = scenariosRaising(g.error);
        out.push({
          context: ctxName,
          owner: ag.name,
          rule: g.name,
          kind: "state_guard",
          expression: g.expression,
          error: g.error,
          path: g.path,
          appliedBy,
          scenarios,
          tests: scenarios.map((s) => `test_${s.name}`),
        });
      }
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
