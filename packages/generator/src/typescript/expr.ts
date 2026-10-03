import { exprChildren, type TExpr, type Type } from "@ddd/core";
import { tsString, type TsImports } from "./code.ts";
import type { TsLayout } from "./layout.ts";
import { ident, prop } from "./names.ts";
import { isDecimal, isPrim, strip } from "./types.ts";

/**
 * TypeScript emission of typed rule expressions.
 *
 * The model's operators are value operators, so emission is type-directed: Decimal arithmetic and comparisons
 * become decimal.js method calls (exact, never floating point), date-times compare by `getTime()`, value objects /
 * lists / optional decimals compare with the runtime `equals`, durations are milliseconds.
 */
export interface ExprContext {
  L: TsLayout;
  imports: TsImports;
  /** Expression for the current object (`this`, `self`, `aggregate`). */
  self: string;
  /** Type that declares the bare field names (for identity brands and narrowing). */
  selfOwner?: string;
  /** Declared types of the parameters in scope (bare names after destructuring). */
  params?: Map<string, Type>;
  /** Command inputs (emitted as `command.<name>`) and their declared types. */
  inputs?: Map<string, Type>;
  /** Locals with a fixed spelling (policy `event`). */
  fixedLocals?: Set<string>;
  ports?: { clock: string; ids: string; extensions: string };
  /** How guard references are consumed: boolean check (default) or throwing. */
  guardMode?: "checks" | "assertHolds";
  /** Inside an element callback (`(item) => …`): narrowed property paths need a non-null assertion. */
  callbacks?: number;
}

/** Precedence: conditional < || < && < equality < relational < additive < multiplicative < unary < member/call. */
const P = { cond: 0, or: 1, and: 2, eq: 3, rel: 4, add: 5, mul: 6, unary: 7, atom: 8 } as const;
type Prec = (typeof P)[keyof typeof P];

type Out = [string, Prec];

export function emitExpr(e: TExpr, ctx: ExprContext): string {
  return emit(e, ctx)[0];
}

/** `!(<e>)`: the negated condition (parenthesized unless `e` is an atom). */
export function emitNegated(e: TExpr, ctx: ExprContext): string {
  // `not x` negated is `x` itself (never `!!(…)`, which typescript-eslint flags as a needless conversion).
  if (e.t === "not") return emit(e.operand, ctx)[0];
  return `!${wrap(emit(e, ctx), P.unary)}`;
}

/** Parameter names referenced anywhere in `e`. */
export function paramRefs(e: TExpr, out = new Set<string>()): Set<string> {
  if (e.t === "param") out.add(e.name);
  for (const c of exprChildren(e)) paramRefs(c, out);
  return out;
}

/** Emits `e` for a place that expects `target` (Integer → Decimal and identity brands are made explicit). */
export function emitAs(e: TExpr, target: Type | undefined, ctx: ExprContext): string {
  return emitCoerced(e, target, ctx)[0];
}

function wrap(o: Out, min: Prec): string {
  return o[1] < min ? `(${o[0]})` : o[0];
}

function isInt(t: Type): boolean {
  return isPrim(t, "Integer");
}

/** The type as the TypeScript code sees it: identity fields carry their owner's brand; narrowing is kept. */
export function actualType(e: TExpr, ctx: ExprContext): Type {
  if (e.t !== "field") return e.type;
  const owner = e.owner ? ownerName(e.owner.type) : ctx.selfOwner;
  const declared = owner ? ctx.L.tsFieldType(owner, e.name) : undefined;
  if (!declared) return e.type;
  return e.type.k !== "optional" ? strip(declared) : declared;
}

function ownerName(t: Type): string | undefined {
  const s = strip(t);
  return s.k === "vo" || s.k === "entity" || s.k === "aggregate" ? s.name : undefined;
}

/** Identity brand of a UUID-like type: the Ref target, "UUID" for a plain UUID, undefined otherwise. */
function brand(t: Type): string | undefined {
  const s = strip(t);
  if (s.k === "ref") return s.target;
  if (s.k === "primitive" && s.name === "UUID") return "UUID";
  return undefined;
}

function emitCoerced(e: TExpr, target: Type | undefined, ctx: ExprContext): Out {
  if (target && isDecimal(target) && isInt(e.type) && e.type.k !== "optional") return [decimal(e, ctx), P.atom];
  const list = target && strip(target);
  if (list?.k === "list" && e.t === "list") return listLiteral(e.items, list.item, ctx);
  const want = target ? brand(target) : undefined;
  const have = brand(actualType(e, ctx));
  if (want && want !== "UUID" && have && have !== want) {
    ctx.imports.type(ctx.L.runtime, "Id");
    const inner = wrap(emit(e, ctx), P.rel);
    // An `as` cast binds like a relational operator: callers that put it in a tighter position parenthesize it.
    if (have === "UUID") return [`${inner} as Id<${tsString(want)}>`, P.cond];
    ctx.imports.type(ctx.L.runtime, "UUID");
    return [`${inner} as UUID as Id<${tsString(want)}>`, P.cond];
  }
  return emit(e, ctx);
}

/** A Decimal-typed operand: Integers are converted with `new Decimal(...)`. */
function decimal(e: TExpr, ctx: ExprContext): string {
  if (isInt(e.type)) {
    ctx.imports.value(ctx.L.runtime, "Decimal");
    return `new Decimal(${emitExpr(e, ctx)})`;
  }
  return wrap(emit(e, ctx), P.atom);
}

function listLiteral(items: TExpr[], itemType: Type, ctx: ExprContext): Out {
  return [`[${items.map((x) => emitAs(x, itemType, ctx)).join(", ")}]`, P.atom];
}

/** `(item) => body` with the callback depth tracked for narrowing. */
function callback(ctx: ExprContext, body: (inner: ExprContext) => string): string {
  const inner = { ...ctx, callbacks: (ctx.callbacks ?? 0) + 1 };
  return `(item) => ${body(inner)}`;
}

function emitBuiltin(e: Extract<TExpr, { t: "builtin" }>, ctx: ExprContext): Out {
  const rt = (...names: string[]) => ctx.imports.value(ctx.L.runtime, ...names);
  const arg = (i: number) => emit(e.args[i]!, ctx);
  const atom = (i: number) => wrap(arg(i), P.atom);
  const inItem = (i: number, min: Prec = P.cond) => callback(ctx, (inner) => wrap(emit(e.args[i]!, inner), min));
  switch (e.fn) {
    case "is_empty":
      return [`${atom(0)}.length === 0`, P.eq];
    case "length":
      return [`${atom(0)}.length`, P.atom];
    case "contains":
      if (isPrim(e.args[0]!.type, "String")) return [`${atom(0)}.includes(${emitExpr(e.args[1]!, ctx)})`, P.atom];
      rt("contains");
      return [`contains(${emitExpr(e.args[0]!, ctx)}, ${emitExpr(e.args[1]!, ctx)})`, P.atom];
    case "days":
    case "hours":
    case "minutes":
      rt(e.fn);
      return [`${e.fn}(${emitExpr(e.args[0]!, ctx)})`, P.atom];
    case "round": {
      rt("Decimal");
      const places = Number((e.args[1] as { value: number }).value);
      return [`${decimal(e.args[0]!, ctx)}.toDecimalPlaces(${places}, Decimal.ROUND_HALF_UP)`, P.atom];
    }
    case "min":
    case "max": {
      const t = strip(e.type);
      if (isDecimal(t)) {
        rt("Decimal");
        return [`Decimal.${e.fn}(${emitExpr(e.args[0]!, ctx)}, ${emitExpr(e.args[1]!, ctx)})`, P.atom];
      }
      if (t.k === "primitive" && (t.name === "DateTime" || t.name === "Date")) {
        const fn = e.fn === "min" ? "earliest" : "latest";
        rt(fn);
        return [`${fn}(${emitExpr(e.args[0]!, ctx)}, ${emitExpr(e.args[1]!, ctx)})`, P.atom];
      }
      return [`Math.${e.fn}(${emitExpr(e.args[0]!, ctx)}, ${emitExpr(e.args[1]!, ctx)})`, P.atom];
    }
    case "count":
      if (e.args.length === 1) return [`${atom(0)}.length`, P.atom];
      return [`${atom(0)}.filter(${inItem(1)}).length`, P.atom];
    case "sum": {
      const fn = isDecimal(e.type) ? "sumDecimals" : "sumOf";
      rt(fn);
      const body = e.args.length === 1 ? "(item) => item" : inItem(1);
      return [`${fn}(${emitExpr(e.args[0]!, ctx)}, ${body})`, P.atom];
    }
    case "any":
      return [`${atom(0)}.some(${inItem(1)})`, P.atom];
    case "all":
      return [`${atom(0)}.every(${inItem(1)})`, P.atom];
    case "append": {
      const item = (strip(e.type) as { item: Type }).item;
      return [`[...${atom(0)}, ${emitAs(e.args[1]!, item, ctx)}]`, P.atom];
    }
    case "remove":
      rt("without");
      return [`without(${emitExpr(e.args[0]!, ctx)}, ${emitExpr(e.args[1]!, ctx)})`, P.atom];
    case "remove_where":
      return [`${atom(0)}.filter(${callback(ctx, (inner) => `!${wrap(emit(e.args[1]!, inner), P.unary)}`)})`, P.atom];
    case "replace_where": {
      const item = (strip(e.type) as { item: Type }).item;
      const body = callback(ctx, (inner) => `(${wrap(emit(e.args[1]!, inner), P.or)} ? ${emitAs(e.args[2]!, item, inner)} : item)`);
      return [`${atom(0)}.map(${body})`, P.atom];
    }
  }
}

/** Equality of two operands by their types (`===` for primitives, decimal.js / getTime / `equals` otherwise). */
function emitEquality(e: Extract<TExpr, { t: "binary" }>, ctx: ExprContext): Out {
  const neg = e.op === "!=";
  const lt = actualType(e.left, ctx);
  const rt_ = actualType(e.right, ctx);
  const optional = lt.k === "optional" || rt_.k === "optional";
  const l = strip(lt);
  const r = strip(rt_);
  const useEquals = () => {
    ctx.imports.value(ctx.L.runtime, "equals");
    const call = `equals(${emitExpr(e.left, ctx)}, ${emitExpr(e.right, ctx)})`;
    return (neg ? [`!${call}`, P.unary] : [call, P.atom]) as Out;
  };
  const decimalSide = isDecimal(l) || isDecimal(r);
  if (decimalSide) {
    if (optional) return useEquals();
    const [a, b] = isDecimal(l) ? [e.left, e.right] : [e.right, e.left];
    const call = `${decimal(a, ctx)}.eq(${emitExpr(b, ctx)})`;
    return neg ? [`!${call}`, P.unary] : [call, P.atom];
  }
  if (isPrim(l, "DateTime")) {
    if (optional) return useEquals();
    return [`${wrap(emit(e.left, ctx), P.atom)}.getTime() ${neg ? "!==" : "==="} ${wrap(emit(e.right, ctx), P.atom)}.getTime()`, P.eq];
  }
  if (l.k === "vo" || l.k === "entity" || l.k === "list" || r.k === "vo" || r.k === "entity" || r.k === "list") return useEquals();
  const bl = brand(l);
  const br = brand(r);
  if (bl && br && bl !== br && bl !== "UUID" && br !== "UUID") return useEquals();
  return [`${wrap(emit(e.left, ctx), P.rel)} ${neg ? "!==" : "==="} ${wrap(emit(e.right, ctx), P.rel)}`, P.eq];
}

const DECIMAL_COMPARE: Record<string, string> = { "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
const FLIPPED: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

function emitOrdering(e: Extract<TExpr, { t: "binary" }>, ctx: ExprContext): Out {
  const l = strip(e.left.type);
  const r = strip(e.right.type);
  if (isDecimal(l)) return [`${decimal(e.left, ctx)}.${DECIMAL_COMPARE[e.op]}(${emitExpr(e.right, ctx)})`, P.atom];
  if (isDecimal(r)) return [`${decimal(e.right, ctx)}.${DECIMAL_COMPARE[FLIPPED[e.op]!]}(${emitExpr(e.left, ctx)})`, P.atom];
  if (isPrim(l, "DateTime")) {
    return [`${wrap(emit(e.left, ctx), P.atom)}.getTime() ${e.op} ${wrap(emit(e.right, ctx), P.atom)}.getTime()`, P.rel];
  }
  return [`${wrap(emit(e.left, ctx), P.add)} ${e.op} ${wrap(emit(e.right, ctx), P.add)}`, P.rel];
}

const DECIMAL_OP: Record<string, string> = { "+": "plus", "-": "minus", "*": "times", "/": "div" };

function emitArithmetic(e: Extract<TExpr, { t: "binary" }>, ctx: ExprContext): Out {
  const l = strip(e.left.type);
  const r = strip(e.right.type);
  const rt = (name: string) => ctx.imports.value(ctx.L.runtime, name);
  const call = (fn: string, a: TExpr, b: TExpr): Out => {
    rt(fn);
    return [`${fn}(${emitExpr(a, ctx)}, ${emitExpr(b, ctx)})`, P.atom];
  };
  const dt = (t: Type) => isPrim(t, "DateTime");
  const date = (t: Type) => isPrim(t, "Date");
  const dur = (t: Type) => t.k === "duration";
  if (e.op === "+") {
    if (dt(l) && dur(r)) return call("plusDuration", e.left, e.right);
    if (dur(l) && dt(r)) return call("plusDuration", e.right, e.left);
    if (date(l) && dur(r)) return call("plusDays", e.left, e.right);
    if (dur(l) && date(r)) return call("plusDays", e.right, e.left);
  }
  if (e.op === "-") {
    if (dt(l) && dur(r)) return call("minusDuration", e.left, e.right);
    if (dt(l) && dt(r)) return call("durationBetween", e.left, e.right);
    if (date(l) && dur(r)) return call("minusDays", e.left, e.right);
    if (date(l) && date(r)) return call("daysBetween", e.left, e.right);
  }
  if (isDecimal(e.type)) {
    // Integer / Integer divides exactly as Decimal (never floating point).
    return [`${decimal(e.left, ctx)}.${DECIMAL_OP[e.op]}(${emitExpr(e.right, ctx)})`, P.atom];
  }
  const p: Prec = e.op === "+" || e.op === "-" ? P.add : P.mul;
  return [`${wrap(emit(e.left, ctx), p)} ${e.op} ${wrap(emit(e.right, ctx), (p + 1) as Prec)}`, p];
}

/** A narrowed reference used inside an element callback: TypeScript does not carry the narrowing into closures. */
function nonNull(code: string, declared: Type | undefined, e: TExpr, ctx: ExprContext): string {
  return (ctx.callbacks ?? 0) > 0 && declared?.k === "optional" && e.type.k !== "optional" ? `${code}!` : code;
}

function emit(e: TExpr, ctx: ExprContext): Out {
  switch (e.t) {
    case "lit":
      if (e.kind === "null") return ["null", P.atom];
      if (e.kind === "boolean") return [e.value ? "true" : "false", P.atom];
      if (e.kind === "string") return [tsString(String(e.value)), P.atom];
      if (e.kind === "decimal") {
        ctx.imports.value(ctx.L.runtime, "Decimal");
        return [`new Decimal(${tsString(String(e.value))})`, P.atom];
      }
      return [String(e.value), (e.value as number) < 0 ? P.unary : P.atom];
    case "field": {
      const owner = e.owner ? ownerName(e.owner.type) : ctx.selfOwner;
      const declared = owner ? ctx.L.fieldTypes(owner).get(e.name) : undefined;
      const base = e.owner ? wrap(emit(e.owner, ctx), P.atom) : ctx.self;
      return [nonNull(`${base}.${prop(e.name)}`, declared, e, ctx), P.atom];
    }
    case "param":
      return [ident(e.name), P.atom];
    case "local": {
      if (ctx.fixedLocals?.has(e.name)) return [e.name, P.atom];
      const input = ctx.inputs?.get(e.name);
      if (input) return [nonNull(`command.${prop(e.name)}`, input, e, ctx), P.atom];
      return [ident(e.name), P.atom];
    }
    case "item":
      return ["item", P.atom];
    case "enumValue": {
      ctx.imports.value(ctx.L.typeModule("enum"), e.enumName);
      const member = /^[A-Za-z_$][\w$]*$/.test(e.value) ? `.${e.value}` : `[${tsString(e.value)}]`;
      return [`${e.enumName}${member}`, P.atom];
    }
    case "port":
      if (!ctx.ports) throw new Error("ports are not available in this context");
      return [e.port === "clock" ? `${ctx.ports.clock}.now()` : `${ctx.ports.ids}.newId()`, P.atom];
    case "guard": {
      const recv = e.receiver ? wrap(emit(e.receiver, ctx), P.atom) : ctx.self;
      const ag = ctx.L.aggregate(e.aggregate);
      const g = ag?.stateGuards.find((x) => x.name === e.guard);
      const types = g && ag ? ctx.L.paramTypes(ag, g.parameters) : new Map<string, Type>();
      const args = e.args.map((a, i) => emitAs(a, g ? types.get(g.parameters[i]!.name) : undefined, ctx)).join(", ");
      return [`${recv}.${prop(e.guard)}(${args}).${ctx.guardMode ?? "checks"}()`, P.atom];
    }
    case "builtin":
      return emitBuiltin(e, ctx);
    case "extension": {
      if (!ctx.ports) throw new Error("extensions are not available in this context");
      const x = ctx.L.ca.ir.extensionPoints.find((p) => p.name === e.name);
      const types = x ? ctx.L.paramTypes(undefined, x.parameters) : new Map<string, Type>();
      const args = e.args.map((a, i) => emitAs(a, x ? types.get(x.parameters[i]!.name) : undefined, ctx)).join(", ");
      return [`(await ${ctx.ports.extensions}.${prop(e.name)}(${args}))`, P.atom];
    }
    case "not":
      return [`!${wrap(emit(e.operand, ctx), P.unary)}`, P.unary];
    case "neg":
      if (isDecimal(e.type)) return [`${wrap(emit(e.operand, ctx), P.atom)}.neg()`, P.atom];
      // `-(-x)`, never `--x` (decrement).
      return [`-${wrap(emit(e.operand, ctx), P.atom)}`, P.unary];
    case "isNull":
      return [`${wrap(emit(e.operand, ctx), P.rel)} ${e.negate ? "!==" : "==="} null`, P.eq];
    case "list":
      return listLiteral(e.items, (strip(e.type) as { item: Type }).item, ctx);
    case "construct": {
      ctx.imports.value(ctx.L.typeModule(e.kind), e.name);
      const fields = e.fields.map((f) => `${prop(f.name)}: ${emitExpr(f.value, ctx)}`).join(", ");
      return [`${e.name}.${e.kind === "vo" ? "create" : "from"}({ ${fields} })`, P.atom];
    }
    case "with": {
      const fields = e.fields.map((f) => `${prop(f.name)}: ${emitExpr(f.value, ctx)}`).join(", ");
      return [`${wrap(emit(e.target, ctx), P.atom)}.with({ ${fields} })`, P.atom];
    }
    case "binary": {
      if (e.op === "and" || e.op === "or") {
        const p: Prec = e.op === "and" ? P.and : P.or;
        const op = e.op === "and" ? "&&" : "||";
        // Same-op children associate freely; everything else at or below `&&` is parenthesized for readability.
        const side = (x: TExpr) => {
          const r = emit(x, ctx);
          if (x.t === "binary" && x.op === e.op) return r[0];
          return r[1] <= P.and ? `(${r[0]})` : r[0];
        };
        return [`${side(e.left)} ${op} ${side(e.right)}`, p];
      }
      if (e.op === "==" || e.op === "!=") return emitEquality(e, ctx);
      if (e.op === "<" || e.op === "<=" || e.op === ">" || e.op === ">=") return emitOrdering(e, ctx);
      return emitArithmetic(e, ctx);
    }
  }
}
