import { describe, expect, test } from "bun:test";
import type { Board, BoardGhost, FacilitatorMessage } from "@ddd/core";
import { acceptGhosts } from "../src/lib/boardOps.ts";
import { FACILITATOR_KEEP, facilitatorStorageKey, ghostsToAdd, historyFor, loadConversation, saveConversation } from "../src/lib/facilitator.ts";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
const broken = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const msg = (over: Partial<FacilitatorMessage> = {}): FacilitatorMessage => ({ id: "m", role: "user", text: "t", at: "2026-10-14T00:00:00Z", ...over });
const ghost = (id: string, over: Partial<BoardGhost> = {}): BoardGhost => ({ id, kind: "command", text: id, x: 0, y: 0, reason: "", source: "llm", ...over });

describe("conversation storage", () => {
  test("one key per project and board", () => {
    expect(facilitatorStorageKey("p", "main")).not.toBe(facilitatorStorageKey("p", "b2"));
    expect(facilitatorStorageKey("p", "main")).not.toBe(facilitatorStorageKey("q", "main"));
  });

  test("round trip; the most recent messages are kept; an empty conversation removes the entry", () => {
    const s = new MemoryStorage();
    const many = Array.from({ length: 100 }, (_, i) => msg({ id: `m${i}`, text: `${i}` }));
    saveConversation(s, "k", many);
    const back = loadConversation(s, "k");
    expect(back).toHaveLength(FACILITATOR_KEEP);
    expect(back[0]!.text).toBe("20");
    expect(back.at(-1)!.text).toBe("99");
    saveConversation(s, "k", []);
    expect(s.data.has("k")).toBe(false);
  });

  test("blocked, full or missing storage never throws", () => {
    expect(loadConversation(broken, "k")).toEqual([]);
    expect(() => saveConversation(broken, "k", [msg()])).not.toThrow();
    expect(() => saveConversation(broken, "k", [])).not.toThrow();
    expect(loadConversation(undefined, "k")).toEqual([]);
  });

  test("corrupt or foreign data is dropped instead of crashing the panel", () => {
    const s = new MemoryStorage();
    for (const raw of ["{not json", '{"a":1}', "42", "null"]) {
      s.setItem("k", raw);
      expect(loadConversation(s, "k")).toEqual([]);
    }
    s.setItem(
      "k",
      JSON.stringify([
        null,
        7,
        { role: "system", text: "x" },
        { role: "user" },
        { role: "assistant", text: "ok", ghosts: [{ id: "g", kind: "bogus", text: "x", x: 0, y: 0 }, { id: "g2", kind: "event", text: "y", x: 1, y: 2, reason: "", source: "llm" }, "junk"], focus: ["a", 1], options: ["o", {}], nextPhase: 3 },
      ]),
    );
    const [only, ...rest] = loadConversation(s, "k");
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ role: "assistant", text: "ok", focus: ["a"], options: ["o"] });
    expect(only!.ghosts!.map((g) => g.id)).toEqual(["g2"]); // an unknown sticky kind would break the label lookup
    expect(only!.nextPhase).toBeUndefined();
    expect(typeof only!.id).toBe("string");
  });
});

describe("historyFor", () => {
  test("assistant turns carry the stickies they suggested; authors are kept; long texts and long conversations are cut", () => {
    const h = historyFor([msg({ text: "Todo", author: "bob" }), msg({ role: "assistant", text: "案です", ghosts: [ghost("g", { kind: "event", text: "追加された" })] }), msg({ text: "x".repeat(7000) })]);
    expect(h[0]).toEqual({ role: "user", text: "Todo", author: "bob" });
    expect(h[1]).toEqual({ role: "assistant", text: '案です\n(suggested stickies: event "追加された")' });
    expect(h[2]!.text).toHaveLength(6000);
    expect(historyFor(Array.from({ length: 90 }, (_, i) => msg({ text: `${i}` })))).toHaveLength(FACILITATOR_KEEP);
  });
});

describe("ghostsToAdd", () => {
  const board = (items: Board["items"]): Board => ({ version: 1, items, frames: [], connectors: [] });

  test("after one sticky of a chain was accepted on the canvas, adding the rest still draws its arrow", () => {
    // The command ghost g-0 was accepted on the canvas as s-cmd; the actor ghost still points at g-0.
    const b = board([
      { id: "e1", kind: "event", text: "完了した", x: 0, y: 0, w: 160, h: 100 },
      { id: "s-cmd", kind: "command", text: "完了する", x: -200, y: 0, w: 160, h: 100 },
    ]);
    const ghosts = [ghost("g-0", { text: "完了する", connect: { from: "g-0", to: "e1" } }), ghost("g-1", { kind: "actor", text: "ユーザー", connect: { from: "g-1", to: "g-0" } })];
    const rest = ghostsToAdd(b, ghosts);
    expect(rest.map((g) => g.id)).toEqual(["g-1"]);
    const added = acceptGhosts(b, rest);
    expect(added.board.connectors.map((c) => [c.from, c.to])).toEqual([[added.ids[0]!, "s-cmd"]]);
  });

  test("a sticky of another kind with the same text does not count as added", () => {
    const b = board([{ id: "a", kind: "event", text: "完了する", x: 0, y: 0, w: 160, h: 100 }]);
    expect(ghostsToAdd(b, [ghost("g", { text: "完了する" })]).map((g) => g.id)).toEqual(["g"]);
  });

  test("everything already on the board: nothing to add", () => {
    const b = board([{ id: "a", kind: "command", text: "完了する。", x: 0, y: 0, w: 160, h: 100 }]);
    expect(ghostsToAdd(b, [ghost("g", { text: "完了 する" })])).toEqual([]);
  });
});
