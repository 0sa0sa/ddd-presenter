/** After the model is saved, stickies that pointed at a renamed type follow the new name on every board. */
import { renameOnBoard, type Board } from "@ddd/core";
import { api, ApiError } from "../api.ts";

export interface Rename {
  from: string;
  to: string;
}

export function applyRenames(board: Board, renames: Rename[]): Board {
  return renames.reduce((b, r) => renameOnBoard(b, r.from, r.to), board);
}

/** Returns how many stickies (and frames) were updated. A board changed meanwhile is retried once. */
export async function renameOnBoards(projectId: string, renames: Rename[]): Promise<number> {
  if (!renames.length) return 0;
  const { boards } = await api.boards(projectId);
  let updated = 0;
  for (const summary of boards) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await api.board(projectId, summary.id);
      const next = applyRenames(current.board, renames);
      if (next === current.board) break;
      try {
        await api.saveBoard(projectId, next, current.version, summary.id);
        updated += next.items.filter((i, k) => i.codeName !== current.board.items[k]?.codeName).length + next.frames.filter((f, k) => f.codeName !== current.board.frames[k]?.codeName).length;
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || attempt === 1) throw e;
      }
    }
  }
  return updated;
}
