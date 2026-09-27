import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import type { Diagnostic } from "@ddd/core";
import { useEffect, useRef } from "react";

export interface GotoRequest {
  line: number;
  nonce: number;
}

/** Token colors from the design tokens, so they work in light and dark mode. */
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--k-aggregate)" },
  { tag: [t.string, t.special(t.string)], color: "var(--ink)" },
  { tag: [t.number, t.bool, t.null], color: "var(--k-event)" },
  { tag: [t.comment, t.lineComment], color: "var(--ink-faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.meta, t.labelName], color: "var(--k-usecase)" },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: "var(--ink-faint)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--surface)", color: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--ink-faint)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--k-aggregate) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-content": { caretColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--k-aggregate) 22%, transparent)" },
});

export function YamlEditor({
  value,
  onChange,
  diagnostics,
  readOnly,
  goto,
  onCursorLine,
}: {
  value: string;
  onChange: (text: string) => void;
  diagnostics: Diagnostic[];
  readOnly: boolean;
  goto?: GotoRequest;
  onCursorLine?: (line: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onCursorLine });
  callbacks.current = { onChange, onCursorLine };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(highlight),
          yaml(),
          lintGutter(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          theme,
          EditorState.tabSize.of(2),
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ "aria-label": "YAMLモデル" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) callbacks.current.onCursorLine?.(u.state.doc.lineAt(u.state.selection.main.head).number);
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External text changes (form edits, reloads) replace the document without losing the undo history.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const cm: CmDiagnostic[] = diagnostics.map((d) => {
      const line = doc.line(Math.min(Math.max(d.line ?? 1, 1), doc.lines));
      const from = Math.min(line.from + Math.max((d.column ?? 1) - 1, 0), line.to);
      return {
        from,
        to: Math.max(from, line.to),
        severity: d.severity,
        message: `${d.message}${d.hint ? `\n${d.hint}` : ""}`,
        source: d.code,
      };
    });
    v.dispatch(setDiagnostics(v.state, cm));
  }, [diagnostics, value]);

  useEffect(() => {
    const v = view.current;
    if (!v || !goto) return;
    const line = v.state.doc.line(Math.min(Math.max(goto.line, 1), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [goto]);

  return <div ref={host} style={{ height: "100%", minHeight: 0 }} />;
}
