import type { EventFlowGraph, EventNode, SeqParticipantKind, SequenceDiagram } from "@ddd/core";
import { useMemo } from "react";
import { layoutEvents, layoutSequence, LINE } from "../lib/flowLayout.ts";

/** Participant colours: the discovery board's sticky palette where the part has one (actor, command, aggregate, policy). */
const HEAD: Record<SeqParticipantKind, string> = {
  person: "var(--st-actor)",
  server: "var(--st-rule)",
  security: "var(--st-rule)",
  app: "var(--st-command)",
  aggregate: "var(--st-aggregate)",
  db: "var(--st-note)",
  events: "var(--st-policy)",
  context: "var(--st-command)",
};

function Lines({ x, y, lines, anchor = "middle", className }: { x: number; y: number; lines: string[]; anchor?: "start" | "middle"; className?: string }) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={className}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : LINE}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

/** A use case or query as a sequence diagram: who takes part, the steps top to bottom, and where it stops. */
export function SequenceSvg({ diagram }: { diagram: SequenceDiagram }) {
  const l = useMemo(() => layoutSequence(diagram), [diagram]);
  const id = `seq-${diagram.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <svg className="flow-svg" width={l.width} height={l.height} viewBox={`0 0 ${l.width} ${l.height}`} role="img" aria-label={`シーケンス図: ${diagram.title}`}>
      <defs>
        <marker id={`${id}-solid`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="flow-head" />
        </marker>
        <marker id={`${id}-open`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10" className="flow-head-open" />
        </marker>
        <marker id={`${id}-x`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="9" markerHeight="9" orient="auto">
          <path d="M1,1 L9,9 M9,1 L1,9" className="flow-head-x" />
        </marker>
      </defs>
      {l.headers.map((h) => (
        <line key={`life-${h.p.id}`} x1={h.x} x2={h.x} y1={l.headerHeight + 6} y2={l.height - 8} className="flow-life" />
      ))}
      {l.shapes.map((s, i) => {
        if (s.kind === "frame") {
          return (
            <g key={i} className={`flow-frame flow-frame-${s.type}`}>
              <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} />
              <path d={`M${s.x},${s.y + 18} h34 l8,-8 v-10`} className="flow-frame-tab" />
              <text x={s.x + 6} y={s.y + 13} className="flow-frame-type">
                {s.type === "alt" ? "分岐" : "場合"}
              </text>
              <Lines x={s.x + 50} y={s.y + 13} lines={s.label} anchor="start" className="flow-frame-label" />
              {s.separators.map((sep, j) => (
                <g key={j}>
                  <line x1={s.x} x2={s.x + s.w} y1={sep.y - 2} y2={sep.y - 2} className="flow-frame-sep" />
                  <Lines x={s.x + 8} y={sep.y + 11} lines={sep.label} anchor="start" className="flow-frame-label" />
                </g>
              ))}
            </g>
          );
        }
        return null;
      })}
      {l.shapes.map((s, i) => {
        if (s.kind === "note") {
          return (
            <g key={i} className="flow-note">
              <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={3} />
              <Lines x={s.x + 8} y={s.y + 16} lines={s.lines} anchor="start" />
            </g>
          );
        }
        if (s.kind === "msg") {
          const self = s.x1 === s.x2;
          const marker = s.style === "fail" ? "x" : s.style === "call" ? "solid" : "open";
          const end = s.x2 + (self ? 0 : s.x2 > s.x1 ? -2 : 2);
          return (
            <g key={i} className={`flow-msg flow-msg-${s.style}`}>
              <Lines x={self ? s.x1 + 10 : s.textX} y={s.y - 6 - (s.lines.length - 1) * LINE} lines={s.lines} anchor={self ? "start" : "middle"} />
              {self ? (
                <path d={`M${s.x1},${s.y} h28 v14 h-26`} markerEnd={`url(#${id}-${marker})`} />
              ) : (
                <line x1={s.x1} x2={end} y1={s.y} y2={s.y} markerEnd={`url(#${id}-${marker})`} />
              )}
            </g>
          );
        }
        return null;
      })}
      {l.headers.map((h) => (
        <g key={h.p.id} className={`flow-head-box flow-kind-${h.p.kind}`}>
          <rect x={h.x - h.w / 2} y={8} width={h.w} height={l.headerHeight - 8} rx={h.p.kind === "person" ? 20 : h.p.kind === "db" ? 10 : 4} style={{ fill: HEAD[h.p.kind] }} />
          <text x={h.x} y={h.p.sub ? 28 : 36} textAnchor="middle" className="flow-head-label">
            {h.p.label}
          </text>
          {h.p.sub && (
            <text x={h.x} y={44} textAnchor="middle" className="flow-head-sub">
              {h.p.sub}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

const BOX: Record<EventNode["kind"], string> = { actor: "var(--st-actor)", use_case: "var(--st-command)", event: "var(--st-event)", policy: "var(--st-policy)" };
const KIND_JA: Record<EventNode["kind"], string> = { actor: "人", use_case: "Use case", event: "イベント", policy: "ポリシー" };

/** The event chain: who starts what, which events it publishes, which policies react and what they run. */
export function EventFlowSvg({ graph, onOpen }: { graph: EventFlowGraph; onOpen?: (n: EventNode) => void }) {
  const l = useMemo(() => layoutEvents(graph), [graph]);
  return (
    <svg className="flow-svg" width={l.width} height={l.height} viewBox={`0 0 ${l.width} ${l.height}`} role="img" aria-label="イベントのつながり">
      <defs>
        <marker id="evflow-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="flow-head" />
        </marker>
      </defs>
      {l.lines.map((e, i) => {
        const x1 = e.from.x + e.from.w;
        const y1 = e.from.y + e.from.h / 2;
        const x2 = e.to.x - 2;
        const y2 = e.to.y + e.to.h / 2;
        const back = x2 <= x1;
        const d = back ? `M${x1},${y1} C${x1 + 60},${y1 - 80} ${x2 - 60},${y2 - 80} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
        return (
          <g key={i} className={`flow-edge${e.dashed ? " is-dashed" : ""}`}>
            <path d={d} markerEnd="url(#evflow-head)" />
            {e.label && (
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="flow-edge-label">
                {e.label.length > 28 ? `${e.label.slice(0, 27)}…` : e.label}
                <title>{e.label}</title>
              </text>
            )}
          </g>
        );
      })}
      {l.boxes.map((b) => {
        const n = b.node;
        const clickable = !!onOpen && !!n.ref;
        let y = b.y + 18;
        return (
          <g
            key={n.id}
            className={`flow-node flow-node-${n.kind}${n.dangling ? " is-dangling" : ""}${clickable ? " is-clickable" : ""}`}
            onClick={clickable ? () => onOpen!(n) : undefined}
            onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen!(n)) : undefined}
            tabIndex={clickable ? 0 : undefined}
            role={clickable ? "button" : undefined}
            aria-label={clickable ? `${KIND_JA[n.kind]} ${n.label} を開く` : undefined}
          >
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={n.kind === "actor" ? 16 : 3} style={{ fill: BOX[n.kind] }} />
            {n.context && (
              <text x={b.x + 10} y={y} className="flow-node-ctx">
                {KIND_JA[n.kind]}・{n.context}
              </text>
            )}
            {(() => {
              if (n.context) y += LINE;
              const label = <Lines x={b.x + 10} y={y} lines={b.lines} anchor="start" className="flow-node-label" />;
              y += b.lines.length * LINE;
              return label;
            })()}
            {n.detail && n.detail !== n.label && (
              <text x={b.x + 10} y={y} className="flow-node-detail">
                {n.detail}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
