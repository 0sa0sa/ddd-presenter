/**
 * Symbolic values of the rule language for Z3 (docs/09 §29). A typed expression (`TExpr`) evaluates to a `V`: Z3 terms
 * shaped like the runtime value. Integer → Int, Decimal → Real (exact, as decimal.js / Python Decimal), DateTime /
 * Date / Duration → Int milliseconds (a Date is a whole day), String / UUID / Ref → an Int standing for the value (equal
 * or not) with an uninterpreted length, enums → Int index, optional → (null flag, value), value objects / entities →
 * records, lists → slots that are each present or not (every list function the language has is order-independent,
 * so a list is the set of its present slots; `append` adds a slot).
 *
 * Building a value object or an entity (and `with`) records the checks the generated code runs on it (its
 * constraints and invariants), each with the condition under which it runs.
 */
import { rationalOf, type Smt, type T } from "./smt.ts";
import { formatPath, type AggregateIR, type Constraints, type ContextAnalysis, type EntityIR, type FieldIR, type InvariantIR, type ProofSource, type TExpr, type Type, type ValueObjectIR } from "@ddd/core";

export type Z3 = Smt;
export type ZBool = T;
export type ZArith = T;
type Fn = { call(x: T): T };

export type V =
  | { k: "bool"; e: ZBool }
  | { k: "int"; e: ZArith }
  | { k: "real"; e: ZArith }
  /** Milliseconds: an instant, a date (a multiple of a day) or a duration. */
  | { k: "time"; e: ZArith; unit: "instant" | "date" | "duration" }
  /** A string, UUID or reference: equal or not; strings have a length. */
  | { k: "atom"; e: ZArith; of: "string" | "uuid" }
  | { k: "enum"; e: ZArith; name: string; values: string[] }
  | { k: "opt"; isNull: ZBool; v: V }
  | { k: "null" }
  | { k: "rec"; name: string; kind: "vo" | "entity" | "aggregate"; fields: Map<string, V> }
  | { k: "list"; item: Type; slots: Slot[] };

export interface Slot {
  present: ZBool;
  v: V;
}

/** A check the generated code runs while building a value: it rejects when `when` holds and `ok` does not. */
export interface Check {
  source: ProofSource;
  ok: ZBool;
  when: ZBool;
}

export class Unsupported extends Error {}

const DAY = 86_400_000;
const UNIT_MS = { days: DAY, hours: 3_600_000, minutes: 60_000 } as const;

interface Env {
  self?: Extract<V, { k: "rec" }>;
  params: Map<string, V>;
  /** Elements bound by collection functions, outermost first. */
  items: V[];
  /** Condition under which the expression is evaluated (and its checks run). */
  when: ZBool;
}

export interface Bounds {
  /** Slots of a list field of the aggregate root, by field name. */
  list(owner: string, field: string): number;
}

export class Encoder {
  readonly z: Z3;
  readonly ca: ContextAnalysis;
  readonly strLen: Fn;
  /** Facts about the fresh values (well-formedness, the assumed invariants): asserted at once, for every query. */
  readonly facts = { push: (...xs: T[]) => xs.forEach((x) => this.z.assert(x)) };
  /** Checks recorded while evaluating, in evaluation order. */
  checks: Check[] = [];
  private literals = new Map<string, number>();
  private counter = 0;
  private normalizers = new Map<string, Fn>();
  /** Set when a list bound limited what was checked. */
  usedLists = false;

  constructor(
    z: Z3,
    ca: ContextAnalysis,
    readonly bounds: Bounds,
  ) {
    this.z = z;
    this.ca = ca;
    this.strLen = z.Function.declare("len");
  }

  name(prefix: string): string {
    return `${prefix}!${this.counter++}`;
  }

  /** The Int standing for a string literal (literals are negative, so no fresh value is one by accident of naming). */
  literal(s: string): ZArith {
    let id = this.literals.get(s);
    if (id === undefined) {
      id = -(this.literals.size + 1);
      this.literals.set(s, id);
      this.facts.push(this.strLen.call(this.z.Int.val(id)).eq([...s].length));
    }
    return this.z.Int.val(id);
  }

  literalOf(id: bigint): string | undefined {
    for (const [s, n] of this.literals) if (BigInt(n) === id) return s;
    return undefined;
  }

  len(e: ZArith): ZArith {
    return this.strLen.call(e) as ZArith;
  }

  // -------------------------------------------------------------------------
  // Types and fresh values
  // -------------------------------------------------------------------------

  fieldTypes(owner: string): Map<string, Type> {
    const m = this.ca.fieldTypes.get(owner);
    if (!m) throw new Unsupported(`no field types for ${owner}`);
    return m;
  }

  vo(name: string): ValueObjectIR | undefined {
    return this.ca.ir.valueObjects.find((v) => v.name === name);
  }

  entity(name: string): EntityIR | undefined {
    for (const ag of this.ca.ir.aggregates) {
      if (ag.name === name) return ag;
      const e = ag.entities.find((x) => x.name === name);
      if (e) return e;
    }
    return undefined;
  }

  ownerFields(name: string): FieldIR[] {
    const o = this.vo(name) ?? this.entity(name);
    if (!o) throw new Unsupported(`unknown type ${name}`);
    return o.fields;
  }

  /**
   * A fresh value of type `t`. With `valid`, it satisfies its own constraints and invariants (value objects and
   * entities as the code builds them; `owner`/`field` give the field's constraints and list bound).
   */
  fresh(t: Type, prefix: string, valid: boolean, slots = 2): V {
    const z = this.z;
    switch (t.k) {
      case "optional": {
        const isNull = z.Bool.const(this.name(`${prefix}?null`));
        return { k: "opt", isNull, v: this.fresh(t.inner, prefix, valid, slots) };
      }
      case "primitive":
        switch (t.name) {
          case "Boolean":
            return { k: "bool", e: z.Bool.const(this.name(prefix)) };
          case "Integer":
            return { k: "int", e: z.Int.const(this.name(prefix)) };
          case "Decimal":
            return { k: "real", e: z.Real.const(this.name(prefix)) };
          case "DateTime":
            return { k: "time", e: z.Int.const(this.name(prefix)), unit: "instant" };
          case "Date": {
            const e = z.Int.const(this.name(prefix));
            this.facts.push(e.mod(DAY).eq(0));
            return { k: "time", e, unit: "date" };
          }
          case "String": {
            const e = z.Int.const(this.name(prefix));
            this.facts.push(this.len(e).ge(0));
            return { k: "atom", e, of: "string" };
          }
          case "UUID":
            return { k: "atom", e: z.Int.const(this.name(prefix)), of: "uuid" };
        }
        break;
      case "ref":
        return { k: "atom", e: z.Int.const(this.name(prefix)), of: "uuid" };
      case "enum": {
        const en = this.ca.ir.enums.find((x) => x.name === t.name);
        if (!en) throw new Unsupported(`unknown enum ${t.name}`);
        const e = z.Int.const(this.name(prefix));
        this.facts.push(e.ge(0), e.lt(en.values.length));
        return { k: "enum", e, name: en.name, values: en.values };
      }
      case "vo":
      case "entity":
      case "aggregate": {
        const types = this.fieldTypes(t.name);
        const fields = new Map<string, V>();
        for (const f of this.ownerFields(t.name)) fields.set(f.name, this.fresh(types.get(f.name)!, `${prefix}.${f.name}`, valid, slots));
        const rec: V = { k: "rec", name: t.name, kind: t.k === "vo" ? "vo" : t.k === "entity" ? "entity" : "aggregate", fields };
        if (valid) this.assumeValid(rec);
        return rec;
      }
      case "list": {
        this.usedLists = true;
        const out: Slot[] = [];
        for (let i = 0; i < slots; i++) out.push({ present: z.Bool.const(this.name(`${prefix}#${i}?`)), v: this.fresh(t.item, `${prefix}#${i}`, valid, Math.min(slots, 2)) });
        return { k: "list", item: t.item, slots: out };
      }
    }
    throw new Unsupported(`values of type ${t.k} are not encoded`);
  }

  /** Facts: the record's field constraints and its invariants (all of them: construct and transition) hold. */
  assumeValid(rec: Extract<V, { k: "rec" }>): void {
    const owner = this.vo(rec.name) ?? this.entity(rec.name);
    if (!owner) return;
    for (const f of owner.fields) {
      const v = rec.fields.get(f.name);
      if (v) this.facts.push(this.constraint(f.constraints, v));
    }
    for (const inv of owner.invariants) this.facts.push(this.invariant(owner, inv, rec));
  }

  /** The invariant's expression evaluated on `rec` (checks it records are dropped: invariants build nothing). */
  invariant(owner: { name: string; fields: FieldIR[] }, inv: InvariantIR, rec: Extract<V, { k: "rec" }>): ZBool {
    const e = this.ca.exprs.get(formatPath([...inv.path, "expression"]));
    if (!e) throw new Unsupported(`invariant ${owner.name}.${inv.name} did not type-check`);
    const saved = this.checks;
    this.checks = [];
    try {
      return this.bool(this.ev(e, { self: rec, params: new Map(), items: [], when: this.z.Bool.val(true) }));
    } finally {
      this.checks = saved;
    }
  }

  /** The field constraints as a condition on `v` (true for an absent optional value). */
  constraint(c: Constraints, v: V): ZBool {
    const z = this.z;
    if (v.k === "opt") return z.Or(v.isNull, this.constraint(c, v.v));
    const parts: ZBool[] = [];
    if (v.k === "atom" && v.of === "string") {
      if (c.min_length !== undefined) parts.push(this.len(v.e).ge(c.min_length));
      if (c.max_length !== undefined) parts.push(this.len(v.e).le(c.max_length));
    }
    if (v.k === "int" || v.k === "real") {
      const num = (n: number) => (v.k === "int" ? n : z.Real.val(String(n)));
      if (c.min !== undefined) parts.push(v.e.ge(num(c.min) as never));
      if (c.max !== undefined) parts.push(v.e.le(num(c.max) as never));
      if (v.k === "real" && c.decimal_places !== undefined) {
        // A whole number of the smallest unit: x * 10^p is an integer (no fresh variable: the check may be negated).
        parts.push(z.IsInt(v.e.mul(z.Real.val(String(10 ** c.decimal_places)))));
      }
    }
    if (v.k === "list") {
      const n = this.count(v);
      if (c.min_items !== undefined) parts.push(n.ge(c.min_items));
      if (c.max_items !== undefined) parts.push(n.le(c.max_items));
    }
    return parts.length ? z.And(...parts) : z.Bool.val(true);
  }

  count(l: Extract<V, { k: "list" }>, pred?: (s: Slot) => ZBool): ZArith {
    const z = this.z;
    if (!l.slots.length) return z.Int.val(0);
    return z.Sum(z.Int.val(0), ...l.slots.map((s) => z.If(pred ? z.And(s.present, pred(s)) : s.present, z.Int.val(1), z.Int.val(0)) as ZArith));
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  bool(v: V): ZBool {
    const u = unwrap(v);
    if (u.k !== "bool") throw new Unsupported(`expected a boolean, got ${u.k}`);
    return u.e;
  }

  evalIn(e: TExpr, self: Extract<V, { k: "rec" }> | undefined, params: Map<string, V>, when?: ZBool): V {
    return this.ev(e, { self, params, items: [], when: when ?? this.z.Bool.val(true) });
  }

  ev(e: TExpr, env: Env): V {
    const z = this.z;
    switch (e.t) {
      case "lit":
        switch (e.kind) {
          case "null":
            return { k: "null" };
          case "boolean":
            return { k: "bool", e: z.Bool.val(e.value as boolean) };
          case "integer":
            return { k: "int", e: z.Int.val(Number(e.value)) };
          case "decimal":
            return { k: "real", e: z.Real.val(String(e.value)) };
          case "string":
            return { k: "atom", e: this.literal(String(e.value)), of: "string" };
        }
        break;
      case "field": {
        const owner = e.owner ? unwrap(this.ev(e.owner, env)) : env.self;
        if (!owner || owner.k !== "rec") throw new Unsupported(`field ${e.name} of a non-record`);
        const v = owner.fields.get(e.name);
        if (!v) throw new Unsupported(`unknown field ${e.name}`);
        return v;
      }
      case "param": {
        const v = env.params.get(e.name);
        if (!v) throw new Unsupported(`unbound parameter ${e.name}`);
        return v;
      }
      case "item": {
        const v = env.items[e.depth];
        if (!v) throw new Unsupported("item outside a collection function");
        return v;
      }
      case "enumValue": {
        const en = this.ca.ir.enums.find((x) => x.name === e.enumName)!;
        return { k: "enum", e: z.Int.val(en.values.indexOf(e.value)), name: en.name, values: en.values };
      }
      case "guard": {
        const ag = env.self && this.ca.ir.aggregates.find((a) => a.name === e.aggregate);
        if (e.receiver || !ag || env.self!.name !== ag.name) throw new Unsupported(`guard ${e.guard} on another value`);
        const g = ag.stateGuards.find((x) => x.name === e.guard);
        const body = g && this.ca.exprs.get(formatPath([...g.path, "expression"]));
        if (!g || !body) throw new Unsupported(`guard ${e.guard} did not type-check`);
        const params = new Map<string, V>();
        g.parameters.forEach((p, i) => {
          const a = e.args[i];
          if (a) params.set(p.name, this.ev(a, env));
        });
        return this.ev(body, { self: env.self, params, items: [], when: env.when });
      }
      case "not":
        return { k: "bool", e: z.Not(this.bool(this.ev(e.operand, env))) };
      case "isNull": {
        const v = this.ev(e.operand, env);
        const isNull = v.k === "opt" ? v.isNull : z.Bool.val(v.k === "null");
        return { k: "bool", e: e.negate ? z.Not(isNull) : isNull };
      }
      case "neg": {
        const v = unwrap(this.ev(e.operand, env));
        if (v.k === "int" || v.k === "real") return { ...v, e: v.e.neg() };
        if (v.k === "time") return { ...v, e: v.e.neg() };
        throw new Unsupported("negation of a non-number");
      }
      case "binary":
        return this.binary(e, env);
      case "builtin":
        return this.builtin(e, env);
      case "list": {
        const item = (e.type.k === "list" ? e.type.item : undefined) as Type;
        return { k: "list", item, slots: e.items.map((x) => ({ present: z.Bool.val(true), v: this.ev(x, env) })) };
      }
      case "construct": {
        const fields = new Map<string, V>();
        for (const f of e.fields) fields.set(f.name, this.coerce(this.ev(f.value, env), f.fieldType));
        const rec: Extract<V, { k: "rec" }> = { k: "rec", name: e.name, kind: e.kind, fields };
        // Fields not given are absent (optional) values.
        for (const f of this.ownerFields(e.name)) if (!fields.has(f.name)) fields.set(f.name, { k: "null" });
        return this.built(rec, env.when);
      }
      case "with": {
        const target = unwrap(this.ev(e.target, env));
        if (target.k !== "rec") throw new Unsupported("with() on a non-record");
        const fields = new Map(target.fields);
        for (const f of e.fields) fields.set(f.name, this.coerce(this.ev(f.value, env), f.fieldType));
        return this.built({ ...target, fields }, env.when);
      }
      default:
        throw new Unsupported(`${e.t} is not encoded (use cases, extension points, ports and principals are out of scope)`);
    }
    throw new Unsupported(`literal ${String((e as { value?: unknown }).value)}`);
  }

  /** Records the checks of building `rec` (normalization, constraints, invariants) and returns the built value. */
  built(rec: Extract<V, { k: "rec" }>, when: ZBool): V {
    const vo = this.vo(rec.name);
    const owner = vo ?? this.entity(rec.name);
    if (!owner) throw new Unsupported(`unknown type ${rec.name}`);
    if (vo) {
      for (const [field, steps] of Object.entries(vo.normalize)) {
        const v = rec.fields.get(field);
        if (v) rec.fields.set(field, this.normalized(v, steps));
      }
    }
    const kind = vo ? "vo-invariant" : "entity-invariant";
    for (const f of owner.fields) {
      const v = rec.fields.get(f.name);
      if (!v || !hasConstraints(f.constraints)) continue;
      this.checks.push({ source: constraintSource(owner.name, f), ok: this.constraint(f.constraints, v), when });
    }
    for (const inv of owner.invariants) {
      if (!vo && !inv.checkOn.includes("construct")) continue;
      this.checks.push({ source: invariantSource(owner.name, inv, kind), ok: this.invariant(owner, inv, rec), when });
    }
    return rec;
  }

  /** A normalized string (strip / lower / upper): another string; stripping never makes it longer. */
  normalized(v: V, steps: string[]): V {
    if (v.k === "opt") return { ...v, v: this.normalized(v.v, steps) };
    if (v.k !== "atom" || v.of !== "string") return v;
    const key = steps.join("+");
    let f = this.normalizers.get(key);
    if (!f) {
      f = this.z.Function.declare(`norm_${key.replace(/\W/g, "_")}`);
      this.normalizers.set(key, f);
    }
    const out = f.call(v.e) as ZArith;
    this.facts.push(steps.includes("strip") ? this.len(out).le(this.len(v.e)) : this.len(out).eq(this.len(v.e)));
    this.facts.push(this.len(out).ge(0));
    return { k: "atom", e: out, of: "string" };
  }

  /** An Integer where a Decimal is expected becomes a Real. */
  coerce(v: V, t: Type): V {
    const base = t.k === "optional" ? t.inner : t;
    if (v.k === "int" && base.k === "primitive" && base.name === "Decimal") return { k: "real", e: this.z.ToReal(v.e) };
    if (v.k === "opt" && v.v.k === "int" && base.k === "primitive" && base.name === "Decimal") return { ...v, v: { k: "real", e: this.z.ToReal(v.v.e) } };
    if (v.k === "list" && base.k === "list") return { ...v, item: base.item, slots: v.slots.map((s) => ({ ...s, v: this.coerce(s.v, base.item) })) };
    return v;
  }

  private binary(e: Extract<TExpr, { t: "binary" }>, env: Env): V {
    const z = this.z;
    if (e.op === "and" || e.op === "or") {
      const l = this.bool(this.ev(e.left, env));
      // The right operand runs only when the left one does not decide (its checks too).
      const r = this.bool(this.ev(e.right, { ...env, when: z.And(env.when, e.op === "and" ? l : z.Not(l)) }));
      return { k: "bool", e: e.op === "and" ? z.And(l, r) : z.Or(l, r) };
    }
    const l = this.ev(e.left, env);
    const r = this.ev(e.right, env);
    if (e.op === "==" || e.op === "!=") {
      const eq = this.eq(l, r);
      return { k: "bool", e: e.op === "==" ? eq : z.Not(eq) };
    }
    const a = unwrap(l);
    const b = unwrap(r);
    if (e.op === "<" || e.op === "<=" || e.op === ">" || e.op === ">=") {
      const [x, y] = this.numbers(a, b);
      const out = e.op === "<" ? x.lt(y) : e.op === "<=" ? x.le(y) : e.op === ">" ? x.gt(y) : x.ge(y);
      return { k: "bool", e: out };
    }
    // Arithmetic.
    if (a.k === "time" || b.k === "time") {
      if (a.k === "time" && b.k === "time") {
        const out = e.op === "+" ? a.e.add(b.e) : e.op === "-" ? a.e.sub(b.e) : undefined;
        if (!out) throw new Unsupported(`${e.op} on times`);
        const unit = a.unit === "duration" && b.unit === "duration" ? "duration" : e.op === "-" && a.unit !== "duration" && b.unit !== "duration" ? "duration" : a.unit === "duration" ? b.unit : a.unit;
        return { k: "time", e: out, unit };
      }
      // Duration * Integer.
      const [d, n] = a.k === "time" ? [a, b] : [b as Extract<V, { k: "time" }>, a];
      if (e.op === "*" && n.k === "int") return { k: "time", e: d.e.mul(n.e), unit: "duration" };
      throw new Unsupported(`${e.op} on a time and a ${n.k}`);
    }
    if (e.op === "/") {
      const [x, y] = [this.real(a), this.real(b)];
      return { k: "real", e: x.div(y) };
    }
    if (a.k === "int" && b.k === "int") {
      return { k: "int", e: e.op === "+" ? a.e.add(b.e) : e.op === "-" ? a.e.sub(b.e) : a.e.mul(b.e) };
    }
    const [x, y] = [this.real(a), this.real(b)];
    return { k: "real", e: e.op === "+" ? x.add(y) : e.op === "-" ? x.sub(y) : x.mul(y) };
  }

  real(v: V): ZArith {
    if (v.k === "real") return v.e;
    if (v.k === "int") return this.z.ToReal(v.e);
    throw new Unsupported(`expected a number, got ${v.k}`);
  }

  private numbers(a: V, b: V): [ZArith, ZArith] {
    if (a.k === "int" && b.k === "int") return [a.e, b.e];
    if ((a.k === "int" || a.k === "real") && (b.k === "int" || b.k === "real")) return [this.real(a), this.real(b)];
    if (a.k === "time" && b.k === "time") return [a.e, b.e];
    if (a.k === "atom" && b.k === "atom") throw new Unsupported("ordering strings");
    throw new Unsupported(`ordering ${a.k} and ${b.k}`);
  }

  /** Equality by type: numbers by value, records field by field, null against an optional's flag. */
  eq(a: V, b: V): ZBool {
    const z = this.z;
    if (a.k === "null" && b.k === "null") return z.Bool.val(true);
    if (a.k === "null") return this.eq(b, a);
    if (b.k === "null") return a.k === "opt" ? a.isNull : z.Bool.val(false);
    if (a.k === "opt" && b.k === "opt") return z.Or(z.And(a.isNull, b.isNull), z.And(z.Not(a.isNull), z.Not(b.isNull), this.eq(a.v, b.v)));
    if (a.k === "opt") return z.And(z.Not(a.isNull), this.eq(a.v, b));
    if (b.k === "opt") return this.eq(b, a);
    if (a.k === "bool" && b.k === "bool") return a.e.eq(b.e);
    if ((a.k === "int" || a.k === "real") && (b.k === "int" || b.k === "real")) {
      const [x, y] = this.numbers(a, b);
      return x.eq(y);
    }
    if ((a.k === "time" && b.k === "time") || (a.k === "atom" && b.k === "atom") || (a.k === "enum" && b.k === "enum")) return a.e.eq(b.e);
    if (a.k === "rec" && b.k === "rec") {
      const parts = [...a.fields].map(([n, v]) => {
        const w = b.fields.get(n);
        return w ? this.eq(v, w) : z.Bool.val(false);
      });
      return parts.length ? z.And(...parts) : z.Bool.val(true);
    }
    throw new Unsupported(`comparing ${a.k} with ${b.k}`);
  }

  private builtin(e: Extract<TExpr, { t: "builtin" }>, env: Env): V {
    const z = this.z;
    const arg = (i: number) => unwrap(this.ev(e.args[i]!, env));
    const list = (i: number): Extract<V, { k: "list" }> => {
      const v = arg(i);
      if (v.k !== "list") throw new Unsupported(`${e.fn}() on a non-list`);
      return v;
    };
    /** The per-element argument `i` for a slot, its checks guarded by the slot being present (and `extra`). */
    const per = (i: number, s: Slot, extra?: ZBool) => this.ev(e.args[i]!, { ...env, items: [...env.items, s.v], when: z.And(env.when, s.present, ...(extra ? [extra] : [])) });
    switch (e.fn) {
      case "is_empty":
      case "length": {
        const v = arg(0);
        const n = v.k === "list" ? this.count(v) : v.k === "atom" && v.of === "string" ? this.len(v.e) : undefined;
        if (!n) throw new Unsupported(`${e.fn}() of ${v.k}`);
        return e.fn === "length" ? { k: "int", e: n } : { k: "bool", e: n.eq(0) };
      }
      case "contains": {
        const v = arg(0);
        if (v.k !== "list") throw new Unsupported("contains() on a string");
        const x = this.ev(e.args[1]!, env);
        return { k: "bool", e: v.slots.length ? z.Or(...v.slots.map((s) => z.And(s.present, this.eq(s.v, x)))) : z.Bool.val(false) };
      }
      case "days":
      case "hours":
      case "minutes": {
        const n = arg(0);
        if (n.k !== "int") throw new Unsupported(`${e.fn}() of ${n.k}`);
        return { k: "time", e: n.e.mul(UNIT_MS[e.fn]), unit: "duration" };
      }
      case "round": {
        const x = this.real(arg(0));
        const places = Number((e.args[1] as { value: number }).value);
        const scale = z.Real.val(String(10 ** places));
        // Half up (away from zero at .5), as decimal.js ROUND_HALF_UP and Python ROUND_HALF_UP.
        const i = z.Int.const(this.name("round"));
        const d = x.mul(scale);
        const ri = z.ToReal(i);
        const half = z.Real.val("1/2");
        this.facts.push(z.If(d.ge(0), z.And(ri.le(d.add(half)), d.add(half).lt(ri.add(1))), z.And(ri.sub(1).lt(d.sub(half)), d.sub(half).le(ri))) as ZBool);
        return { k: "real", e: ri.div(scale) };
      }
      case "min":
      case "max": {
        const a = arg(0);
        const b = arg(1);
        const [x, y] = this.numbers(a, b);
        const pick = e.fn === "min" ? x.le(y) : x.ge(y);
        const out = z.If(pick, x, y) as ZArith;
        if (a.k === "time") return { k: "time", e: out, unit: a.unit };
        return a.k === "int" && b.k === "int" ? { k: "int", e: out } : { k: "real", e: out };
      }
      case "count": {
        const l = list(0);
        return { k: "int", e: this.count(l, e.args.length > 1 ? (s) => this.bool(per(1, s)) : undefined) };
      }
      case "sum": {
        const l = list(0);
        const decimal = e.type.k === "primitive" && e.type.name === "Decimal";
        const terms = l.slots.map((s) => {
          const v = e.args.length > 1 ? unwrap(per(1, s)) : unwrap(s.v);
          const n = decimal ? this.real(v) : v.k === "int" ? v.e : this.real(v);
          return z.If(s.present, n, decimal ? z.Real.val("0") : z.Int.val(0)) as ZArith;
        });
        if (!terms.length) return decimal ? { k: "real", e: z.Real.val("0") } : { k: "int", e: z.Int.val(0) };
        return { k: decimal ? "real" : "int", e: z.Sum(terms[0]!, ...terms.slice(1)) } as V;
      }
      case "any":
      case "all": {
        const l = list(0);
        if (!l.slots.length) return { k: "bool", e: z.Bool.val(e.fn === "all") };
        const parts = l.slots.map((s) => (e.fn === "any" ? z.And(s.present, this.bool(per(1, s))) : z.Implies(s.present, this.bool(per(1, s)))));
        return { k: "bool", e: e.fn === "any" ? z.Or(...parts) : z.And(...parts) };
      }
      case "append": {
        const l = list(0);
        const x = this.coerce(this.ev(e.args[1]!, env), l.item);
        return { ...l, slots: [...l.slots, { present: z.Bool.val(true), v: x }] };
      }
      case "remove": {
        const l = list(0);
        const x = this.ev(e.args[1]!, env);
        return { ...l, slots: l.slots.map((s) => ({ present: z.And(s.present, z.Not(this.eq(s.v, x))), v: s.v })) };
      }
      case "remove_where": {
        const l = list(0);
        return { ...l, slots: l.slots.map((s) => ({ present: z.And(s.present, z.Not(this.bool(per(1, s)))), v: s.v })) };
      }
      case "replace_where": {
        const l = list(0);
        return {
          ...l,
          slots: l.slots.map((s) => {
            const hit = this.bool(per(1, s));
            const next = this.coerce(per(2, s, hit), l.item);
            return { present: s.present, v: this.ite(hit, next, s.v) };
          }),
        };
      }
    }
  }

  /** `c ? a : b` over values of the same shape. */
  ite(c: ZBool, a: V, b: V): V {
    const z = this.z;
    if (a.k === "rec" && b.k === "rec") {
      const fields = new Map<string, V>();
      for (const [n, v] of a.fields) fields.set(n, this.ite(c, v, b.fields.get(n) ?? v));
      return { ...a, fields };
    }
    if (a.k === "opt" && b.k === "opt") return { k: "opt", isNull: z.If(c, a.isNull, b.isNull) as ZBool, v: this.ite(c, a.v, b.v) };
    if (a.k === "null" && b.k === "opt") return { k: "opt", isNull: z.Or(c, b.isNull), v: b.v };
    if (a.k === "opt" && b.k === "null") return { k: "opt", isNull: z.Or(z.Not(c), a.isNull), v: a.v };
    if (a.k === "opt" && b.k !== "opt") return this.ite(c, a, { k: "opt", isNull: z.Bool.val(false), v: b });
    if (b.k === "opt" && a.k !== "opt") return this.ite(c, { k: "opt", isNull: z.Bool.val(false), v: a }, b);
    if (a.k === "list" && b.k === "list") {
      const n = Math.max(a.slots.length, b.slots.length);
      const slots: Slot[] = [];
      for (let i = 0; i < n; i++) {
        const x = a.slots[i];
        const y = b.slots[i];
        if (x && y) slots.push({ present: z.If(c, x.present, y.present) as ZBool, v: this.ite(c, x.v, y.v) });
        else if (x) slots.push({ present: z.And(c, x.present), v: x.v });
        else slots.push({ present: z.And(z.Not(c), y!.present), v: y!.v });
      }
      return { ...a, slots };
    }
    if (a.k === "real" && b.k === "int") return { k: "real", e: z.If(c, a.e, z.ToReal(b.e)) as ZArith };
    if (a.k === "int" && b.k === "real") return { k: "real", e: z.If(c, z.ToReal(a.e), b.e) as ZArith };
    if (a.k === b.k && "e" in a && "e" in b) return { ...a, e: z.If(c, a.e as never, b.e as never) } as V;
    throw new Unsupported(`choosing between ${a.k} and ${b.k}`);
  }

  // -------------------------------------------------------------------------
  // Reading a model back
  // -------------------------------------------------------------------------

  /** The terms whose values `read` needs. */
  leaves(v: V, out: T[] = []): T[] {
    switch (v.k) {
      case "bool":
      case "int":
      case "real":
      case "time":
      case "enum":
        out.push(v.e);
        break;
      case "atom":
        out.push(v.e);
        if (v.of === "string") out.push(this.len(v.e));
        break;
      case "opt":
        out.push(v.isNull);
        this.leaves(v.v, out);
        break;
      case "rec":
        for (const f of v.fields.values()) this.leaves(f, out);
        break;
      case "list":
        for (const s of v.slots) {
          out.push(s.present);
          this.leaves(s.v, out);
        }
        break;
    }
    return out;
  }

  /** The value of `v` from the values of its leaves, as scenario data (decimals, instants and dates are strings). */
  read(vals: Map<string, string>, v: V): unknown {
    const raw = (t: T) => vals.get(t.s);
    const int = (t: T): bigint => {
      const r = rationalOf(raw(t) ?? "0");
      return r ? r[0] / r[1] : 0n;
    };
    const flag = (t: T) => raw(t) === "true";
    switch (v.k) {
      case "bool":
        return flag(v.e);
      case "int":
        return Number(int(v.e));
      case "real": {
        const r = rationalOf(raw(v.e) ?? "0");
        return r ? fraction(r[0], r[1]) : raw(v.e);
      }
      case "time": {
        const ms = Number(int(v.e));
        if (v.unit === "duration") return `${ms / 1000}s`;
        const at = new Date(BASE + ms);
        if (Number.isNaN(at.getTime())) return `${ms}ms`;
        const iso = at.toISOString();
        return v.unit === "date" ? iso.slice(0, 10) : iso.replace(".000Z", "+00:00");
      }
      case "atom": {
        const id = int(v.e);
        if (v.of === "uuid") return uuidOf(id);
        const lit = this.literalOf(id);
        if (lit !== undefined) return lit;
        return placeholder(id, Math.max(0, Number(int(this.len(v.e)))));
      }
      case "enum":
        return v.values[Number(int(v.e))] ?? v.values[0];
      case "opt":
        return flag(v.isNull) ? null : this.read(vals, v.v);
      case "null":
        return null;
      case "rec": {
        const out: Record<string, unknown> = {};
        for (const [n, f] of v.fields) out[n] = this.read(vals, f);
        return out;
      }
      case "list":
        return v.slots.filter((s) => flag(s.present)).map((s) => this.read(vals, s.v));
    }
  }
}

/** Instants are milliseconds from 2026-01-01T00:00:00Z (a readable origin for counterexamples). */
const BASE = Date.UTC(2026, 0, 1);

export function unwrap(v: V): V {
  return v.k === "opt" ? v.v : v;
}

export function hasConstraints(c: Constraints): boolean {
  return Object.values(c).some((x) => x !== undefined && typeof x !== "string");
}

export function constraintText(c: Constraints): string {
  return Object.entries(c)
    .filter(([k, x]) => x !== undefined && k !== "pattern")
    .map(([k, x]) => `${k}: ${x}`)
    .join(", ");
}

export function constraintSource(owner: string, f: FieldIR): ProofSource {
  return { kind: "constraint", owner, name: f.name, error: "ConstraintViolation", expression: constraintText(f.constraints), path: f.path };
}

export function invariantSource(owner: string, inv: InvariantIR, kind: ProofSource["kind"]): ProofSource {
  return { kind, owner, name: inv.name, error: inv.error, ...(inv.description ? { description: inv.description } : {}), expression: inv.expression, path: inv.path };
}

/** A rational as a decimal string: exact when it terminates ("3.5"), else 10 places. */
export function fraction(num: bigint, den: bigint): string {
  const neg = num < 0n !== den < 0n && num !== 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const whole = n / d;
  let rest = n % d;
  let digits = "";
  for (let i = 0; i < 10 && rest !== 0n; i++) {
    rest *= 10n;
    digits += (rest / d).toString();
    rest %= d;
  }
  return `${neg ? "-" : ""}${whole}${digits ? `.${digits}` : ""}`;
}

function uuidOf(id: bigint): string {
  const n = id < 0n ? -id : id;
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0").slice(-12)}`;
}

/** A readable string of length `n` standing for the value `id`: one letter per value ("ccc"); different ids, different letters. */
function placeholder(id: bigint, n: number): string {
  const i = Number((id < 0n ? -id : id) % 26n);
  return String.fromCharCode(97 + i).repeat(n);
}

export type { AggregateIR };
