import { checkExpression, makeEnv, referencedFields, type ExprEnv, type TExpr } from "./checker.ts";
import { DiagnosticBag, formatPath, sortDiagnostics, type Diagnostic, type Path } from "./diagnostics.ts";
import type {
  AggregateIR,
  AggregateScenarioIR,
  ContextIR,
  EntityIR,
  EventEmissionIR,
  FieldIR,
  InvariantIR,
  ModelIR,
  ParameterIR,
  PolicyIR,
  RelationshipIR,
  ScenarioThenIR,
  StepIR,
  UseCaseIR,
  UseCaseScenarioIR,
  ValueObjectIR,
} from "./ir.ts";
import { parseModel, type ParseResult } from "./parse.ts";
import { assignable, closest, resolveType, sameType, T, typeToString, type Type } from "./types.ts";

// ---------------------------------------------------------------------------
// Analysis result
// ---------------------------------------------------------------------------

export interface EventInfo {
  name: string;
  fields: { name: string; type: Type }[];
  sources: { aggregate: string; member: string; kind: "operation" | "factory" }[];
}

export interface UseCaseInfo {
  returnType?: Type;
  usesClock: boolean;
  usesIds: boolean;
  repositories: string[];
  extensions: string[];
  publishes: string[];
  idsCount: number;
}

export interface PolicyInfo {
  /** The consumed event, resolved to its owning context. */
  event: { context: string; name: string };
  /** The event comes from another context (through `relationship`). */
  crossContext: boolean;
  relationship?: RelationshipIR;
  usesClock: boolean;
  usesIds: boolean;
}

export interface ContextAnalysis {
  ir: ContextIR;
  /** owner name → field name → resolved type (optional wrapped). Owners: VOs, entities, aggregates, commands, errors. */
  fieldTypes: Map<string, Map<string, Type>>;
  /** formatPath(path) → typed expression. */
  exprs: Map<string, TExpr>;
  events: Map<string, EventInfo>;
  useCases: Map<string, UseCaseInfo>;
  /** Policies whose event and use case resolved. Typed args are in `exprs` (path `…policies[i].args.<input>`). */
  policies: Map<string, PolicyInfo>;
}

export interface Analysis {
  model: ModelIR;
  contexts: Map<string, ContextAnalysis>;
  diagnostics: Diagnostic[];
}

export interface ValidateResult {
  model?: ModelIR;
  analysis?: Analysis;
  diagnostics: Diagnostic[];
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Naming rules
// ---------------------------------------------------------------------------

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type".split(
    " ",
  ),
);
/** Attribute names that would shadow Pydantic BaseModel API or generated helpers. */
const RESERVED_MEMBERS = new Set([
  "copy",
  "dict",
  "json",
  "schema",
  "schema_json",
  "validate",
  "construct",
  "fields",
  "parse_obj",
  "parse_raw",
  "parse_file",
  "from_orm",
  "update_forward_refs",
  "self",
  "cls",
  "replace",
  "events",
  "aggregate",
  "identity",
  "identity_field",
  "same_state_as",
]);
const RESERVED_TYPES = new Set([
  "DomainError",
  "ConstraintViolation",
  "AggregateNotFound",
  "DomainEvent",
  "Transition",
  "StateGuard",
  "BaseModel",
  "ConfigDict",
  "Field",
  "Enum",
  "UUID",
  "Decimal",
  "Protocol",
  "Exception",
  "Clock",
  "IdGenerator",
  "EventPublisher",
  "UnitOfWork",
  "Extensions",
  "EventHandler",
  "Callable",
  "List",
  "Optional",
  "Ref",
  "String",
  "Integer",
  "Boolean",
  "DateTime",
  "Date",
]);

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

class Validator {
  readonly bag = new DiagnosticBag();
  readonly contexts = new Map<string, ContextAnalysis>();

  constructor(readonly model: ModelIR) {}

  run(): void {
    const m = this.model;
    if (!m.project.trim()) this.bag.error("missing-key", "project must not be empty", ["project"]);
    if (!/^[a-z_][a-z0-9_]*$/.test(m.generation.package) || PY_KEYWORDS.has(m.generation.package)) {
      this.bag.error("invalid-name", `generation.package "${m.generation.package}" is not a valid lowercase Python package name`, ["generation", "package"], {
        hint: "Use lowercase letters, digits and underscores, e.g. cleaning_platform",
      });
    }
    for (const dir of ["srcDir", "testsDir"] as const) {
      const v = m.generation[dir];
      if (v.startsWith("/") || v.split(/[\\/]/).includes("..")) {
        this.bag.error("invalid-path", `generation.${dir === "srcDir" ? "src_dir" : "tests_dir"} must be a relative path inside the project`, ["generation", dir === "srcDir" ? "src_dir" : "tests_dir"]);
      }
    }
    if (m.contexts.length === 0) this.bag.warning("empty-model", "The model has no bounded contexts", ["contexts"]);
    const seen = new Map<string, Path>();
    for (const ctx of m.contexts) {
      if (!PASCAL.test(ctx.name)) this.bag.error("invalid-name", `Context name "${ctx.name}" must be PascalCase`, [...ctx.path, "name"]);
      const snake = toSnake(ctx.name);
      if (seen.has(snake)) this.bag.error("duplicate-name", `Duplicate context "${ctx.name}"`, [...ctx.path, "name"]);
      seen.set(snake, ctx.path);
      this.contexts.set(ctx.name, new ContextValidator(this.bag, ctx).run());
    }
    // Context map and policies need every context's events and use cases.
    this.checkRelationships();
    for (const ctx of m.contexts) this.checkPolicies(ctx);
    this.checkPolicyCycles();
    this.checkContractUsage();
  }

  // -- context map ------------------------------------------------------------

  relEl(r: RelationshipIR): string {
    return `Context map › ${r.upstream} → ${r.downstream}`;
  }

  unknownContext(name: string, path: Path, element: string): void {
    const s = closest(name, this.model.contexts.map((c) => c.name));
    this.bag.error("unknown-context", `Unknown context "${name}"`, path, { element, hint: s ? `Did you mean "${s}"?` : `Contexts: ${this.model.contexts.map((c) => c.name).join(", ") || "none"}` });
  }

  checkRelationships(): void {
    const pairs = new Set<string>();
    for (const r of this.model.relationships) {
      const el = this.relEl(r);
      const up = this.contexts.get(r.upstream);
      if (!up) this.unknownContext(r.upstream, [...r.path, "upstream"], el);
      if (!this.contexts.has(r.downstream)) this.unknownContext(r.downstream, [...r.path, "downstream"], el);
      if (r.upstream === r.downstream) {
        this.bag.error("self-relationship", `A context cannot be upstream of itself (${r.upstream})`, [...r.path, "downstream"], {
          element: el,
          hint: "Policies inside one context need no relationship; relationships connect two different contexts",
        });
      }
      const key = `${r.upstream}→${r.downstream}`;
      if (pairs.has(key)) {
        this.bag.error("duplicate-relationship", `Relationship ${r.upstream} → ${r.downstream} is declared more than once`, r.path, {
          element: el,
          hint: "Declare one relationship per upstream/downstream pair and list every contract event in its events",
        });
      }
      pairs.add(key);
      if (r.pattern === "separate_ways" && r.events.length) {
        this.bag.error("separate-ways-with-events", "separate_ways means the contexts do not integrate, so it cannot carry an event contract", [...r.path, "events"], {
          element: el,
          hint: "Remove the events, or choose a pattern that integrates (e.g. customer_supplier, conformist, anticorruption_layer)",
        });
      }
      const seen = new Set<string>();
      r.events.forEach((e, i) => {
        if (seen.has(e)) this.bag.error("duplicate-name", `Event ${e} is listed twice`, [...r.path, "events", i], { element: el });
        seen.add(e);
        if (up && !up.events.has(e)) {
          const s = closest(e, [...up.events.keys()]);
          this.bag.error("unknown-event", `Event ${e} is not emitted in upstream context ${r.upstream}`, [...r.path, "events", i], {
            element: el,
            hint: s ? `Did you mean "${s}"?` : up.events.size ? `Events of ${r.upstream}: ${[...up.events.keys()].join(", ")}` : `${r.upstream} emits no events yet`,
          });
        }
      });
    }
  }

  // -- policies -------------------------------------------------------------

  checkPolicies(ctx: ContextIR): void {
    const ca = this.contexts.get(ctx.name);
    if (!ca || !ctx.policies.length) return;
    const seen = new Set<string>();
    for (const p of ctx.policies) {
      if (seen.has(p.name)) this.bag.error("duplicate-name", `Duplicate policy "${p.name}"`, [...p.path, "name"], { element: this.el(ctx, p) });
      seen.add(p.name);
    }
    // tests/generated/test_<context>_policies.py must not collide with a use case or aggregate test file.
    for (const clash of [...ctx.useCases.map((u) => u.name), ...ctx.aggregates.map((a) => toSnake(a.name))].filter((n) => n === "policies")) {
      this.bag.error("reserved-name", `"${clash}" clashes with the generated policy tests of ${ctx.name}`, [...ctx.policies[0]!.path, "name"], { element: ctx.name, hint: "Rename the use case or aggregate" });
    }
    for (const p of ctx.policies) this.checkPolicy(ctx, ca, p);
  }

  el(ctx: ContextIR, p: PolicyIR): string {
    return `${ctx.name} › ${p.name}`;
  }

  checkPolicy(ctx: ContextIR, ca: ContextAnalysis, p: PolicyIR): void {
    const el = this.el(ctx, p);
    checkSnakeName(this.bag, p.name, "Policy name", [...p.path, "name"], el);
    const wpath = [...p.path, "when"];
    const ref = parseEventRef(p.when);
    let event: EventInfo | undefined;
    let evCtx: ContextAnalysis | undefined;
    if (!ref) {
      this.bag.error("invalid-reference", `"when" must name an event: Event (this context) or Context.Event, got "${p.when}"`, wpath, { element: el });
    } else {
      evCtx = this.contexts.get(ref.context ?? ctx.name);
      if (!evCtx) this.unknownContext(ref.context!, wpath, el);
      else {
        event = evCtx.events.get(ref.name);
        if (!event) {
          const elsewhere = [...this.contexts.values()].find((c) => c !== evCtx && c.events.has(ref.name));
          const s = closest(ref.name, [...evCtx.events.keys()]);
          this.bag.error("unknown-event", `Event ${ref.name} is not emitted in context ${evCtx.ir.name}`, wpath, {
            element: el,
            hint: elsewhere ? `It is emitted by ${elsewhere.ir.name}; write when: ${elsewhere.ir.name}.${ref.name}` : s ? `Did you mean "${s}"?` : "Events are declared in the emits of an operation or factory",
          });
        }
      }
    }
    const uc = ctx.useCases.find((u) => u.name === p.run);
    if (!uc) {
      const s = closest(p.run, ctx.useCases.map((u) => u.name));
      this.bag.error("unknown-use-case", `Unknown use case "${p.run}" in context ${ctx.name}`, [...p.path, "run"], {
        element: el,
        hint: s ? `Did you mean "${s}"?` : "A policy runs a use case of its own context; declare it under use_cases",
      });
    }
    if (!event || !evCtx) return;
    const cross = evCtx.ir.name !== ctx.name;
    let relationship: RelationshipIR | undefined;
    if (cross) {
      const up = evCtx.ir.name;
      const rels = this.model.relationships.filter((r) => r.upstream === up && r.downstream === ctx.name);
      relationship = rels.find((r) => r.events.includes(event!.name));
      if (!rels.length) {
        this.bag.error("missing-relationship", `Policy ${p.name} consumes ${up}.${event.name} from another context, but no relationship ${up} → ${ctx.name} declares that event contract`, wpath, {
          element: el,
          hint: `Cross-context integration needs an explicit contract. Add at the top level:\nrelationships:\n  - { upstream: ${up}, downstream: ${ctx.name}, pattern: customer_supplier, events: [${event.name}] }`,
        });
      } else if (!relationship) {
        const r = rels[0]!;
        this.bag.error("event-not-in-contract", `Relationship ${up} → ${ctx.name} does not list ${event.name} in its events`, wpath, {
          element: el,
          hint: `Add it to the contract: events: [${[...r.events, event.name].join(", ")}] (relationships[${this.model.relationships.indexOf(r)}])`,
        });
      }
    }
    const info: PolicyInfo = { event: { context: evCtx.ir.name, name: event.name }, crossContext: cross, relationship, usesClock: false, usesIds: false };
    if (uc) this.checkPolicyArgs(ctx, ca, p, uc, event, evCtx, info, el);
    ca.policies.set(p.name, info);
  }

  checkPolicyArgs(ctx: ContextIR, ca: ContextAnalysis, p: PolicyIR, uc: UseCaseIR, event: EventInfo, evCtx: ContextAnalysis, info: PolicyInfo, el: string): void {
    const inputs = ca.fieldTypes.get(uc.command) ?? new Map<string, Type>();
    const eventFields = event.fields.map((f) => f.name);
    for (const k of Object.keys(p.args)) {
      if (!uc.input.some((f) => f.name === k)) {
        const s = closest(k, uc.input.map((f) => f.name));
        this.bag.error("unknown-argument", `Use case ${uc.name} has no input "${k}"`, [...p.path, "args", k], {
          element: el,
          hint: s ? `Did you mean "${s}"?` : uc.input.length ? `Inputs: ${uc.input.map((f) => f.name).join(", ")}` : `${uc.name} takes no input`,
        });
      }
    }
    for (const f of uc.input) {
      const t = inputs.get(f.name);
      const src = p.args[f.name];
      if (src === undefined) {
        if (f.required) {
          const same = event.fields.find((x) => x.name === f.name) ?? (f.name.endsWith("_id") ? event.fields.find((x) => x.name === "id") : undefined);
          this.bag.error("missing-argument", `Missing argument "${f.name}" for use case ${uc.name}`, Object.keys(p.args).length ? [...p.path, "args"] : p.path, {
            element: el,
            hint: same ? `Map it from the event: args: { ${f.name}: event.${same.name} }` : `Use event.<field> (${eventFields.join(", ") || "the event has no fields"}), clock.now, ids.new or a literal`,
          });
        }
        continue;
      }
      if (!t) continue;
      const apath = [...p.path, "args", f.name];
      const m = /^\s*event((?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/.exec(src);
      if (m) {
        const segs = m[1]!.split(".").map((x) => x.trim()).filter(Boolean);
        const e = this.eventPath(event, evCtx, segs, apath, el);
        if (!e) continue;
        if (info.crossContext && crossesAsModelType(e.type)) {
          this.bag.error("cross-context-type", `event.${segs.join(".")} is ${typeToString(e.type)}, a type of ${evCtx.ir.name} that ${ctx.name} cannot hold`, apath, {
            element: el,
            hint: "Across contexts pass values only (String, Integer, UUID, DateTime, …): pick a field of the value object, e.g. event.email.value",
          });
          continue;
        }
        if (!assignable(e.type, t)) {
          this.bag.error("type-mismatch", `event.${segs.join(".")} is ${typeToString(e.type)} but input "${f.name}" of ${uc.name} is ${typeToString(t)}`, apath, {
            element: el,
            hint: e.type.k === "optional" ? "The event field may be null; make the input optional (required: false)" : undefined,
          });
          continue;
        }
        ca.exprs.set(formatPath(apath), e);
        continue;
      }
      const r = checkExpression(src, makeEnv(ctx, { allowPorts: true }), t);
      for (const err of r.errors) {
        this.bag.error("invalid-expression", err.message, apath, {
          element: el,
          hint: /\bevent\b/.test(src) ? "Write event.<field> alone as the argument; policies do not compute with event fields" : err.hint ?? `in "${src}" at column ${err.start + 1}`,
        });
      }
      if (!r.expr) continue;
      walk(r.expr, (n) => {
        if (n.t === "port" && n.port === "clock") info.usesClock = true;
        if (n.t === "port" && n.port === "ids") info.usesIds = true;
      });
      ca.exprs.set(formatPath(apath), r.expr);
    }
  }

  /** Resolves `event.a.b` against the event payload and the upstream context's value objects. */
  eventPath(event: EventInfo, evCtx: ContextAnalysis, segs: string[], path: Path, el: string): TExpr | undefined {
    if (!segs.length) {
      this.bag.error("invalid-expression", "Pass a field of the event, not the event itself", path, { element: el, hint: `e.g. event.${event.fields[0]?.name ?? "id"}` });
      return undefined;
    }
    let cur: TExpr = { t: "local", name: "event", type: { k: "event", name: event.name } };
    let fields = new Map(event.fields.map((f) => [f.name, f.type]));
    let owner = event.name;
    for (const [i, seg] of segs.entries()) {
      const ft = fields.get(seg);
      if (!ft) {
        const s = closest(seg, [...fields.keys()]);
        this.bag.error("unknown-field", `${owner} has no field "${seg}"`, path, { element: el, hint: s ? `Did you mean "${s}"?` : `Fields: ${[...fields.keys()].join(", ") || "none"}` });
        return undefined;
      }
      cur = { t: "field", name: seg, owner: cur, type: ft };
      if (i === segs.length - 1) break;
      if (ft.k === "optional") {
        this.bag.error("invalid-expression", `${owner}.${seg} may be null, so its fields cannot be read here`, path, { element: el });
        return undefined;
      }
      if (ft.k !== "vo" && ft.k !== "entity") {
        this.bag.error("invalid-expression", `${owner}.${seg} is ${typeToString(ft)} and has no fields`, path, { element: el });
        return undefined;
      }
      fields = evCtx.fieldTypes.get(ft.name) ?? new Map();
      owner = ft.name;
    }
    return cur;
  }

  /** A use case that publishes the event its own policy consumes (directly or through other policies) loops forever. */
  checkPolicyCycles(): void {
    const deps = new Map<string, string[]>();
    const via = new Map<string, { ctx: ContextIR; policy: PolicyIR }>();
    for (const ctx of this.model.contexts) {
      const ca = this.contexts.get(ctx.name);
      if (!ca) continue;
      for (const p of ctx.policies) {
        const info = ca.policies.get(p.name);
        const uc = ca.useCases.get(p.run);
        if (!info || !uc) continue;
        const from = `${info.event.context}.${info.event.name}`;
        const to = uc.publishes.map((e) => `${ctx.name}.${e}`);
        deps.set(from, [...(deps.get(from) ?? []), ...to]);
        for (const t of to) if (!via.has(`${from}→${t}`)) via.set(`${from}→${t}`, { ctx, policy: p });
      }
    }
    for (const cycle of findCycles(deps)) {
      const steps = cycle.map((n, i) => ({ node: n, by: via.get(`${n}→${cycle[(i + 1) % cycle.length]}`) }));
      const first = steps[0]!.by;
      if (!first) continue;
      const chain = steps.map((s) => `${s.node} → (${s.by ? `${s.by.ctx.name}.${s.by.policy.name}` : "?"})`).join(" → ");
      this.bag.warning("policy-cycle", `Policies form a loop: ${chain} → ${cycle[0]}`, [...first.policy.path, "when"], {
        element: this.el(first.ctx, first.policy),
        hint: "Each event runs a use case that publishes an event of the loop again. Stop the chain with a condition in a use case, or split the reaction",
      });
    }
  }

  checkContractUsage(): void {
    for (const r of this.model.relationships) {
      const down = this.contexts.get(r.downstream);
      const up = this.contexts.get(r.upstream);
      if (!down || !up || r.pattern === "separate_ways") continue;
      r.events.forEach((e, i) => {
        const consumed = [...down.policies.values()].some((p) => p.event.context === r.upstream && p.event.name === e);
        if (!consumed && up.events.has(e)) {
          this.bag.info("unused-contract-event", `${r.downstream} has no policy that consumes ${r.upstream}.${e}`, [...r.path, "events", i], {
            element: this.relEl(r),
            hint: `Add a policy to ${r.downstream} with when: ${r.upstream}.${e}, or remove the event from the contract`,
          });
        }
      });
    }
  }
}

/** Parses a policy's `when`: `Event` or `Context.Event`. */
export function parseEventRef(src: string): { context?: string; name: string } | undefined {
  const m = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(src);
  if (!m) return undefined;
  return m[1] ? { context: m[1], name: m[2]! } : { name: m[2]! };
}

/** Enum / value object / entity types are classes of one context and cannot cross a context boundary. */
function crossesAsModelType(t: Type): boolean {
  const b = unwrap(t);
  return b.k === "enum" || b.k === "vo" || b.k === "entity" || b.k === "aggregate";
}

function checkSnakeName(bag: DiagnosticBag, name: string, what: string, path: Path, element?: string): void {
  if (!SNAKE.test(name)) {
    bag.error("invalid-name", `${what} "${name}" must be snake_case`, path, { element, hint: `e.g. ${toSnake(name)}` });
  } else if (PY_KEYWORDS.has(name)) {
    bag.error("reserved-name", `${what} "${name}" is a Python keyword`, path, { element, hint: `e.g. ${name}_` });
  } else if (name.startsWith("model_") || RESERVED_MEMBERS.has(name)) {
    bag.error("reserved-name", `${what} "${name}" clashes with a generated or Pydantic member name`, path, { element });
  }
}

class ContextValidator {
  readonly fieldTypes = new Map<string, Map<string, Type>>();
  readonly exprs = new Map<string, TExpr>();
  readonly events = new Map<string, EventInfo>();
  readonly useCases = new Map<string, UseCaseInfo>();
  readonly policies = new Map<string, PolicyInfo>();
  /** Names that become Python classes in the context namespace. */
  readonly typeNames = new Map<string, { kind: string; path: Path }>();

  constructor(
    readonly bag: DiagnosticBag,
    readonly ctx: ContextIR,
  ) {}

  el(...parts: (string | undefined)[]): string {
    return [this.ctx.name, ...parts.filter(Boolean)].join(" › ");
  }

  run(): ContextAnalysis {
    this.registerTypes();
    this.checkErrors();
    this.checkEnums();
    for (const vo of this.ctx.valueObjects) this.checkValueObject(vo);
    this.checkValueObjectCycles();
    for (const ag of this.ctx.aggregates) this.checkAggregate(ag);
    this.checkExtensionPoints();
    for (const uc of this.ctx.useCases) this.checkUseCase(uc);
    this.checkDuplicateSnake(
      this.ctx.useCases.map((u) => ({ name: u.name, path: [...u.path, "name"] })),
      "use case",
    );
    for (const ag of this.ctx.aggregates) {
      this.checkDuplicateSnake(ag.scenarios.map((s) => ({ name: s.name, path: [...s.path, "name"] })), "scenario", this.el(ag.name));
      for (const sc of ag.scenarios) this.checkAggregateScenario(ag, sc);
    }
    for (const uc of this.ctx.useCases) {
      this.checkDuplicateSnake(uc.scenarios.map((s) => ({ name: s.name, path: [...s.path, "name"] })), "scenario", this.el(uc.name));
      for (const sc of uc.scenarios) this.checkUseCaseScenario(uc, sc);
    }
    return { ir: this.ctx, fieldTypes: this.fieldTypes, exprs: this.exprs, events: this.events, useCases: this.useCases, policies: this.policies };
  }

  // -- registration & naming ------------------------------------------------

  registerTypes(): void {
    const reg = (name: string, kind: string, path: Path) => {
      if (!PASCAL.test(name)) {
        this.bag.error("invalid-name", `${kind} name "${name}" must be PascalCase`, path, { element: this.el(name) });
      }
      if (RESERVED_TYPES.has(name)) {
        this.bag.error("reserved-name", `"${name}" is reserved by the generator`, path, { element: this.el(name), hint: `Rename the ${kind}` });
      }
      const prev = this.typeNames.get(name);
      if (prev) {
        this.bag.error("duplicate-name", `"${name}" is already defined as a ${prev.kind}`, path, { element: this.el(name) });
        return;
      }
      this.typeNames.set(name, { kind, path });
    };
    for (const e of this.ctx.errors) reg(e.name, "error", [...e.path, "name"]);
    for (const e of this.ctx.enums) reg(e.name, "enum", [...e.path, "name"]);
    for (const v of this.ctx.valueObjects) reg(v.name, "value object", [...v.path, "name"]);
    for (const a of this.ctx.aggregates) {
      reg(a.name, "aggregate", [...a.path, "name"]);
      reg(`${a.name}Repository`, "repository", [...a.path, "name"]);
      for (const en of a.entities) reg(en.name, "entity", [...en.path, "name"]);
    }
    for (const u of this.ctx.useCases) {
      reg(u.command, "command", [...u.path, "command"]);
      reg(`${pascal(u.name)}UseCase`, "use case class", [...u.path, "name"]);
    }
    for (const p of this.ctx.policies) reg(`${pascal(p.name)}Policy`, "policy class", [...p.path, "name"]);
    // Events are registered once each (possibly emitted from several places).
    const eventSeen = new Set<string>();
    for (const a of this.ctx.aggregates) {
      for (const m of [...a.factories, ...a.operations]) {
        for (const e of m.emits) {
          if (!eventSeen.has(e.name)) {
            eventSeen.add(e.name);
            reg(e.name, "event", [...e.path, "name"]);
          }
        }
      }
    }
  }

  checkSnake(name: string, what: string, path: Path, element?: string): void {
    checkSnakeName(this.bag, name, what, path, element);
  }

  checkDuplicateSnake(items: { name: string; path: Path }[], what: string, element?: string): void {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.name)) this.bag.error("duplicate-name", `Duplicate ${what} "${it.name}"`, it.path, { element });
      seen.add(it.name);
    }
  }

  resolve(typeSrc: string, path: Path, aggregate?: string, element?: string): Type | undefined {
    const r = resolveType(typeSrc, { context: this.ctx, aggregate });
    if (!r.ok) {
      this.bag.error("unknown-type", r.message, path, { hint: r.hint, element });
      return undefined;
    }
    return r.type;
  }

  // -- fields ---------------------------------------------------------------

  checkFields(ownerName: string, fields: FieldIR[], opts: { aggregate?: string; element: string; allowAggregateTypes?: boolean; allowEntity?: boolean }): Map<string, Type> {
    const types = new Map<string, Type>();
    this.checkDuplicateSnake(fields.map((f) => ({ name: f.name, path: [...f.path, "name"] })), "field", opts.element);
    for (const f of fields) {
      this.checkSnake(f.name, "Field name", [...f.path, "name"], opts.element);
      const t = this.resolve(f.type, [...f.path, "type"], opts.aggregate, opts.element);
      if (!t) continue;
      const base = t.k === "list" ? t.item : t;
      if (base.k === "aggregate") {
        this.bag.error("aggregate-boundary", `Field "${f.name}" holds aggregate ${base.name} directly`, [...f.path, "type"], {
          element: opts.element,
          hint: `Reference other aggregates by identity: Ref[${base.name}]`,
        });
        continue;
      }
      if (base.k === "entity" && !opts.allowEntity) {
        this.bag.error("aggregate-boundary", `Field "${f.name}" of ${ownerName} cannot hold entity ${base.name}`, [...f.path, "type"], {
          element: opts.element,
          hint: "Value objects, commands and events may only contain values, not entities",
        });
        continue;
      }
      if (t.k === "optional") {
        this.bag.error("invalid-type", `Use "required: false" instead of Optional[...]`, [...f.path, "type"], { element: opts.element });
        continue;
      }
      this.checkConstraints(f, t, opts.element);
      types.set(f.name, f.required ? t : { k: "optional", inner: t });
    }
    this.fieldTypes.set(ownerName, types);
    return types;
  }

  checkConstraints(f: FieldIR, t: Type, element: string): void {
    const c = f.constraints;
    const p = [...f.path, "constraints"];
    const isStr = t.k === "primitive" && t.name === "String";
    const isNum = t.k === "primitive" && (t.name === "Integer" || t.name === "Decimal");
    const isDec = t.k === "primitive" && t.name === "Decimal";
    const isList = t.k === "list";
    const need = (keys: (keyof typeof c)[], ok: boolean, what: string) => {
      for (const k of keys) {
        if (c[k] !== undefined && !ok) {
          this.bag.error("invalid-constraint", `Constraint "${k}" applies only to ${what}, but "${f.name}" is ${typeToString(t)}`, [...p, k], { element });
        }
      }
    };
    need(["min_length", "max_length", "pattern"], isStr, "String fields");
    need(["min", "max"], isNum, "Integer or Decimal fields");
    need(["max_digits", "decimal_places"], isDec, "Decimal fields");
    need(["min_items", "max_items"], isList, "List fields");
    const pairs: [keyof typeof c, keyof typeof c][] = [
      ["min_length", "max_length"],
      ["min", "max"],
      ["min_items", "max_items"],
    ];
    for (const [lo, hi] of pairs) {
      const a = c[lo] as number | undefined;
      const b = c[hi] as number | undefined;
      if (a !== undefined && b !== undefined && a > b) {
        this.bag.error("invalid-constraint", `${lo} (${a}) is greater than ${hi} (${b})`, [...p, lo], { element });
      }
    }
    for (const k of ["min_length", "max_length", "min_items", "max_items", "max_digits", "decimal_places"] as const) {
      const v = c[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        this.bag.error("invalid-constraint", `${k} must be a non-negative integer`, [...p, k], { element });
      }
    }
    if (c.pattern !== undefined) {
      try {
        new RegExp(c.pattern);
      } catch {
        this.bag.error("invalid-constraint", `pattern is not a valid regular expression`, [...p, "pattern"], { element });
      }
      if (/\(\?<[A-Za-z]/.test(c.pattern)) {
        this.bag.warning("portability", "Named groups differ between JavaScript and Python; prefer plain groups", [...p, "pattern"], { element });
      }
    }
  }

  // -- errors & enums -------------------------------------------------------

  checkErrors(): void {
    const codes = new Map<string, Path>();
    for (const e of this.ctx.errors) {
      const el = this.el(e.name);
      if (!SNAKE.test(e.code)) this.bag.error("invalid-name", `Error code "${e.code}" must be snake_case`, [...e.path, "code"], { element: el });
      if (codes.has(e.code)) this.bag.error("duplicate-name", `Error code "${e.code}" is used by more than one error`, [...e.path, "code"], { element: el });
      codes.set(e.code, e.path);
      if (!e.message.trim()) this.bag.error("missing-key", "Error message must not be empty", [...e.path, "message"], { element: el });
      const details = this.checkFields(e.name, e.details, { element: el });
      for (const n of details.keys()) {
        if (["message", "code", "details", "args"].includes(n)) {
          this.bag.error("reserved-name", `Error detail "${n}" clashes with the exception API`, [...e.path, "details"], { element: el });
        }
      }
    }
  }

  checkEnums(): void {
    for (const e of this.ctx.enums) {
      const el = this.el(e.name);
      if (e.values.length === 0) this.bag.error("empty-enum", `Enum ${e.name} has no values`, [...e.path, "values"], { element: el });
      const seen = new Set<string>();
      e.values.forEach((v, i) => {
        if (!SNAKE.test(v)) this.bag.error("invalid-name", `Enum value "${v}" must be snake_case`, [...e.path, "values", i], { element: el });
        if (seen.has(v)) this.bag.error("duplicate-name", `Duplicate enum value "${v}"`, [...e.path, "values", i], { element: el });
        seen.add(v);
      });
    }
  }

  // -- value objects --------------------------------------------------------

  checkValueObject(vo: ValueObjectIR): void {
    const el = this.el(vo.name);
    if (vo.fields.length === 0) this.bag.error("empty-value-object", `Value object ${vo.name} has no fields`, [...vo.path, "fields"], { element: el });
    const types = this.checkFields(vo.name, vo.fields, { element: el });
    for (const [field, steps] of Object.entries(vo.normalize)) {
      const t = types.get(field);
      const np = [...vo.path, "normalize", field];
      if (!vo.fields.some((f) => f.name === field)) {
        this.bag.error("unknown-field", `normalize refers to unknown field "${field}"`, np, { element: el });
      } else if (t && !(t.k === "primitive" && t.name === "String") && !(t.k === "optional" && sameType(t.inner, T.String))) {
        this.bag.error("invalid-normalize", `normalize applies only to String fields; "${field}" is ${typeToString(t)}`, np, { element: el });
      }
      if (steps.includes("lower") && steps.includes("upper")) {
        this.bag.warning("invalid-normalize", `normalize for "${field}" has both lower and upper; the last one wins`, np, { element: el });
      }
    }
    this.checkInvariants(vo.invariants, makeEnv(this.ctx, { self: { name: vo.name, fields: types } }), el, types, true);
  }

  checkValueObjectCycles(): void {
    const deps = new Map<string, string[]>();
    for (const vo of this.ctx.valueObjects) {
      const t = this.fieldTypes.get(vo.name) ?? new Map();
      deps.set(
        vo.name,
        [...t.values()].flatMap((x) => {
          const b = unwrap(x);
          return b.k === "vo" ? [b.name] : [];
        }),
      );
    }
    for (const cycle of findCycles(deps)) {
      const vo = this.ctx.valueObjects.find((v) => v.name === cycle[0])!;
      this.bag.error("circular-dependency", `Value objects form a cycle: ${cycle.join(" → ")} → ${cycle[0]}`, [...vo.path, "fields"], {
        element: this.el(vo.name),
        hint: "Break the cycle; value objects must be finite values",
      });
    }
  }

  // -- invariants / guards --------------------------------------------------

  checkInvariants(invariants: InvariantIR[], env: ExprEnv, el: string, fields: Map<string, Type>, valueObject: boolean): void {
    for (const inv of invariants) {
      const iel = `${el} › ${inv.name}`;
      this.checkSnake(inv.name, "Invariant name", [...inv.path, "name"], iel);
      if (fields.has(inv.name)) this.bag.error("duplicate-name", `Invariant "${inv.name}" has the same name as a field`, [...inv.path, "name"], { element: iel });
      this.checkErrorRef(inv.error, [...inv.path, "error"], iel);
      if (inv.checkOn.length === 0) this.bag.error("invalid-value", "check_on must list at least one timing", [...inv.path, "check_on"], { element: iel });
      if (!valueObject && inv.checkOn.length === 1 && inv.checkOn[0] === "construct") {
        this.bag.info(
          "construct-implies-transition",
          "With immutable replacement every transition constructs a new instance, so this invariant is also checked after transitions",
          [...inv.path, "check_on"],
          { element: iel },
        );
      }
      const e = this.expr(inv.expression, [...inv.path, "expression"], env, T.Boolean, iel);
      if (e && referencedFields(e).size === 0) {
        this.bag.warning("constant-rule", `Invariant ${inv.name} does not reference any field`, [...inv.path, "expression"], { element: iel });
      }
    }
  }

  expr(src: string, path: Path, env: ExprEnv, expected: Type | undefined, element: string): TExpr | undefined {
    const r = checkExpression(src, env, expected);
    for (const err of r.errors) {
      this.bag.error("invalid-expression", err.message, path, {
        element,
        hint: err.hint ?? `in "${src}" at column ${err.start + 1}`,
      });
    }
    if (r.expr && r.nodeCount > 25) {
      this.bag.warning("complex-rule", `Expression is complex (${r.nodeCount} nodes)`, path, {
        element,
        hint: "Split it into several named rules so each one can be reviewed and tested separately",
      });
    }
    if (r.expr) this.exprs.set(formatPath(path), r.expr);
    return r.expr;
  }

  checkErrorRef(name: string, path: Path, element: string): void {
    if (this.ctx.errors.some((e) => e.name === name)) return;
    const s = closest(name, this.ctx.errors.map((e) => e.name));
    this.bag.error("unknown-error", `Unknown domain error "${name}"`, path, {
      element,
      hint: s ? `Did you mean "${s}"?` : `Declare it under contexts[].errors`,
    });
  }

  params(params: ParameterIR[], el: string, aggregate?: string): Map<string, Type> {
    const m = new Map<string, Type>();
    this.checkDuplicateSnake(params.map((p) => ({ name: p.name, path: [...p.path, "name"] })), "parameter", el);
    for (const p of params) {
      this.checkSnake(p.name, "Parameter name", [...p.path, "name"], el);
      const t = this.resolve(p.type, [...p.path, "type"], aggregate, el);
      if (t) m.set(p.name, p.required ? t : { k: "optional", inner: t });
    }
    return m;
  }

  // -- aggregates -----------------------------------------------------------

  checkEntityBase(en: EntityIR, aggregate: string): Map<string, Type> {
    const el = this.el(aggregate === en.name ? en.name : `${aggregate} › ${en.name}`);
    const types = this.checkFields(en.name, en.fields, { aggregate, element: el, allowEntity: true });
    const id = en.fields.find((f) => f.name === en.identity);
    if (!id) {
      this.bag.error("unknown-field", `Identity field "${en.identity}" is not defined`, [...en.path, "identity"], { element: el, hint: `Add a field named ${en.identity}` });
    } else {
      const t = types.get(id.name);
      if (!id.required) this.bag.error("invalid-identity", "The identity field must be required", [...id.path, "required"], { element: el });
      if (t && !(t.k === "primitive" && ["UUID", "String", "Integer"].includes(t.name))) {
        this.bag.error("invalid-identity", `Identity must be UUID, String or Integer, got ${typeToString(t)}`, [...id.path, "type"], { element: el });
      }
    }
    return types;
  }

  checkAggregate(ag: AggregateIR): void {
    const el = this.el(ag.name);
    const types = this.checkEntityBase(ag, ag.name);
    for (const en of ag.entities) {
      const et = this.checkEntityBase(en, ag.name);
      this.checkInvariants(en.invariants, makeEnv(this.ctx, { self: { name: en.name, fields: et } }), this.el(`${ag.name} › ${en.name}`), et, false);
    }
    // Entity cycles within the aggregate
    const deps = new Map<string, string[]>();
    for (const en of [ag, ...ag.entities]) {
      const t = this.fieldTypes.get(en.name) ?? new Map();
      deps.set(en.name, [...t.values()].flatMap((x) => (unwrap(x).k === "entity" ? [(unwrap(x) as { name: string }).name] : [])));
    }
    for (const cycle of findCycles(deps)) {
      this.bag.error("circular-dependency", `Entities form a cycle: ${cycle.join(" → ")} → ${cycle[0]}`, [...ag.path, "entities"], { element: el });
    }
    // Unused internal entity
    const used = new Set([...deps.values()].flat());
    for (const en of ag.entities) {
      if (!used.has(en.name)) {
        this.bag.warning("unused-entity", `Entity ${en.name} is not reachable from aggregate root ${ag.name}`, [...en.path, "name"], {
          element: el,
          hint: "Internal entities must be held by the root (directly or via another entity)",
        });
      }
    }
    // Size heuristics — diagnose only, never split automatically.
    const size = ag.fields.length + ag.entities.reduce((n, e) => n + e.fields.length, 0);
    if (size > 25 || ag.entities.length > 5 || ag.operations.length > 15) {
      this.bag.warning("large-aggregate", `Aggregate ${ag.name} is large (${size} fields, ${ag.entities.length} entities, ${ag.operations.length} operations)`, [...ag.path, "name"], {
        element: el,
        hint: "Consider whether all of it must be consistent in one transaction; split candidates are yours to decide",
      });
    }

    // Member names become methods on the same class.
    const members: { name: string; path: Path }[] = [
      ...ag.invariants.map((x) => ({ name: x.name, path: [...x.path, "name"] })),
      ...ag.stateGuards.map((x) => ({ name: x.name, path: [...x.path, "name"] })),
      ...ag.factories.map((x) => ({ name: x.name, path: [...x.path, "name"] })),
      ...ag.operations.map((x) => ({ name: x.name, path: [...x.path, "name"] })),
    ];
    this.checkDuplicateSnake(members, "member (invariant / guard / factory / operation)", el);
    for (const m of members) {
      if (types.has(m.name)) this.bag.error("duplicate-name", `"${m.name}" is both a field and a member of ${ag.name}`, m.path, { element: el });
    }

    const selfEnv = () => makeEnv(this.ctx, { self: { name: ag.name, fields: types, aggregate: ag } });
    this.checkInvariants(ag.invariants, selfEnv(), el, types, false);

    for (const g of ag.stateGuards) {
      const gel = `${el} › ${g.name}`;
      this.checkSnake(g.name, "State guard name", [...g.path, "name"], gel);
      this.checkErrorRef(g.error, [...g.path, "error"], gel);
      const params = this.params(g.parameters, gel, ag.name);
      const env = selfEnv();
      env.params = params;
      this.expr(g.expression, [...g.path, "expression"], env, T.Boolean, gel);
    }

    for (const f of ag.factories) {
      const fel = `${el} › ${f.name}`;
      this.checkSnake(f.name, "Factory name", [...f.path, "name"], fel);
      const params = this.params(f.parameters, fel, ag.name);
      if (f.require.length) {
        this.bag.error("invalid-require", "Factories cannot require state guards because no state exists yet", [...f.path, "require"], {
          element: fel,
          hint: "Express creation preconditions as invariants (checked on construct)",
        });
      }
      const env = makeEnv(this.ctx, { params });
      for (const [field, src] of Object.entries(f.fields)) {
        const t = types.get(field);
        if (!t) {
          this.bag.error("unknown-field", `${ag.name} has no field "${field}"`, [...f.path, "fields", field], { element: fel });
          continue;
        }
        this.expr(src, [...f.path, "fields", field], env, t, fel);
      }
      for (const fd of ag.fields) {
        if (fd.required && !(fd.name in f.fields)) {
          this.bag.error("missing-field", `Factory ${f.name} does not set required field "${fd.name}"`, [...f.path, "fields"], { element: fel });
        }
      }
      this.checkEmits(ag, f.name, "factory", f.emits, params, types, fel);
    }

    for (const op of ag.operations) {
      const oel = `${el} › ${op.name}`;
      this.checkSnake(op.name, "Operation name", [...op.path, "name"], oel);
      const params = this.params(op.parameters, oel, ag.name);
      for (const p of params.keys()) {
        if (types.has(p)) {
          this.bag.warning("shadowed-field", `Parameter "${p}" shadows field ${ag.name}.${p} inside ${op.name}`, [...op.path, "parameters"], {
            element: oel,
            hint: "Rename the parameter so rules are unambiguous",
          });
        }
      }
      op.require.forEach((src, i) => {
        const env = selfEnv();
        env.params = params;
        env.allowSelfGuards = true;
        const e = this.expr(src, [...op.path, "require", i], env, T.Boolean, oel);
        if (e && !(e.t === "guard" && !e.receiver)) {
          this.bag.error("invalid-require", `require entries must name a state guard of ${ag.name}, e.g. "pending_until_expiry(at)"`, [...op.path, "require", i], {
            element: oel,
            hint: "Write general conditions as a named state guard so the rule has a name and an error",
          });
          this.exprs.delete(formatPath([...op.path, "require", i]));
        }
      });
      const env = selfEnv();
      env.params = params;
      for (const [field, src] of Object.entries(op.changes)) {
        const t = types.get(field);
        if (!t) {
          this.bag.error("unknown-field", `${ag.name} has no field "${field}"`, [...op.path, "changes", field], {
            element: oel,
            hint: closest(field, [...types.keys()]) ? `Did you mean "${closest(field, [...types.keys()])}"?` : undefined,
          });
          continue;
        }
        if (field === ag.identity) {
          this.bag.error("identity-change", `Operation ${op.name} must not change the identity field "${field}"`, [...op.path, "changes", field], { element: oel });
          continue;
        }
        this.expr(src, [...op.path, "changes", field], env, t, oel);
      }
      if (Object.keys(op.changes).length === 0 && op.emits.length === 0) {
        this.bag.warning("noop-operation", `Operation ${op.name} neither changes state nor emits events`, [...op.path, "name"], { element: oel });
      }
      this.checkEmits(ag, op.name, "operation", op.emits, params, types, oel);
    }
  }

  checkEmits(
    ag: AggregateIR,
    member: string,
    kind: "operation" | "factory",
    emits: EventEmissionIR[],
    params: Map<string, Type>,
    fieldTypes: Map<string, Type>,
    el: string,
  ): void {
    const seen = new Set<string>();
    for (const em of emits) {
      if (seen.has(em.name)) {
        this.bag.error("duplicate-event", `Event ${em.name} is emitted more than once by ${member}`, [...em.path, "name"], { element: el });
      }
      seen.add(em.name);
      const payload: { name: string; type: Type }[] = [];
      const fieldNames = new Set<string>();
      // Event payload expressions see the post-transition state and the parameters.
      const env = makeEnv(this.ctx, { self: { name: ag.name, fields: fieldTypes, aggregate: ag }, params });
      for (const fd of em.fields) {
        if (fieldNames.has(fd.name)) this.bag.error("duplicate-name", `Duplicate event field "${fd.name}"`, fd.path, { element: el });
        fieldNames.add(fd.name);
        this.checkSnake(fd.name, "Event field", fd.path, el);
        if (fd.value !== undefined) {
          const e = this.expr(fd.value, [...fd.path, "value"], env, undefined, el);
          if (e) payload.push({ name: fd.name, type: e.type });
          continue;
        }
        const pt = params.get(fd.name);
        const ft = fieldTypes.get(fd.name);
        if (pt && ft && !sameType(pt, ft)) {
          this.bag.error("ambiguous-event-field", `Event field "${fd.name}" matches both a parameter and a field with different types`, fd.path, {
            element: el,
            hint: `Use { name: ${fd.name}, value: <expression> } to choose explicitly`,
          });
          continue;
        }
        const t = pt ?? ft;
        if (t && (unwrap(t).k === "entity" || unwrap(t).k === "aggregate")) {
          this.bag.error("invalid-event-field", `Event field "${fd.name}" carries ${typeToString(t)}; events must carry values`, fd.path, {
            element: el,
            hint: "Put the identity or a value object in the event instead of an entity",
          });
          continue;
        }
        if (!t) {
          this.bag.error("unknown-field", `Event field "${fd.name}" is neither a parameter of ${member} nor a field of ${ag.name}`, fd.path, {
            element: el,
            hint: `Use { name: ${fd.name}, value: <expression> } for computed values`,
          });
          continue;
        }
        payload.push({ name: fd.name, type: t });
      }
      if (em.when !== undefined) this.expr(em.when, [...em.path, "when"], env, T.Boolean, el);

      const existing = this.events.get(em.name);
      if (!existing) {
        this.events.set(em.name, { name: em.name, fields: payload, sources: [{ aggregate: ag.name, member, kind }] });
      } else {
        const same =
          existing.fields.length === payload.length &&
          existing.fields.every((f, i) => f.name === payload[i]!.name && sameType(f.type, payload[i]!.type));
        if (!same) {
          this.bag.error("event-contract-mismatch", `Event ${em.name} is emitted with a different payload than in ${existing.sources[0]!.aggregate}.${existing.sources[0]!.member}`, [...em.path, "fields"], {
            element: el,
            hint: "An event name defines one contract; use the same fields everywhere or rename the event",
          });
        }
        existing.sources.push({ aggregate: ag.name, member, kind });
      }
    }
  }

  // -- extension points -----------------------------------------------------

  checkExtensionPoints(): void {
    this.checkDuplicateSnake(this.ctx.extensionPoints.map((x) => ({ name: x.name, path: [...x.path, "name"] })), "extension point");
    for (const x of this.ctx.extensionPoints) {
      const el = this.el(x.name);
      this.checkSnake(x.name, "Extension point name", [...x.path, "name"], el);
      if (["is_empty", "contains", "length"].includes(x.name)) {
        this.bag.error("reserved-name", `"${x.name}" is a built-in rule function`, [...x.path, "name"], { element: el });
      }
      this.params(x.parameters, el);
      const rt = this.resolve(x.returns, [...x.path, "returns"], undefined, el);
      if (rt && (rt.k === "aggregate" || rt.k === "entity")) {
        this.bag.error("invalid-type", "Extension points must return values, not aggregates or entities", [...x.path, "returns"], { element: el });
      }
      if (rt && x.testDefault !== undefined) this.checkValue(x.testDefault, rt, [...x.path, "test_default"], el);
    }
  }

  // -- use cases ------------------------------------------------------------

  checkUseCase(uc: UseCaseIR): void {
    const el = this.el(uc.name);
    this.checkSnake(uc.name, "Use case name", [...uc.path, "name"], el);
    const inputTypes = this.checkFields(uc.command, uc.input, { element: el });
    if (uc.idempotencyKey && !inputTypes.has(uc.idempotencyKey)) {
      this.bag.error("unknown-field", `idempotency_key "${uc.idempotencyKey}" is not an input field`, [...uc.path, "idempotency_key"], { element: el });
    }
    if (uc.retry && !uc.idempotencyKey) {
      this.bag.warning("missing-idempotency-key", `Use case ${uc.name} may be retried but declares no idempotency_key`, [...uc.path, "retry"], {
        element: el,
        hint: "Retries without an idempotency key can apply the same change twice",
      });
    }
    if (uc.steps.length === 0) this.bag.warning("empty-use-case", `Use case ${uc.name} has no steps`, [...uc.path, "steps"], { element: el });

    const info: UseCaseInfo = { usesClock: false, usesIds: false, repositories: [], extensions: [], publishes: [], idsCount: 0 };
    const returnTypes: { type: Type; path: Path }[] = [];
    const state: StepState = {
      locals: new Map(inputTypes),
      aggregates: new Map(),
      produced: new Set(),
      dirty: new Map(),
      saved: new Set(),
      terminated: false,
    };
    this.checkSteps(uc, uc.steps, state, info, returnTypes, el);
    if (!state.terminated) {
      for (const [v, p] of state.dirty) {
        if (!state.saved.has(v)) {
          this.bag.warning("unsaved-change", `"${v}" is changed but never saved`, p, { element: el, hint: `Add "- save: ${v}" after the change` });
        }
      }
    }
    if (returnTypes.length) {
      const first = returnTypes[0]!;
      for (const r of returnTypes.slice(1)) {
        if (!sameType(r.type, first.type)) {
          this.bag.error("inconsistent-return", `Returns ${typeToString(r.type)} here but ${typeToString(first.type)} elsewhere`, r.path, { element: el });
        }
      }
      if (!this.allPathsTerminate(uc.steps)) {
        this.bag.error("missing-return", `Some paths through ${uc.name} end without "return" or "fail"`, [...uc.path, "steps"], {
          element: el,
          hint: "Add a return to every branch",
        });
      }
      info.returnType = first.type;
    }
    const dirtyAggregates = new Set([...state.aggregatesTouched ?? []]);
    if (uc.transaction === "required" && dirtyAggregates.size > 1) {
      this.bag.warning("multi-aggregate-transaction", `Use case ${uc.name} changes several aggregates (${[...dirtyAggregates].join(", ")}) in one transaction`, [...uc.path, "steps"], {
        element: el,
        hint: "Aggregates are consistency boundaries; prefer one aggregate per transaction and domain events for the rest",
      });
    }
    info.repositories = uniqSorted(info.repositories);
    info.extensions = uniqSorted(info.extensions);
    info.publishes = uniqSorted(info.publishes);
    this.useCases.set(uc.name, info);
  }

  allPathsTerminate(steps: StepIR[]): boolean {
    for (const s of steps) {
      if (s.kind === "return" || s.kind === "fail") return true;
      if (s.kind === "if" && this.allPathsTerminate(s.then) && this.allPathsTerminate(s.else)) return true;
    }
    return false;
  }

  stepEnv(state: StepState): ExprEnv {
    return makeEnv(this.ctx, { locals: state.locals, allowPorts: true, allowReceiverGuards: true, allowExtensions: true });
  }

  noteUsage(e: TExpr | undefined, info: UseCaseInfo): void {
    if (!e) return;
    walk(e, (n) => {
      if (n.t === "port" && n.port === "clock") info.usesClock = true;
      if (n.t === "port" && n.port === "ids") {
        info.usesIds = true;
        info.idsCount++;
      }
      if (n.t === "extension") info.extensions.push(n.name);
    });
  }

  checkSteps(uc: UseCaseIR, steps: StepIR[], state: StepState, info: UseCaseInfo, returns: { type: Type; path: Path }[], el: string): void {
    for (const step of steps) {
      if (state.terminated) {
        this.bag.error("unreachable-step", "This step can never run because a previous step returns or fails", step.path, { element: el });
        return;
      }
      switch (step.kind) {
        case "load": {
          const ag = this.ctx.aggregates.find((a) => a.name === step.aggregate);
          if (!ag) {
            this.unknownAggregate(step.aggregate, [...step.path, "aggregate"], el);
            break;
          }
          info.repositories.push(ag.name);
          const idType = this.fieldTypes.get(ag.name)?.get(ag.identity);
          this.expr(step.by, [...step.path, "by"], this.stepEnv(state), idType, el);
          if (step.notFound) this.checkErrorRef(step.notFound, [...step.path, "not_found"], el);
          else {
            this.bag.info("default-not-found", `No not_found error declared; the generic AggregateNotFound is raised`, step.path, { element: el });
          }
          this.bind(step.as, ag.name, [...step.path, "as"], state, el);
          break;
        }
        case "create": {
          const ag = this.ctx.aggregates.find((a) => a.name === step.aggregate);
          if (!ag) {
            this.unknownAggregate(step.aggregate, [...step.path, "aggregate"], el);
            break;
          }
          info.repositories.push(ag.name);
          const f = ag.factories.find((x) => x.name === step.factory);
          if (!f) {
            this.bag.error("unknown-member", `${ag.name} has no factory "${step.factory}"`, [...step.path, "factory"], {
              element: el,
              hint: ag.factories.length ? `Factories: ${ag.factories.map((x) => x.name).join(", ")}` : `Declare it under ${ag.name}.factories`,
            });
            break;
          }
          this.checkArgs(ag, f.name, f.parameters, step.args, [...step.path, "args"], state, info, el);
          for (const em of f.emits) state.produced.add(em.name);
          this.bind(step.as, ag.name, [...step.path, "as"], state, el);
          state.dirty.set(step.as, step.path);
          (state.aggregatesTouched ??= new Set()).add(ag.name);
          break;
        }
        case "invoke": {
          const agName = state.aggregates.get(step.target);
          if (!agName) {
            this.bag.error("unknown-variable", `"${step.target}" is not a loaded or created aggregate`, [...step.path, "target"], {
              element: el,
              hint: "Load it first with a load step",
            });
            break;
          }
          const ag = this.ctx.aggregates.find((a) => a.name === agName)!;
          const op = ag.operations.find((o) => o.name === step.operation);
          if (!op) {
            const s = closest(step.operation, ag.operations.map((o) => o.name));
            this.bag.error("unknown-member", `${ag.name} has no operation "${step.operation}"`, [...step.path, "operation"], {
              element: el,
              hint: s ? `Did you mean "${s}"?` : undefined,
            });
            break;
          }
          this.checkArgs(ag, op.name, op.parameters, step.args, [...step.path, "args"], state, info, el);
          for (const em of op.emits) state.produced.add(em.name);
          if (Object.keys(op.changes).length) state.dirty.set(step.target, step.path);
          (state.aggregatesTouched ??= new Set()).add(ag.name);
          break;
        }
        case "save": {
          if (!state.aggregates.has(step.target)) {
            this.bag.error("unknown-variable", `"${step.target}" is not a loaded or created aggregate`, step.path, { element: el });
            break;
          }
          if (!state.dirty.has(step.target)) {
            this.bag.info("save-unchanged", `"${step.target}" is saved without being changed`, step.path, { element: el });
          }
          state.saved.add(step.target);
          break;
        }
        case "publish": {
          if (!this.events.has(step.event)) {
            const s = closest(step.event, [...this.events.keys()]);
            this.bag.error("unknown-event", `Event ${step.event} is not emitted by any operation or factory`, step.path, {
              element: el,
              hint: s ? `Did you mean "${s}"?` : "Declare it in an operation's emits",
            });
            break;
          }
          if (!state.produced.has(step.event)) {
            this.bag.error("event-not-produced", `Event ${step.event} is published but no earlier step in this path emits it`, step.path, {
              element: el,
              hint: "Invoke the operation or factory that emits it before publishing",
            });
          }
          if (step.afterCommit && uc.transaction === "none") {
            this.bag.error("publish-after-commit-without-transaction", "publish_after_commit requires transaction: required", step.path, { element: el });
          }
          info.publishes.push(step.event);
          break;
        }
        case "if": {
          const e = this.expr(step.condition, [...step.path, "condition"], this.stepEnv(state), T.Boolean, el);
          this.noteUsage(e, info);
          const a = cloneState(state);
          const b = cloneState(state);
          this.checkSteps(uc, step.then, a, info, returns, el);
          this.checkSteps(uc, step.else, b, info, returns, el);
          if (step.then.length === 0) this.bag.warning("empty-branch", "The then-branch is empty", [...step.path, "then"], { element: el });
          mergeState(state, a, b);
          break;
        }
        case "fail": {
          this.checkErrorRef(step.error, step.path, el);
          state.terminated = true;
          break;
        }
        case "return": {
          const e = this.expr(step.value, step.path, this.stepEnv(state), undefined, el);
          this.noteUsage(e, info);
          if (e) {
            if (e.type.k === "aggregate" || e.type.k === "entity") {
              this.bag.error("invalid-return", "Use cases must not return aggregates or entities; return an identity or value", step.path, { element: el });
            } else {
              returns.push({ type: e.type, path: step.path });
            }
          }
          for (const [v, p] of state.dirty) {
            if (!state.saved.has(v)) this.bag.warning("unsaved-change", `"${v}" is changed but not saved before return`, p, { element: el });
          }
          state.terminated = true;
          break;
        }
      }
    }
  }

  checkArgs(
    ag: AggregateIR,
    member: string,
    params: ParameterIR[],
    args: Record<string, string>,
    path: Path,
    state: StepState,
    info: UseCaseInfo,
    el: string,
  ): void {
    for (const k of Object.keys(args)) {
      if (!params.some((p) => p.name === k)) {
        this.bag.error("unknown-argument", `${ag.name}.${member} has no parameter "${k}"`, [...path, k], { element: el });
      }
    }
    for (const p of params) {
      const src = args[p.name];
      if (src === undefined) {
        if (p.required) this.bag.error("missing-argument", `Missing argument "${p.name}" for ${ag.name}.${member}`, path, { element: el });
        continue;
      }
      const r = resolveType(p.type, { context: this.ctx, aggregate: ag.name });
      if (!r.ok) continue;
      const t: Type = p.required ? r.type : { k: "optional", inner: r.type };
      const e = this.expr(src, [...path, p.name], this.stepEnv(state), t, el);
      this.noteUsage(e, info);
    }
  }

  bind(name: string, aggregate: string, path: Path, state: StepState, el: string): void {
    this.checkSnake(name, "Variable name", path, el);
    if (state.locals.has(name)) {
      this.bag.error("duplicate-name", `"${name}" is already defined in this use case`, path, { element: el });
      return;
    }
    if (name === "clock" || name === "ids") this.bag.error("reserved-name", `"${name}" is reserved for ports`, path, { element: el });
    state.locals.set(name, { k: "aggregate", name: aggregate });
    state.aggregates.set(name, aggregate);
  }

  unknownAggregate(name: string, path: Path, el: string): void {
    const s = closest(name, this.ctx.aggregates.map((a) => a.name));
    this.bag.error("unknown-aggregate", `Unknown aggregate "${name}"`, path, { element: el, hint: s ? `Did you mean "${s}"?` : undefined });
  }

  // -- scenarios ------------------------------------------------------------

  /** Checks a literal scenario value against a type. */
  checkValue(value: unknown, t: Type, path: Path, el: string, aggregate?: string): void {
    const bad = (msg: string, hint?: string) => this.bag.error("invalid-scenario-value", msg, path, { element: el, hint });
    if (t.k === "optional") {
      if (value === null) return;
      return this.checkValue(value, t.inner, path, el, aggregate);
    }
    if (value === null || value === undefined) return bad(`Expected ${typeToString(t)}, got null`);
    switch (t.k) {
      case "primitive":
        switch (t.name) {
          case "String":
            if (typeof value !== "string") bad(`Expected a string, got ${JSON.stringify(value)}`);
            return;
          case "Integer":
            if (typeof value !== "number" || !Number.isInteger(value)) bad(`Expected an integer, got ${JSON.stringify(value)}`);
            return;
          case "Decimal":
            if (!(typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)))) bad(`Expected a decimal, got ${JSON.stringify(value)}`);
            return;
          case "Boolean":
            if (typeof value !== "boolean") bad(`Expected true or false, got ${JSON.stringify(value)}`);
            return;
          case "UUID":
            if (typeof value !== "string" || !UUID_RE.test(value)) bad(`Expected a UUID string, got ${JSON.stringify(value)}`);
            return;
          case "DateTime":
            if (typeof value !== "string" || !DATETIME_RE.test(value)) {
              bad(`Expected an ISO-8601 date-time with UTC offset, got ${JSON.stringify(value)}`, 'e.g. "2026-01-01T10:00:00+00:00". A UTC offset is required so comparisons are unambiguous');
            }
            return;
          case "Date":
            if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`Expected a date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
            return;
        }
        return;
      case "ref":
        if (typeof value !== "string" || !UUID_RE.test(value)) bad(`Expected a UUID string for Ref[${t.target}]`);
        return;
      case "enum": {
        const en = this.ctx.enums.find((e) => e.name === t.name)!;
        if (typeof value !== "string" || !en.values.includes(value)) bad(`Expected one of ${en.values.join(", ")} (${t.name}), got ${JSON.stringify(value)}`);
        return;
      }
      case "list":
        if (!Array.isArray(value)) return bad(`Expected a list, got ${JSON.stringify(value)}`);
        value.forEach((v, i) => this.checkValue(v, t.item, [...path, i], el, aggregate));
        return;
      case "vo":
      case "entity": {
        if (typeof value !== "object" || Array.isArray(value)) return bad(`Expected a mapping for ${t.name}`);
        const fields = this.fieldTypes.get(t.name) ?? new Map<string, Type>();
        this.checkRecord(value as Record<string, unknown>, fields, path, el, `${t.name}`, true);
        return;
      }
      default:
        bad(`Values of type ${typeToString(t)} cannot be written in scenarios`);
    }
  }

  checkRecord(rec: Record<string, unknown>, fields: Map<string, Type>, path: Path, el: string, owner: string, complete: boolean): void {
    for (const [k, v] of Object.entries(rec)) {
      const t = fields.get(k);
      if (!t) {
        const s = closest(k, [...fields.keys()]);
        this.bag.error("unknown-field", `${owner} has no field "${k}"`, [...path, k], { element: el, hint: s ? `Did you mean "${s}"?` : undefined });
        continue;
      }
      this.checkValue(v, t, [...path, k], el);
    }
    if (complete) {
      for (const [k, t] of fields) {
        if (t.k !== "optional" && !(k in rec)) {
          this.bag.error("incomplete-scenario", `Missing value for required field ${owner}.${k}`, path, {
            element: el,
            hint: "Scenarios must state every required value so the expected result is unambiguous",
          });
        }
      }
    }
  }

  checkThenCommon(then: ScenarioThenIR, el: string): void {
    if (then.raises !== undefined && !["ConstraintViolation", "AggregateNotFound"].includes(then.raises)) this.checkErrorRef(then.raises, [...then.path, "raises"], el);
    const empty = then.raises === undefined && then.state === undefined && then.emits === undefined && !then.hasReturns;
    if (empty) {
      this.bag.error("ambiguous-scenario", "then states no expected result", then.path, {
        element: el,
        hint: "Specify at least one of raises, state, emits" + (then.hasReturns ? "" : ", returns"),
      });
    }
    for (const e of then.emits ?? []) {
      const ev = this.events.get(e.event);
      if (!ev) {
        this.bag.error("unknown-event", `Unknown event ${e.event}`, [...e.path], { element: el });
        continue;
      }
      const fm = new Map(ev.fields.map((f) => [f.name, f.type]));
      this.checkRecord(e.fields, fm, [...e.path, "fields"], el, ev.name, false);
    }
  }

  checkAggregateScenario(ag: AggregateIR, sc: AggregateScenarioIR): void {
    const el = this.el(ag.name, `scenario ${sc.name}`);
    this.checkSnake(sc.name, "Scenario name", [...sc.path, "name"], el);
    const fields = this.fieldTypes.get(ag.name) ?? new Map<string, Type>();
    if (sc.given) this.checkRecord(sc.given.aggregate, fields, sc.given.path, el, ag.name, true);
    const w = sc.when;
    if (w.kind === "construct") {
      if (sc.given) this.bag.error("invalid-scenario", "A construct scenario must not have a given aggregate", sc.given.path, { element: el });
      this.checkRecord(w.fields, fields, w.path, el, ag.name, true);
    } else {
      const member =
        w.kind === "operation" ? ag.operations.find((o) => o.name === w.operation) : ag.factories.find((f) => f.name === w.factory);
      const mname = w.kind === "operation" ? w.operation : w.factory;
      if (!member) {
        this.bag.error("unknown-member", `${ag.name} has no ${w.kind} "${mname}"`, [...w.path, w.kind], { element: el });
      } else {
        if (w.kind === "operation" && !sc.given) {
          this.bag.error("incomplete-scenario", "An operation scenario needs given.aggregate", sc.path, { element: el });
        }
        if (w.kind === "factory" && sc.given) this.bag.error("invalid-scenario", "A factory scenario must not have a given aggregate", sc.given.path, { element: el });
        const pm = this.paramTypes(member.parameters, ag.name);
        this.checkRecord(w.args, pm, [...w.path, "args"], el, `${ag.name}.${mname}`, true);
      }
    }
    const then = sc.then;
    this.checkThenCommon(then, el);
    if (then.state !== undefined && !Array.isArray(then.state)) {
      if (then.raises) this.bag.error("invalid-scenario", "A failing scenario has no resulting state; remove then.state", [...then.path, "state"], { element: el });
      this.checkRecord(then.state, fields, [...then.path, "state"], el, ag.name, false);
    }
    if (then.emits && w.kind === "construct" && then.emits.length) {
      this.bag.error("invalid-scenario", "Direct construction does not emit events; use a factory", [...then.path, "emits"], { element: el });
    }
  }

  paramTypes(params: ParameterIR[], aggregate?: string): Map<string, Type> {
    const m = new Map<string, Type>();
    for (const p of params) {
      const r = resolveType(p.type, { context: this.ctx, aggregate });
      if (r.ok) m.set(p.name, p.required ? r.type : { k: "optional", inner: r.type });
    }
    return m;
  }

  checkUseCaseScenario(uc: UseCaseIR, sc: UseCaseScenarioIR): void {
    const el = this.el(uc.name, `scenario ${sc.name}`);
    this.checkSnake(sc.name, "Scenario name", [...sc.path, "name"], el);
    const info = this.useCases.get(uc.name);
    const g = sc.given;
    if (g.clock !== undefined) this.checkValue(g.clock, T.DateTime, [...g.path, "clock"], el);
    if (info?.usesClock && g.clock === undefined) {
      this.bag.error("incomplete-scenario", `Use case ${uc.name} reads clock.now; given.clock is required`, g.path, { element: el });
    }
    g.ids.forEach((id, i) => this.checkValue(id, T.UUID, [...g.path, "ids", i], el));
    if (info?.usesIds && g.ids.length === 0 && sc.then.raises === undefined) {
      this.bag.error("incomplete-scenario", `Use case ${uc.name} generates ids; list them in given.ids`, g.path, { element: el });
    }
    for (const a of g.aggregates) {
      const ag = this.ctx.aggregates.find((x) => x.name === a.type);
      if (!ag) {
        this.unknownAggregate(a.type, a.path, el);
        continue;
      }
      this.checkRecord(a.fields, this.fieldTypes.get(ag.name) ?? new Map(), a.path, el, ag.name, true);
    }
    for (const [name, v] of Object.entries(g.extensions)) {
      const x = this.ctx.extensionPoints.find((e) => e.name === name);
      if (!x) {
        this.bag.error("unknown-extension", `Unknown extension point "${name}"`, [...g.path, "extensions", name], { element: el });
        continue;
      }
      const rt = resolveType(x.returns, { context: this.ctx });
      if (rt.ok) this.checkValue(v, rt.type, [...g.path, "extensions", name], el);
    }
    for (const name of info?.extensions ?? []) {
      const x = this.ctx.extensionPoints.find((e) => e.name === name);
      if (x && x.testDefault === undefined && !(name in g.extensions)) {
        this.bag.error("incomplete-scenario", `Use case ${uc.name} calls extension ${name}; stub it in given.extensions or declare test_default`, g.path, { element: el });
      }
    }
    this.checkRecord(sc.when.input, this.fieldTypes.get(uc.command) ?? new Map(), sc.when.path, el, uc.command, true);
    const then = sc.then;
    this.checkThenCommon(then, el);
    if (then.hasReturns) {
      if (!info?.returnType) this.bag.error("invalid-scenario", `Use case ${uc.name} returns nothing`, [...then.path, "returns"], { element: el });
      else if (then.raises) this.bag.error("invalid-scenario", "A failing scenario cannot also expect a return value", [...then.path, "returns"], { element: el });
      else this.checkValue(then.returns, info.returnType, [...then.path, "returns"], el);
    } else if (info?.returnType && then.raises === undefined) {
      this.bag.warning("unchecked-return", `Scenario does not check the value returned by ${uc.name}`, then.path, { element: el });
    }
    for (const e of then.emits ?? []) {
      if (info && this.events.has(e.event) && !info.publishes.includes(e.event)) {
        this.bag.error("invalid-scenario", `Use case ${uc.name} never publishes ${e.event}`, e.path, {
          element: el,
          hint: info.publishes.length ? `It publishes: ${info.publishes.join(", ")}` : "Add a publish or publish_after_commit step",
        });
      }
    }
    if (Array.isArray(then.state)) {
      for (const s of then.state) {
        const ag = this.ctx.aggregates.find((x) => x.name === s.aggregate);
        if (!ag) {
          this.unknownAggregate(s.aggregate, [...s.path, "aggregate"], el);
          continue;
        }
        const fields = this.fieldTypes.get(ag.name) ?? new Map<string, Type>();
        const idType = fields.get(ag.identity);
        if (idType) this.checkValue(s.id, idType, [...s.path, "id"], el);
        this.checkRecord(s.fields, fields, [...s.path, "fields"], el, ag.name, false);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepState {
  locals: Map<string, Type>;
  aggregates: Map<string, string>;
  produced: Set<string>;
  dirty: Map<string, Path>;
  saved: Set<string>;
  terminated: boolean;
  aggregatesTouched?: Set<string>;
}

function cloneState(s: StepState): StepState {
  return {
    locals: new Map(s.locals),
    aggregates: new Map(s.aggregates),
    produced: new Set(s.produced),
    dirty: new Map(s.dirty),
    saved: new Set(s.saved),
    terminated: s.terminated,
    aggregatesTouched: new Set(s.aggregatesTouched ?? []),
  };
}

/** After an if-step: continue with what holds on all non-terminated branches. */
function mergeState(target: StepState, a: StepState, b: StepState): void {
  const live = [a, b].filter((s) => !s.terminated);
  target.aggregatesTouched = new Set([...(a.aggregatesTouched ?? []), ...(b.aggregatesTouched ?? [])]);
  if (live.length === 0) {
    target.terminated = true;
    return;
  }
  const [first, ...rest] = live as [StepState, ...StepState[]];
  // Variables bound inside a branch are scoped to that branch.
  for (const s of live) {
    for (const [v, p] of s.dirty) if (target.locals.has(v)) target.dirty.set(v, p);
  }
  target.produced = new Set([...first.produced].filter((e) => rest.every((s) => s.produced.has(e))));
  target.saved = new Set([...first.saved].filter((e) => rest.every((s) => s.saved.has(e))));
}

function walk(e: TExpr, fn: (n: TExpr) => void): void {
  fn(e);
  switch (e.t) {
    case "field":
      if (e.owner) walk(e.owner, fn);
      break;
    case "guard":
      if (e.receiver) walk(e.receiver, fn);
      e.args.forEach((a) => walk(a, fn));
      break;
    case "builtin":
    case "extension":
      e.args.forEach((a) => walk(a, fn));
      break;
    case "not":
      walk(e.operand, fn);
      break;
    case "binary":
      walk(e.left, fn);
      walk(e.right, fn);
      break;
    case "isNull":
      walk(e.operand, fn);
      break;
  }
}

export { walk as walkExpr };

function unwrap(t: Type): Type {
  if (t.k === "optional") return unwrap(t.inner);
  if (t.k === "list") return unwrap(t.item);
  return t;
}

function findCycles(deps: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) {
        const cycle = stack.slice(stack.indexOf(d));
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      } else if (!state.get(d)) visit(d);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of deps.keys()) if (!state.get(n)) visit(n);
  return cycles;
}

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeModel(model: ModelIR, parsed?: Pick<ParseResult, "locate">): Analysis {
  const v = new Validator(model);
  v.run();
  const diagnostics = v.bag.items;
  if (parsed) {
    for (const d of diagnostics) {
      if (d.line === undefined) {
        const loc = parsed.locate(d.path);
        if (loc) Object.assign(d, loc);
      }
    }
  }
  return { model, contexts: v.contexts, diagnostics: sortDiagnostics(diagnostics) };
}

/** Parse + semantic validation. Same function is used by the CLI and the Web server. */
export function validateModelText(text: string): ValidateResult {
  const parsed = parseModel(text);
  if (!parsed.model || parsed.diagnostics.some((d) => d.severity === "error")) {
    return { model: parsed.model, diagnostics: sortDiagnostics(parsed.diagnostics), ok: false };
  }
  const analysis = analyzeModel(parsed.model, parsed);
  const diagnostics = sortDiagnostics([...parsed.diagnostics, ...analysis.diagnostics]);
  return { model: parsed.model, analysis, diagnostics, ok: !diagnostics.some((d) => d.severity === "error") };
}
