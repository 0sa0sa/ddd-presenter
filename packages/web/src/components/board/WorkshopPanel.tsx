import { DEFAULT_VOTES, phaseOf, STICKY_KINDS, voteRanking, votesLeft, WORKSHOP_PHASES, type Board } from "@ddd/core";
import { useEffect, useState } from "react";

/** Remaining time of the shared timebox, updated every second. */
function useRemaining(endsAt?: string): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  return endsAt ? Math.max(0, Date.parse(endsAt) - now) : undefined;
}

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** Facilitation: the workshop steps, what to ask, auto-checked progress, a shared timer and dot voting. */
export function WorkshopPanel({
  board,
  user,
  canEdit,
  voting,
  onVoting,
  onChange,
  onFocus,
}: {
  board: Board;
  user: string;
  canEdit: boolean;
  voting: boolean;
  onVoting: (on: boolean) => void;
  onChange: (b: Board) => void;
  onFocus: (ids: string[]) => void;
}) {
  const phase = phaseOf(board);
  const index = WORKSHOP_PHASES.indexOf(phase);
  const checks = phase.checks(board);
  const remaining = useRemaining(board.workshop?.timerEndsAt);
  const ranking = voteRanking(board);
  const left = votesLeft(board, user);
  const perPerson = board.workshop?.votesPerPerson ?? DEFAULT_VOTES;

  const setWorkshop = (patch: Partial<NonNullable<Board["workshop"]>>) => {
    const next = { ...(board.workshop ?? {}), phase: phase.id, ...patch };
    if (next.timerEndsAt === undefined) delete next.timerEndsAt;
    onChange({ ...board, workshop: next });
  };
  const goTo = (i: number) => {
    const p = WORKSHOP_PHASES[i];
    if (p) onChange({ ...board, workshop: { ...(board.workshop?.votesPerPerson ? { votesPerPerson: board.workshop.votesPerPerson } : {}), phase: p.id } });
  };

  return (
    <div className="stack workshop" style={{ gap: 10 }} data-tour="workshop-panel">
      <ol className="workshop-steps" aria-label="ワークショップの進め方">
        {WORKSHOP_PHASES.map((p, i) => (
          <li key={p.id}>
            <button className={`workshop-step${i === index ? " is-current" : i < index ? " is-done" : ""}`} aria-current={i === index ? "step" : undefined} disabled={!canEdit} onClick={() => goTo(i)} title={p.goal}>
              <span className="workshop-step-no">{i + 1}</span>
              {p.title}
            </button>
          </li>
        ))}
      </ol>

      <section className="stack" style={{ gap: 6 }}>
        <h4>
          {index + 1}. {phase.title} <span className="small muted">目安 {phase.minutes} 分</span>
        </h4>
        <p className="small">{phase.goal}</p>
        {phase.kinds.length > 0 && (
          <p className="small muted">
            使う付箋:{" "}
            {phase.kinds.map((k) => (
              <span key={k} className={`kind-pill sticky-${k}`}>
                {STICKY_KINDS[k].label}
              </span>
            ))}
          </p>
        )}
        <details className="small" open>
          <summary>進行役の問いかけ</summary>
          <ul>
            {phase.prompts.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-label="この段階のチェック">
        <ul className="assist-list">
          {checks.map((c) => (
            <li key={c.label}>
              <button className="assist-item" disabled={!c.itemIds.length} onClick={() => onFocus(c.itemIds)} title={c.itemIds.length ? "該当する付箋を表示" : undefined}>
                <span className={c.done ? "check-done" : "check-todo"} aria-label={c.done ? "できた" : "まだ"}>
                  {c.done ? "✓" : "○"}
                </span>
                <span>
                  {c.label}
                  {!c.done && c.itemIds.length > 0 && <span className="small muted">（{c.itemIds.length}件）</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="quiet small-button" disabled={!canEdit || index === 0} onClick={() => goTo(index - 1)}>
            前の段階
          </button>
          <button className={`small-button${checks.every((c) => c.done) ? " primary" : ""}`} disabled={!canEdit || index === WORKSHOP_PHASES.length - 1} onClick={() => goTo(index + 1)}>
            次の段階へ
          </button>
        </div>
      </section>

      <section className="stack" style={{ gap: 6 }} aria-label="タイマー">
        <h4>タイマー</h4>
        {remaining !== undefined ? (
          <div className="row">
            <span className={`workshop-timer${remaining === 0 ? " is-over" : ""}`} aria-live="polite">
              {remaining === 0 ? "時間です" : mmss(remaining)}
            </span>
            {canEdit && (
              <button className="quiet small-button" onClick={() => setWorkshop({ timerEndsAt: undefined })}>
                止める
              </button>
            )}
          </div>
        ) : (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {[phase.minutes, 5, 10].filter((m, i, a) => a.indexOf(m) === i).map((m) => (
              <button key={m} className="small-button" disabled={!canEdit} onClick={() => setWorkshop({ timerEndsAt: new Date(Date.now() + m * 60000).toISOString() })}>
                {m} 分
              </button>
            ))}
            <span className="small muted">ボードを開いている全員に同じ残り時間が表示されます</span>
          </div>
        )}
      </section>

      <section className="stack" style={{ gap: 6 }} aria-label="投票">
        <h4>投票</h4>
        <p className="small muted">話し合う順番を決めるため、気になる付箋（主にホットスポット）に1人 {perPerson} 票まで入れます。同じ付箋に何票入れても構いません。</p>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <button className={voting ? "primary small-button" : "small-button"} aria-pressed={voting} disabled={!canEdit} onClick={() => onVoting(!voting)} data-tour="vote-mode">
            {voting ? "投票を終える" : "投票する"}
          </button>
          <span className="small">残り {Math.max(0, left)} 票</span>
          <label className="small row" style={{ gap: 4 }}>
            1人
            <select value={perPerson} disabled={!canEdit} onChange={(e) => setWorkshop({ votesPerPerson: Number(e.target.value) })}>
              {[1, 2, 3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            票
          </label>
        </div>
        {voting && <p className="small workshop-hint">付箋をクリックすると1票、Shift+クリックで取り消し。</p>}
        {ranking.length > 0 && (
          <ol className="assist-list vote-ranking">
            {ranking.slice(0, 8).map(({ item, count }) => (
              <li key={item.id}>
                <button className="assist-item" onClick={() => onFocus([item.id])}>
                  <span className="vote-count">{count}</span>
                  <span>
                    {item.text || "無題"} <span className="small muted">{STICKY_KINDS[item.kind].label}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
