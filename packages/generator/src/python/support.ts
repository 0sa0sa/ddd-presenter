import { pascal, T, toSnake, type TExpr, type Type } from "@ddd/core";

export { pascal, toSnake };

export const GENERATOR_NAME = "ddd-presenter";
export const GENERATOR_VERSION = "0.1.0";

export function enumMember(value: string): string {
  return value.toUpperCase();
}

/** Collects `from x import y` lines deterministically. */
export class Imports {
  private readonly map = new Map<string, Set<string>>();
  private readonly plain = new Set<string>();

  from(module: string, ...names: string[]): this {
    const set = this.map.get(module) ?? new Set<string>();
    for (const n of names) set.add(n);
    this.map.set(module, set);
    return this;
  }

  import(module: string): this {
    this.plain.add(module);
    return this;
  }

  render(): string {
    const future = this.map.get("__future__");
    const lines: string[] = [];
    if (future) lines.push(`from __future__ import ${[...future].sort().join(", ")}`, "");
    const std: string[] = [];
    const third: string[] = [];
    const local: string[] = [];
    const bucket = (m: string) => (STDLIB.has(m.split(".")[0]!) ? std : m.startsWith("pydantic") || m === "pytest" ? third : local);
    for (const m of [...this.plain].sort()) bucket(m).push(`import ${m}`);
    for (const m of [...this.map.keys()].sort()) {
      if (m === "__future__") continue;
      const names = [...this.map.get(m)!].sort((a, b) => a.localeCompare(b));
      if (names.length === 0) continue;
      const one = `from ${m} import ${names.join(", ")}`;
      const line = one.length <= 100 ? one : `from ${m} import (\n${names.map((n) => `    ${n},`).join("\n")}\n)`;
      bucket(m).push(line);
    }
    const groups = [std, third, local].filter((g) => g.length);
    return [...lines, ...groups.map((g) => g.join("\n"))].join("\n\n").replace(/\n\n\n+/g, "\n\n");
  }
}

const STDLIB = new Set(["dataclasses", "datetime", "decimal", "enum", "typing", "uuid", "collections", "re", "abc"]);

/** Indentation-aware line builder. */
export class Code {
  private readonly lines: string[] = [];
  private depth = 0;

  line(s = ""): this {
    this.lines.push(s ? "    ".repeat(this.depth) + s : "");
    return this;
  }

  lines_(ss: string[]): this {
    for (const s of ss) this.line(s);
    return this;
  }

  indent(fn: () => void): this {
    this.depth++;
    fn();
    this.depth--;
    return this;
  }

  docstring(text: string | undefined): this {
    if (!text) return this;
    const safe = text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
    const parts = safe.split("\n");
    if (parts.length === 1) return this.line(`"""${parts[0]}"""`);
    this.line(`"""${parts[0]}`);
    for (const p of parts.slice(1)) this.line(p);
    return this.line(`"""`);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

export function pyString(s: string): string {
  // JSON string syntax is valid Python for our inputs; escape non-printables explicitly.
  return JSON.stringify(s);
}

export interface PyTypeOptions {
  /** Use pydantic AwareDatetime for DateTime fields (model fields only). */
  field: boolean;
}

/** Python annotation for a resolved type. Returns the annotation and records required imports. */
export function pyType(t: Type, imp: Imports, typeModule: (kind: "enum" | "vo" | "entity" | "aggregate" | "event", name: string) => string, opts: PyTypeOptions): string {
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return "str";
        case "Integer":
          return "int";
        case "Boolean":
          return "bool";
        case "Decimal":
          imp.from("decimal", "Decimal");
          return "Decimal";
        case "UUID":
          imp.from("uuid", "UUID");
          return "UUID";
        case "DateTime":
          if (opts.field) {
            imp.from("pydantic", "AwareDatetime");
            return "AwareDatetime";
          }
          imp.from("datetime", "datetime");
          return "datetime";
        case "Date":
          imp.from("datetime", "date");
          return "date";
      }
      break;
    case "ref":
      imp.from("uuid", "UUID");
      return "UUID";
    case "enum":
    case "vo":
    case "entity":
    case "aggregate":
    case "event":
      imp.from(typeModule(t.k, t.name), t.name);
      return t.name;
    case "list":
      return `tuple[${pyType(t.item, imp, typeModule, opts)}, ...]`;
    case "optional":
      return `${pyType(t.inner, imp, typeModule, opts)} | None`;
    case "null":
      return "None";
    case "duration":
      imp.from("datetime", "timedelta");
      return "timedelta";
  }
  throw new Error(`unreachable type ${JSON.stringify(t)}`);
}

// ---------------------------------------------------------------------------
// Expression emission
// ---------------------------------------------------------------------------

export interface ExprContext {
  /** Python expression for the current object (`self`, `aggregate`, …). */
  self: string;
  /** Local names that are command inputs (emitted as `command.<name>`). */
  inputs?: Set<string>;
  imports: Imports;
  typeModule: (kind: "enum" | "vo" | "entity" | "aggregate" | "event", name: string) => string;
  /** Use case port attributes. */
  ports?: { clock: string; ids: string; extensions: string };
  /** How guards are consumed: boolean check (default) or raising. */
  guardMode?: "checks" | "assert_holds";
}

/** Python precedence levels: or < and < not < comparison < + - < * / < unary - < atom. */
type Prec = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
const ATOM: Prec = 7;

export function emitExpr(e: TExpr, ctx: ExprContext): string {
  return emit(e, ctx)[0];
}

/**
 * Emits `e` for a place that expects `target`. An Integer flowing into a Decimal is wrapped in
 * `Decimal(...)` so plain-Python call sites (operation arguments, tuples, return values) stay mypy-clean.
 */
export function emitAs(e: TExpr, target: Type | undefined, ctx: ExprContext): string {
  return emitCoerced(e, target, ctx)[0];
}

function isDecimal(t: Type | undefined): boolean {
  if (t?.k === "optional") return isDecimal(t.inner);
  return t?.k === "primitive" && t.name === "Decimal";
}

function emitCoerced(e: TExpr, target: Type | undefined, ctx: ExprContext): [string, Prec] {
  if (isDecimal(target) && e.type.k === "primitive" && e.type.name === "Integer") {
    ctx.imports.from("decimal", "Decimal");
    return [`Decimal(${emitExpr(e, ctx)})`, ATOM];
  }
  const list = target?.k === "optional" ? target.inner : target;
  if (list?.k === "list" && e.t === "list") return emitTuple(e.items, list.item, ctx);
  return emit(e, ctx);
}

function emitTuple(items: TExpr[], itemType: Type, ctx: ExprContext): [string, Prec] {
  const xs = items.map((x) => emitAs(x, itemType, ctx));
  return [xs.length === 1 ? `(${xs[0]},)` : `(${xs.join(", ")})`, ATOM];
}

function wrap(s: [string, Prec], min: Prec): string {
  return s[1] < min ? `(${s[0]})` : s[0];
}

/** Zero of a summable type, used as the start value of `sum(...)`. */
function zero(t: Type, ctx: ExprContext): string {
  if (t.k === "duration") {
    ctx.imports.from("datetime", "timedelta");
    return "timedelta()";
  }
  if (isDecimal(t)) {
    ctx.imports.from("decimal", "Decimal");
    return 'Decimal("0")';
  }
  return "0";
}

/**
 * Collection functions are emitted with list comprehensions (`[... for item_ in xs]`) rather than bare
 * generator expressions, so the generated code stays valid when a long line is split argument by argument.
 */
function emitBuiltin(e: Extract<TExpr, { t: "builtin" }>, ctx: ExprContext): [string, Prec] {
  const arg = (i: number) => emit(e.args[i]!, ctx);
  const s = (i: number) => arg(i)[0];
  switch (e.fn) {
    case "is_empty":
      return [`len(${s(0)}) == 0`, 3];
    case "length":
      return [`len(${s(0)})`, ATOM];
    case "contains":
      return [`${wrap(arg(1), 4)} in ${wrap(arg(0), 4)}`, 3];
    case "days":
    case "hours":
    case "minutes":
      ctx.imports.from("datetime", "timedelta");
      return [`timedelta(${e.fn}=${s(0)})`, ATOM];
    case "round": {
      ctx.imports.from("decimal", "Decimal", "ROUND_HALF_UP");
      const places = Number((e.args[1] as { value: number }).value);
      const quantum = places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`;
      const x = emitCoerced(e.args[0]!, T.Decimal, ctx);
      return [`${wrap(x, ATOM)}.quantize(Decimal(${pyString(quantum)}), rounding=ROUND_HALF_UP)`, ATOM];
    }
    case "min":
    case "max":
      return [`${e.fn}(${emitAs(e.args[0]!, e.type, ctx)}, ${emitAs(e.args[1]!, e.type, ctx)})`, ATOM];
    case "count":
      if (e.args.length === 1) return [`len(${s(0)})`, ATOM];
      return [`len([item_ for item_ in ${s(0)} if ${s(1)}])`, ATOM];
    case "sum":
      if (e.args.length === 1) return [`sum(${s(0)}, ${zero(e.type, ctx)})`, ATOM];
      return [`sum([${emitAs(e.args[1]!, e.type, ctx)} for item_ in ${s(0)}], ${zero(e.type, ctx)})`, ATOM];
    case "any":
    case "all":
      return [`${e.fn}([${s(1)} for item_ in ${s(0)}])`, ATOM];
    case "append": {
      const item = (e.type as { item: Type }).item;
      return [`(*${wrap(arg(0), ATOM)}, ${emitAs(e.args[1]!, item, ctx)})`, ATOM];
    }
    case "remove":
      return [`tuple([item_ for item_ in ${s(0)} if item_ != ${wrap(arg(1), 4)}])`, ATOM];
    case "remove_where":
      return [`tuple([item_ for item_ in ${s(0)} if not ${wrap(arg(1), 2)}])`, ATOM];
    case "replace_where": {
      const item = (e.type as { item: Type }).item;
      return [`tuple([${emitAs(e.args[2]!, item, ctx)} if ${s(1)} else item_ for item_ in ${s(0)}])`, ATOM];
    }
  }
}

function emit(e: TExpr, ctx: ExprContext): [string, Prec] {
  switch (e.t) {
    case "lit":
      if (e.kind === "null") return ["None", ATOM];
      if (e.kind === "boolean") return [e.value ? "True" : "False", ATOM];
      if (e.kind === "string") return [pyString(String(e.value)), ATOM];
      if (e.kind === "decimal") {
        ctx.imports.from("decimal", "Decimal");
        return [`Decimal(${pyString(String(e.value))})`, ATOM];
      }
      // A negative literal is a unary minus in Python.
      return [String(e.value), (e.value as number) < 0 ? 6 : ATOM];
    case "field":
      if (e.owner) return [`${wrap(emit(e.owner, ctx), ATOM)}.${e.name}`, ATOM];
      return [`${ctx.self}.${e.name}`, ATOM];
    case "param":
      return [e.name, ATOM];
    case "local":
      return [ctx.inputs?.has(e.name) ? `command.${e.name}` : e.name, ATOM];
    case "item":
      return ["item_", ATOM];
    case "enumValue":
      ctx.imports.from(ctx.typeModule("enum", e.enumName), e.enumName);
      return [`${e.enumName}.${enumMember(e.value)}`, ATOM];
    case "port":
      if (!ctx.ports) throw new Error("ports are not available in this context");
      return [e.port === "clock" ? `${ctx.ports.clock}.now()` : `${ctx.ports.ids}.new_id()`, ATOM];
    case "guard": {
      const recv = e.receiver ? wrap(emit(e.receiver, ctx), ATOM) : ctx.self;
      const args = e.args.map((a) => emitExpr(a, ctx)).join(", ");
      return [`${recv}.${e.guard}(${args}).${ctx.guardMode ?? "checks"}()`, ATOM];
    }
    case "builtin":
      return emitBuiltin(e, ctx);
    case "extension": {
      if (!ctx.ports) throw new Error("extensions are not available in this context");
      return [`${ctx.ports.extensions}.${e.name}(${e.args.map((a) => emitExpr(a, ctx)).join(", ")})`, ATOM];
    }
    case "not":
      return [`not ${wrap(emit(e.operand, ctx), 2)}`, 2];
    case "neg":
      return [`-${wrap(emit(e.operand, ctx), ATOM)}`, 6];
    case "isNull":
      return [`${wrap(emit(e.operand, ctx), 4)} is ${e.negate ? "not " : ""}None`, 3];
    case "list":
      return emitTuple(e.items, (e.type as { item: Type }).item, ctx);
    case "construct": {
      ctx.imports.from(ctx.typeModule(e.kind, e.name), e.name);
      return [`${e.name}(${e.fields.map((f) => `${f.name}=${emitAs(f.value, f.fieldType, ctx)}`).join(", ")})`, ATOM];
    }
    case "with":
      return [`${wrap(emit(e.target, ctx), ATOM)}._replace(${e.fields.map((f) => `${f.name}=${emitAs(f.value, f.fieldType, ctx)}`).join(", ")})`, ATOM];
    case "binary": {
      if (e.op === "and" || e.op === "or") {
        const p: Prec = e.op === "and" ? 1 : 0;
        // Same-op children associate freely; everything else is parenthesized for readability.
        const side = (x: TExpr) => {
          const r = emit(x, ctx);
          if (x.t === "binary" && x.op === e.op) return r[0];
          return r[1] <= 1 ? `(${r[0]})` : r[0];
        };
        return [`${side(e.left)} ${e.op} ${side(e.right)}`, p];
      }
      if (e.op === "+" || e.op === "-" || e.op === "*" || e.op === "/") {
        const p: Prec = e.op === "+" || e.op === "-" ? 4 : 5;
        const intType = (x: TExpr) => x.type.k === "primitive" && x.type.name === "Integer";
        // Integer / Integer is exact: it divides as Decimal (never float).
        if (e.op === "/" && intType(e.left) && intType(e.right)) {
          ctx.imports.from("decimal", "Decimal");
          return [`Decimal(${emitExpr(e.left, ctx)}) / ${wrap(emit(e.right, ctx), 6)}`, 5];
        }
        return [`${wrap(emit(e.left, ctx), p)} ${e.op} ${wrap(emit(e.right, ctx), (p + 1) as Prec)}`, p];
      }
      return [`${wrap(emit(e.left, ctx), 4)} ${e.op} ${wrap(emit(e.right, ctx), 4)}`, 3];
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario literal values → Python
// ---------------------------------------------------------------------------

export interface ValueContext {
  imports: Imports;
  typeModule: ExprContext["typeModule"];
  /** Field types for VOs/entities by name. */
  fieldTypes: Map<string, Map<string, Type>>;
}

export function pyValue(v: unknown, t: Type, ctx: ValueContext): string {
  if (t.k === "optional") return v === null || v === undefined ? "None" : pyValue(v, t.inner, ctx);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return pyString(String(v));
        case "Integer":
          return String(v);
        case "Boolean":
          return v ? "True" : "False";
        case "Decimal":
          ctx.imports.from("decimal", "Decimal");
          return `Decimal(${pyString(String(v))})`;
        case "UUID":
          ctx.imports.from("uuid", "UUID");
          return `UUID(${pyString(String(v))})`;
        case "DateTime":
          ctx.imports.from("datetime", "datetime");
          return `datetime.fromisoformat(${pyString(String(v))})`;
        case "Date":
          ctx.imports.from("datetime", "date");
          return `date.fromisoformat(${pyString(String(v))})`;
      }
      break;
    case "ref":
      ctx.imports.from("uuid", "UUID");
      return `UUID(${pyString(String(v))})`;
    case "enum":
      ctx.imports.from(ctx.typeModule("enum", t.name), t.name);
      return `${t.name}.${enumMember(String(v))}`;
    case "list": {
      const items = (v as unknown[]).map((x) => pyValue(x, t.item, ctx));
      return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
    }
    case "vo":
    case "entity": {
      ctx.imports.from(ctx.typeModule(t.k, t.name), t.name);
      const fields = ctx.fieldTypes.get(t.name) ?? new Map<string, Type>();
      const rec = v as Record<string, unknown>;
      const args = [...fields.entries()].filter(([k]) => k in rec).map(([k, ft]) => `${k}=${pyValue(rec[k], ft, ctx)}`);
      return `${t.name}(${args.join(", ")})`;
    }
  }
  throw new Error(`Cannot render scenario value of type ${JSON.stringify(t)}`);
}
