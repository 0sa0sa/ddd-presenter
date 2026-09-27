import { STICKY_KINDS, suggestCodeName, type Board, type StickyKind } from "@ddd/core";
import { useEffect, useState } from "react";
import { newId, removeIds, updateConnector, updateFrame, updateItem } from "../../lib/boardOps.ts";
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

export function ItemPanel({ board, selectedIds, selectedEdgeId, canEdit, onChange, onEdit }: { board: Board; selectedIds: string[]; selectedEdgeId?: string; canEdit: boolean; onChange: (b: Board) => void; onEdit: (id: string) => void }) {
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
        {canEdit && (
          <div className="row">
            <button onClick={() => onEdit(item.id)}>テキストを編集</button>
            <button className="danger" onClick={() => onChange(removeIds(board, [item.id]))}>
              削除
            </button>
          </div>
        )}
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
