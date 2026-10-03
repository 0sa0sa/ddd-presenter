import { LineCounter, parseDocument, isMap, isNode, isScalar, isSeq, visit, type Document, type Node } from "yaml";
import { DiagnosticBag, type Diagnostic, type Path } from "./diagnostics.ts";
import type {
  AggregateIR,
  AggregateScenarioIR,
  CheckTiming,
  Constraints,
  ContextIR,
  EntityIR,
  EnumIR,
  ErrorIR,
  EventEmissionIR,
  ExtensionPointIR,
  FactoryIR,
  FieldIR,
  InvariantIR,
  ModelIR,
  NormalizeStep,
  OperationIR,
  ParameterIR,
  PolicyIR,
  RelationshipIR,
  RelationshipPattern,
  ScenarioThenIR,
  StateGuardIR,
  StepIR,
  UseCaseIR,
  UseCaseScenarioIR,
  ValueObjectIR,
} from "./ir.ts";
import { RELATIONSHIP_PATTERNS, SCHEMA_VERSION, SUBDOMAIN_KINDS, type SubdomainKind } from "./ir.ts";

export interface ParseResult {
  model?: ModelIR;
  diagnostics: Diagnostic[];
  /** Resolves a YAML path to a 1-based line/column. */
  locate: (path: Path) => { line: number; column: number } | undefined;
  /** Character offsets [start, end) of the YAML node at `path` (value node), if it exists. */
  rangeOf: (path: Path) => [number, number] | undefined;
  /** Offsets [start, end) of the key scalar for a mapping entry at `path`, if it exists. */
  keyRangeOf: (path: Path) => [number, number] | undefined;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural reader: turns loosely-typed YAML data into IR, reporting shape errors with paths. */
class Reader {
  constructor(readonly bag: DiagnosticBag) {}

  obj(value: unknown, path: Path, what: string): Obj | undefined {
    if (isObj(value)) return value;
    this.bag.error("invalid-shape", `${what} must be a mapping`, path);
    return undefined;
  }

  keys(o: Obj, allowed: readonly string[], path: Path, what: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) {
        this.bag.error("unknown-key", `Unknown key "${k}" in ${what}`, [...path, k], {
          hint: `Allowed keys: ${allowed.join(", ")}`,
        });
      }
    }
  }

  str(o: Obj, key: string, path: Path, required: boolean): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) this.bag.error("missing-key", `Missing required key "${key}"`, path);
      return undefined;
    }
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    this.bag.error("invalid-shape", `"${key}" must be a string`, [...path, key]);
    return undefined;
  }

  bool(o: Obj, key: string, path: Path, fallback: boolean): boolean {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    this.bag.error("invalid-shape", `"${key}" must be true or false`, [...path, key]);
    return fallback;
  }

  list(o: Obj, key: string, path: Path): { value: unknown; path: Path }[] {
    const v = o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.bag.error("invalid-shape", `"${key}" must be a list`, [...path, key]);
      return [];
    }
    return v.map((value, i) => ({ value, path: [...path, key, i] }));
  }

  strList(o: Obj, key: string, path: Path): string[] {
    return this.list(o, key, path).flatMap(({ value, path: p }) => {
      if (typeof value === "string") return [value];
      if (typeof value === "number" || typeof value === "boolean") return [String(value)];
      this.bag.error("invalid-shape", `Items of "${key}" must be strings`, p);
      return [];
    });
  }

  /** `key: { name: expr }` mapping whose values are expressions (strings/scalars). */
  exprMap(o: Obj, key: string, path: Path): Record<string, string> {
    const v = o[key];
    if (v === undefined || v === null) return {};
    const m = this.obj(v, [...path, key], `"${key}"`);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(m)) {
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = String(val);
      else if (val === null) out[k] = "null";
      else this.bag.error("invalid-shape", `"${key}.${k}" must be an expression string`, [...path, key, k]);
    }
    return out;
  }

  dataMap(o: Obj, key: string, path: Path): Record<string, unknown> {
    const v = o[key];
    if (v === undefined || v === null) return {};
    return this.obj(v, [...path, key], `"${key}"`) ?? {};
  }
}

const CONSTRAINT_KEYS = [
  "min_length",
  "max_length",
  "pattern",
  "min",
  "max",
  "max_digits",
  "decimal_places",
  "min_items",
  "max_items",
] as const;

function readConstraints(r: Reader, o: Obj, path: Path): Constraints {
  const raw = o.constraints;
  if (raw === undefined || raw === null) return {};
  const c = r.obj(raw, [...path, "constraints"], "constraints");
  if (!c) return {};
  r.keys(c, CONSTRAINT_KEYS, [...path, "constraints"], "constraints");
  const out: Constraints = {};
  for (const k of CONSTRAINT_KEYS) {
    const v = c[k];
    if (v === undefined) continue;
    if (k === "pattern") {
      if (typeof v === "string") out.pattern = v;
      else r.bag.error("invalid-shape", "pattern must be a string", [...path, "constraints", k]);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else {
      r.bag.error("invalid-shape", `${k} must be a number`, [...path, "constraints", k]);
    }
  }
  return out;
}

function readField(r: Reader, value: unknown, path: Path): FieldIR | undefined {
  const o = r.obj(value, path, "field");
  if (!o) return undefined;
  r.keys(o, ["name", "type", "required", "description", "constraints"], path, "field");
  const name = r.str(o, "name", path, true);
  if (Array.isArray(o.type)) {
    r.bag.error("invalid-shape", "Type expressions with brackets must be quoted in YAML", [...path, "type"], {
      hint: 'Write type: "List[EmailAddress]" — inside { ... } an unquoted [ starts a YAML list',
    });
    return undefined;
  }
  const type = r.str(o, "type", path, true);
  if (!name || !type) return undefined;
  return {
    name,
    type,
    required: r.bool(o, "required", path, true),
    description: r.str(o, "description", path, false),
    constraints: readConstraints(r, o, path),
    path,
  };
}

function readFields(r: Reader, o: Obj, key: string, path: Path): FieldIR[] {
  return r.list(o, key, path).flatMap(({ value, path: p }) => readField(r, value, p) ?? []);
}

function readParameters(r: Reader, o: Obj, path: Path): ParameterIR[] {
  return r.list(o, "parameters", path).flatMap(({ value, path: p }) => {
    const po = r.obj(value, p, "parameter");
    if (!po) return [];
    r.keys(po, ["name", "type", "required", "description"], p, "parameter");
    const name = r.str(po, "name", p, true);
    const type = r.str(po, "type", p, true);
    if (!name || !type) return [];
    return [{ name, type, required: r.bool(po, "required", p, true), path: p }];
  });
}

function readInvariants(r: Reader, o: Obj, path: Path): InvariantIR[] {
  return r.list(o, "invariants", path).flatMap(({ value, path: p }) => {
    const io = r.obj(value, p, "invariant");
    if (!io) return [];
    r.keys(io, ["name", "description", "expression", "error", "check_on"], p, "invariant");
    const name = r.str(io, "name", p, true);
    const expression = r.str(io, "expression", p, true);
    const error = r.str(io, "error", p, true);
    if (!name || !expression || !error) return [];
    const checkOnRaw = io.check_on === undefined ? ["construct", "transition"] : r.strList(io, "check_on", p);
    const checkOn: CheckTiming[] = [];
    checkOnRaw.forEach((t, i) => {
      if (t === "construct" || t === "transition") {
        if (!checkOn.includes(t)) checkOn.push(t);
      } else {
        r.bag.error("invalid-value", `check_on must be "construct" or "transition", got "${t}"`, [...p, "check_on", i]);
      }
    });
    return [{ name, description: r.str(io, "description", p, false), expression, error, checkOn, path: p }];
  });
}

function readEmits(r: Reader, o: Obj, path: Path): EventEmissionIR[] {
  return r.list(o, "emits", path).flatMap(({ value, path: p }) => {
    const eo = r.obj(value, p, "event emission");
    if (!eo) return [];
    r.keys(eo, ["name", "fields", "when"], p, "event emission");
    const name = r.str(eo, "name", p, true);
    if (!name) return [];
    const fields = r.list(eo, "fields", p).flatMap(({ value: fv, path: fp }) => {
      if (typeof fv === "string") return [{ name: fv, path: fp }];
      const fo = r.obj(fv, fp, "event field");
      if (!fo) return [];
      r.keys(fo, ["name", "value"], fp, "event field");
      const fname = r.str(fo, "name", fp, true);
      if (!fname) return [];
      return [{ name: fname, value: r.str(fo, "value", fp, false), path: fp }];
    });
    return [{ name, fields, when: r.str(eo, "when", p, false), path: p }];
  });
}

function readRequire(r: Reader, o: Obj, path: Path): string[] {
  const v = o.require;
  if (typeof v === "string") return [v];
  return r.strList(o, "require", path);
}

function readEntity(r: Reader, o: Obj, path: Path, extraKeys: readonly string[]): EntityIR | undefined {
  r.keys(o, ["name", "description", "identity", "fields", "invariants", ...extraKeys], path, "entity");
  const name = r.str(o, "name", path, true);
  const identity = r.str(o, "identity", path, true);
  if (!name || !identity) return undefined;
  return {
    name,
    description: r.str(o, "description", path, false),
    identity,
    fields: readFields(r, o, "fields", path),
    invariants: readInvariants(r, o, path),
    path,
  };
}

function readThen(r: Reader, value: unknown, path: Path, useCase: boolean): ScenarioThenIR {
  const then: ScenarioThenIR = { hasReturns: false, path };
  const o = r.obj(value, path, "then");
  if (!o) return then;
  r.keys(o, useCase ? ["raises", "state", "emits", "returns"] : ["raises", "state", "emits"], path, "then");
  then.raises = r.str(o, "raises", path, false);
  if ("returns" in o) {
    then.hasReturns = true;
    then.returns = o.returns;
  }
  if (o.state !== undefined) {
    if (useCase) {
      then.state = r.list(o, "state", path).flatMap(({ value: sv, path: sp }) => {
        const so = r.obj(sv, sp, "expected state");
        if (!so) return [];
        r.keys(so, ["aggregate", "id", "fields"], sp, "expected state");
        const aggregate = r.str(so, "aggregate", sp, true);
        if (!aggregate) return [];
        if (so.id === undefined) r.bag.error("missing-key", 'Missing required key "id"', sp);
        return [{ aggregate, id: so.id, fields: r.dataMap(so, "fields", sp), path: sp }];
      });
    } else {
      then.state = r.dataMap(o, "state", path);
    }
  }
  if (o.emits !== undefined) {
    then.emits = r.list(o, "emits", path).flatMap(({ value: ev, path: ep }) => {
      if (typeof ev === "string") return [{ event: ev, fields: {}, path: ep }];
      const eo = r.obj(ev, ep, "expected event");
      if (!eo) return [];
      r.keys(eo, ["event", "fields"], ep, "expected event");
      const event = r.str(eo, "event", ep, true);
      if (!event) return [];
      return [{ event, fields: r.dataMap(eo, "fields", ep), path: ep }];
    });
  }
  return then;
}

function readAggregateScenario(r: Reader, value: unknown, path: Path): AggregateScenarioIR | undefined {
  const o = r.obj(value, path, "scenario");
  if (!o) return undefined;
  r.keys(o, ["name", "description", "given", "when", "then"], path, "scenario");
  const name = r.str(o, "name", path, true);
  if (!name) return undefined;
  let given: AggregateScenarioIR["given"];
  if (o.given !== undefined) {
    const go = r.obj(o.given, [...path, "given"], "given");
    if (go) {
      r.keys(go, ["aggregate"], [...path, "given"], "given");
      given = { aggregate: r.dataMap(go, "aggregate", [...path, "given"]), path: [...path, "given", "aggregate"] };
    }
  }
  const wpath = [...path, "when"];
  const wo = o.when === undefined ? undefined : r.obj(o.when, wpath, "when");
  if (!wo) {
    if (o.when === undefined) r.bag.error("missing-key", 'Missing required key "when"', path);
    return undefined;
  }
  r.keys(wo, ["construct", "operation", "factory", "args"], wpath, "when");
  let when: AggregateScenarioIR["when"] | undefined;
  if (wo.construct !== undefined) {
    when = { kind: "construct", fields: r.dataMap(wo, "construct", wpath), path: [...wpath, "construct"] };
  } else if (wo.operation !== undefined) {
    when = { kind: "operation", operation: r.str(wo, "operation", wpath, true) ?? "", args: r.dataMap(wo, "args", wpath), path: wpath };
  } else if (wo.factory !== undefined) {
    when = { kind: "factory", factory: r.str(wo, "factory", wpath, true) ?? "", args: r.dataMap(wo, "args", wpath), path: wpath };
  } else {
    r.bag.error("invalid-scenario", 'when must contain one of "construct", "operation" or "factory"', wpath);
    return undefined;
  }
  if (o.then === undefined) r.bag.error("missing-key", 'Missing required key "then"', path);
  return {
    name,
    description: r.str(o, "description", path, false),
    given,
    when,
    then: readThen(r, o.then ?? {}, [...path, "then"], false),
    path,
  };
}

function readAggregate(r: Reader, value: unknown, path: Path): AggregateIR | undefined {
  const o = r.obj(value, path, "aggregate");
  if (!o) return undefined;
  const base = readEntity(r, o, path, ["entities", "state_guards", "factories", "operations", "scenarios"]);
  if (!base) return undefined;
  const entities = r.list(o, "entities", path).flatMap(({ value: ev, path: ep }) => {
    const eo = r.obj(ev, ep, "entity");
    return eo ? readEntity(r, eo, ep, []) ?? [] : [];
  });
  const stateGuards: StateGuardIR[] = r.list(o, "state_guards", path).flatMap(({ value: gv, path: gp }) => {
    const go = r.obj(gv, gp, "state guard");
    if (!go) return [];
    r.keys(go, ["name", "description", "parameters", "expression", "error"], gp, "state guard");
    const name = r.str(go, "name", gp, true);
    const expression = r.str(go, "expression", gp, true);
    const error = r.str(go, "error", gp, true);
    if (!name || !expression || !error) return [];
    return [{ name, description: r.str(go, "description", gp, false), parameters: readParameters(r, go, gp), expression, error, path: gp }];
  });
  const factories: FactoryIR[] = r.list(o, "factories", path).flatMap(({ value: fv, path: fp }) => {
    const fo = r.obj(fv, fp, "factory");
    if (!fo) return [];
    r.keys(fo, ["name", "description", "parameters", "require", "fields", "emits"], fp, "factory");
    const name = r.str(fo, "name", fp, true);
    if (!name) return [];
    return [
      {
        name,
        description: r.str(fo, "description", fp, false),
        parameters: readParameters(r, fo, fp),
        require: readRequire(r, fo, fp),
        fields: r.exprMap(fo, "fields", fp),
        emits: readEmits(r, fo, fp),
        path: fp,
      },
    ];
  });
  const operations: OperationIR[] = r.list(o, "operations", path).flatMap(({ value: ov, path: op }) => {
    const oo = r.obj(ov, op, "operation");
    if (!oo) return [];
    r.keys(oo, ["name", "description", "parameters", "require", "changes", "emits"], op, "operation");
    const name = r.str(oo, "name", op, true);
    if (!name) return [];
    return [
      {
        name,
        description: r.str(oo, "description", op, false),
        parameters: readParameters(r, oo, op),
        require: readRequire(r, oo, op),
        changes: r.exprMap(oo, "changes", op),
        emits: readEmits(r, oo, op),
        path: op,
      },
    ];
  });
  const scenarios = r.list(o, "scenarios", path).flatMap(({ value: sv, path: sp }) => readAggregateScenario(r, sv, sp) ?? []);
  return { ...base, entities, stateGuards, factories, operations, scenarios };
}

function readSteps(r: Reader, items: { value: unknown; path: Path }[]): StepIR[] {
  const steps: StepIR[] = [];
  for (const { value, path } of items) {
    const o = r.obj(value, path, "step");
    if (!o) continue;
    const keys = Object.keys(o);
    if (keys.length !== 1) {
      r.bag.error("invalid-step", "A step must have exactly one key (load, create, invoke, save, publish, publish_after_commit, if, fail, return)", path);
      continue;
    }
    const kind = keys[0]!;
    const body = o[kind];
    const bpath = [...path, kind];
    switch (kind) {
      case "load": {
        const b = r.obj(body, bpath, "load step");
        if (!b) break;
        r.keys(b, ["aggregate", "by", "as", "not_found"], bpath, "load step");
        const aggregate = r.str(b, "aggregate", bpath, true);
        const by = r.str(b, "by", bpath, true);
        const as = r.str(b, "as", bpath, true);
        if (aggregate && by && as) steps.push({ kind: "load", aggregate, by, as, notFound: r.str(b, "not_found", bpath, false), path: bpath });
        break;
      }
      case "create": {
        const b = r.obj(body, bpath, "create step");
        if (!b) break;
        r.keys(b, ["aggregate", "factory", "as", "args"], bpath, "create step");
        const aggregate = r.str(b, "aggregate", bpath, true);
        const factory = r.str(b, "factory", bpath, true);
        const as = r.str(b, "as", bpath, true);
        if (aggregate && factory && as) steps.push({ kind: "create", aggregate, factory, as, args: r.exprMap(b, "args", bpath), path: bpath });
        break;
      }
      case "invoke": {
        const b = r.obj(body, bpath, "invoke step");
        if (!b) break;
        r.keys(b, ["target", "operation", "args"], bpath, "invoke step");
        const target = r.str(b, "target", bpath, true);
        const operation = r.str(b, "operation", bpath, true);
        if (target && operation) steps.push({ kind: "invoke", target, operation, args: r.exprMap(b, "args", bpath), path: bpath });
        break;
      }
      case "save":
      case "publish":
      case "publish_after_commit":
      case "fail": {
        if (typeof body !== "string") {
          r.bag.error("invalid-shape", `"${kind}" step takes a name`, bpath);
          break;
        }
        if (kind === "save") steps.push({ kind: "save", target: body, path: bpath });
        else if (kind === "fail") steps.push({ kind: "fail", error: body, path: bpath });
        else steps.push({ kind: "publish", event: body, afterCommit: kind === "publish_after_commit", path: bpath });
        break;
      }
      case "return": {
        if (body === undefined || (typeof body === "object" && body !== null)) {
          r.bag.error("invalid-shape", '"return" step takes an expression', bpath);
          break;
        }
        steps.push({ kind: "return", value: body === null ? "null" : String(body), path: bpath });
        break;
      }
      case "if": {
        const b = r.obj(body, bpath, "if step");
        if (!b) break;
        r.keys(b, ["condition", "then", "else"], bpath, "if step");
        const condition = r.str(b, "condition", bpath, true);
        if (!condition) break;
        steps.push({
          kind: "if",
          condition,
          then: readSteps(r, r.list(b, "then", bpath)),
          else: readSteps(r, r.list(b, "else", bpath)),
          path: bpath,
        });
        break;
      }
      default:
        r.bag.error("invalid-step", `Unknown step "${kind}"`, [...path, kind], {
          hint: "Use one of load, create, invoke, save, publish, publish_after_commit, if, fail, return",
        });
    }
  }
  return steps;
}

function readUseCaseScenario(r: Reader, value: unknown, path: Path): UseCaseScenarioIR | undefined {
  const o = r.obj(value, path, "scenario");
  if (!o) return undefined;
  r.keys(o, ["name", "description", "given", "when", "then"], path, "scenario");
  const name = r.str(o, "name", path, true);
  if (!name) return undefined;
  const gpath = [...path, "given"];
  const go = o.given === undefined ? {} : r.obj(o.given, gpath, "given") ?? {};
  r.keys(go, ["clock", "ids", "aggregates", "extensions"], gpath, "given");
  const aggregates = r.list(go, "aggregates", gpath).flatMap(({ value: av, path: ap }) => {
    const ao = r.obj(av, ap, "given aggregate");
    if (!ao) return [];
    r.keys(ao, ["type", "fields"], ap, "given aggregate");
    const type = r.str(ao, "type", ap, true);
    if (!type) return [];
    return [{ type, fields: r.dataMap(ao, "fields", ap), path: [...ap, "fields"] }];
  });
  const wpath = [...path, "when"];
  const wo = o.when === undefined ? undefined : r.obj(o.when, wpath, "when");
  if (!wo) {
    if (o.when === undefined) r.bag.error("missing-key", 'Missing required key "when"', path);
    return undefined;
  }
  r.keys(wo, ["input"], wpath, "when");
  if (o.then === undefined) r.bag.error("missing-key", 'Missing required key "then"', path);
  return {
    name,
    description: r.str(o, "description", path, false),
    given: {
      clock: r.str(go, "clock", gpath, false),
      ids: r.strList(go, "ids", gpath),
      aggregates,
      extensions: r.dataMap(go, "extensions", gpath),
      path: gpath,
    },
    when: { input: r.dataMap(wo, "input", wpath), path: [...wpath, "input"] },
    then: readThen(r, o.then ?? {}, [...path, "then"], true),
    path,
  };
}

function readUseCase(r: Reader, value: unknown, path: Path): UseCaseIR | undefined {
  const o = r.obj(value, path, "use case");
  if (!o) return undefined;
  r.keys(
    o,
    ["name", "description", "actor", "command", "input", "transaction", "idempotency_key", "retry", "steps", "scenarios"],
    path,
    "use case",
  );
  const name = r.str(o, "name", path, true);
  const command = r.str(o, "command", path, true);
  if (!name || !command) return undefined;
  const transaction = r.str(o, "transaction", path, false) ?? "required";
  if (transaction !== "required" && transaction !== "none") {
    r.bag.error("invalid-value", `transaction must be "required" or "none"`, [...path, "transaction"]);
  }
  return {
    name,
    description: r.str(o, "description", path, false),
    actor: r.str(o, "actor", path, false),
    command,
    input: readFields(r, o, "input", path),
    transaction: transaction === "none" ? "none" : "required",
    idempotencyKey: r.str(o, "idempotency_key", path, false),
    retry: r.bool(o, "retry", path, false),
    steps: readSteps(r, r.list(o, "steps", path)),
    scenarios: r.list(o, "scenarios", path).flatMap(({ value: sv, path: sp }) => readUseCaseScenario(r, sv, sp) ?? []),
    path,
  };
}

function readContext(r: Reader, value: unknown, path: Path): ContextIR | undefined {
  const o = r.obj(value, path, "context");
  if (!o) return undefined;
  r.keys(
    o,
    ["name", "description", "subdomain", "glossary", "errors", "enums", "value_objects", "aggregates", "extension_points", "use_cases", "policies"],
    path,
    "context",
  );
  const name = r.str(o, "name", path, true);
  if (!name) return undefined;
  const glossary = r.list(o, "glossary", path).flatMap(({ value: gv, path: gp }) => {
    const go = r.obj(gv, gp, "glossary entry");
    if (!go) return [];
    r.keys(go, ["term", "definition"], gp, "glossary entry");
    const term = r.str(go, "term", gp, true);
    const definition = r.str(go, "definition", gp, true);
    return term && definition ? [{ term, definition }] : [];
  });
  const errors: ErrorIR[] = r.list(o, "errors", path).flatMap(({ value: ev, path: ep }) => {
    const eo = r.obj(ev, ep, "error");
    if (!eo) return [];
    r.keys(eo, ["name", "code", "message", "description", "details"], ep, "error");
    const ename = r.str(eo, "name", ep, true);
    const code = r.str(eo, "code", ep, true);
    const message = r.str(eo, "message", ep, true);
    if (!ename || !code || !message) return [];
    return [{ name: ename, code, message, description: r.str(eo, "description", ep, false), details: readFields(r, eo, "details", ep), path: ep }];
  });
  const enums: EnumIR[] = r.list(o, "enums", path).flatMap(({ value: ev, path: ep }) => {
    const eo = r.obj(ev, ep, "enum");
    if (!eo) return [];
    r.keys(eo, ["name", "description", "values"], ep, "enum");
    const ename = r.str(eo, "name", ep, true);
    if (!ename) return [];
    return [{ name: ename, description: r.str(eo, "description", ep, false), values: r.strList(eo, "values", ep), path: ep }];
  });
  const valueObjects: ValueObjectIR[] = r.list(o, "value_objects", path).flatMap(({ value: vv, path: vp }) => {
    const vo = r.obj(vv, vp, "value object");
    if (!vo) return [];
    r.keys(vo, ["name", "description", "fields", "normalize", "invariants"], vp, "value object");
    const vname = r.str(vo, "name", vp, true);
    if (!vname) return [];
    const normalize: Record<string, NormalizeStep[]> = {};
    const nm = r.dataMap(vo, "normalize", vp);
    for (const [field, steps] of Object.entries(nm)) {
      const npath = [...vp, "normalize", field];
      const arr = typeof steps === "string" ? [steps] : Array.isArray(steps) ? steps : undefined;
      if (!arr) {
        r.bag.error("invalid-shape", "normalize steps must be a list", npath);
        continue;
      }
      normalize[field] = [];
      arr.forEach((s, i) => {
        if (s === "strip" || s === "lower" || s === "upper") normalize[field]!.push(s);
        else r.bag.error("invalid-value", `Unknown normalize step "${String(s)}"`, [...npath, i], { hint: "Use strip, lower or upper" });
      });
    }
    return [
      {
        name: vname,
        description: r.str(vo, "description", vp, false),
        fields: readFields(r, vo, "fields", vp),
        normalize,
        invariants: readInvariants(r, vo, vp),
        path: vp,
      },
    ];
  });
  const extensionPoints: ExtensionPointIR[] = r.list(o, "extension_points", path).flatMap(({ value: xv, path: xp }) => {
    const xo = r.obj(xv, xp, "extension point");
    if (!xo) return [];
    r.keys(xo, ["name", "description", "parameters", "returns", "test_default"], xp, "extension point");
    const xname = r.str(xo, "name", xp, true);
    const returns = r.str(xo, "returns", xp, true);
    if (!xname || !returns) return [];
    return [
      {
        name: xname,
        description: r.str(xo, "description", xp, false),
        parameters: readParameters(r, xo, xp),
        returns,
        testDefault: xo.test_default,
        path: xp,
      },
    ];
  });
  const subdomain = r.str(o, "subdomain", path, false);
  if (subdomain !== undefined && !(SUBDOMAIN_KINDS as readonly string[]).includes(subdomain)) {
    r.bag.error("invalid-value", `Unknown subdomain "${subdomain}"`, [...path, "subdomain"], { hint: `Use one of ${SUBDOMAIN_KINDS.join(", ")}` });
  }
  return {
    name,
    description: r.str(o, "description", path, false),
    ...(subdomain && (SUBDOMAIN_KINDS as readonly string[]).includes(subdomain) ? { subdomain: subdomain as SubdomainKind } : {}),
    glossary,
    errors,
    enums,
    valueObjects,
    aggregates: r.list(o, "aggregates", path).flatMap(({ value: av, path: ap }) => readAggregate(r, av, ap) ?? []),
    extensionPoints,
    useCases: r.list(o, "use_cases", path).flatMap(({ value: uv, path: up }) => readUseCase(r, uv, up) ?? []),
    policies: r.list(o, "policies", path).flatMap(({ value: pv, path: pp }) => readPolicy(r, pv, pp) ?? []),
    path,
  };
}

function readPolicy(r: Reader, value: unknown, path: Path): PolicyIR | undefined {
  const o = r.obj(value, path, "policy");
  if (!o) return undefined;
  r.keys(o, ["name", "description", "when", "run", "args"], path, "policy");
  const name = r.str(o, "name", path, true);
  const when = r.str(o, "when", path, true);
  const run = r.str(o, "run", path, true);
  if (!name || !when || !run) return undefined;
  return { name, description: r.str(o, "description", path, false), when, run, args: r.exprMap(o, "args", path), path };
}

function readRelationship(r: Reader, value: unknown, path: Path): RelationshipIR | undefined {
  const o = r.obj(value, path, "relationship");
  if (!o) return undefined;
  r.keys(o, ["upstream", "downstream", "pattern", "events", "description"], path, "relationship");
  const upstream = r.str(o, "upstream", path, true);
  const downstream = r.str(o, "downstream", path, true);
  const pattern = r.str(o, "pattern", path, false) ?? "customer_supplier";
  if (!(RELATIONSHIP_PATTERNS as readonly string[]).includes(pattern)) {
    r.bag.error("invalid-value", `Unknown relationship pattern "${pattern}"`, [...path, "pattern"], { hint: `Use one of ${RELATIONSHIP_PATTERNS.join(", ")}` });
  }
  if (!upstream || !downstream) return undefined;
  return {
    upstream,
    downstream,
    pattern: (RELATIONSHIP_PATTERNS as readonly string[]).includes(pattern) ? (pattern as RelationshipPattern) : "customer_supplier",
    events: r.strList(o, "events", path),
    description: r.str(o, "description", path, false),
    path,
  };
}

/** Path of the innermost map entry / list item whose range contains `offset` (best effort; [] when none). */
function pathAt(doc: Document, offset: number): Path {
  const out: Path = [];
  const inRange = (n: unknown) => isNode(n) && !!n.range && n.range[0] <= offset && offset <= n.range[2];
  let node: unknown = doc.contents;
  for (let guard = 0; guard < 100 && (isMap(node) || isSeq(node)); guard++) {
    let next: unknown;
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? pair.key.value : undefined;
        if (key === undefined || key === null) continue;
        if (inRange(pair.value) || inRange(pair.key)) {
          out.push(String(key));
          next = pair.value;
          break;
        }
      }
    } else {
      node.items.forEach((item, i) => {
        if (next === undefined && inRange(item)) {
          out.push(i);
          next = item;
        }
      });
    }
    if (next === undefined) break;
    node = next;
  }
  return out;
}

function makeRange(doc: Document) {
  return (path: Path): [number, number] | undefined => {
    const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
    if (isNode(node) && node.range) return [node.range[0], node.range[1]];
    return undefined;
  };
}

function makeKeyRange(doc: Document) {
  return (path: Path): [number, number] | undefined => {
    if (path.length === 0) return undefined;
    const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
    if (!isMap(parent)) return undefined;
    const key = path[path.length - 1];
    const pair = parent.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key));
    if (pair && isScalar(pair.key) && pair.key.range) return [pair.key.range[0], pair.key.range[1]];
    return undefined;
  };
}

function makeLocator(doc: Document, lc: LineCounter) {
  return (path: Path) => {
    // Walk up the path until a node with a range is found.
    for (let n = path.length; n >= 0; n--) {
      const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
      if (isNode(node) && node.range) {
        const pos = lc.linePos(node.range[0]);
        return { line: pos.line, column: pos.col };
      }
    }
    return undefined;
  };
}

/** Parses YAML model text into the canonical IR. Structural errors only; see `validateModel` for semantics. */
export function parseModel(text: string): ParseResult {
  const bag = new DiagnosticBag();
  const lc = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  } catch (e) {
    // The yaml library reports problems in doc.errors; anything thrown is still the input's fault, not ours.
    bag.error("yaml-syntax", `The YAML could not be read: ${(e as Error).message}`, [], { line: 1, column: 1 });
    const empty = parseDocument("");
    return { diagnostics: bag.items, locate: makeLocator(empty, lc), rangeOf: makeRange(empty), keyRangeOf: makeKeyRange(empty) };
  }
  const locate = makeLocator(doc, lc);
  const rangeOf = makeRange(doc);
  const keyRangeOf = makeKeyRange(doc);

  const reportedLines = new Set<number>();
  for (const err of doc.errors) {
    const pos = err.linePos?.[0] ?? lc.linePos(err.pos[0]);
    // Follow-up errors on the same line (the parser losing its place) add nothing.
    if (pos && reportedLines.has(pos.line)) continue;
    if (pos) reportedLines.add(pos.line);
    const path = pathAt(doc, err.pos[0]);
    const lineText = text.split("\n")[(pos?.line ?? 1) - 1] ?? "";
    if (/flow-seq-start/.test(err.message)) {
      // `{ name: tags, type: List[String] }`: inside { ... } an unquoted [ starts a YAML list.
      const at = (pos?.col ?? 1) - 1;
      const pair = [...lineText.matchAll(/([\w-]+):\s*([^,{}\s]*\[[^\]]*\][^,{}]*?)\s*(?=[,}]|$)/g)].find((m) => m.index! <= at && at <= m.index! + m[0].length);
      bag.error("yaml-syntax", 'Unquoted "[" inside { ... }: YAML reads it as the start of a list', path, {
        line: pos?.line,
        column: pos?.col,
        hint: pair ? `Write it quoted: ${pair[1]}: "${pair[2]}"` : 'Values containing [ ] must be quoted inside { ... }, e.g. type: "List[EmailAddress]"',
      });
      // The parser loses its place after this; whatever it reports next follows from the same mistake.
      break;
    }
    bag.error("yaml-syntax", err.message.split("\n")[0] ?? err.message, path, { line: pos?.line, column: pos?.col });
  }
  if (doc.errors.length > 0) return { diagnostics: bag.items, locate, rangeOf, keyRangeOf };

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (e) {
    // e.g. "Excessive alias count indicates a resource exhaustion attack" (a ReferenceError from the yaml library).
    const message = (e as Error).message;
    let alias: Node | undefined;
    visit(doc, { Alias: (_k, n) => ((alias = n), visit.BREAK) });
    const offset = (alias as Node | undefined)?.range?.[0];
    const pos = offset !== undefined ? lc.linePos(offset) : undefined;
    const aliases = /alias/i.test(message);
    bag.error(
      aliases ? "yaml-aliases" : "yaml-syntax",
      aliases ? "The YAML expands too many aliases (*name references to &name anchors)" : `The YAML could not be read: ${message}`,
      offset !== undefined ? pathAt(doc, offset) : [],
      {
        line: pos?.line ?? 1,
        column: pos?.col ?? 1,
        hint: aliases ? "Models do not need anchors and aliases; write the values out (at most 50 alias expansions are allowed)" : undefined,
      },
    );
    return { diagnostics: bag.items, locate, rangeOf, keyRangeOf };
  }
  const r = new Reader(bag);
  const root = r.obj(data, [], "model");
  let model: ModelIR | undefined;
  if (root) {
    r.keys(root, ["schema_version", "project", "description", "generation", "contexts", "relationships"], [], "model");
    const version = root.schema_version;
    if (version === undefined) {
      bag.error("missing-key", 'Missing required key "schema_version"', []);
    } else if (version !== SCHEMA_VERSION) {
      bag.error("unsupported-schema-version", `schema_version ${String(version)} is not supported by this version`, ["schema_version"], {
        hint: `This generator reads schema_version ${SCHEMA_VERSION}. Run "ddd migrate" to upgrade older models.`,
      });
    }
    const project = r.str(root, "project", [], true) ?? "";
    const gen = root.generation === undefined ? {} : r.obj(root.generation, ["generation"], "generation") ?? {};
    r.keys(gen, ["package", "src_dir", "tests_dir"], ["generation"], "generation");
    const defaultPackage = project.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "domain";
    model = {
      schemaVersion: typeof version === "number" ? version : SCHEMA_VERSION,
      project,
      description: r.str(root, "description", [], false),
      generation: {
        package: r.str(gen, "package", ["generation"], false) ?? defaultPackage,
        srcDir: r.str(gen, "src_dir", ["generation"], false) ?? "src",
        testsDir: r.str(gen, "tests_dir", ["generation"], false) ?? "tests",
      },
      contexts: r.list(root, "contexts", []).flatMap(({ value, path }) => readContext(r, value, path) ?? []),
      relationships: r.list(root, "relationships", []).flatMap(({ value, path }) => readRelationship(r, value, path) ?? []),
    };
  }

  for (const d of bag.items) {
    if (d.line === undefined) {
      const loc = locate(d.path);
      if (loc) Object.assign(d, loc);
    }
  }
  return { model, diagnostics: bag.items, locate, rangeOf, keyRangeOf };
}
