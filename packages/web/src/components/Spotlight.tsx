import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TourDemo, TourStop } from "../lib/tour.ts";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;

function findTarget(target: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)];
  // Prefer a visible element (some targets exist in several places).
  return all.find((el) => el.getClientRects().length > 0) ?? null;
}

/** Tiny animated illustrations of gestures that are hard to describe in words. */
function Demo({ kind }: { kind: TourDemo }) {
  if (kind === "drag-arrow") {
    return (
      <svg className="demo" viewBox="0 0 240 90" role="img" aria-label="付箋の端の丸から、もう一枚の付箋までドラッグすると矢印が引かれる">
        <rect x="8" y="24" width="70" height="44" rx="3" className="demo-cmd" />
        <text x="43" y="50" className="demo-text">コマンド</text>
        <rect x="160" y="24" width="70" height="44" rx="3" className="demo-evt" />
        <text x="195" y="50" className="demo-text">イベント</text>
        <circle cx="78" cy="46" r="5" className="demo-handle" />
        <line x1="78" y1="46" x2="160" y2="46" className="demo-line" />
        <g className="demo-cursor-drag">
          <path d="M0 0 L0 14 L4 10 L7 17 L9 16 L6 9 L11 9 Z" className="demo-cursor" />
        </g>
      </svg>
    );
  }
  if (kind === "double-click") {
    return (
      <svg className="demo" viewBox="0 0 240 90" role="img" aria-label="付箋やキャンバスをダブルクリックすると編集・追加できる">
        <rect x="80" y="18" width="90" height="54" rx="3" className="demo-evt demo-pop" />
        <text x="125" y="49" className="demo-text">招待が送られた</text>
        <circle cx="125" cy="45" r="16" className="demo-ripple" />
        <circle cx="125" cy="45" r="16" className="demo-ripple demo-ripple-2" />
        <path d="M0 0 L0 14 L4 10 L7 17 L9 16 L6 9 L11 9 Z" className="demo-cursor" transform="translate(128 48)" />
      </svg>
    );
  }
  if (kind === "range-select") {
    return (
      <svg className="demo" viewBox="0 0 240 90" role="img" aria-label="空いている所から斜めにドラッグすると範囲の中の付箋が選ばれる">
        <rect x="40" y="26" width="46" height="30" rx="2" className="demo-cmd" />
        <rect x="100" y="36" width="46" height="30" rx="2" className="demo-evt" />
        <rect x="160" y="26" width="46" height="30" rx="2" className="demo-agg" />
        <rect x="30" y="16" width="130" height="60" className="demo-select" />
        <path d="M0 0 L0 14 L4 10 L7 17 L9 16 L6 9 L11 9 Z" className="demo-cursor demo-cursor-select" />
      </svg>
    );
  }
  return (
    <div className="demo demo-complete" aria-label="Ctrl+Space で候補が出る">
      <code>
        status == <span className="demo-caret" />
      </code>
      <ul>
        <li className="is-active">pending</li>
        <li>accepted</li>
        <li>revoked</li>
      </ul>
      <span className="small muted">Ctrl+Space</span>
    </div>
  );
}

export function Spotlight({
  stops,
  index,
  onIndex,
  onClose,
  onOpenTab,
}: {
  stops: TourStop[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onOpenTab: (tab: NonNullable<TourStop["tab"]>) => void;
}) {
  const stop = stops[index]!;
  const [rect, setRect] = useState<Rect>();
  const bubble = useRef<HTMLDivElement>(null);
  const [bubblePos, setBubblePos] = useState<{ top: number; left: number }>({ top: 80, left: 80 });
  const last = index === stops.length - 1;

  // Open the tab this stop lives on.
  useEffect(() => {
    if (stop.tab) onOpenTab(stop.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Follow the target as the layout changes (tabs, dialogs, scrolling, canvas panning).
  useEffect(() => {
    let scrolled = false;
    const tick = () => {
      const el = findTarget(stop.target);
      if (!el) {
        setRect(undefined);
        return;
      }
      if (!scrolled) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        scrolled = true;
      }
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.left - r.left) < 1 && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    tick();
    const t = setInterval(tick, 200);
    window.addEventListener("resize", tick);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", tick);
    };
  }, [stop.target, index]);

  // Advance when the learner performs the highlighted action.
  useEffect(() => {
    if (!stop.advanceOnClick) return;
    const onClick = (e: MouseEvent) => {
      const el = findTarget(stop.target);
      if (el && e.target instanceof Node && el.contains(e.target)) {
        setTimeout(() => (last ? onClose() : onIndex(index + 1)), 350);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [stop, index, last, onIndex, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable=true], .cm-editor");
      if (e.key === "Escape") onClose();
      if (typing) return;
      if (e.key === "ArrowRight" && !last) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, last, onIndex, onClose]);

  // Place the bubble next to the target, inside the viewport.
  useLayoutEffect(() => {
    const b = bubble.current;
    if (!b) return;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) {
      setBubblePos({ top: Math.max(16, vh / 2 - bh / 2), left: Math.max(16, vw / 2 - bw / 2) });
      return;
    }
    const gap = 14;
    const candidates = [
      { top: rect.top + rect.height + gap, left: rect.left }, // below
      { top: rect.top - bh - gap, left: rect.left }, // above
      { top: rect.top, left: rect.left + rect.width + gap }, // right
      { top: rect.top, left: rect.left - bw - gap }, // left
    ];
    const fits = (p: { top: number; left: number }) => p.top >= 8 && p.left >= 8 && p.top + bh <= vh - 8 && p.left + bw <= vw - 8;
    // Large targets (the canvas, the editor): put the bubble inside, near the top-left.
    const big = rect.width > vw * 0.45 && rect.height > vh * 0.45;
    const pos = big ? { top: rect.top + 24, left: rect.left + 24 } : (candidates.find(fits) ?? candidates[0]!);
    setBubblePos({ top: Math.min(Math.max(8, pos.top), vh - bh - 8), left: Math.min(Math.max(8, pos.left), vw - bw - 8) });
  }, [rect, index]);

  const big = rect && rect.width > window.innerWidth * 0.45 && rect.height > window.innerHeight * 0.45;

  return (
    <div className="spotlight" role="dialog" aria-modal="false" aria-labelledby="spotlight-title">
      {rect ? (
        <div
          className={`spotlight-hole${big ? " is-big" : ""}`}
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
          aria-hidden
        />
      ) : (
        <div className="spotlight-dim" aria-hidden />
      )}
      <div ref={bubble} className="spotlight-bubble" style={{ top: bubblePos.top, left: bubblePos.left }}>
        <div className="row small muted">
          <span>
            操作ガイド {index + 1} / {stops.length}
          </span>
          <div className="spacer" />
          <button className="quiet small-button" onClick={onClose} aria-label="操作ガイドを閉じる">
            ✕
          </button>
        </div>
        <h3 id="spotlight-title">{stop.title}</h3>
        <p className="small">{rect || !stop.whenMissing ? stop.body : stop.whenMissing}</p>
        {stop.demo && <Demo kind={stop.demo} />}
        {stop.advanceOnClick && rect && <p className="small spotlight-do">▶ 光っている所を押すと次へ進みます</p>}
        <div className="row">
          <button className="quiet small-button" onClick={() => onIndex(index - 1)} disabled={index === 0}>
            戻る
          </button>
          <div className="spacer" />
          <button className="primary small-button" onClick={() => (last ? onClose() : onIndex(index + 1))}>
            {last ? "閉じて試す" : "次へ"}
          </button>
        </div>
      </div>
    </div>
  );
}
