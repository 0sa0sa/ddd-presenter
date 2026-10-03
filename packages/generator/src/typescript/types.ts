import type { Constraints, NormalizeStep, Type } from "@ddd/core";
import { tsString, type TsImports } from "./code.ts";
import type { TsLayout } from "./layout.ts";

/** TypeScript type of a resolved model type; records the (type-only) imports it needs. */
export function tsType(t: Type, imp: TsImports, L: TsLayout): string {
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return "string";
        case "Integer":
          return "number";
        case "Boolean":
          return "boolean";
        case "Decimal":
          imp.type(L.runtime, "Decimal");
          return "Decimal";
        case "UUID":
          imp.type(L.runtime, "UUID");
          return "UUID";
        case "DateTime":
          return "Date";
        case "Date":
          imp.type(L.runtime, "LocalDate");
          return "LocalDate";
      }
      break;
    case "ref":
      imp.type(L.runtime, "Id");
      return `Id<${tsString(t.target)}>`;
    case "enum":
    case "vo":
    case "entity":
    case "aggregate":
    case "event":
      imp.type(L.typeModule(t.k), t.name);
      return t.name;
    case "list":
      return `ReadonlyArray<${tsType(t.item, imp, L)}>`;
    case "optional":
      return `${tsType(t.inner, imp, L)} | null`;
    case "null":
      return "null";
    case "duration":
      imp.type(L.runtime, "Duration");
      return "Duration";
  }
  throw new Error(`unreachable type ${JSON.stringify(t)}`);
}

/**
 * Zod schema of a field. Normalization runs first, then the constraints (as in the Python target); optional fields
 * are `T | null` with null as the default.
 */
export function zodSchema(t: Type, imp: TsImports, L: TsLayout, constraints: Constraints = {}, normalize: NormalizeStep[] = []): string {
  if (t.k === "optional") {
    imp.value("zod", "z");
    return `${zodSchema(t.inner, imp, L, constraints, normalize)}.nullable().default(null)`;
  }
  const c = constraints;
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String": {
          imp.value("zod", "z");
          let s = "z.string()";
          for (const n of normalize) s += n === "strip" ? ".trim()" : n === "lower" ? ".toLowerCase()" : ".toUpperCase()";
          if (c.min_length !== undefined) s += `.min(${c.min_length})`;
          if (c.max_length !== undefined) s += `.max(${c.max_length})`;
          if (c.pattern !== undefined) s += `.regex(new RegExp(${tsString(c.pattern)}))`;
          return s;
        }
        case "Integer": {
          imp.value("zod", "z");
          let s = "z.number().int()";
          if (c.min !== undefined) s += `.min(${c.min})`;
          if (c.max !== undefined) s += `.max(${c.max})`;
          return s;
        }
        case "Boolean":
          imp.value("zod", "z");
          return "z.boolean()";
        case "Decimal": {
          imp.value(L.runtime, "decimalSchema");
          const opts: string[] = [];
          if (c.min !== undefined) opts.push(`min: ${c.min}`);
          if (c.max !== undefined) opts.push(`max: ${c.max}`);
          if (c.max_digits !== undefined) opts.push(`maxDigits: ${c.max_digits}`);
          if (c.decimal_places !== undefined) opts.push(`decimalPlaces: ${c.decimal_places}`);
          return `decimalSchema(${opts.length ? `{ ${opts.join(", ")} }` : ""})`;
        }
        case "UUID":
          imp.value(L.runtime, "uuidSchema");
          return "uuidSchema";
        case "DateTime":
          imp.value(L.runtime, "dateTimeSchema");
          return "dateTimeSchema";
        case "Date":
          imp.value(L.runtime, "localDateSchema");
          return "localDateSchema";
      }
      break;
    case "ref":
      imp.value(L.runtime, "idSchema");
      return `idSchema(${tsString(t.target)})`;
    case "enum":
    case "vo":
      imp.value(L.typeModule(t.k), `${t.name}Schema`);
      return `${t.name}Schema`;
    case "entity":
      imp.value(L.typeModule("entity"), t.name);
      return `${t.name}.schema`;
    case "list": {
      imp.value("zod", "z");
      let s = `z.array(${zodSchema(t.item, imp, L)})`;
      const min = c.min_items ?? c.min_length;
      const max = c.max_items ?? c.max_length;
      if (min !== undefined) s += `.min(${min})`;
      if (max !== undefined) s += `.max(${max})`;
      return `${s}.readonly()`;
    }
  }
  throw new Error(`Cannot build a schema for ${JSON.stringify(t)}`);
}

export function isDecimal(t: Type | undefined): boolean {
  if (t?.k === "optional") return isDecimal(t.inner);
  return t?.k === "primitive" && t.name === "Decimal";
}

export function isPrim(t: Type | undefined, name: string): boolean {
  if (t?.k === "optional") return isPrim(t.inner, name);
  return t?.k === "primitive" && t.name === name;
}

export function strip(t: Type): Type {
  return t.k === "optional" ? t.inner : t;
}
