import { pascal, toSnake, type TExpr, type Type } from "@ddd/core";

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

type Prec = 0 | 1 | 2 | 3 | 4; // or < and < not < cmp < atom

export function emitExpr(e: TExpr, ctx: ExprContext): string {
  return emit(e, ctx)[0];
}

function wrap(s: [string, Prec], min: Prec): string {
  return s[1] < min ? `(${s[0]})` : s[0];
}

function emit(e: TExpr, ctx: ExprContext): [string, Prec] {
  switch (e.t) {
    case "lit":
      if (e.kind === "null") return ["None", 4];
      if (e.kind === "boolean") return [e.value ? "True" : "False", 4];
      if (e.kind === "string") return [pyString(String(e.value)), 4];
      if (e.kind === "decimal") {
        ctx.imports.from("decimal", "Decimal");
        return [`Decimal(${pyString(String(e.value))})`, 4];
      }
      return [String(e.value), 4];
    case "field":
      if (e.owner) return [`${wrap(emit(e.owner, ctx), 4)}.${e.name}`, 4];
      return [`${ctx.self}.${e.name}`, 4];
    case "param":
      return [e.name, 4];
    case "local":
      return [ctx.inputs?.has(e.name) ? `command.${e.name}` : e.name, 4];
    case "enumValue":
      ctx.imports.from(ctx.typeModule("enum", e.enumName), e.enumName);
      return [`${e.enumName}.${enumMember(e.value)}`, 4];
    case "port":
      if (!ctx.ports) throw new Error("ports are not available in this context");
      return [e.port === "clock" ? `${ctx.ports.clock}.now()` : `${ctx.ports.ids}.new_id()`, 4];
    case "guard": {
      const recv = e.receiver ? wrap(emit(e.receiver, ctx), 4) : ctx.self;
      const args = e.args.map((a) => emitExpr(a, ctx)).join(", ");
      return [`${recv}.${e.guard}(${args}).${ctx.guardMode ?? "checks"}()`, 4];
    }
    case "builtin": {
      const [a, b] = e.args.map((x) => emit(x, ctx));
      if (e.fn === "is_empty") return [`len(${a![0]}) == 0`, 3];
      if (e.fn === "length") return [`len(${a![0]})`, 4];
      return [`${wrap(b!, 4)} in ${wrap(a!, 4)}`, 3];
    }
    case "extension": {
      if (!ctx.ports) throw new Error("extensions are not available in this context");
      return [`${ctx.ports.extensions}.${e.name}(${e.args.map((a) => emitExpr(a, ctx)).join(", ")})`, 4];
    }
    case "not":
      return [`not ${wrap(emit(e.operand, ctx), 2)}`, 2];
    case "isNull":
      return [`${wrap(emit(e.operand, ctx), 4)} is ${e.negate ? "not " : ""}None`, 3];
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
