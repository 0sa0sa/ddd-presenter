/** CodeMirror integration of the core language service: completion, hover, go-to-definition, rename. */
import { acceptCompletion, autocompletion, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { complete, definition, hover, prepareRename, rename, type CompletionKind } from "@ddd/core";

const CM_TYPE: Record<CompletionKind, string> = {
  key: "property",
  type: "type",
  error: "class",
  aggregate: "class",
  event: "class",
  field: "variable",
  parameter: "variable",
  enumValue: "enum",
  function: "function",
  guard: "method",
  variable: "variable",
  port: "namespace",
  extension: "function",
  operation: "method",
  factory: "method",
  keyword: "keyword",
  value: "constant",
  context: "namespace",
  useCase: "function",
};

const KIND_LABEL: Record<CompletionKind, string> = {
  key: "キー",
  type: "型",
  error: "Domain error",
  aggregate: "Aggregate",
  event: "Domain event",
  field: "フィールド",
  parameter: "引数",
  enumValue: "Enum値",
  function: "関数",
  guard: "State guard",
  variable: "変数",
  port: "Port",
  extension: "Extension point",
  operation: "Operation",
  factory: "Factory",
  keyword: "キーワード",
  value: "値",
  context: "Bounded context",
  useCase: "Use case",
};

/** Minimal Markdown (bold, code, bullet lists, paragraphs) rendered safely as DOM. */
export function renderMarkdown(md: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-ddd-doc";
  const inline = (text: string, into: HTMLElement) => {
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (!part) continue;
      if (part.startsWith("**")) {
        const b = document.createElement("strong");
        b.textContent = part.slice(2, -2);
        into.append(b);
      } else if (part.startsWith("`")) {
        const c = document.createElement("code");
        c.textContent = part.slice(1, -1);
        into.append(c);
      } else into.append(document.createTextNode(part));
    }
  };
  for (const block of md.split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines.every((l) => l.startsWith("- "))) {
      const ul = document.createElement("ul");
      for (const l of lines) {
        const li = document.createElement("li");
        inline(l.slice(2), li);
        ul.append(li);
      }
      root.append(ul);
    } else {
      const p = document.createElement("p");
      inline(lines.join(" "), p);
      root.append(p);
    }
  }
  return root;
}

function source(context: CompletionContext): CompletionResult | null {
  const text = context.state.doc.toString();
  const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
  const word = context.matchBefore(/[A-Za-z0-9_]*/);
  // Open automatically while typing a word, or right after ".", ": ", "[", "{", ", " and "- ".
  if (!context.explicit && (!word || word.from === word.to) && !/[.:\[{, -]/.test(before)) return null;
  const r = complete(text, context.pos);
  if (!r.items.length) return null;
  const options: Completion[] = r.items.map((i) => ({
    label: i.label,
    type: CM_TYPE[i.kind],
    detail: i.detail,
    info: i.documentation ? () => renderMarkdown(i.documentation!) : undefined,
    apply: i.insertText,
    section: KIND_LABEL[i.kind],
    boost: 10 - (i.sortRank ?? 5),
  }));
  return { from: r.from, to: r.to, options, validFor: /^[A-Za-z0-9_]*$/ };
}

function gotoDefinition(view: EditorView, pos: number): boolean {
  const d = definition(view.state.doc.toString(), pos);
  if (!d) return false;
  view.dispatch({ selection: { anchor: d.from, head: d.to }, effects: EditorView.scrollIntoView(d.from, { y: "center" }) });
  return true;
}

export interface LanguageOptions {
  /** Called with the new document after a rename; the editor applies it through its normal change path. */
  onRename: (text: string, change: { from: string; to: string }) => void;
  /** Asks the user for a new name; returns undefined when cancelled. */
  askName: (current: string) => string | undefined;
  onMessage: (message: string) => void;
}

export function dddLanguage(opts: LanguageOptions): Extension {
  const doRename = (view: EditorView): boolean => {
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    const check = prepareRename(text, pos);
    if (!check.ok) {
      opts.onMessage(check.error);
      return true;
    }
    const next = opts.askName(check.name);
    if (!next || next === check.name) return true;
    const r = rename(text, pos, next);
    if (!r.ok) opts.onMessage(r.error);
    else opts.onRename(r.text, { from: check.name, to: next });
    return true;
  };

  return [
    autocompletion({ override: [source], icons: true, activateOnTyping: true, maxRenderedOptions: 60 }),
    Prec.high(
      keymap.of([
        ...completionKeymap,
        { key: "Tab", run: acceptCompletion },
        { key: "F12", run: (v) => gotoDefinition(v, v.state.selection.main.head) },
        { key: "F2", run: doRename },
      ]),
    ),
    hoverTooltip((view, pos) => {
      const h = hover(view.state.doc.toString(), pos);
      if (!h) return null;
      return { pos: h.from, end: h.to, above: true, create: () => ({ dom: renderMarkdown(h.markdown) }) };
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        if (gotoDefinition(view, pos)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    }),
  ];
}
