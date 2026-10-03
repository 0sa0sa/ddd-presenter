import { describe, expect, test } from "bun:test";
import type { Board, BoardItem } from "@ddd/core";
import { mergeBoards } from "../src/lib/boardMerge.ts";

const s = (id: string, text: string, extra: Partial<BoardItem> = {}): BoardItem => ({ id, kind: "event", text, x: 0, y: 0, w: 160, h: 100, ...extra });
const board = (items: BoardItem[], extra: Partial<Board> = {}): Board => ({ version: 1, items, frames: [], connectors: [], ...extra });

describe("three-way board merge", () => {
  const base = board([s("a", "招待が送られた"), s("b", "招待が受諾された")]);

  test("both sides adding stickies keeps both (the workshop case)", () => {
    const mine = board([...base.items, s("m", "ボブの付箋")]);
    const theirs = board([...base.items, s("t", "アリスの付箋")]);
    const r = mergeBoards(base, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.board.items.map((i) => i.text)).toEqual(["招待が送られた", "招待が受諾された", "アリスの付箋", "ボブの付箋"]);
  });

  test("edits to different stickies and a move combine; a deletion on one side is applied", () => {
    const mine = board([{ ...base.items[0]!, x: 300 }, base.items[1]!]);
    const theirs = board([base.items[0]!, { ...base.items[1]!, text: "招待が承諾された" }]);
    expect(mergeBoards(base, mine, theirs).board.items).toEqual([{ ...base.items[0]!, x: 300 }, { ...base.items[1]!, text: "招待が承諾された" }]);
    const deleted = mergeBoards(base, board([base.items[1]!]), base);
    expect(deleted.board.items.map((i) => i.id)).toEqual(["b"]);
    expect(deleted.conflicts).toEqual([]);
  });

  test("votes and comments from both sides on the same sticky are all kept", () => {
    const b0 = board([s("h", "再送できる？", { kind: "hotspot", votes: ["carol"] })]);
    const mine = board([{ ...b0.items[0]!, votes: ["carol", "bob", "bob"], comments: [{ id: "c1", author: "bob", text: "できない", at: "2026-10-03T10:00:01Z" }] }]);
    const theirs = board([{ ...b0.items[0]!, votes: ["carol", "alice"], comments: [{ id: "c2", author: "alice", text: "要確認", at: "2026-10-03T10:00:00Z" }] }]);
    const r = mergeBoards(b0, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect([...r.board.items[0]!.votes!].sort()).toEqual(["alice", "bob", "bob", "carol"]);
    expect(r.board.items[0]!.comments!.map((c) => c.id)).toEqual(["c2", "c1"]);
    // Taking a vote back on one side removes exactly one.
    const unvote = mergeBoards(b0, board([{ ...b0.items[0]!, votes: [] }]), theirs);
    expect(unvote.board.items[0]!.votes).toEqual(["alice"]);
  });

  test("both editing the same sticky differently is a conflict; ours is kept and reported", () => {
    const r = mergeBoards(base, board([{ ...base.items[0]!, text: "A案" }, base.items[1]!]), board([{ ...base.items[0]!, text: "B案" }, base.items[1]!]));
    expect(r.conflicts).toEqual([{ id: "a", kind: "item", label: "A案", reason: "edit" }]);
    expect(r.board.items[0]!.text).toBe("A案");
  });

  test("they deleted a sticky we edited: ours is kept and reported; arrows to deleted stickies go", () => {
    const withArrow = board(base.items, { connectors: [{ id: "k", from: "a", to: "b" }] });
    const r = mergeBoards(withArrow, board([{ ...base.items[0]!, text: "変更" }, base.items[1]!], { connectors: [{ id: "k", from: "a", to: "b" }] }), board([base.items[1]!]));
    expect(r.conflicts).toEqual([{ id: "a", kind: "item", label: "変更", reason: "deleted" }]);
    const gone = mergeBoards(withArrow, withArrow, board([base.items[1]!]));
    expect(gone.board.connectors).toEqual([]);
  });

  test("the workshop step follows whoever changed it", () => {
    const b0 = board([], { workshop: { phase: "chaotic" } });
    expect(mergeBoards(b0, b0, board([], { workshop: { phase: "timeline" } })).board.workshop).toEqual({ phase: "timeline" });
    expect(mergeBoards(b0, board([], { workshop: { phase: "design" } }), b0).board.workshop).toEqual({ phase: "design" });
  });
});
