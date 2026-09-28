import { addModelElementsToBoard, applyEdits, compareBoardWithModel, renameOnBoard, SUBDOMAIN_LABEL, type Board, type ModelElementRef, type ModelIR, type SyncKind } from "@ddd/core";
import { useMemo } from "react";

const KIND_LABEL: Record<SyncKind, string> = { context: "コンテキスト", aggregate: "集約", command: "コマンド（操作）", event: "イベント", policy: "ポリシー" };

/** The model → board direction: what the model has that the board lacks, and stickies the model no longer knows. */
export function SyncPanel({
  board,
  model,
  canEdit,
  onChange,
  onFocus,
  onReflect,
  modelText,
  onModelYaml,
}: {
  modelText: string;
  /** Puts an edited model into the editor (unsaved), like "モデルに反映". */
  onModelYaml: (yaml: string, message: string) => void;
  board: Board;
  model?: ModelIR;
  canEdit: boolean;
  onChange: (b: Board) => void;
  onFocus: (ids: string[]) => void;
  onReflect: () => void;
}) {
  const cmp = useMemo(() => (model ? compareBoardWithModel(board, model) : undefined), [board, model]);
  if (!model || !cmp) return <p className="small muted">モデル（YAML）にエラーがあるため比べられません。モデルのタブで直してください。</p>;

  const add = (elements: ModelElementRef[]) => {
    const r = addModelElementsToBoard(board, model, elements);
    onChange(r.board);
    if (r.added.length) onFocus(r.added);
  };
  const byKind = (kind: SyncKind) => cmp.missing.filter((m) => m.kind === kind);
  const inSync = !cmp.missing.length && !cmp.stale.length && !cmp.unreflected.length && !cmp.subdomains.length;
  const label = (s?: string) => (s ? SUBDOMAIN_LABEL[s as keyof typeof SUBDOMAIN_LABEL].label : "未分類");

  return (
    <div className="stack" style={{ gap: 10 }} data-tour="sync-panel">
      <p className="small muted">
        いまのモデル（YAML・未保存の変更を含む）とボードを比べます。付箋はモデルでの名前（英字）で要素と結び付いています（コンテキスト・集約・コマンド・イベント・ポリシー）。
      </p>
      {inSync && <p className="small">✓ ボードとモデルは一致しています（結び付いた付箋 {cmp.linked.length} 枚）。</p>}

      {cmp.stale.length > 0 && (
        <section className="stack" style={{ gap: 6 }}>
          <h4>モデルから消えた・名前が変わった付箋（{cmp.stale.length}）</h4>
          <ul className="assist-list">
            {cmp.stale.map((s) => (
              <li key={s.id} className="sync-row">
                <button className="assist-item" onClick={() => onFocus([s.id])}>
                  <span className="sev sev-warning">▲</span>
                  <span>
                    {s.text || "無題"} <code className="small">{s.codeName}</code>
                    <span className="small muted"> {KIND_LABEL[s.kind]}</span>
                  </span>
                </button>
                {canEdit && (
                  <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                    {s.candidates.slice(0, 3).map((c) => (
                      <button key={c} className="small-button" title={`付箋のモデルでの名前を ${c} に変えます`} onClick={() => onChange(renameOnBoard(board, s.codeName, c, [s.kind]))}>
                        → {c}
                      </button>
                    ))}
                    <button
                      className="quiet small-button"
                      title="結び付きを外し、未反映の付箋に戻します"
                      onClick={() =>
                        onChange({
                          ...board,
                          items: board.items.map((i) => (i.id === s.id ? { ...i, codeName: undefined } : i)),
                          frames: board.frames.map((f) => (f.id === s.id ? { ...f, codeName: undefined } : f)),
                        })
                      }
                    >
                      結び付きを外す
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cmp.subdomains.length > 0 && (
        <section className="stack" style={{ gap: 6 }}>
          <h4>サブドメインの分類が違うコンテキスト（{cmp.subdomains.length}）</h4>
          <ul className="assist-list">
            {cmp.subdomains.map((d) => (
              <li key={d.frameId} className="sync-row">
                <button className="assist-item" onClick={() => onFocus([d.frameId])}>
                  <span>
                    <code>{d.context}</code> ボード: {label(d.board)} ／ モデル: {label(d.model)}
                  </span>
                </button>
                {canEdit && (
                  <div className="row" style={{ gap: 4 }}>
                    <button className="small-button" onClick={() => onChange({ ...board, frames: board.frames.map((f) => (f.id === d.frameId ? { ...f, subdomain: d.model } : f)) })}>
                      ボードをモデルに合わせる
                    </button>
                    <button
                      className="small-button"
                      onClick={() => {
                        const idx = model.contexts.findIndex((c) => c.name === d.context);
                        const r = applyEdits(modelText, [d.board ? { op: "set", path: ["contexts", idx, "subdomain"], value: d.board } : { op: "remove", path: ["contexts", idx, "subdomain"] }]);
                        if (r.ok) onModelYaml(r.text, `${d.context} のサブドメインを「${label(d.board)}」にしました。差分を確認して保存してください`);
                      }}
                    >
                      モデルをボードに合わせる
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cmp.missing.length > 0 && (
        <section className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4>モデルにだけある要素（{cmp.missing.length}）</h4>
            {canEdit && (
              <button className="small-button primary" onClick={() => add(cmp.missing)} data-tour="sync-add-all">
                すべてボードに置く
              </button>
            )}
          </div>
          {(["context", "aggregate", "command", "event", "policy"] as SyncKind[]).map((k) =>
            byKind(k).length ? (
              <div key={k}>
                <h5 className="small muted">{KIND_LABEL[k]}</h5>
                <ul className="assist-list">
                  {byKind(k).map((m) => (
                    <li key={`${m.kind}:${m.context}:${m.name}`} className="sync-row">
                      <span className="small">
                        {m.label !== m.name && <>{m.label} </>}
                        <code>{m.name}</code>
                        {m.aggregate && m.kind !== "aggregate" && <span className="muted">（{m.aggregate}）</span>}
                      </span>
                      {canEdit && (
                        <button className="small-button" onClick={() => add([m])}>
                          置く
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </section>
      )}

      {cmp.unreflected.length > 0 && (
        <section className="stack" style={{ gap: 6 }}>
          <h4>まだモデルにない付箋（{cmp.unreflected.length}）</h4>
          <div className="row" style={{ gap: 6 }}>
            <button className="small-button" onClick={() => onFocus(cmp.unreflected)}>
              付箋を表示
            </button>
            {canEdit && (
              <button className="small-button" onClick={onReflect}>
                モデルに反映…
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
