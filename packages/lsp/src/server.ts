/**
 * Language Server for DDD Presenter models (*.ddd.yaml).
 * Same parser, validator and language service as the CLI and the Web editor.
 */
import { complete, definition, hover, prepareRename, rename, validateModelText, type CompletionKind } from "@ddd/core";
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

function publish(doc: TextDocument): void {
  const text = doc.getText();
  const result = validateModelText(text);
  const diagnostics: Diagnostic[] = result.diagnostics.map((d) => {
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
  });
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics });
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
documents.onDidChangeContent((e) => {
  clearTimeout(timers.get(e.document.uri));
  timers.set(
    e.document.uri,
    setTimeout(() => publish(e.document), 150),
  );
});
documents.onDidOpen((e) => publish(e.document));
documents.onDidClose((e) => void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }));

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
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

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const h = hover(doc.getText(), doc.offsetAt(params.position));
  if (!h) return null;
  return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: { start: doc.positionAt(h.from), end: doc.positionAt(h.to) } };
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const d = definition(doc.getText(), doc.offsetAt(params.position));
  if (!d) return null;
  return { uri: doc.uri, range: { start: doc.positionAt(d.from), end: doc.positionAt(d.to) } };
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const r = prepareRename(doc.getText(), doc.offsetAt(params.position));
  if (!r.ok) throw new Error(r.error);
  return { range: { start: doc.positionAt(r.from), end: doc.positionAt(r.to) }, placeholder: r.name };
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const r = rename(text, doc.offsetAt(params.position), params.newName);
  if (!r.ok) throw new Error(r.error);
  return { changes: { [doc.uri]: [{ range: { start: doc.positionAt(0), end: doc.positionAt(text.length) }, newText: r.text }] } };
});

documents.listen(connection);
connection.listen();
