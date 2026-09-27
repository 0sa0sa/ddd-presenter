/**
 * Copilot-style ghost text for the model editor: a grey prediction after the cursor, Tab to accept.
 * Local (rule-based) predictions appear first; an LLM prediction replaces them when AI is enabled.
 */
import { completionStatus } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { suggestInline } from "@ddd/core";

export interface Ghost {
  pos: number;
  text: string;
  label: string;
  source: "local" | "llm";
}

export interface GhostOptions {
  /** Whether LLM predictions may be requested (AI enabled for the workspace and the user can edit). */
  llmEnabled: () => boolean;
  /** Fetches an LLM prediction; resolves undefined when there is none. */
  fetchLlm: (text: string, offset: number, signal: AbortSignal) => Promise<Omit<Ghost, "pos"> | undefined>;
  /** Reports whether a request is in flight (for a small status indicator). */
  onBusy?: (busy: boolean) => void;
}

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly ghost: Ghost) {
    super();
  }
  eq(other: GhostWidget) {
    return other.ghost.text === this.ghost.text && other.ghost.source === this.ghost.source;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = `cm-ghost cm-ghost-${this.ghost.source}`;
    wrap.setAttribute("aria-hidden", "true");
    wrap.textContent = this.ghost.text;
    const badge = document.createElement("span");
    badge.className = "cm-ghost-badge";
    badge.textContent = `${this.ghost.source === "llm" ? "AI" : "予測"} · ${this.ghost.label} · Tab で確定`;
    wrap.append(badge);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    // Any edit or cursor move invalidates the prediction.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g), side: 1 }).range(g.pos)]) : Decoration.none)),
});

function atLineEnd(view: EditorView): number | undefined {
  const sel = view.state.selection.main;
  if (!sel.empty) return undefined;
  const line = view.state.doc.lineAt(sel.head);
  if (view.state.sliceDoc(sel.head, line.to).trim()) return undefined;
  return sel.head;
}

export function acceptGhost(view: EditorView): boolean {
  const g = view.state.field(ghostField, false);
  if (!g || completionStatus(view.state) === "active") return false;
  view.dispatch({
    changes: { from: g.pos, insert: g.text },
    selection: { anchor: g.pos + g.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
  });
  return true;
}

export function ghostText(opts: GhostOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      localTimer?: ReturnType<typeof setTimeout>;
      llmTimer?: ReturnType<typeof setTimeout>;
      abort?: AbortController;

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return;
        this.schedule(false);
      }

      schedule(immediate: boolean) {
        clearTimeout(this.localTimer);
        clearTimeout(this.llmTimer);
        this.abort?.abort();
        opts.onBusy?.(false);
        this.localTimer = setTimeout(() => this.requestLocal(), immediate ? 0 : 350);
        if (opts.llmEnabled()) this.llmTimer = setTimeout(() => void this.requestLlm(), immediate ? 0 : 900);
      }

      requestLocal() {
        const pos = atLineEnd(this.view);
        if (pos === undefined || completionStatus(this.view.state) === "active") return;
        const text = this.view.state.doc.toString();
        const s = suggestInline(text, pos);
        if (s && this.view.state.doc.toString() === text && this.view.state.selection.main.head === pos && !this.view.state.field(ghostField, false)) {
          this.view.dispatch({ effects: setGhost.of({ pos, text: s.text, label: s.label, source: "local" }) });
        }
      }

      async requestLlm() {
        const pos = atLineEnd(this.view);
        if (pos === undefined) return;
        const text = this.view.state.doc.toString();
        const ctrl = new AbortController();
        this.abort = ctrl;
        opts.onBusy?.(true);
        try {
          const g = await opts.fetchLlm(text, pos, ctrl.signal);
          if (!g || ctrl.signal.aborted) return;
          if (this.view.state.doc.toString() !== text || this.view.state.selection.main.head !== pos) return;
          this.view.dispatch({ effects: setGhost.of({ ...g, pos }) });
        } catch {
          // Network or model errors: keep the local prediction.
        } finally {
          if (this.abort === ctrl) opts.onBusy?.(false);
        }
      }

      destroy() {
        clearTimeout(this.localTimer);
        clearTimeout(this.llmTimer);
        this.abort?.abort();
      }
    },
  );

  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptGhost },
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(ghostField, false)) return false;
            view.dispatch({ effects: setGhost.of(null) });
            return true;
          },
        },
        {
          // Ask for a prediction now (Alt+\ like many editors).
          key: "Alt-\\",
          run: (view) => {
            view.plugin(plugin)?.schedule(true);
            return true;
          },
        },
      ]),
    ),
  ];
}
