import { applyEdits, parseModel, ruleUsage, unifiedDiff, validateModelText, type Diagnostic, type EditOp, type ModelIR, type Path } from "@ddd/core";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError, type Me, type Role } from "../api.ts";
import { href, navigate } from "../App.tsx";
import { DiagramView } from "../components/DiagramView.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { HistoryView } from "../components/HistoryView.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { Outline } from "../components/Outline.tsx";
import { ProposeDialog } from "../components/ProposeDialog.tsx";
import type { ProposeKind } from "../lib/propose.ts";
import { PreviewView } from "../components/PreviewView.tsx";
import { RulesView } from "../components/RulesView.tsx";
import { ScenariosView } from "../components/ScenariosView.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { YamlEditor, type GotoRequest } from "../components/YamlEditor.tsx";
import { buildOutline, flatten } from "../lib/outline.ts";
import { BoardTabs } from "../components/board/BoardTabs.tsx";
import { BoardView } from "../components/board/BoardView.tsx";
import { renameOnBoards, type Rename } from "../lib/boardRenames.ts";
import { clearDraft, readDraft, writeDraft, type ModelDraft } from "../lib/drafts.ts";
import { TutorialCoach } from "../components/TutorialCoach.tsx";
import { tutorialStore } from "../lib/tutorial.ts";

const TABS = [
  { id: "discovery", label: "ディスカバリー" },
  { id: "model", label: "モデル (YAML)" },
  { id: "diagram", label: "図" },
  { id: "rules", label: "ルール" },
  { id: "scenarios", label: "シナリオ" },
  { id: "preview", label: "生成プレビュー" },
  { id: "history", label: "履歴" },
] as const;
type Tab = (typeof TABS)[number]["id"];

interface Conflict {
  theirs: string;
  version: number;
}

export function ProjectPage({ me, id, tab: tabParam, onLogout }: { me: Me; id: string; tab?: string; onLogout: () => void }) {
  const [defaultTab, setDefaultTab] = useState<Tab>("model");
  const tab: Tab = (TABS.find((t) => t.id === tabParam)?.id ?? defaultTab) as Tab;
  const [project, setProject] = useState<{ name: string; workspace_id: string }>();
  const [role, setRole] = useState<Role>("viewer");
  const [saved, setSaved] = useState<{ version: number; yaml: string }>();
  const [text, setText] = useState("");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [goto, setGoto] = useState<GotoRequest>();
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [conflict, setConflict] = useState<Conflict>();
  const lastGoodModel = useRef<ModelIR>(undefined);
  const [coach, setCoach] = useState(() => tutorialStore.get().projectId === id);
  const [ai, setAi] = useState<{ available: boolean; enabled: boolean; active: boolean; model: string | null }>();
  const [aiBusy, setAiBusy] = useState(false);
  const [propose, setPropose] = useState<{ context: string; aggregate: string; kind: ProposeKind }>();
  const [board, setBoard] = useState<{ id: string; name: string }>(() => {
    try {
      return { id: localStorage.getItem(`ddd.board.${id}`) ?? "main", name: "" };
    } catch {
      return { id: "main", name: "" };
    }
  });
  const [boardsVersion, setBoardsVersion] = useState(0);
  /** Unsaved edits left from an earlier visit (offered for restore). */
  const [draftOffer, setDraftOffer] = useState<ModelDraft>();
  const selectBoard = useCallback(
    (bid: string, name: string) => {
      setBoard((prev) => (prev.id === bid && prev.name === name ? prev : { id: bid, name }));
      try {
        localStorage.setItem(`ddd.board.${id}`, bid);
      } catch {
        // Private mode: the choice is not remembered.
      }
    },
    [id],
  );
  /** Type renames since the last save; applied to the boards' stickies once the model is saved. */
  const pendingRenames = useRef<Rename[]>([]);
  const noteRename = useCallback((from: string, to: string) => {
    pendingRenames.current.push({ from, to });
  }, []);
  const aiActive = useRef(false);
  aiActive.current = !!ai?.active && role !== "viewer";

  const canEdit = role !== "viewer";
  const dirty = saved !== undefined && text !== saved.yaml;

  // Keep unsaved edits in this browser until they are saved (or discarded).
  useEffect(() => {
    if (!saved || draftOffer) return;
    if (!dirty) {
      clearDraft(id);
      return;
    }
    const t = setTimeout(() => writeDraft(id, { yaml: text, baseVersion: saved.version, savedAt: new Date().toISOString() }), 400);
    return () => clearTimeout(t);
  }, [id, text, dirty, saved, draftOffer]);

  useEffect(() => {
    api.assistStatus(id).then(setAi, () => setAi(undefined));
    Promise.all([api.project(id), api.model(id), api.layout(id)]).then(
      ([p, m, l]) => {
        setProject(p.project);
        setRole(p.role);
        setSaved({ version: m.version, yaml: m.yaml });
        setText(m.yaml);
        const draft = readDraft(id);
        if (draft && draft.yaml !== m.yaml) setDraftOffer(draft);
        else if (draft) clearDraft(id);
        // A project whose model has no aggregates yet starts on the discovery board.
        const parsed = validateModelText(m.yaml).model;
        if (parsed && parsed.contexts.every((c) => c.aggregates.length === 0 && c.useCases.length === 0)) setDefaultTab("discovery");
        setPositions(l.positions);
      },
      (e) => setLoadError(e instanceof ApiError && e.status === 404 ? "このプロジェクトは存在しないか、閲覧権限がありません。" : describeError(e)),
    );
  }, [id]);

  // Validation runs in the browser with the same core library as the CLI and server.
  const deferred = useDeferredValue(text);
  const result = useMemo(() => validateModelText(deferred), [deferred]);
  const locate = useMemo(() => parseModel(deferred).locate, [deferred]);
  if (result.model) lastGoodModel.current = result.model;
  const model = result.model ?? lastGoodModel.current;
  const diagnostics: Diagnostic[] = result.diagnostics;
  const outline = useMemo(() => (model ? buildOutline(model, diagnostics) : []), [model, diagnostics]);
  const flat = useMemo(() => flatten(outline), [outline]);
  const rules = useMemo(() => (result.analysis ? ruleUsage(result.analysis) : []), [result.analysis]);
  const selected = flat.find((n) => n.id === selectedId);
  const savedCheck = useMemo(() => (saved ? validateModelText(saved.yaml) : undefined), [saved]);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const setTab = (t: Tab) => navigate({ page: "project", id, tab: t });

  const gotoPath = useCallback(
    (path: Path) => {
      const loc = locate(path);
      if (!loc) return;
      if (tab !== "model") navigate({ page: "project", id, tab: "model" });
      setGoto({ line: loc.line, nonce: Date.now() });
    },
    [locate, tab, id],
  );

  const nodeLines = useMemo(() => flat.map((n) => ({ n, line: locate(n.path)?.line ?? 0 })).sort((a, b) => a.line - b.line), [flat, locate]);
  const onCursorLine = useCallback(
    (line: number) => {
      let best: (typeof nodeLines)[number] | undefined;
      for (const x of nodeLines) if (x.line <= line) best = x;
      if (best && best.n.id !== selectedId) setSelectedId(best.n.id);
    },
    [nodeLines, selectedId],
  );

  const onEdit = useCallback(
    (ops: EditOp[]): string | undefined => {
      if (!ops.length) return undefined;
      const r = applyEdits(text, ops);
      if (!r.ok) return r.error;
      for (const op of ops) if (op.op === "renameType") noteRename(op.from, op.to);
      setText(r.text);
      return undefined;
    },
    [text, noteRename],
  );

  const save = useCallback(
    async (baseVersion?: number) => {
      if (!saved || !canEdit) return;
      setStatus("保存しています…");
      try {
        const r = await api.saveModel(id, text, baseVersion ?? saved.version, message);
        setSaved({ version: r.version, yaml: text });
        setMessage("");
        setConflict(undefined);
        setStatus(r.ok ? `v${r.version} として保存しました` : `v${r.version} として保存しました（エラーが残っているため生成はできません）`);
        const renames = pendingRenames.current.splice(0);
        if (renames.length)
          renameOnBoards(id, renames).then(
            (n) => n && setStatus(`v${r.version} として保存し、ボードの付箋 ${n} 枚の名前も更新しました`),
            (e) => setStatus(`v${r.version} として保存しました。ボードの付箋の名前は更新できませんでした: ${describeError(e)}`),
          );
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConflict({ theirs: String(e.body.yaml), version: Number(e.body.current_version) });
          setStatus("ほかの人が先に保存しました");
        } else setStatus(`保存できませんでした: ${describeError(e)}`);
      }
    },
    [saved, canEdit, id, text, message],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [save, dirty]);

  const layoutTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onMove = (nodeId: string, p: { x: number; y: number }) => {
    const next = { ...positions, [nodeId]: p };
    setPositions(next);
    clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => api.saveLayout(id, next).catch((e) => setStatus(`図の配置を保存できませんでした: ${describeError(e)}`)), 400);
  };

  if (loadError) {
    return (
      <>
        <TopBar me={me} onLogout={onLogout} />
        <main className="page">
          <p className="error-banner">{loadError}</p>
          <a href="#/">ワークスペース一覧へ</a>
        </main>
      </>
    );
  }
  if (!saved || !project) return <div className="page muted">読み込み中…</div>;

  return (
    <>
      <TopBar
        me={me}
        onLogout={onLogout}
        crumbs={
          <>
            <a href={href({ page: "workspace", ws: project.workspace_id })}>ワークスペース</a>
            <span aria-hidden>/</span>
            <strong style={{ color: "var(--ink)" }}>{project.name}</strong>
            <span className="muted small">v{saved.version}</span>
            {!canEdit && <span className="role">閲覧のみ</span>}
          </>
        }
      >
        {!coach && (
          <button
            className="quiet small-button"
            onClick={() => {
              tutorialStore.show(id);
              setCoach(true);
            }}
            title="手順ガイドを表示します"
          >
            ガイド
          </button>
        )}
        <a className="small" data-tour="export-link" href={`/api/projects/${id}/export`} download>
          YAMLをエクスポート
        </a>
      </TopBar>
      <div className={`workbench${tab === "preview" || tab === "history" ? " no-inspector" : ""}${tab === "discovery" ? " is-board" : ""}`}>
        <Outline nodes={outline} selected={selectedId} onSelect={(n) => {
          setSelectedId(n.id);
          if (tab === "model") gotoPath(n.path);
        }} />
        <section className={`main${draftOffer && canEdit ? " has-notice" : ""}`}>
          <div className="tabs" role="tablist" aria-label="表示">
            {TABS.map((t) => (
              <button key={t.id} className="tab" role="tab" data-tour={`tab-${t.id}`} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === "model" && errors > 0 && <span className="sev-error small"> ✕{errors}</span>}
              </button>
            ))}
          </div>
          {draftOffer && canEdit && (
            <div className="merge-note" role="status" data-tour="draft-offer">
              <strong>前回の未保存の変更があります</strong>
              <span className="small">
                v{draftOffer.baseVersion} を元に {new Date(draftOffer.savedAt).toLocaleString()} まで編集した内容です。
                {draftOffer.baseVersion !== saved.version && ` その後 v${saved.version} が保存されています。復元して保存すると、差分を確認してからどちらを残すか選べます。`}
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="small-button primary"
                  onClick={() => {
                    setText(draftOffer.yaml);
                    // Saving against the version the draft was based on lets the normal conflict check show the diff.
                    if (draftOffer.baseVersion !== saved.version) setSaved({ version: draftOffer.baseVersion, yaml: saved.yaml });
                    setDraftOffer(undefined);
                    setStatus("未保存の変更を復元しました。確認して保存してください");
                  }}
                >
                  復元する
                </button>
                <button
                  className="quiet small-button"
                  onClick={() => {
                    clearDraft(id);
                    setDraftOffer(undefined);
                  }}
                >
                  破棄する
                </button>
              </div>
            </div>
          )}
          <div className={`tab-body${tab === "model" || tab === "diagram" || tab === "preview" || tab === "discovery" ? " fill" : ""}`} role="tabpanel">
            {tab === "discovery" && (
              <div className="board-page">
              <BoardTabs
                projectId={id}
                current={board.id}
                canEdit={canEdit}
                refreshKey={boardsVersion}
                onSelect={selectBoard}
              />
              <BoardView
                key={board.id}
                boardId={board.id}
                boardName={board.name}
                user={me.user.username}
                model={result.model}
                projectId={id}
                canEdit={canEdit}
                modelText={text}
                aiActive={!!ai?.active}
                onImportNewBoard={async (name, imported) => {
                  const created = await api.createBoard(id, name);
                  await api.saveBoard(id, imported, 0, created.id);
                  selectBoard(created.id, created.name);
                  setBoardsVersion((v) => v + 1);
                  setStatus(`draw.io の図を新しいボード「${created.name}」に読み込みました`);
                }}
                onModelYaml={(yaml, msg) => {
                  setText(yaml);
                  setStatus(msg);
                }}
                onReflect={(yaml) => {
                  setText(yaml);
                  setStatus("ボードの内容をモデルに反映しました。差分を確認して保存してください");
                  navigate({ page: "project", id, tab: "model" });
                }}
              />
              </div>
            )}
            {tab === "model" && (
              <div className="editor-wrap" data-tour="editor">
                <YamlEditor
                  value={text}
                  onChange={setText}
                  diagnostics={diagnostics}
                  readOnly={!canEdit}
                  goto={goto}
                  onCursorLine={onCursorLine}
                  onMessage={setStatus}
                  onRenamed={noteRename}
                  ghost={
                    canEdit
                      ? {
                          llmEnabled: () => aiActive.current,
                          fetchLlm: async (t, o, signal) => {
                            const r = await api.assistInline(id, t, o, signal);
                            return r.suggestion ?? undefined;
                          },
                          onBusy: setAiBusy,
                        }
                      : undefined
                  }
                />
                <p className="editor-help small muted" data-tour="editor-help">
                  グレーの予測は Tab で確定・Esc で消す・⌥\ で今すぐ予測・Ctrl+Space 補完・F12 定義へ・F2 名前を一括変更
                  <span className="spacer" />
                  <span className={ai?.active ? "ai-on" : "muted"}>
                    {ai?.active ? `AI: オン（${ai.model}）${aiBusy ? " 考えています…" : ""}` : ai?.available ? "AI: オフ（ワークスペースの設定で有効化）" : "予測: ローカルのみ"}
                  </span>
                </p>
                {diagnostics.length > 0 && (
                  <div className="diagnostics" aria-label="診断" data-tour="diagnostics">
                    {diagnostics.map((d, i) => (
                      <button key={i} onClick={() => d.line && setGoto({ line: d.line, nonce: Date.now() })}>
                        <span className={`sev sev-${d.severity}`}>
                          {d.severity === "error" ? "✕ エラー" : d.severity === "warning" ? "▲ 警告" : "ⓘ 情報"}
                          <span className="muted">{d.line ? ` ${d.line}行` : ""}</span>
                        </span>
                        <span>
                          {d.element && <strong>{d.element}: </strong>}
                          {d.message}
                          {d.hint && <span className="diag-hint"> — {d.hint}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab === "diagram" && model && (
              <DiagramView model={model} analysis={result.analysis} diagnostics={diagnostics} positions={positions} canEdit={canEdit} selectedId={selectedId} onSelect={setSelectedId} onMove={onMove} />
            )}
            {tab === "rules" && <RulesView rules={rules} onGoto={gotoPath} onSelect={setSelectedId} />}
            {tab === "scenarios" && model && <ScenariosView model={model} onGoto={gotoPath} />}
            {tab === "preview" && <PreviewView projectId={id} version={saved.version} dirty={dirty} />}
            {tab === "history" && (
              <HistoryView
                projectId={id}
                currentVersion={saved.version}
                canEdit={canEdit}
                onRestore={(yaml, v) => {
                  setText(yaml);
                  setMessage(`v${v} に戻す`);
                  navigate({ page: "project", id, tab: "model" });
                }}
              />
            )}
            {(tab === "rules" || tab === "scenarios" || tab === "diagram") && !result.analysis && (
              <p className="error-banner" style={{ margin: 16 }}>
                モデルにエラーがあるため、最後に正しく読めた状態を表示しています。
              </p>
            )}
          </div>
          <footer className="statusbar" aria-live="polite">
            {errors > 0 ? (
              <span className="sev sev-error" data-tour="status">✕ エラー {errors}</span>
            ) : (
              <span className="sev" data-tour="status" style={{ color: "var(--ok)" }}>
                ✓ 検証OK
              </span>
            )}
            {warnings > 0 && <span className="sev sev-warning">▲ 警告 {warnings}</span>}
            <span>{dirty ? "未保存の変更あり" : `v${saved.version} 保存済み`}</span>
            {status && <span className="muted">{status}</span>}
            <div className="spacer" />
            {canEdit && (
              <>
                <input aria-label="変更の説明" placeholder="変更の説明（任意）" value={message} onChange={(e) => setMessage(e.target.value)} style={{ width: 220 }} />
                <button className="primary" data-tour="save-button" disabled={!dirty} onClick={() => void save()} title="Ctrl/Cmd + S">
                  保存
                </button>
              </>
            )}
          </footer>
        </section>
        {tab !== "preview" && tab !== "history" && tab !== "discovery" && (
          <Inspector node={selected} model={model} analysis={result.analysis} rules={rules} diagnostics={diagnostics} canEdit={canEdit} onEdit={onEdit} onGoto={gotoPath} onSelectId={setSelectedId} onPropose={(context, aggregate, kind) => setPropose({ context, aggregate, kind })} />
        )}
      </div>
      {propose && (
        <ProposeDialog
          projectId={id}
          text={text}
          context={propose.context}
          aggregate={propose.aggregate}
          initialKind={propose.kind}
          aiActive={!!ai?.active}
          onClose={() => setPropose(undefined)}
          onApply={(yaml) => {
            setText(yaml);
            setPropose(undefined);
            setStatus("提案をモデルに適用しました（未保存）。確認して保存してください。");
          }}
        />
      )}
      {coach && (
        <TutorialCoach
          projectId={id}
          currentTab={tab}
          draft={result.model}
          saved={savedCheck?.model}
          savedOk={!!savedCheck?.ok}
          savedVersion={saved.version}
          onOpenTab={(t) => navigate({ page: "project", id, tab: t })}
          onClose={() => {
            tutorialStore.hide();
            setCoach(false);
          }}
        />
      )}
      {conflict && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
          <div className="modal">
            <h2 id="conflict-title">ほかの人が先に v{conflict.version} を保存しました</h2>
            <p>あなたの変更はまだ保存されていません。相手の版との差分を確認して、どちらを残すか選んでください。</p>
            <div className="panel" style={{ maxHeight: 320, overflow: "auto" }}>
              <DiffView diff={unifiedDiff("model.ddd.yaml", conflict.theirs, text)} />
            </div>
            <p className="small muted">− が相手の版、＋ があなたの編集です。</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  setSaved({ version: conflict.version, yaml: conflict.theirs });
                  setText(conflict.theirs);
                  setConflict(undefined);
                  setStatus(`v${conflict.version} を読み込みました`);
                }}
              >
                相手の版を読み込む（自分の変更を破棄）
              </button>
              <button className="primary" onClick={() => void save(conflict.version)}>
                自分の編集を v{conflict.version + 1} として保存
              </button>
              <button className="quiet" onClick={() => setConflict(undefined)}>
                閉じて編集を続ける
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
