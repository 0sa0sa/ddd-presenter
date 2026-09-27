import { STICKY_KINDS, SUBDOMAIN_LABEL, type BoardFrame, type BoardGhost, type BoardItem, type BoardLane, type StickyKind } from "@ddd/core";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

export const STICKY_GLYPH: Record<StickyKind, string> = {
  event: "⚑",
  command: "▶",
  actor: "☺",
  policy: "↻",
  aggregate: "◆",
  read_model: "▤",
  external_system: "⧉",
  hotspot: "!",
  rule: "§",
  note: "✎",
};

export interface StickyData extends Record<string, unknown> {
  item: BoardItem;
  editing: boolean;
  highlighted: boolean;
  onCommitText: (id: string, text: string) => void;
  onStopEditing: () => void;
}

export interface FrameData extends Record<string, unknown> {
  frame: BoardFrame;
  editing: boolean;
  highlighted: boolean;
  onCommitTitle: (id: string, title: string) => void;
  onStopEditing: () => void;
}

export type StickyNodeType = Node<StickyData, "sticky">;
export type FrameNodeType = Node<FrameData, "frame">;

export interface LaneData extends Record<string, unknown> {
  lane: BoardLane;
  editing: boolean;
  onCommitTitle: (id: string, title: string) => void;
  onStopEditing: () => void;
}
export type LaneNodeType = Node<LaneData, "lane">;
export type PivotNodeType = Node<{ label: string }, "pivot">;

export interface GhostData extends Record<string, unknown> {
  ghost: BoardGhost;
  first: boolean;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}
export type GhostNodeType = Node<GhostData, "ghost">;

function InlineText({ value, onCommit, onCancel, multiline }: { value: string; onCommit: (v: string) => void; onCancel: () => void; multiline: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="nodrag nowheel board-inline"
      aria-label="テキスト"
      value={draft}
      rows={multiline ? 3 : 1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit(draft);
        }
      }}
    />
  );
}

const HANDLES = (
  <>
    <Handle type="target" position={Position.Left} className="board-handle" />
    <Handle type="source" position={Position.Right} className="board-handle" />
    <Handle id="t" type="target" position={Position.Top} className="board-handle" />
    <Handle id="b" type="source" position={Position.Bottom} className="board-handle" />
  </>
);

export function StickyNode({ data, selected }: NodeProps<StickyNodeType>) {
  const { item } = data;
  const meta = STICKY_KINDS[item.kind];
  return (
    <div
      className={`sticky sticky-${item.kind}${selected ? " is-selected" : ""}${data.highlighted ? " is-highlighted" : ""}${item.pivotal ? " is-pivotal" : ""}${item.resolved ? " is-resolved" : ""}`}
      title={`${meta.label}: ${meta.help}${item.resolution ? `\n結論: ${item.resolution}` : ""}`}
    >
      <NodeResizer isVisible={selected} minWidth={80} minHeight={40} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      <div className="sticky-kind">
        <span aria-hidden>{STICKY_GLYPH[item.kind]}</span> {meta.label}
        {item.kind === "command" && item.creates && <span className="sticky-flag">作成</span>}
        {item.pivotal && <span className="sticky-flag">節目</span>}
        {item.resolved && <span className="sticky-flag">✓ 解決</span>}
      </div>
      {data.editing ? (
        <InlineText value={item.text} multiline onCommit={(v) => data.onCommitText(item.id, v)} onCancel={data.onStopEditing} />
      ) : (
        <div className="sticky-text">{item.text || <span className="sticky-placeholder">ダブルクリックで入力</span>}</div>
      )}
      {item.codeName && <div className="sticky-code">{item.codeName}</div>}
      {(item.votes?.length || item.comments?.length) && (
        <div className="sticky-meta" aria-label={`投票 ${item.votes?.length ?? 0}・コメント ${item.comments?.length ?? 0}`}>
          {item.votes?.length ? <span className="sticky-votes">{"●".repeat(Math.min(item.votes.length, 6))}{item.votes.length > 6 ? ` ${item.votes.length}` : ""}</span> : null}
          {item.comments?.length ? <span className="sticky-comments">💬 {item.comments.length}</span> : null}
        </div>
      )}
      {HANDLES}
    </div>
  );
}

export function FrameNode({ data, selected }: NodeProps<FrameNodeType>) {
  const { frame } = data;
  return (
    <div className={`board-frame${selected ? " is-selected" : ""}${data.highlighted ? " is-highlighted" : ""}`}>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      <div className="board-frame-title">
        {data.editing ? (
          <InlineText value={frame.title} multiline={false} onCommit={(v) => data.onCommitTitle(frame.id, v)} onCancel={data.onStopEditing} />
        ) : (
          <>
            <span className="board-frame-label">コンテキスト</span>
            {frame.subdomain && (
              <span className={`subdomain-badge subdomain-${frame.subdomain}`} title={SUBDOMAIN_LABEL[frame.subdomain].help}>
                {SUBDOMAIN_LABEL[frame.subdomain].label}
              </span>
            )}{" "}
            {frame.title || "無題（ダブルクリックで名前）"}
            {frame.codeName && <span className="sticky-code"> {frame.codeName}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** A predicted sticky: click (or Tab for the first one) to add it, × to dismiss. */
export function GhostNode({ data }: NodeProps<GhostNodeType>) {
  const { ghost } = data;
  const meta = STICKY_KINDS[ghost.kind];
  return (
    <div className={`sticky sticky-${ghost.kind} sticky-ghost sticky-ghost-${ghost.source}`} title={`${ghost.reason}（クリックで追加）`}>
      <button
        className="nodrag sticky-ghost-body"
        onClick={(e) => {
          e.stopPropagation();
          data.onAccept(ghost.id);
        }}
        aria-label={`提案「${ghost.text}」を追加`}
      >
        <span className="sticky-kind">
          <span aria-hidden>{STICKY_GLYPH[ghost.kind]}</span> {meta.label}
          <span className="sticky-flag">{ghost.source === "llm" ? "AI" : "予測"}</span>
        </span>
        <span className="sticky-text">{ghost.text}</span>
        <span className="sticky-ghost-hint">{data.first ? "Tab またはクリックで追加" : "クリックで追加"}</span>
      </button>
      <button
        className="nodrag sticky-ghost-dismiss"
        aria-label="この提案を消す"
        title="この提案を消す"
        onClick={(e) => {
          e.stopPropagation();
          data.onDismiss(ghost.id);
        }}
      >
        ×
      </button>
      <Handle type="target" position={Position.Left} className="board-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="board-handle" isConnectable={false} />
    </div>
  );
}

/** A horizontal swimlane behind the stickies; only its vertical position and height matter. */
export function LaneNode({ data, selected }: NodeProps<LaneNodeType>) {
  const { lane } = data;
  return (
    <div className={`board-lane${selected ? " is-selected" : ""}`}>
      <NodeResizer isVisible={selected} minWidth={400} minHeight={60} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      <div className="board-lane-title">
        {data.editing ? <InlineText value={lane.title} multiline={false} onCommit={(v) => data.onCommitTitle(lane.id, v)} onCancel={data.onStopEditing} /> : lane.title || "レーン（ダブルクリックで名前）"}
      </div>
    </div>
  );
}

/** Vertical line through a pivotal event: the timeline's turning points. */
export function PivotNode({ data }: NodeProps<PivotNodeType>) {
  return (
    <div className="board-pivot" title={`節目: ${data.label}`}>
      <span>{data.label}</span>
    </div>
  );
}

export const nodeTypes = { sticky: StickyNode, frame: FrameNode, ghost: GhostNode, lane: LaneNode, pivot: PivotNode };
