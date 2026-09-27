import { STICKY_KINDS, type BoardFrame, type BoardGhost, type BoardItem, type StickyKind } from "@ddd/core";
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
    <div className={`sticky sticky-${item.kind}${selected ? " is-selected" : ""}${data.highlighted ? " is-highlighted" : ""}`} title={`${meta.label}: ${meta.help}`}>
      <NodeResizer isVisible={selected} minWidth={80} minHeight={40} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      <div className="sticky-kind">
        <span aria-hidden>{STICKY_GLYPH[item.kind]}</span> {meta.label}
        {item.kind === "command" && item.creates && <span className="sticky-flag">作成</span>}
      </div>
      {data.editing ? (
        <InlineText value={item.text} multiline onCommit={(v) => data.onCommitText(item.id, v)} onCancel={data.onStopEditing} />
      ) : (
        <div className="sticky-text">{item.text || <span className="sticky-placeholder">ダブルクリックで入力</span>}</div>
      )}
      {item.codeName && <div className="sticky-code">{item.codeName}</div>}
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
            <span className="board-frame-label">コンテキスト</span> {frame.title || "無題（ダブルクリックで名前）"}
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

export const nodeTypes = { sticky: StickyNode, frame: FrameNode, ghost: GhostNode };
