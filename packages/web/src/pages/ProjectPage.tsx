import { applyEdits, parseModel, ruleUsage, unifiedDiff, validateModelText, type Diagnostic, type EditOp, type ModelIR, type Path } from "@ddd/core";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError, type Me, type Role } from "../api.ts";
import { href, navigate } from "../App.tsx";
import { DiagramView } from "../components/DiagramView.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { HistoryView } from "../components/HistoryView.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { Outline } from "../components/Outline.tsx";
import { PreviewView } from "../components/PreviewView.tsx";
import { RulesView } from "../components/RulesView.tsx";
import { ScenariosView } from "../components/ScenariosView.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { YamlEditor, type GotoRequest } from "../components/YamlEditor.tsx";
import { buildOutline, flatten } from "../lib/outline.ts";
import { BoardView } from "../components/board/BoardView.tsx";

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

  const canEdit = role !== "viewer";
  const dirty = saved !== undefined && text !== saved.yaml;

  useEffect(() => {
    Promise.all([api.project(id), api.model(id), api.layout(id)]).then(
      ([p, m, l]) => {
        setProject(p.project);
        setRole(p.role);
        setSaved({ version: m.version, yaml: m.yaml });
        setText(m.yaml);
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
      setText(r.text);
      return undefined;
    },
    [text],
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
        <a className="small" href={`/api/projects/${id}/export`} download>
          YAMLをエクスポート
        </a>
      </TopBar>
      <div className={`workbench${tab === "preview" || tab === "history" ? " no-inspector" : ""}${tab === "discovery" ? " is-board" : ""}`}>
        <Outline nodes={outline} selected={selectedId} onSelect={(n) => {
          setSelectedId(n.id);
          if (tab === "model") gotoPath(n.path);
        }} />
        <section className="main">
          <div className="tabs" role="tablist" aria-label="表示">
            {TABS.map((t) => (
              <button key={t.id} className="tab" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === "model" && errors > 0 && <span className="sev-error small"> ✕{errors}</span>}
              </button>
            ))}
          </div>
          <div className={`tab-body${tab === "model" || tab === "diagram" || tab === "preview" || tab === "discovery" ? " fill" : ""}`} role="tabpanel">
            {tab === "discovery" && (
              <BoardView
                projectId={id}
                canEdit={canEdit}
                modelText={text}
                onReflect={(yaml) => {
                  setText(yaml);
                  setStatus("ボードの内容をモデルに反映しました。差分を確認して保存してください");
                  navigate({ page: "project", id, tab: "model" });
                }}
              />
            )}
            {tab === "model" && (
              <div className="editor-wrap">
                <YamlEditor value={text} onChange={setText} diagnostics={diagnostics} readOnly={!canEdit} goto={goto} onCursorLine={onCursorLine} onMessage={setStatus} />
                <p className="editor-help small muted">Ctrl+Space 補完・ホバーで説明・⌘/Ctrl+クリック または F12 で定義へ・F2 で名前を一括変更</p>
                {diagnostics.length > 0 && (
                  <div className="diagnostics" aria-label="診断">
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
              <span className="sev sev-error">✕ エラー {errors}</span>
            ) : (
              <span className="sev" style={{ color: "var(--ok)" }}>
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
                <button className="primary" disabled={!dirty} onClick={() => void save()} title="Ctrl/Cmd + S">
                  保存
                </button>
              </>
            )}
          </footer>
        </section>
        {tab !== "preview" && tab !== "history" && tab !== "discovery" && (
          <Inspector node={selected} model={model} analysis={result.analysis} rules={rules} diagnostics={diagnostics} canEdit={canEdit} onEdit={onEdit} onGoto={gotoPath} onSelectId={setSelectedId} />
        )}
      </div>
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
