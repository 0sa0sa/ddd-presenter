/**
 * The multi-file model format (docs/10 §12): `ddd.yaml` (project settings), and per bounded context a `.proto`
 * (data shapes and contracts), a `.domain` (aggregate rules), a `.flow` (use-case steps, queries, policies) and a
 * `.scenarios.yaml` (scenario tests). They are assembled into the same data the YAML format reads, so the IR, the
 * validator and the generators are shared; a source map points every model path back at the file and line.
 */
import { isNode, LineCounter, parseDocument, stringify, type Document } from "yaml";
import { DiagnosticBag, sortDiagnostics, type Diagnostic, type Path } from "../diagnostics.ts";
import { readModelData, type ParseResult } from "../parse.ts";
import { analyzeModel, toSnake, type ValidateResult } from "../validate.ts";
import { parseDomain, parseFlow, type DomainFile, type Emit, type Entry, type FlowFile, type Invariant, type Param, type Stmt } from "./behavior.ts";
import { SplitSyntaxError, type Tok } from "./lexer.ts";
import { findOption, parseProto, tfToJs, type ProtoField, type ProtoFile, type ProtoMessage, type ProtoOption, type ProtoRpc, type TfValue } from "./proto.ts";

export const MANIFEST_FILE = "ddd.yaml";
export const SPLIT_EXTENSIONS = [".proto", ".domain", ".flow", ".scenarios.yaml"] as const;

export type SourceKind = "manifest" | "proto" | "domain" | "flow" | "scenarios";

/** Which part of the multi-file format a path is, if any. */
export function sourceKind(path: string): SourceKind | undefined {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (base === MANIFEST_FILE) return "manifest";
  if (base.endsWith(".scenarios.yaml")) return "scenarios";
  if (base.endsWith(".proto")) return "proto";
  if (base.endsWith(".domain")) return "domain";
  if (base.endsWith(".flow")) return "flow";
  return undefined;
}

/** A `.proto` belongs to the model only when it declares its context; any other (vendored, shared, buf deps) is not read. */
const CONTEXT_OPTION = /option\s*\(\s*\.?ddd\.v1\.context\s*\)/;

/** Whether a file is a model source: a manifest, scenarios, .domain, .flow, or a .proto with `option (ddd.v1.context)`. */
export function isModelSource(path: string, text: string): boolean {
  const kind = sourceKind(path);
  if (!kind) return false;
  return kind !== "proto" || CONTEXT_OPTION.test(text);
}

export interface Loc {
  file: string;
  line: number;
  column: number;
}

export interface SplitParseResult extends ParseResult {
  /** The assembled data (the shape of the YAML format), for tooling and tests. */
  data?: Record<string, unknown>;
  locate: (path: Path) => Loc | undefined;
}

type Obj = Record<string, unknown>;
const key = (p: Path) => JSON.stringify(p);

class SourceMap {
  private readonly entries = new Map<string, Loc>();
  private readonly mounts: { prefix: Path; locate: (rest: Path) => Loc | undefined }[] = [];

  set(path: Path, file: string, tok: { line: number; col: number } | undefined): void {
    if (tok) this.entries.set(key(path), { file, line: tok.line, column: tok.col });
  }

  mount(prefix: Path, locate: (rest: Path) => Loc | undefined): void {
    this.mounts.push({ prefix, locate });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  locate(path: Path): Loc | undefined {
    for (const m of this.mounts) {
      if (m.prefix.length <= path.length && m.prefix.every((p, i) => p === path[i])) {
        const l = m.locate(path.slice(m.prefix.length));
        if (l) return l;
      }
    }
    for (let n = path.length; n >= 0; n--) {
      const l = this.entries.get(key(path.slice(0, n)));
      if (l) return l;
    }
    return undefined;
  }
}

function yamlLocator(doc: Document, lc: LineCounter, file: string) {
  return (path: Path): Loc | undefined => {
    for (let n = path.length; n >= 0; n--) {
      const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
      if (isNode(node) && node.range) {
        const p = lc.linePos(node.range[0]);
        return { file, line: p.line, column: p.col };
      }
    }
    return undefined;
  };
}

const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const lower = (v: unknown, prefix = ""): unknown => {
  if (typeof v !== "string") return v;
  const s = v.toLowerCase();
  return prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
};

const INTEGER_TYPES = new Set(["int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64"]);
const TIMESTAMP = new Set(["google.protobuf.Timestamp", ".google.protobuf.Timestamp"]);
const TYPE_OPTION: Record<string, string> = { UUID: "UUID", DECIMAL: "Decimal", DATE: "Date" };

/** Option messages nested in others: `(ddd.v1.aggregate) = { authorize { ... } rate_limit { ... } }`, `normalize { ... }`. */
const NESTED_FIELDS: Record<string, Record<string, readonly string[]>> = {
  "ddd.v1.aggregate": { authorize: ["public", "internal", "authenticated", "roles", "permissions", "cross_tenant"], rate_limit: ["requests", "per", "by", "none"] },
  "ddd.v1.value_object": { normalize: ["field", "steps"] },
};

/** The `ddd.v1` options each kind of declaration may carry. */
export const DECLARATION_OPTIONS = {
  file: ["ddd.v1.context"],
  message: ["ddd.v1.error", "ddd.v1.value_object", "ddd.v1.aggregate", "ddd.v1.entity"],
  rpc: ["ddd.v1.use_case", "ddd.v1.query", "ddd.v1.authorize", "ddd.v1.rate_limit"],
  enumValue: ["ddd.v1.value"],
} as const;

/** Allowed fields of each `ddd.v1` option message (unknown ones are reported, as YAML reports unknown keys). */
const OPTION_FIELDS: Record<string, readonly string[]> = {
  "ddd.v1.context": ["name", "description", "subdomain"],
  "ddd.v1.error": ["code", "message"],
  "ddd.v1.value_object": ["normalize"],
  "ddd.v1.aggregate": ["identity", "tenancy", "authorize", "rate_limit"],
  "ddd.v1.entity": ["identity"],
  "ddd.v1.use_case": ["name", "actor", "transaction", "idempotency_key", "retry"],
  "ddd.v1.query": ["name"],
  "ddd.v1.authorize": ["public", "internal", "authenticated", "roles", "permissions", "cross_tenant"],
  "ddd.v1.rate_limit": ["requests", "per", "by", "none"],
};

/** Cross-file checks that a syntax error elsewhere makes meaningless (the declaration may be in the unreadable file). */
const CROSS_FILE = new Set(["missing-flow", "missing-rpc", "unknown-scenario-owner", "unknown-aggregate", "unknown-value-object", "unknown-entity", "missing-proto", "unlisted-context"]);

class Assembler {
  readonly bag = new DiagnosticBag();
  readonly map = new SourceMap();
  private unreadable = false;

  constructor(readonly files: Record<string, string>) {}

  error(code: string, message: string, file: string, tok: { line: number; col: number } | undefined, hint?: string): void {
    if (code === "syntax" || code === "yaml-syntax") this.unreadable = true;
    else if (this.unreadable && CROSS_FILE.has(code)) return;
    this.bag.error(code, message, [], { file, ...(tok ? { line: tok.line, column: tok.col } : {}), ...(hint ? { hint } : {}) });
  }

  syntax(file: string, e: unknown): void {
    if (e instanceof SplitSyntaxError) this.error("syntax", e.message, file, e.tok, e.hint);
    else throw e;
  }

  /** A `ddd.v1` option value as plain data, reporting fields the option does not have. */
  option(options: ProtoOption[], name: string, file: string): Obj | undefined {
    const o = findOption(options, name);
    if (!o) return undefined;
    if (o.value.k !== "msg") {
      this.error("invalid-option", `(${name}) takes a message value: { field: value ... }`, file, o.tok);
      return undefined;
    }
    const allowed = OPTION_FIELDS[name];
    if (allowed) {
      for (const f of o.value.fields) {
        if (!allowed.includes(f.name)) this.error("unknown-key", `Unknown field "${f.name}" in (${name})`, file, f.tok, `Allowed fields: ${allowed.join(", ")}`);
        const nested = NESTED_FIELDS[name]?.[f.name];
        if (!nested) continue;
        const values = f.value.k === "list" ? f.value.items : [f.value];
        for (const v of values) {
          if (v.k !== "msg") {
            this.error("invalid-option", `${f.name} in (${name}) takes a message value: ${f.name} { ... }`, file, f.tok);
            continue;
          }
          for (const g of v.fields) {
            if (!nested.includes(g.name)) this.error("unknown-key", `Unknown field "${g.name}" in ${f.name} of (${name})`, file, g.tok, `Allowed fields: ${nested.join(", ")}`);
          }
        }
      }
    }
    return tfToJs(o.value) as Obj;
  }

  /** Reports `ddd.v1` options a declaration cannot carry (a misspelt option would otherwise just be ignored). */
  knownOptions(options: ProtoOption[], allowed: readonly string[], what: string, file: string): void {
    for (const o of options) {
      if (o.name.replace(/^\./, "").startsWith("ddd.") && !allowed.includes(o.name.replace(/^\./, ""))) {
        this.error("unknown-option", `(${o.name}) is not an option of ${what}`, file, o.tok, `Options of ${what}: ${allowed.map((x) => `(${x})`).join(", ")}`);
      }
    }
  }

  optionTok(options: ProtoOption[], name: string): Tok | undefined {
    return findOption(options, name)?.tok;
  }

  /** Field of a message → the YAML field shape. Query parameters are optional unless declared without `optional`. */
  field(f: ProtoField, file: string, path: Path, queryParam = false): Obj | undefined {
    const opt = (n: string) => findOption(f.options, n);
    const typeExpr = opt("ddd.v1.type_expr");
    const typeOpt = opt("ddd.v1.type");
    const ref = opt("ddd.v1.ref");
    const optionalList = opt("ddd.v1.optional_list");
    const rules = opt("ddd.v1.rules");
    for (const o of f.options) {
      if (!["ddd.v1.type_expr", "ddd.v1.type", "ddd.v1.ref", "ddd.v1.optional_list", "ddd.v1.rules"].includes(o.name) && o.name.startsWith("ddd.")) {
        this.error("unknown-option", `Unknown field option (${o.name})`, file, o.tok, "Field options: (ddd.v1.type), (ddd.v1.ref), (ddd.v1.rules), (ddd.v1.type_expr), (ddd.v1.optional_list)");
      }
    }
    let type: string | undefined;
    if (typeExpr) {
      if (typeExpr.value.k !== "str") this.error("invalid-option", "(ddd.v1.type_expr) takes a string", file, typeExpr.tok);
      else type = typeExpr.value.v;
    } else if (f.type === "string") {
      if (ref) type = ref.value.k === "str" ? `Ref[${ref.value.v}]` : undefined;
      else if (typeOpt) {
        const t = typeOpt.value.k === "id" ? TYPE_OPTION[typeOpt.value.v] : undefined;
        if (!t) this.error("invalid-option", "(ddd.v1.type) is UUID, DECIMAL or DATE", file, typeOpt.tok);
        type = t;
      } else type = "String";
    } else if (INTEGER_TYPES.has(f.type)) type = "Integer";
    else if (f.type === "bool") type = "Boolean";
    else if (TIMESTAMP.has(f.type)) type = "DateTime";
    else if (f.type === "double" || f.type === "float" || f.type === "bytes") {
      this.error("unsupported-type", `${f.type} has no model type`, file, f.typeTok, "Use string with [(ddd.v1.type) = DECIMAL] for exact numbers, int64 for whole numbers");
      return undefined;
    } else type = f.type.split(".").pop()!;
    if ((ref || typeOpt) && f.type !== "string" && !typeExpr) this.error("invalid-option", `(ddd.v1.${ref ? "ref" : "type"}) applies to string fields`, file, (ref ?? typeOpt)!.tok);
    if (!type) return undefined;
    if (f.label === "repeated" && !typeExpr) type = `List[${type}]`;
    const out: Obj = { name: f.name, type };
    const optional = f.label === "optional" || (f.label === "repeated" && optionalList?.value.k === "id" && optionalList.value.v === "true");
    if (queryParam) {
      if (!optional) out.required = true;
    } else if (optional) out.required = false;
    if (f.doc !== undefined) out.description = f.doc;
    if (rules) {
      if (rules.value.k !== "msg") this.error("invalid-option", "(ddd.v1.rules) takes a message value: { min_length: 1 ... }", file, rules.tok);
      else {
        out.constraints = tfToJs(rules.value);
        for (const r of rules.value.fields) this.map.set([...path, "constraints", r.name], file, r.tok);
      }
    }
    this.map.set(path, file, f.tok);
    this.map.set([...path, "type"], file, f.typeTok);
    return out;
  }

  fields(m: ProtoMessage, file: string, path: Path, skip: ReadonlySet<string> = new Set(), queryParams = false): Obj[] {
    const seen = new Map<number, string>();
    const out: Obj[] = [];
    for (const f of m.fields) {
      const prev = seen.get(f.number);
      if (prev) this.error("duplicate-field-number", `Field number ${f.number} of ${m.name} is used by both ${prev} and ${f.name}`, file, f.tok);
      seen.set(f.number, f.name);
      if (skip.has(f.name)) continue;
      const d = this.field(f, file, [...path, out.length], queryParams);
      if (d) out.push(d);
    }
    return out;
  }

  params(ps: Param[], file: string, path: Path): Obj[] {
    return ps.map((p, i) => {
      this.map.set([...path, i], file, p.tok);
      return { name: p.name, type: p.type, ...(p.required ? {} : { required: false }) };
    });
  }

  invariants(list: Invariant[], file: string, path: Path): Obj[] {
    return list.map((v, i) => {
      const p = [...path, i];
      this.map.set(p, file, v.tok);
      this.map.set([...p, "expression"], file, v.expr.tok);
      this.map.set([...p, "error"], file, v.errorTok);
      return { name: v.name, ...(v.doc !== undefined ? { description: v.doc } : {}), expression: v.expr.text, error: v.error, ...(v.checkOn ? { check_on: v.checkOn } : {}) };
    });
  }

  entryMap(list: Entry[], file: string, path: Path): Obj {
    const out: Obj = {};
    for (const e of list) {
      out[e.key] = e.value.text;
      this.map.set([...path, e.key], file, e.value.tok);
    }
    return out;
  }

  emits(list: Emit[], file: string, path: Path): Obj[] {
    return list.map((e, i) => {
      const p = [...path, i];
      this.map.set(p, file, e.tok);
      const fields = e.fields.map((f, j) => {
        this.map.set([...p, "fields", j], file, f.tok);
        return f.value ? { name: f.name, value: f.value.text } : f.name;
      });
      if (e.when) this.map.set([...p, "when"], file, e.when.tok);
      return { name: e.name, ...(fields.length ? { fields } : {}), ...(e.when ? { when: e.when.text } : {}) };
    });
  }

  authorize(opt: Obj | undefined, optTok: Tok | undefined, allowIf: { text: string; tok: Tok } | undefined, file: string, flowFile: string | undefined, path: Path): unknown {
    if (!opt && !allowIf) return undefined;
    this.map.set(path, allowIf && !opt ? flowFile ?? file : file, allowIf && !opt ? allowIf.tok : optTok);
    const o = opt ?? {};
    const flags = (["public", "internal"] as const).filter((k) => o[k] === true);
    if (flags.length) {
      if (allowIf) this.error("invalid-authorize", `authorize ${flags[0]} does not take a rule; remove the authorize statement or the ${flags[0]} flag`, flowFile ?? file, allowIf.tok);
      if (flags.length > 1 || o.roles !== undefined || o.permissions !== undefined) this.error("invalid-authorize", `(ddd.v1.authorize) ${flags[0]} stands alone`, file, optTok);
      return flags[0];
    }
    const out: Obj = {};
    if (o.roles !== undefined) out.roles = asList(o.roles);
    if (o.permissions !== undefined) out.permissions = asList(o.permissions);
    if (o.cross_tenant === true) out.cross_tenant = true;
    if (allowIf) {
      out.allow_if = allowIf.text;
      this.map.set([...path, "allow_if"], flowFile ?? file, allowIf.tok);
    }
    return Object.keys(out).length ? out : "authenticated";
  }

  rateLimit(opt: Obj | undefined): unknown {
    if (!opt) return undefined;
    if (opt.none === true) return "none";
    return { requests: opt.requests, per: lower(opt.per), by: lower(opt.by) };
  }

  steps(list: Stmt[], aggregates: ReadonlySet<string>, file: string, path: Path, top: { allowIf?: { text: string; tok: Tok } } | undefined): Obj[] {
    const out: Obj[] = [];
    for (const s of list) {
      if (s.kind === "authorize") {
        if (!top) this.error("invalid-authorize", "authorize belongs at the top level of a flow (it is checked once, not per branch)", file, s.tok);
        else if (top.allowIf) this.error("invalid-authorize", "A flow has at most one authorize rule; combine them with and / or", file, s.tok);
        else top.allowIf = { text: s.expr.text, tok: s.expr.tok };
        continue;
      }
      const p = [...path, out.length];
      this.map.set(p, file, s.tok);
      switch (s.kind) {
        case "load":
          this.map.set([...p, "load", "by"], file, s.by.tok);
          out.push({ load: { aggregate: s.aggregate, by: s.by.text, as: s.as, ...(s.notFound ? { not_found: s.notFound } : {}) } });
          break;
        case "call":
          if (aggregates.has(s.target)) out.push({ create: { aggregate: s.target, factory: s.member, as: s.as, args: this.entryMap(s.args, file, [...p, "create", "args"]) } });
          else {
            this.map.set([...p, "let", "value"], file, s.raw.tok);
            out.push({ let: { name: s.as, value: s.raw.text } });
          }
          break;
        case "let":
          this.map.set([...p, "let", "value"], file, s.value.tok);
          out.push({ let: { name: s.name, value: s.value.text } });
          break;
        case "invoke":
          out.push({ invoke: { target: s.target, operation: s.operation, ...(s.args.length ? { args: this.entryMap(s.args, file, [...p, "invoke", "args"]) } : {}) } });
          break;
        case "save":
          out.push({ save: s.target });
          break;
        case "publish":
          out.push(s.afterCommit ? { publish_after_commit: s.event } : { publish: s.event });
          break;
        case "fail":
          out.push({ fail: s.error });
          break;
        case "return":
          this.map.set([...p, "return"], file, s.value.tok);
          out.push({ return: s.value.text });
          break;
        case "if": {
          this.map.set([...p, "if", "condition"], file, s.condition.tok);
          const then = this.steps(s.then, aggregates, file, [...p, "if", "then"], undefined);
          const els = this.steps(s.else, aggregates, file, [...p, "if", "else"], undefined);
          out.push({ if: { condition: s.condition.text, then, ...(els.length ? { else: els } : {}) } });
          break;
        }
      }
    }
    return out;
  }
}

interface ContextSources {
  proto?: { file: string; ast: ProtoFile };
  domains: { file: string; ast: DomainFile }[];
  flows: { file: string; ast: FlowFile }[];
  scenarios: { file: string; doc: Document; lc: LineCounter; data: Obj }[];
}

/** Assembles the multi-file sources (relative path → text) into the model data and parses it into IR. */
export function parseModelFiles(files: Record<string, string>): SplitParseResult {
  const a = new Assembler(files);
  const done = (data?: Record<string, unknown>): SplitParseResult => {
    const model = data ? readModelData(data, a.bag) : undefined;
    for (const d of a.bag.items) {
      if (d.line === undefined) {
        const loc = a.map.locate(d.path);
        if (loc) Object.assign(d, loc);
      }
    }
    return { model, data, diagnostics: a.bag.items, locate: (p) => a.map.locate(p), rangeOf: () => undefined, keyRangeOf: () => undefined };
  };

  const paths = Object.keys(files).sort();
  const manifests = paths.filter((p) => sourceKind(p) === "manifest");
  if (manifests.length !== 1) {
    a.error("missing-manifest", manifests.length ? `Several ${MANIFEST_FILE} files: ${manifests.join(", ")}` : `No ${MANIFEST_FILE}: the project settings and the list of contexts live there`, manifests[1] ?? MANIFEST_FILE, undefined);
    return done();
  }
  const manifestFile = manifests[0]!;
  const lc = new LineCounter();
  const mdoc = parseDocument(files[manifestFile]!, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  for (const err of mdoc.errors) {
    const p = err.linePos?.[0] ?? lc.linePos(err.pos[0]);
    a.bag.error("yaml-syntax", err.message.split("\n")[0] ?? err.message, [], { file: manifestFile, line: p?.line, column: p?.col });
  }
  if (mdoc.errors.length) return done();
  const manifest = mdoc.toJS({ maxAliasCount: 50 }) as unknown;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    a.error("invalid-shape", `${MANIFEST_FILE} must be a mapping`, manifestFile, { line: 1, col: 1 });
    return done();
  }
  const locateManifest = yamlLocator(mdoc, lc, manifestFile);
  a.map.mount([], (rest) => (rest[0] === "contexts" && rest.length > 1 ? undefined : locateManifest(rest)));

  const contextNames: string[] = [];
  const declared = (manifest as Obj).contexts;
  if (declared !== undefined && !Array.isArray(declared)) {
    a.error("invalid-shape", "contexts in ddd.yaml lists the context names in order: contexts: [Ordering, Billing]", manifestFile, locateManifest(["contexts"]) && { line: locateManifest(["contexts"])!.line, col: locateManifest(["contexts"])!.column });
  }
  for (const [i, c] of asList(declared).entries()) {
    const loc = locateManifest(["contexts", i]);
    if (typeof c !== "string") a.error("invalid-shape", "Each entry of contexts is a context name", manifestFile, loc && { line: loc.line, col: loc.column });
    else if (contextNames.includes(c)) a.error("duplicate-name", `Context ${c} is listed twice`, manifestFile, loc && { line: loc.line, col: loc.column });
    else contextNames.push(c);
  }

  // Parse every source and group it by context.
  const byContext = new Map<string, ContextSources>();
  const sources = (name: string) => byContext.get(name) ?? byContext.set(name, { domains: [], flows: [], scenarios: [] }).get(name)!;
  const where = new Map<string, { file: string; tok: { line: number; col: number } }>();
  for (const file of paths) {
    const kind = sourceKind(file);
    const text = files[file]!;
    try {
      if (kind === "proto") {
        if (!isModelSource(file, text)) continue; // not part of the model (another service's or a dependency's proto)
        const ast = parseProto(text);
        const ctx = findOption(ast.options, "ddd.v1.context");
        if (!ctx) continue; // not a model file (e.g. ddd/v1/options.proto, shared protos)
        const name = ctx.value.k === "msg" ? ctx.value.fields.find((f) => f.name === "name") : undefined;
        if (!name || name.value.k !== "str") {
          a.error("missing-key", "(ddd.v1.context) needs the context name: { name: \"Ordering\" }", file, ctx.tok);
          continue;
        }
        const s = sources(name.value.v);
        if (s.proto) a.error("duplicate-context", `Context ${name.value.v} has two .proto files (${s.proto.file} and ${file})`, file, ctx.tok, "Keep one .proto per context");
        else s.proto = { file, ast };
        where.set(name.value.v, { file, tok: ctx.tok });
      } else if (kind === "domain") {
        const ast = parseDomain(text);
        sources(ast.context).domains.push({ file, ast });
        if (!where.has(ast.context)) where.set(ast.context, { file, tok: ast.contextTok });
      } else if (kind === "flow") {
        const ast = parseFlow(text);
        sources(ast.context).flows.push({ file, ast });
        if (!where.has(ast.context)) where.set(ast.context, { file, tok: ast.contextTok });
      } else if (kind === "scenarios") {
        const slc = new LineCounter();
        const doc = parseDocument(text, { lineCounter: slc, uniqueKeys: true, prettyErrors: false });
        for (const err of doc.errors) {
          const p = err.linePos?.[0] ?? slc.linePos(err.pos[0]);
          a.error("yaml-syntax", err.message.split("\n")[0] ?? err.message, file, p && { line: p.line, col: p.col });
        }
        if (doc.errors.length) continue;
        const data = doc.toJS({ maxAliasCount: 50 }) as unknown;
        if (data === null || data === undefined) continue;
        if (typeof data !== "object" || Array.isArray(data) || typeof (data as Obj).context !== "string") {
          a.error("invalid-shape", "A scenarios file starts with context: <Name>, then aggregates: / use_cases: / queries: keyed by name", file, { line: 1, col: 1 });
          continue;
        }
        const o = data as Obj;
        for (const k of Object.keys(o)) {
          if (!["context", "aggregates", "use_cases", "queries"].includes(k)) {
            const l = yamlLocator(doc, slc, file)([k]);
            a.error("unknown-key", `Unknown key "${k}" in a scenarios file`, file, l && { line: l.line, col: l.column }, "Allowed keys: context, aggregates, use_cases, queries");
          }
        }
        sources(o.context as string).scenarios.push({ file, doc, lc: slc, data: o });
      }
    } catch (e) {
      a.syntax(file, e);
    }
  }
  for (const [name, w] of where) {
    if (!contextNames.includes(name)) a.error("unlisted-context", `Context ${name} is not listed in ${MANIFEST_FILE}`, w.file, w.tok, `Add it to contexts: in ${MANIFEST_FILE}`);
  }

  const contexts: Obj[] = [];
  for (const [ci, name] of contextNames.entries()) {
    const src = byContext.get(name);
    const cpath: Path = ["contexts", ci];
    if (!src?.proto) {
      const loc = locateManifest(["contexts", ci]);
      a.error("missing-proto", `Context ${name} has no .proto file`, manifestFile, loc && { line: loc.line, col: loc.column }, `Create one with option (ddd.v1.context) = { name: "${name}" };`);
      contexts.push({ name });
      continue;
    }
    contexts.push(buildContext(a, name, src, cpath));
  }
  const { contexts: _c, ...rest } = manifest as Obj;
  return done({ ...rest, contexts });
}

function buildContext(a: Assembler, name: string, src: ContextSources, cpath: Path): Obj {
  const { file: pf, ast } = src.proto!;
  a.knownOptions(ast.options, DECLARATION_OPTIONS.file, "a file", pf);
  const checkMessage = (m: ProtoMessage): void => {
    a.knownOptions(m.options, DECLARATION_OPTIONS.message, `message ${m.name}`, pf);
    m.messages.forEach(checkMessage);
    for (const e of m.enums) for (const v of e.values) a.knownOptions(v.options, DECLARATION_OPTIONS.enumValue, `enum value ${v.name}`, pf);
  };
  for (const d of ast.decls) {
    if (d.kind === "message") checkMessage(d.message);
    else if (d.kind === "enum") for (const v of d.enum.values) a.knownOptions(v.options, DECLARATION_OPTIONS.enumValue, `enum value ${v.name}`, pf);
    else for (const r of d.service.rpcs) a.knownOptions(r.options, DECLARATION_OPTIONS.rpc, `rpc ${r.name}`, pf);
  }
  const ctxOpt = a.option(ast.options, "ddd.v1.context", pf) ?? {};
  a.map.set(cpath, pf, a.optionTok(ast.options, "ddd.v1.context"));
  const messages = new Map<string, ProtoMessage>();
  for (const d of ast.decls) if (d.kind === "message") messages.set(d.message.name, d.message);
  const kindOf = (m: ProtoMessage) =>
    findOption(m.options, "ddd.v1.error") ? "error" : findOption(m.options, "ddd.v1.value_object") ? "vo" : findOption(m.options, "ddd.v1.aggregate") ? "aggregate" : undefined;

  // Behavior sources, merged by name.
  const domainAggs = new Map<string, { file: string; block: DomainFile["aggregates"][number] }>();
  const domainValues = new Map<string, { file: string; block: DomainFile["values"][number] }>();
  const glossary: Obj[] = [];
  const extensions: Obj[] = [];
  for (const { file, ast: d } of src.domains) {
    for (const g of d.glossary) glossary.push({ term: g.term, definition: g.definition });
    for (const b of d.aggregates) {
      if (domainAggs.has(b.name)) a.error("duplicate-name", `aggregate ${b.name} is described twice in .domain files`, file, b.tok);
      else domainAggs.set(b.name, { file, block: b });
    }
    for (const b of d.values) {
      if (domainValues.has(b.name)) a.error("duplicate-name", `value ${b.name} is described twice in .domain files`, file, b.tok);
      else domainValues.set(b.name, { file, block: b });
    }
    for (const x of d.extensions) {
      const p = [...cpath, "extension_points", extensions.length];
      a.map.set(p, file, x.tok);
      extensions.push({
        name: x.name,
        ...(x.doc !== undefined ? { description: x.doc } : {}),
        ...(x.params.length ? { parameters: a.params(x.params, file, [...p, "parameters"]) } : {}),
        returns: x.returns,
        ...(x.default ? { test_default: x.default.value } : {}),
      });
    }
  }

  const ctx: Obj = { name };
  if (typeof ctxOpt.description === "string") ctx.description = ctxOpt.description;
  if (ctxOpt.subdomain !== undefined) ctx.subdomain = lower(ctxOpt.subdomain);
  if (glossary.length) ctx.glossary = glossary;

  const errors: Obj[] = [];
  const enums: Obj[] = [];
  const vos: Obj[] = [];
  const aggregates: Obj[] = [];
  const aggregateNames = new Set<string>();
  for (const d of ast.decls) if (d.kind === "message" && kindOf(d.message) === "aggregate") aggregateNames.add(d.message.name);

  for (const d of ast.decls) {
    if (d.kind === "enum") {
      const e = d.enum;
      const p = [...cpath, "enums", enums.length];
      a.map.set(p, pf, e.tok);
      const prefix = toSnake(e.name).toUpperCase() + "_";
      const values: string[] = [];
      for (const v of e.values) {
        if (v.number === 0) continue;
        const explicit = findOption(v.options, "ddd.v1.value");
        if (explicit && explicit.value.k === "str") values.push(explicit.value.v);
        else values.push((v.name.startsWith(prefix) ? v.name.slice(prefix.length) : v.name).toLowerCase());
        a.map.set([...p, "values", values.length - 1], pf, v.tok);
      }
      enums.push({ name: e.name, ...(e.doc !== undefined ? { description: e.doc } : {}), values });
      continue;
    }
    if (d.kind !== "message") continue;
    const m = d.message;
    const kind = kindOf(m);
    if (kind === "error") {
      const p = [...cpath, "errors", errors.length];
      a.map.set(p, pf, m.tok);
      const o = a.option(m.options, "ddd.v1.error", pf) ?? {};
      const details = a.fields(m, pf, [...p, "details"]);
      errors.push({ name: m.name, code: o.code, message: o.message, ...(m.doc !== undefined ? { description: m.doc } : {}), ...(details.length ? { details } : {}) });
    } else if (kind === "vo") {
      const p = [...cpath, "value_objects", vos.length];
      a.map.set(p, pf, m.tok);
      const o = a.option(m.options, "ddd.v1.value_object", pf) ?? {};
      const normalize: Obj = {};
      for (const n of asList(o.normalize)) {
        const no = n as Obj;
        if (typeof no?.field === "string") normalize[no.field] = asList(no.steps).map((s) => lower(s));
      }
      const block = domainValues.get(m.name);
      domainValues.delete(m.name);
      const invariants = block ? a.invariants(block.block.invariants, block.file, [...p, "invariants"]) : [];
      vos.push({
        name: m.name,
        ...(m.doc !== undefined ? { description: m.doc } : {}),
        fields: a.fields(m, pf, [...p, "fields"]),
        ...(Object.keys(normalize).length ? { normalize } : {}),
        ...(invariants.length ? { invariants } : {}),
      });
    } else if (kind === "aggregate") {
      aggregates.push(buildAggregate(a, m, pf, [...cpath, "aggregates", aggregates.length], domainAggs, src));
    }
  }
  for (const { file, block } of domainAggs.values()) a.error("unknown-aggregate", `aggregate ${block.name} in ${file} has no message with (ddd.v1.aggregate) in ${pf}`, file, block.tok);
  for (const { file, block } of domainValues.values()) a.error("unknown-value-object", `value ${block.name} in ${file} has no message with (ddd.v1.value_object) in ${pf}`, file, block.tok);

  if (errors.length) ctx.errors = errors;
  if (enums.length) ctx.enums = enums;
  if (vos.length) ctx.value_objects = vos;
  if (aggregates.length) ctx.aggregates = aggregates;
  if (extensions.length) ctx.extension_points = extensions;

  // rpcs ↔ flows / queries.
  const rpcs = new Map<string, ProtoRpc>();
  for (const d of ast.decls) {
    if (d.kind !== "service") continue;
    for (const r of d.service.rpcs) {
      const uc = a.option(r.options, "ddd.v1.use_case", pf);
      const q = a.option(r.options, "ddd.v1.query", pf);
      const n = (typeof uc?.name === "string" ? uc.name : typeof q?.name === "string" ? q.name : undefined) ?? toSnake(r.name);
      if (rpcs.has(n)) a.error("duplicate-name", `Two rpcs map to ${n}`, pf, r.tok);
      else rpcs.set(n, r);
    }
  }
  const used = new Set<string>();
  const requestOf = (r: ProtoRpc): ProtoMessage | undefined => {
    const m = messages.get(r.input.split(".").pop()!);
    if (!m) a.error("unknown-message", `Request message ${r.input} of rpc ${r.name} is not declared in ${pf}`, pf, r.inputTok);
    return m;
  };
  const checkParams = (declared: { name: string; tok: Tok }[], actual: string[], what: string, file: string, tok: Tok, r: ProtoRpc) => {
    const d = declared.map((x) => x.name);
    const missing = actual.filter((x) => !d.includes(x));
    const extra = declared.filter((x) => !actual.includes(x.name));
    for (const x of extra) a.error("unknown-input", `${x.name} is not a field of ${r.input}`, file, x.tok, `The request fields of ${r.name} are: ${actual.join(", ") || "(none)"}`);
    if (missing.length) a.error("missing-input", `${what} does not list ${missing.join(", ")} of ${r.input}`, file, tok, `Write ${what.split(" ")[0]} ${what.split(" ")[1]}(${actual.join(", ")})`);
  };

  const useCases: Obj[] = [];
  const queries: Obj[] = [];
  const policies: Obj[] = [];
  for (const { file, ast: f } of src.flows) {
    for (const fl of f.flows) {
      const r = rpcs.get(fl.name);
      if (!r) {
        a.error("missing-rpc", `flow ${fl.name} has no rpc in ${pf}`, file, fl.tok, `Declare rpc ${fl.name.replace(/(^|_)([a-z0-9])/g, (_m, _u, ch: string) => ch.toUpperCase())}(...) returns (...) in the service`);
        continue;
      }
      used.add(fl.name);
      const p = [...cpath, "use_cases", useCases.length];
      a.map.set(p, pf, r.tok);
      const opt = a.option(r.options, "ddd.v1.use_case", pf) ?? {};
      const req = requestOf(r);
      // A cross-tenant use case's request carries the tenant (tenant_id), which is not a model field.
      const crossTenant = findOption(r.options, "ddd.v1.authorize")?.value;
      const implicit = new Set<string>(crossTenant?.k === "msg" && crossTenant.fields.some((x) => x.name === "cross_tenant" && x.value.k === "id" && x.value.v === "true") ? ["tenant_id"] : []);
      const input = req ? a.fields(req, pf, [...p, "input"], implicit) : [];
      if (req) checkParams(fl.params, req.fields.map((x) => x.name).filter((x) => !implicit.has(x)), `flow ${fl.name}`, file, fl.tok, r);
      const top: { allowIf?: { text: string; tok: Tok } } = {};
      a.map.set([...p, "steps"], file, fl.tok);
      const steps = a.steps(fl.steps, aggregateNames, file, [...p, "steps"], top);
      const authorize = a.authorize(a.option(r.options, "ddd.v1.authorize", pf), a.optionTok(r.options, "ddd.v1.authorize"), top.allowIf, pf, file, [...p, "authorize"]);
      const rateLimit = a.rateLimit(a.option(r.options, "ddd.v1.rate_limit", pf));
      a.map.set([...p, "rate_limit"], pf, a.optionTok(r.options, "ddd.v1.rate_limit"));
      useCases.push({
        name: fl.name,
        ...(r.doc !== undefined ? { description: r.doc } : {}),
        ...(typeof opt.actor === "string" ? { actor: opt.actor } : {}),
        command: r.name,
        ...(input.length ? { input } : {}),
        ...(opt.transaction !== undefined ? { transaction: lower(opt.transaction) } : {}),
        ...(typeof opt.idempotency_key === "string" ? { idempotency_key: opt.idempotency_key } : {}),
        ...(opt.retry !== undefined ? { retry: opt.retry } : {}),
        ...(authorize !== undefined ? { authorize } : {}),
        ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
        ...(steps.length ? { steps } : {}),
        ...scenariosFor(a, src, "use_cases", fl.name, [...p, "scenarios"]),
      });
    }
    for (const q of f.queries) {
      const r = rpcs.get(q.name);
      if (!r) {
        a.error("missing-rpc", `query ${q.name} has no rpc in ${pf}`, file, q.tok);
        continue;
      }
      used.add(q.name);
      const p = [...cpath, "queries", queries.length];
      a.map.set(p, pf, r.tok);
      const req = requestOf(r);
      const implicit = new Set<string>(["cursor", "limit", ...(q.search ? [q.search.param] : [])]);
      const params = req ? a.fields(req, pf, [...p, "params"], implicit, true) : [];
      if (req) checkParams(q.params, req.fields.map((x) => x.name).filter((x) => !implicit.has(x)), `query ${q.name}`, file, q.tok, r);
      a.map.set([...p, "from"], file, q.tok);
      const authorize = a.authorize(a.option(r.options, "ddd.v1.authorize", pf), a.optionTok(r.options, "ddd.v1.authorize"), q.authorize, pf, file, [...p, "authorize"]);
      const rateLimit = a.rateLimit(a.option(r.options, "ddd.v1.rate_limit", pf));
      a.map.set([...p, "rate_limit"], pf, a.optionTok(r.options, "ddd.v1.rate_limit"));
      const where = q.where.map((w, i) => {
        a.map.set([...p, "where", i], file, w.tok);
        return { field: w.field, op: w.op, ...(w.param !== undefined ? { param: w.param } : {}), ...(w.principal !== undefined ? { principal: w.principal } : {}), ...(w.hasValue ? { value: w.value } : {}) };
      });
      if (q.search) a.map.set([...p, "search"], file, q.search.tok);
      const orderBy = q.orderBy.map((o, i) => {
        a.map.set([...p, "order_by", i], file, o.tok);
        return o.direction ? { field: o.field, direction: o.direction } : o.field;
      });
      if (q.page) a.map.set([...p, "page"], file, q.page.tok);
      queries.push({
        name: q.name,
        ...(r.doc !== undefined ? { description: r.doc } : {}),
        from: q.from,
        ...(authorize !== undefined ? { authorize } : {}),
        ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
        ...(params.length ? { params } : {}),
        ...(where.length ? { where } : {}),
        ...(q.search ? { search: { param: q.search.param, fields: q.search.fields, mode: q.search.mode, ...(q.search.minSimilarity !== undefined ? { min_similarity: q.search.minSimilarity } : {}) } } : {}),
        ...(orderBy.length ? { order_by: orderBy } : {}),
        ...(q.page ? { page: { size: q.page.size, ...(q.page.maxSize !== undefined ? { max_size: q.page.maxSize } : {}) } } : {}),
        ...(q.returns ? { returns: q.returns } : {}),
        ...scenariosFor(a, src, "queries", q.name, [...p, "scenarios"]),
      });
    }
    for (const po of f.policies) {
      const p = [...cpath, "policies", policies.length];
      a.map.set(p, file, po.tok);
      policies.push({ name: po.name, ...(po.doc !== undefined ? { description: po.doc } : {}), when: po.event, run: po.run, ...(po.args.length ? { args: a.entryMap(po.args, file, [...p, "args"]) } : {}) });
    }
  }
  for (const [n, r] of rpcs) {
    if (!used.has(n)) a.error("missing-flow", `rpc ${r.name} has no flow or query named ${n} in the .flow files of ${name}`, pf, r.tok, `Write flow ${n}(...) { ... } or query ${n}(...) from <Aggregate> { ... }`);
  }
  if (useCases.length) ctx.use_cases = useCases;
  if (policies.length) ctx.policies = policies;
  if (queries.length) ctx.queries = queries;

  // Scenario owners that do not exist.
  for (const s of src.scenarios) {
    const known: Record<string, Set<string>> = {
      aggregates: new Set(aggregates.map((x) => x.name as string)),
      use_cases: new Set(useCases.map((x) => x.name as string)),
      queries: new Set(queries.map((x) => x.name as string)),
    };
    for (const section of ["aggregates", "use_cases", "queries"] as const) {
      const v = s.data[section];
      if (v === undefined || v === null) continue;
      const loc = yamlLocator(s.doc, s.lc, s.file);
      if (typeof v !== "object" || Array.isArray(v)) {
        const l = loc([section]);
        a.error("invalid-shape", `${section} in a scenarios file maps names to lists of scenarios`, s.file, l && { line: l.line, col: l.column });
        continue;
      }
      for (const owner of Object.keys(v as Obj)) {
        if (!known[section]!.has(owner)) {
          const l = loc([section, owner]);
          a.error("unknown-scenario-owner", `${section} ${owner} in ${s.file} does not exist in ${name}`, s.file, l && { line: l.line, col: l.column });
        }
      }
    }
  }
  return ctx;
}

function scenariosFor(a: Assembler, src: ContextSources, section: "aggregates" | "use_cases" | "queries", owner: string, path: Path): { scenarios?: unknown[] } {
  const out: unknown[] = [];
  for (const s of src.scenarios) {
    const sec = s.data[section];
    if (typeof sec !== "object" || sec === null || Array.isArray(sec)) continue;
    const list = (sec as Obj)[owner];
    if (list === undefined) continue;
    const offset = out.length;
    const locate = yamlLocator(s.doc, s.lc, s.file);
    if (!Array.isArray(list)) {
      const l = locate([section, owner]);
      a.error("invalid-shape", `The scenarios of ${owner} are a list`, s.file, l && { line: l.line, col: l.column });
      continue;
    }
    out.push(...list);
    const end = out.length;
    a.map.mount(path, (rest) => {
      const i = rest[0];
      if (typeof i !== "number" || i < offset || i >= end) return undefined;
      return locate([section, owner, i - offset, ...rest.slice(1)]);
    });
  }
  return out.length ? { scenarios: out } : {};
}

function buildAggregate(
  a: Assembler,
  m: ProtoMessage,
  pf: string,
  p: Path,
  domainAggs: Map<string, { file: string; block: DomainFile["aggregates"][number] }>,
  src: ContextSources,
): Obj {
  a.map.set(p, pf, m.tok);
  const o = a.option(m.options, "ddd.v1.aggregate", pf) ?? {};
  const optTok = a.optionTok(m.options, "ddd.v1.aggregate");
  const entityMsgs = m.messages.filter((n) => findOption(n.options, "ddd.v1.entity"));
  const d = domainAggs.get(m.name);
  domainAggs.delete(m.name);
  const df = d?.file ?? pf;
  const b = d?.block;
  const entities = entityMsgs.map((em, i) => {
    const ep = [...p, "entities", i];
    a.map.set(ep, pf, em.tok);
    const eo = a.option(em.options, "ddd.v1.entity", pf) ?? {};
    const eb = b?.entities.find((x) => x.name === em.name);
    const invariants = eb ? a.invariants(eb.invariants, df, [...ep, "invariants"]) : [];
    return {
      name: em.name,
      ...(em.doc !== undefined ? { description: em.doc } : {}),
      identity: eo.identity,
      fields: a.fields(em, pf, [...ep, "fields"]),
      ...(invariants.length ? { invariants } : {}),
    };
  });
  for (const eb of b?.entities ?? []) {
    if (!entityMsgs.some((x) => x.name === eb.name)) a.error("unknown-entity", `entity ${eb.name} has no nested message with (ddd.v1.entity) in ${m.name}`, df, eb.tok);
  }
  const invariants = b ? a.invariants(b.invariants, df, [...p, "invariants"]) : [];
  const guards = (b?.guards ?? []).map((g, i) => {
    const gp = [...p, "state_guards", i];
    a.map.set(gp, df, g.tok);
    a.map.set([...gp, "expression"], df, g.expr.tok);
    a.map.set([...gp, "error"], df, g.errorTok);
    return {
      name: g.name,
      ...(g.doc !== undefined ? { description: g.doc } : {}),
      ...(g.params.length ? { parameters: a.params(g.params, df, [...gp, "parameters"]) } : {}),
      expression: g.expr.text,
      error: g.error,
    };
  });
  const member = (x: { name: string; doc?: string; params: Param[]; requires: { text: string; tok: Tok }[]; emits: Emit[]; tok: Tok }, mp: Path) => {
    a.map.set(mp, df, x.tok);
    x.requires.forEach((r, i) => a.map.set([...mp, "require", i], df, r.tok));
    return {
      name: x.name,
      ...(x.doc !== undefined ? { description: x.doc } : {}),
      ...(x.params.length ? { parameters: a.params(x.params, df, [...mp, "parameters"]) } : {}),
      ...(x.requires.length ? { require: x.requires.map((r) => r.text) } : {}),
    };
  };
  const factories = (b?.factories ?? []).map((f, i) => {
    const fp = [...p, "factories", i];
    const emits = a.emits(f.emits, df, [...fp, "emits"]);
    return { ...member(f, fp), fields: a.entryMap(f.fields, df, [...fp, "fields"]), ...(emits.length ? { emits } : {}) };
  });
  const operations = (b?.operations ?? []).map((op, i) => {
    const opp = [...p, "operations", i];
    const emits = a.emits(op.emits, df, [...opp, "emits"]);
    return { ...member(op, opp), changes: a.entryMap(op.changes, df, [...opp, "changes"]), ...(emits.length ? { emits } : {}) };
  });
  const authorize = a.authorize(o.authorize as Obj | undefined, optTok, b?.authorize, pf, df, [...p, "authorize"]);
  const rateLimit = a.rateLimit(o.rate_limit as Obj | undefined);
  a.map.set([...p, "identity"], pf, optTok);
  return {
    name: m.name,
    ...(m.doc !== undefined ? { description: m.doc } : {}),
    identity: o.identity,
    fields: a.fields(
      { ...m, fields: m.fields },
      pf,
      [...p, "fields"],
    ),
    ...(invariants.length ? { invariants } : {}),
    ...(entities.length ? { entities } : {}),
    ...(guards.length ? { state_guards: guards } : {}),
    ...(factories.length ? { factories } : {}),
    ...(operations.length ? { operations } : {}),
    ...scenariosFor(a, src, "aggregates", m.name, [...p, "scenarios"]),
    ...(authorize !== undefined ? { authorize } : {}),
    ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
    ...(o.tenancy !== undefined ? { tenancy: lower(o.tenancy, "tenancy_") } : {}),
  };
}

/**
 * The text the generated manifest hashes (`model_sha256`) for a multi-file model: every model source in path
 * order, so editing any of them marks the generated code as coming from a different model.
 */
export function modelSourceText(files: Record<string, string>): string {
  return Object.keys(files)
    .filter((p) => isModelSource(p, files[p]!))
    .sort()
    .map((p) => `--- ${p}\n${files[p]!.replace(/\r\n/g, "\n")}`)
    .join("\n");
}

/**
 * The multi-file sources as one YAML model (for editors that work on YAML, e.g. the Web editor's import).
 * Comments are not carried over; the IR is the same.
 */
export function splitToYaml(files: Record<string, string>): { yaml?: string; diagnostics: Diagnostic[] } {
  const parsed = parseModelFiles(files);
  const failed = !parsed.data || parsed.diagnostics.some((d) => d.severity === "error" && (d.code === "syntax" || d.code === "yaml-syntax" || d.code === "missing-manifest"));
  if (failed) return { diagnostics: parsed.diagnostics };
  const { schema_version, project, description, generation, security, contexts, relationships, ...rest } = parsed.data!;
  const ordered = { schema_version, project, description, generation, security, ...rest, contexts, relationships };
  const clean = Object.fromEntries(Object.entries(ordered).filter(([, v]) => v !== undefined));
  return { yaml: stringify(clean, { lineWidth: 0 }), diagnostics: parsed.diagnostics };
}

/** Parse + semantic validation of the multi-file format (the counterpart of `validateModelText`). */
export function validateModelFiles(files: Record<string, string>): ValidateResult & { parsed: SplitParseResult } {
  const parsed = parseModelFiles(files);
  if (!parsed.model || parsed.diagnostics.some((d) => d.severity === "error")) {
    return { model: parsed.model, diagnostics: sortDiagnostics(parsed.diagnostics), ok: false, parsed };
  }
  const analysis = analyzeModel(parsed.model, parsed);
  const diagnostics: Diagnostic[] = sortDiagnostics([...parsed.diagnostics, ...analysis.diagnostics]);
  return { model: parsed.model, analysis, diagnostics, ok: !diagnostics.some((d) => d.severity === "error"), parsed };
}

export type { TfValue };
