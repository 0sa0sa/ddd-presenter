import { itemsInFrame, SUBDOMAIN_LABEL, type AggregateCandidate, type Board, type ContextLink, type Finding, type ModelIR } from "@ddd/core";
import { useState } from "react";
import { addConnector, addItem } from "../../lib/boardOps.ts";
import { SyncPanel } from "./SyncPanel.tsx";
import { WorkshopPanel } from "./WorkshopPanel.tsx";

type Tab = "workshop" | "hints" | "aggregates" | "contexts" | "model";

export function AssistPanel({
  board,
  findings,
  candidates,
  links,
  canEdit,
  onFocus,
  onChange,
  onReflect,
  model,
  user,
  voting,
  onVoting,
}: {
  model?: ModelIR;
  user: string;
  voting: boolean;
  onVoting: (on: boolean) => void;
  board: Board;
  findings: Finding[];
  candidates: AggregateCandidate[];
  links: ContextLink[];
  canEdit: boolean;
  onFocus: (ids: string[]) => void;
  onChange: (b: Board) => void;
  onReflect: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => (board.workshop ? "workshop" : "hints"));
  const text = (id: string) => board.items.find((i) => i.id === id)?.text || "無題";
  const frameTitle = (id: string) => board.frames.find((f) => f.id === id)?.title || "無題";
  const warnings = findings.filter((f) => f.severity === "warning").length;
  // A group needs an aggregate only when it contains commands; a lone event may be an outside fact.
  const shown = candidates.filter((c) => c.aggregateItemId || c.commandIds.length > 0);
  const unassigned = shown.filter((c) => !c.aggregateItemId);

  const placeAggregate = (c: AggregateCandidate) => {
    const r = addItem(board, "aggregate", { x: c.position.x + 100, y: c.position.y + 60 }, c.name ?? "");
    let b = r.board;
    for (const id of c.commandIds) b = addConnector(b, id, r.id);
    onChange(b);
    onFocus([r.id, ...c.commandIds, ...c.eventIds]);
  };

  return (
    <section className="board-panel assist" aria-label="整理の補助" data-tour="assist-panel">
      <div className="assist-head">
        <h3>整理の補助</h3>
        <button className="primary small-button" data-tour="assist-reflect" onClick={onReflect} title="集約・コマンド・イベントをモデル（YAML）に反映します。適用前に差分を確認できます">
          モデルに反映…
        </button>
      </div>
      <div className="tabs assist-tabs" role="tablist">
        <button className="tab" role="tab" data-tour="assist-tab-workshop" aria-selected={tab === "workshop"} onClick={() => setTab("workshop")}>
          進行
        </button>
        <button className="tab" role="tab" data-tour="assist-tab-hints" aria-selected={tab === "hints"} onClick={() => setTab("hints")}>
          ヒント{warnings ? ` ▲${warnings}` : ""}
        </button>
        <button className="tab" role="tab" data-tour="assist-tab-aggregates" aria-selected={tab === "aggregates"} onClick={() => setTab("aggregates")}>
          集約の候補{unassigned.length ? ` (${unassigned.length})` : ""}
        </button>
        <button className="tab" role="tab" data-tour="assist-tab-contexts" aria-selected={tab === "contexts"} onClick={() => setTab("contexts")}>
          コンテキスト
        </button>
        <button className="tab" role="tab" data-tour="assist-tab-model" aria-selected={tab === "model"} onClick={() => setTab("model")}>
          モデル
        </button>
      </div>

      {tab === "workshop" && <WorkshopPanel board={board} user={user} canEdit={canEdit} voting={voting} onVoting={onVoting} onChange={onChange} onFocus={onFocus} />}
      {tab === "model" && <SyncPanel board={board} model={model} canEdit={canEdit} onChange={onChange} onFocus={onFocus} onReflect={onReflect} />}

      {tab === "hints" && (
        <ul className="assist-list">
          {findings.length === 0 && <li className="muted small">気になる点はありません。ドメインエキスパートとシナリオを確認しましょう。</li>}
          {findings.map((f, i) => (
            <li key={i}>
              <button className="assist-item" onClick={() => onFocus(f.itemIds)} disabled={!f.itemIds.length}>
                <span className={`sev sev-${f.severity}`}>{f.severity === "warning" ? "▲" : "ⓘ"}</span>
                <span>
                  {f.message}
                  {f.hint && <span className="diag-hint"> — {f.hint}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "aggregates" && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small muted">
            矢印と配置から、同じものを変更するコマンドとイベントをまとめた候補です。集約にするか・どこで分けるかは皆さんで決めてください。一度の変更で必ず守るルールがあるまとまりが、集約の候補になります。
          </p>
          <ul className="assist-list" data-tour="assist-candidates">
            {shown.map((c) => (
              <li key={c.id} className="candidate">
                <button className="assist-item" onClick={() => onFocus([...(c.aggregateItemId ? [c.aggregateItemId] : []), ...c.commandIds, ...c.eventIds])}>
                  <span className="sticky-dot sticky-aggregate" aria-hidden />
                  <span>
                    <strong>{c.aggregateItemId ? text(c.aggregateItemId) : c.name ? `「${c.name}」（案）` : "担当する集約が未定"}</strong>
                    <span className="small muted">
                      {" "}
                      コマンド {c.commandIds.length}・イベント {c.eventIds.length}
                      {c.frameId ? `・${frameTitle(c.frameId)}` : ""}
                    </span>
                    <span className="diag-hint">
                      {" "}
                      — {c.reason}。{c.commandIds.map(text).join("、")}
                    </span>
                  </span>
                </button>
                {!c.aggregateItemId && canEdit && (
                  <button className="small-button" onClick={() => placeAggregate(c)}>
                    集約として置く
                  </button>
                )}
              </li>
            ))}
            {shown.length === 0 && <li className="small muted">コマンドとイベントを置いて矢印でつなぐと、候補が出ます。</li>}
          </ul>
          <details className="small">
            <summary>集約を決めるときの問い</summary>
            <ul>
              <li>一度の操作で、必ず同時に正しくなければならないものは何か（真の不変条件）</li>
              <li>それ以外は、イベントで少し遅れて伝われば十分ではないか（結果整合性）</li>
              <li>集約は小さく保ち、他の集約はIDで参照する</li>
              <li>同時に編集する人が多いものを1つの集約にまとめすぎていないか</li>
            </ul>
          </details>
        </div>
      )}

      {tab === "contexts" && (
        <div className="stack" style={{ gap: 8 }}>
          {board.frames.length === 0 ? (
            <p className="small muted">
              コンテキストの境界はまだありません。付箋を複数選んで「コンテキストで囲む」か、ツールバーの「コンテキスト」でフレームを置きます。言葉の意味が変わる所・担当チームが変わる所・ポリシーでつながる所が境界の候補です。
            </p>
          ) : (
            <ul className="assist-list">
              {board.frames.map((f) => {
                const inside = itemsInFrame(board, f);
                return (
                  <li key={f.id}>
                    <button className="assist-item" onClick={() => onFocus([f.id])}>
                      <span aria-hidden>▭</span>
                      <span>
                        <strong>{f.title || "無題"}</strong>
                        {f.subdomain && <span className={`subdomain-badge subdomain-${f.subdomain}`}>{SUBDOMAIN_LABEL[f.subdomain].label}</span>}
                        <span className="small muted">
                          {" "}
                          集約 {inside.filter((i) => i.kind === "aggregate").length}・コマンド {inside.filter((i) => i.kind === "command").length}・イベント {inside.filter((i) => i.kind === "event").length}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <h4 className="small">コンテキスト間の連携</h4>
          {links.length === 0 ? (
            <p className="small muted">フレームをまたぐ「イベント → ポリシー → コマンド」の矢印があると、ここに連携として表示されます。</p>
          ) : (
            <ul className="assist-list">
              {links.map((l, i) => (
                <li key={i}>
                  <button className="assist-item" onClick={() => onFocus([l.fromFrameId, l.toFrameId])}>
                    <span aria-hidden>⇢</span>
                    <span>
                      <strong>{frameTitle(l.fromFrameId)}</strong> → <strong>{frameTitle(l.toFrameId)}</strong>
                      <span className="diag-hint"> — {l.via.join(" → ")}（イベントで伝える）</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canEdit && tab === "aggregates" && unassigned.length > 0 && (
        <p className="small muted">「集約として置く」で付箋を置いたあと、モデルでの名前を付けてください。</p>
      )}
    </section>
  );
}
