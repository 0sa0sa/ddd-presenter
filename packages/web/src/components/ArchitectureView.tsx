import {
  ARCH_FILL,
  architectureToDrawio,
  architectureToMermaid,
  architectureToSvg,
  architectureView,
  archNodeSize,
  deriveArchitecture,
  placeArchitecture,
  RATE_LIMIT_KEYS,
  RATE_LIMIT_UNITS,
  RELATIONSHIP_PATTERNS,
  SUBDOMAIN_KINDS,
  SUBDOMAIN_LABEL,
  type Analysis,
  type ArchElement,
  type ArchKind,
  type ArchLevel,
  type ArchRelation,
  type ArchView,
  type Diagnostic,
  type ModelIR,
  type Path,
  type Point,
  type RateLimitKey,
  type RateLimitUnit,
  type RelationshipPattern,
  type SubdomainKind,
} from "@ddd/core";
import { Background, ConnectionMode, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, describeError } from "../api.ts";
import {
  addContext,
  addExternalSystem,
  addRelationship,
  addSecurity,
  generatedFilesFor,
  OpHistory,
  PATTERN_JA,
  removeRelationship,
  setDefaultRateLimit,
  setHttpApi,
  setRls,
  setSubdomain,
  setTarget,
  updateRelationship,
  upstreamEvents,
  type OpResult,
  type RelationshipDraft,
} from "../lib/architectureOps.ts";
import { copyText, downloadBlob, downloadSvgAsPng, safeFileName } from "../lib/download.ts";

const KIND_JA: Record<ArchKind, string> = {
  person: "利用者",
  role: "プラットフォームロール",
  context: "コンテキスト",
  external: "外部システム",
  container: "コンテナ",
  database: "データベース",
  idp: "ID プロバイダ",
  aggregate: "集約",
  use_case: "ユースケース",
  query: "クエリ",
  policy: "ポリシー",
  port: "ポート",
  adapter: "アダプタ",
};

type Layouts = Record<string, { version: number; positions: Record<string, Point> }>;
type ANode = Node<{ e: ArchElement; connectable: boolean; drillable: boolean; onDrill: (id: string) => void }, "arch">;

function ArchNode({ data, selected }: NodeProps<ANode>) {
  const { e, connectable } = data;
  const size = archNodeSize(e);
  const c = ARCH_FILL[e.kind];
  const handle = (id: string, position: Position) => (
    <Handle key={id} id={id} type="source" position={position} isConnectable={connectable} className={connectable ? "anode-handle" : "anode-handle hidden"} />
  );
  return (
    <div
      className={`anode anode-${e.kind}${selected ? " selected" : ""}`}
      style={{ width: size.w, height: size.h, background: c.fill, color: c.text, borderColor: c.stroke }}
      onDoubleClick={() => data.drillable && data.onDrill(e.id)}
      title={[e.label, e.technology && `[${e.technology}]`, e.description, data.drillable ? "ダブルクリックで中身を表示" : ""].filter(Boolean).join("\n")}
    >
      <div className="anode-label">{e.label}</div>
      {e.technology && <div className="anode-tech">[{e.technology}]</div>}
      {e.description && <div className="anode-desc">{e.description}</div>}
      {e.badges.length > 0 && (
        <div className="anode-badges">
          {e.badges.map((b) => (
            <span key={b} className="anode-badge">
              {b}
            </span>
          ))}
        </div>
      )}
      {handle("t", Position.Top)}
      {handle("b", Position.Bottom)}
      {handle("l", Position.Left)}
      {handle("r", Position.Right)}
    </div>
  );
}

const nodeTypes = { arch: ArchNode };

/** Handles facing each other: vertical sides when the boxes are stacked, horizontal sides otherwise. */
function handlesFor(a: Point & { w: number; h: number }, b: Point & { w: number; h: number }): [string, string] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dy) * 1.4 >= Math.abs(dx)) return dy >= 0 ? ["b", "t"] : ["t", "b"];
  return dx >= 0 ? ["r", "l"] : ["l", "r"];
}

const levelLabel = (level: ArchLevel) => (level === "system" ? "システム全体" : level === "containers" ? "コンテナ" : `コンテキストの中身: ${level.slice("context:".length)}`);

type Selection = { type: "node"; id: string } | { type: "edge"; id: string } | undefined;
type Dialog = "context" | "settings" | "external" | "relationship" | undefined;

export function ArchitectureView({
  projectId,
  model,
  analysis,
  text,
  canEdit,
  savedVersion,
  onApply,
  onGoto,
  onOpenFile,
  onStatus,
}: {
  projectId: string;
  model: ModelIR;
  analysis?: Analysis;
  text: string;
  canEdit: boolean;
  savedVersion: number;
  onApply: (text: string, message: string) => void;
  onGoto: (path: Path) => void;
  onOpenFile: (path: string) => void;
  onStatus: (message: string) => void;
}) {
  const arch = useMemo(() => deriveArchitecture(model, analysis, { lang: "ja" }), [model, analysis]);
  const [level, setLevel] = useState<ArchLevel>(() => {
    try {
      return (sessionStorage.getItem(`ddd.arch.level.${projectId}`) as ArchLevel | null) ?? "system";
    } catch {
      return "system";
    }
  });
  const view: ArchView = architectureView(arch, level) ?? arch.system;
  useEffect(() => {
    try {
      sessionStorage.setItem(`ddd.arch.level.${projectId}`, view.level);
    } catch {
      // Private mode: the level is not remembered.
    }
  }, [projectId, view.level]);

  const [layouts, setLayouts] = useState<Layouts>({});
  const layoutsRef = useRef<Layouts>({});
  layoutsRef.current = layouts;
  useEffect(() => {
    api.architectureLayout(projectId).then(
      (r) => setLayouts(r.levels),
      (e) => onStatus(`アーキテクチャ図の配置を読み込めませんでした: ${describeError(e)}`),
    );
  }, [projectId, onStatus]);

  const positions = useMemo(() => placeArchitecture(view, layouts[view.level]?.positions ?? {}), [view, layouts]);
  const [selection, setSelection] = useState<Selection>();
  const selectedNode = selection?.type === "node" ? view.elements.find((e) => e.id === selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? view.relations.find((r) => r.id === selection.id) : undefined;
  useEffect(() => setSelection(undefined), [view.level]);

  // --- nodes and edges -------------------------------------------------------------------
  const flow = useRef<ReactFlowInstance<ANode> | undefined>(undefined);
  // A new element (e.g. an added context) may land outside the visible area: refit when the view gains elements.
  const elementCount = useRef<{ level: string; n: number }>({ level: "", n: 0 });
  useEffect(() => {
    const prev = elementCount.current;
    elementCount.current = { level: view.level, n: view.elements.length };
    if (prev.level === view.level && view.elements.length > prev.n) setTimeout(() => void flow.current?.fitView({ padding: 0.15, duration: 250 }), 60);
  }, [view.level, view.elements.length]);
  /** Double-click handler of the nodes (the node component calls it; React Flow's node double-click is unreliable after a selection re-render). */
  const drillRef = useRef<(id: string) => void>(() => undefined);
  const [nodes, setNodes] = useState<ANode[]>([]);
  const connectableLevel = canEdit && view.level === "system";
  useEffect(() => {
    // Existing nodes are updated in place: a fresh node object loses React Flow's measurements and is hidden until it
    // is measured again (a double-click would then land on the pane).
    setNodes((prev) =>
      view.elements.map((e) => {
        const size = archNodeSize(e);
        const old = prev.find((n) => n.id === e.id);
        return {
          ...old,
          id: e.id,
          type: "arch" as const,
          position: positions[e.id]!,
          width: size.w,
          height: size.h,
          data: { e, connectable: connectableLevel && e.kind === "context", drillable: !!e.drill && e.drill !== view.level, onDrill: (nid: string) => drillRef.current(nid) },
          draggable: canEdit,
          selected: selection?.type === "node" && selection.id === e.id,
          ariaLabel: `${KIND_JA[e.kind]} ${e.label}`,
        };
      }),
    );
  }, [view, positions, canEdit, connectableLevel, selection]);

  const boxOf = useCallback(
    (id: string) => {
      const e = view.elements.find((x) => x.id === id)!;
      const n = nodes.find((x) => x.id === id);
      return { ...(n?.position ?? positions[id]!), ...archNodeSize(e) };
    },
    [view, nodes, positions],
  );
  const dense = view.level.startsWith("context:");
  const edges: Edge[] = useMemo(
    () =>
      view.relations
        .filter((r) => positions[r.source] && positions[r.target])
        .map((r) => {
          const [sh, th] = handlesFor(boxOf(r.source), boxOf(r.target));
          const focus = selection?.type === "node" && (selection.id === r.source || selection.id === r.target);
          const chosen = selection?.type === "edge" && selection.id === r.id;
          // Component views have many lines: labels only for the selected element's relations.
          const showLabel = !dense || focus || chosen;
          const stroke = chosen ? "var(--focus)" : focus ? "var(--ink)" : "var(--ink-faint)";
          return {
            id: r.id,
            source: r.source,
            target: r.target,
            sourceHandle: sh,
            targetHandle: th,
            label: showLabel ? (r.technology ? `${r.label} [${r.technology}]` : r.label) : undefined,
            style: { stroke, strokeDasharray: r.dashed ? "6 4" : undefined, strokeWidth: chosen || focus ? 2 : 1.3 },
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
            selected: chosen,
            focusable: true,
            ariaLabel: `${r.label}`,
          } satisfies Edge;
        }),
    [view, positions, boxOf, selection, dense],
  );

  // --- layout persistence (debounced, optimistic concurrency, conflict → retry with ours on top) ---
  // One timer per level: arranging another level within the debounce must not cancel this level's save.
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const persist = useCallback(
    (lvl: string, next: Record<string, Point>) => {
      setLayouts((l) => ({ ...l, [lvl]: { version: l[lvl]?.version ?? 0, positions: next } }));
      clearTimeout(saveTimers.current.get(lvl));
      saveTimers.current.set(lvl, setTimeout(async () => {
        saveTimers.current.delete(lvl);
        const attempt = async (base: number, retry: boolean): Promise<void> => {
          try {
            const r = await api.saveArchitectureLayout(projectId, lvl, next, base);
            setLayouts((l) => ({ ...l, [lvl]: { version: r.version, positions: l[lvl]?.positions ?? r.positions } }));
          } catch (e) {
            if (e instanceof ApiError && e.status === 409 && retry) {
              // Someone else arranged this level: keep their positions for nodes we did not place, ours win for the rest.
              const theirs = (e.body.positions ?? {}) as Record<string, Point>;
              const merged = { ...theirs, ...next };
              setLayouts((l) => ({ ...l, [lvl]: { version: Number(e.body.current_version), positions: merged } }));
              next = merged;
              return attempt(Number(e.body.current_version), false);
            }
            onStatus(`アーキテクチャ図の配置を保存できませんでした: ${describeError(e)}`);
          }
        };
        await attempt(layoutsRef.current[lvl]?.version ?? 0, true);
      }, 400));
    },
    [projectId, onStatus],
  );

  const onDragStop = (id: string, p: Point) => {
    const all: Record<string, Point> = {};
    for (const n of nodes) all[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    all[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    persist(view.level, all);
  };

  // --- operations --------------------------------------------------------------------------
  const history = useRef(new OpHistory());
  const [, bump] = useState(0);
  const [opError, setOpError] = useState<{ error: string; diagnostics: Diagnostic[] }>();
  const [dialog, setDialog] = useState<Dialog>();
  const [relDraft, setRelDraft] = useState<RelationshipDraft & { index?: number }>();
  const run = (label: string, r: OpResult): boolean => {
    if (!r.ok) {
      setOpError({ error: r.error, diagnostics: r.diagnostics });
      return false;
    }
    setOpError(undefined);
    history.current.push(text, r.text, label);
    bump((n) => n + 1);
    onApply(r.text, `${label}（未保存。保存すると確定します）`);
    return true;
  };
  const undo = () => {
    const r = history.current.undo(text);
    bump((n) => n + 1);
    if (!r) return;
    if ("error" in r) return setOpError({ error: r.error, diagnostics: [] });
    setOpError(undefined);
    onApply(r.text, `「${r.label}」を元に戻しました`);
  };

  const drill = (e: ArchElement | undefined) => {
    if (e?.drill && e.drill !== view.level && architectureView(arch, e.drill)) setLevel(e.drill);
  };
  drillRef.current = (nid: string) => drill(view.elements.find((e) => e.id === nid));

  const onConnect = (c: Connection) => {
    if (!canEdit || view.level !== "system" || !c.source || !c.target) return;
    const up = view.elements.find((e) => e.id === c.source);
    const down = view.elements.find((e) => e.id === c.target);
    if (up?.kind !== "context" || down?.kind !== "context" || up.id === down.id) return;
    setRelDraft({ upstream: up.label, downstream: down.label, pattern: "customer_supplier", events: [] });
    setOpError(undefined);
    setDialog("relationship");
  };

  // --- exports -----------------------------------------------------------------------------
  const exportAs = async (format: "svg" | "png" | "drawio" | "mermaid" | "copy") => {
    const current: Record<string, Point> = {};
    for (const n of nodes) current[n.id] = n.position;
    const title = view.title;
    const name = `${safeFileName(`${model.project}-${view.level.replace(":", "-")}`)}`;
    if (format === "copy") return onStatus((await copyText(architectureToMermaid(view))) ? "Mermaid をクリップボードにコピーしました" : "コピーできませんでした");
    if (format === "mermaid") return downloadBlob(new Blob([architectureToMermaid(view)], { type: "text/plain" }), `${name}.mmd`);
    if (format === "drawio") return downloadBlob(new Blob([architectureToDrawio(view, current, title)], { type: "application/xml" }), `${name}.drawio`);
    const svg = architectureToSvg(view, current, title);
    if (format === "svg") return downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
    downloadSvgAsPng(svg, `${name}.png`);
  };

  // --- generated files (from the saved version's preview) -----------------------------------
  const [files, setFiles] = useState<{ version: number; paths: string[] }>();
  useEffect(() => {
    if (!selectedNode?.code?.length || files?.version === savedVersion) return;
    api.preview(projectId, savedVersion).then(
      (p) => setFiles({ version: savedVersion, paths: p.files.map((f) => f.path) }),
      () => setFiles({ version: savedVersion, paths: [] }),
    );
  }, [selectedNode, files, savedVersion, projectId]);

  const contexts = model.contexts.map((c) => c.name);
  const relIndex = (r: ArchRelation | undefined) => (r?.path?.[0] === "relationships" && typeof r.path[1] === "number" ? r.path[1] : undefined);

  return (
    <div className="board arch">
      <div className="board-toolbar" role="toolbar" aria-label="アーキテクチャ図の操作">
        <div className="segmented" role="group" aria-label="表示するレベル">
          <button aria-pressed={view.level === "system"} onClick={() => setLevel("system")}>
            システム全体
          </button>
          <button aria-pressed={view.level === "containers"} onClick={() => setLevel("containers")}>
            コンテナ
          </button>
          <select
            aria-label="コンテキストの中身"
            value={view.level.startsWith("context:") ? view.level : ""}
            onChange={(e) => e.target.value && setLevel(e.target.value as ArchLevel)}
          >
            <option value="">コンテキストの中身…</option>
            {arch.contexts.map((v) => (
              <option key={v.level} value={v.level}>
                {v.level.slice("context:".length)}
              </option>
            ))}
          </select>
        </div>
        <span className="toolbar-sep" aria-hidden />
        {canEdit && (
          <>
            <button className="quiet" onClick={() => (setOpError(undefined), setDialog("context"))}>
              ＋ コンテキスト
            </button>
            <button className="quiet" onClick={() => (setOpError(undefined), setDialog("external"))}>
              ＋ 外部システム
            </button>
            <button className="quiet" onClick={() => (setOpError(undefined), setDialog("settings"))}>
              生成・セキュリティ設定
            </button>
            <button className="quiet" disabled={!history.current.size} onClick={undo} title={history.current.peek() ? `「${history.current.peek()}」を元に戻す` : "元に戻す操作はありません"}>
              ↶ 元に戻す
            </button>
            <button className="quiet" disabled={!layouts[view.level]?.positions || !Object.keys(layouts[view.level]!.positions).length} onClick={() => persist(view.level, {})} title="このレベルの手動配置を消して自動配置に戻します">
              自動配置
            </button>
          </>
        )}
        <span className="spacer" />
        <details className="export-menu">
          <summary className="quiet">書き出し</summary>
          <div className="export-menu-body">
            <button className="quiet" onClick={() => void exportAs("svg")}>
              SVG（このレベル）
            </button>
            <button className="quiet" onClick={() => void exportAs("png")}>
              PNG（このレベル）
            </button>
            <button className="quiet" onClick={() => void exportAs("drawio")}>
              draw.io（.drawio。draw.io で編集できる）
            </button>
            <button className="quiet" onClick={() => void exportAs("mermaid")}>
              Mermaid（.mmd）
            </button>
            <button className="quiet" onClick={() => void exportAs("copy")}>
              Mermaid をコピー
            </button>
          </div>
        </details>
      </div>
      <nav className="arch-crumbs small" aria-label="レベル">
        <button className="linklike" onClick={() => setLevel("system")} aria-current={view.level === "system" ? "page" : undefined}>
          システム全体
        </button>
        {view.level !== "system" && (
          <>
            <span aria-hidden>›</span>
            <button className="linklike" onClick={() => setLevel("containers")} aria-current={view.level === "containers" ? "page" : undefined}>
              コンテナ
            </button>
          </>
        )}
        {view.level.startsWith("context:") && (
          <>
            <span aria-hidden>›</span>
            <strong aria-current="page">{view.level.slice("context:".length)}</strong>
          </>
        )}
        <span className="muted">— {view.description}</span>
      </nav>
      <div className="board-body">
        <div
          className="diagram arch-canvas"
          aria-label={`アーキテクチャ図: ${levelLabel(view.level)}`}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && selectedNode?.drill) drill(selectedNode);
            if (ev.key === "Escape") setSelection(undefined);
          }}
        >
          <ReactFlow
            key={view.level}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            connectionMode={ConnectionMode.Loose}
            nodesConnectable={connectableLevel}
            onConnect={onConnect}
            onNodesChange={(changes) =>
              setNodes((ns) =>
                ns.map((n) => {
                  const c = changes.find((x) => "id" in x && x.id === n.id);
                  if (c?.type === "position" && c.position) return { ...n, position: c.position };
                  return n;
                }),
              )
            }
            onNodeDragStop={(_, n) => onDragStop(n.id, n.position)}
            onNodeClick={(_, n) => setSelection((s) => (s?.type === "node" && s.id === n.id ? s : { type: "node", id: n.id }))}
            onEdgeClick={(_, e) => setSelection((s) => (s?.type === "edge" && s.id === e.id ? s : { type: "edge", id: e.id }))}
            onSelectionChange={({ nodes: ns, edges: es }) => {
              if (ns[0]) setSelection((s) => (s?.type === "node" && s.id === ns[0]!.id ? s : { type: "node", id: ns[0]!.id }));
              else if (es[0]) setSelection((s) => (s?.type === "edge" && s.id === es[0]!.id ? s : { type: "edge", id: es[0]!.id }));
            }}
            onPaneClick={() => setSelection(undefined)}
            zoomOnDoubleClick={false}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.15}
            proOptions={{ hideAttribution: true }}
            onInit={(instance) => {
              flow.current = instance;
            }}
          >
            <Background gap={24} size={1} color="var(--line)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="arch-panel" aria-label="選択した要素">
          {opError && (
            <div className="error-banner" role="alert">
              <strong>{opError.error}</strong>
              {opError.diagnostics.length > 0 && (
                <ul className="small">
                  {opError.diagnostics.map((d, i) => (
                    <li key={i}>
                      {d.element && <strong>{d.element}: </strong>}
                      {d.message}
                      {d.hint && <span className="muted"> — {d.hint}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <button className="quiet small-button" onClick={() => setOpError(undefined)}>
                閉じる
              </button>
            </div>
          )}
          {selectedNode ? (
            <ElementPanel
              e={selectedNode}
              view={view}
              model={model}
              canEdit={canEdit}
              files={files?.version === savedVersion ? generatedFilesFor(selectedNode.code, files.paths) : undefined}
              savedVersion={savedVersion}
              onDrill={() => drill(selectedNode)}
              onGoto={onGoto}
              onOpenFile={onOpenFile}
              onSubdomain={(s) => run(`${selectedNode.label} のサブドメインを変更`, setSubdomain(text, model, selectedNode.label, s))}
              onConnect={(down) => {
                setRelDraft({ upstream: selectedNode.label, downstream: down, pattern: "customer_supplier", events: [] });
                setOpError(undefined);
                setDialog("relationship");
              }}
              onAddExternal={() => (setOpError(undefined), setDialog("external"))}
            />
          ) : selectedEdge ? (
            <RelationPanel
              r={selectedEdge}
              view={view}
              canEdit={canEdit && relIndex(selectedEdge) !== undefined}
              onGoto={onGoto}
              onEdit={() => {
                const i = relIndex(selectedEdge)!;
                const rel = model.relationships[i]!;
                setRelDraft({ index: i, upstream: rel.upstream, downstream: rel.downstream, pattern: rel.pattern, events: rel.events, description: rel.description });
                setOpError(undefined);
                setDialog("relationship");
              }}
              onDelete={() => {
                const i = relIndex(selectedEdge)!;
                const rel = model.relationships[i]!;
                if (run(`関係 ${rel.upstream} → ${rel.downstream} を削除`, removeRelationship(text, model, i))) setSelection(undefined);
              }}
            />
          ) : (
            <ViewSummary view={view} canEdit={canEdit} />
          )}
        </aside>
      </div>
      {dialog === "context" && (
        <ContextDialog
          error={opError}
          onClose={() => setDialog(undefined)}
          onSubmit={(name, sub) => run(`コンテキスト ${name} を追加`, addContext(text, model, name, sub)) && setDialog(undefined)}
        />
      )}
      {dialog === "external" && (
        <ExternalDialog
          contexts={contexts}
          initial={selectedNode?.kind === "context" ? selectedNode.label : view.level.startsWith("context:") ? view.level.slice("context:".length) : contexts[0]}
          error={opError}
          onClose={() => setDialog(undefined)}
          onSubmit={(ctx, d) => run(`外部システム ${d.name} を ${ctx} に追加`, addExternalSystem(text, model, ctx, d)) && setDialog(undefined)}
        />
      )}
      {dialog === "relationship" && relDraft && (
        <RelationshipDialog
          draft={relDraft}
          contexts={contexts}
          model={model}
          error={opError}
          onClose={() => setDialog(undefined)}
          onSubmit={(d) => {
            const r = relDraft.index === undefined ? addRelationship(text, model, d) : updateRelationship(text, model, relDraft.index, d);
            if (run(relDraft.index === undefined ? `関係 ${d.upstream} → ${d.downstream} を追加` : `関係 ${d.upstream} → ${d.downstream} を変更`, r)) setDialog(undefined);
          }}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          model={model}
          error={opError}
          onClose={() => setDialog(undefined)}
          run={(label, r) => run(label, r)}
          ops={{
            target: (t) => setTarget(text, model, t),
            api: (on) => setHttpApi(text, model, on),
            rls: (on) => setRls(text, model, on),
            rate: (l) => setDefaultRateLimit(text, model, l),
            security: (d) => addSecurity(text, model, d),
          }}
        />
      )}
    </div>
  );
}

function Badges({ badges }: { badges: string[] }) {
  if (!badges.length) return null;
  return (
    <p className="arch-badges">
      {badges.map((b) => (
        <span key={b} className="badge-chip">
          {b}
        </span>
      ))}
    </p>
  );
}

function ViewSummary({ view, canEdit }: { view: ArchView; canEdit: boolean }) {
  const counts = new Map<ArchKind, number>();
  for (const e of view.elements) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return (
    <section>
      <h2>{view.title}</h2>
      <p className="small muted">{view.description}</p>
      <ul className="small">
        {[...counts].map(([k, n]) => (
          <li key={k}>
            {KIND_JA[k]}: {n}
          </li>
        ))}
        <li>関係: {view.relations.length}</li>
      </ul>
      <p className="small muted">要素や線を選ぶと、ここに詳細と操作が出ます。</p>
      <ul className="small muted arch-list">
        <li>ダブルクリック（または選んで Enter）で中身を表示。上のパンくずで戻れます</li>
        {canEdit && <li>ドラッグで配置を変えられます（意味は変わりません。配置はレベルごとに保存されます）</li>}
        {canEdit && view.level === "system" && <li>コンテキストの縁の点から別のコンテキストへドラッグすると関係を追加できます（パネルからも追加できます）</li>}
        <li>実線は呼び出し・依存、破線はイベント・実装・外部への問い合わせ</li>
      </ul>
    </section>
  );
}

function ElementPanel({
  e,
  view,
  model,
  canEdit,
  files,
  savedVersion,
  onDrill,
  onGoto,
  onOpenFile,
  onSubdomain,
  onConnect,
  onAddExternal,
}: {
  e: ArchElement;
  view: ArchView;
  model: ModelIR;
  canEdit: boolean;
  files?: string[];
  savedVersion: number;
  onDrill: () => void;
  onGoto: (path: Path) => void;
  onOpenFile: (path: string) => void;
  onSubdomain: (s: SubdomainKind | undefined) => void;
  onConnect: (downstream: string) => void;
  onAddExternal: () => void;
}) {
  const ctx = e.kind === "context" ? model.contexts.find((c) => c.name === e.label) : undefined;
  const [down, setDown] = useState("");
  const label = new Map(view.elements.map((x) => [x.id, x.label]));
  const related = view.relations.filter((r) => r.source === e.id || r.target === e.id);
  return (
    <section>
      <p className="small muted">{KIND_JA[e.kind]}</p>
      <h2>{e.label}</h2>
      {e.technology && <p className="small">[{e.technology}]</p>}
      {e.description && <p className="small">{e.description}</p>}
      <Badges badges={e.badges} />
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {e.path && (
          <button className="small-button" onClick={() => onGoto(e.path!)}>
            YAMLで開く
          </button>
        )}
        {e.drill && e.drill !== view.level && (
          <button className="small-button" onClick={onDrill}>
            中身を見る
          </button>
        )}
      </div>
      {ctx && canEdit && view.level === "system" && (
        <div className="arch-form">
          <label>
            サブドメイン
            <select value={ctx.subdomain ?? ""} onChange={(ev) => onSubdomain((ev.target.value || undefined) as SubdomainKind | undefined)}>
              <option value="">（未設定）</option>
              {SUBDOMAIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SUBDOMAIN_LABEL[k].label}（{k}）
                </option>
              ))}
            </select>
          </label>
          <label>
            下流のコンテキストへ関係を追加
            <span className="row" style={{ gap: 6 }}>
              <select value={down} onChange={(ev) => setDown(ev.target.value)} aria-label="下流のコンテキスト">
                <option value="">選ぶ…</option>
                {model.contexts
                  .filter((c) => c.name !== ctx.name)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <button className="small-button" disabled={!down} onClick={() => onConnect(down)}>
                関係を追加…
              </button>
            </span>
          </label>
          <button className="small-button quiet" onClick={onAddExternal}>
            外部システム（拡張ポイント）を追加…
          </button>
        </div>
      )}
      {related.length > 0 && (
        <>
          <h3 className="small">関係</h3>
          <ul className="small arch-list">
            {related.map((r) => (
              <li key={r.id}>
                {r.source === e.id ? `→ ${label.get(r.target)}` : `← ${label.get(r.source)}`}: {r.label}
                {r.technology && <span className="muted"> [{r.technology}]</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {e.code?.length ? (
        <>
          <h3 className="small">生成されるファイル</h3>
          {files === undefined ? (
            <p className="small muted">読み込み中…</p>
          ) : files.length ? (
            <>
              <p className="small muted">保存済みの v{savedVersion} から生成（未保存の変更は反映されていません）</p>
              <ul className="small arch-list">
                {files.slice(0, 14).map((f) => (
                  <li key={f}>
                    <button className="linklike" onClick={() => onOpenFile(f)} title={`${f} を生成プレビューで開く`}>
                      {f.replace(/^.*?\/generated\//, "…/generated/")}
                    </button>
                  </li>
                ))}
                {files.length > 14 && <li className="muted">ほか {files.length - 14} 件</li>}
              </ul>
            </>
          ) : (
            <p className="small muted">保存済みの v{savedVersion} にはこの要素のファイルがありません（未保存の変更か、モデルにエラーがあります）</p>
          )}
        </>
      ) : null}
    </section>
  );
}

function RelationPanel({ r, view, canEdit, onGoto, onEdit, onDelete }: { r: ArchRelation; view: ArchView; canEdit: boolean; onGoto: (p: Path) => void; onEdit: () => void; onDelete: () => void }) {
  const label = (id: string) => view.elements.find((e) => e.id === id)?.label ?? id;
  return (
    <section>
      <p className="small muted">関係</p>
      <h2>
        {label(r.source)} → {label(r.target)}
      </h2>
      <p className="small">{r.label}</p>
      {r.technology && <p className="small muted">[{r.technology}]</p>}
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {r.path && (
          <button className="small-button" onClick={() => onGoto(r.path!)}>
            YAMLで開く
          </button>
        )}
        {canEdit && (
          <>
            <button className="small-button" onClick={onEdit}>
              編集…
            </button>
            <button className="small-button danger" onClick={onDelete}>
              削除
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    first.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal arch-modal" ref={first}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DialogError({ error }: { error?: { error: string; diagnostics: Diagnostic[] } }) {
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      <strong>{error.error}</strong>
      {error.diagnostics.length > 0 && (
        <ul className="small">
          {error.diagnostics.map((d, i) => (
            <li key={i}>
              {d.element && <strong>{d.element}: </strong>}
              {d.message}
              {d.hint && <span className="muted"> — {d.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContextDialog({ error, onClose, onSubmit }: { error?: { error: string; diagnostics: Diagnostic[] }; onClose: () => void; onSubmit: (name: string, sub?: SubdomainKind) => void }) {
  const [name, setName] = useState("");
  const [sub, setSub] = useState<SubdomainKind | "">("");
  return (
    <Modal title="コンテキストを追加" onClose={onClose}>
      <form
        className="arch-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name, sub || undefined);
        }}
      >
        <label>
          名前（PascalCase）
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing" required />
        </label>
        <label>
          サブドメイン
          <select value={sub} onChange={(e) => setSub(e.target.value as SubdomainKind | "")}>
            <option value="">（未設定）</option>
            {SUBDOMAIN_KINDS.map((k) => (
              <option key={k} value={k}>
                {SUBDOMAIN_LABEL[k].label}（{k}）
              </option>
            ))}
          </select>
        </label>
        <DialogError error={error} />
        <div className="row">
          <button className="primary" type="submit">
            追加
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ExternalDialog({
  contexts,
  initial,
  error,
  onClose,
  onSubmit,
}: {
  contexts: string[];
  initial?: string;
  error?: { error: string; diagnostics: Diagnostic[] };
  onClose: () => void;
  onSubmit: (context: string, d: { name: string; description?: string; returns?: string }) => void;
}) {
  const [ctx, setCtx] = useState(initial ?? contexts[0] ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [returns, setReturns] = useState("Boolean");
  return (
    <Modal title="外部システムを追加（拡張ポイント）" onClose={onClose}>
      <p className="small muted">外部システムへの問い合わせは、顧客が実装する拡張ポイントとしてモデルに入ります（生成されるコードは雛形を作るだけで、上書きしません）。</p>
      <form
        className="arch-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(ctx, { name, description, returns });
        }}
      >
        <label>
          問い合わせるコンテキスト
          <select value={ctx} onChange={(e) => setCtx(e.target.value)}>
            {contexts.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          名前（snake_case）
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="check_credit" required />
        </label>
        <label>
          説明
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="与信を外部の審査サービスに問い合わせる" />
        </label>
        <label>
          戻り値の型
          <input value={returns} onChange={(e) => setReturns(e.target.value)} />
        </label>
        <DialogError error={error} />
        <div className="row">
          <button className="primary" type="submit">
            追加
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RelationshipDialog({
  draft,
  contexts,
  model,
  error,
  onClose,
  onSubmit,
}: {
  draft: RelationshipDraft & { index?: number };
  contexts: string[];
  model: ModelIR;
  error?: { error: string; diagnostics: Diagnostic[] };
  onClose: () => void;
  onSubmit: (d: RelationshipDraft) => void;
}) {
  const [d, setD] = useState<RelationshipDraft>({ upstream: draft.upstream, downstream: draft.downstream, pattern: draft.pattern, events: draft.events, description: draft.description ?? "" });
  const events = upstreamEvents(model, d.upstream);
  return (
    <Modal title={draft.index === undefined ? "コンテキストの関係を追加" : "コンテキストの関係を編集"} onClose={onClose}>
      <form
        className="arch-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(d);
        }}
      >
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label>
            上流（供給する側）
            <select value={d.upstream} onChange={(e) => setD({ ...d, upstream: e.target.value, events: [] })}>
              {contexts.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            下流（使う側）
            <select value={d.downstream} onChange={(e) => setD({ ...d, downstream: e.target.value })}>
              {contexts.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          パターン
          <select value={d.pattern} onChange={(e) => setD({ ...d, pattern: e.target.value as RelationshipPattern })}>
            {RELATIONSHIP_PATTERNS.map((p) => (
              <option key={p} value={p}>
                {PATTERN_JA[p]}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>イベント契約（下流が受け取れる上流のイベント）</legend>
          {events.length === 0 && <p className="small muted">{d.upstream} はイベントを発生させていません</p>}
          {events.map((ev) => (
            <label key={ev} className="check">
              <input type="checkbox" checked={d.events.includes(ev)} onChange={(e) => setD({ ...d, events: e.target.checked ? [...d.events, ev] : d.events.filter((x) => x !== ev) })} />
              {ev}
            </label>
          ))}
        </fieldset>
        <label>
          説明
          <input value={d.description ?? ""} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </label>
        <DialogError error={error} />
        <div className="row">
          <button className="primary" type="submit">
            {draft.index === undefined ? "追加" : "変更"}
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsDialog({
  model,
  error,
  onClose,
  run,
  ops,
}: {
  model: ModelIR;
  error?: { error: string; diagnostics: Diagnostic[] };
  onClose: () => void;
  run: (label: string, r: OpResult) => boolean;
  ops: {
    target: (t: "python" | "typescript") => OpResult;
    api: (on: boolean) => OpResult;
    rls: (on: boolean) => OpResult;
    rate: (l: { requests: number; per: RateLimitUnit; by: RateLimitKey } | undefined) => OpResult;
    security: (d: { role: string; issuer?: string; audience?: string }) => OpResult;
  };
}) {
  const sec = model.security;
  const current = sec?.rateLimits.default;
  const [rate, setRate] = useState({ on: !!current, requests: current?.requests ?? 60, per: current?.per ?? ("minute" as RateLimitUnit), by: current?.by ?? ("principal" as RateLimitKey) });
  const [secDraft, setSecDraft] = useState({ role: "member", issuer: "", audience: "" });
  return (
    <Modal title="生成・セキュリティ設定" onClose={onClose}>
      <p className="small muted">変更はモデル（YAML）への未保存の編集になります。モデルを不正にする変更は適用されず、理由が表示されます。</p>
      <fieldset className="arch-form">
        <legend>生成するコード</legend>
        <div className="row" style={{ gap: 12 }}>
          {(["python", "typescript"] as const).map((t) => (
            <label key={t} className="check">
              <input type="radio" name="target" checked={model.generation.target === t} onChange={() => run(`生成ターゲットを ${t} に変更`, ops.target(t))} />
              {t === "python" ? "Python（Pydantic）" : "TypeScript（Zod）"}
            </label>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={!!model.generation.typescript.api} onChange={(e) => run(e.target.checked ? "HTTP API を生成する" : "HTTP API を生成しない", ops.api(e.target.checked))} />
          HTTP API と TanStack Query のクライアント（generation.typescript.api、TypeScript のとき生成）
        </label>
      </fieldset>
      {sec ? (
        <fieldset className="arch-form">
          <legend>セキュリティ</legend>
          {sec.tenancy ? (
            <label className="check">
              <input type="checkbox" checked={sec.tenancy.rls} onChange={(e) => run(e.target.checked ? "RLS をオン" : "RLS をオフ", ops.rls(e.target.checked))} />
              PostgreSQL の行レベルセキュリティ（tenancy.rls。オフでも SQL のテナント条件は付きます）
            </label>
          ) : (
            <p className="small muted">マルチテナント（security.tenancy）はありません（RLS は tenancy があるときだけ）。</p>
          )}
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "end" }}>
            <label className="check">
              <input type="checkbox" checked={rate.on} onChange={(e) => setRate({ ...rate, on: e.target.checked })} />
              既定のレート制限
            </label>
            <label>
              回数
              <input type="number" min={1} value={rate.requests} disabled={!rate.on} onChange={(e) => setRate({ ...rate, requests: Number(e.target.value) })} style={{ width: 80 }} />
            </label>
            <label>
              期間
              <select value={rate.per} disabled={!rate.on} onChange={(e) => setRate({ ...rate, per: e.target.value as RateLimitUnit })}>
                {RATE_LIMIT_UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <label>
              数える単位
              <select value={rate.by} disabled={!rate.on} onChange={(e) => setRate({ ...rate, by: e.target.value as RateLimitKey })}>
                {RATE_LIMIT_KEYS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <button className="small-button" onClick={() => run("既定のレート制限を変更", ops.rate(rate.on ? { requests: rate.requests, per: rate.per, by: rate.by } : undefined))}>
              適用
            </button>
          </div>
        </fieldset>
      ) : (
        <fieldset className="arch-form">
          <legend>セキュリティを追加</legend>
          <p className="small muted">
            security を宣言すると既定で拒否になります。ここでは最小の構成（ロール 1 つ・Bearer JWT）を入れ、authorize のないユースケース・集約・クエリに authenticated（ポリシーが実行するユースケースは internal）を付けます。あとで YAML で絞り込んでください。
          </p>
          <label>
            ロール名
            <input value={secDraft.role} onChange={(e) => setSecDraft({ ...secDraft, role: e.target.value })} />
          </label>
          <label>
            発行者（iss、任意）
            <input value={secDraft.issuer} onChange={(e) => setSecDraft({ ...secDraft, issuer: e.target.value })} placeholder="https://auth.example.com/" />
          </label>
          <label>
            対象（aud、任意）
            <input value={secDraft.audience} onChange={(e) => setSecDraft({ ...secDraft, audience: e.target.value })} />
          </label>
          <button className="small-button" onClick={() => run("セキュリティを追加", ops.security(secDraft))}>
            セキュリティを追加
          </button>
        </fieldset>
      )}
      <DialogError error={error} />
      <div className="row">
        <button className="primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  );
}
