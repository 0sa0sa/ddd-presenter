import { STICKY_KINDS, SUBDOMAIN_LABEL, suggestCodeName, type Board, type BoardItem, type StickyKind, type Subdomain } from "@ddd/core";
import { useEffect, useState } from "react";
import { addComment, newId, removeComment, removeIds, updateConnector, updateFrame, updateItem, updateLane } from "../../lib/boardOps.ts";
import { STICKY_GLYPH } from "./nodes.tsx";

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

function Field({ label, value, onCommit, placeholder, multiline, invalid, disabled }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; invalid?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    value: draft,
    placeholder,
    disabled,
    "aria-invalid": !!invalid,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
  };
  return (
    <label className="field">
      {label}
      {multiline ? (
        <textarea rows={3} {...common} style={{ fontFamily: "var(--font-ui)", fontSize: 13 }} />
      ) : (
        <input {...common} onKeyDown={(e) => e.key === "Enter" && commit()} />
      )}
      {invalid && <span className="small sev-warning">▲ {invalid}</span>}
    </label>
  );
}

/** Discussion on a sticky: what people asked or decided, kept next to it. */
function Comments({ board, item, user, canEdit, onChange }: { board: Board; item: BoardItem; user: string; canEdit: boolean; onChange: (b: Board) => void }) {
  const [draft, setDraft] = useState("");
  const comments = item.comments ?? [];
  return (
    <div className="stack comments" style={{ gap: 6 }}>
      <h4 className="small">コメント{comments.length ? `（${comments.length}）` : ""}</h4>
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="small muted">
            {c.author}・{c.at ? new Date(c.at).toLocaleString() : ""}
            {canEdit && c.author === user && (
              <button className="linklike small" onClick={() => onChange(removeComment(board, item.id, c.id))}>
                削除
              </button>
            )}
          </div>
          <div className="small comment-text">{c.text}</div>
        </div>
      ))}
      {canEdit && (
        <form
          className="stack"
          style={{ gap: 4 }}
          onSubmit={(e) => {
            e.preventDefault();
            onChange(addComment(board, item.id, user, draft));
            setDraft("");
          }}
        >
          <textarea rows={2} value={draft} placeholder="質問・補足・決まったこと" aria-label="コメント" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="small-button" disabled={!draft.trim()}>
            コメントする
          </button>
        </form>
      )}
    </div>
  );
}

export function ItemPanel({
  board,
  selectedIds,
  selectedEdgeId,
  canEdit,
  user,
  onChange,
  onEdit,
}: {
  board: Board;
  selectedIds: string[];
  selectedEdgeId?: string;
  canEdit: boolean;
  user: string;
  onChange: (b: Board) => void;
  onEdit: (id: string) => void;
}) {
  const lane = selectedIds.length === 1 ? board.lanes?.find((l) => l.id === selectedIds[0]) : undefined;
  if (lane) {
    return (
      <section className="board-panel">
        <h3>☰ スイムレーン</h3>
        <p className="small muted">人・部署・プロセスごとに横の帯で分けて、誰の流れかを見やすくします。上下に動かしたり高さを変えたりできます。</p>
        <Field label="名前" value={lane.title} disabled={!canEdit} onCommit={(v) => onChange(updateLane(board, lane.id, { title: v }))} />
        {canEdit && (
          <button className="danger" onClick={() => onChange(removeIds(board, [lane.id]))}>
            レーンを削除（付箋は残る）
          </button>
        )}
      </section>
    );
  }
  const items = board.items.filter((i) => selectedIds.includes(i.id));
  const frames = board.frames.filter((f) => selectedIds.includes(f.id));
  const edge = board.connectors.find((c) => c.id === selectedEdgeId);

  if (edge && selectedIds.length === 0) {
    const from = board.items.find((i) => i.id === edge.from);
    const to = board.items.find((i) => i.id === edge.to);
    return (
      <section className="board-panel">
        <h3>矢印</h3>
        <p className="small">
          {from?.text || "無題"} → {to?.text || "無題"}
        </p>
        <Field label="ラベル" value={edge.label ?? ""} disabled={!canEdit} onCommit={(v) => onChange(updateConnector(board, edge.id, { label: v }))} />
        {canEdit && (
          <button className="danger" onClick={() => onChange(removeIds(board, [edge.id]))}>
            矢印を削除
          </button>
        )}
      </section>
    );
  }

  if (items.length + frames.length > 1) {
    const all = [...items, ...frames];
    return (
      <section className="board-panel">
        <h3>{all.length} 個を選択中</h3>
        {canEdit && (
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button
              data-tour="item-wrap-context"
              onClick={() => {
                const pad = 40;
                const minX = Math.min(...items.map((i) => i.x)) - pad;
                const minY = Math.min(...items.map((i) => i.y)) - pad - 20;
                const maxX = Math.max(...items.map((i) => i.x + i.w)) + pad;
                const maxY = Math.max(...items.map((i) => i.y + i.h)) + pad;
                onChange({ ...board, frames: [...board.frames, { id: newId("f"), title: "", x: minX, y: minY, w: maxX - minX, h: maxY - minY }] });
              }}
              disabled={items.length === 0}
              title="選んだ付箋をコンテキストのフレームで囲みます"
            >
              コンテキストで囲む
            </button>
            <button className="danger" onClick={() => onChange(removeIds(board, all.map((x) => x.id)))}>
              削除
            </button>
          </div>
        )}
      </section>
    );
  }

  const item = items[0];
  if (item) {
    const meta = STICKY_KINDS[item.kind];
    const suggested = meta.code ? suggestCodeName(item.text, meta.code) : "";
    const invalid = item.codeName && meta.code && !(meta.code === "pascal" ? PASCAL : SNAKE).test(item.codeName) ? (meta.code === "pascal" ? "PascalCase の英字で書きます（例: InvitationAccepted）" : "snake_case の英字で書きます（例: accept_invitation）") : undefined;
    return (
      <section className="board-panel">
        <h3 className={`sticky-title sticky-${item.kind}-text`}>
          <span aria-hidden>{STICKY_GLYPH[item.kind]}</span> {meta.label}
        </h3>
        <p className="small muted">{meta.help}</p>
        <label className="field">
          種類
          <select disabled={!canEdit} value={item.kind} onChange={(e) => onChange(updateItem(board, item.id, { kind: e.target.value as StickyKind }))}>
            {(Object.keys(STICKY_KINDS) as StickyKind[]).map((k) => (
              <option key={k} value={k}>
                {STICKY_KINDS[k].label}
              </option>
            ))}
          </select>
        </label>
        <Field label="テキスト" value={item.text} multiline disabled={!canEdit} onCommit={(v) => onChange(updateItem(board, item.id, { text: v }))} />
        {meta.code && (
          <Field
            label={`モデルでの名前（${meta.code === "pascal" ? "PascalCase" : "snake_case"}）`}
            value={item.codeName ?? ""}
            placeholder={suggested || (meta.code === "pascal" ? "例: InvitationAccepted" : "例: accept_invitation")}
            invalid={invalid}
            disabled={!canEdit}
            onCommit={(v) => onChange(updateItem(board, item.id, { codeName: v.trim() }))}
          />
        )}
        {item.kind === "command" && (
          <label className="small row" style={{ gap: 6 }}>
            <input type="checkbox" disabled={!canEdit} checked={!!item.creates} onChange={(e) => onChange(updateItem(board, item.id, { creates: e.target.checked }))} />
            このコマンドで集約を新しく作る（ファクトリになる）
          </label>
        )}
        {item.kind === "event" && (
          <label className="small row" style={{ gap: 6 }} title="業務の段階が変わる出来事。コンテキストの境界の手がかりになります">
            <input type="checkbox" disabled={!canEdit} checked={!!item.pivotal} onChange={(e) => onChange(updateItem(board, item.id, { pivotal: e.target.checked }))} />
            流れの節目になる出来事（ピボタルイベント）
          </label>
        )}
        {item.kind === "hotspot" && (
          <div className="stack" style={{ gap: 6 }}>
            <label className="small row" style={{ gap: 6 }}>
              <input type="checkbox" disabled={!canEdit} checked={!!item.resolved} onChange={(e) => onChange(updateItem(board, item.id, { resolved: e.target.checked }))} />
              結論が出た（解決済み）
            </label>
            {item.resolved && <Field label="結論" value={item.resolution ?? ""} multiline placeholder="例: 期限切れの招待は再送せず、新しく発行する" disabled={!canEdit} onCommit={(v) => onChange(updateItem(board, item.id, { resolution: v.trim() }))} />}
          </div>
        )}
        {item.votes?.length ? <p className="small">投票 {item.votes.length} 票（{[...new Set(item.votes)].join("、")}）</p> : null}
        {canEdit && (
          <div className="row">
            <button onClick={() => onEdit(item.id)}>テキストを編集</button>
            <button className="danger" onClick={() => onChange(removeIds(board, [item.id]))}>
              削除
            </button>
          </div>
        )}
        <Comments board={board} item={item} user={user} canEdit={canEdit} onChange={onChange} />
      </section>
    );
  }

  const frame = frames[0];
  if (frame) {
    const invalid = frame.codeName && !PASCAL.test(frame.codeName) ? "PascalCase の英字で書きます（例: StaffInvitation）" : undefined;
    return (
      <section className="board-panel">
        <h3>▭ コンテキスト（境界の候補）</h3>
        <p className="small muted">言葉の意味が変わる所・担当が変わる所が境界の目安です。中に置いた付箋はフレームと一緒に動きます。</p>
        <Field label="名前" value={frame.title} disabled={!canEdit} onCommit={(v) => onChange(updateFrame(board, frame.id, { title: v }))} />
        <fieldset className="stack subdomain-choice" disabled={!canEdit}>
          <legend className="small">サブドメインの分類</legend>
          {(Object.keys(SUBDOMAIN_LABEL) as Subdomain[]).map((k) => (
            <label key={k} className="small row" style={{ gap: 6 }}>
              <input type="radio" name={`subdomain-${frame.id}`} checked={frame.subdomain === k} onChange={() => onChange(updateFrame(board, frame.id, { subdomain: k }))} />
              <span className={`subdomain-badge subdomain-${k}`}>{SUBDOMAIN_LABEL[k].label}</span>
              {SUBDOMAIN_LABEL[k].help}
            </label>
          ))}
          {frame.subdomain && (
            <button type="button" className="linklike small" onClick={() => onChange(updateFrame(board, frame.id, { subdomain: undefined }))}>
              分類を外す
            </button>
          )}
        </fieldset>
        <Field label="モデルでの名前（PascalCase）" value={frame.codeName ?? ""} placeholder={suggestCodeName(frame.title, "pascal") || "例: StaffInvitation"} invalid={invalid} disabled={!canEdit} onCommit={(v) => onChange(updateFrame(board, frame.id, { codeName: v.trim() }))} />
        {canEdit && (
          <button className="danger" onClick={() => onChange(removeIds(board, [frame.id]))}>
            フレームを削除（中の付箋は残る）
          </button>
        )}
      </section>
    );
  }

  return null;
}
