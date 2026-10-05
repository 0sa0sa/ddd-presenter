import { referencedFields, type TExpr } from "./checker.ts";
import { formatPath } from "./diagnostics.ts";
import type { FieldIR, InvariantIR } from "./ir.ts";
import { resolveType, type Type } from "./types.ts";
import type { ContextAnalysis } from "./validate.ts";

/**
 * Violating examples for invariants, derived from the model's own scenarios.
 *
 * A scenario that builds a valid object (a `given` aggregate, a successful `construct`, a command input, …) is a
 * known-good starting point. For each construct-time invariant we look for a small change to such a record (one or
 * two referenced fields set to null, another enum value, an empty list, the value of another field of the same type,
 * a literal of the rule ± 1, …) after which every earlier invariant still holds and this one fails. The generator
 * turns the result into a test that constructs the object and asserts that exactly this rule raised.
 *
 * Nothing here has to be complete: when no change is found, or an expression cannot be evaluated over plain values
 * (parameters, guards, value-object equality, …), the invariant simply gets no derived test and stays "not covered".
 */

type Rec = Record<string, unknown>;

export interface DerivedViolation {
  /** Aggregate, entity or value object that owns the invariant. */
  owner: string;
  ownerKind: "aggregate" | "entity" | "vo";
  rule: string;
  error: string;
  /** Complete field values, in the scenario value format (JSON-like). */
  record: Rec;
  /** Scenario that supplied the valid starting record. */
  from: string;
  /** Fields changed from that record. */
  changed: string[];
}

interface Owner {
  name: string;
  kind: DerivedViolation["ownerKind"];
  fields: FieldIR[];
  invariants: InvariantIR[];
  normalize: Record<string, string[]>;
}

/** Upper bound of candidate records evaluated per invariant (the search runs on every keystroke in the editor). */
const BUDGET = 400;

export function deriveViolations(ca: ContextAnalysis): DerivedViolation[] {
  const ctx = ca.ir;
  const owners: Owner[] = [
    ...ctx.valueObjects.map((v) => ({ name: v.name, kind: "vo" as const, fields: v.fields, invariants: v.invariants, normalize: v.normalize })),
    ...ctx.aggregates.flatMap((a) => [
      { name: a.name, kind: "aggregate" as const, fields: a.fields, invariants: a.invariants, normalize: {} },
      ...a.entities.map((e) => ({ name: e.name, kind: "entity" as const, fields: e.fields, invariants: e.invariants, normalize: {} })),
    ]),
  ];
  const byName = new Map(owners.map((o) => [o.name, o]));
  const enumValues = (name: string) => ctx.enums.find((e) => e.name === name)?.values ?? [];
  const bases = collectBases(ca, byName);
  const out: DerivedViolation[] = [];
  for (const owner of owners) {
    const construct = owner.invariants.filter((i) => i.checkOn.includes("construct"));
    const exprs = construct.map((i) => ca.exprs.get(formatPath([...i.path, "expression"])));
    if (!construct.length || exprs.some((e) => !e)) continue;
    const types = ca.fieldTypes.get(owner.name) ?? new Map<string, Type>();
    construct.forEach((inv, idx) => {
      const found = search(owner, types, exprs as TExpr[], idx, bases.get(owner.name) ?? [], bases, enumValues);
      if (found) out.push({ owner: owner.name, ownerKind: owner.kind, rule: inv.name, error: inv.error, ...found });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Known-good records from scenarios
// ---------------------------------------------------------------------------

interface Base {
  record: Rec;
  from: string;
}

function collectBases(ca: ContextAnalysis, owners: Map<string, Owner>): Map<string, Base[]> {
  const out = new Map<string, Base[]>();
  const seen = new Set<string>();
  const walk = (v: unknown, t: Type, from: string) => {
    if (v === null || v === undefined) return;
    if (t.k === "optional") return walk(v, t.inner, from);
    if (t.k === "list") {
      if (Array.isArray(v)) v.forEach((x) => walk(x, t.item, from));
      return;
    }
    if (t.k !== "vo" && t.k !== "entity" && t.k !== "aggregate") return;
    if (typeof v !== "object" || Array.isArray(v)) return;
    const types = ca.fieldTypes.get(t.name);
    const owner = owners.get(t.name);
    if (!types || !owner) return;
    const record = canonical(v, t, ca, owners) as Rec;
    const key = `${t.name}:${JSON.stringify(record)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.set(t.name, [...(out.get(t.name) ?? []), { record, from }]);
    }
    for (const [k, ft] of types) walk((v as Rec)[k], ft, from);
  };
  const ctx = ca.ir;
  for (const ag of ctx.aggregates) {
    const self: Type = { k: "aggregate", name: ag.name };
    for (const sc of ag.scenarios) {
      // `given` is constructed outside pytest.raises, so it is valid whenever the scenario passes.
      if (sc.given) walk(sc.given.aggregate, self, sc.name);
      if (sc.then.raises) continue;
      if (sc.when.kind === "construct") walk(sc.when.fields, self, sc.name);
      else {
        const w = sc.when;
        const member = w.kind === "operation" ? ag.operations.find((o) => o.name === w.operation) : ag.factories.find((f) => f.name === w.factory);
        for (const p of member?.parameters ?? []) {
          const r = resolveType(p.type, { context: ctx, aggregate: ag.name });
          if (r.ok) walk(w.args[p.name], r.type, sc.name);
        }
      }
    }
  }
  for (const uc of ctx.useCases) {
    const input = ca.fieldTypes.get(uc.command) ?? new Map<string, Type>();
    for (const sc of uc.scenarios) {
      for (const a of sc.given.aggregates) walk(a.fields, { k: "aggregate", name: a.type }, sc.name);
      // The command is built before the use case runs, so its values are valid too.
      for (const [k, t] of input) walk(sc.when.input[k], t, sc.name);
    }
  }
  return out;
}

/**
 * The value as the generated classes hold it: value-object normalization (strip/lower/upper) applied at every depth,
 * so rule evaluation sees what Python sees. Normalized values are fixed points, so they are also valid input.
 */
function canonical(v: unknown, t: Type, ca: ContextAnalysis, owners: Map<string, Owner>): unknown {
  if (v === null || v === undefined) return v;
  if (t.k === "optional") return canonical(v, t.inner, ca, owners);
  if (t.k === "list") return Array.isArray(v) ? v.map((x) => canonical(x, t.item, ca, owners)) : v;
  if ((t.k !== "vo" && t.k !== "entity" && t.k !== "aggregate") || typeof v !== "object" || Array.isArray(v)) return v;
  const types = ca.fieldTypes.get(t.name) ?? new Map<string, Type>();
  const out: Rec = {};
  for (const [k, x] of Object.entries(v as Rec)) out[k] = types.has(k) ? canonical(x, types.get(k)!, ca, owners) : x;
  for (const [field, steps] of Object.entries(owners.get(t.name)?.normalize ?? {})) {
    let s = out[field];
    if (typeof s !== "string") continue;
    for (const step of steps) s = step === "strip" ? (s as string).trim() : step === "lower" ? (s as string).toLowerCase() : (s as string).toUpperCase();
    out[field] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function search(
  owner: Owner,
  types: Map<string, Type>,
  exprs: TExpr[],
  target: number,
  bases: Base[],
  pools: Map<string, Base[]>,
  enumValues: (name: string) => string[],
): { record: Rec; from: string; changed: string[] } | undefined {
  const fields = [...referencedFields(exprs[target]!)].filter((f) => types.has(f));
  let budget = BUDGET;
  const fires = (rec: Rec): boolean | undefined => {
    budget--;
    for (let i = 0; i < target; i++) if (evaluateOnValues(exprs[i]!, rec) !== true) return false;
    const v = evaluateOnValues(exprs[target]!, rec);
    return v === undefined ? undefined : v === false;
  };
  for (const base of bases) {
    const options = new Map(fields.map((f) => [f, candidates(f, types.get(f)!, base.record, exprs[target]!, owner, pools, enumValues)]));
    for (const f of fields) {
      for (const v of options.get(f)!) {
        if (budget <= 0) return undefined;
        const rec = { ...base.record, [f]: v };
        if (fires(rec)) return { record: rec, from: base.from, changed: [f] };
      }
    }
    for (let a = 0; a < fields.length; a++) {
      for (let b = a + 1; b < fields.length; b++) {
        const fa = fields[a]!;
        const fb = fields[b]!;
        for (const va of options.get(fa)!) {
          for (const vb of options.get(fb)!) {
            if (budget <= 0) return undefined;
            const rec = { ...base.record, [fa]: va, [fb]: vb };
            if (fires(rec)) return { record: rec, from: base.from, changed: [fa, fb] };
          }
        }
      }
    }
  }
  return undefined;
}

/** Replacement values for one field, all of which satisfy the field's declared constraints. */
function candidates(field: string, t: Type, base: Rec, rule: TExpr, owner: Owner, pools: Map<string, Base[]>, enumValues: (name: string) => string[]): unknown[] {
  const decl = owner.fields.find((f) => f.name === field);
  const inner = t.k === "optional" ? t.inner : t;
  const out: unknown[] = [];
  if (t.k === "optional") out.push(null);
  const sameType = Object.entries(base).filter(([k, v]) => k !== field && v !== null && v !== undefined && sameShape(owner, k, inner));
  const literals = collectLiterals(rule);
  switch (inner.k) {
    case "enum":
      out.push(...enumValues(inner.name));
      break;
    case "list":
      out.push([]);
      break;
    case "primitive":
      if (inner.name === "Boolean") out.push(true, false);
      else if (inner.name === "Integer" || inner.name === "Decimal") {
        const nums = [...literals.filter((l) => typeof l === "number" || (typeof l === "string" && /^-?\d+(\.\d+)?$/.test(l))).map(Number), ...sameType.map(([, v]) => Number(v))];
        for (const n of nums) out.push(n, n - 1, n + 1);
        out.push(0);
      } else {
        out.push(...sameType.map(([, v]) => v), ...literals.filter((l) => typeof l === "string"));
      }
      break;
    case "vo":
    case "entity":
      out.push(...sameType.map(([, v]) => v), ...(pools.get(inner.name) ?? []).slice(0, 3).map((b) => b.record));
      break;
    default:
      out.push(...sameType.map(([, v]) => v));
  }
  const current = JSON.stringify(base[field] ?? null);
  const unique = new Map<string, unknown>();
  for (const v of out) {
    const key = JSON.stringify(v ?? null);
    if (key !== current && !unique.has(key) && fitsConstraints(v, inner, decl)) unique.set(key, v);
  }
  return [...unique.values()];
}

/** Two fields of the owner have the same resolved type (so one's value is a valid value of the other). */
function sameShape(owner: Owner, other: string, t: Type): boolean {
  const decl = owner.fields.find((f) => f.name === other);
  if (!decl) return false;
  const name = t.k === "primitive" ? t.name : t.k === "enum" || t.k === "vo" || t.k === "entity" ? t.name : t.k === "ref" ? `Ref[${t.target}]` : undefined;
  return name !== undefined && decl.type === name;
}

function collectLiterals(e: TExpr): unknown[] {
  const out: unknown[] = [];
  walk(e, (n) => {
    if (n.t === "lit" && n.kind !== "null" && n.kind !== "boolean") out.push(n.value);
  });
  return out;
}

function fitsConstraints(v: unknown, t: Type, decl: FieldIR | undefined): boolean {
  if (v === null || v === undefined) return true;
  const c = decl?.constraints ?? {};
  if (t.k === "primitive" && t.name === "Integer" && !Number.isInteger(v)) return false;
  if (typeof v === "string") {
    if (c.min_length !== undefined && v.length < c.min_length) return false;
    if (c.max_length !== undefined && v.length > c.max_length) return false;
    if (c.pattern !== undefined) {
      try {
        if (!new RegExp(c.pattern).test(v)) return false;
      } catch {
        return false;
      }
    }
  }
  if (typeof v === "number") {
    if (c.min !== undefined && v < c.min) return false;
    if (c.max !== undefined && v > c.max) return false;
    if (c.decimal_places !== undefined && (String(v).split(".")[1]?.length ?? 0) > c.decimal_places) return false;
  }
  if (Array.isArray(v)) {
    if (c.min_items !== undefined && v.length < c.min_items) return false;
    if (c.max_items !== undefined && v.length > c.max_items) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evaluation over scenario values (undefined = cannot tell)
// ---------------------------------------------------------------------------

const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/** The caller an authorization rule (`allow_if`) is evaluated for. */
export interface EvalPrincipal {
  id: string;
  roles: string[];
  claims: Record<string, unknown>;
}

export function evaluateOnValues(e: TExpr, self: Rec, principal?: EvalPrincipal): unknown {
  switch (e.t) {
    case "lit":
      return e.kind === "null" ? null : e.value;
    case "field": {
      if (!e.owner) return self[e.name] ?? null;
      const o = evaluateOnValues(e.owner, self, principal);
      if (o === null || o === undefined || typeof o !== "object" || Array.isArray(o)) return undefined;
      return (o as Rec)[e.name] ?? null;
    }
    case "enumValue":
      return e.value;
    case "not": {
      const v = evaluateOnValues(e.operand, self, principal);
      return typeof v === "boolean" ? !v : undefined;
    }
    case "isNull": {
      const v = evaluateOnValues(e.operand, self, principal);
      if (v === undefined) return undefined;
      return e.negate ? v !== null : v === null;
    }
    case "builtin": {
      const a = evaluateOnValues(e.args[0]!, self, principal);
      if (e.fn === "is_empty") return Array.isArray(a) || typeof a === "string" ? a.length === 0 : undefined;
      if (e.fn === "length") return Array.isArray(a) || typeof a === "string" ? a.length : undefined;
      // Only `contains` is evaluated besides the two above; arithmetic, time and collection functions
      // (sum, count, days, round, …) are "cannot tell", so no derived test relies on an approximation.
      if (e.fn !== "contains" || e.args.length < 2) return undefined;
      const b = evaluateOnValues(e.args[1]!, self, principal);
      if (!Array.isArray(a) || b === undefined) return undefined;
      const item = e.args[0]!.type.k === "list" ? (e.args[0]!.type as { item: Type }).item : undefined;
      const hits = a.map((x) => compare("==", x, b, item));
      return hits.includes(true) ? true : hits.includes(undefined) ? undefined : false;
    }
    case "binary": {
      if (e.op === "and" || e.op === "or") {
        const l = evaluateOnValues(e.left, self, principal);
        if (typeof l !== "boolean") return undefined;
        if (e.op === "and" && !l) return false;
        if (e.op === "or" && l) return true;
        const r = evaluateOnValues(e.right, self, principal);
        return typeof r === "boolean" ? r : undefined;
      }
      if (!COMPARISONS.has(e.op)) return undefined; // + - * / are not evaluated here (see above)
      const l = evaluateOnValues(e.left, self, principal);
      const r = evaluateOnValues(e.right, self, principal);
      if (l === undefined || r === undefined) return undefined;
      return compare(e.op, l, r, e.left.type);
    }
    case "principal":
      if (!principal) return undefined;
      if (e.member === "id") return principal.id;
      if (e.member === "roles") return principal.roles;
      return principal.claims[e.member] ?? null;
    case "hasRole":
      return principal ? principal.roles.includes(e.role) : undefined;
    default:
      // Parameters, locals, guards, ports and extensions have no value in a constructed object.
      return undefined;
  }
}

function compare(op: string, l: unknown, r: unknown, t: Type | undefined): boolean | undefined {
  if (l === null || r === null || !t) return undefined;
  const base = t.k === "optional" ? t.inner : t;
  let a: number | string | boolean;
  let b: number | string | boolean;
  if (base.k === "primitive") {
    switch (base.name) {
      case "Integer":
      case "Decimal":
        a = Number(l);
        b = Number(r);
        if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
        break;
      case "DateTime":
        a = Date.parse(String(l));
        b = Date.parse(String(r));
        if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
        break;
      case "UUID":
        a = String(l).toLowerCase();
        b = String(r).toLowerCase();
        break;
      case "Boolean":
        if (typeof l !== "boolean" || typeof r !== "boolean") return undefined;
        a = l;
        b = r;
        break;
      default:
        a = String(l);
        b = String(r);
    }
  } else if (base.k === "enum") {
    a = String(l);
    b = String(r);
  } else if (base.k === "ref") {
    a = String(l).toLowerCase();
    b = String(r).toLowerCase();
  } else {
    // Value objects, entities and lists: equality depends on normalization and number formats; do not guess.
    return undefined;
  }
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
  return undefined;
}

function walk(e: TExpr, fn: (n: TExpr) => void): void {
  fn(e);
  switch (e.t) {
    case "field":
      if (e.owner) walk(e.owner, fn);
      break;
    case "guard":
      if (e.receiver) walk(e.receiver, fn);
      e.args.forEach((a) => walk(a, fn));
      break;
    case "builtin":
    case "extension":
      e.args.forEach((a) => walk(a, fn));
      break;
    case "not":
    case "isNull":
      walk(e.operand, fn);
      break;
    case "binary":
      walk(e.left, fn);
      walk(e.right, fn);
      break;
  }
}
