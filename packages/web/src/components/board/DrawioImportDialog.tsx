import { drawioToBoard, emptyBoard, STICKY_KINDS, type Board, type DrawioPage, type DrawioTarget, type StickyKind } from "@ddd/core";
import { useMemo, useState } from "react";

const TARGETS: { value: DrawioTarget; label: string }[] = [
  ...(Object.keys(STICKY_KINDS) as StickyKind[]).map((k) => ({ value: k as DrawioTarget, label: STICKY_KINDS[k].label })),
  { value: "frame", label: "コンテキストの枠" },
  { value: "ignore", label: "読み込まない" },
];
const labelOf = (t: DrawioTarget) => TARGETS.find((x) => x.value === t)?.label ?? t;

/** Reviews a draw.io file before it lands on the board: page, colour → sticky kind, and where to put it. */
export function DrawioImportDialog({
  fileName,
  pages,
  board,
  onClose,
  onImportHere,
  onImportNewBoard,
}: {
  fileName: string;
  pages: DrawioPage[];
  board: Board;
  onClose: () => void;
  onImportHere: (next: Board, added: string[]) => void;
  onImportNewBoard: (name: string, next: Board) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const page = pages[pageIndex]!;
  const [mappings, setMappings] = useState<Record<number, Record<string, DrawioTarget>>>({});
  const mapping = mappings[pageIndex] ?? {};
  const [dest, setDest] = useState<"here" | "new">(board.items.length ? "new" : "here");
  const [name, setName] = useState(() => (pages.length > 1 ? page.name : fileName.replace(/\.(drawio\.svg|drawio|xml|svg)$/i, "")));

  const result = useMemo(() => drawioToBoard(page, dest === "here" ? board : emptyBoard(), mapping, dest === "here" ? undefined : { x: 0, y: 0 }), [page, dest, board, mapping]);
  const byShape = page.shapes.filter((s) => s.shapeKind && s.shapeKind !== "ignore");
  const total = Object.values(result.counts).reduce((a, b) => a + (b ?? 0), 0);

  const setTarget = (fill: string, t: DrawioTarget) => setMappings({ ...mappings, [pageIndex]: { ...mapping, [fill]: t } });

  const run = () => {
    if (dest === "new") onImportNewBoard(name.trim() || page.name, result.board);
    else {
      const before = new Set([...board.items.map((i) => i.id), ...board.frames.map((f) => f.id)]);
      onImportHere(result.board, [...result.board.items, ...result.board.frames].map((x) => x.id).filter((id) => !before.has(id)));
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="drawio-title">
      <div className="modal reflect">
        <h2 id="drawio-title">draw.io を読み込む</h2>
        <p className="small muted">
          {fileName} の図形を付箋に、矢印を付箋の間の矢印に、枠（コンテナや大きな点線の四角）をコンテキストの枠にします。付箋の種類は図形の色で決めます。色ごとの対応を確かめてから読み込んでください。
        </p>

        {pages.length > 1 && (
          <label className="field">
            ページ
            <select
              value={pageIndex}
              onChange={(e) => {
                const i = Number(e.target.value);
                setPageIndex(i);
                setName(pages[i]!.name);
              }}
            >
              {pages.map((p, i) => (
                <option key={i} value={i}>
                  {p.name}（図形 {p.shapes.length}・矢印 {p.edges.length}）
                </option>
              ))}
            </select>
          </label>
        )}

        <section className="stack" style={{ gap: 6 }}>
          <h3>色ごとの付箋の種類</h3>
          {page.colors.length === 0 ? (
            <p className="small muted">色で決める図形はありません。</p>
          ) : (
            <table className="drawio-colors">
              <thead>
                <tr>
                  <th>色</th>
                  <th>数</th>
                  <th>例</th>
                  <th>付箋の種類</th>
                </tr>
              </thead>
              <tbody>
                {page.colors.map((c) => (
                  <tr key={c.fill}>
                    <td>
                      <span className="drawio-swatch" style={{ background: c.fill === "none" ? "transparent" : c.fill }} title={c.fill} />
                      <code className="small">{c.fill === "none" ? "塗りなし" : c.fill}</code>
                    </td>
                    <td className="small">{c.count}</td>
                    <td className="small muted drawio-examples">{c.examples.join("、") || "（文字なし）"}</td>
                    <td>
                      <select aria-label={`${c.fill} の図形を`} value={mapping[c.fill] ?? c.suggested} onChange={(e) => setTarget(c.fill, e.target.value as DrawioTarget)}>
                        {TARGETS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                            {t.value === c.suggested ? "（推測）" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {byShape.length > 0 && (
            <p className="small muted">
              形で決めた図形: {[...new Set(byShape.map((s) => s.shapeKind!))].map((k) => `${labelOf(k)} ${byShape.filter((s) => s.shapeKind === k).length}`).join("・")}（人型はアクター、コンテナや他の図形を囲む点線の四角はコンテキストの枠）
            </p>
          )}
        </section>

        <section className="stack" style={{ gap: 6 }}>
          <h3>読み込み先</h3>
          <label className="small row" style={{ gap: 6 }}>
            <input type="radio" name="drawio-dest" checked={dest === "new"} onChange={() => setDest("new")} />
            新しいボードとして
            {dest === "new" && <input aria-label="新しいボードの名前" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />}
          </label>
          <label className="small row" style={{ gap: 6 }}>
            <input type="radio" name="drawio-dest" checked={dest === "here"} onChange={() => setDest("here")} />
            いまのボードに追加（{board.items.length ? "既存の付箋の右側に置く" : "空のボード"}）
          </label>
        </section>

        <p className="small">
          付箋 {total - (result.counts.frame ?? 0)} 枚
          {result.counts.frame ? `・枠 ${result.counts.frame}` : ""}・矢印 {page.edges.length - result.droppedEdges} 本を読み込みます
          {result.ignored ? `（読み込まない図形 ${result.ignored}）` : ""}
          {result.droppedEdges ? `。両端が付箋でない矢印 ${result.droppedEdges} 本は入りません` : ""}
          {result.truncated ? "。付箋が 3000 枚を超えるため、超えた分は入りません" : ""}
        </p>
        {total > 0 && (
          <p className="small muted">
            内訳:{" "}
            {Object.entries(result.counts)
              .map(([k, n]) => `${labelOf(k as DrawioTarget)} ${n}`)
              .join("・")}
          </p>
        )}

        <div className="row modal-actions">
          <button className="primary" disabled={total === 0 || (dest === "new" && !name.trim())} onClick={run}>
            読み込む
          </button>
          <button className="quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
