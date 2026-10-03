import { pascal, toSnake } from "@ddd/core";

export { pascal, toSnake };

/**
 * snake_case model name → camelCase TypeScript name. An underscore before a letter becomes the upper-case letter;
 * any other underscore stays (`line_1` → `line_1`), so two different model names never map to the same name.
 */
export function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** PascalCase / snake_case → kebab-case file or directory name (`CleaningStaff` → `cleaning-staff`). */
export function kebab(name: string): string {
  return toSnake(name).replace(/_/g, "-");
}

/** Words that cannot name a variable or parameter in strict-mode ECMAScript / TypeScript. */
const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function " +
    "if import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);

/**
 * Names the generated code itself declares or imports unqualified next to model names (runtime helpers, `z`,
 * locals of generated methods). A model parameter or variable with one of these names gets a trailing underscore.
 */
const GENERATED_LOCALS = new Set([
  "z",
  "args",
  "aggregate",
  "events",
  "command",
  "emitted",
  "afterCommit",
  "item",
  "equals",
  "contains",
  "without",
  "sumOf",
  "sumDecimals",
  "earliest",
  "latest",
  "days",
  "hours",
  "minutes",
  "plusDuration",
  "minusDuration",
  "durationBetween",
  "plusDays",
  "minusDays",
  "daysBetween",
  "transition",
  "parseWith",
  "idSchema",
  "uuidSchema",
  "dateTimeSchema",
  "localDateSchema",
  "decimalSchema",
]);

/** A safe TypeScript identifier for a model parameter / variable name (camelCased, escaped if reserved). */
export function ident(name: string): string {
  const c = camel(name);
  return JS_RESERVED.has(c) || GENERATED_LOCALS.has(c) ? `${c}_` : c;
}

/** A property name (fields, methods): reserved words are fine after a dot and as object keys. */
export function prop(name: string): string {
  return camel(name);
}
