/**
 * Three-way merge of boards, used when someone else saved the board while we had unsaved changes.
 * Elements (stickies, frames, arrows, lanes) are merged by id: a side that changed an element wins over
 * a side that did not. Votes and comments are merged as sets of individual contributions, so two people
 * voting or commenting on the same sticky at the same time both keep theirs. Only when both sides changed
 * the same element in different ways is it a conflict (our version is kept and the conflict is reported).
 */
import type { Board, BoardComment, BoardItem } from "@ddd/core";

export interface MergeConflict {
  id: string;
  kind: "item" | "frame" | "connector" | "lane";
  /** Text or title, for the conflict message. */
  label: string;
  /** "edit": both edited; "deleted": they deleted what we edited (or the reverse). */
  reason: "edit" | "deleted";
}

export interface MergeResult {
  board: Board;
  conflicts: MergeConflict[];
}

type WithId = { id: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Multiset merge: theirs + what we added − what we removed (relative to base). */
function mergeVotes(base: string[] = [], mine: string[] = [], theirs: string[] = []): string[] {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const b = count(base);
  const m = count(mine);
  const out = count(theirs);
  for (const name of new Set([...b.keys(), ...m.keys()])) {
    const delta = (m.get(name) ?? 0) - (b.get(name) ?? 0);
    out.set(name, Math.max(0, (out.get(name) ?? 0) + delta));
  }
  return [...out.entries()].flatMap(([name, n]) => Array<string>(n).fill(name));
}

function mergeComments(base: BoardComment[] = [], mine: BoardComment[] = [], theirs: BoardComment[] = []): BoardComment[] {
  const baseIds = new Set(base.map((c) => c.id));
  const mineIds = new Set(mine.map((c) => c.id));
  const theirIds = new Set(theirs.map((c) => c.id));
  // Keep a comment unless one side deleted it (it was in base and is gone on that side).
  const kept = [...theirs, ...mine.filter((c) => !theirIds.has(c.id))].filter((c) => !(baseIds.has(c.id) && (!mineIds.has(c.id) || !theirIds.has(c.id))));
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}

/** An item without its collaborative parts (votes, comments), which merge separately. */
const core = (i: BoardItem) => {
  const { votes: _v, comments: _c, ...rest } = i;
  return rest;
};

function mergeList<T extends WithId>(
  base: T[],
  mine: T[],
  theirs: T[],
  kind: MergeConflict["kind"],
  label: (x: T) => string,
  conflicts: MergeConflict[],
  combine?: (b: T | undefined, m: T, t: T) => T | undefined,
): T[] {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const T = new Map(theirs.map((x) => [x.id, x]));
  const order = [...theirs.map((x) => x.id), ...mine.map((x) => x.id).filter((id) => !T.has(id))];
  const out: T[] = [];
  for (const id of order) {
    const b = B.get(id);
    const m = M.get(id);
    const t = T.get(id);
    if (m && t) {
      if (combine) {
        const c = combine(b, m, t);
        if (c) out.push(c);
        continue;
      }
      if (same(m, t) || (b && same(m, b))) out.push(t);
      else if (b && same(t, b)) out.push(m);
      else {
        conflicts.push({ id, kind, label: label(m), reason: "edit" });
        out.push(m);
      }
    } else if (m && !t) {
      if (!b) out.push(m); // we added it
      else if (!same(m, b)) {
        // They deleted it, we changed it: keep ours and say so.
        conflicts.push({ id, kind, label: label(m), reason: "deleted" });
        out.push(m);
      }
      // else: they deleted it, we did not touch it → deleted
    } else if (!m && t) {
      if (!b) out.push(t); // they added it
      else if (!same(t, b)) {
        conflicts.push({ id, kind, label: label(t), reason: "deleted" });
        out.push(t);
      }
      // else: we deleted it, they did not touch it → deleted
    }
  }
  return out;
}

export function mergeBoards(base: Board, mine: Board, theirs: Board): MergeResult {
  const conflicts: MergeConflict[] = [];
  const items = mergeList(base.items, mine.items, theirs.items, "item", (i) => i.text || "（無題の付箋）", conflicts, (b, m, t) => {
    const bc = b ? core(b) : undefined;
    const mc = core(m);
    const tc = core(t);
    let merged: BoardItem;
    if (same(mc, tc) || (bc && same(mc, bc))) merged = { ...tc };
    else if (bc && same(tc, bc)) merged = { ...mc };
    else {
      conflicts.push({ id: m.id, kind: "item", label: m.text || "（無題の付箋）", reason: "edit" });
      merged = { ...mc };
    }
    const votes = mergeVotes(b?.votes, m.votes, t.votes);
    const comments = mergeComments(b?.comments, m.comments, t.comments);
    if (votes.length) merged.votes = votes;
    if (comments.length) merged.comments = comments;
    return merged;
  });
  const frames = mergeList(base.frames, mine.frames, theirs.frames, "frame", (f) => f.title || "（無題の枠）", conflicts);
  const alive = new Set(items.map((i) => i.id));
  const connectors = mergeList(base.connectors, mine.connectors, theirs.connectors, "connector", () => "矢印", conflicts).filter((c) => alive.has(c.from) && alive.has(c.to));
  const lanes = mergeList(base.lanes ?? [], mine.lanes ?? [], theirs.lanes ?? [], "lane", (l) => l.title || "（無題のレーン）", conflicts);
  // Shared workshop state: whoever changed it last wins (ours if we changed it).
  const workshop = same(mine.workshop, base.workshop) ? theirs.workshop : mine.workshop;
  const board: Board = { version: 1, items, frames, connectors };
  if (lanes.length) board.lanes = lanes;
  if (workshop) board.workshop = workshop;
  return { board, conflicts };
}
