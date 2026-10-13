import { isModelSource, sourceKind, splitModelText, splitToYaml, validateModelFiles, type Diagnostic } from "@ddd/core";
import { useMemo, useState } from "react";
import { downloadBlob, safeFileName } from "../lib/download.ts";
import { createZip, readZip, stripCommonFolder } from "../lib/zip.ts";

interface Imported {
  files: Record<string, string>;
  yaml?: string;
  diagnostics: Diagnostic[];
}

/** Dependencies, virtual environments and generated code: never model sources (the CLI skips them too). */
const SKIP = /(^|\/)(\.[^/]*|node_modules|__pycache__|dist|build|venv|generated)\//;

/** Only the model's sources: other .proto files (dependencies, other services) are left out. */
function modelSources(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([p, t]) => !SKIP.test(p) && isModelSource(p, t)));
}

/** Reads the chosen files (one ZIP, several files, or a folder) as path → text. */
async function readChosen(list: FileList): Promise<Record<string, string>> {
  const chosen = [...list];
  if (chosen.length === 1 && /\.zip$/i.test(chosen[0]!.name)) return stripCommonFolder(modelSources(await readZip(new Uint8Array(await chosen[0]!.arrayBuffer()))));
  const files: Record<string, string> = {};
  for (const f of chosen) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (sourceKind(path) && !SKIP.test(path) && f.size <= 5 * 1024 * 1024) files[path] = await f.text();
  }
  return stripCommonFolder(modelSources(files));
}

const where = (d: Diagnostic) => `${d.file ?? "ddd.yaml"}${d.line ? `:${d.line}` : ""}`;

/** The model in the multi-file format (docs/10 §12): download it as a ZIP, or bring such files into the editor as YAML. */
export function SplitFormatDialog({ text, project, canEdit, onClose, onImport }: { text: string; project: string; canEdit: boolean; onClose: () => void; onImport: (yaml: string, message: string) => void }) {
  const out = useMemo(() => splitModelText(text), [text]);
  /** The files as edited in this dialog (undefined until the first edit). */
  const [edited, setEdited] = useState<Record<string, string>>();
  const current = edited ?? out.files;
  const paths = Object.keys(current);
  const [selected, setSelected] = useState(() => paths.find((p) => p.endsWith(".flow")) ?? paths[0]);
  const check = useMemo(() => (edited ? validateModelFiles(edited) : undefined), [edited]);
  const editedYaml = useMemo(() => (edited ? splitToYaml(edited).yaml : undefined), [edited]);
  const editErrors = check?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const perFile = (p: string) => editErrors.filter((d) => (d.file ?? "ddd.yaml") === p).length;
  const applyEdits = () => {
    if (editedYaml) onImport(editedYaml, "複数ファイル形式での編集をモデルに反映しました。差分を確認して保存してください");
  };
  const [imported, setImported] = useState<Imported>();
  const [error, setError] = useState<string>();

  const choose = async (list: FileList | null) => {
    setError(undefined);
    setImported(undefined);
    if (!list?.length) return;
    try {
      const files = await readChosen(list);
      if (!Object.keys(files).length) {
        setError("モデルのファイル（ddd.yaml、.proto、.domain、.flow、.scenarios.yaml）が見つかりませんでした");
        return;
      }
      const back = splitToYaml(files);
      const diagnostics = back.yaml ? validateModelFiles(files).diagnostics : back.diagnostics;
      setImported({ files, yaml: back.yaml, diagnostics });
    } catch (e) {
      setError(`読み込めませんでした: ${(e as Error).message}`);
    }
  };

  const errors = imported?.diagnostics.filter((d) => d.severity === "error") ?? [];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="split-title">
      <div className="modal split-format">
        <h2 id="split-title">複数ファイル形式（.proto / .domain / .flow）</h2>
        <p className="small muted">
          モデルを層ごとのファイルに分けた形式です。<code>.proto</code> にデータの形と契約、<code>.domain</code> に集約の規則、<code>.flow</code> に Use case の手順を書きます。生成されるコードは YAML と同じです。ここで編集した内容は YAML に変換してモデルに反映します（保存されるのは YAML。説明でないコメントは残りません）。CLI（<code>ddd validate &lt;フォルダ&gt;</code>）と VS Code 拡張機能でも編集できます。
        </p>

        <section className="stack" style={{ gap: 6 }}>
          <h3>{canEdit ? "見る・編集する・書き出す" : "見る・書き出す"}</h3>
          {paths.length === 0 ? (
            <p className="small">モデルにエラーがあるため書き出せません。モデルのタブでエラーを直してください。</p>
          ) : (
            <>
              <div className="split-files" role="tablist" aria-label="ファイル">
                {paths.map((p) => (
                  <button key={p} role="tab" aria-selected={p === selected} className="small-button" onClick={() => setSelected(p)}>
                    {p}
                    {edited && edited[p] !== out.files[p] ? " ●" : ""}
                    {perFile(p) > 0 && <span className="sev-error"> ✕{perFile(p)}</span>}
                  </button>
                ))}
              </div>
              {canEdit ? (
                <textarea
                  className="split-preview split-editor"
                  aria-label={`${selected} の内容`}
                  spellCheck={false}
                  value={selected ? current[selected] ?? "" : ""}
                  onChange={(e) => selected && setEdited({ ...current, [selected]: e.target.value })}
                />
              ) : (
                <pre className="split-preview" aria-label={`${selected} の内容`}>
                  {selected ? current[selected] : ""}
                </pre>
              )}
              {check && (
                <div className="stack" style={{ gap: 4 }}>
                  <p className="small">{editErrors.length ? `編集した内容にエラーが ${editErrors.length} 件あります` : "編集した内容にエラーはありません"}</p>
                  {check.diagnostics.length > 0 && (
                    <ul className="split-diagnostics small">
                      {check.diagnostics.slice(0, 20).map((d, i) => (
                        <li key={i}>
                          <button className="link-button" onClick={() => d.file && setSelected(d.file)}>
                            <span className={`sev sev-${d.severity}`}>{d.severity === "error" ? "✕" : d.severity === "warning" ? "▲" : "ⓘ"}</span> <code>{where(d)}</code> {d.message}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className={edited ? "" : "primary"} onClick={() => downloadBlob(new Blob([createZip(current) as BlobPart], { type: "application/zip" }), `${safeFileName(project)}-model.zip`)}>
                  ZIP で書き出す（{paths.length} ファイル）
                </button>
                {canEdit && edited && (
                  <>
                    <button className="primary" disabled={!editedYaml} onClick={applyEdits} title="YAML に変換してエディタに入れます（保存はまだしません）">
                      編集をモデルに反映
                    </button>
                    <button className="quiet" onClick={() => setEdited(undefined)}>
                      編集を取り消す
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>

        {canEdit && (
          <section className="stack" style={{ gap: 6 }}>
            <h3>読み込む</h3>
            <p className="small muted">ZIP、複数のファイル、またはフォルダを選びます。YAML に変換してエディタに入れます（保存はまだしません）。.proto / .domain / .flow のコメントのうち、説明でないものは YAML には残りません。</p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="small-button file-button">
                ファイルを選ぶ…
                <input type="file" multiple accept=".zip,.proto,.domain,.flow,.yaml,.yml" onChange={(e) => void choose(e.target.files)} hidden />
              </label>
              <label className="small-button file-button">
                フォルダを選ぶ…
                <input type="file" {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => void choose(e.target.files)} hidden />
              </label>
            </div>
            {error && <p className="small sev-error">{error}</p>}
            {imported && (
              <div className="stack" style={{ gap: 4 }}>
                <p className="small">
                  {Object.keys(imported.files).length} ファイル（{Object.keys(imported.files).sort().join("、")}）
                  {errors.length ? `。エラー ${errors.length} 件` : "。エラーはありません"}
                </p>
                {imported.diagnostics.length > 0 && (
                  <ul className="split-diagnostics small">
                    {imported.diagnostics.slice(0, 20).map((d, i) => (
                      <li key={i}>
                        <span className={`sev sev-${d.severity}`}>{d.severity === "error" ? "✕" : d.severity === "warning" ? "▲" : "ⓘ"}</span> <code>{where(d)}</code> {d.message}
                      </li>
                    ))}
                  </ul>
                )}
                {!imported.yaml && <p className="small">構文の誤りがあるため YAML に変換できません。上の場所を直してから選び直してください。</p>}
              </div>
            )}
          </section>
        )}

        <div className="row modal-actions">
          {canEdit && (
            <button
              className="primary"
              disabled={!imported?.yaml}
              onClick={() => imported?.yaml && onImport(imported.yaml, `複数ファイル形式から読み込みました（${Object.keys(imported.files).length} ファイル）。差分を確認して保存してください`)}
            >
              エディタに取り込む
            </button>
          )}
          <button className="quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
