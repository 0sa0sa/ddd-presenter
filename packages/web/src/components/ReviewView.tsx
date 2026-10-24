import { flowsMarkdown, formatPath, REVIEW_CATEGORIES, reviewMarkdown, reviewQuestions, validateModelText, type Analysis, type ModelIR, type Path, type ProofReport, type ReviewQuestion, type ReviewVerdict } from "@ddd/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api.ts";
import { downloadBlob, safeFileName } from "../lib/download.ts";
import { answersOf, filterQuestions, reviewState, type ReviewFilter, type StoredAnswer } from "../lib/review.ts";
import { FlowReview } from "./FlowReview.tsx";
import { ProofView } from "./ProofView.tsx";

type Mode = "questions" | "flows" | "proofs";
const MODES: readonly Mode[] = ["questions", "flows", "proofs"];

const KEY_PREF = "ddd.review.showModel";
const KEY_MODE = "ddd.review.mode";
const local = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not remembered in a private window.
    }
  },
};
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
  text,
  model,
  analysis,
  onApply,
}: {
  projectId: string;
  projectName: string;
  savedYaml: string;
  savedVersion: number;
  dirty: boolean;
  canEdit: boolean;
  onGoto: (p: Path) => void;
  /** The model being edited (the flow diagrams are drawn from it, and their .flow blocks edit it). */
  text: string;
  model?: ModelIR;
  analysis?: Analysis;
  onApply: (yaml: string, message: string) => void;
}) {
  const result = useMemo(() => validateModelText(savedYaml), [savedYaml]);
  // Proofs of the saved version (Z3 on the server, docs/09 §29): their counterexamples are questions too.
  const [proofs, setProofs] = useState<{ version: number; loading: boolean; report?: ProofReport | null; reason?: string; error?: string }>({ version: 0, loading: false });
  const report = proofs.version === savedVersion ? (proofs.report ?? undefined) : undefined;
  const questions = useMemo(() => (result.analysis && result.ok ? reviewQuestions(result.analysis, report ? { proofs: report } : {}) : []), [result, report]);
  const [stored, setStored] = useState<Record<string, StoredAnswer>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [showModel, setShowModel] = useState(pref.get);
  const [noteOpen, setNoteOpen] = useState<string>();
  const [mode, setModeState] = useState<Mode>(() => {
    const m = local.get(KEY_MODE) as Mode | null;
    return m && MODES.includes(m) ? m : "questions";
  });
  const [flowFocus, setFlowFocus] = useState<{ id: string; nonce: number }>();
  const setMode = (m: Mode) => {
    setModeState(m);
    local.set(KEY_MODE, m);
  };
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

  useEffect(() => {
    if (!result.ok) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setProofs({ version: savedVersion, loading: true });
    // The server answers "running" while a first proof of the version is still going: ask again shortly.
    const ask = () =>
      api.proofs(projectId, savedVersion).then(
        (r) => {
          if (!live) return;
          if (r.reason === "running") timer = setTimeout(ask, 2000);
          else setProofs({ version: r.version, loading: false, report: r.report, ...(r.reason ? { reason: r.reason } : {}) });
        },
        (e) => live && setProofs({ version: savedVersion, loading: false, error: describeError(e) }),
      );
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, savedVersion, result.ok]);

  const state = useMemo(() => reviewState(questions, stored), [questions, stored]);
  // Answers to proof questions are not stale while the version's proofs are loading, off or failed (the questions
  // are simply not there yet): only a report for the saved version tells which counterexamples are gone.
  const stale = useMemo(() => (report ? state.stale : state.stale.filter((x) => !x.id.startsWith("proof:"))), [state.stale, report]);
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
  const downloadFlows = () => {
    if (!model) return;
    downloadBlob(new Blob([flowsMarkdown(model, analysis)], { type: "text/markdown" }), `${safeFileName(projectName)}-flows${dirty ? "-unsaved" : `-v${savedVersion}`}.md`);
  };

  const modes = (
    <div className="review-modes segmented" role="tablist" aria-label="レビューの方法">
      {(
        [
          ["questions", "質問（はい／いいえ）"],
          ["flows", "フロー図"],
          ["proofs", "証明（Z3）"],
        ] as const
      ).map(([id, label]) => (
        <button key={id} role="tab" className="small-button" aria-selected={mode === id} aria-pressed={mode === id} onClick={() => setMode(id)}>
          {label}
        </button>
      ))}
    </div>
  );

  if (mode === "flows") {
    return (
      <div className="view review">
        {modes}
        <div className="flow-bar">
          <p className="muted small flow-intro">モデルから作った手順の図です。順番・止まる所・どこ（サーバー・DB・イベント）で何をするかが業務どおりか、図ごとに答えてください。図は編集中のモデルから描きます。</p>
          <div className="spacer" />
          <button className="small-button" onClick={downloadFlows} disabled={!model} title="すべての図を Mermaid つきの Markdown で">
            フロー図（Markdown）
          </button>
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {!canEdit && <p className="small muted">閲覧者は回答・編集できません。</p>}
        {model ? (
          <FlowReview model={model} analysis={analysis} text={text} questions={questions} stored={stored} canEdit={canEdit && loaded} dirty={dirty} onAnswer={(q, a, n) => void save(q, a, n)} onApply={onApply} focus={flowFocus} />
        ) : (
          <p className="error-banner">モデルにエラーがあるため、図を描けません。モデルを直してください。</p>
        )}
      </div>
    );
  }

  if (mode === "proofs") {
    return (
      <div className="view review">
        {modes}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <ProofView
          projectName={projectName}
          savedVersion={savedVersion}
          proofs={proofs.version === savedVersion ? proofs : { loading: true }}
          questions={questions}
          stored={stored}
          canEdit={canEdit && loaded}
          dirty={dirty}
          text={text}
          model={model}
          onAnswer={(q, a, n) => void save(q, a, n)}
          onApply={onApply}
          onGoto={onGoto}
        />
      </div>
    );
  }

  if (!result.ok || !result.analysis) {
    return (
      <div className="view review">
        {modes}
        <p className="error-banner">保存されたモデル（v{savedVersion}）にエラーがあるため、質問を作れません。モデルを直して保存してください。</p>
      </div>
    );
  }

  let lastCategory = "";
  const numbers = new Map(questions.map((q, i) => [q.id, i + 1]));
  return (
    <div className="view review">
      {modes}
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
                {q.category === "proofs" && (
                  <button className="linklike small" onClick={() => setMode("proofs")}>
                    反例を見る
                  </button>
                )}
                {q.category === "flows" && (
                  <button
                    className="linklike small"
                    onClick={() => {
                      setFlowFocus({ id: q.id.split(":")[1]!, nonce: Date.now() });
                      setMode("flows");
                    }}
                  >
                    図で見る
                  </button>
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

      {stale.length > 0 && filter === "all" && (
        <details className="small">
          <summary>モデルの変更で使われなくなった回答 {stale.length} 件</summary>
          <ul>
            {stale.map((x) => (
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
