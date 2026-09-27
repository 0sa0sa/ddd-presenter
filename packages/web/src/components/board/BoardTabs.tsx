import { useCallback, useEffect, useState } from "react";
import { api, describeError, type BoardSummary } from "../../api.ts";

/** The project's boards (e.g. one per workshop or per process) as tabs above the canvas. */
export function BoardTabs({ projectId, current, canEdit, onSelect }: { projectId: string; current: string; canEdit: boolean; onSelect: (id: string, name: string) => void }) {
  const [boards, setBoards] = useState<BoardSummary[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      api.boards(projectId).then(
        (r) => {
          setBoards(r.boards);
          const cur = r.boards.find((b) => b.id === current);
          if (!cur) onSelect("main", r.boards[0]?.name ?? "メイン");
          else onSelect(cur.id, cur.name);
        },
        (e) => setError(describeError(e)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const name = window.prompt("新しいボードの名前（例: 支払いの流れ・9/27 ワークショップ）");
    if (!name?.trim()) return;
    try {
      const r = await api.createBoard(projectId, name.trim());
      await load();
      onSelect(r.id, r.name);
    } catch (e) {
      setError(describeError(e));
    }
  };
  const rename = async (b: BoardSummary) => {
    const name = window.prompt("ボードの名前", b.name);
    if (!name?.trim() || name === b.name) return;
    try {
      await api.renameBoard(projectId, b.id, name.trim());
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const remove = async (b: BoardSummary) => {
    if (!confirm(`ボード「${b.name}」を削除します（付箋 ${b.stickies} 枚）。元に戻せません。`)) return;
    try {
      await api.deleteBoard(projectId, b.id);
      onSelect("main", "メイン");
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  };

  if (!boards) return null;
  return (
    <div className="board-tabs" role="tablist" aria-label="ボード" data-tour="board-tabs">
      {boards.map((b) => (
        <span key={b.id} className={`board-tab${b.id === current ? " is-current" : ""}`}>
          <button role="tab" aria-selected={b.id === current} onClick={() => onSelect(b.id, b.name)} onDoubleClick={() => canEdit && void rename(b)} title={canEdit ? "ダブルクリックで名前を変更" : undefined}>
            {b.name}
            <span className="small muted"> {b.stickies}</span>
          </button>
          {canEdit && b.id !== "main" && b.id === current && (
            <button className="quiet board-tab-close" aria-label={`ボード「${b.name}」を削除`} title="このボードを削除" onClick={() => void remove(b)}>
              ×
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <button className="quiet board-tab-add" onClick={() => void create()} title="ボードを追加（ワークショップや業務の流れごとに分けられます）">
          ＋ ボード
        </button>
      )}
      {error && <span className="small sev-error">{error}</span>}
    </div>
  );
}
