import type { Type } from "@ddd/core";
import { tsString, type TsImports } from "./code.ts";
import type { TsLayout } from "./layout.ts";
import { prop } from "./names.ts";

/**
 * Scenario values (YAML data) as TypeScript.
 *
 * - `inputValue`: what a schema accepts (`X.from({...})`, `Command.create({...})`): strings for decimals, date-times
 *   and ids, plain objects for value objects. Entities are built with `X.from(...)`.
 * - `typedValue`: an already-typed value (operation arguments, expected values): `new Decimal("1.50")`,
 *   `dateTime("…")`, `id("Order", "…")`, `Money.create({...})`.
 */
export function inputValue(v: unknown, t: Type, imp: TsImports, L: TsLayout): string {
  if (t.k === "optional") return v === null || v === undefined ? "null" : inputValue(v, t.inner, imp, L);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "Integer":
          return String(v);
        case "Boolean":
          return v ? "true" : "false";
        case "UUID":
          return tsString(String(v).toLowerCase());
        default:
          return tsString(String(v));
      }
    case "ref":
      return tsString(String(v).toLowerCase());
    case "enum":
      return tsString(String(v));
    case "list":
      return `[${(v as unknown[]).map((x) => inputValue(x, t.item, imp, L)).join(", ")}]`;
    case "vo":
      return record(t.name, v as Record<string, unknown>, imp, L);
    case "entity":
      imp.value(L.typeModule("entity"), t.name);
      return `${t.name}.from(${record(t.name, v as Record<string, unknown>, imp, L)})`;
  }
  throw new Error(`Cannot render scenario value of type ${JSON.stringify(t)}`);
}

/** `{ a: …, b: … }` with the fields of `owner` that `rec` sets, in declaration order. */
export function record(owner: string, rec: Record<string, unknown>, imp: TsImports, L: TsLayout): string {
  const fields = [...L.fieldTypes(owner).entries()].filter(([k]) => k in rec);
  if (!fields.length) return "{}";
  return `{ ${fields.map(([k, ft]) => `${prop(k)}: ${inputValue(rec[k], L.tsFieldType(owner, k) ?? ft, imp, L)}`).join(", ")} }`;
}

export function typedValue(v: unknown, t: Type, imp: TsImports, L: TsLayout): string {
  if (t.k === "optional") return v === null || v === undefined ? "null" : typedValue(v, t.inner, imp, L);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return tsString(String(v));
        case "Integer":
          return String(v);
        case "Boolean":
          return v ? "true" : "false";
        case "Decimal":
          imp.value(L.runtime, "Decimal");
          return `new Decimal(${tsString(String(v))})`;
        case "UUID":
          imp.value(L.runtime, "uuid");
          return `uuid(${tsString(String(v))})`;
        case "DateTime":
          imp.value(L.runtime, "dateTime");
          return `dateTime(${tsString(String(v))})`;
        case "Date":
          imp.value(L.runtime, "localDate");
          return `localDate(${tsString(String(v))})`;
      }
      break;
    case "ref":
      imp.value(L.runtime, "id");
      return `id(${tsString(t.target)}, ${tsString(String(v))})`;
    case "enum":
      imp.value(L.typeModule("enum"), t.name);
      return /^[A-Za-z_$][\w$]*$/.test(String(v)) ? `${t.name}.${String(v)}` : `${t.name}[${tsString(String(v))}]`;
    case "list":
      return `[${(v as unknown[]).map((x) => typedValue(x, t.item, imp, L)).join(", ")}]`;
    case "vo":
      imp.value(L.typeModule("vo"), t.name);
      return `${t.name}.create(${record(t.name, v as Record<string, unknown>, imp, L)})`;
    case "entity":
      return inputValue(v, t, imp, L);
  }
  throw new Error(`Cannot render scenario value of type ${JSON.stringify(t)}`);
}

/** Whether `expect(actual).toBe(literal)` compares values of this type (otherwise `plain(...)` + `toEqual`). */
export function comparesByIdentity(t: Type): boolean {
  const s = t.k === "optional" ? t.inner : t;
  if (s.k === "enum" || s.k === "ref") return true;
  return s.k === "primitive" && ["String", "Integer", "Boolean", "UUID", "Date"].includes(s.name);
}

export function isBranded(t: Type): boolean {
  const s = t.k === "optional" ? t.inner : t;
  return s.k === "ref" || (s.k === "primitive" && (s.name === "UUID" || s.name === "Date"));
}

/** An assertion that `actual` equals the scenario value `v` of type `t`. */
export function expectEqual(actual: string, v: unknown, t: Type, imp: TsImports, L: TsLayout): string {
  if (v === null || v === undefined) return `expect(${actual}).toBeNull();`;
  // Branded strings (ids, dates) are compared as plain strings: `toBe` is typed by the actual value in bun:test.
  if (isBranded(t)) return `expect(String(${actual})).toBe(${inputValue(v, t, imp, L)});`;
  if (comparesByIdentity(t)) return `expect(${actual}).toBe(${inputValue(v, t, imp, L)});`;
  imp.value(L.contextTesting, "plain");
  return `expect(plain(${actual})).toEqual(plain(${typedValue(v, t, imp, L)}));`;
}
