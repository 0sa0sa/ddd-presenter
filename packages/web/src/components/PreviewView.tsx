import { useEffect, useState } from "react";
import type { Diagnostic } from "@ddd/core";
import { api, ApiError, describeError, type Preview } from "../api.ts";
import { DiffView } from "./DiffView.tsx";

const ACTION_LABEL: Record<string, string> = {
  create: "追加",
  update: "変更",
  unchanged: "変更なし",
  stale: "不要になる",
  keep: "顧客所有",
  conflict: "衝突",
};

export function PreviewView({ projectId, version, dirty }: { projectId: string; version: number; dirty: boolean }) {
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<{ message: string; offline: boolean; diagnostics: Diagnostic[] }>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [mode, setMode] = useState<"diff" | "file">("diff");
  const [showUnchanged, setShowUnchanged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setLoading(true);
    api.preview(projectId, version).then(
      (p) => {
        if (cancelled) return;
        setLoading(false);
        setPreview(p);
        const first = p.plan.find((e) => e.action === "update" || e.action === "stale") ?? p.plan.find((e) => e.path.endsWith("aggregates.py"));
        setSelected(first?.path);
        setMode(first?.diff ? "diff" : "file");
      },
      (e) => {
        if (cancelled) return;
        setLoading(false);
        setPreview(undefined);
        const diagnostics = e instanceof ApiError && Array.isArray(e.body.diagnostics) ? (e.body.diagnostics as Diagnostic[]) : [];
        const errors = diagnostics.filter((d) => d.severity === "error");
        setError({
          message: errors.length ? `v${version} のモデルにエラーがあるため、コードを生成できません。` : describeError(e),
          offline: e instanceof ApiError && e.status === 0,
          diagnostics: errors,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, version, attempt]);

  if (error) {
    return (
      <div className="view">
        <p className="error-banner" role="alert">
          {error.message}
        </p>
        {error.diagnostics.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>v{version} のモデルにあるエラー</h2>
            </div>
            <ul className="list small">
              {error.diagnostics.map((d, i) => (
                <li key={i}>
                  <span className="sev sev-error">✕ {d.line ? `${d.line}行` : ""}</span>
                  <span>
                    {d.element && <strong>{d.element}: </strong>}
                    {d.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="muted">
          プレビューは保存済みのバージョン v{version} から作ります。
          {error.diagnostics.length > 0 && " エラーを直して保存すると表示できます。"}
          {dirty && " 未保存の変更はプレビューに含まれません。"}
        </p>
        <div>
          <button onClick={() => setAttempt((n) => n + 1)} disabled={loading}>
            {loading ? "再試行しています…" : error.offline ? "再接続する" : "もう一度読み込む"}
          </button>
        </div>
      </div>
    );
  }
  if (!preview) return <div className="view muted">生成しています…</div>;

  const entry = preview.plan.find((e) => e.path === selected);
  const file = preview.files.find((f) => f.path === selected);
  const visible = preview.plan.filter((e) => showUnchanged || (e.action !== "unchanged" && e.action !== "keep"));
  const count = (a: string) => preview.plan.filter((e) => e.action === a).length;

  return (
    <div className="preview">
      <div className="file-list" aria-label="生成されるファイル" data-tour="preview-files">
        <div className="stack" style={{ padding: 12, gap: 8 }}>
          <p className="small">
            v{preview.version} の生成結果{preview.base_version ? `（v${preview.base_version} との比較）` : "（初回）"}
          </p>
          {dirty && <p className="small sev-warning">▲ 未保存の変更は含まれていません。保存すると反映されます。</p>}
          <p className="small muted">
            追加 {count("create")}・変更 {count("update")}・不要 {count("stale")}・変更なし {count("unchanged")}
          </p>
          <label className="small row" style={{ gap: 4 }}>
            <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
            変更のないファイルも表示
          </label>
          <a className="small" href={`/api/projects/${projectId}/preview.zip?version=${preview.version}`} download>
            ZIPでダウンロード（レビュー用）
          </a>
        </div>
        {preview.breaking.length > 0 && (
          <div className="stack small" style={{ padding: "0 12px 12px", gap: 4 }}>
            <span className="sev sev-warning">▲ 生成APIの破壊的変更 {preview.breaking.length} 件</span>
            {preview.breaking.map((b) => (
              <span key={b.path + b.symbol} className="mono">
                {b.symbol} <span className="muted">— {b.reason}</span>
              </span>
            ))}
          </div>
        )}
        {visible.map((e) => (
          <button key={e.path} className="file-item" aria-current={selected === e.path} onClick={() => {
            setSelected(e.path);
            setMode(e.diff ? "diff" : "file");
          }}>
            <span className={`action action-${e.action}`}>{ACTION_LABEL[e.action]}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={e.path}>
              {e.path.replace(/^src\/[^/]+\/generated\//, "…/")}
            </span>
          </button>
        ))}
      </div>
      <div style={{ overflow: "auto", minWidth: 0 }}>
        {entry && (
          <div className="row" style={{ padding: "8px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)", position: "sticky", top: 0 }}>
            <span className="mono small">{entry.path}</span>
            {entry.ownership === "scaffold" && <span className="role">初回のみ作成・以後は顧客所有</span>}
            <div className="spacer" />
            {entry.diff && (
              <div role="tablist" className="row" style={{ gap: 0 }}>
                <button className="tab" role="tab" aria-selected={mode === "diff"} onClick={() => setMode("diff")}>
                  差分
                </button>
                <button className="tab" role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")} disabled={!file}>
                  ファイル
                </button>
              </div>
            )}
          </div>
        )}
        {entry && mode === "diff" && entry.diff !== undefined ? <DiffView diff={entry.diff} /> : file ? <pre className="code">{file.content}</pre> : <p className="muted" style={{ padding: 16 }}>ファイルを選んでください。</p>}
      </div>
    </div>
  );
}
