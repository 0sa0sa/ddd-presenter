import { boardToModel, STICKY_KINDS, unifiedDiff, type Board, type NameRequest } from "@ddd/core";
import { useMemo, useState } from "react";
import { DiffView } from "../DiffView.tsx";

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

function currentName(board: Board, r: NameRequest): string {
  return board.items.find((i) => i.id === r.id)?.codeName ?? board.frames.find((f) => f.id === r.id)?.codeName ?? (r.id === "__default_context" ? "Core" : r.suggested);
}

export function ReflectDialog({ board, modelText, canEdit, onClose, onApply }: { board: Board; modelText: string; canEdit: boolean; onClose: () => void; onApply: (yaml: string, names: Record<string, string>) => void }) {
  const first = useMemo(() => boardToModel(board, modelText), [board, modelText]);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(first.names.map((r) => [r.id, currentName(board, r)])));
  const result = useMemo(() => boardToModel(board, modelText, Object.fromEntries(Object.entries(names).filter(([, v]) => v))), [board, modelText, names]);
  const diff = useMemo(() => (result.yaml ? unifiedDiff("model.ddd.yaml", modelText, result.yaml) : ""), [result.yaml, modelText]);
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const kindLabel = (r: NameRequest) => (r.kind === "context" ? "コンテキスト" : STICKY_KINDS[r.kind].label);
  const valid = (r: NameRequest) => (r.style === "pascal" ? PASCAL : SNAKE).test(names[r.id] ?? "");

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reflect-title">
      <div className="modal reflect">
        <h2 id="reflect-title">ボードをモデルに反映</h2>
        <p className="small">
          集約・コマンド・イベントを、モデル（YAML）の Aggregate・操作・Use case・イベントとして追加します。既存の要素は変更しません。適用すると YAML エディタに未保存の変更として入るので、確認してから保存してください。
        </p>

        {result.error && !result.missing.length && (
          <p className="error-banner" role="alert">
            {result.error}
          </p>
        )}

        {result.names.length > 0 && (
          <section className="stack" style={{ gap: 6 }}>
            <h3>モデルでの名前</h3>
            <p className="small muted">付箋のラベルはそのまま用語集に残ります。コードで使う英字の名前だけ決めてください（次回以降はボードに記憶されます）。</p>
            <div className="reflect-names" data-tour="reflect-names">
              {result.names.map((r) => (
                <label key={r.id} className={`reflect-name${valid(r) ? "" : " is-invalid"}`}>
                  <span className="small muted">{kindLabel(r)}</span>
                  <span className="reflect-label">{r.text || "（無題）"}</span>
                  <input
                    aria-label={`${r.text} のモデルでの名前`}
                    value={names[r.id] ?? ""}
                    placeholder={r.style === "pascal" ? "PascalCase" : "snake_case"}
                    disabled={!canEdit}
                    onChange={(e) => setNames({ ...names, [r.id]: e.target.value.trim() })}
                  />
                </label>
              ))}
            </div>
            {result.missing.length > 0 && <p className="small sev-warning">▲ あと {result.missing.length} 個の名前が必要です（{result.missing[0]!.style === "pascal" ? "PascalCase" : "snake_case"} の英字）</p>}
          </section>
        )}

        {result.summary.length > 0 && (
          <section>
            <h3>追加される内容</h3>
            <ul className="small">
              {result.summary.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        )}

        {result.skipped.length > 0 && (
          <details className="small">
            <summary>モデルに入らない付箋（{result.skipped.length}）</summary>
            <ul>
              {result.skipped.map((s) => (
                <li key={s.id}>
                  {s.text || "（無題）"} — <span className="muted">{s.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {errors.length > 0 && (
          <div className="error-banner small">
            {errors.slice(0, 5).map((d, i) => (
              <div key={i}>
                ✕ {d.element ? `${d.element}: ` : ""}
                {d.message}
              </div>
            ))}
          </div>
        )}

        {result.yaml && (
          <section className="stack" style={{ gap: 6 }}>
            <h3>
              差分 <span className="small muted">{warnings.length ? `（警告 ${warnings.length} 件: 操作の状態変更や Rule は YAML で書き足します）` : ""}</span>
            </h3>
            <div className="panel" style={{ maxHeight: 320, overflow: "auto" }}>
              <DiffView diff={diff} />
            </div>
          </section>
        )}

        <div className="row">
          <button className="primary" data-tour="reflect-apply" disabled={!canEdit || !result.ok || !result.yaml} onClick={() => onApply(result.yaml!, Object.fromEntries(result.names.map((r) => [r.id, names[r.id] ?? ""]).filter(([, v]) => v)))}>
            モデルに反映（未保存の変更として）
          </button>
          <button className="quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
