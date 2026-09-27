import type { Analysis, Diagnostic, ModelIR } from "@ddd/core";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { buildGraph, KIND_GLYPH, KIND_LABEL, type GraphNode } from "../lib/outline.ts";

type DNode = Node<{ g: GraphNode; selected: boolean }, "domain">;

function DomainNode({ data }: NodeProps<DNode>) {
  const { g } = data;
  return (
    <div className={`dnode kind kind-${g.kind}${data.selected ? " selected" : ""}`}>
      <div className="dnode-head">
        <span className="glyph" aria-hidden>
          {KIND_GLYPH[g.kind]}
        </span>
        <span>{g.name}</span>
        {g.errors > 0 && <span className="sev-error small">✕{g.errors}</span>}
        <span className="dnode-kind">{KIND_LABEL[g.kind]}</span>
      </div>
      {g.lines.length > 0 && <div className="dnode-lines">{g.lines.slice(0, 12).join("\n") + (g.lines.length > 12 ? `\n… 他 ${g.lines.length - 12} 行` : "")}</div>}
      <HandleStub />
    </div>
  );
}

// React Flow needs handles for edges; hidden handles on left/right keep the node visually clean.
function HandleStub() {
  return (
    <>
      <Handle id="l" type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="r" type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="t" type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle id="b" type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
}

const nodeTypes = { domain: DomainNode };

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  uses: { stroke: "var(--k-usecase)" },
  emits: { stroke: "var(--k-event)", dash: "6 4" },
  holds: { stroke: "var(--k-value)" },
  references: { stroke: "var(--ink-faint)", dash: "2 4" },
  publishes: { stroke: "var(--k-event)" },
};

export function DiagramView({
  model,
  analysis,
  diagnostics,
  positions,
  canEdit,
  selectedId,
  onSelect,
  onMove,
}: {
  model: ModelIR;
  analysis?: Analysis;
  diagnostics: Diagnostic[];
  positions: Record<string, { x: number; y: number }>;
  canEdit: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  onMove: (id: string, p: { x: number; y: number }) => void;
}) {
  const graph = useMemo(() => buildGraph(model, analysis, positions, diagnostics), [model, analysis, positions, diagnostics]);
  const [nodes, setNodes] = useState<DNode[]>([]);

  useEffect(() => {
    setNodes(graph.nodes.map((g) => ({ id: g.id, type: "domain", position: { x: g.x, y: g.y }, data: { g, selected: g.id === selectedId }, draggable: canEdit })));
  }, [graph, selectedId, canEdit]);

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // Containment runs downwards (aggregate → value object below); flow edges run left to right.
    sourceHandle: e.kind === "holds" ? "b" : "r",
    targetHandle: e.kind === "holds" ? "t" : "l",
    label: e.label,
    style: { stroke: EDGE_STYLE[e.kind]!.stroke, strokeDasharray: EDGE_STYLE[e.kind]!.dash, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STYLE[e.kind]!.stroke },
  }));

  return (
    <div className="diagram" aria-label="モデルの図">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) =>
          setNodes((ns) =>
            ns.map((n) => {
              const c = changes.find((x) => "id" in x && x.id === n.id);
              if (c?.type === "position" && c.position) return { ...n, position: c.position };
              return n;
            }),
          )
        }
        onNodeDragStop={(_, n) => onMove(n.id, n.position)}
        onNodeClick={(_, n) => onSelect(n.id)}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
      >
        <Background gap={24} size={1} color="var(--line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="small muted" style={{ position: "absolute", right: 12, bottom: 8, background: "var(--paper)", padding: "2px 8px", borderRadius: 4 }}>
        <span className="kind kind-useCase">── 使う</span>　<span className="kind kind-event">- - 発生させる</span>　<span className="kind kind-valueObject">── 保持する</span>　<span className="muted">··· IDで参照</span>
        {canEdit && "　ドラッグで配置を変えられます（意味は変わりません）"}
      </div>
    </div>
  );
}
