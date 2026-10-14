import { formatPath, REVIEW_CATEGORIES, reviewMarkdown, reviewQuestions, validateModelText, type Path, type ReviewQuestion, type ReviewVerdict } from "@ddd/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api.ts";
import { downloadBlob, safeFileName } from "../lib/download.ts";
import { answersOf, filterQuestions, reviewState, type ReviewFilter, type StoredAnswer } from "../lib/review.ts";

const KEY_PREF = "ddd.review.showModel";
const pref = {
  get: () => {
    try {
      return localStorage.getItem(KEY_PREF) === "1";
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      localStorage.setItem(KEY_PREF, on ? "1" : "0");
    } catch {
      // The choice is not remembered in a private window.
    }
  },
};

const MODEL_LABEL = { yes: "はい", no: "いいえ", undefined: "モデルにない" } as const;

/**
 * The product manager's review (docs/11 §11): yes/no questions read from the saved model. Answers are shared with
 * the project; an answer that differs from the model (or a yes to something the model has no place for) is a change
 * to make. The model's own answers stay hidden until asked for, so they do not lead the reviewer.
 */
export function ReviewView({
  projectId,
  projectName,
  savedYaml,
  savedVersion,
  dirty,
  canEdit,
  onGoto,
}: {
  projectId: string;
  projectName: string;
  savedYaml: string;
  savedVersion: number;
  dirty: boolean;
  canEdit: boolean;
  onGoto: (p: Path) => void;
}) {
  const result = useMemo(() => validateModelText(savedYaml), [savedYaml]);
  const questions = useMemo(() => (result.analysis && result.ok ? reviewQuestions(result.analysis) : []), [result]);
  const [stored, setStored] = useState<Record<string, StoredAnswer>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [showModel, setShowModel] = useState(pref.get);
  const [noteOpen, setNoteOpen] = useState<string>();
  const storedRef = useRef(stored);
  storedRef.current = stored;

  useEffect(() => {
    let live = true;
    setLoaded(false);
    api.reviewAnswers(projectId).then(
      (r) => {
        if (!live) return;
        setStored(r.answers);
        setLoaded(true);
      },
      (e) => live && setError(describeError(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const state = useMemo(() => reviewState(questions, stored), [questions, stored]);
  const shown = useMemo(() => filterQuestions(questions, stored, filter, state.findingIds), [questions, stored, filter, state.findingIds]);

  const save = async (q: ReviewQuestion, answer: ReviewVerdict | null, note: string) => {
    const before = storedRef.current[q.id];
    const next: StoredAnswer = { answer, note, text: q.text, by: before?.by ?? null, at: before?.at ?? new Date().toISOString() };
    setStored((s) => {
      const copy = { ...s };
      if (answer === null && !note.trim()) delete copy[q.id];
      else copy[q.id] = next;
      return copy;
    });
    setError(undefined);
    try {
      const r = await api.saveReviewAnswer(projectId, { question_id: q.id, answer, note, text: q.text });
      setStored((s) => (s[q.id] ? { ...s, [q.id]: { ...s[q.id]!, by: r.by, at: r.at } } : s));
    } catch (e) {
      // Put back what the server still has.
      setStored((s) => {
        const copy = { ...s };
        if (before) copy[q.id] = before;
        else delete copy[q.id];
        return copy;
      });
      setError(`回答を保存できませんでした: ${describeError(e)}`);
    }
  };

  const download = (withAnswers: boolean) => {
    const md = reviewMarkdown(projectName, questions, withAnswers ? { answers: answersOf(stored) } : {});
    downloadBlob(new Blob([md], { type: "text/markdown" }), `${safeFileName(projectName)}-${withAnswers ? "review-result" : "review-sheet"}-v${savedVersion}.md`);
  };

  if (!result.ok || !result.analysis) {
    return (
      <div className="view">
        <p className="error-banner">保存されたモデル（v{savedVersion}）にエラーがあるため、質問を作れません。モデルを直して保存してください。</p>
      </div>
    );
  }

  let lastCategory = "";
  const numbers = new Map(questions.map((q, i) => [q.id, i + 1]));
  return (
    <div className="view review">
      <p className="muted">
        モデルから作った「はい／いいえ」の質問です。プロダクトマネージャーが、業務として正しいかを答えてください。モデルと違う答え（とモデルにまだないことへの「はい」）が、モデルを直すべき所になります。回答はこのプロジェクトのメンバーに共有されます。
      </p>
      {dirty && <p className="small sev-warning">▲ 保存していない変更があります。質問は保存されたモデル（v{savedVersion}）から作っています。</p>}

      <div className="review-bar">
        <span>
          回答 <strong>{state.answered}</strong> / {questions.length} 問
          {state.findings.length > 0 && <span className="sev sev-warning">・▲ モデルを直すもの {state.findings.length} 件</span>}
        </span>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="表示する質問">
          {(
            [
              ["all", "すべて"],
              ["open", "未回答"],
              ["findings", "直すもの"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className="small-button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <label className="small review-toggle">
          <input
            type="checkbox"
            checked={showModel}
            onChange={(e) => {
              setShowModel(e.target.checked);
              pref.set(e.target.checked);
            }}
          />
          モデルの答えを表示
        </label>
        <button className="small-button" onClick={() => download(false)} title="回答欄つきの質問票（モデルの答えなし）">
          質問票（Markdown）
        </button>
        <button className="small-button" onClick={() => download(true)} disabled={!state.answered} title="回答と、モデルを直すものの一覧">
          結果（Markdown）
        </button>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!canEdit && <p className="small muted">閲覧者は回答できません。編集者か所有者が回答できます。</p>}
      {!loaded && !error && <p className="muted">回答を読み込んでいます…</p>}

      {loaded && shown.length === 0 && <p className="muted">{filter === "open" ? "すべて回答しました。" : filter === "findings" ? "モデルを直すものはありません。" : "質問がありません。"}</p>}

      <ol className="review-list">
        {shown.map((q) => {
          const s = stored[q.id];
          const finding = state.findings.find((f) => f.question.id === q.id);
          const header = q.category !== lastCategory ? REVIEW_CATEGORIES[q.category] : undefined;
          lastCategory = q.category;
          return (
            <li key={q.id} className="review-item" data-state={finding ? "finding" : s?.answer ? "answered" : "open"}>
              {header && <h2 className="review-cat">{header}</h2>}
              <div className="review-q">
                <p className="review-text">
                  <span className="muted small">{numbers.get(q.id)}.</span> {q.text}
                </p>
                <div className="segmented" role="group" aria-label={`回答: ${q.text}`}>
                  {(["yes", "no"] as const).map((v) => (
                    <button key={v} className="small-button" aria-pressed={s?.answer === v} disabled={!canEdit} onClick={() => void save(q, s?.answer === v ? null : v, s?.note ?? "")}>
                      {v === "yes" ? "はい" : "いいえ"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="review-meta small muted">
                {showModel && <span>モデル: {MODEL_LABEL[q.modelAnswer]}</span>}
                {s?.answer && s.by && (
                  <span>
                    {s.by}・{new Date(s.at).toLocaleString()}
                  </span>
                )}
                <button className="linklike small" onClick={() => setNoteOpen(noteOpen === q.id ? undefined : q.id)}>
                  {s?.note ? "メモを見る" : "メモ"}
                </button>
              </div>
              {finding && (
                <div className="review-finding small" role="note">
                  <strong>{finding.kind === "missing" ? "モデルにまだないことです。" : `モデルは「${MODEL_LABEL[q.modelAnswer]}」です。`}</strong>
                  <div>いまのモデル: {q.basis}</div>
                  <div>直し方: {q.ifDifferent}</div>
                  <button className="linklike small" onClick={() => onGoto(q.path)} title={formatPath(q.path)}>
                    モデルで見る（{q.element}）
                  </button>
                </div>
              )}
              {showModel && !finding && <p className="small muted review-basis">根拠: {q.basis}</p>}
              {noteOpen === q.id && (
                <textarea
                  className="review-note"
                  rows={2}
                  maxLength={2000}
                  defaultValue={s?.note ?? ""}
                  disabled={!canEdit}
                  aria-label={`メモ: ${q.text}`}
                  placeholder="迷った理由、確認する相手など"
                  onBlur={(e) => {
                    if (e.target.value !== (s?.note ?? "")) void save(q, s?.answer ?? null, e.target.value);
                  }}
                />
              )}
              {noteOpen !== q.id && s?.note && <p className="small review-note-text">メモ: {s.note}</p>}
            </li>
          );
        })}
      </ol>

      {state.stale.length > 0 && filter === "all" && (
        <details className="small">
          <summary>モデルの変更で使われなくなった回答 {state.stale.length} 件</summary>
          <ul>
            {state.stale.map((x) => (
              <li key={x.id}>
                {x.stored.text || x.id} → {x.stored.answer === "yes" ? "はい" : "いいえ"}
                {x.stored.by ? `（${x.stored.by}）` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
