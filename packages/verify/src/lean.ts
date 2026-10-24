/**
 * The aggregates as Lean 4 definitions and the proof obligations as theorems (docs/09 §29).
 *
 * Z3 checks lists only up to a bound; a Lean proof covers lists of any length. Each aggregate becomes a structure,
 * its invariants, constraints and guards predicates, its operations functions on the structure, and every obligation
 * Z3 left bounded or undecided a theorem ("a valid state, valid arguments and the guards give a new state that keeps
 * the invariant"), proved by `sorry` until a prover (`prove.ts`) fills it in and Lean checks it.
 *
 * Only Lean's core library is used (Int, Rat, String, List, Option): no Mathlib to download. Decimal is `Rat`
 * (exact), Integer `Int`, instants and durations `Int` milliseconds, String / UUID / Ref `String`.
 */
import {
  exprChildren,
  formatPath,
  resolveType,
  type AggregateIR,
  type Analysis,
  type Constraints,
  type ContextAnalysis,
  type FieldIR,
  type InvariantIR,
  type OperationIR,
  type ProofReport,
  type ProofResult,
  type TExpr,
  type Type,
} from "@ddd/core";

/** Lean 4 keywords and tokens that cannot be identifiers without «…». */
const KEYWORDS = new Set(
  "at by do else end export fun from have if import in instance let match mutual namespace open private protected rec return section show structure then theorem universe variable where with deriving inductive def abbrev axiom class example extends for unless try catch finally break continue calc Type Prop Sort macro syntax notation infix prefix postfix local attribute opaque partial unsafe noncomputable nomatch termination_by decreasing_by suffices obtain sorry".split(
    " ",
  ),
);

export function leanName(name: string): string {
  return KEYWORDS.has(name) || !/^[A-Za-z_][A-Za-z0-9_']*$/.test(name) ? `«${name}»` : name;
}

export class LeanUnsupported extends Error {}

const DAY = 86_400_000;

/** Helpers every generated file starts with. */
const PRELUDE = `/-- Rounding half up (away from zero at .5), as decimal.js ROUND_HALF_UP and Python ROUND_HALF_UP. -/
def roundHalfUp (x : Rat) (places : Nat) : Rat :=
  let s : Rat := (10 : Rat) ^ places
  if x ≥ 0 then (((x * s + 1 / 2).floor : Int) : Rat) / s else -((((-x) * s + 1 / 2).floor : Int) : Rat) / s
`;

interface Ctx {
  ca: ContextAnalysis;
  /** Name of the record the bare field names belong to (`self`). */
  self?: string;
  /** Names of the element variables of the enclosing collection functions. */
  items: string[];
}

/** Lean type of a model type. */
function leanType(ca: ContextAnalysis, t: Type): string {
  switch (t.k) {
    case "optional":
      return `Option ${paren(leanType(ca, t.inner))}`;
    case "list":
      return `List ${paren(leanType(ca, t.item))}`;
    case "primitive":
      return { Integer: "Int", Decimal: "Rat", Boolean: "Bool", String: "String", UUID: "String", DateTime: "Int", Date: "Int" }[t.name];
    case "ref":
      return "String";
    case "duration":
      return "Int";
    case "enum":
    case "vo":
    case "entity":
    case "aggregate":
      return leanName(t.name);
  }
  throw new LeanUnsupported(`type ${t.k}`);
}

const paren = (s: string) => (/^[\w.«»']+$/.test(s) ? s : `(${s})`);

const base = (t: Type) => (t.k === "optional" ? t.inner : t);
const isRat = (t: Type) => base(t).k === "primitive" && (base(t) as { name: string }).name === "Decimal";
const isNumeric = (t: Type) => {
  const b = base(t);
  return b.k === "duration" || (b.k === "primitive" && ["Integer", "Decimal", "DateTime", "Date"].includes(b.name));
};

/** `"1.50"` → `(150 / 100 : Rat)`. */
function ratLiteral(v: string | number): string {
  const s = String(v);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [w, f = ""] = body.split(".");
  const num = BigInt(`${w}${f}`);
  const den = 10n ** BigInt(f.length);
  return `(${neg ? "-" : ""}${num} / ${den} : Rat)`;
}

/** An expression as a Lean term (`prop`: a Boolean condition as a Prop). */
function term(e: TExpr, c: Ctx, want: "prop" | "term" = "term"): string {
  const t = (x: TExpr) => term(x, c);
  const p = (x: TExpr) => term(x, c, "prop");
  const asRat = (x: TExpr) => (isRat(x.type) ? t(x) : `((${t(x)} : Int) : Rat)`);
  switch (e.t) {
    case "lit":
      if (e.kind === "null") return "none";
      if (e.kind === "boolean") return want === "prop" ? (e.value ? "True" : "False") : e.value ? "true" : "false";
      if (e.kind === "integer") return isRat(e.type) ? ratLiteral(e.value as number) : `(${e.value} : Int)`;
      if (e.kind === "decimal") return ratLiteral(e.value as string);
      return JSON.stringify(e.value);
    case "field": {
      const owner = e.owner ? t(e.owner) : "self";
      const ownerType = e.owner ? base(e.owner.type) : undefined;
      const ownerName = ownerType && "name" in ownerType ? ownerType.name : c.self;
      const declared = ownerName ? c.ca.fieldTypes.get(ownerName)?.get(e.name) : undefined;
      // A narrowed optional field (`placed_at != null and … placed_at …`): its value, the default when absent.
      const value = declared?.k === "optional" && e.type.k !== "optional" ? `(${paren(owner)}.${leanName(e.name)}.getD default)` : `${paren(owner)}.${leanName(e.name)}`;
      return want === "prop" && base(e.type).k === "primitive" && (base(e.type) as { name: string }).name === "Boolean" ? `(${value} = true)` : value;
    }
    case "param":
      return leanName(e.name);
    case "item":
      return c.items[e.depth] ?? "item";
    case "enumValue":
      return `${leanName(e.enumName)}.${leanName(e.value)}`;
    case "guard": {
      if (e.receiver) throw new LeanUnsupported("guard on another value");
      return `(self.${leanName(`guard_${e.guard}`)}${e.args.map((a) => ` ${paren(t(a))}`).join("")})`;
    }
    case "not":
      return `(¬ ${p(e.operand)})`;
    case "isNull":
      return `(${paren(t(e.operand))}.${e.negate ? "isSome" : "isNone"} = true)`;
    case "neg":
      return `(-${paren(t(e.operand))})`;
    case "binary": {
      const op = e.op;
      if (op === "and" || op === "or") return `(${p(e.left)} ${op === "and" ? "∧" : "∨"} ${p(e.right)})`;
      const l = e.left;
      const r = e.right;
      if (op === "==" || op === "!=") {
        const rel = op === "==" ? "=" : "≠";
        if (l.t === "lit" && l.kind === "null") return `(${t(r)} ${rel} none)`;
        if (r.t === "lit" && r.kind === "null") return `(${t(l)} ${rel} none)`;
        if (isNumeric(l.type) && isNumeric(r.type) && (isRat(l.type) || isRat(r.type))) return `(${asRat(l)} ${rel} ${asRat(r)})`;
        return `(${t(l)} ${rel} ${t(r)})`;
      }
      const lean = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "+": "+", "-": "-", "*": "*", "/": "/" }[op];
      if (op === "/") return `(${asRat(l)} / ${asRat(r)})`;
      if (isRat(l.type) || isRat(r.type) || isRat(e.type)) return `(${asRat(l)} ${lean} ${asRat(r)})`;
      return `(${t(l)} ${lean} ${t(r)})`;
    }
    case "builtin":
      return builtin(e, c, want);
    case "list":
      return `[${e.items.map(t).join(", ")}]`;
    case "construct": {
      const owner = c.ca.ir.valueObjects.find((v) => v.name === e.name) ?? c.ca.ir.aggregates.flatMap((a) => a.entities).find((x) => x.name === e.name);
      const given = new Map(e.fields.map((f) => [f.name, f]));
      const fields = (owner?.fields ?? []).map((f) => {
        const g = given.get(f.name);
        const v = g ? (isRat(g.fieldType) && !isRat(g.value.type) ? asRat(g.value) : t(g.value)) : "none";
        return `${leanName(f.name)} := ${v}`;
      });
      return `({ ${fields.join(", ")} } : ${leanName(e.name)})`;
    }
    case "with":
      return `{ ${t(e.target)} with ${e.fields.map((f) => `${leanName(f.name)} := ${isRat(f.fieldType) && !isRat(f.value.type) ? asRat(f.value) : t(f.value)}`).join(", ")} }`;
    default:
      throw new LeanUnsupported(`${e.t} is not translated`);
  }
}

function builtin(e: Extract<TExpr, { t: "builtin" }>, c: Ctx, want: "prop" | "term"): string {
  const t = (x: TExpr, cc = c) => term(x, cc);
  const withItem = () => {
    const name = `item${c.items.length}`;
    return { name, ctx: { ...c, items: [...c.items, name] } };
  };
  const a0 = e.args[0]!;
  switch (e.fn) {
    case "is_empty":
      return `(${paren(t(a0))}.length = 0)`;
    case "length":
      return `((${paren(t(a0))}.length : Nat) : Int)`;
    case "contains":
      if (base(a0.type).k !== "list") throw new LeanUnsupported("contains on a string");
      return `(${t(e.args[1]!)} ∈ ${paren(t(a0))})`;
    case "days":
    case "hours":
    case "minutes":
      return `(${t(a0)} * ${e.fn === "days" ? DAY : e.fn === "hours" ? 3_600_000 : 60_000})`;
    case "round":
      return `(roundHalfUp ${paren(isRat(a0.type) ? t(a0) : `((${t(a0)} : Int) : Rat)`)} ${(e.args[1] as { value: number }).value})`;
    case "min":
    case "max":
      return `(${e.fn} ${paren(t(a0))} ${paren(t(e.args[1]!))})`;
    case "count": {
      if (e.args.length === 1) return `((${paren(t(a0))}.length : Nat) : Int)`;
      const it = withItem();
      return `(((${paren(t(a0))}.filter (fun ${it.name} => decide ${paren(term(e.args[1]!, it.ctx, "prop"))})).length : Nat) : Int)`;
    }
    case "sum": {
      if (e.args.length === 1) return `(${paren(t(a0))}.sum)`;
      const it = withItem();
      const body = term(e.args[1]!, it.ctx);
      const v = isRat(e.type) && !isRat(e.args[1]!.type) ? `((${body} : Int) : Rat)` : body;
      return `((${paren(t(a0))}.map (fun ${it.name} => ${v})).sum)`;
    }
    case "any":
    case "all": {
      const it = withItem();
      const body = term(e.args[1]!, it.ctx, "prop");
      return e.fn === "any" ? `(∃ ${it.name} ∈ ${paren(t(a0))}, ${body})` : `(∀ ${it.name} ∈ ${paren(t(a0))}, ${body})`;
    }
    case "append":
      return `(${paren(t(a0))} ++ [${t(e.args[1]!)}])`;
    case "remove": {
      const it = withItem();
      return `(${paren(t(a0))}.filter (fun ${it.name} => decide (${it.name} ≠ ${t(e.args[1]!)})))`;
    }
    case "remove_where": {
      const it = withItem();
      return `(${paren(t(a0))}.filter (fun ${it.name} => !decide ${paren(term(e.args[1]!, it.ctx, "prop"))}))`;
    }
    case "replace_where": {
      const it = withItem();
      return `(${paren(t(a0))}.map (fun ${it.name} => if ${term(e.args[1]!, it.ctx, "prop")} then ${term(e.args[2]!, it.ctx)} else ${it.name}))`;
    }
  }
  void want;
  throw new LeanUnsupported(`${e.fn}()`);
}

/** The field constraints of `value` (a Lean term of type `t`) as a Prop, or undefined when there are none. */
function constraintProp(c: Constraints, value: string, t: Type): string | undefined {
  if (t.k === "optional") {
    const inner = constraintProp(c, "x", t.inner);
    return inner ? `(∀ x, ${value} = some x → ${inner})` : undefined;
  }
  const parts: string[] = [];
  const b = base(t);
  if (b.k === "primitive" && b.name === "String") {
    if (c.min_length !== undefined) parts.push(`${value}.length ≥ ${c.min_length}`);
    if (c.max_length !== undefined) parts.push(`${value}.length ≤ ${c.max_length}`);
  }
  if (b.k === "primitive" && (b.name === "Integer" || b.name === "Decimal")) {
    const lit = (n: number) => (b.name === "Decimal" ? ratLiteral(n) : `(${n} : Int)`);
    if (c.min !== undefined) parts.push(`${value} ≥ ${lit(c.min)}`);
    if (c.max !== undefined) parts.push(`${value} ≤ ${lit(c.max)}`);
    if (b.name === "Decimal" && c.decimal_places !== undefined) parts.push(`(${value} * (10 : Rat) ^ ${c.decimal_places}).den = 1`);
  }
  if (b.k === "list") {
    if (c.min_items !== undefined) parts.push(`${value}.length ≥ ${c.min_items}`);
    if (c.max_items !== undefined) parts.push(`${value}.length ≤ ${c.max_items}`);
  }
  return parts.length ? parts.map((x) => `(${x})`).join(" ∧ ") : undefined;
}

/** `x.Valid` for a value of type `t` (value objects, entities, lists and options of them), or undefined. */
function validProp(ca: ContextAnalysis, value: string, t: Type, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  switch (t.k) {
    case "optional": {
      const inner = validProp(ca, "x", t.inner, depth + 1);
      return inner ? `(∀ x, ${value} = some x → ${inner})` : undefined;
    }
    case "list": {
      const inner = validProp(ca, "x", t.item, depth + 1);
      return inner ? `(∀ x ∈ ${value}, ${inner})` : undefined;
    }
    case "vo":
    case "entity":
      return `${paren(value)}.Valid`;
    default:
      return undefined;
  }
}

export interface LeanTheorem {
  /** The proof result it states (its id). */
  id: string;
  /** Lean name of the theorem. */
  name: string;
  /** Module (file) it is in, e.g. `Proofs.Sales`. */
  module: string;
  /** The statement, up to and including `:= by`. */
  statement: string;
}

export interface LeanProject {
  files: Record<string, string>;
  theorems: LeanTheorem[];
  /** Results that could not be stated in Lean, with the reason. */
  skipped: { id: string; reason: string }[];
}

/** Results worth a Lean proof: proven by Z3 only up to a list bound, or undecided. */
export function leanCandidates(report: ProofReport): ProofResult[] {
  return report.results.filter((r) => r.kind === "operation" && (r.source.kind === "invariant" || r.source.kind === "constraint") && ((r.outcome === "proven" && r.bound !== undefined) || r.outcome === "unknown"));
}

/**
 * A Lean 4 project (lake) with the definitions of every context and a theorem per candidate result (`sorry` proofs).
 * `toolchain` is the `lean-toolchain` line.
 */
export function leanProject(analysis: Analysis, report: ProofReport, toolchain = "leanprover/lean4:v4.35.0"): LeanProject {
  const files: Record<string, string> = {};
  const theorems: LeanTheorem[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const candidates = leanCandidates(report);
  const modules: string[] = [];
  for (const ca of analysis.contexts.values()) {
    const mine = candidates.filter((r) => r.context === ca.ir.name);
    if (!mine.length) continue;
    const module = `Proofs.${leanModule(ca.ir.name)}`;
    const out = contextFile(ca, mine, module, theorems, skipped);
    if (!out) continue;
    files[`Proofs/${leanModule(ca.ir.name)}.lean`] = out;
    modules.push(module);
  }
  files["Proofs.lean"] = modules.map((m) => `import ${m}`).join("\n") + "\n";
  files["lean-toolchain"] = `${toolchain}\n`;
  files["lakefile.toml"] = `name = "proofs"\ndefaultTargets = ["Proofs"]\n\n[[lean_lib]]\nname = "Proofs"\n`;
  return { files, theorems, skipped };
}

const leanModule = (name: string) => name.replace(/[^A-Za-z0-9]/g, "_").replace(/^[^A-Za-z]/, "M$&");

function contextFile(ca: ContextAnalysis, results: ProofResult[], module: string, theorems: LeanTheorem[], skipped: { id: string; reason: string }[]): string | undefined {
  const ctx = ca.ir;
  const lines: string[] = [
    `/-`,
    `  Generated by DDD Presenter from the ${ctx.name} context: definitions of its aggregates and the proof obligations`,
    `  that Z3 checked only up to a list bound (docs/09 §29). Do not edit the definitions or the statements; a proof`,
    `  replaces a \`sorry\` and is checked by Lean.`,
    `-/`,
    "",
    // Guards and operations keep the model's parameters even when a body does not read them.
    "set_option linter.unusedVariables false",
    "",
    `namespace ${leanName(leanModule(ctx.name))}`,
    "",
    PRELUDE,
  ];
  const fieldT = (owner: string, f: FieldIR) => {
    const t = ca.fieldTypes.get(owner)?.get(f.name);
    if (!t) throw new LeanUnsupported(`type of ${owner}.${f.name}`);
    return t;
  };
  try {
    for (const en of ctx.enums) {
      lines.push(`inductive ${leanName(en.name)} where`, ...en.values.map((v) => `  | ${leanName(v)}`), "  deriving DecidableEq, Repr, Inhabited", "");
    }
    // Value objects first (entities and aggregates hold them), then entities, then aggregate roots.
    const records = [...ctx.valueObjects, ...ctx.aggregates.flatMap((a) => a.entities), ...ctx.aggregates];
    for (const r of records) {
      lines.push(`structure ${leanName(r.name)} where`, ...r.fields.map((f) => `  ${leanName(f.name)} : ${leanType(ca, fieldT(r.name, f))}`), "  deriving Inhabited", "");
    }
    for (const r of records) {
      const c: Ctx = { ca, self: r.name, items: [] };
      for (const inv of r.invariants) lines.push(`def ${leanName(r.name)}.${leanName(`inv_${inv.name}`)} (self : ${leanName(r.name)}) : Prop :=`, `  ${term(expr(ca, inv), c, "prop")}`, "");
      const parts = [
        ...r.fields.flatMap((f) => {
          const t = fieldT(r.name, f);
          return [constraintProp(f.constraints, `self.${leanName(f.name)}`, t), validProp(ca, `self.${leanName(f.name)}`, t)].filter((x): x is string => !!x);
        }),
        ...r.invariants.map((i) => `self.${leanName(`inv_${i.name}`)}`),
      ];
      lines.push(`/-- Every constraint and invariant of ${r.name} holds. -/`, `def ${leanName(r.name)}.Valid (self : ${leanName(r.name)}) : Prop :=`, `  ${parts.length ? parts.join(" ∧\n  ") : "True"}`, "");
    }
    for (const ag of ctx.aggregates) aggregateDefs(ca, ag, lines);
  } catch (err) {
    if (!(err instanceof LeanUnsupported)) throw err;
    for (const r of results) skipped.push({ id: r.id, reason: err.message });
    return undefined;
  }
  for (const r of results) {
    const ag = ctx.aggregates.find((a) => a.name === r.aggregate)!;
    const op = ag.operations.find((o) => o.name === r.name)!;
    try {
      const st = statement(ca, ag, op, r);
      lines.push(`/-- ${r.name} keeps ${r.source.owner}.${r.source.name} (${r.source.expression}). Z3: ${r.outcome}${r.bound ? `, lists of at most ${r.bound}` : ""}. -/`, st.text, "  sorry", "");
      theorems.push({ id: r.id, name: st.name, module, statement: st.text });
    } catch (err) {
      if (!(err instanceof LeanUnsupported)) throw err;
      skipped.push({ id: r.id, reason: err.message });
    }
  }
  lines.push(`end ${leanName(leanModule(ctx.name))}`, "");
  return lines.join("\n");
}

function expr(ca: ContextAnalysis, inv: InvariantIR | { path: (string | number)[] }, key = "expression"): TExpr {
  const e = ca.exprs.get(formatPath([...inv.path, key]));
  if (!e) throw new LeanUnsupported(`${formatPath(inv.path)} did not type-check`);
  return e;
}

function paramType(ca: ContextAnalysis, ag: AggregateIR, p: { type: string; required: boolean }): Type {
  const r = resolveType(p.type, { context: ca.ir, aggregate: ag.name });
  if (!r.ok) throw new LeanUnsupported(r.message);
  return p.required ? r.type : { k: "optional", inner: r.type };
}

function aggregateDefs(ca: ContextAnalysis, ag: AggregateIR, lines: string[]): void {
  const A = leanName(ag.name);
  const c: Ctx = { ca, self: ag.name, items: [] };
  for (const g of ag.stateGuards) {
    const params = g.parameters.map((p) => `(${leanName(p.name)} : ${leanType(ca, paramType(ca, ag, p))})`).join(" ");
    lines.push(`def ${A}.${leanName(`guard_${g.name}`)} (self : ${A})${params ? ` ${params}` : ""} : Prop :=`, `  ${term(expr(ca, g), c, "prop")}`, "");
  }
  for (const op of ag.operations) {
    const params = op.parameters.map((p) => `(${leanName(p.name)} : ${leanType(ca, paramType(ca, ag, p))})`).join(" ");
    const changes = ag.fields.filter((f) => op.changes[f.name] !== undefined).map((f) => {
      const e = ca.exprs.get(formatPath([...op.path, "changes", f.name]));
      if (!e) throw new LeanUnsupported(`${op.name}.${f.name} did not type-check`);
      const declared = ca.fieldTypes.get(ag.name)!.get(f.name)!;
      const v = term(e, c);
      const value = isRat(declared) && !isRat(e.type) && e.t !== "lit" ? `((${v} : Int) : Rat)` : declared.k === "optional" && e.type.k !== "optional" && e.type.k !== "null" ? `some ${paren(v)}` : v;
      return `${leanName(f.name)} := ${value}`;
    });
    lines.push(`/-- The state after ${op.name} (its changes, computed from the state before). -/`, `def ${A}.${leanName(`op_${op.name}`)} (self : ${A})${params ? ` ${params}` : ""} : ${A} :=`, `  ${changes.length ? `{ self with ${changes.join(", ")} }` : "self"}`, "");
  }
}

/**
 * `theorem <Agg>.<op>_keeps_<source> (self) (params) (h : self.Valid) (hargs …) (hreq …) (hbefore …) : … := by`:
 * a valid state, valid arguments, the require guards and the checks that run before this one give a new state on
 * which it holds.
 */
function statement(ca: ContextAnalysis, ag: AggregateIR, op: OperationIR, r: ProofResult): { name: string; text: string } {
  const A = leanName(ag.name);
  const c: Ctx = { ca, self: ag.name, items: [] };
  const params = op.parameters.map((p) => ({ name: leanName(p.name), type: paramType(ca, ag, p) }));
  const binders = params.map((p) => `(${p.name} : ${leanType(ca, p.type)})`);
  const call = `(self.${leanName(`op_${op.name}`)}${params.map((p) => ` ${p.name}`).join("")})`;
  const hyps: string[] = ["(h : self.Valid)"];
  params.forEach((p, i) => {
    const v = validProp(ca, p.name, p.type);
    if (v) hyps.push(`(harg${i} : ${v})`);
  });
  op.require.forEach((_, i) => hyps.push(`(hreq${i} : ${term(requireExpr(ca, op, i), c, "prop")})`));
  // The values the change builds pass their own checks (they run before the aggregate's, as in the generated code).
  builtChecks(ca, ag, op, c).forEach((b, i) => hyps.push(`(hbuilt${i} : ${b})`));
  // The aggregate's own checks that run before this one on the new state (invariants in order, constraints first).
  const changed = new Set(Object.keys(op.changes));
  const checks: { key: string; prop: string }[] = [];
  for (const f of ag.fields) {
    if (!changed.has(f.name)) continue;
    const prop = constraintProp(f.constraints, `${call}.${leanName(f.name)}`, ca.fieldTypes.get(ag.name)!.get(f.name)!);
    if (prop) checks.push({ key: `constraint.${f.name}`, prop });
  }
  const order = [...ag.invariants.filter((i) => i.checkOn.includes("construct")), ...ag.invariants.filter((i) => i.checkOn.includes("transition") && !i.checkOn.includes("construct"))];
  for (const inv of order) checks.push({ key: `invariant.${inv.name}`, prop: `${call}.${leanName(`inv_${inv.name}`)}` });
  const key = `${r.source.kind}.${r.source.name}`;
  const at = checks.findIndex((x) => x.key === key);
  if (at < 0) throw new LeanUnsupported(`no check ${key}`);
  checks.slice(0, at).forEach((x, i) => hyps.push(`(hbefore${i} : ${x.prop})`));
  const name = `${A}.${leanName(`${op.name}_keeps_${r.source.name}`)}`;
  const text = [`theorem ${name} (self : ${A})${binders.length ? ` ${binders.join(" ")}` : ""}`, ...hyps.map((x) => `    ${x}`), `    : ${checks[at]!.prop} := by`].join("\n");
  return { name, text };
}

/** `X.Valid` of every value object / entity the changes build (per element for `replace_where`). */
function builtChecks(ca: ContextAnalysis, ag: AggregateIR, op: OperationIR, c: Ctx): string[] {
  const out: string[] = [];
  const builds = (e: TExpr): boolean => e.t === "construct" || e.t === "with" || exprChildren(e).some(builds);
  const walk = (e: TExpr, ctx: Ctx) => {
    if (e.t === "construct" || e.t === "with") {
      exprChildren(e).forEach((x) => walk(x, ctx));
      out.push(`(${term(e, ctx)}).Valid`);
      return;
    }
    if (e.t === "builtin" && e.fn === "replace_where") {
      walk(e.args[0]!, ctx);
      const name = `item${ctx.items.length}`;
      const inner = { ...ctx, items: [...ctx.items, name] };
      if (builds(e.args[2]!)) out.push(`(∀ ${name} ∈ ${paren(term(e.args[0]!, ctx))}, ${term(e.args[1]!, inner, "prop")} → (${term(e.args[2]!, inner)}).Valid)`);
      return;
    }
    // Element-wise arguments of the other collection functions build nothing the change keeps.
    if (e.t === "builtin" && ["count", "sum", "any", "all", "remove_where"].includes(e.fn)) {
      walk(e.args[0]!, ctx);
      return;
    }
    exprChildren(e).forEach((x) => walk(x, ctx));
  };
  for (const f of ag.fields) {
    if (op.changes[f.name] === undefined) continue;
    const e = ca.exprs.get(formatPath([...op.path, "changes", f.name]));
    if (e) walk(e, c);
  }
  return out;
}

function requireExpr(ca: ContextAnalysis, op: OperationIR, i: number): TExpr {
  const e = ca.exprs.get(formatPath([...op.path, "require", i]));
  if (!e) throw new LeanUnsupported(`${op.name}.require[${i}] did not type-check`);
  return e;
}
