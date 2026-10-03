import { formatPath, typeToString, type AggregateIR, type EntityIR, type EventEmissionIR, type InvariantIR, type ParameterIR, type TExpr, type Type, type ValueObjectIR } from "@ddd/core";
import { assemble, Code, header, TsImports, tsString, unparen } from "./code.ts";
import { emitExpr, emitNegated, paramRefs, type ExprContext } from "./expr.ts";
import type { TsLayout } from "./layout.ts";
import { ident, prop } from "./names.ts";
import { tsType, zodSchema } from "./types.ts";

export interface TsFile {
  path: string;
  content: string;
}

export function file(L: TsLayout, module: string, doc: string, imp: TsImports, body: string): TsFile {
  return { path: L.file(module), content: assemble(header(L.model), doc, imp, body) };
}

function topoSort<T extends { name: string }>(items: T[], deps: (t: T) => string[]): T[] {
  const byName = new Map(items.map((i) => [i.name, i]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (t: T, stack: Set<string>) => {
    if (seen.has(t.name) || stack.has(t.name)) return;
    stack.add(t.name);
    for (const d of deps(t)) {
      const x = byName.get(d);
      if (x) visit(x, stack);
    }
    seen.add(t.name);
    out.push(t);
  };
  for (const i of items) visit(i, new Set());
  return out;
}

function namedDeps(types: Map<string, Type>): string[] {
  const out: string[] = [];
  const walk = (t: Type) => {
    if (t.k === "optional") walk(t.inner);
    else if (t.k === "list") walk(t.item);
    else if (t.k === "vo" || t.k === "entity") out.push(t.name);
  };
  types.forEach(walk);
  return out;
}

/** `key: value`, or the shorthand `key` when the value is a variable of the same name. */
export function entry(key: string, value: string): string {
  return key === value ? key : `${key}: ${value}`;
}

const expr = (L: TsLayout, path: (string | number)[]): TExpr => {
  const e = L.ca.exprs.get(formatPath(path));
  if (!e) throw new Error(`missing typed expression at ${formatPath(path)}`);
  return e;
};

// ---------------------------------------------------------------------------
// errors / enums
// ---------------------------------------------------------------------------

export function errorsFile(L: TsLayout): TsFile {
  const mod = L.mod("errors");
  const imp = new TsImports(mod);
  const c = new Code();
  for (const e of L.ca.ir.errors) {
    imp.value(L.runtime, "DomainError");
    imp.type(L.runtime, "ErrorDetails");
    const types = L.fieldTypes(e.name);
    const detailsType = e.details.length ? `${e.name}Details` : "ErrorDetails";
    c.line();
    if (e.details.length) {
      c.doc(`Diagnostic details of ${e.name} (besides \`rule\` / \`guard\`).`);
      c.block(`export interface ${e.name}Details extends ErrorDetails`, () => {
        for (const d of e.details) {
          if (d.description) c.doc(d.description);
          c.line(`readonly ${prop(d.name)}?: ${tsType(stripOptional(types.get(d.name)), imp, L)};`);
        }
      });
      c.line();
    }
    const doc = [e.description ?? e.message];
    if (e.details.length) doc.push("", `Details: ${e.details.map((d) => `${d.name}: ${typeToString(types.get(d.name) ?? { k: "null" })}`).join(", ")}.`);
    c.doc(doc.join("\n"));
    c.block(`export class ${e.name} extends DomainError${e.details.length ? `<${detailsType}>` : ""}`, () => {
      c.line(`static override readonly code = ${tsString(e.code)};`);
      c.line(`override readonly code = ${tsString(e.code)};`);
      c.line();
      c.block(`constructor(details: ${detailsType} = {}, message = ${tsString(e.message)})`, () => c.line("super(details, message);"));
    });
  }
  c.line();
  c.doc(`Every domain error of the ${L.ca.ir.name} context.`);
  c.line(`export const ALL_ERRORS = [${L.ca.ir.errors.map((e) => e.name).join(", ")}] as const;`);
  return file(L, mod, `Domain errors of the ${L.ca.ir.name} context.`, imp, c.toString());
}

function stripOptional(t: Type | undefined): Type {
  if (!t) return { k: "null" };
  return t.k === "optional" ? t.inner : t;
}

export function enumsFile(L: TsLayout): TsFile {
  const mod = L.mod("enums");
  const imp = new TsImports(mod);
  const c = new Code();
  for (const e of L.ca.ir.enums) {
    imp.value("zod", "z");
    c.line();
    c.doc(e.description ?? `Values of ${e.name}.`);
    c.block(`export const ${e.name} =`, () => {
      for (const v of e.values) c.line(`${/^[A-Za-z_$][\w$]*$/.test(v) ? v : tsString(v)}: ${tsString(v)},`);
    }, " as const;");
    c.line(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`);
    c.line(`export const ${e.name}Schema = z.enum(${e.name});`);
  }
  if (!L.ca.ir.enums.length) c.line("// This context declares no enums.").line("export {};");
  return file(L, mod, `Enumerations of the ${L.ca.ir.name} context.`, imp, c.toString());
}

// ---------------------------------------------------------------------------
// value objects
// ---------------------------------------------------------------------------

export function valueObjectsFile(L: TsLayout): TsFile {
  const mod = L.mod("value-objects");
  const imp = new TsImports(mod);
  const c = new Code();
  const vos = topoSort(L.ca.ir.valueObjects, (v) => namedDeps(L.fieldTypes(v.name)));
  for (const vo of vos) valueObject(L, c, vo, imp);
  if (!vos.length) c.line("// This context declares no value objects.").line("export {};");
  return file(L, mod, `Value objects of the ${L.ca.ir.name} context.`, imp, c.toString());
}

function fieldSchemas(L: TsLayout, owner: string, fields: { name: string; constraints: object }[], imp: TsImports, normalize: Record<string, string[]> = {}): string[] {
  return fields.flatMap((f) => {
    const t = L.tsFieldType(owner, f.name);
    if (!t) return [];
    return [`${prop(f.name)}: ${zodSchema(t, imp, L, f.constraints, (normalize[f.name] ?? []) as never)},`];
  });
}

function invariantDoc(inv: InvariantIR): string {
  return `Invariant \`${inv.name}\`: ${inv.expression}${inv.description ? `\n\n${inv.description}` : ""}\nChecked on: ${inv.checkOn.join(", ")}. Violation raises ${inv.error}.`;
}

/** `if (!(<rule>)) { throw new <Error>({ rule, … }); }` */
function invariantCheck(L: TsLayout, c: Code, inv: InvariantIR, ctx: ExprContext, details: string): void {
  ctx.imports.value(L.mod("errors"), inv.error);
  c.block(`if (${emitNegated(expr(L, [...inv.path, "expression"]), ctx)})`, () => {
    c.line(`throw new ${inv.error}({ rule: ${tsString(inv.name)}${details} });`);
  });
}

function valueObject(L: TsLayout, c: Code, vo: ValueObjectIR, imp: TsImports): void {
  imp.value("zod", "z");
  imp.value(L.runtime, "parseWith");
  const fields = `${vo.name}Fields`;
  const norm = Object.entries(vo.normalize);
  c.line();
  c.block(`const ${fields} = z.strictObject(`, () => c.lines_(fieldSchemas(L, vo.name, vo.fields, imp, vo.normalize)), ").readonly();");
  c.line();
  const doc = [vo.description ?? `Value object ${vo.name}.`];
  if (norm.length) doc.push("", `Normalization runs before constraints: ${norm.map(([f, s]) => `${f}: ${s.join(" → ")}`).join(", ")}.`);
  c.doc(doc.join("\n"));
  c.line(`export type ${vo.name} = z.output<typeof ${fields}>;`);
  c.line(`export type ${vo.name}Input = z.input<typeof ${fields}>;`);
  const construct = vo.invariants.filter((i) => i.checkOn.includes("construct"));
  if (construct.length) {
    c.line();
    c.doc(`Invariants of ${vo.name}, checked after the field constraints:\n${construct.map((i) => `- \`${i.name}\`: ${i.expression} (${i.error})`).join("\n")}`);
    c.block(`function check${vo.name}(self: ${vo.name}): ${vo.name}`, () => {
      const ctx: ExprContext = { L, imports: imp, self: "self", selfOwner: vo.name };
      for (const inv of construct) invariantCheck(L, c, inv, ctx, "");
      c.line("return self;");
    });
  }
  c.line();
  c.doc(construct.length ? "Validates the fields (normalization first), then checks the invariants." : "Validates the fields (normalization first).");
  c.line(`export const ${vo.name}Schema = ${construct.length ? `${fields}.transform(check${vo.name})` : fields};`);
  c.line();
  c.block(`export const ${vo.name} =`, () => {
    c.line(`schema: ${vo.name}Schema,`);
    c.doc("Builds the value object: constraint failures throw ConstraintViolation, invariants their domain error.");
    c.block(`create(input: ${vo.name}Input): ${vo.name}`, () => c.line(`return parseWith(${vo.name}Schema, input, ${tsString(vo.name)});`), ",");
    c.doc("Like `create`, for input of unknown shape (e.g. parsed JSON).");
    c.block(`parse(input: unknown): ${vo.name}`, () => c.line(`return parseWith(${vo.name}Schema, input, ${tsString(vo.name)});`), ",");
  }, " as const;");
}

// ---------------------------------------------------------------------------
// entities and aggregates
// ---------------------------------------------------------------------------

export function entitiesFile(L: TsLayout): TsFile {
  const mod = L.mod("entities");
  const imp = new TsImports(mod);
  const c = new Code();
  const all = L.ca.ir.aggregates.flatMap((a) => a.entities.map((e) => ({ e, a, name: e.name })));
  const sorted = topoSort(all, (x) => namedDeps(L.fieldTypes(x.e.name)));
  for (const { e, a } of sorted) entityClass(L, c, e, imp, a);
  if (!sorted.length) c.line("// This context declares no internal entities.").line("export {};");
  return file(L, mod, `Internal entities of the ${L.ca.ir.name} aggregates.`, imp, c.toString());
}

export function aggregatesFile(L: TsLayout): TsFile {
  const mod = L.mod("aggregates");
  const imp = new TsImports(mod);
  const c = new Code();
  for (const ag of L.ca.ir.aggregates) entityClass(L, c, ag, imp);
  if (!L.ca.ir.aggregates.length) c.line("// This context declares no aggregates.").line("export {};");
  return file(L, mod, `Aggregates of the ${L.ca.ir.name} context.`, imp, c.toString());
}

function isAggregate(x: EntityIR | AggregateIR): x is AggregateIR {
  return "operations" in x;
}

/** Argument object type of a factory / operation: `{ readonly at: Date; readonly note?: string | null }`. */
function argsType(L: TsLayout, owner: AggregateIR, params: ParameterIR[], imp: TsImports): string {
  const types = L.paramTypes(owner, params);
  const fields = params.map((p) => {
    const t = types.get(p.name)!;
    return `readonly ${prop(p.name)}${t.k === "optional" ? "?" : ""}: ${tsType(t, imp, L)}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** `const { a, b = null } = args;` for the parameters the body uses. */
function destructure(c: Code, params: ParameterIR[], used: Set<string>): void {
  const parts = params.filter((p) => used.has(p.name)).map((p) => {
    const local = ident(p.name);
    const key = prop(p.name);
    const base = key === local ? key : `${key}: ${local}`;
    return p.required ? base : `${base} = null`;
  });
  if (parts.length) c.line(`const { ${parts.join(", ")} } = args;`);
}

function paramSignature(L: TsLayout, owner: AggregateIR, params: ParameterIR[], imp: TsImports): string {
  if (!params.length) return "";
  const optional = params.every((p) => !p.required);
  return `args: ${argsType(L, owner, params, imp)}${optional ? " = {}" : ""}`;
}

function entityClass(L: TsLayout, c: Code, en: EntityIR | AggregateIR, imp: TsImports, parent?: AggregateIR): void {
  const ag = isAggregate(en) ? en : undefined;
  const name = en.name;
  const props = `${name}Props`;
  imp.value("zod", "z");
  imp.value(L.runtime, "parseWith");
  imp.value(L.runtime, ag ? "AggregateRoot" : "Entity");
  const fieldTypes = new Map(en.fields.map((f) => [f.name, L.tsFieldType(name, f.name)!]));
  const idType = tsType(fieldTypes.get(en.identity)!, imp, L);
  const construct = en.invariants.filter((i) => i.checkOn.includes("construct"));
  const transitionOnly = en.invariants.filter((i) => i.checkOn.includes("transition") && !i.checkOn.includes("construct"));
  const hasOps = !!ag && ag.operations.length > 0;
  const ctx: ExprContext = { L, imports: imp, self: "this", selfOwner: name };
  const details = `, ${prop(en.identity)}: this.${prop(en.identity)}`;

  c.line();
  c.block(`const ${props} = z.strictObject(`, () => c.lines_(fieldSchemas(L, name, en.fields, imp)), ");");
  c.line(`export type ${props} = z.output<typeof ${props}>;`);
  c.line(`export type ${name}Input = z.input<typeof ${props}>;`);
  c.line();
  const doc = [en.description ?? (ag ? `Aggregate root ${name}.` : `Entity ${name}.`), ""];
  if (ag) {
    doc.push(`Identity: ${en.identity}. Instances are immutable; operations return a Transition with the new state.`);
    if (ag.entities.length) doc.push(`Internal entities: ${ag.entities.map((e) => e.name).join(", ")}.`);
  } else {
    doc.push(`Part of aggregate ${parent?.name}; changed only through ${parent?.name} operations. Identity: ${en.identity}.`);
  }
  c.doc(doc.join("\n"));
  c.block(`export class ${name} extends ${ag ? "AggregateRoot" : "Entity"}`, () => {
    if (!ag) {
      c.doc(`Schema of a ${name} field: accepts ${name} instances (build them with \`${name}.from\`).`);
      c.line(`static readonly schema = z.custom<${name}>((value) => value instanceof ${name}, "Expected a ${name}");`);
      c.line();
    }
    for (const f of en.fields) {
      if (f.description) c.doc(f.description);
      c.line(`readonly ${prop(f.name)}: ${tsType(fieldTypes.get(f.name)!, imp, L)};`);
    }
    c.line();
    c.block(`private constructor(props: ${props})`, () => {
      c.line("super();");
      for (const f of en.fields) c.line(`this.${prop(f.name)} = props.${prop(f.name)};`);
      c.line("Object.freeze(this);");
    });
    c.line();
    c.doc(`Validates \`input\` (constraint failures throw ConstraintViolation)${construct.length ? " and checks the construct-time invariants" : ""}.`);
    c.block(`static from(input: ${name}Input): ${name}`, () => {
      const v = ag ? "aggregate" : "entity";
      c.line(`const ${v} = new ${name}(parseWith(${props}, input, ${tsString(name)}));`);
      if (construct.length) c.line(`${v}.#checkInvariants();`);
      c.line(`return ${v};`);
    });
    c.line();
    c.block(`override get identity(): ${idType}`, () => c.line(`return this.${prop(en.identity)};`));
    if (!ag || hasOps) {
      c.line();
      c.block(`#props(): ${props}`, () => {
        c.block("return", () => {
          for (const f of en.fields) c.line(`${prop(f.name)}: this.${prop(f.name)},`);
        }, ";");
      });
      c.line();
      if (!ag) {
        c.doc("A copy with some fields changed (all construct-time invariants run on it). Used by aggregate operations.");
        c.block(`with(changes: Partial<${name}Input>): ${name}`, () => c.line(`return ${name}.from({ ...this.#props(), ...changes });`));
      } else {
        c.doc("Candidate state: the changes applied to a copy (construct-time invariants run on it).");
        c.block(`#with(changes: Partial<${name}Input>): ${name}`, () => c.line(`return ${name}.from({ ...this.#props(), ...changes });`));
      }
    }
    if (construct.length) {
      c.line();
      c.doc("Construct-time invariants. Run for every new instance (transition candidates too).");
      c.block("#checkInvariants(): void", () => {
        for (const i of construct) c.line(`this.#invariant${pascalName(i.name)}();`);
      });
    }
    if (hasOps && transitionOnly.length) {
      c.line();
      c.doc("Invariants checked only after a state transition (construct-time ones already ran).");
      c.block("#checkTransitionInvariants(): void", () => {
        for (const i of transitionOnly) c.line(`this.#invariant${pascalName(i.name)}();`);
      });
    }
    for (const inv of en.invariants) {
      if (!inv.checkOn.includes("construct") && !hasOps) continue;
      c.line();
      c.doc(invariantDoc(inv));
      c.block(`#invariant${pascalName(inv.name)}(): void`, () => invariantCheck(L, c, inv, ctx, details));
    }
    if (ag) {
      guards(L, c, ag, imp, ctx, details);
      factories(L, c, ag, imp);
      operations(L, c, ag, imp, transitionOnly.length > 0);
    }
  });
}

function pascalName(snake: string): string {
  const c = prop(snake);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function requiredBy(L: TsLayout, ag: AggregateIR, guard: string): string[] {
  return ag.operations
    .filter((op) => op.require.some((_, i) => {
      const r = L.ca.exprs.get(formatPath([...op.path, "require", i]));
      return r?.t === "guard" && r.guard === guard;
    }))
    .map((o) => o.name);
}

function guards(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports, base: ExprContext, details: string): void {
  for (const g of ag.stateGuards) {
    imp.value(L.runtime, "StateGuard");
    imp.value(L.mod("errors"), g.error);
    const types = L.paramTypes(ag, g.parameters);
    const sig = g.parameters.map((p) => {
      const t = types.get(p.name)!;
      return `${ident(p.name)}: ${tsType(t, imp, L)}${t.k === "optional" ? " = null" : ""}`;
    });
    const usedBy = requiredBy(L, ag, g.name);
    const ctx: ExprContext = { ...base, params: types };
    c.line();
    const d = [`State guard \`${g.name}\`: ${g.expression}`];
    if (g.description) d.push("", g.description);
    d.push("", `Violation raises ${g.error}.${usedBy.length ? ` Required by: ${usedBy.join(", ")}.` : ""}`);
    c.doc(d.join("\n"));
    c.block(`${prop(g.name)}(${sig.join(", ")}): StateGuard`, () => {
      c.line("return new StateGuard(");
      c.indent(() => {
        c.line(`${tsString(g.name)},`);
        c.line(`${emitExpr(expr(L, [...g.path, "expression"]), ctx)},`);
        c.line(`() => new ${g.error}({ guard: ${tsString(g.name)}${details} }),`);
      });
      c.line(");");
    });
  }
}

/** Parameters used by a factory / operation body (expressions and event fields copied from parameters). */
function usedParams(L: TsLayout, member: { path: (string | number)[]; parameters: ParameterIR[]; emits: EventEmissionIR[] }, exprs: TExpr[]): Set<string> {
  const used = new Set<string>();
  for (const e of exprs) paramRefs(e, used);
  const params = new Set(member.parameters.map((p) => p.name));
  for (const em of member.emits) {
    for (const f of em.fields) {
      if (f.value !== undefined) paramRefs(expr(L, [...f.path, "value"]), used);
      else if (params.has(f.name)) used.add(f.name);
    }
    if (em.when !== undefined) paramRefs(expr(L, [...em.path, "when"]), used);
  }
  return used;
}

function factories(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports): void {
  for (const f of ag.factories) {
    imp.value(L.runtime, "transition");
    imp.type(L.runtime, "Transition");
    const types = L.paramTypes(ag, f.parameters);
    const ctx: ExprContext = { L, imports: imp, self: ag.name, selfOwner: ag.name, params: types };
    const values = ag.fields.filter((fd) => f.fields[fd.name] !== undefined).map((fd) => ({ fd, e: expr(L, [...f.path, "fields", fd.name]) }));
    const used = usedParams(L, f, values.map((v) => v.e));
    c.line();
    const d = [f.description ?? `Create a new ${ag.name}.`, "", "Factory: construct-time invariants are checked on the new instance."];
    if (f.emits.length) d.push(`Emits: ${f.emits.map((e) => e.name).join(", ")}.`);
    c.doc(d.join("\n"));
    c.block(`static ${prop(f.name)}(${paramSignature(L, ag, f.parameters, imp)}): Transition<${ag.name}>`, () => {
      destructure(c, f.parameters, used);
      const fields = values.map(({ fd, e }) => entry(prop(fd.name), emitExpr(e, ctx)));
      c.line(`const aggregate = ${ag.name}.from({ ${fields.join(", ")} });`);
      emitEvents(L, c, ag, f.emits, new Set(f.parameters.map((p) => p.name)), imp);
    });
  }
}

function operations(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports, transitionChecks: boolean): void {
  for (const op of ag.operations) {
    imp.value(L.runtime, "transition");
    imp.type(L.runtime, "Transition");
    const types = L.paramTypes(ag, op.parameters);
    const ctx: ExprContext = { L, imports: imp, self: "this", selfOwner: ag.name, params: types };
    const requires = op.require.map((_, i) => expr(L, [...op.path, "require", i]));
    const changes = ag.fields.filter((fd) => op.changes[fd.name] !== undefined).map((fd) => ({ fd, e: expr(L, [...op.path, "changes", fd.name]) }));
    const used = usedParams(L, op, [...requires, ...changes.map((x) => x.e)]);
    c.line();
    const d = [op.description ?? `Operation ${op.name}.`, ""];
    if (op.require.length) d.push(`Requires: ${op.require.join(", ")}`);
    if (changes.length) d.push(`Changes: ${changes.map((x) => x.fd.name).join(", ")}`);
    if (op.emits.length) d.push(`Emits: ${op.emits.map((e) => e.name).join(", ")}`);
    d.push("Invariants are checked on the candidate state before it is returned.");
    c.doc(d.join("\n"));
    c.block(`${prop(op.name)}(${paramSignature(L, ag, op.parameters, imp)}): Transition<${ag.name}>`, () => {
      destructure(c, op.parameters, used);
      for (const r of requires) c.line(`${emitExpr(r, { ...ctx, guardMode: "assertHolds" })};`);
      // Changes are computed from the state before the transition.
      const fields = changes.map(({ fd, e }) => entry(prop(fd.name), emitExpr(e, ctx)));
      c.line(`const aggregate = this.#with({${fields.length ? ` ${fields.join(", ")} ` : ""}});`);
      if (transitionChecks) c.line("aggregate.#checkTransitionInvariants();");
      emitEvents(L, c, ag, op.emits, new Set(op.parameters.map((p) => p.name)), imp);
    });
  }
}

/** Events built from the new state: a bare field name copies a parameter, else the post-transition field. */
function emitEvents(L: TsLayout, c: Code, ag: AggregateIR, emits: EventEmissionIR[], params: Set<string>, imp: TsImports): void {
  if (!emits.length) {
    c.line("return transition(aggregate);");
    return;
  }
  imp.type(L.runtime, "DomainEvent");
  const ctx: ExprContext = { L, imports: imp, self: "aggregate", selfOwner: ag.name, params: L.paramTypes(ag, []) };
  c.line("const events: DomainEvent[] = [];");
  for (const em of emits) {
    imp.value(L.mod("events"), em.name);
    const fields = em.fields.map((fd) => {
      if (fd.value !== undefined) return `${prop(fd.name)}: ${emitExpr(expr(L, [...fd.path, "value"]), ctx)}`;
      return entry(prop(fd.name), params.has(fd.name) ? ident(fd.name) : `aggregate.${prop(fd.name)}`);
    });
    const push = `events.push(${em.name}.create({ ${fields.join(", ")} }));`;
    if (em.when !== undefined) c.block(`if (${unparen(emitExpr(expr(L, [...em.path, "when"]), ctx))})`, () => c.line(push));
    else c.line(push);
  }
  c.line("return transition(aggregate, events);");
}

// ---------------------------------------------------------------------------
// events / commands / rules
// ---------------------------------------------------------------------------

export function eventType(context: string, event: string): string {
  return `${context}.${event}`;
}

export function eventsFile(L: TsLayout): TsFile {
  const mod = L.mod("events");
  const imp = new TsImports(mod);
  const c = new Code();
  const events = [...L.ca.events.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const ev of events) {
    imp.value("zod", "z");
    imp.value(L.runtime, "parseWith");
    imp.type(L.runtime, "DomainEvent");
    const payload = `${ev.name}Payload`;
    const type = eventType(L.ca.ir.name, ev.name);
    c.line();
    c.block(`const ${payload} = z.strictObject(`, () => {
      for (const f of ev.fields) c.line(`${prop(f.name)}: ${zodSchema(f.type, imp, L)},`);
    }, ");");
    c.line();
    c.doc(`Emitted by ${ev.sources.map((s) => `${s.aggregate}.${s.member}`).join(", ")}.`);
    c.line(`export type ${ev.name} = Readonly<{ type: ${tsString(type)} } & z.output<typeof ${payload}>>;`);
    c.line(`export type ${ev.name}Input = z.input<typeof ${payload}>;`);
    c.line();
    c.block(`export const ${ev.name} =`, () => {
      c.line(`type: ${tsString(type)},`);
      c.doc("Builds the event (the payload is validated and frozen).");
      c.block(`create(payload: ${ev.name}Input): ${ev.name}`, () => {
        c.line(`return Object.freeze({ type: ${ev.name}.type, ...parseWith(${payload}, payload, ${tsString(ev.name)}) });`);
      }, ",");
      c.block(`is(event: DomainEvent): event is ${ev.name}`, () => c.line(`return event.type === ${ev.name}.type;`), ",");
    }, " as const;");
  }
  if (events.length) {
    c.line();
    c.doc(`Every domain event of the ${L.ca.ir.name} context.`);
    c.line(`export type ${L.ca.ir.name}Event = ${events.map((e) => e.name).join(" | ")};`);
  } else {
    c.line("// This context declares no domain events.").line("export {};");
  }
  return file(L, mod, `Domain events of the ${L.ca.ir.name} context. \`type\` is "<Context>.<Event>".`, imp, c.toString());
}

export function commandsFile(L: TsLayout): TsFile {
  const mod = L.mod("commands");
  const imp = new TsImports(mod);
  const c = new Code();
  for (const uc of L.ca.ir.useCases) {
    imp.value("zod", "z");
    imp.value(L.runtime, "parseWith");
    const fields = `${uc.command}Fields`;
    c.line();
    c.block(`const ${fields} = z.strictObject(`, () => c.lines_(fieldSchemas(L, uc.command, uc.input, imp)), ").readonly();");
    c.line();
    c.doc(`Input of use case \`${uc.name}\`${uc.actor ? ` (actor: ${uc.actor})` : ""}.`);
    c.line(`export type ${uc.command} = z.output<typeof ${fields}>;`);
    c.line(`export type ${uc.command}Input = z.input<typeof ${fields}>;`);
    c.line();
    c.block(`export const ${uc.command} =`, () => {
      c.line(`schema: ${fields},`);
      c.block(`create(input: ${uc.command}Input): ${uc.command}`, () => c.line(`return parseWith(${fields}, input, ${tsString(uc.command)});`), ",");
      c.block(`parse(input: unknown): ${uc.command}`, () => c.line(`return parseWith(${fields}, input, ${tsString(uc.command)});`), ",");
    }, " as const;");
  }
  if (!L.ca.ir.useCases.length) c.line("// This context declares no use cases.").line("export {};");
  return file(L, mod, `Commands (use case inputs) of the ${L.ca.ir.name} context.`, imp, c.toString());
}

export function rulesFile(L: TsLayout): TsFile {
  const mod = L.mod("rules");
  const imp = new TsImports(mod);
  imp.type(L.runtime, "Rule");
  const c = new Code();
  const list = (xs: string[]) => `[${xs.map(tsString).join(", ")}]`;
  c.line();
  c.open("export const RULES: ReadonlyArray<Rule> = [", () => {
    const owners: (EntityIR | ValueObjectIR)[] = [...L.ca.ir.valueObjects, ...L.ca.ir.aggregates.flatMap((a) => [a, ...a.entities])];
    for (const o of owners) {
      for (const inv of o.invariants) {
        const ag = L.ca.ir.aggregates.find((a) => a.name === o.name);
        const applied = ag ? [...ag.factories.map((f) => f.name), ...ag.operations.map((op) => op.name)] : [];
        c.line(
          `{ name: ${tsString(inv.name)}, kind: "invariant", owner: ${tsString(o.name)}, expression: ${tsString(inv.expression)}, error: ${tsString(inv.error)}, checkOn: ${list(inv.checkOn)}, appliedBy: ${list(applied)} },`,
        );
      }
    }
    for (const ag of L.ca.ir.aggregates) {
      for (const g of ag.stateGuards) {
        c.line(
          `{ name: ${tsString(g.name)}, kind: "state_guard", owner: ${tsString(ag.name)}, expression: ${tsString(g.expression)}, error: ${tsString(g.error)}, checkOn: [], appliedBy: ${list(requiredBy(L, ag, g.name))} },`,
        );
      }
    }
  }, "];");
  return file(L, mod, `Catalogue of the named rules in the ${L.ca.ir.name} context.`, imp, c.toString());
}
