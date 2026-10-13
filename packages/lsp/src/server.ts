/**
 * Language Server for DDD Presenter models: a YAML model (*.ddd.yaml), or a multi-file model (ddd.yaml with
 * .proto / .domain / .flow / .scenarios.yaml sources, docs/10 §12), validated as one project.
 * Same parser, validator and language service as the CLI and the Web editor.
 */
import {
  complete,
  definition,
  hover,
  isModelSource,
  MANIFEST_FILE,
  prepareRename,
  prepareSplitRename,
  rename,
  splitRename,
  sourceKind,
  splitKeywords,
  splitSymbols,
  validateModelFiles,
  validateModelText,
  wordAt,
  type CompletionKind,
  type Diagnostic as ModelDiagnostic,
  type SplitSymbol,
  type SplitSymbolKind,
} from "@ddd/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type Diagnostic,
  type InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const KIND: Record<CompletionKind, CompletionItemKind> = {
  key: CompletionItemKind.Property,
  type: CompletionItemKind.Class,
  error: CompletionItemKind.Class,
  aggregate: CompletionItemKind.Class,
  event: CompletionItemKind.Event,
  field: CompletionItemKind.Field,
  parameter: CompletionItemKind.Variable,
  enumValue: CompletionItemKind.EnumMember,
  function: CompletionItemKind.Function,
  guard: CompletionItemKind.Method,
  variable: CompletionItemKind.Variable,
  port: CompletionItemKind.Module,
  extension: CompletionItemKind.Function,
  operation: CompletionItemKind.Method,
  factory: CompletionItemKind.Constructor,
  keyword: CompletionItemKind.Keyword,
  value: CompletionItemKind.Value,
  context: CompletionItemKind.Module,
  useCase: CompletionItemKind.Function,
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(
  (): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [".", ":", " ", "[", "{", ",", "-"] },
      hoverProvider: true,
      definitionProvider: true,
      renameProvider: { prepareProvider: true },
    },
    serverInfo: { name: "ddd-presenter-lsp", version: "0.1.0" },
  }),
);

function toLsp(d: ModelDiagnostic, text: string): Diagnostic {
  const line = Math.max((d.line ?? 1) - 1, 0);
  const character = Math.max((d.column ?? 1) - 1, 0);
  const lineText = text.split("\n")[line] ?? "";
  return {
    range: { start: { line, character }, end: { line, character: Math.max(lineText.length, character) } },
    severity: d.severity === "error" ? DiagnosticSeverity.Error : d.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
    code: d.code,
    source: "ddd",
    message: `${d.element ? `${d.element}: ` : ""}${d.message}${d.hint ? `\n${d.hint}` : ""}`,
  };
}

function publish(doc: TextDocument): void {
  const text = doc.getText();
  const result = validateModelText(text);
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: result.diagnostics.map((d) => toLsp(d, text)) });
}

// ---------------------------------------------------------------------------
// Multi-file models: every source of the project (the directory holding ddd.yaml) is validated together.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "dist", "build", "venv", "generated"]);

const pathOf = (uri: string): string | undefined => (uri.startsWith("file:") ? fileURLToPath(uri) : undefined);

/** The multi-file project a document belongs to: the nearest directory above it with ddd.yaml. */
function projectRoot(uri: string): string | undefined {
  const path = pathOf(uri);
  if (!path || !sourceKind(path)) return undefined;
  let dir = dirname(path);
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

interface Project {
  /** Relative path → text (open documents win over the disk). */
  files: Record<string, string>;
  symbols: SplitSymbol[];
  published: Set<string>;
}
const projects = new Map<string, Project>();

function readSources(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile() && sourceKind(e.name)) {
        const rel = relative(root, abs).split(sep).join("/");
        if (sourceKind(rel) === "manifest" && rel !== MANIFEST_FILE) continue;
        try {
          const text = readFileSync(abs, "utf8");
          if (isModelSource(rel, text)) files[rel] = text;
        } catch {
          // unreadable: leave it out
        }
      }
    }
  };
  walk(root, 0);
  for (const doc of documents.all()) {
    const p = pathOf(doc.uri);
    if (!p) continue;
    const rel = relative(root, p).split(sep).join("/");
    if (rel.startsWith("..") || !sourceKind(rel) || (sourceKind(rel) === "manifest" && rel !== MANIFEST_FILE)) continue;
    if (isModelSource(rel, doc.getText())) files[rel] = doc.getText();
    else delete files[rel];
  }
  return files;
}

function publishProject(root: string): void {
  const files = readSources(root);
  const result = validateModelFiles(files);
  const prev = projects.get(root);
  const symbols = result.model ? splitSymbols(result.model, result.parsed.locate) : prev?.symbols ?? [];
  const byFile = new Map<string, ModelDiagnostic[]>();
  for (const d of result.diagnostics) {
    const f = d.file ?? MANIFEST_FILE;
    byFile.set(f, [...(byFile.get(f) ?? []), d]);
  }
  const published = new Set<string>();
  for (const rel of new Set([...Object.keys(files), ...byFile.keys()])) {
    const uri = pathToFileURL(join(root, rel)).toString();
    published.add(uri);
    const text = files[rel] ?? "";
    void connection.sendDiagnostics({ uri, diagnostics: (byFile.get(rel) ?? []).map((d) => toLsp(d, text)) });
  }
  for (const uri of prev?.published ?? []) if (!published.has(uri)) void connection.sendDiagnostics({ uri, diagnostics: [] });
  projects.set(root, { files, symbols, published });
}

/** A YAML model document (the multi-file sources are handled per project). */
const isYamlModel = (doc: TextDocument) => doc.languageId === "ddd-yaml" || /\.ddd\.ya?ml$/.test(doc.uri);

function schedule(doc: TextDocument, delay: number): void {
  const root = projectRoot(doc.uri);
  if (!root && !isYamlModel(doc)) return; // e.g. a .proto outside any multi-file model
  const key = root ?? doc.uri;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => (root ? publishProject(root) : publish(doc)), delay),
  );
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
documents.onDidChangeContent((e) => schedule(e.document, 150));
documents.onDidOpen((e) => schedule(e.document, 0));
documents.onDidClose((e) => {
  const root = projectRoot(e.document.uri);
  if (root) schedule(e.document, 0); // the file on disk now counts
  else void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

const SYMBOL_KIND: Record<SplitSymbolKind, CompletionItemKind> = {
  context: CompletionItemKind.Module,
  error: CompletionItemKind.Class,
  enum: CompletionItemKind.Enum,
  enumValue: CompletionItemKind.EnumMember,
  valueObject: CompletionItemKind.Struct,
  aggregate: CompletionItemKind.Class,
  entity: CompletionItemKind.Class,
  field: CompletionItemKind.Field,
  guard: CompletionItemKind.Method,
  factory: CompletionItemKind.Constructor,
  operation: CompletionItemKind.Method,
  event: CompletionItemKind.Event,
  extension: CompletionItemKind.Function,
  useCase: CompletionItemKind.Function,
  query: CompletionItemKind.Function,
  policy: CompletionItemKind.Function,
};

function splitDoc(uri: string): { root: string; project?: Project; kind: ReturnType<typeof sourceKind> } | undefined {
  const root = projectRoot(uri);
  if (!root) return undefined;
  return { root, project: projects.get(root), kind: sourceKind(pathOf(uri)!) };
}

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const split = splitDoc(doc.uri);
  if (split) {
    const text = doc.getText();
    const offset = doc.offsetAt(params.position);
    const w = wordAt(text, offset) ?? { word: "", from: offset, to: offset };
    const range = { start: doc.positionAt(w.from), end: doc.positionAt(w.to) };
    const seen = new Set<string>();
    const items = [
      ...splitKeywords(split.kind!).map((k) => ({ label: k, kind: CompletionItemKind.Keyword, sortText: `2${k}` })),
      ...(split.project?.symbols ?? []).flatMap((s) => {
        const id = `${s.kind}:${s.name}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ label: s.name, kind: SYMBOL_KIND[s.kind], detail: s.detail, documentation: s.description, sortText: `1${s.name}` }];
      }),
    ];
    return { isIncomplete: false, items: items.map((i) => ({ ...i, textEdit: { range, newText: i.label }, filterText: i.label })) };
  }
  if (!isYamlModel(doc)) return [];
  const offset = doc.offsetAt(params.position);
  const r = complete(doc.getText(), offset);
  const range = { start: doc.positionAt(r.from), end: doc.positionAt(r.to) };
  return {
    isIncomplete: false,
    items: r.items.map((i, index) => ({
      label: i.label,
      kind: KIND[i.kind],
      detail: i.detail,
      documentation: i.documentation ? { kind: MarkupKind.Markdown, value: i.documentation } : undefined,
      textEdit: { range, newText: i.insertText ?? i.label },
      insertTextFormat: InsertTextFormat.PlainText,
      sortText: `${String(i.sortRank ?? 5).padStart(2, "0")}${String(index).padStart(4, "0")}`,
      filterText: i.label,
    })),
  };
});

/** Declarations named like the word under the cursor (the current context's first). */
function symbolsAt(doc: TextDocument, position: { line: number; character: number }, project: Project | undefined) {
  const w = wordAt(doc.getText(), doc.offsetAt(position));
  if (!w || !project) return undefined;
  const found = project.symbols.filter((s) => s.name === w.word);
  return found.length ? { w, found } : undefined;
}

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const split = splitDoc(doc.uri);
  if (split) {
    const at = symbolsAt(doc, params.position, split.project);
    if (!at) return null;
    const value = at.found.map((s) => `\`${s.detail}\`${s.description ? `\n\n${s.description}` : ""}`).join("\n\n---\n\n");
    return { contents: { kind: MarkupKind.Markdown, value }, range: { start: doc.positionAt(at.w.from), end: doc.positionAt(at.w.to) } };
  }
  if (!isYamlModel(doc)) return null;
  const h = hover(doc.getText(), doc.offsetAt(params.position));
  if (!h) return null;
  return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: { start: doc.positionAt(h.from), end: doc.positionAt(h.to) } };
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const split = splitDoc(doc.uri);
  if (split) {
    const at = symbolsAt(doc, params.position, split.project);
    if (!at) return null;
    return at.found.flatMap((s) => {
      if (!s.loc) return [];
      const start = { line: s.loc.line - 1, character: s.loc.column - 1 };
      return [{ uri: pathToFileURL(join(split.root, s.loc.file)).toString(), range: { start, end: { line: start.line, character: start.character + s.name.length } } }];
    });
  }
  if (!isYamlModel(doc)) return null;
  const d = definition(doc.getText(), doc.offsetAt(params.position));
  if (!d) return null;
  return { uri: doc.uri, range: { start: doc.positionAt(d.from), end: doc.positionAt(d.to) } };
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const root = projectRoot(doc.uri);
  if (root) {
    const files = readSources(root);
    const rel = relative(root, pathOf(doc.uri)!).split(sep).join("/");
    const r = prepareSplitRename(files, rel, doc.offsetAt(params.position));
    if (!r.ok) throw new Error(r.error);
    return { range: { start: doc.positionAt(r.from), end: doc.positionAt(r.to) }, placeholder: r.name };
  }
  if (!isYamlModel(doc)) return null;
  const r = prepareRename(doc.getText(), doc.offsetAt(params.position));
  if (!r.ok) throw new Error(r.error);
  return { range: { start: doc.positionAt(r.from), end: doc.positionAt(r.to) }, placeholder: r.name };
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const root = projectRoot(doc.uri);
  if (root) {
    // Every file of the project that mentions the name is rewritten (open or not).
    const files = readSources(root);
    const rel = relative(root, pathOf(doc.uri)!).split(sep).join("/");
    const r = splitRename(files, rel, doc.offsetAt(params.position), params.newName);
    if (!r.ok) throw new Error(r.error);
    const changes: Record<string, { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]> = {};
    for (const p of r.changed) {
      const old = files[p]!;
      const lines = old.split("\n");
      changes[pathToFileURL(join(root, p)).toString()] = [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1]!.length } }, newText: r.files[p]! }];
    }
    return { changes };
  }
  if (!isYamlModel(doc)) return null;
  const text = doc.getText();
  const r = rename(text, doc.offsetAt(params.position), params.newName);
  if (!r.ok) throw new Error(r.error);
  return { changes: { [doc.uri]: [{ range: { start: doc.positionAt(0), end: doc.positionAt(text.length) }, newText: r.text }] } };
});

documents.listen(connection);
connection.listen();
