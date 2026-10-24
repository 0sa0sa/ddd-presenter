/**
 * YAML model → the multi-file format (`ddd migrate --split`, docs/10 §12). The output reads back into the same IR
 * (the round-trip tests check it for every sample model), keeps YAML comments (scenario and settings files keep
 * them in place, the other files carry them as plain comments), and ships the option definitions it uses.
 */
import { Document, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { Diagnostic, Path } from "../diagnostics.ts";
import type { AggregateIR, AuthorizeIR, ContextIR, EventEmissionIR, FieldIR, InvariantIR, ModelIR, ParameterIR, RateLimitIR, StepIR, UseCaseIR } from "../ir.ts";
import { parseModel } from "../parse.ts";
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_MIN_SIMILARITY, DEFAULT_PAGE_SIZE, RELEVANCE, type QueryIR } from "../queries.ts";
import { parseTypeExpr, typeToString, type Type } from "../types.ts";
import { analyzeModel, pascal, toSnake } from "../validate.ts";
import { MANIFEST_FILE } from "./assemble.ts";
import { OPTIONS_PROTO } from "./options-proto.ts";
import { enumPrefix, protoPackage, protoService, queryRpc, useCaseRpc } from "./proto-names.ts";

export interface SplitOutput {
  /** Relative path → content. Empty when the YAML could not be read. */
  files: Record<string, string>;
  diagnostics: Diagnostic[];
}

const json = (v: unknown) => JSON.stringify(v);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** Comment lines written above a YAML node (on the sequence item, the mapping key, or the first key of an item). */
function yamlComment(doc: Document, path: Path): string[] {
  if (!path.length) return [];
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  const last = path[path.length - 1];
  let c: string | undefined;
  if (isSeq(parent) && typeof last === "number") {
    const item = parent.items[last] as Node | undefined;
    c = item?.commentBefore ?? undefined;
    if (!c && isMap(item)) {
      const first = item.items[0];
      if (first && isNode(first.key)) c = first.key.commentBefore ?? undefined;
    }
  } else if (isMap(parent)) {
    const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
    if (pair && isNode(pair.key)) c = pair.key.commentBefore ?? undefined;
  }
  return c ? c.split("\n").map((l) => l.replace(/^ /, "")) : [];
}

class Writer {
  readonly lines: string[] = [];
  depth = 0;

  line(s = ""): void {
    this.lines.push(s ? "  ".repeat(this.depth) + s : "");
  }

  /** Comment block attached to the next declaration: its description. */
  doc(text: string | undefined): void {
    if (text === undefined) return;
    for (const l of text.split("\n")) this.line(l ? `// ${l}` : "//");
  }

  /** Comments carried over from the YAML, kept apart from the description by a blank line. */
  comments(lines: string[], attached = false): void {
    if (!lines.length) return;
    for (const l of lines) this.line(l ? `// ${l}` : "//");
    if (!attached) this.line();
  }

  open(s: string): void {
    this.line(s);
    this.depth++;
  }

  close(s = "}"): void {
    this.depth--;
    this.line(s);
  }

  blank(): void {
    const last = this.lines[this.lines.length - 1];
    if (last !== undefined && last !== "" && !last.endsWith("{")) this.lines.push("");
  }

  toString(): string {
    while (this.lines.length && this.lines[this.lines.length - 1] === "") this.lines.pop();
    return this.lines.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// .proto
// ---------------------------------------------------------------------------

interface ProtoScope {
  /** Entity name → owning aggregate (nested messages need `Aggregate.Entity` outside their aggregate). */
  entityOwner: Map<string, string>;
  /** The aggregate whose body is being written, if any. */
  inside?: string;
  usesTimestamp: { value: boolean };
}

/** A model type as a proto field: label, proto type and field options; undefined when only `type_expr` can carry it. */
function protoField(type: string, required: boolean, scope: ProtoScope, queryParam: boolean): { label: string; type: string; options: string[] } {
  const fallback = () => ({ label: (queryParam ? !required : !required) ? "optional " : "", type: "string", options: [`(ddd.v1.type_expr) = ${json(type)}`] });
  const t = parseTypeExpr(type);
  if (!t) return fallback();
  const scalar = (e: { name: string; args: { name: string; args: unknown[] }[] }): { type: string; options: string[] } | undefined => {
    if (e.name === "Ref" && e.args.length === 1 && !e.args[0]!.args.length) return { type: "string", options: [`(ddd.v1.ref) = ${json(e.args[0]!.name)}`] };
    if (e.args.length) return undefined;
    switch (e.name) {
      case "String":
        return { type: "string", options: [] };
      case "Integer":
        return { type: "int64", options: [] };
      case "Boolean":
        return { type: "bool", options: [] };
      case "UUID":
        return { type: "string", options: ["(ddd.v1.type) = UUID"] };
      case "Decimal":
        return { type: "string", options: ["(ddd.v1.type) = DECIMAL"] };
      case "Date":
        return { type: "string", options: ["(ddd.v1.type) = DATE"] };
      case "DateTime":
        scope.usesTimestamp.value = true;
        return { type: "google.protobuf.Timestamp", options: [] };
      default: {
        if (["List", "Optional", "Ref"].includes(e.name)) return undefined;
        const owner = scope.entityOwner.get(e.name);
        return { type: owner && owner !== scope.inside ? `${owner}.${e.name}` : e.name, options: [] };
      }
    }
  };
  if (t.name === "List" && t.args.length === 1) {
    const inner = scalar(t.args[0]!);
    if (!inner) return fallback();
    return { label: "repeated ", type: inner.type, options: [...inner.options, ...(required ? [] : ["(ddd.v1.optional_list) = true"])] };
  }
  const s = scalar(t);
  if (!s) return fallback();
  return { label: required ? "" : "optional ", ...s };
}

function rulesOption(f: FieldIR): string[] {
  const entries = Object.entries(f.constraints).filter(([, v]) => v !== undefined);
  if (!entries.length) return [];
  return [`(ddd.v1.rules) = { ${entries.map(([k, v]) => `${k}: ${typeof v === "string" ? json(v) : String(v)}`).join(" ")} }`];
}

function writeFields(w: Writer, fields: FieldIR[], scope: ProtoScope, doc: Document | undefined, queryParams = false, startAt = 1): number {
  let n = startAt;
  for (const f of fields) {
    if (doc) w.comments(yamlComment(doc, f.path));
    w.doc(f.description);
    const pf = protoField(f.type, f.required, scope, queryParams);
    const options = [...pf.options, ...rulesOption(f)];
    w.line(`${pf.label}${pf.type} ${f.name} = ${n++}${options.length ? ` [${options.join(", ")}]` : ""};`);
  }
  return n;
}

const UNIT = (u: string) => u.toUpperCase();
const KEY = (k: string) => k.toUpperCase();

function rateLimitText(r: RateLimitIR | "none"): string {
  return r === "none" ? "{ none: true }" : `{ requests: ${r.requests} per: ${UNIT(r.per)} by: ${KEY(r.by)} }`;
}

function authorizeText(a: AuthorizeIR): string {
  if (a.kind === "public") return "{ public: true }";
  if (a.kind === "internal") return "{ internal: true }";
  const parts: string[] = [];
  if (a.roles.length) parts.push(`roles: [${a.roles.map(json).join(", ")}]`);
  if (a.permissions !== undefined) parts.push(`permissions: [${a.permissions.map(json).join(", ")}]`);
  if (a.crossTenant) parts.push("cross_tenant: true");
  return parts.length ? `{ ${parts.join(" ")} }` : "{ authenticated: true }";
}

function uniqueName(base: string, taken: Set<string>): string {
  let n = base;
  while (taken.has(n)) n += "_";
  taken.add(n);
  return n;
}

function writeProto(model: ModelIR, ctx: ContextIR, ci: number, doc: Document, analysis: ReturnType<typeof analyzeModel> | undefined): string {
  const scope: ProtoScope = { entityOwner: new Map(), usesTimestamp: { value: false } };
  for (const a of ctx.aggregates) for (const e of a.entities) scope.entityOwner.set(e.name, a.name);
  const taken = new Set<string>([...ctx.errors.map((e) => e.name), ...ctx.enums.map((e) => e.name), ...ctx.valueObjects.map((v) => v.name), ...ctx.aggregates.map((a) => a.name)]);
  const cpath = ["contexts", ci];
  const w = new Writer();

  for (const e of ctx.errors) {
    w.comments(yamlComment(doc, e.path));
    w.doc(e.description);
    w.open(`message ${e.name} {`);
    w.line(`option (ddd.v1.error) = { code: ${json(e.code)} message: ${json(e.message)} };`);
    writeFields(w, e.details, scope, doc);
    w.close();
    w.blank();
  }
  for (const e of ctx.enums) {
    w.comments(yamlComment(doc, e.path));
    w.doc(e.description);
    w.open(`enum ${e.name} {`);
    const prefix = enumPrefix(e.name);
    const names = new Set<string>();
    const values = e.values.map((v) => {
      const name = prefix + toSnake(v).toUpperCase();
      // The value is read back as the lowercased name without the prefix; anything else is spelled out.
      const back = name.slice(prefix.length).toLowerCase();
      names.add(name);
      return { name, option: back === v ? "" : ` [(ddd.v1.value) = ${json(v)}]` };
    });
    let zero = `${prefix}UNSPECIFIED`;
    while (names.has(zero)) zero += "_";
    w.line(`${zero} = 0;`);
    values.forEach((v, i) => w.line(`${v.name} = ${i + 1}${v.option};`));
    w.close();
    w.blank();
  }
  for (const v of ctx.valueObjects) {
    w.comments(yamlComment(doc, v.path));
    w.doc(v.description);
    w.open(`message ${v.name} {`);
    const norm = Object.entries(v.normalize);
    w.line(
      norm.length
        ? `option (ddd.v1.value_object) = { ${norm.map(([f, steps]) => `normalize { field: ${json(f)} steps: [${steps.map((s) => s.toUpperCase()).join(", ")}] }`).join(" ")} };`
        : "option (ddd.v1.value_object) = {};",
    );
    writeFields(w, v.fields, scope, doc);
    w.close();
    w.blank();
  }
  for (const a of ctx.aggregates) {
    w.comments(yamlComment(doc, a.path));
    w.doc(a.description);
    w.open(`message ${a.name} {`);
    const parts = [`identity: ${json(a.identity)}`];
    if (a.tenancy) parts.push(`tenancy: TENANCY_${a.tenancy.toUpperCase()}`);
    if (a.authorize) parts.push(`authorize ${authorizeText(a.authorize)}`);
    if (a.rateLimit) parts.push(`rate_limit ${rateLimitText(a.rateLimit)}`);
    w.comments([...yamlComment(doc, [...a.path, "authorize"]), ...yamlComment(doc, [...a.path, "rate_limit"])], true);
    w.line(`option (ddd.v1.aggregate) = { ${parts.join(" ")} };`);
    writeFields(w, a.fields, { ...scope, inside: a.name }, doc);
    for (const e of a.entities) {
      w.blank();
      w.comments(yamlComment(doc, e.path));
      w.doc(e.description);
      w.open(`message ${e.name} {`);
      w.line(`option (ddd.v1.entity) = { identity: ${json(e.identity)} };`);
      writeFields(w, e.fields, { ...scope, inside: a.name }, doc);
      w.close();
    }
    w.close();
    w.blank();
  }

  // Service: one rpc per use case and query; their request / response messages follow.
  const ca = analysis?.contexts.get(ctx.name);
  const messages: string[][] = [];
  if (ctx.useCases.length || ctx.queries.length) {
    w.open(`service ${protoService(ctx)} {`);
    for (const u of ctx.useCases) {
      w.comments(yamlComment(doc, u.path));
      w.doc(u.description);
      const req = uniqueName(`${u.command}Request`, taken);
      const res = uniqueName(`${u.command}Response`, taken);
      w.open(`rpc ${useCaseRpc(u)}(${req}) returns (${res}) {`);
      const uc: string[] = [];
      if (toSnake(u.command) !== u.name) uc.push(`name: ${json(u.name)}`);
      if (u.actor !== undefined) uc.push(`actor: ${json(u.actor)}`);
      if (u.transaction === "none") uc.push("transaction: NONE");
      if (u.idempotencyKey !== undefined) uc.push(`idempotency_key: ${json(u.idempotencyKey)}`);
      if (u.retry) uc.push("retry: true");
      if (uc.length) w.line(`option (ddd.v1.use_case) = { ${uc.join(" ")} };`);
      if (u.authorize) {
        w.comments(yamlComment(doc, [...u.path, "authorize"]), true);
        w.line(`option (ddd.v1.authorize) = ${authorizeText(u.authorize)};`);
      }
      if (u.rateLimit) w.line(`option (ddd.v1.rate_limit) = ${rateLimitText(u.rateLimit)};`);
      w.close();
      const mw = new Writer();
      mw.open(`message ${req} {`);
      let first = 1;
      if (u.authorize?.crossTenant && model.security?.tenancy) {
        // Implicit input of a cross-tenant use case (not a model field): the tenant it acts in.
        mw.line("// The tenant the use case acts in (cross_tenant; not a field of the model).");
        mw.line(`string tenant_id = 1${model.security.tenancy.type === "UUID" ? " [(ddd.v1.type) = UUID]" : ""};`);
        first = 2;
      }
      writeFields(mw, u.input, scope, doc, false, first);
      mw.close();
      mw.blank();
      const ret = ca?.useCases.get(u.name)?.returnType;
      mw.open(`message ${res} {`);
      if (ret) writeResult(mw, ret, scope);
      mw.close();
      messages.push(mw.lines);
    }
    for (const q of ctx.queries) {
      w.comments(yamlComment(doc, q.path));
      w.doc(q.description);
      const base = queryRpc(q);
      const req = uniqueName(`${base}Request`, taken);
      const res = uniqueName(`${base}Response`, taken);
      w.open(`rpc ${base}(${req}) returns (${res}) {`);
      w.line("option idempotency_level = NO_SIDE_EFFECTS;");
      if (toSnake(base) !== q.name) w.line(`option (ddd.v1.query) = { name: ${json(q.name)} };`);
      if (q.authorize) {
        w.comments(yamlComment(doc, [...q.path, "authorize"]), true);
        w.line(`option (ddd.v1.authorize) = ${authorizeText(q.authorize)};`);
      }
      if (q.rateLimit) w.line(`option (ddd.v1.rate_limit) = ${rateLimitText(q.rateLimit)};`);
      w.close();
      const mw = new Writer();
      mw.open(`message ${req} {`);
      let n = writeFields(mw, q.params, scope, doc, true);
      if (q.search) {
        mw.line(`// Search text (search ${q.search.param} in the .flow).`);
        mw.line(`optional string ${q.search.param} = ${n++};`);
      }
      mw.line("// Page size (at most the page max of the query).");
      mw.line(`optional int64 limit = ${n++};`);
      mw.line("// Cursor of the next page (next_cursor of the previous response).");
      mw.line(`optional string cursor = ${n++};`);
      mw.close();
      mw.blank();
      const agg = ctx.aggregates.find((a) => a.name === q.from);
      mw.open(`message ${res} {`);
      mw.open("message Item {");
      const returned = agg ? (q.returns ? q.returns.flatMap((r) => agg.fields.filter((f) => f.name === r)) : agg.fields) : [];
      writeFields(mw, returned.map((f) => ({ ...f, description: undefined })), { ...scope, inside: undefined }, undefined);
      mw.close();
      mw.line("repeated Item items = 1;");
      mw.line("optional string next_cursor = 2;");
      mw.close();
      messages.push(mw.lines);
    }
    w.close();
    w.blank();
  }
  for (const m of messages) {
    for (const l of m) w.lines.push(l);
    w.blank();
  }

  const head = new Writer();
  head.line('syntax = "proto3";');
  head.blank();
  head.line(`package ${protoPackage(ctx)};`);
  head.blank();
  head.line('import "ddd/v1/options.proto";');
  if (scope.usesTimestamp.value) head.line('import "google/protobuf/timestamp.proto";');
  head.blank();
  head.comments(yamlComment(doc, cpath));
  const co = [`name: ${json(ctx.name)}`];
  if (ctx.description !== undefined) co.push(`description: ${json(ctx.description)}`);
  if (ctx.subdomain) co.push(`subdomain: ${ctx.subdomain.toUpperCase()}`);
  head.line(`option (ddd.v1.context) = { ${co.join(" ")} };`);
  head.blank();
  return head.toString() + "\n" + w.toString();
}

function writeResult(w: Writer, t: Type, scope: ProtoScope): void {
  const required = t.k !== "optional";
  const inner = t.k === "optional" ? t.inner : t;
  if (inner.k === "null" || inner.k === "duration" || inner.k === "event") return;
  const pf = protoField(typeToString(inner), required, scope, false);
  w.line(`${pf.label}${pf.type} result = 1${pf.options.length ? ` [${pf.options.join(", ")}]` : ""};`);
}

// ---------------------------------------------------------------------------
// .domain
// ---------------------------------------------------------------------------

const DEFAULT_CHECK = ["construct", "transition"];

function paramsText(ps: ParameterIR[]): string {
  return ps.map((p) => `${p.name}: ${p.type}${p.required ? "" : "?"}`).join(", ");
}

function writeInvariant(w: Writer, inv: InvariantIR, doc: Document): void {
  w.comments(yamlComment(doc, inv.path));
  w.doc(inv.description);
  const on = inv.checkOn.join(",") === DEFAULT_CHECK.join(",") ? "" : inv.checkOn.length ? ` on ${inv.checkOn.join(", ")}` : " on none";
  w.line(`invariant ${inv.name}: ${oneLine(inv.expression)} else ${inv.error}${on}`);
}

function mapText(entries: [string, string][], shorthand: boolean): string[] {
  const parts = entries.map(([k, v]) => (shorthand && oneLine(v) === k ? k : `${k}: ${oneLine(v)}`));
  return parts;
}

function writeMap(w: Writer, keyword: string, entries: [string, string][], suffix = ""): void {
  const parts = mapText(entries, true);
  const flat = `${keyword} { ${parts.join(", ")} }${suffix}`;
  if (flat.length <= 100 || parts.length <= 1) {
    w.line(entries.length ? flat : `${keyword} {}${suffix}`);
    return;
  }
  w.open(`${keyword} {`);
  for (const p of parts) w.line(p);
  w.close(`}${suffix}`);
}

function writeEmits(w: Writer, emits: EventEmissionIR[]): void {
  for (const e of emits) {
    const fields = e.fields.map((f) => (f.value === undefined ? f.name : `${f.name}: ${oneLine(f.value)}`));
    const when = e.when !== undefined ? ` when ${oneLine(e.when)}` : "";
    if (!fields.length) w.line(`emit ${e.name}${when}`);
    else {
      const flat = `emit ${e.name} { ${fields.join(", ")} }${when}`;
      if (flat.length <= 100 || fields.length <= 1) w.line(flat);
      else {
        w.open(`emit ${e.name} {`);
        for (const f of fields) w.line(f);
        w.close(`}${when}`);
      }
    }
  }
}

function writeDomain(ctx: ContextIR, doc: Document): string | undefined {
  const w = new Writer();
  let any = false;
  w.line(`context ${ctx.name}`);
  w.blank();
  if (ctx.glossary.length) {
    any = true;
    w.open("glossary {");
    for (const g of ctx.glossary) w.line(`${json(g.term)}: ${json(g.definition)}`);
    w.close();
    w.blank();
  }
  for (const x of ctx.extensionPoints) {
    any = true;
    w.comments(yamlComment(doc, x.path));
    w.doc(x.description);
    w.line(`extension ${x.name}(${paramsText(x.parameters)}) -> ${x.returns}${x.testDefault !== undefined ? ` default ${json(x.testDefault)}` : ""}`);
    w.blank();
  }
  for (const v of ctx.valueObjects) {
    if (!v.invariants.length) continue;
    any = true;
    w.open(`value ${v.name} {`);
    for (const inv of v.invariants) writeInvariant(w, inv, doc);
    w.close();
    w.blank();
  }
  for (const a of ctx.aggregates) {
    const allowIf = a.authorize?.allowIf;
    const hasEntityRules = a.entities.some((e) => e.invariants.length);
    if (!allowIf && !a.invariants.length && !a.stateGuards.length && !a.factories.length && !a.operations.length && !hasEntityRules) continue;
    any = true;
    w.open(`aggregate ${a.name} {`);
    if (allowIf !== undefined) {
      w.line(`authorize ${oneLine(allowIf)}`);
      w.blank();
    }
    for (const inv of a.invariants) writeInvariant(w, inv, doc);
    for (const e of a.entities) {
      if (!e.invariants.length) continue;
      w.blank();
      w.open(`entity ${e.name} {`);
      for (const inv of e.invariants) writeInvariant(w, inv, doc);
      w.close();
    }
    if (a.stateGuards.length) w.blank();
    for (const g of a.stateGuards) {
      w.comments(yamlComment(doc, g.path));
      w.doc(g.description);
      w.line(`guard ${g.name}${g.parameters.length ? `(${paramsText(g.parameters)})` : ""}: ${oneLine(g.expression)} else ${g.error}`);
    }
    const member = (kind: "factory" | "operation", m: AggregateIR["factories"][number] | AggregateIR["operations"][number], entries: [string, string][]) => {
      w.blank();
      w.comments(yamlComment(doc, m.path));
      w.doc(m.description);
      const req = m.require.length ? ` requires ${m.require.map(oneLine).join(", ")}` : "";
      w.open(`${kind} ${m.name}(${paramsText(m.parameters)})${req} {`);
      if (entries.length) writeMap(w, kind === "factory" ? "new" : "change", entries);
      writeEmits(w, m.emits);
      w.close();
    };
    for (const f of a.factories) member("factory", f, Object.entries(f.fields));
    for (const o of a.operations) member("operation", o, Object.entries(o.changes));
    w.close();
    w.blank();
  }
  return any ? w.toString() : undefined;
}

// ---------------------------------------------------------------------------
// .flow
// ---------------------------------------------------------------------------

function argsText(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${oneLine(v)}`)
    .join(", ");
}

function writeSteps(w: Writer, steps: StepIR[], doc: Document): void {
  for (const s of steps) {
    w.comments(yamlComment(doc, s.path.slice(0, -1)), true);
    switch (s.kind) {
      case "load":
        w.line(`let ${s.as} = load ${s.aggregate}(${oneLine(s.by)})${s.notFound ? ` else fail ${s.notFound}` : ""}`);
        break;
      case "create":
        w.line(`let ${s.as} = ${s.aggregate}.${s.factory}(${argsText(s.args)})`);
        break;
      case "invoke":
        w.line(`${s.target}.${s.operation}(${argsText(s.args)})`);
        break;
      case "save":
        w.line(`save ${s.target}`);
        break;
      case "publish":
        w.line(`publish ${s.event}${s.afterCommit ? " after commit" : ""}`);
        break;
      case "fail":
        w.line(`fail ${s.error}`);
        break;
      case "return":
        w.line(`return ${oneLine(s.value)}`);
        break;
      case "let":
        w.line(`let ${s.name} = ${oneLine(s.value)}`);
        break;
      case "if":
        writeIf(w, s, doc);
        break;
    }
  }
}

function writeIf(w: Writer, s: Extract<StepIR, { kind: "if" }>, doc: Document): void {
  const only = s.then[0];
  if (s.then.length === 1 && only?.kind === "fail" && !s.else.length) {
    w.line(`if ${oneLine(s.condition)} fail ${only.error}`);
    return;
  }
  w.open(`if ${oneLine(s.condition)} {`);
  let cur = s;
  for (;;) {
    writeSteps(w, cur.then, doc);
    const nested = cur.else[0];
    if (cur.else.length === 1 && nested?.kind === "if") {
      w.depth--;
      w.open(`} else if ${oneLine(nested.condition)} {`);
      cur = nested;
      continue;
    }
    if (cur.else.length) {
      w.depth--;
      w.open("} else {");
      writeSteps(w, cur.else, doc);
    }
    break;
  }
  w.close();
}

const OP_TEXT: Record<string, string> = { eq: "==", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function writeQuery(w: Writer, q: QueryIR, doc: Document): void {
  w.comments(yamlComment(doc, q.path), true);
  w.open(`query ${q.name}(${q.params.map((p) => p.name).join(", ")}) from ${q.from} {`);
  if (q.authorize?.allowIf !== undefined) w.line(`authorize ${oneLine(q.authorize.allowIf)}`);
  for (const f of q.where) {
    const operand = f.param !== undefined ? `:${f.param}` : f.principal !== undefined ? `principal.${f.principal}` : "value" in f ? json(f.value) : undefined;
    if (operand !== undefined) w.line(`where ${f.field} ${OP_TEXT[f.op]} ${operand}`);
  }
  if (q.search) {
    const sim = q.search.mode === "trigram" && q.search.minSimilarity !== DEFAULT_MIN_SIMILARITY ? ` >= ${q.search.minSimilarity}` : "";
    w.line(`search ${q.search.param} on ${q.search.fields.join(", ")} ${q.search.mode}${sim}`);
  }
  if (q.orderBy.length) {
    w.line(`order by ${q.orderBy.map((o) => (o.direction === (o.field === RELEVANCE ? "desc" : "asc") ? o.field : `${o.field} ${o.direction}`)).join(", ")}`);
  }
  if (q.page.size !== DEFAULT_PAGE_SIZE || q.page.maxSize !== Math.max(DEFAULT_MAX_PAGE_SIZE, q.page.size)) {
    w.line(`page ${q.page.size}${q.page.maxSize !== Math.max(DEFAULT_MAX_PAGE_SIZE, q.page.size) ? ` max ${q.page.maxSize}` : ""}`);
  }
  if (q.returns) w.line(`returns ${q.returns.join(", ")}`);
  w.close();
}

function writePolicy(w: Writer, p: ContextIR["policies"][number], doc: Document): void {
  w.comments(yamlComment(doc, p.path));
  w.doc(p.description);
  w.open(`policy ${p.name} on ${p.when} {`);
  const args = argsText(p.args);
  w.line(`run ${p.run}${args ? `(${args})` : ""}`);
  w.close();
}

/** One block of a context's .flow source: a use case (`flow`), a query or a policy. */
export interface FlowBlock {
  kind: "use_case" | "query" | "policy";
  name: string;
  /** The block as the .flow file writes it (comments and description included). */
  source: string;
  path: Path;
}

/** The .flow blocks of a context, in the order of the .flow file. */
export function contextFlowBlocks(ctx: ContextIR, doc: Document): FlowBlock[] {
  const block = (write: (w: Writer) => void) => {
    const w = new Writer();
    write(w);
    return w.toString();
  };
  return [
    ...ctx.useCases.map((u) => ({ kind: "use_case" as const, name: u.name, source: block((w) => writeUseCase(w, u, doc)), path: u.path })),
    ...ctx.queries.map((q) => ({ kind: "query" as const, name: q.name, source: block((w) => writeQuery(w, q, doc)), path: q.path })),
    ...ctx.policies.map((p) => ({ kind: "policy" as const, name: p.name, source: block((w) => writePolicy(w, p, doc)), path: p.path })),
  ];
}

function writeFlow(ctx: ContextIR, doc: Document): string | undefined {
  const blocks = contextFlowBlocks(ctx, doc);
  if (!blocks.length) return undefined;
  return flowFileText(ctx.name, blocks.map((b) => b.source));
}

/** A .flow file from its blocks. */
export function flowFileText(context: string, blocks: string[]): string {
  return [`context ${context}`, ...blocks.map((b) => b.replace(/\s+$/, ""))].join("\n\n") + "\n";
}

function writeUseCase(w: Writer, u: UseCaseIR, doc: Document): void {
  w.comments(yamlComment(doc, [...u.path, "steps"]), true);
  w.open(`flow ${u.name}(${u.input.map((f) => f.name).join(", ")}) {`);
  const allowIf = u.authorize?.allowIf;
  // The rule is checked once the aggregates it reads are loaded: write it after the leading loads.
  let lead = 0;
  while (lead < u.steps.length && u.steps[lead]!.kind === "load") lead++;
  if (allowIf === undefined) writeSteps(w, u.steps, doc);
  else {
    writeSteps(w, u.steps.slice(0, lead), doc);
    w.line(`authorize ${oneLine(allowIf)}`);
    writeSteps(w, u.steps.slice(lead), doc);
  }
  w.close();
}

// ---------------------------------------------------------------------------
// Settings and scenarios (YAML, comments kept)
// ---------------------------------------------------------------------------

function writeManifest(doc: Document, model: ModelIR): string {
  const out = new Document();
  out.commentBefore = doc.commentBefore;
  const root = out.createNode({}) as ReturnType<Document["createNode"]> & { items: unknown[] };
  const src = doc.contents;
  if (isMap(src)) {
    for (const pair of src.items) {
      if (isScalar(pair.key) && pair.key.value === "contexts") {
        const p = out.createPair("contexts", model.contexts.map((c) => c.name));
        if (isNode(pair.key) && pair.key.commentBefore) (p.key as Node).commentBefore = pair.key.commentBefore;
        (root.items as unknown[]).push(p);
      } else (root.items as unknown[]).push(pair.clone(out.schema));
    }
  }
  out.contents = root as never;
  return out.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function writeScenarios(doc: Document, ctx: ContextIR): string | undefined {
  const sections: [string, { name: string; path: Path; scenarios: unknown[] }[]][] = [
    ["aggregates", ctx.aggregates.map((a) => ({ name: a.name, path: [...a.path, "scenarios"], scenarios: a.scenarios }))],
    ["use_cases", ctx.useCases.map((u) => ({ name: u.name, path: [...u.path, "scenarios"], scenarios: u.scenarios }))],
    ["queries", ctx.queries.map((q) => ({ name: q.name, path: [...q.path, "scenarios"], scenarios: q.scenarios }))],
  ];
  if (!sections.some(([, owners]) => owners.some((o) => o.scenarios.length))) return undefined;
  const out = new Document({ context: ctx.name });
  for (const [section, owners] of sections) {
    for (const o of owners) {
      if (!o.scenarios.length) continue;
      const node = doc.getIn(o.path, true);
      out.setIn([section, o.name], isNode(node) ? node.clone() : node);
    }
  }
  const text = out.toString({ lineWidth: 0, flowCollectionPadding: false });
  // Anchors and aliases that cross owners do not survive the move; fall back to plain data then.
  const back = parseDocument(text);
  if (back.errors.length || JSON.stringify(back.toJS({ maxAliasCount: 50 })) !== JSON.stringify(dataOf(doc, sections))) {
    return new Document(dataOf(doc, sections)).toString({ lineWidth: 0, flowCollectionPadding: false });
  }
  return text;
}

function dataOf(doc: Document, sections: [string, { name: string; path: Path; scenarios: unknown[] }[]][]): Record<string, unknown> {
  const js = doc.toJS({ maxAliasCount: 50 }) as unknown;
  const at = (path: Path): unknown => path.reduce<unknown>((v, k) => (v as Record<string | number, unknown> | undefined)?.[k], js);
  const owner = sections.flatMap(([, owners]) => owners)[0];
  const out: Record<string, unknown> = { context: owner ? at([...owner.path.slice(0, 2), "name"]) : "" };
  for (const [section, owners] of sections) {
    for (const o of owners) {
      if (!o.scenarios.length) continue;
      ((out[section] ??= {}) as Record<string, unknown>)[o.name] = at(o.path);
    }
  }
  return out;
}

const BUF_YAML = `# buf (https://buf.build): \`buf build\` / \`buf lint\` / \`buf breaking\` read the model .proto files.
version: v2
lint:
  use:
    - STANDARD
  ignore:
    # The option definitions written by ddd (not part of the model).
    - ddd
breaking:
  use:
    - WIRE_JSON
`;

/**
 * The model's protobuf contract written from the IR: `<ctx>/v1/<ctx>.proto` per context, the option definitions
 * and buf.yaml (what `generated/proto/` holds; the same files `ddd migrate --split` writes, without YAML comments).
 */
export function protoFiles(model: ModelIR, analysis?: ReturnType<typeof analyzeModel>): Record<string, string> {
  const files: Record<string, string> = {};
  const doc = new Document({});
  model.contexts.forEach((ctx, ci) => {
    const base = toSnake(ctx.name);
    files[`${base}/v1/${base}.proto`] = writeProto(model, ctx, ci, doc, analysis);
  });
  files["ddd/v1/options.proto"] = OPTIONS_PROTO;
  files["buf.yaml"] = BUF_YAML;
  return files;
}

/** Converts a YAML model into the multi-file format. */
export function splitModelText(text: string): SplitOutput {
  const parsed = parseModel(text);
  if (!parsed.model || parsed.diagnostics.some((d) => d.severity === "error")) return { files: {}, diagnostics: parsed.diagnostics };
  const model = parsed.model;
  const doc = parseDocument(text);
  let analysis: ReturnType<typeof analyzeModel> | undefined;
  try {
    analysis = analyzeModel(model);
  } catch {
    analysis = undefined;
  }
  const files: Record<string, string> = {};
  files[MANIFEST_FILE] = writeManifest(doc, model);
  model.contexts.forEach((ctx, ci) => {
    const base = toSnake(ctx.name);
    // buf layout: the package cleaning_staff.v1 lives in cleaning_staff/v1/.
    files[`${base}/v1/${base}.proto`] = writeProto(model, ctx, ci, doc, analysis);
    const domain = writeDomain(ctx, doc);
    if (domain) files[`${base}.domain`] = domain;
    const flow = writeFlow(ctx, doc);
    if (flow) files[`${base}.flow`] = flow;
    const scenarios = writeScenarios(doc, ctx);
    if (scenarios) files[`${base}.scenarios.yaml`] = scenarios;
  });
  files["ddd/v1/options.proto"] = OPTIONS_PROTO;
  files["buf.yaml"] = BUF_YAML;
  return { files, diagnostics: parsed.diagnostics };
}

