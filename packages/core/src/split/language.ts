/**
 * Editor support for the multi-file format (LSP): the names a model declares, where each is declared (through the
 * source map) and the keywords of each file kind, for completion, hover and go-to-definition across files.
 */
import { isMap, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { Path } from "../diagnostics.ts";
import type { ModelIR } from "../ir.ts";
import { toSnake } from "../validate.ts";
import { parseModelFiles, sourceKind, validateModelFiles, type Loc, type SourceKind } from "./assemble.ts";
import { lex } from "./lexer.ts";

export type SplitSymbolKind =
  | "context"
  | "error"
  | "enum"
  | "enumValue"
  | "valueObject"
  | "aggregate"
  | "entity"
  | "field"
  | "guard"
  | "factory"
  | "operation"
  | "event"
  | "extension"
  | "useCase"
  | "query"
  | "policy";

export interface SplitSymbol {
  name: string;
  kind: SplitSymbolKind;
  /** e.g. "aggregate CleaningStaffInvitation", "field email: EmailAddress". */
  detail: string;
  description?: string;
  context: string;
  loc?: Loc;
}

const KEYWORDS: Record<"domain" | "flow", string[]> = {
  domain: ["context", "glossary", "extension", "default", "value", "aggregate", "authorize", "invariant", "else", "on", "construct", "transition", "guard", "factory", "operation", "requires", "new", "change", "emit", "when", "entity", "and", "or", "not", "true", "false", "null"],
  flow: ["context", "flow", "let", "load", "else", "fail", "if", "save", "publish", "after", "commit", "return", "authorize", "query", "from", "where", "search", "on", "trigram", "prefix", "exact", "order", "by", "asc", "desc", "page", "max", "returns", "policy", "run", "and", "or", "not", "true", "false", "null", "clock", "ids", "principal", "event"],
};

export function splitKeywords(kind: SourceKind): string[] {
  return kind === "domain" || kind === "flow" ? KEYWORDS[kind] : [];
}

/** Every named element of the model with its declaration site. */
export function splitSymbols(model: ModelIR, locate: (path: Path) => Loc | undefined): SplitSymbol[] {
  const out: SplitSymbol[] = [];
  const add = (s: Omit<SplitSymbol, "loc">, path: Path) => out.push({ ...s, loc: locate(path) });
  for (const c of model.contexts) {
    const ctx = c.name;
    add({ name: c.name, kind: "context", detail: `context ${c.name}`, description: c.description, context: ctx }, c.path);
    for (const e of c.errors) add({ name: e.name, kind: "error", detail: `error ${e.name} (${e.code})`, description: e.description ?? e.message, context: ctx }, e.path);
    for (const e of c.enums) {
      add({ name: e.name, kind: "enum", detail: `enum ${e.name}: ${e.values.join(" | ")}`, description: e.description, context: ctx }, e.path);
      e.values.forEach((v, i) => add({ name: v, kind: "enumValue", detail: `${e.name}.${v}`, context: ctx }, [...e.path, "values", i]));
    }
    for (const v of c.valueObjects) {
      add({ name: v.name, kind: "valueObject", detail: `value object ${v.name}`, description: v.description, context: ctx }, v.path);
      for (const f of v.fields) add({ name: f.name, kind: "field", detail: `field ${v.name}.${f.name}: ${f.type}`, description: f.description, context: ctx }, f.path);
    }
    const events = new Set<string>();
    for (const a of c.aggregates) {
      add({ name: a.name, kind: "aggregate", detail: `aggregate ${a.name} (identity ${a.identity})`, description: a.description, context: ctx }, a.path);
      for (const f of a.fields) add({ name: f.name, kind: "field", detail: `field ${a.name}.${f.name}: ${f.type}${f.required ? "" : "?"}`, description: f.description, context: ctx }, f.path);
      for (const e of a.entities) {
        add({ name: e.name, kind: "entity", detail: `entity ${a.name}.${e.name}`, description: e.description, context: ctx }, e.path);
        for (const f of e.fields) add({ name: f.name, kind: "field", detail: `field ${e.name}.${f.name}: ${f.type}`, description: f.description, context: ctx }, f.path);
      }
      for (const g of a.stateGuards) add({ name: g.name, kind: "guard", detail: `guard ${a.name}.${g.name}: ${g.expression}`, description: g.description, context: ctx }, g.path);
      for (const f of a.factories) {
        add({ name: f.name, kind: "factory", detail: `factory ${a.name}.${f.name}(${f.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")})`, description: f.description, context: ctx }, f.path);
        for (const e of f.emits) if (!events.has(e.name)) (events.add(e.name), add({ name: e.name, kind: "event", detail: `event ${e.name} (from ${a.name}.${f.name})`, context: ctx }, e.path));
      }
      for (const o of a.operations) {
        add({ name: o.name, kind: "operation", detail: `operation ${a.name}.${o.name}(${o.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")})`, description: o.description, context: ctx }, o.path);
        for (const e of o.emits) if (!events.has(e.name)) (events.add(e.name), add({ name: e.name, kind: "event", detail: `event ${e.name} (from ${a.name}.${o.name})`, context: ctx }, e.path));
      }
    }
    for (const x of c.extensionPoints) add({ name: x.name, kind: "extension", detail: `extension ${x.name}(${x.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${x.returns}`, description: x.description, context: ctx }, x.path);
    for (const u of c.useCases) add({ name: u.name, kind: "useCase", detail: `flow ${u.name} (rpc ${u.command})`, description: u.description, context: ctx }, u.path);
    for (const q of c.queries) add({ name: q.name, kind: "query", detail: `query ${q.name} from ${q.from}`, description: q.description, context: ctx }, q.path);
    for (const p of c.policies) add({ name: p.name, kind: "policy", detail: `policy ${p.name} on ${p.when}`, description: p.description, context: ctx }, p.path);
  }
  return out;
}

/** The identifier around `offset` (letters, digits, `_`), with its range. */
export function wordAt(text: string, offset: number): { word: string; from: number; to: number } | undefined {
  let from = offset;
  let to = offset;
  while (from > 0 && /[A-Za-z0-9_]/.test(text[from - 1]!)) from--;
  while (to < text.length && /[A-Za-z0-9_]/.test(text[to]!)) to++;
  if (from === to || /[0-9]/.test(text[from]!)) return undefined;
  return { word: text.slice(from, to), from, to };
}

// ---------------------------------------------------------------------------
// Rename across the files of a multi-file model
// ---------------------------------------------------------------------------

/** Kinds that can be renamed (fields and enum values are left out: their names are too often shared). */
const RENAMABLE: Partial<Record<SplitSymbolKind, "pascal" | "snake">> = {
  error: "pascal",
  enum: "pascal",
  valueObject: "pascal",
  aggregate: "pascal",
  entity: "pascal",
  event: "pascal",
  guard: "snake",
  extension: "snake",
  factory: "snake",
  operation: "snake",
};

/** YAML keys whose value names a renamable element (scenarios, relationships). */
const YAML_REF_KEYS = new Set(["raises", "event", "type", "factory", "operation", "aggregate"]);
/** YAML mappings whose keys name elements (scenario owners, stubbed extensions). */
const YAML_NAME_MAPS = new Set(["aggregates", "extensions"]);

export type SplitRenameResult = { ok: true; files: Record<string, string>; changed: string[] } | { ok: false; error: string };

export function prepareSplitRename(
  files: Record<string, string>,
  file: string,
  offset: number,
): { ok: true; name: string; from: number; to: number; kind: SplitSymbolKind } | { ok: false; error: string } {
  const text = files[file];
  if (text === undefined) return { ok: false, error: "The file is not part of the model" };
  const w = wordAt(text, offset);
  if (!w) return { ok: false, error: "Put the cursor on a name" };
  const parsed = parseModelFiles(files);
  if (!parsed.model) return { ok: false, error: "The model cannot be read; fix the syntax errors first" };
  const found = splitSymbols(parsed.model, parsed.locate).filter((s) => s.name === w.word);
  const kinds = [...new Set(found.map((s) => s.kind))];
  const renamable = kinds.filter((k) => RENAMABLE[k]);
  if (!renamable.length) {
    return { ok: false, error: found.length ? `A ${kinds[0]} cannot be renamed here; rename it in each file` : `${w.word} is not a declared name` };
  }
  if (kinds.length > 1) return { ok: false, error: `${w.word} names more than one thing (${kinds.join(", ")}); rename them by hand` };
  return { ok: true, name: w.word, from: w.from, to: w.to, kind: renamable[0]! };
}

function renameTokens(text: string, from: string, to: string, enumPrefix?: { from: string; to: string }, strings = false): string {
  let out = "";
  let last = 0;
  for (const t of lex(text)) {
    // `(ddd.v1.ref) = "Order"` names a type in a string.
    if (strings && t.k === "str" && t.v === from) {
      out += text.slice(last, t.s) + JSON.stringify(to);
      last = t.e;
      continue;
    }
    if (t.k !== "id") continue;
    let replacement: string | undefined;
    if (t.v === from) replacement = to;
    else if (enumPrefix && t.v.startsWith(enumPrefix.from)) replacement = enumPrefix.to + t.v.slice(enumPrefix.from.length);
    if (replacement === undefined) continue;
    out += text.slice(last, t.s) + replacement;
    last = t.e;
  }
  return out + text.slice(last);
}

function renameYaml(text: string, from: string, to: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) return text;
  let changed = false;
  visit(doc, {
    Pair(_k, pair, path) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (key && YAML_REF_KEYS.has(key) && isScalar(pair.value) && pair.value.value === from) {
        pair.value.value = to;
        changed = true;
      }
      if (key === "events" && isSeq(pair.value)) {
        for (const item of pair.value.items) if (isScalar(item) && item.value === from) ((item.value = to), (changed = true));
      }
      const parent = path[path.length - 1];
      const owner = path[path.length - 2];
      if (isScalar(pair.key) && pair.key.value === from && isMap(parent) && owner && isPair(owner) && isScalar(owner.key) && YAML_NAME_MAPS.has(String(owner.key.value))) {
        pair.key.value = to;
        changed = true;
      }
    },
  });
  return changed ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }) : text;
}

/** Renames a declared element in every file of a multi-file model; refuses when the result would have new errors. */
export function splitRename(files: Record<string, string>, file: string, offset: number, newName: string): SplitRenameResult {
  const prep = prepareSplitRename(files, file, offset);
  if (!prep.ok) return prep;
  const style = RENAMABLE[prep.kind]!;
  const pattern = style === "pascal" ? /^[A-Z][A-Za-z0-9]*$/ : /^[a-z][a-z0-9_]*$/;
  if (!pattern.test(newName)) return { ok: false, error: `${newName} must be ${style === "pascal" ? "PascalCase" : "snake_case"}` };
  if (newName === prep.name) return { ok: false, error: "The name is unchanged" };
  const parsed = parseModelFiles(files);
  if (splitSymbols(parsed.model!, parsed.locate).some((s) => s.name === newName)) return { ok: false, error: `${newName} is already used` };
  const enumPrefix = prep.kind === "enum" ? { from: toSnake(prep.name).toUpperCase() + "_", to: toSnake(newName).toUpperCase() + "_" } : undefined;
  const next: Record<string, string> = {};
  const changed: string[] = [];
  for (const [p, text] of Object.entries(files)) {
    const kind = sourceKind(p);
    const out = kind === "manifest" || kind === "scenarios" ? renameYaml(text, prep.name, newName) : kind ? renameTokens(text, prep.name, newName, kind === "proto" ? enumPrefix : undefined, kind === "proto" && style === "pascal") : text;
    next[p] = out;
    if (out !== text) changed.push(p);
  }
  const before = validateModelFiles(files).diagnostics.filter((d) => d.severity === "error").length;
  const after = validateModelFiles(next).diagnostics.filter((d) => d.severity === "error");
  if (after.length > before) return { ok: false, error: `Renaming would leave errors: ${after[0]!.message}` };
  return { ok: true, files: next, changed };
}
