import { analyzeBoard, boardGhosts, contextMap, sampleBoard, STICKY_KINDS, suggestAggregates, type Board, type BoardGhost, type StickyKind } from "@ddd/core";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError } from "../../api.ts";
import { acceptGhost, addConnector, addFrame, addItem, duplicate, frameContents, History, removeIds, updateItem, visibleGhosts } from "../../lib/boardOps.ts";
import { AssistPanel } from "./AssistPanel.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { nodeTypes, STICKY_GLYPH, type FrameData, type GhostData, type StickyData } from "./nodes.tsx";
import { ReflectDialog } from "./ReflectDialog.tsx";

const NO_HIGHLIGHT: string[] = [];
const clearHighlight = (prev: string[]) => (prev.length ? NO_HIGHLIGHT : prev);

const PALETTE: StickyKind[] = ["event", "command", "actor", "policy", "aggregate", "rule", "read_model", "external_system", "hotspot", "note"];

interface Props {
  projectId: string;
  canEdit: boolean;
  modelText: string;
  onReflect: (yaml: string) => void;
  /** AI (Claude) is enabled for the workspace: offer "ask AI for stickies". */
  aiActive?: boolean;
}

export function BoardView(props: Props) {
  return (
    <ReactFlowProvider>
      <BoardCanvas {...props} />
    </ReactFlowProvider>
  );
}

type Tool = StickyKind | "frame";

function BoardCanvas({ projectId, canEdit, modelText, onReflect, aiActive }: Props) {
  const rf = useReactFlow();
  const [board, setBoard] = useState<Board>();
  const [saved, setSaved] = useState<{ version: number; json: string }>({ version: 0, json: "" });
  const [status, setStatus] = useState<string>();
  const [conflict, setConflict] = useState<{ version: number; board: Board }>();
  const [tool, setTool] = useState<Tool>("event");
  const [editingId, setEditingId] = useState<string>();
  const [selected, setSelected] = useState<string[]>(NO_HIGHLIGHT);
  const [highlight, setHighlight] = useState<string[]>(NO_HIGHLIGHT);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [reflecting, setReflecting] = useState(false);
  const [llmGhosts, setLlmGhosts] = useState<BoardGhost[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
  const [showGhosts, setShowGhosts] = useState(true);
  const history = useRef(new History());
  const dragStart = useRef<{ frameId?: string; contents: string[]; origin: Record<string, { x: number; y: number }> }>(undefined);
  const boardRef = useRef<Board | undefined>(undefined);
  boardRef.current = board;

  const json = useMemo(() => (board ? JSON.stringify(board) : ""), [board]);
  const dirty = !!board && json !== saved.json;

  // -- load, autosave, polling -------------------------------------------------

  const load = useCallback(async () => {
    try {
      const r = await api.board(projectId);
      setBoard(r.board);
      setSaved({ version: r.version, json: JSON.stringify(r.board) });
      history.current.clear();
      setStatus(r.updated_by ? `最終更新: ${r.updated_by}（${new Date(r.updated_at!).toLocaleString()}）` : undefined);
    } catch (e) {
      setStatus(describeError(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (baseVersion?: number) => {
      const b = boardRef.current;
      if (!b || !canEdit) return;
      const body = JSON.stringify(b);
      try {
        const r = await api.saveBoard(projectId, b, baseVersion ?? saved.version);
        setSaved({ version: r.version, json: body });
        setConflict(undefined);
        setStatus("保存しました");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setConflict({ version: Number(e.body.current_version), board: e.body.board as Board });
        else setStatus(`保存できませんでした: ${describeError(e)}`);
      }
    },
    [projectId, saved.version, canEdit],
  );

  useEffect(() => {
    if (!dirty || !canEdit || conflict) return;
    setStatus("保存待ち…");
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [json, dirty, canEdit, conflict, save]);

  // Show other people's changes when we have nothing unsaved.
  useEffect(() => {
    const t = setInterval(async () => {
      if (dirty || editingId || document.visibilityState !== "visible") return;
      try {
        const r = await api.board(projectId);
        if (r.version > saved.version) {
          setBoard(r.board);
          setSaved({ version: r.version, json: JSON.stringify(r.board) });
          history.current.clear();
          setStatus(`${r.updated_by ?? "ほかの人"} の変更を反映しました`);
        }
      } catch {
        // Offline: the next save reports the problem.
      }
    }, 4000);
    return () => clearInterval(t);
  }, [projectId, dirty, editingId, saved.version]);

  // -- board mutations ---------------------------------------------------------

  const commit = useCallback((next: Board) => {
    const prev = boardRef.current;
    if (!prev || next === prev) return;
    history.current.push(prev);
    setBoard(next);
  }, []);

  const undo = useCallback(() => {
    const b = boardRef.current;
    if (!b) return;
    const prev = history.current.undo(b);
    if (prev) setBoard(prev);
  }, []);
  const redo = useCallback(() => {
    const b = boardRef.current;
    if (!b) return;
    const next = history.current.redo(b);
    if (next) setBoard(next);
  }, []);

  const commitText = useCallback(
    (id: string, text: string) => {
      const b = boardRef.current!;
      setEditingId(undefined);
      if (b.items.some((i) => i.id === id)) commit(updateItem(b, id, { text }));
      else commit({ ...b, frames: b.frames.map((f) => (f.id === id ? { ...f, title: text } : f)) });
    },
    [commit],
  );
  const stopEditing = useCallback(() => setEditingId(undefined), []);

  // -- ghost stickies (predictions) ---------------------------------------------

  const localGhosts = useMemo(() => (board && canEdit ? boardGhosts(board) : []), [board, canEdit]);
  const ghosts = useMemo(
    () => (board && showGhosts && !editingId ? visibleGhosts([...localGhosts, ...llmGhosts], board, selected, dismissed) : []),
    [board, showGhosts, editingId, localGhosts, llmGhosts, selected, dismissed],
  );
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;

  const acceptGhostById = useCallback(
    (id: string) => {
      const b = boardRef.current;
      const g = ghostsRef.current.find((x) => x.id === id);
      if (!b || !g) return;
      commit(acceptGhost(b, g).board);
      setLlmGhosts((prev) => prev.filter((x) => x.id !== id));
      setStatus(`「${g.text}」を追加しました（ダブルクリックで直せます）`);
    },
    [commit],
  );
  const dismissGhost = useCallback((id: string) => setDismissed((prev) => new Set([...prev, id])), []);

  const askAi = async () => {
    const b = boardRef.current;
    if (!b) return;
    setAsking(true);
    try {
      const r = await api.boardAssist(projectId, b, true);
      const fresh = r.ghosts.filter((g) => g.source === "llm");
      setLlmGhosts(fresh);
      setShowGhosts(true);
      setStatus(fresh.length ? `AI が ${fresh.length} 枚の付箋を提案しました。クリックで追加、× で消せます` : "AI からの提案はありませんでした");
    } catch (e) {
      setStatus(describeError(e));
    } finally {
      setAsking(false);
    }
  };

  // -- derive React Flow nodes / edges from the board --------------------------

  useEffect(() => {
    if (!board) return;
    setNodes((prev) => {
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      const hl = new Set(highlight);
      const frames: Node[] = board.frames.map((f) => ({
        id: f.id,
        type: "frame",
        position: { x: f.x, y: f.y },
        width: f.w,
        height: f.h,
        zIndex: -1,
        selected: sel.has(f.id),
        draggable: canEdit,
        data: { frame: f, editing: editingId === f.id, highlighted: hl.has(f.id), onCommitTitle: commitText, onStopEditing: stopEditing } satisfies FrameData,
      }));
      const items: Node[] = board.items.map((i) => ({
        id: i.id,
        type: "sticky",
        position: { x: i.x, y: i.y },
        width: i.w,
        height: i.h,
        selected: sel.has(i.id),
        draggable: canEdit && editingId !== i.id,
        data: { item: i, editing: editingId === i.id, highlighted: hl.has(i.id), onCommitText: commitText, onStopEditing: stopEditing } satisfies StickyData,
      }));
      const ghostNodes: Node[] = ghosts.map((g, i) => ({
        id: g.id,
        type: "ghost",
        position: { x: g.x, y: g.y },
        width: STICKY_KINDS[g.kind].w,
        height: STICKY_KINDS[g.kind].h,
        draggable: false,
        selectable: false,
        connectable: false,
        data: { ghost: g, first: i === 0, onAccept: acceptGhostById, onDismiss: dismissGhost } satisfies GhostData,
      }));
      return [...frames, ...items, ...ghostNodes];
    });
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return board.connectors.map((c) => ({
        id: c.id,
        source: c.from,
        target: c.to,
        label: c.label,
        selected: sel.has(c.id),
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--ink-soft)" },
        style: { stroke: "var(--ink-soft)", strokeWidth: 1.5 },
      })).concat(
        ghosts
          .filter((g) => g.connect)
          .map((g) => ({
            id: `edge-${g.id}`,
            source: g.connect!.from,
            target: g.connect!.to,
            label: undefined,
            selected: false,
            selectable: false,
            markerEnd: { type: MarkerType.ArrowClosed, color: "var(--ink-faint)" },
            style: { stroke: "var(--ink-faint)", strokeWidth: 1.2, strokeDasharray: "5 4" },
          })),
      );
    });
  }, [board, editingId, highlight, canEdit, commitText, stopEditing, ghosts, acceptGhostById, dismissGhost]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      // End of a user resize → commit the size.
      const resized = changes.filter((c) => c.type === "dimensions" && c.resizing === false && c.setAttributes && c.dimensions);
      if (resized.length && boardRef.current) {
        let b = boardRef.current;
        for (const c of resized) {
          if (c.type !== "dimensions" || !c.dimensions) continue;
          const pos = rf.getNode(c.id)?.position;
          const patch = { w: Math.round(c.dimensions.width), h: Math.round(c.dimensions.height), ...(pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : {}) };
          b = b.items.some((i) => i.id === c.id) ? updateItem(b, c.id, patch) : { ...b, frames: b.frames.map((f) => (f.id === c.id ? { ...f, ...patch } : f)) };
        }
        commit(b);
      }
    },
    [commit, rf],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    const b = boardRef.current!;
    const contents = node.type === "frame" ? frameContents(b, node.id).filter((id) => !rf.getNode(id)?.selected) : [];
    const origin: Record<string, { x: number; y: number }> = {};
    for (const n of rf.getNodes()) origin[n.id] = { ...n.position };
    dragStart.current = { frameId: node.type === "frame" ? node.id : undefined, contents, origin };
  }, [rf]);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const d = dragStart.current;
    if (!d?.frameId || node.id !== d.frameId) return;
    const o = d.origin[node.id]!;
    const dx = node.position.x - o.x;
    const dy = node.position.y - o.y;
    setNodes((ns) => ns.map((n) => (d.contents.includes(n.id) ? { ...n, position: { x: d.origin[n.id]!.x + dx, y: d.origin[n.id]!.y + dy } } : n)));
  }, []);

  const onNodeDragStop = useCallback(() => {
    const b = boardRef.current;
    if (!b) return;
    const positions = new Map(rf.getNodes().map((n) => [n.id, n.position]));
    const moved = {
      ...b,
      items: b.items.map((i) => {
        const p = positions.get(i.id);
        return p && (Math.round(p.x) !== i.x || Math.round(p.y) !== i.y) ? { ...i, x: Math.round(p.x), y: Math.round(p.y) } : i;
      }),
      frames: b.frames.map((f) => {
        const p = positions.get(f.id);
        return p && (Math.round(p.x) !== f.x || Math.round(p.y) !== f.y) ? { ...f, x: Math.round(p.x), y: Math.round(p.y) } : f;
      }),
    };
    if (JSON.stringify(moved) !== JSON.stringify(b)) commit(moved);
    dragStart.current = undefined;
  }, [commit, rf]);

  const placeAt = useCallback(
    (point: { x: number; y: number }, t: Tool = tool) => {
      const b = boardRef.current;
      if (!b || !canEdit) return;
      const r = t === "frame" ? addFrame(b, point) : addItem(b, t, point);
      commit(r.board);
      setEditingId(r.id);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    },
    [tool, canEdit, commit],
  );

  const addAtCenter = (t: Tool) => {
    const el = document.querySelector(".board-canvas");
    const rect = el?.getBoundingClientRect();
    const p = rf.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 });
    placeAt({ x: p.x + (Math.random() - 0.5) * 60, y: p.y + (Math.random() - 0.5) * 60 }, t);
  };

  const deleteSelected = useCallback(() => {
    const b = boardRef.current;
    if (!b || !canEdit) return;
    const ids = [...rf.getNodes().filter((n) => n.selected).map((n) => n.id), ...rf.getEdges().filter((e) => e.selected).map((e) => e.id)];
    if (ids.length) commit(removeIds(b, ids));
  }, [canEdit, commit, rf]);

  const duplicateSelected = useCallback(() => {
    const b = boardRef.current;
    if (!b || !canEdit) return;
    const ids = rf.getNodes().filter((n) => n.selected).map((n) => n.id);
    if (!ids.length) return;
    const r = duplicate(b, ids);
    commit(r.board);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
  }, [canEdit, commit, rf]);

  // Keyboard shortcuts (ignored while typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button, a, [role=tab], [contenteditable=true], .cm-editor, .modal")) return;
      if (!document.querySelector(".board-canvas")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
      } else if ((e.key === "Delete" || e.key === "Backspace") && canEdit) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Tab" && !mod && canEdit && ghostsRef.current.length) {
        e.preventDefault();
        acceptGhostById(ghostsRef.current[0]!.id);
      } else if (e.key === "Escape" && ghostsRef.current.length) {
        const ids = ghostsRef.current.map((g) => g.id);
        setDismissed((prev) => new Set([...prev, ...ids]));
      } else if (e.key === "Enter" && selected.length === 1 && canEdit) {
        e.preventDefault();
        setEditingId(selected[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, duplicateSelected, deleteSelected, selected, canEdit, acceptGhostById]);

  const findings = useMemo(() => (board ? analyzeBoard(board) : []), [board]);
  const candidates = useMemo(() => (board ? suggestAggregates(board) : []), [board]);
  const links = useMemo(() => (board ? contextMap(board) : []), [board]);

  const focus = useCallback(
    (ids: string[]) => {
      setHighlight(ids);
      if (ids.length) void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.4, duration: 300, maxZoom: 1.2 });
    },
    [rf],
  );

  if (!board) return <div className="view muted">{status ?? "ボードを読み込んでいます…"}</div>;

  const selectedEdge = edges.find((e) => e.selected);

  return (
    <div className="board">
      <div className="board-toolbar" role="toolbar" aria-label="付箋の種類">
        {canEdit && (
          <>
            {PALETTE.map((k) => (
              <button
                key={k}
                data-tour={`palette-${k}`}
                className={`palette-item sticky-swatch sticky-${k}`}
                aria-pressed={tool === k}
                title={`${STICKY_KINDS[k].label}: ${STICKY_KINDS[k].help}（クリックで追加・キャンバスをダブルクリックでその場所に追加）`}
                onClick={() => {
                  setTool(k);
                  addAtCenter(k);
                }}
              >
                <span aria-hidden>{STICKY_GLYPH[k]}</span>
                {STICKY_KINDS[k].label}
              </button>
            ))}
            <button
              className="palette-item palette-frame"
              data-tour="palette-frame"
              aria-pressed={tool === "frame"}
              title="コンテキスト（境界）のフレーム。中に置いた付箋はフレームと一緒に動きます"
              onClick={() => {
                setTool("frame");
                addAtCenter("frame");
              }}
            >
              ▭ コンテキスト
            </button>
            <span className="toolbar-sep" />
            <button className="quiet" onClick={undo} disabled={!history.current.canUndo} title="元に戻す（⌘/Ctrl+Z）">
              ↶
            </button>
            <button className="quiet" onClick={redo} disabled={!history.current.canRedo} title="やり直す（⌘/Ctrl+Shift+Z）">
              ↷
            </button>
          </>
        )}
        <div className="spacer" />
        {canEdit && (
          <label className="small row" style={{ gap: 4 }} title="付箋の並びから、次に置きそうな付箋を半透明で表示します（Tab で追加・Esc で消す）">
            <input type="checkbox" checked={showGhosts} onChange={(e) => setShowGhosts(e.target.checked)} />
            予測を表示
          </label>
        )}
        {canEdit && aiActive && board.items.length > 0 && (
          <button data-tour="board-ai" onClick={() => void askAi()} disabled={asking} title="ボードの内容を Claude に送り、足りなさそうな付箋を提案してもらいます">
            {asking ? "AI が考えています…" : "AI に付箋を提案してもらう"}
          </button>
        )}
        {board.items.length === 0 && canEdit && (
          <button
            data-tour="board-sample"
            onClick={() => {
              commit(sampleBoard());
              setTimeout(() => void rf.fitView({ padding: 0.1, duration: 300 }), 50);
            }}
          >
            サンプルボードを読み込む
          </button>
        )}
        <span className="small muted" aria-live="polite">
          {conflict ? "ほかの人の変更と衝突しています" : dirty ? "未保存" : status}
        </span>
      </div>
      <div className="board-body">
        <div className="board-canvas" data-tour="board-canvas" onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
          placeAt(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onConnect={(c) => canEdit && c.source && c.target && commit(addConnector(boardRef.current!, c.source, c.target))}
            onNodeDoubleClick={(_, n) => canEdit && setEditingId(n.id)}
            onSelectionChange={({ nodes: ns }) => {
              // Only store real changes: React Flow reports selection on every node update, and
              // setting a fresh array each time would re-derive the nodes and loop forever.
              const ids = ns.map((n) => n.id);
              setSelected((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids));
              if (ns.length) setHighlight(clearHighlight);
            }}
            onPaneClick={() => setHighlight(clearHighlight)}
            deleteKeyCode={null}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            zoomOnDoubleClick={false}
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            connectionMode={ConnectionMode.Loose}
            nodesConnectable={canEdit}
            nodesDraggable={canEdit}
            elementsSelectable
            minZoom={0.1}
            maxZoom={2.5}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--line-strong)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === "sticky" ? `var(--st-${(n.data as StickyData).item.kind})` : "transparent")} nodeStrokeColor="var(--ink-faint)" maskColor="rgb(0 0 0 / 8%)" />
          </ReactFlow>
          {board.items.length === 0 && (
            <div className="board-empty">
              <p>キャンバスをダブルクリックして付箋を置きます。</p>
              <p className="small muted">まず業務で起きる出来事（ドメインイベント）を時系列で左から右へ並べ、次にそれを起こすコマンドとアクター、最後に集約とコンテキストの境界を考えます。</p>
            </div>
          )}
          <p className="board-help small muted">
            半透明の付箋は予測（Tab・クリックで追加／Esc で消す）／ダブルクリック: 追加・編集／ドラッグ: 範囲選択／ホイール・右ドラッグ: 移動／付箋の端から矢印／Delete: 削除／⌘D: 複製／⌘Z: 元に戻す
          </p>
        </div>
        <aside className="board-side" aria-label="付箋の詳細と整理の補助">
          <ItemPanel
            board={board}
            selectedIds={selected}
            selectedEdgeId={selectedEdge?.id}
            canEdit={canEdit}
            onChange={commit}
            onEdit={(id) => setEditingId(id)}
          />
          <AssistPanel
            board={board}
            findings={findings}
            candidates={candidates}
            links={links}
            canEdit={canEdit}
            onFocus={focus}
            onChange={commit}
            onReflect={() => setReflecting(true)}
          />
        </aside>
      </div>
      {reflecting && (
        <ReflectDialog
          board={board}
          modelText={modelText}
          canEdit={canEdit}
          onClose={() => setReflecting(false)}
          onApply={(yaml, names) => {
            // Remember the code names on the board so the next reflection is pre-filled.
            let b = board;
            for (const [id, name] of Object.entries(names)) {
              if (b.items.some((i) => i.id === id)) b = updateItem(b, id, { codeName: name });
              else b = { ...b, frames: b.frames.map((f) => (f.id === id ? { ...f, codeName: name } : f)) };
            }
            commit(b);
            setReflecting(false);
            onReflect(yaml);
          }}
        />
      )}
      {conflict && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="board-conflict">
          <div className="modal">
            <h2 id="board-conflict">ほかの人が先にボードを保存しました（v{conflict.version}）</h2>
            <p>あなたの変更はまだ保存されていません。どちらを残すか選んでください。</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  setBoard(conflict.board);
                  setSaved({ version: conflict.version, json: JSON.stringify(conflict.board) });
                  history.current.clear();
                  setConflict(undefined);
                }}
              >
                相手のボードを読み込む（自分の変更を破棄）
              </button>
              <button className="primary" onClick={() => void save(conflict.version)}>
                自分のボードで上書き保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

