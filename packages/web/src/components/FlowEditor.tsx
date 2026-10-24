import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import type { FlowEditProblem } from "@ddd/core";
import { useEffect, useRef } from "react";
import { highlight, theme } from "./YamlEditor.tsx";

const KEYWORDS = new Set(["flow", "let", "load", "else", "fail", "if", "save", "publish", "after", "commit", "return", "authorize", "query", "from", "where", "search", "on", "order", "by", "page", "max", "returns", "policy", "run", "and", "or", "not", "trigram", "prefix", "exact", "asc", "desc"]);

/** Colours of the .flow syntax (docs/10 §12.4): keywords, comments, strings, numbers, `:parameters`. */
const flowLanguage = StreamLanguage.define<null>({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(\.\d+)?/)) return "number";
    if (stream.match(/^:[A-Za-z_]\w*/)) return "variableName";
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return "keyword";
      if (w === "true" || w === "false" || w === "null") return "bool";
      return /^[A-Z]/.test(w) ? "typeName" : null;
    }
    stream.next();
    return "punctuation";
  },
});

/** Editor of one .flow block (a use case, query or policy); problems are shown at their line in the block. */
export function FlowEditor({ value, onChange, problems, readOnly, label, onSubmit }: { value: string; onChange: (text: string) => void; problems: FlowEditProblem[]; readOnly: boolean; label: string; onSubmit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const callbacks = useRef({ onChange, onSubmit });
  callbacks.current = { onChange, onSubmit };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          flowLanguage,
          syntaxHighlighting(highlight),
          lintGutter(),
          keymap.of([{ key: "Mod-Enter", run: () => (callbacks.current.onSubmit?.(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          theme,
          EditorState.tabSize.of(2),
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once per block (the parent keys it); later values come from typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const cm: CmDiagnostic[] = problems.flatMap((p) => {
      if (p.line === undefined || p.line < 1 || p.line > doc.lines) return [];
      const line = doc.line(p.line);
      const from = Math.min(line.from + Math.max((p.column ?? 1) - 1, 0), line.to);
      return [{ from, to: Math.max(from, line.to), severity: "error" as const, message: `${p.message}${p.hint ? `\n${p.hint}` : ""}`, ...(p.code ? { source: p.code } : {}) }];
    });
    v.dispatch(setDiagnostics(v.state, cm));
  }, [problems]);

  return <div ref={host} className="flow-editor" />;
}
