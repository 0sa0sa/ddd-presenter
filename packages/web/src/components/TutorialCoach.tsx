import type { Board, ModelIR } from "@ddd/core";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { href } from "../App.tsx";
import { TOURS } from "../lib/tour.ts";
import { nextStep, TUTORIAL_STEPS, tutorialProgress, tutorialStore, type TutorialTab } from "../lib/tutorial.ts";
import { Spotlight } from "./Spotlight.tsx";

const TAB_LABEL: Record<TutorialTab, string> = {
  discovery: "ディスカバリー",
  model: "モデル (YAML)",
  diagram: "図",
  rules: "ルール",
  scenarios: "シナリオ",
  preview: "生成プレビュー",
  history: "履歴",
};

export function TutorialCoach({
  projectId,
  currentTab,
  draft,
  saved,
  savedOk,
  savedVersion,
  onOpenTab,
  onClose,
}: {
  projectId: string;
  currentTab: string;
  draft?: ModelIR;
  saved?: ModelIR;
  savedOk: boolean;
  savedVersion: number;
  onOpenTab: (tab: TutorialTab) => void;
  onClose: () => void;
}) {
  const [board, setBoard] = useState<Board>();
  const [store, setStore] = useState(() => tutorialStore.get());
  const [openId, setOpenId] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [tour, setTour] = useState<{ stepId: string; index: number }>();

  // The board lives in its own view; poll it so progress follows what the learner does there.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.board(projectId).then(
        (r) => alive && setBoard(r.board),
        () => undefined,
      );
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId]);

  useEffect(() => {
    tutorialStore.visit(currentTab);
    setStore(tutorialStore.get());
  }, [currentTab]);

  const progress = useMemo(
    () => tutorialProgress({ board, draft, saved, savedOk, savedVersion, visited: new Set(store.visited), manualDone: new Set(store.manualDone) }),
    [board, draft, saved, savedOk, savedVersion, store],
  );
  const next = nextStep(progress);
  const doneCount = TUTORIAL_STEPS.filter((s) => progress[s.id]).length;
  const shown = TUTORIAL_STEPS.find((s) => s.id === openId) ?? next;
  const collapsed = !!store.collapsed;
  const autoTour = store.autoTour !== false;

  // When a step becomes the next one, show its spotlight tour once (can be turned off).
  useEffect(() => {
    if (!next || tour || !autoTour || !TOURS[next.id] || (store.toured ?? []).includes(next.id)) return;
    if (board === undefined) return; // wait for the first progress check, so a finished step does not flash its tour
    tutorialStore.markToured(next.id);
    setStore(tutorialStore.get());
    setTour({ stepId: next.id, index: 0 });
  }, [next, tour, autoTour, store.toured, board]);

  const startTour = (stepId: string) => {
    tutorialStore.markToured(stepId);
    setStore(tutorialStore.get());
    setTour({ stepId, index: 0 });
  };

  if (tour && TOURS[tour.stepId]) {
    return (
      <Spotlight
        stops={TOURS[tour.stepId]!}
        index={tour.index}
        onIndex={(i) => setTour({ ...tour, index: Math.max(0, i) })}
        onClose={() => setTour(undefined)}
        onOpenTab={(t) => t !== currentTab && onOpenTab(t)}
      />
    );
  }
  // On the board the right side holds the assist panel; elsewhere the right side is the inspector.
  const side = currentTab === "discovery" ? " is-left" : " is-right";

  const setCollapsed = (v: boolean) => {
    tutorialStore.setCollapsed(v);
    setStore(tutorialStore.get());
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text.replace(/ → .*$/, ""));
      setCopied(text);
      setTimeout(() => setCopied(undefined), 1200);
    } catch {
      // Clipboard permission denied: the text is visible, the learner can type it.
    }
  };

  if (collapsed) {
    return (
      <button className={`coach-pill${side}`} onClick={() => setCollapsed(false)} aria-label="ガイドを開く">
        ガイド {doneCount}/{TUTORIAL_STEPS.length}
        {next ? `・次: ${next.title}` : "・完了"}
      </button>
    );
  }

  return (
    <aside className={`coach${side}`} aria-label="チュートリアルのガイド">
      <header className="coach-head">
        <strong>ガイド</strong>
        <span className="small muted">
          {doneCount} / {TUTORIAL_STEPS.length}
        </span>
        <div className="spacer" />
        <a className="small" href={href({ page: "tutorial" })}>
          DDD の説明
        </a>
        <button className="quiet small-button" onClick={() => setCollapsed(true)} aria-label="ガイドを小さくする">
          ─
        </button>
        <button className="quiet small-button" onClick={onClose} aria-label="ガイドを閉じる" title="閉じる（プロジェクトの「ガイド」ボタンで再表示）">
          ✕
        </button>
      </header>
      <div className="coach-bar" role="progressbar" aria-valuemin={0} aria-valuemax={TUTORIAL_STEPS.length} aria-valuenow={doneCount}>
        <span style={{ width: `${(doneCount / TUTORIAL_STEPS.length) * 100}%` }} />
      </div>

      {!next && !openId ? (
        <div className="coach-body">
          <p>
            <strong>おつかれさまでした。</strong>ボードで見つけた集約とルールが、モデルになり、Python のコードとテストになるところまで体験しました。
          </p>
          <p className="small muted">次は自分の業務で、ドメインエキスパートと一緒にイベントを並べるところから始めてみてください。</p>
        </div>
      ) : (
        shown && (
          <div className="coach-body">
            <p className="coach-step-label small muted">{progress[shown.id] ? "✓ 完了した手順" : shown === next ? "次にやること" : "手順"}</p>
            <h3>{shown.title}</h3>
            <p className="small coach-why">{shown.why}</p>
            <ol className="small coach-how">
              {shown.how.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ol>
            {shown.examples && (
              <div className="coach-examples">
                {shown.examples.map((ex) => (
                  <button key={ex} className="coach-example" onClick={() => void copy(ex)} title="クリックでコピー">
                    {copied === ex ? "コピーしました" : ex}
                  </button>
                ))}
              </div>
            )}
            <div className="row" style={{ flexWrap: "wrap" }}>
              {TOURS[shown.id] && (
                <button className="primary small-button" onClick={() => startTour(shown.id)}>
                  操作を見せる（ハイライト）
                </button>
              )}
              {currentTab !== shown.tab && !TOURS[shown.id] && (
                <button className="primary small-button" onClick={() => onOpenTab(shown.tab)}>
                  「{TAB_LABEL[shown.tab]}」を開く
                </button>
              )}
              {shown.manual && (
                <label className="small row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!progress[shown.id]}
                    onChange={() => {
                      tutorialStore.toggleManual(shown.id);
                      setStore(tutorialStore.get());
                    }}
                  />
                  できた
                </label>
              )}
              {openId && openId !== next?.id && (
                <button className="quiet small-button" onClick={() => setOpenId(undefined)}>
                  次の手順に戻る
                </button>
              )}
            </div>
          </div>
        )
      )}

      <label className="small row coach-auto">
        <input
          type="checkbox"
          checked={autoTour}
          onChange={(e) => {
            tutorialStore.setAutoTour(e.target.checked);
            setStore(tutorialStore.get());
          }}
        />
        次の手順に進んだら、操作ガイド（ハイライト）を自動で出す
      </label>
      <ol className="coach-list">
        {TUTORIAL_STEPS.map((s) => (
          <li key={s.id}>
            <button className={`coach-item${s.id === shown?.id ? " is-open" : ""}`} onClick={() => setOpenId(s.id)}>
              <span className={progress[s.id] ? "tut-ok" : "muted"} aria-label={progress[s.id] ? "完了" : "未完了"}>
                {progress[s.id] ? "✓" : "○"}
              </span>
              <span>{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
