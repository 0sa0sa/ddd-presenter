import { describe, expect, test } from "bun:test";
import { boardGhosts, emptyBoard, sampleBoard, type Board, type BoardGhost } from "@ddd/core";
import { acceptGhost, addConnector, addFrame, addItem, duplicate, frameContents, History, moveBy, removeIds, updateItem, visibleGhosts } from "../src/lib/boardOps.ts";

describe("board operations", () => {
  test("add a sticky centered on the click point", () => {
    const { board, id } = addItem(emptyBoard(), "event", { x: 100, y: 100 }, "招待が送られた");
    const item = board.items.find((i) => i.id === id)!;
    expect(item).toMatchObject({ kind: "event", text: "招待が送られた", x: 20, y: 50, w: 160, h: 100 });
  });

  test("connectors are unique and never self-referencing", () => {
    let b = addItem(emptyBoard(), "command", { x: 0, y: 0 }).board;
    const a = b.items[0]!.id;
    b = addItem(b, "event", { x: 300, y: 0 }).board;
    const e = b.items[1]!.id;
    b = addConnector(b, a, e);
    b = addConnector(b, a, e);
    b = addConnector(b, a, a);
    expect(b.connectors).toHaveLength(1);
  });

  test("removing a sticky removes its connectors", () => {
    const b = removeIds(sampleBoard(), ["c-accept"]);
    expect(b.items.some((i) => i.id === "c-accept")).toBe(false);
    expect(b.connectors.some((c) => c.from === "c-accept" || c.to === "c-accept")).toBe(false);
  });

  test("duplicate copies connectors between copied stickies and clears code names", () => {
    const { board, ids } = duplicate(sampleBoard(), ["c-accept", "e-accepted"]);
    expect(ids).toHaveLength(2);
    const copies = board.items.filter((i) => ids.includes(i.id));
    expect(copies.every((c) => c.codeName === undefined)).toBe(true);
    expect(board.connectors.filter((c) => ids.includes(c.from) && ids.includes(c.to))).toHaveLength(1);
  });

  test("a frame carries the stickies inside it", () => {
    const b = sampleBoard();
    const inside = frameContents(b, "f-notify");
    expect(inside.sort()).toEqual(["ag-mail", "c-welcome", "e-welcome", "p-welcome", "x-mail"]);
    const moved = moveBy(b, ["f-notify", ...inside], 100, 50);
    expect(moved.items.find((i) => i.id === "c-welcome")!.x).toBe(b.items.find((i) => i.id === "c-welcome")!.x + 100);
    expect(frameContents(moved, "f-notify").sort()).toEqual(inside.sort());
  });

  test("updates drop empty code names and 'creates' on non-commands", () => {
    const b = updateItem(sampleBoard(), "e-accepted", { codeName: "", creates: true });
    const e = b.items.find((i) => i.id === "e-accepted")!;
    expect("codeName" in e).toBe(false);
    expect("creates" in e).toBe(false);
  });

  test("undo / redo", () => {
    const h = new History();
    const a = emptyBoard();
    const b = addFrame(a, { x: 0, y: 0 }, "招待").board;
    h.push(a);
    expect(h.undo(b)).toBe(a);
    expect(h.redo(a)).toBe(b);
    expect(h.canRedo).toBe(false);
  });
});

describe("ghost stickies", () => {
  const base = (): Board => ({
    version: 1,
    frames: [],
    items: [
      { id: "c1", kind: "command", text: "招待を受諾する", x: 0, y: 0, w: 160, h: 90 },
      { id: "e2", kind: "event", text: "招待が取り消された", x: 600, y: 300, w: 160, h: 90 },
    ],
    connectors: [],
  });

  test("shows ghosts tied to the selection, else to the newest sticky", () => {
    const b = base();
    const all = boardGhosts(b);
    expect(visibleGhosts(all, b, ["c1"], new Set()).map((g) => g.id)).toEqual(["ghost-evt-c1"]);
    expect(visibleGhosts(all, b, [], new Set()).map((g) => g.id)).toEqual(["ghost-cmd-e2"]);
    expect(visibleGhosts(all, b, ["c1"], new Set(["ghost-evt-c1"]))).toEqual([]);
  });

  test("AI ghosts are always shown; ghosts for deleted stickies are not", () => {
    const b = base();
    const llm: BoardGhost = { id: "ghost-llm-0-c1", kind: "actor", text: "スタッフ候補", x: -200, y: 0, connect: { from: "ghost-llm-0-c1", to: "c1" }, reason: "", source: "llm" };
    expect(visibleGhosts([llm], b, ["e2"], new Set()).map((g) => g.id)).toEqual([llm.id]);
    const gone = { ...b, items: b.items.filter((i) => i.id !== "c1") };
    expect(visibleGhosts([llm], gone, [], new Set())).toEqual([]);
  });

  test("accepting adds the sticky and its connector", () => {
    const b = base();
    const g = boardGhosts(b).find((x) => x.id === "ghost-evt-c1")!;
    const r = acceptGhost(b, g);
    const item = r.board.items.find((i) => i.id === r.id)!;
    expect(item).toMatchObject({ kind: "event", text: "招待が受諾された", x: g.x, y: g.y });
    expect(r.board.connectors).toEqual([expect.objectContaining({ from: "c1", to: r.id })]);
    expect(boardGhosts(r.board).some((x) => x.id === "ghost-evt-c1")).toBe(false);
  });
});
