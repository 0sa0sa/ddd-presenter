/**
 * Property tests of the aggregates (`generation.property_tests`, docs/09 §29): Hypothesis runs random sequences of
 * factories and operations with random arguments. Every call must either succeed or raise one of the domain errors
 * the model declares for it (its guards' errors, the invariants it can break, ConstraintViolation); a crash or another
 * error fails. It is the generated code's counterpart of the proofs: a fuzz test whose specification is the model.
 */
import { exprChildren, formatPath, type AggregateIR, type Constraints, type FactoryIR, type OperationIR, type TExpr, type Type } from "@ddd/core";

import { paramTypes, type PyFile } from "./domain.ts";
import { assemble, type Layout } from "./layout.ts";
import { securityModule } from "./security.ts";
import { Code, Imports, pascal, pyString } from "./support.ts";
import { defaultTenantPy, tenantPy } from "./tests.ts";

/** Integer and string literals of the aggregate's rules: values near them find the boundaries sooner. */
export function aggregateLiterals(L: Pick<Layout, "ca">, ag: AggregateIR): { ints: number[]; strings: string[] } {
  const prefix = formatPath(ag.path);
  const ints = new Set<number>();
  const strings = new Set<string>();
  const walk = (e: TExpr) => {
    if (e.t === "lit" && e.kind === "integer" && typeof e.value === "number") [e.value - 1, e.value, e.value + 1].forEach((n) => ints.add(n));
    if (e.t === "lit" && e.kind === "string" && typeof e.value === "string" && e.value.length <= 40) strings.add(e.value);
    exprChildren(e).forEach(walk);
  };
  for (const [path, e] of L.ca.exprs) if (path.startsWith(prefix)) walk(e);
  for (const f of [...ag.fields, ...ag.entities.flatMap((x) => x.fields)]) {
    for (const n of [f.constraints.min, f.constraints.max, f.constraints.min_length, f.constraints.max_length]) if (typeof n === "number" && Number.isInteger(n)) [n - 1, n, n + 1].forEach((x) => ints.add(x));
  }
  return { ints: [...ints].filter((n) => Math.abs(n) <= 1_000_000).sort((a, b) => a - b).slice(0, 40), strings: [...strings].sort().slice(0, 20) };
}

/** The domain errors a factory or operation may raise: its guards', the invariants it can break, constraints. */
export function declaredErrors(L: Pick<Layout, "ca">, ag: AggregateIR, x: FactoryIR | OperationIR, kind: "factory" | "operation"): string[] {
  const out = new Set<string>(["ConstraintViolation"]);
  for (const r of x.require) {
    const g = ag.stateGuards.find((s) => s.name === r.replace(/\(.*$/, ""));
    if (g) out.add(g.error);
  }
  for (const inv of ag.invariants) if (kind === "operation" || inv.checkOn.includes("construct")) out.add(inv.error);
  // Value objects and entities the change builds (their constraints and invariants run).
  const built = new Set<string>();
  const walk = (e: TExpr) => {
    if (e.t === "construct") built.add(e.name);
    if (e.t === "with") {
      const t = e.target.type.k === "optional" ? e.target.type.inner : e.target.type;
      if (t.k === "entity" || t.k === "vo") built.add(t.name);
    }
    exprChildren(e).forEach(walk);
  };
  const body = kind === "factory" ? (x as FactoryIR).fields : (x as OperationIR).changes;
  for (const f of Object.keys(body)) {
    const e = L.ca.exprs.get(formatPath([...x.path, kind === "factory" ? "fields" : "changes", f]));
    if (e) walk(e);
  }
  // Values built for the events' payloads run their checks too (the proofs count them as well, docs/09 §29).
  for (const em of x.emits) {
    for (const fd of em.fields) {
      if (fd.value === undefined) continue;
      const e = L.ca.exprs.get(formatPath([...fd.path, "value"]));
      if (e) walk(e);
    }
  }
  for (const name of built) {
    const owner = L.ca.ir.valueObjects.find((v) => v.name === name) ?? ag.entities.find((v) => v.name === name);
    for (const inv of owner?.invariants ?? []) out.add(inv.error);
  }
  return [...out].sort();
}

interface Strategy {
  /** Hypothesis strategy expression. */
  expr: string;
  /** The value may be None because building it failed (a value object or entity with invalid fields). */
  maybe: boolean;
}

/** A Hypothesis strategy for values of type `t`. Value objects and entities are built and may come out None. */
function strategy(L: Layout, t: Type, imp: Imports, lits: { ints: number[]; strings: string[] }, depth = 0, c: Constraints = {}): Strategy {
  const st = (s: string): Strategy => ({ expr: s, maybe: false });
  switch (t.k) {
    case "optional": {
      const inner = strategy(L, t.inner, imp, lits, depth, c);
      return { expr: `st.one_of(st.none(), ${inner.expr})`, maybe: inner.maybe };
    }
    case "primitive":
      switch (t.name) {
        case "Integer": {
          const lo = c.min ?? -1000;
          const hi = c.max ?? 1000;
          const near = lits.ints.filter((n) => n >= lo && n <= hi);
          const base = `st.integers(min_value=${lo}, max_value=${hi})`;
          return st(near.length ? `st.one_of(${base}, st.sampled_from(${pyList(near.map(String))}))` : base);
        }
        case "Decimal":
          return st(`st.decimals(min_value=${c.min ?? -1000}, max_value=${c.max ?? 1000}, places=${c.decimal_places ?? 2}, allow_nan=False, allow_infinity=False)`);
        case "String": {
          // A small pool of strings (so equal values come up: the same currency, the same code) next to random text.
          const lo = c.min_length ?? 0;
          const hi = c.max_length ?? 12;
          const n = Math.max(lo, Math.min(hi, 3));
          const pool = c.pattern ? [] : ["a", "b"].map((ch) => pyString(ch.repeat(n)));
          const fits = lits.strings.filter((x) => x.length >= lo && x.length <= hi && !c.pattern).map(pyString);
          const text = c.pattern ? `st.from_regex(${pyString(c.pattern)}, fullmatch=True)` : `_text(${lo}, ${Math.min(hi, lo + 12)})`;
          const choices = [...pool, ...fits];
          return st(choices.length ? `st.one_of(st.sampled_from(${pyList(choices)}), ${text})` : text);
        }
        case "Boolean":
          return st("st.booleans()");
        case "UUID":
          return st("st.uuids()");
        case "DateTime":
          return st("_INSTANTS");
        case "Date":
          return st("_DATES");
      }
      break;
    case "ref":
      return st("st.uuids()");
    case "enum":
      imp.from(L.typeModule("enum", t.name), t.name);
      return st(`st.sampled_from(${t.name})`);
    case "list": {
      const item = strategy(L, t.item, imp, lits, depth + 1);
      const size = `min_size=${c.min_items ?? 0}, max_size=${Math.max(c.min_items ?? 0, Math.min(c.max_items ?? 3, 3))}`;
      return st(item.maybe ? `st.lists(${item.expr}, ${size}).map(_present)` : `st.lists(${item.expr}, ${size}).map(tuple)`);
    }
    case "vo":
    case "entity": {
      if (depth > 3) break;
      imp.from(L.typeModule(t.k, t.name), t.name);
      const types = L.fieldTypes(t.name);
      const owner = L.ca.ir.valueObjects.find((v) => v.name === t.name) ?? L.ca.ir.aggregates.flatMap((a) => a.entities).find((e) => e.name === t.name)!;
      const fields = owner.fields.map((f) => {
        const s = strategy(L, types.get(f.name)!, imp, lits, depth + 1, f.constraints);
        return `${f.name}=${s.expr}`;
      });
      return { expr: `st.builds(_attempt(${t.name})${fields.length ? `, ${fields.join(", ")}` : ""})`, maybe: true };
    }
  }
  return st("st.nothing()");
}

function pyList(items: string[]): string {
  return `[${items.join(", ")}]`;
}

export function propertyTestFile(L: Layout): PyFile | undefined {
  if (!L.model.generation.propertyTests) return undefined;
  const aggregates = L.ca.ir.aggregates.filter((ag) => ag.factories.length > 0);
  if (!aggregates.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.from("collections.abc", "Callable", "Sequence");
  imp.from("datetime", "UTC", "date", "datetime");
  imp.from("typing", "TypeVar");
  imp.from("hypothesis", "HealthCheck", "event", "settings");
  imp.import("hypothesis.strategies as st");
  imp.from("hypothesis.stateful", "RuleBasedStateMachine", "rule");
  imp.from(L.runtime, "DomainError");
  const c = new Code();
  c.line();
  c.line('_T = TypeVar("_T")');
  c.line().line();
  c.line("def _text(min_size: int, max_size: int) -> st.SearchStrategy[str]:");
  c.indent(() => c.line('return st.text(alphabet=st.characters(codec="ascii", categories=["L", "N"]), min_size=min_size, max_size=max_size)'));
  c.line().line();
  c.line("_INSTANTS = st.datetimes(min_value=datetime(2025, 1, 1), max_value=datetime(2027, 12, 31), timezones=st.just(UTC))");
  c.line("_DATES = st.dates(min_value=date(2025, 1, 1), max_value=date(2027, 12, 31))");
  c.line().line();
  c.line("def _attempt(build: Callable[..., _T]) -> Callable[..., _T | None]:");
  c.indent(() => {
    c.docstring("A builder that gives None when the value is invalid (a value object or entity that refuses its fields).");
    c.line();
    c.line("def attempt(**fields: object) -> _T | None:");
    c.indent(() => {
      c.line("try:");
      c.indent(() => c.line("return build(**fields)"));
      c.line("except (DomainError, ValueError):");
      c.indent(() => c.line("return None"));
    });
    c.line();
    c.line("return attempt");
  });
  c.line().line();
  c.line("def _present(items: Sequence[_T | None]) -> tuple[_T, ...]:");
  c.indent(() => c.line("return tuple(x for x in items if x is not None)"));

  for (const ag of aggregates) machine(L, c, ag, imp);
  return {
    path: L.testPath("properties"),
    content: assemble(L.model, `Property tests of the ${L.ca.ir.name} aggregates (Hypothesis): random factories and operations raise only the domain errors the model declares.`, imp, c.toString(), { exports: false }),
  };
}

function importErrors(L: Layout, imp: Imports, names: string[]): void {
  for (const n of names) {
    if (n === "ConstraintViolation") imp.from(L.runtime, n);
    else if (n === "NotAuthorized" || n === "Unauthenticated") imp.from(securityModule(L.model), n);
    else imp.from(L.mod("errors"), n);
  }
}

function machine(L: Layout, c: Code, ag: AggregateIR, imp: Imports): void {
  imp.from(L.mod("aggregates"), ag.name);
  const lits = aggregateLiterals(L, ag);
  const cls = `${ag.name}Machine`;
  c.line().line();
  c.line(`class ${cls}(RuleBasedStateMachine):`);
  c.indent(() => {
    c.docstring(
      [
        `Random ${ag.name} lifecycles: a factory, then operations on the state it returns.`,
        "",
        "Every call succeeds or raises one of its declared domain errors; any other exception fails the test.",
      ].join("\n"),
    );
    c.line();
    c.line("def __init__(self) -> None:");
    c.indent(() => {
      c.line("super().__init__()");
      c.line(`self.aggregate: ${ag.name} | None = None`);
    });
    const members: { kind: "factory" | "operation"; x: FactoryIR | OperationIR }[] = [
      ...ag.factories.map((x) => ({ kind: "factory" as const, x })),
      ...ag.operations.map((x) => ({ kind: "operation" as const, x })),
    ];
    for (const { kind, x } of members) {
      const errors = declaredErrors(L, ag, x, kind);
      importErrors(L, imp, errors);
      const types = paramTypes(L, ag, x.parameters);
      const strategies = x.parameters.map((p) => ({ p, s: strategy(L, types.get(p.name)!, imp, lits) }));
      c.line();
      // Factories are always enabled (a new aggregate replaces the current one), so a rule can always run.
      if (kind === "operation") {
        imp.from("hypothesis.stateful", "precondition");
        c.line("@precondition(lambda self: self.aggregate is not None)");
      }
      c.line(`@rule(${strategies.map(({ p, s }) => `${p.name}=${s.expr}`).join(", ")})`);
      const sig = strategies.map(({ p, s }) => `${p.name}: ${pyParamType(L, types.get(p.name)!, imp)}${s.maybe ? " | None" : ""}`);
      c.line(`def ${kind === "factory" ? "create" : "do"}_${x.name}(${["self", ...sig].join(", ")}) -> None:`);
      c.indent(() => {
        // Arguments that could not be built (invalid value objects) are not a call to make: skip the step.
        for (const { p, s } of strategies) {
          if (!s.maybe || types.get(p.name)!.k === "optional") continue;
          c.line(`if ${p.name} is None:`);
          c.indent(() => c.line("return"));
        }
        const args = x.parameters.map((p) => `${p.name}=${p.name}`);
        if (kind === "factory" && L.tenantScoped(ag)) args.unshift(`tenant_id=${tenantPy(L, imp, defaultTenantPy(L))}`);
        if (kind === "operation") {
          c.line("aggregate = self.aggregate");
          c.line("assert aggregate is not None");
        }
        c.line("try:");
        c.indent(() => {
          c.line(`transition = ${kind === "factory" ? ag.name : "aggregate"}.${x.name}(${args.join(", ")})`);
        });
        c.line(`except ${errors.length === 1 ? errors[0] : `(${errors.join(", ")})`} as error:`);
        c.indent(() => {
          // `--hypothesis-show-statistics` shows how often each call succeeded or was refused, and why.
          c.line(`event(${pyString(`${x.name}: `)} + type(error).__name__)`);
          c.line("return");
        });
        c.line(`event(${pyString(`${x.name}: ok`)})`);
        c.line("self.aggregate = transition.aggregate");
      });
    }
  });
  c.line().line();
  c.line(`Test${pascal(ag.name)}Properties = ${cls}.TestCase`);
  c.line(`Test${pascal(ag.name)}Properties.settings = settings(`);
  c.indent(() => {
    c.line("max_examples=200,");
    c.line("stateful_step_count=30,");
    c.line("deadline=None,");
    c.line("suppress_health_check=[HealthCheck.filter_too_much, HealthCheck.too_slow],");
  });
  c.line(")");
  void pyString;
}

/** The parameter's annotation (tuples for lists, Optional as `| None`). */
function pyParamType(L: Layout, t: Type, imp: Imports): string {
  switch (t.k) {
    case "optional":
      return `${pyParamType(L, t.inner, imp)} | None`;
    case "list":
      return `tuple[${pyParamType(L, t.item, imp)}, ...]`;
    case "primitive":
      if (t.name === "Decimal") imp.from("decimal", "Decimal");
      if (t.name === "UUID") imp.from("uuid", "UUID");
      return { String: "str", Integer: "int", Decimal: "Decimal", Boolean: "bool", UUID: "UUID", DateTime: "datetime", Date: "date" }[t.name];
    case "ref":
      imp.from("uuid", "UUID");
      return "UUID";
    case "enum":
    case "vo":
    case "entity":
      imp.from(L.typeModule(t.k, t.name), t.name);
      return t.name;
    default:
      return "object";
  }
}
