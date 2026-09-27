import { useState } from "react";
import { KIND_GLYPH, KIND_LABEL, type OutlineNode } from "../lib/outline.ts";

export function Outline({ nodes, selected, onSelect }: { nodes: OutlineNode[]; selected?: string; onSelect: (n: OutlineNode) => void }) {
  return (
    <nav className="outline" aria-label="モデル要素" data-tour="outline">
      {nodes.length === 0 && <p className="outline-group">モデルを読み込めません。YAMLの構文エラーを直すと要素が表示されます。</p>}
      <ul role="tree">
        {nodes.map((n) => (
          <Item key={n.id} node={n} depth={0} selected={selected} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  );
}

function Item({ node, depth, selected, onSelect }: { node: OutlineNode; depth: number; selected?: string; onSelect: (n: OutlineNode) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={selected === node.id}>
      <button
        className={`outline-item kind kind-${node.kind}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        aria-current={selected === node.id}
        title={`${KIND_LABEL[node.kind]}: ${node.name}`}
        onClick={() => {
          onSelect(node);
          if (hasChildren && selected === node.id) setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" && hasChildren) setOpen(true);
          if (e.key === "ArrowLeft" && hasChildren) setOpen(false);
        }}
      >
        <span className="muted" aria-hidden style={{ width: "0.9em", display: "inline-block" }}>
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="glyph" aria-hidden>
          {KIND_GLYPH[node.kind]}
        </span>
        <span className="visually-hidden">{KIND_LABEL[node.kind]}</span>
        <span className="name">{node.name}</span>
        {node.errors > 0 && (
          <span className="count sev-error" aria-label={`エラー ${node.errors}件`}>
            ✕{node.errors}
          </span>
        )}
        {node.errors === 0 && node.warnings > 0 && (
          <span className="count sev-warning" aria-label={`警告 ${node.warnings}件`}>
            ▲{node.warnings}
          </span>
        )}
      </button>
      {hasChildren && open && (
        <ul role="group">
          {node.children.map((c) => (
            <Item key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}
