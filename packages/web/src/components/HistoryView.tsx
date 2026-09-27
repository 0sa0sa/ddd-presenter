import { useEffect, useState } from "react";
import { api, describeError, type VersionInfo } from "../api.ts";
import { DiffView } from "./DiffView.tsx";

export function HistoryView({ projectId, currentVersion, canEdit, onRestore }: { projectId: string; currentVersion: number; canEdit: boolean; onRestore: (yaml: string, from: number) => void }) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.versions(projectId).then(
      (r) => {
        setError(undefined);
        setVersions(r.versions);
        const [latest, prev] = r.versions;
        setTo(latest?.version);
        setFrom(prev?.version ?? latest?.version);
      },
      (e) => setError(describeError(e)),
    );
  }, [projectId, currentVersion]);

  useEffect(() => {
    if (from !== undefined && to !== undefined) api.diff(projectId, from, to).then((r) => setDiff(r.diff), (e) => setError(describeError(e)));
  }, [projectId, from, to]);

  return (
    <div className="view" style={{ maxWidth: "none" }}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>版</th>
              <th>メッセージ</th>
              <th>作成者</th>
              <th>日時</th>
              <th>比較</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{v.message || <span className="muted">—</span>}</td>
                <td>{v.author ?? "—"}</td>
                <td className="small">{new Date(v.created_at).toLocaleString()}</td>
                <td className="small">
                  <label>
                    <input type="radio" name="from" checked={from === v.version} onChange={() => setFrom(v.version)} /> 旧
                  </label>{" "}
                  <label>
                    <input type="radio" name="to" checked={to === v.version} onChange={() => setTo(v.version)} /> 新
                  </label>
                </td>
                {canEdit && (
                  <td>
                    {v.version !== currentVersion && (
                      <button className="quiet small" onClick={() => api.versionYaml(projectId, v.version).then((r) => onRestore(r.yaml, v.version), (e) => setError(describeError(e)))}>
                        この版を編集中に読み込む
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>
            v{from} → v{to} のモデル差分
          </h2>
        </div>
        {diff !== undefined && <DiffView diff={diff} />}
      </div>
    </div>
  );
}
