import {
  applyFlowBlock,
  eventFlowToMermaid,
  flowBlocks,
  flowDiagrams,
  flowReviewTargets,
  sequenceToMermaid,
  type Analysis,
  type FlowEditProblem,
  type FlowRef,
  type FlowReviewTarget,
  type ModelIR,
  type ReviewQuestion,
  type ReviewVerdict,
} from "@ddd/core";
import { useEffect, useMemo, useState } from "react";
import type { StoredAnswer } from "../lib/review.ts";
import { EventFlowSvg, SequenceSvg } from "./FlowDiagrams.tsx";
import { FlowEditor } from "./FlowEditor.tsx";

const KEYWORD: Record<FlowRef["kind"], string> = { use_case: "flow", query: "query", policy: "policy" };
const refKey = (r: FlowRef) => `${r.kind}:${r.context}.${r.name}`;
/** `events`, or the diagram's `Context.name`. */
const diagramId = (t: FlowReviewTarget) => (t.diagram === "events" ? "events" : t.diagram.id);

/**
 * The flow diagrams of the review (docs/11 §12): the event chain and one sequence per use case and query, drawn from
 * the model being edited. A reviewer answers "is this flow right?" per diagram (stored like the other review answers,
 * under an id that changes with the diagram); an editor can rewrite the .flow block behind a diagram and see it redrawn.
 */
export function FlowReview({
  model,
  analysis,
  text,
  questions,
  stored,
  canEdit,
  dirty,
  onAnswer,
  onApply,
  focus,
}: {
  model: ModelIR;
  analysis?: Analysis;
  text: string;
  /** Questions of the saved model (answers can be given only to a diagram the saved model shows). */
  questions: ReviewQuestion[];
  stored: Record<string, StoredAnswer>;
  canEdit: boolean;
  dirty: boolean;
  onAnswer: (q: ReviewQuestion, answer: ReviewVerdict | null, note: string) => void;
  onApply: (yaml: string, message: string) => void;
  /** A diagram to show (`events` or `Context.name`), e.g. from a question's 「図で見る」. */
  focus?: { id: string; nonce: number };
}) {
  const diagrams = useMemo(() => flowDiagrams(model, analysis), [model, analysis]);
  const targets = useMemo(() => flowReviewTargets(model, diagrams), [model, diagrams]);
  const blocks = useMemo(() => flowBlocks(text), [text]);
  const saved = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const [selected, setSelected] = useState<string>(() => (targets[0] ? diagramId(targets[0]) : "events"));
  const [editing, setEditing] = useState<FlowRef>();
  const [draft, setDraft] = useState("");
  const [problems, setProblems] = useState<FlowEditProblem[]>([]);
  const [error, setError] = useState<string>();
  const [noteOpen, setNoteOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const target = targets.find((t) => diagramId(t) === selected) ?? targets[0];
  const sequence = target && target.diagram !== "events" ? target.diagram : undefined;
  const question = target ? saved.get(target.id) : undefined;
  const answer = target ? stored[target.id] : undefined;
  const source = editing ? blocks.find((c) => c.context === editing.context)?.blocks.find((b) => b.kind === editing.kind && b.name === editing.name)?.source : undefined;

  useEffect(() => {
    if (focus) select(focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // A diagram that no longer exists (renamed in the YAML): fall back to the first.
  useEffect(() => {
    if (targets.length && !targets.some((t) => diagramId(t) === selected)) setSelected(diagramId(targets[0]!));
  }, [targets, selected]);

  const openEditor = (ref: FlowRef) => {
    const b = blocks.find((c) => c.context === ref.context)?.blocks.find((x) => x.kind === ref.kind && x.name === ref.name);
    if (!b) return;
    setEditing(ref);
    setDraft(b.source);
    setProblems([]);
    setError(undefined);
  };
  const closeEditor = () => {
    setEditing(undefined);
    setProblems([]);
    setError(undefined);
  };
  const select = (id: string) => {
    setSelected(id);
    setNoteOpen(false);
    setCopied(false);
    if (editing && !(id !== "events" && id === `${editing.context}.${editing.name}`)) closeEditor();
  };
  const apply = () => {
    if (!editing) return;
    const r = applyFlowBlock(text, editing, draft);
    if (!r.ok) {
      setError(r.error);
      setProblems(r.problems);
      return;
    }
    setError(undefined);
    setProblems([]);
    if (!r.changed) {
      setError("変更はありません（意味が同じです）");
      return;
    }
    onApply(r.text, `${KEYWORD[editing.kind]} ${editing.name} を書き換えました（未保存）`);
    closeEditor();
  };
  const copyMermaid = async () => {
    const mmd = sequence ? sequenceToMermaid(sequence) : eventFlowToMermaid(diagrams.events);
    try {
      await navigator.clipboard.writeText(mmd);
      setCopied(true);
    } catch {
      setError("クリップボードに書き込めませんでした");
    }
  };

  const contexts = model.contexts.filter((c) => c.useCases.length || c.queries.length);
  const status = (id: string) => {
    const s = stored[id];
    if (!saved.has(id)) return { mark: "▲", label: "保存していない変更で図が変わっています" };
    if (s?.answer === "no") return { mark: "✕", label: "いいえ（直すもの）" };
    if (s?.answer === "yes") return { mark: "✓", label: "はい" };
    return { mark: "・", label: "未回答" };
  };
  const item = (id: string, diagramId: string, label: string) => {
    const st = status(id);
    return (
      <li key={diagramId}>
        <button className="flow-index-item" aria-current={selected === diagramId ? "true" : undefined} onClick={() => select(diagramId)} title={st.label}>
          <span className={`flow-mark flow-mark-${st.mark === "✓" ? "yes" : st.mark === "✕" ? "no" : st.mark === "▲" ? "stale" : "open"}`} aria-label={st.label}>
            {st.mark}
          </span>
          <span>{label}</span>
        </button>
      </li>
    );
  };
  const policies = model.contexts.flatMap((c) => c.policies.map((p) => ({ context: c.name, p })));

  if (!targets.length) return <p className="muted">図にする Use case・クエリがありません。</p>;

  return (
    <div className="flow-review">
      <nav className="flow-index" aria-label="フロー図の一覧">
        <ul>
          {targets[0]?.diagram === "events" && item(targets[0].id, "events", "イベントのつながり")}
        </ul>
        {contexts.map((c) => (
          <div key={c.name}>
            <h3 className="flow-index-ctx">{c.name}</h3>
            <ul>
              {targets
                .filter((t) => t.diagram !== "events" && t.diagram.ref.context === c.name)
                .map((t) => {
                  const d = t.diagram as Exclude<typeof t.diagram, "events">;
                  return item(t.id, d.id, `${d.ref.kind === "query" ? "（クエリ）" : ""}${d.description ?? d.ref.name}`);
                })}
            </ul>
          </div>
        ))}
      </nav>

      <section className="flow-main" aria-live="polite">
        {target && (
          <>
            <header className="flow-main-head">
              <div>
                <h2 className="flow-title">{sequence ? sequence.title : "イベントのつながり"}</h2>
                <p className="small muted flow-sub">
                  {sequence
                    ? `${sequence.ref.context} の ${sequence.ref.kind === "query" ? "クエリ" : "Use case"}。上から順に動き、枠の中は条件に当てはまるときだけ起きます。✕ の矢印で止まります。`
                    : "人が始める Use case（青）、それが発行するイベント（橙）、反応するポリシー（紫）、ポリシーが動かす Use case。点線の枠は、反応するものがないイベントです。"}
                </p>
              </div>
              <div className="flow-actions">
                <span className="small">この流れで合っている？</span>
                <div className="segmented" role="group" aria-label="この流れで合っているか">
                  {(["yes", "no"] as const).map((v) => (
                    <button key={v} className="small-button" aria-pressed={answer?.answer === v} disabled={!canEdit || !question} onClick={() => question && onAnswer(question, answer?.answer === v ? null : v, answer?.note ?? "")}>
                      {v === "yes" ? "はい" : "いいえ"}
                    </button>
                  ))}
                </div>
                <button className="linklike small" onClick={() => setNoteOpen(!noteOpen)} disabled={!question}>
                  {answer?.note ? "メモを見る" : "メモ"}
                </button>
                <button className="small-button" onClick={() => void copyMermaid()} title="この図を Mermaid の文で">
                  {copied ? "コピーしました" : "Mermaid をコピー"}
                </button>
                {sequence && canEdit && !editing && (
                  <button className="small-button primary" onClick={() => openEditor(sequence.ref)}>
                    フローを直す
                  </button>
                )}
              </div>
            </header>
            {!question && <p className="small sev-warning">▲ {dirty ? "保存していない変更でこの図が変わっています。保存すると、この図に答えられます。" : "この図はまだ質問になっていません。"}</p>}
            {answer?.answer === "no" && question && <p className="small review-finding">直すもの: {question.ifDifferent}</p>}
            {noteOpen && question && (
              <textarea
                className="review-note"
                rows={2}
                maxLength={2000}
                defaultValue={answer?.note ?? ""}
                disabled={!canEdit}
                aria-label="メモ: この流れについて"
                placeholder="違う所、足りない手順など"
                onBlur={(e) => {
                  if (e.target.value !== (answer?.note ?? "")) onAnswer(question, answer?.answer ?? null, e.target.value);
                }}
              />
            )}
            {!noteOpen && answer?.note && <p className="small review-note-text">メモ: {answer.note}</p>}

            {editing && source !== undefined && (
              <div className="flow-edit">
                <div className="flow-edit-head">
                  <strong className="small">
                    {KEYWORD[editing.kind]} {editing.name} を直す
                  </strong>
                  <span className="small muted">.flow の書き方（docs/10 §12.4）。名前と入力は変えられません。Ctrl/Cmd + Enter で適用。</span>
                </div>
                <FlowEditor key={`${refKey(editing)}\u0000${source}`} value={draft} onChange={setDraft} problems={problems} readOnly={!canEdit} label={`${KEYWORD[editing.kind]} ${editing.name} の .flow`} onSubmit={apply} />
                {error && (
                  <div className="error-banner small" role="alert">
                    <div>{error}</div>
                    {problems.length > 0 && (
                      <ul className="flow-problems">
                        {problems.map((p, i) => (
                          <li key={i}>
                            {p.line !== undefined ? `${p.line} 行目: ` : ""}
                            {p.message}
                            {p.hint ? `（${p.hint}）` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="flow-edit-actions">
                  <button className="primary" onClick={apply} disabled={draft === source}>
                    適用
                  </button>
                  <button onClick={() => setDraft(source)} disabled={draft === source}>
                    元に戻す
                  </button>
                  <button className="quiet" onClick={closeEditor}>
                    閉じる
                  </button>
                  <span className="small muted">適用するとモデル（YAML）が変わります。保存するまでほかの人には見えません。</span>
                </div>
              </div>
            )}

            <div className="flow-canvas">
              {sequence ? (
                <SequenceSvg diagram={sequence} />
              ) : (
                <EventFlowSvg
                  graph={diagrams.events}
                  onOpen={(n) => {
                    if (!n.ref) return;
                    if (n.ref.kind === "policy") openEditor(n.ref);
                    else select(`${n.ref.context}.${n.ref.name}`);
                  }}
                />
              )}
            </div>
            {!sequence && policies.length > 0 && canEdit && !editing && (
              <p className="small muted">
                ポリシーを直す:{" "}
                {policies.map(({ context, p }, i) => (
                  <span key={`${context}.${p.name}`}>
                    {i > 0 && "・"}
                    <button className="linklike small" onClick={() => openEditor({ context, kind: "policy", name: p.name })}>
                      {p.name}
                    </button>
                  </span>
                ))}
                （図のポリシーや Use case を押しても開けます）
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
