import { formatPath, resolveType, typeToString, type AggregateIR, type Constraints, type EntityIR, type EventEmissionIR, type FieldIR, type InvariantIR, type Type, type ValueObjectIR } from "@ddd/core";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { Code, emitAs, emitExpr, emitNegated, enumMember, MAX_LINE, pyString, pyType, type Imports } from "./support.ts";

export interface PyFile {
  path: string;
  content: string;
}

/** Discriminator field of every generated event ("<Context>.<Event>", the same tag as the TypeScript target). */
export const EVENT_TAG = "event_type";
/** Tagged union of the events of one context (in its events module). */
export const EVENT_UNION = "AnyEvent";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function fieldArgs(c: Constraints): string[] {
  const out: string[] = [];
  if (c.min_length !== undefined) out.push(`min_length=${c.min_length}`);
  if (c.max_length !== undefined) out.push(`max_length=${c.max_length}`);
  if (c.pattern !== undefined) out.push(`pattern=${pyRaw(c.pattern)}`);
  if (c.min !== undefined) out.push(`ge=${c.min}`);
  if (c.max !== undefined) out.push(`le=${c.max}`);
  if (c.max_digits !== undefined) out.push(`max_digits=${c.max_digits}`);
  if (c.decimal_places !== undefined) out.push(`decimal_places=${c.decimal_places}`);
  if (c.min_items !== undefined) out.push(`min_length=${c.min_items}`);
  if (c.max_items !== undefined) out.push(`max_length=${c.max_items}`);
  return out;
}

function pyRaw(s: string): string {
  if (!s.includes('"') && !s.endsWith("\\")) return `r"${s}"`;
  return pyString(s);
}

function fieldLines(L: Layout, owner: string, fields: FieldIR[], imp: Imports): string[] {
  const types = L.fieldTypes(owner);
  const lines: string[] = [];
  for (const f of fields) {
    const t = types.get(f.name);
    if (!t) continue;
    const ann = pyType(t, imp, L.typeModule, { field: true });
    const args = fieldArgs(f.constraints);
    if (f.description) args.push(`description=${pyString(f.description)}`);
    if (t.k === "optional" && args.length === 0) {
      lines.push(`${f.name}: ${ann} = None`);
      continue;
    }
    if (t.k === "optional") args.unshift("default=None");
    if (args.length) {
      imp.from("pydantic", "Field");
      lines.push(`${f.name}: ${ann} = Field(${args.join(", ")})`);
    } else {
      lines.push(`${f.name}: ${ann}`);
    }
  }
  return lines;
}

/** Keyword arguments identifying the object in error details. */
function errorDetails(identity: string | undefined, self: string, extra: Record<string, string>): string {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`);
  if (identity) parts.push(`${identity}=${self}.${identity}`);
  return parts.join(", ");
}

function invariantMethods(L: Layout, c: Code, owner: string, identity: string | undefined, invariants: InvariantIR[], imp: Imports): void {
  for (const inv of invariants) {
    const e = L.ca.exprs.get(formatPath([...inv.path, "expression"]))!;
    imp.from(L.mod("errors"), inv.error);
    c.line();
    c.line(`def _invariant_${inv.name}(self) -> None:`);
    c.indent(() => {
      c.docstring(`Invariant \`${inv.name}\`: ${inv.expression}${inv.description ? `\n\n${inv.description}` : ""}\nChecked on: ${inv.checkOn.join(", ")}. Violation raises ${inv.error}.`);
      c.line(`if ${emitNegated(e, L.exprCtx(imp, "self"))}:`);
      c.indent(() => c.line(`raise ${inv.error}(${errorDetails(identity, "self", { rule: pyString(inv.name) })})`));
    });
  }
}

function constructValidator(c: Code, invariants: InvariantIR[], imp: Imports): void {
  const construct = invariants.filter((i) => i.checkOn.includes("construct"));
  if (!construct.length) return;
  imp.from("pydantic", "model_validator");
  imp.from("typing", "Self");
  c.line();
  c.line(`@model_validator(mode="after")`);
  c.line(`def _check_invariants(self) -> Self:`);
  c.indent(() => {
    c.docstring("Construct-time invariants. Run for every new instance (transition candidates too).");
    for (const i of construct) c.line(`self._invariant_${i.name}()`);
    c.line("return self");
  });
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

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export function errorsFile(L: Layout): PyFile {
  const mod = L.mod("errors");
  const imp = new ModuleImports(mod);
  imp.from(L.runtime, "DomainError");
  const c = new Code();
  for (const e of L.ca.ir.errors) {
    c.line().line();
    c.line(`class ${e.name}(DomainError):`);
    c.indent(() => {
      const doc = [e.description ?? e.message];
      if (e.details.length) {
        const types = L.fieldTypes(e.name);
        doc.push("", "Details:", ...e.details.map((d) => `    ${d.name}: ${typeToString(types.get(d.name) ?? { k: "null" })}${d.description ? ` — ${d.description}` : ""}`));
      }
      c.docstring(doc.join("\n"));
      c.line();
      c.line(`code = ${pyString(e.code)}`);
      c.line(`default_message = ${pyString(e.message)}`);
    });
  }
  const names = L.ca.ir.errors.map((e) => e.name);
  imp.from("typing", "Final");
  c.line().line();
  c.line(`ALL_ERRORS: Final[tuple[type[DomainError], ...]] = (${names.join(", ")}${names.length === 1 ? "," : ""})`);
  return { path: L.path(mod), content: assemble(L.model, `Domain errors of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

export function enumsFile(L: Layout): PyFile {
  const mod = L.mod("enums");
  const imp = new ModuleImports(mod);
  if (L.ca.ir.enums.length) imp.from("enum", "StrEnum");
  const c = new Code();
  for (const e of L.ca.ir.enums) {
    c.line().line();
    c.line(`class ${e.name}(StrEnum):`);
    c.indent(() => {
      if (e.description) c.docstring(e.description).line();
      for (const v of e.values) c.line(`${enumMember(v)} = ${pyString(v)}`);
    });
  }
  if (!L.ca.ir.enums.length) c.line("# This context declares no enums.");
  return { path: L.path(mod), content: assemble(L.model, `Enumerations of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

export function valueObjectsFile(L: Layout): PyFile {
  const mod = L.mod("value_objects");
  const imp = new ModuleImports(mod);
  const c = new Code();
  const vos = topoSort(L.ca.ir.valueObjects, (v) => namedDeps(L.fieldTypes(v.name)));
  if (vos.length) imp.from(L.runtime, "ValueObject");
  for (const vo of vos) valueObject(L, c, vo, imp);
  if (!vos.length) c.line("# This context declares no value objects.");
  return { path: L.path(mod), content: assemble(L.model, `Value objects of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

function valueObject(L: Layout, c: Code, vo: ValueObjectIR, imp: Imports): void {
  c.line().line();
  c.line(`class ${vo.name}(ValueObject):`);
  c.indent(() => {
    const doc = [vo.description ?? `Value object ${vo.name}.`];
    const norm = Object.entries(vo.normalize);
    if (norm.length) doc.push("", "Normalization runs before constraints:", ...norm.map(([f, s]) => `    ${f}: ${s.join(" → ")}`));
    c.docstring(doc.join("\n"));
    c.line();
    c.lines_(fieldLines(L, vo.name, vo.fields, imp));
    for (const [field, steps] of norm) {
      imp.from("pydantic", "field_validator");
      const expr = steps.reduce((acc, s) => `${acc}.${s === "strip" ? "strip" : s === "lower" ? "lower" : "upper"}()`, "value");
      c.line();
      c.line(`@field_validator(${pyString(field)}, mode="before")`);
      c.line("@classmethod");
      c.line(`def _normalize_${field}(cls, value: object) -> object:`);
      c.indent(() => c.line(`return ${expr} if isinstance(value, str) else value`));
    }
    constructValidator(c, vo.invariants, imp);
    invariantMethods(L, c, vo.name, undefined, vo.invariants, imp);
  });
}

export function entitiesFile(L: Layout): PyFile {
  const mod = L.mod("entities");
  const imp = new ModuleImports(mod);
  const c = new Code();
  const all = L.ca.ir.aggregates.flatMap((a) => a.entities.map((e) => ({ e, a })));
  const sorted = topoSort(
    all.map((x) => ({ ...x, name: x.e.name })),
    (x) => namedDeps(L.fieldTypes(x.e.name)),
  );
  if (sorted.length) imp.from(L.runtime, "Entity");
  for (const { e, a } of sorted) {
    c.line().line();
    c.line(`class ${e.name}(Entity):`);
    c.indent(() => {
      c.docstring(`${e.description ?? `Entity ${e.name}.`}\n\nPart of aggregate ${a.name}; changed only through ${a.name} operations.\nIdentity: ${e.identity}.`);
      c.line();
      imp.from("typing", "ClassVar");
      c.line(`identity_field: ClassVar[str] = ${pyString(e.identity)}`);
      c.line();
      c.lines_(fieldLines(L, e.name, e.fields, imp));
      constructValidator(c, e.invariants, imp);
      invariantMethods(L, c, e.name, e.identity, e.invariants, imp);
    });
  }
  if (!sorted.length) c.line("# This context declares no internal entities.");
  return { path: L.path(mod), content: assemble(L.model, `Internal entities of the ${L.ca.ir.name} aggregates.`, imp, c.toString()) };
}

export function eventsFile(L: Layout): PyFile {
  const mod = L.mod("events");
  const imp = new ModuleImports(mod);
  const c = new Code();
  const events = [...L.ca.events.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (events.length) imp.from(L.runtime, "DomainEvent");
  for (const ev of events) {
    if (ev.name === EVENT_UNION || ev.fields.some((f) => f.name === EVENT_TAG)) {
      throw new Error(`${L.ca.ir.name}.${ev.name}: "${EVENT_UNION}" and the field name "${EVENT_TAG}" are reserved by the Python event module`);
    }
    imp.from("typing", "Literal");
    const tag = pyString(`${L.ca.ir.name}.${ev.name}`);
    c.line().line();
    c.line(`class ${ev.name}(DomainEvent):`);
    c.indent(() => {
      c.docstring(`Emitted by ${ev.sources.map((s) => `${s.aggregate}.${s.member}`).join(", ")}.`);
      c.line();
      const one = `${EVENT_TAG}: Literal[${tag}] = ${tag}`;
      // Too long for one line: parenthesize the value, as ruff format does.
      if (one.length + 4 <= MAX_LINE) c.line(one);
      else c.line(`${EVENT_TAG}: Literal[${tag}] = (`).indent(() => c.line(tag)).line(")");
      for (const f of ev.fields) {
        const ann = pyType(f.type, imp, L.typeModule, { field: true });
        c.line(`${f.name}: ${ann}${f.type.k === "optional" ? " = None" : ""}`);
      }
    });
  }
  if (events.length) {
    imp.from("typing", "Final", "TypeAlias");
    imp.from("pydantic", "TypeAdapter");
    imp.from(L.runtime, "parse_with");
    const names = events.map((e) => e.name);
    c.line().line();
    if (names.length === 1) {
      c.line(`${EVENT_UNION}: TypeAlias = ${names[0]}`);
    } else {
      // Tagged union: Pydantic picks the class from `event_type` instead of trying each member in turn (a member's
      // ConstraintViolation is not a ValueError, so an untagged union would stop at the first member that fails).
      imp.from("typing", "Annotated");
      imp.from("pydantic", "Field");
      c.line(`${EVENT_UNION}: TypeAlias = Annotated[`);
      c.indent(() => {
        const union = names.join(" | ");
        if (union.length + 5 <= MAX_LINE) c.line(`${union},`);
        else c.line("(").indent(() => names.forEach((n, i) => c.line(i === 0 ? n : `| ${n}`))).line("),");
        c.line(`Field(discriminator=${pyString(EVENT_TAG)}),`);
      });
      c.line("]");
    }
    c.docstring(`Every domain event of the ${L.ca.ir.name} context, told apart by \`${EVENT_TAG}\`.`);
    c.line();
    c.line(`_EVENTS: Final[TypeAdapter[${EVENT_UNION}]] = TypeAdapter(${EVENT_UNION})`);
    c.line().line();
    c.line(`def parse_event(data: object) -> ${EVENT_UNION}:`);
    c.indent(() => {
      c.docstring(
        `Rebuilds an event of this context from its \`model_dump()\` / \`model_dump(mode="json")\` form (e.g. an outbox row).\n\n\`${EVENT_TAG}\` selects the class; invalid data raises ConstraintViolation.`,
      );
      c.line(`return parse_with(_EVENTS, data, ${pyString(EVENT_UNION)})`);
    });
  }
  if (!events.length) c.line("# This context declares no domain events.");
  return { path: L.path(mod), content: assemble(L.model, `Domain events of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

export function commandsFile(L: Layout): PyFile {
  const mod = L.mod("commands");
  const imp = new ModuleImports(mod);
  const c = new Code();
  if (L.ca.ir.useCases.length) imp.from(L.runtime, "DomainModel");
  for (const uc of L.ca.ir.useCases) {
    c.line().line();
    c.line(`class ${uc.command}(DomainModel):`);
    c.indent(() => {
      c.docstring(`Input of use case \`${uc.name}\`${uc.actor ? ` (actor: ${uc.actor})` : ""}.`);
      if (uc.input.length) c.line();
      c.lines_(fieldLines(L, uc.command, uc.input, imp));
    });
  }
  if (!L.ca.ir.useCases.length) c.line("# This context declares no use cases.");
  return { path: L.path(mod), content: assemble(L.model, `Commands (use case inputs) of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

export function aggregatesFile(L: Layout): PyFile {
  const mod = L.mod("aggregates");
  const imp = new ModuleImports(mod);
  const c = new Code();
  if (L.ca.ir.aggregates.length) imp.from(L.runtime, "AggregateRoot");
  for (const ag of L.ca.ir.aggregates) aggregate(L, c, ag, imp);
  if (!L.ca.ir.aggregates.length) c.line("# This context declares no aggregates.");
  return { path: L.path(mod), content: assemble(L.model, `Aggregates of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

function paramSig(L: Layout, params: { name: string; type: string; required: boolean }[], owner: AggregateIR, imp: Imports): string {
  const types = paramTypes(L, owner, params);
  return params
    .map((p) => {
      const t = types.get(p.name)!;
      return `${p.name}: ${pyType(t, imp, L.typeModule, { field: false })}${t.k === "optional" ? " = None" : ""}`;
    })
    .join(", ");
}

export function paramTypes(L: Layout, owner: AggregateIR | undefined, params: { name: string; type: string; required: boolean }[]): Map<string, Type> {
  // Parameter types are resolved the same way as fields; reuse the resolver through core.
  const m = new Map<string, Type>();
  for (const p of params) {
    const r = resolve(L, p.type, owner?.name);
    m.set(p.name, p.required ? r : { k: "optional", inner: r });
  }
  return m;
}

function resolve(L: Layout, src: string, aggregate?: string): Type {
  const r = resolveType(src, { context: L.ca.ir, aggregate });
  if (!r.ok) throw new Error(`unresolved type ${src} (model must be validated before generation)`);
  return r.type;
}

function aggregate(L: Layout, c: Code, ag: AggregateIR, imp: Imports): void {
  const X = (p: (string | number)[]) => L.ca.exprs.get(formatPath(p));
  c.line().line();
  c.line(`class ${ag.name}(AggregateRoot):`);
  c.indent(() => {
    const doc = [ag.description ?? `Aggregate root ${ag.name}.`, "", `Identity: ${ag.identity}. Instances are immutable; operations return a Transition with the new state.`];
    if (ag.entities.length) doc.push(`Internal entities: ${ag.entities.map((e) => e.name).join(", ")}.`);
    c.docstring(doc.join("\n"));
    c.line();
    imp.from("typing", "ClassVar");
    c.line(`identity_field: ClassVar[str] = ${pyString(ag.identity)}`);
    c.line();
    c.lines_(fieldLines(L, ag.name, ag.fields, imp));

    // -- invariants
    constructValidator(c, ag.invariants, imp);
    const transitionOnly = ag.invariants.filter((i) => i.checkOn.includes("transition") && !i.checkOn.includes("construct"));
    c.line();
    c.line("def _check_transition_invariants(self) -> None:");
    c.indent(() => {
      c.docstring("Invariants checked only after a state transition (construct-time ones already ran).");
      for (const i of transitionOnly) c.line(`self._invariant_${i.name}()`);
    });
    invariantMethods(L, c, ag.name, ag.identity, ag.invariants, imp);

    // -- state guards
    for (const g of ag.stateGuards) {
      imp.from(L.runtime, "StateGuard");
      imp.from(L.mod("errors"), g.error);
      const sig = paramSig(L, g.parameters, ag, imp);
      const e = X([...g.path, "expression"])!;
      const usedBy = ag.operations.filter((op) => op.require.some((_, i) => {
        const r = X([...op.path, "require", i]);
        return r?.t === "guard" && r.guard === g.name;
      }));
      c.line();
      c.line(`def ${g.name}(self${sig ? `, ${sig}` : ""}) -> StateGuard:`);
      c.indent(() => {
        const d = [`State guard \`${g.name}\`: ${g.expression}`];
        if (g.description) d.push("", g.description);
        d.push("", `Violation raises ${g.error}.${usedBy.length ? ` Required by: ${usedBy.map((o) => o.name).join(", ")}.` : ""}`);
        c.docstring(d.join("\n"));
        c.line("return StateGuard(");
        c.indent(() => {
          c.line(`name=${pyString(g.name)},`);
          c.line(`holds=${emitExpr(e, L.exprCtx(imp, "self"))},`);
          c.line(`error=lambda: ${g.error}(${errorDetails(ag.identity, "self", { guard: pyString(g.name) })}),`);
        });
        c.line(")");
      });
    }

    // -- factories
    for (const f of ag.factories) {
      imp.from(L.runtime, "Transition");
      const sig = paramSig(L, f.parameters, ag, imp);
      c.line();
      c.line("@classmethod");
      c.line(`def ${f.name}(cls${sig ? `, ${sig}` : ""}) -> Transition[${ag.name}]:`);
      c.indent(() => {
        const d = [f.description ?? `Create a new ${ag.name}.`, "", "Factory: construct-time invariants are checked on the new instance."];
        if (f.emits.length) d.push(`Emits: ${f.emits.map((e) => e.name).join(", ")}.`);
        c.docstring(d.join("\n"));
        const args = ag.fields
          .filter((fd) => f.fields[fd.name] !== undefined)
          .map((fd) => `${fd.name}=${emitAs(X([...f.path, "fields", fd.name])!, L.fieldTypes(ag.name).get(fd.name), L.exprCtx(imp, "cls"))}`);
        c.line(`aggregate = cls(${args.join(", ")})`);
        emitEvents(L, c, ag, f.emits, new Set(f.parameters.map((p) => p.name)), imp);
      });
    }

    // -- operations
    for (const op of ag.operations) {
      imp.from(L.runtime, "Transition");
      const sig = paramSig(L, op.parameters, ag, imp);
      c.line();
      c.line(`def ${op.name}(self${sig ? `, ${sig}` : ""}) -> Transition[${ag.name}]:`);
      c.indent(() => {
        const d = [op.description ?? `Operation ${op.name}.`, ""];
        if (op.require.length) d.push(`Requires: ${op.require.join(", ")}`);
        const changed = Object.keys(op.changes);
        if (changed.length) d.push(`Changes: ${changed.join(", ")}`);
        if (op.emits.length) d.push(`Emits: ${op.emits.map((e) => e.name).join(", ")}`);
        d.push("Invariants are checked on the candidate state before it is returned.");
        c.docstring(d.join("\n"));
        op.require.forEach((_, i) => {
          const r = X([...op.path, "require", i])!;
          c.line(emitExpr(r, L.exprCtx(imp, "self", { guardMode: "assert_holds" })));
        });
        const changes = ag.fields
          .filter((fd) => op.changes[fd.name] !== undefined)
          .map((fd) => `${fd.name}=${emitExpr(X([...op.path, "changes", fd.name])!, L.exprCtx(imp, "self"))}`);
        c.line(`aggregate = self._replace(${changes.join(", ")})`);
        c.line("aggregate._check_transition_invariants()");
        emitEvents(L, c, ag, op.emits, new Set(op.parameters.map((p) => p.name)), imp);
      });
    }
  });
}

function emitEvents(L: Layout, c: Code, ag: AggregateIR, emits: EventEmissionIR[], params: Set<string>, imp: Imports): void {
  if (!emits.length) {
    c.line("return Transition(aggregate=aggregate)");
    return;
  }
  imp.from(L.runtime, "DomainEvent");
  c.line("events: list[DomainEvent] = []");
  for (const em of emits) {
    imp.from(L.mod("events"), em.name);
    const args = em.fields.map((fd) => {
      if (fd.value !== undefined) return `${fd.name}=${emitExpr(L.ca.exprs.get(formatPath([...fd.path, "value"]))!, L.exprCtx(imp, "aggregate"))}`;
      return `${fd.name}=${params.has(fd.name) ? fd.name : `aggregate.${fd.name}`}`;
    });
    const create = `events.append(${em.name}(${args.join(", ")}))`;
    if (em.when !== undefined) {
      const w = L.ca.exprs.get(formatPath([...em.path, "when"]))!;
      c.line(`if ${emitExpr(w, L.exprCtx(imp, "aggregate"))}:`);
      c.indent(() => c.line(create));
    } else {
      c.line(create);
    }
  }
  c.line("return Transition(aggregate=aggregate, events=tuple(events))");
}

export function rulesFile(L: Layout): PyFile {
  const mod = L.mod("rules");
  const imp = new ModuleImports(mod);
  imp.from("dataclasses", "dataclass");
  imp.from("typing", "Final");
  const c = new Code();
  c.line().line();
  c.line("@dataclass(frozen=True, slots=True)");
  c.line("class Rule:");
  c.indent(() => {
    c.docstring("Catalogue entry of a named domain rule (for traceability and documentation).");
    c.line();
    c.line("name: str");
    c.line("kind: str");
    c.line("owner: str");
    c.line("expression: str");
    c.line("error: str");
    c.line("check_on: tuple[str, ...]");
    c.line("applied_by: tuple[str, ...]");
  });
  c.line().line();
  const entries = new Code();
  entries.indent(() => {
    const c = entries;
    const owners: (EntityIR | ValueObjectIR)[] = [...L.ca.ir.valueObjects, ...L.ca.ir.aggregates.flatMap((a) => [a, ...a.entities])];
    for (const o of owners) {
      for (const inv of o.invariants) {
        const ag = L.ca.ir.aggregates.find((a) => a.name === o.name);
        const applied = ag ? [...ag.factories.map((f) => f.name), ...ag.operations.map((op) => op.name)] : [];
        c.line(`Rule(${pyString(inv.name)}, "invariant", ${pyString(o.name)}, ${pyString(inv.expression)}, ${pyString(inv.error)}, ${tuple(inv.checkOn)}, ${tuple(applied)}),`);
      }
    }
    for (const ag of L.ca.ir.aggregates) {
      for (const g of ag.stateGuards) {
        const applied = ag.operations.filter((op) => op.require.some((_, i) => {
          const r = L.ca.exprs.get(formatPath([...op.path, "require", i]));
          return r?.t === "guard" && r.guard === g.name;
        }));
        c.line(`Rule(${pyString(g.name)}, "state_guard", ${pyString(ag.name)}, ${pyString(g.expression)}, ${pyString(g.error)}, (), ${tuple(applied.map((a) => a.name))}),`);
      }
    }
  });
  const body = entries.toString();
  if (body.trim()) c.line("RULES: Final[tuple[Rule, ...]] = (").lines_(body.split("\n").map((l) => l.trim()).map((l) => `    ${l}`)).line(")");
  else c.line("RULES: Final[tuple[Rule, ...]] = ()");
  return { path: L.path(mod), content: assemble(L.model, `Catalogue of the named rules in the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

function tuple(xs: string[]): string {
  if (xs.length === 0) return "()";
  if (xs.length === 1) return `(${pyString(xs[0]!)},)`;
  return `(${xs.map(pyString).join(", ")})`;
}

