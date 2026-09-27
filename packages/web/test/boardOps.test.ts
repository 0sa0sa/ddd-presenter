import { describe, expect, test } from "bun:test";
import { emptyBoard, sampleBoard } from "@ddd/core";
import { addConnector, addFrame, addItem, duplicate, frameContents, History, moveBy, removeIds, updateItem } from "../src/lib/boardOps.ts";

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
