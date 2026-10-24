/**
 * Property tests of the aggregates for TypeScript (`generation.property_tests`, docs/09 §29): fast-check runs random
 * sequences of factories and operations with random arguments. Every call must either succeed or throw one of the
 * domain errors the model declares for it; a crash or another error fails the test (fast-check shrinks the sequence).
 */
import type { AggregateIR, Constraints, Type } from "@ddd/core";

import { aggregateLiterals, declaredErrors } from "../python/properties.ts";
import { Code, tsString, TsImports } from "./code.ts";
import type { TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { prop } from "./names.ts";
import { defaultTenant, importError, tenantLiteral, testFile } from "./tests.ts";

type Lits = { ints: number[]; strings: string[] };

/** `fc` arbitrary of the value an operation takes (`typed`), or of the input a schema accepts (`input`). */
function arbitrary(L: TsLayout, t: Type, imp: TsImports, lits: Lits, form: "typed" | "input", depth = 0, c: Constraints = {}): { expr: string; maybe: boolean } {
  const a = (expr: string) => ({ expr, maybe: false });
  const rt = (...names: string[]) => imp.value(L.runtime, ...names);
  switch (t.k) {
    case "optional": {
      const inner = arbitrary(L, t.inner, imp, lits, form, depth, c);
      return { expr: `fc.option(${inner.expr}, { nil: null })`, maybe: inner.maybe };
    }
    case "primitive":
      switch (t.name) {
        case "Integer": {
          const lo = c.min ?? -1000;
          const hi = c.max ?? 1000;
          const near = lits.ints.filter((n) => n >= lo && n <= hi);
          const base = `fc.integer({ min: ${lo}, max: ${hi} })`;
          return a(near.length ? `fc.oneof(${base}, fc.constantFrom(${near.join(", ")}))` : base);
        }
        case "Decimal": {
          const places = c.decimal_places ?? 2;
          const scale = 10 ** places;
          const lo = Math.round((c.min ?? -1000) * scale);
          const hi = Math.round((c.max ?? 1000) * scale);
          const text = `fc.integer({ min: ${lo}, max: ${hi} }).map((n) => (n / ${scale}).toFixed(${places}))`;
          if (form === "input") return a(text);
          rt("Decimal");
          return a(`${text}.map((s) => new Decimal(s))`);
        }
        case "String": {
          const lo = c.min_length ?? 0;
          const hi = c.max_length ?? 12;
          if (c.pattern) return a(`fc.stringMatching(new RegExp(${tsString(`^(?:${c.pattern})$`)}))`);
          const n = Math.max(lo, Math.min(hi, 3));
          const pool = ["a", "b"].map((ch) => tsString(ch.repeat(n)));
          const fits = lits.strings.filter((x) => x.length >= lo && x.length <= hi).map(tsString);
          return a(`fc.oneof(fc.constantFrom(${[...pool, ...fits].join(", ")}), text(${lo}, ${Math.min(hi, lo + 12)}))`);
        }
        case "Boolean":
          return a("fc.boolean()");
        case "UUID":
          if (form === "input") return a("fc.uuid()");
          rt("uuid");
          return a("fc.uuid().map((s) => uuid(s))");
        case "DateTime":
          if (form === "input") return a("INSTANTS");
          rt("instant");
          return a("INSTANTS.map((s) => instant(s))");
        case "Date":
          if (form === "input") return a("DATES");
          rt("localDate");
          return a("DATES.map((s) => localDate(s))");
      }
      break;
    case "ref":
      if (form === "input") return a("fc.uuid()");
      rt("id");
      return a(`fc.uuid().map((s) => id(${tsString(t.target)}, s))`);
    case "enum": {
      imp.value(L.typeModule("enum"), t.name);
      const en = L.ca.ir.enums.find((e) => e.name === t.name)!;
      return a(`fc.constantFrom(${en.values.map((v) => (/^[A-Za-z_$][\w$]*$/.test(v) ? `${t.name}.${v}` : `${t.name}[${tsString(v)}]`)).join(", ")})`);
    }
    case "list": {
      const item = arbitrary(L, t.item, imp, lits, form, depth + 1);
      const size = `{ minLength: ${c.min_items ?? 0}, maxLength: ${Math.max(c.min_items ?? 0, Math.min(c.max_items ?? 3, 3))} }`;
      return a(item.maybe ? `fc.array(${item.expr}, ${size}).map((xs) => xs.filter(present))` : `fc.array(${item.expr}, ${size})`);
    }
    case "vo":
    case "entity": {
      if (depth > 3) break;
      const owner = L.ca.ir.valueObjects.find((v) => v.name === t.name) ?? L.ca.ir.aggregates.flatMap((x) => x.entities).find((e) => e.name === t.name)!;
      const types = L.fieldTypes(t.name);
      const fields = owner.fields.map((f) => `${prop(f.name)}: ${arbitrary(L, L.tsFieldType(t.name, f.name) ?? types.get(f.name)!, imp, lits, t.k === "entity" ? "input" : "input", depth + 1, f.constraints).expr}`);
      const record = `fc.record({ ${fields.join(", ")} })`;
      // A value object's input form is the plain record; an entity (and any typed value) is built and may refuse it.
      if (form === "input" && t.k === "vo") return a(record);
      imp.value(L.typeModule(t.k), t.name);
      const build = t.k === "vo" ? `${t.name}.create(x)` : `${t.name}.from(x)`;
      return { expr: `${record}.map((x) => attempt(() => ${build}))`, maybe: true };
    }
  }
  return a("fc.constant(undefined)");
}

export function propertyTestFile(L: TsLayout): TsFile | undefined {
  if (!L.model.generation.propertyTests) return undefined;
  const aggregates = L.ca.ir.aggregates.filter((ag) => ag.factories.length > 0);
  if (!aggregates.length) return undefined;
  const module = L.testModule("properties");
  const imp = new TsImports(module);
  imp.namespace("fast-check", "fc");
  const body = new Code();
  for (const ag of aggregates) {
    body.line();
    aggregateProperties(L, body, ag, imp);
  }
  const text = body.toString();
  const uses = (name: string) => new RegExp(`(^|[^\\w.])${name}\\b`).test(text);
  // Only the helpers the tests use (the project compiles with noUnusedLocals).
  const c = new Code();
  const consts: string[] = [];
  if (uses("text")) {
    consts.push(
      "const ALNUM = fc.mapToConstant({ num: 26, build: (v) => String.fromCharCode(97 + v) }, { num: 26, build: (v) => String.fromCharCode(65 + v) }, { num: 10, build: (v) => String.fromCharCode(48 + v) });",
    );
    consts.push("const text = (minLength: number, maxLength: number) => fc.string({ unit: ALNUM, minLength, maxLength });");
  }
  if (uses("INSTANTS")) consts.push("const INSTANTS = fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 11, 31) }).map((ms) => new Date(ms).toISOString());");
  if (uses("DATES")) consts.push("const DATES = fc.integer({ min: 20089, max: 21183 }).map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10));");
  if (consts.length) {
    c.line();
    consts.forEach((l) => c.line(l));
  }
  if (uses("attempt")) {
    c.line();
    c.doc("The value `build` returns, or undefined when it refuses its input (a value object or entity with invalid fields).");
    c.block("function attempt<T>(build: () => T): T | undefined", () => {
      c.line("try {");
      c.indent(() => c.line("return build();"));
      c.line("} catch {");
      c.indent(() => c.line("return undefined;"));
      c.line("}");
    });
  }
  if (uses("present")) {
    c.line();
    c.block("function present<T>(x: T | undefined): x is T", () => c.line("return x !== undefined;"));
  }
  c.line();
  c.doc("Whether `error` is an instance of one of `declared` (the errors the model declares for the call).");
  c.block("function isDeclared(error: unknown, declared: readonly (abstract new (...args: never[]) => Error)[]): boolean", () => {
    c.line("return declared.some((E) => error instanceof E);");
  });
  c.line(text.replace(/\n$/, ""));
  return testFile(L, module, `Property tests of the ${L.ca.ir.name} aggregates (fast-check): random factories and operations throw only the domain errors the model declares.`, imp, c.toString());
}

function aggregateProperties(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports): void {
  imp.value(L.mod("aggregates"), ag.name);
  const lits = aggregateLiterals(L, ag);
  const members = [...ag.factories.map((x) => ({ kind: "factory" as const, x })), ...ag.operations.map((x) => ({ kind: "operation" as const, x }))];
  const steps: string[] = [];
  const cases: { name: string; lines: string[] }[] = [];
  const declared: string[] = [];
  for (const { kind, x } of members) {
    const types = L.paramTypes(ag, x.parameters);
    const args = x.parameters.map((p) => ({ p, arb: arbitrary(L, types.get(p.name)!, imp, lits, "typed") }));
    const errors = declaredErrors(L, ag, x, kind);
    for (const e of errors) importError(L, imp, e);
    steps.push(`fc.record({ kind: fc.constant(${tsString(x.name)} as const), args: fc.record({ ${args.map(({ p, arb }) => `${prop(p.name)}: ${arb.expr}`).join(", ")} }) })`);
    declared.push(`${/^[A-Za-z_$][\w$]*$/.test(x.name) ? x.name : tsString(x.name)}: [${errors.join(", ")}],`);
    const lines: string[] = [];
    const keep = ag.operations.length > 0;
    if (kind === "operation") lines.push("if (!aggregate) break;");
    const entries = args.map(({ p }) => `${prop(p.name)}: step.args.${prop(p.name)}`);
    // Arguments that could not be built (invalid value objects) are not a call to make.
    for (const { p, arb } of args) if (arb.maybe && types.get(p.name)!.k !== "optional") lines.push(`if (step.args.${prop(p.name)} === undefined) break;`);
    if (kind === "factory" && L.tenantScoped(ag)) entries.unshift(`tenantId: ${tenantLiteral(L, imp, defaultTenant(L))}`);
    const callee = `${kind === "factory" ? ag.name : "aggregate"}.${prop(x.name)}`;
    // Two or more arguments are written one per line (Prettier keeps an object literal expanded once it is).
    // Without operations the new aggregate is not used: the call alone is the test.
    const assign = keep ? "aggregate = " : "";
    const tail = keep ? ").aggregate;" : ");";
    if (entries.length >= 2) lines.push(`${assign}${callee}({`, ...entries.map((e) => `  ${e},`), `}${tail}`, "break;");
    else lines.push(`${assign}${callee}(${entries.length ? `{ ${entries[0]} }` : ""}${tail}`, "break;");
    cases.push({ name: x.name, lines });
  }
  c.block(`describe(${tsString(`${ag.name} properties`)}, () =>`, () => {
    c.doc("The domain errors each factory and operation may throw (its guards, the invariants it can break, constraints).");
    c.open("const declared = {", () => declared.forEach((d) => c.line(d)), "};");
    c.line(`const steps = fc.array(fc.oneof(${steps.join(", ")}), { maxLength: 30, size: "medium" });`);
    c.line();
    c.doc("Every call succeeds or throws one of its declared domain errors; anything else fails (and is shrunk).");
    c.block(`test("random factories and operations throw only declared domain errors", () =>`, () => {
      c.open("fc.assert(", () => {
        c.open("fc.property(steps, (run) => {", () => {
          if (ag.operations.length) c.line(`let aggregate: ${ag.name} | undefined;`);
          c.block("for (const step of run)", () => {
            c.line("try {");
            c.indent(() => {
              // One factory and no operation: no switch (its only case would always match).
              if (cases.length === 1) cases[0]!.lines.filter((l) => l !== "break;").forEach((l) => c.line(l));
              else
                c.block("switch (step.kind)", () => {
                  for (const cs of cases) {
                    c.line(`case ${tsString(cs.name)}:`);
                    c.indent(() => cs.lines.forEach((l) => c.line(l)));
                  }
                });
            });
            c.line("} catch (error) {");
            c.indent(() => c.line("if (!isDeclared(error, declared[step.kind])) throw error;"));
            c.line("}");
          });
        }, "}),");
        c.line("{ numRuns: 200 },");
      }, ");");
    }, ");");
  }, ");");
}
