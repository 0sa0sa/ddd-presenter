import { describe, expect, test } from "bun:test";
import { facilitatorBrief, facilitatorTurn, placeSuggestions, retargetGhosts, type Board } from "../src/index.ts";

const item = (id: string, kind: Board["items"][number]["kind"], text: string, x: number, y = 0) => ({ id, kind, text, x, y, w: 160, h: 100 });
const board = (items: Board["items"] = []): Board => ({ version: 1, items, frames: [], connectors: [] });

describe("placeSuggestions", () => {
  test("an empty board gets a timeline from the origin; each event goes right of the last one", () => {
    const ghosts = placeSuggestions(
      board(),
      [
        { kind: "event", text: "Todo が追加された", near_item_id: "", placement: "right", connect: "none", reason: "" },
        { kind: "event", text: "Todo が完了した", near_item_id: "", placement: "right", connect: "none", reason: "" },
      ],
      "g",
    );
    expect(ghosts.map((g) => [g.id, g.x, g.y])).toEqual([
      ["g-0", 0, 0],
      ["g-1", 200, 0],
    ]);
  });

  test("a chain on an earlier suggestion connects to that ghost; a taken spot moves the ghost to a row below its anchor", () => {
    const b = board([item("e1", "event", "追加された", 0), item("e2", "event", "完了した", 200)]);
    const [cmd, actor] = placeSuggestions(
      b,
      [
        { ref: "c", kind: "command", text: "完了する", near_item_id: "e2", placement: "left", connect: "to_near", reason: "" },
        { kind: "actor", text: "ユーザー", near_item_id: "c", placement: "above", connect: "to_near", reason: "" },
      ],
      "g",
    );
    expect(cmd).toMatchObject({ x: 200, y: 140 }); // left of e2 is e1: the command goes below its event instead
    expect(cmd!.connect).toEqual({ from: "g-0", to: "e2" });
    expect(actor!.connect).toEqual({ from: "g-1", to: "g-0" });
    expect(actor).toMatchObject({ x: 200, y: 280 }); // above the command is the event, so it goes below the command
    const after = retargetGhosts([actor!], "g-0", "s-new");
    expect(after[0]!.connect).toEqual({ from: "g-1", to: "s-new" });
  });
});

test("placed stickies never overlap the board or each other", () => {
  const b = board([item("e1", "event", "a", 0), item("e2", "event", "b", 200), item("h", "hotspot", "?", 380, 30)]);
  const ghosts = placeSuggestions(
    b,
    [0, 1, 2].map((n) => ({ kind: "event", text: `e${n}`, near_item_id: "e1", placement: "right" as const, connect: "none" as const, reason: "" })),
    "g",
  );
  const boxes = [...b.items, ...ghosts.map((g) => ({ ...g, w: 160, h: 100 }))];
  for (const [i, a] of boxes.entries()) for (const c of boxes.slice(i + 1)) expect(a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h).toBe(false);
});

describe("facilitatorBrief / facilitatorTurn", () => {
  test("the brief carries the step, its checks with sticky names, findings and counts", () => {
    const b = board([item("e1", "event", "Todo を追加", 0)]);
    const brief = facilitatorBrief(b);
    expect(brief.phase).toMatchObject({ id: "chaotic", index: 1, title: "出来事を出し合う" });
    expect(brief.checks.find((c) => c.label.includes("過去形"))).toEqual({ label: "出来事が過去形で書かれている", done: false, stickies: ["e1「Todo を追加」"] });
    expect(brief.counts).toMatchObject({ event: 1, frame: 0, arrow: 0 });
    expect(brief.phases.map((p) => p.id)).toContain("reflect");
  });

  test("an empty reply is no turn; unknown focus ids and the current step are dropped", () => {
    const b = board([item("e1", "event", "追加された", 0)]);
    const base = { suggestions: [], focus_item_ids: ["e1", "x"], options: [], next_phase: "chaotic" };
    expect(facilitatorTurn(b, { ...base, reply: "  " }, "g")).toBeUndefined();
    expect(facilitatorTurn(b, { ...base, reply: "ok" }, "g")).toEqual({ reply: "ok", ghosts: [], focus: ["e1"], options: [] });
  });
});

describe("placeSuggestions: what an LLM may get wrong", () => {
  const s = (over: Partial<Parameters<typeof placeSuggestions>[1][number]>) => ({ kind: "event", text: "x", near_item_id: "", placement: "right" as const, connect: "none" as const, reason: "", ...over });

  test("unknown kinds and anchors, frames as anchors, forward references and blank text are dropped", () => {
    const b: Board = { ...board([item("e1", "event", "a", 0)]), frames: [{ id: "f1", title: "F", x: 0, y: 0, w: 600, h: 400 }] };
    const ghosts = placeSuggestions(
      b,
      [
        s({ kind: "bogus" }),
        s({ near_item_id: "nope" }),
        s({ near_item_id: "f1" }),
        s({ near_item_id: "later" }),
        s({ text: "   " }),
        s({ text: 7 as never }),
        s({ ref: "later", text: "kept" }),
      ],
      "g",
    );
    expect(ghosts.map((g) => [g.id, g.text])).toEqual([["g-6", "kept"]]);
  });

  test("a sticky without an anchor never gets an arrow; an unknown placement means right", () => {
    const b = board([item("e1", "event", "a", 0)]);
    const [odd, free] = placeSuggestions(b, [s({ near_item_id: "e1", placement: "diagonal" as never }), s({ connect: "from_near" })], "g");
    expect(odd).toMatchObject({ x: 200, y: 0 });
    expect(free!.connect).toBeUndefined();
    expect(free!.x).toBeGreaterThan(odd!.x);
  });

  test("without events the timeline continues right of the rightmost sticky, on its row", () => {
    const b = board([item("a1", "actor", "人", 0, 300), item("c1", "command", "する", 500, 50)]);
    const [g] = placeSuggestions(b, [s({})], "g");
    expect(g).toMatchObject({ x: 500 + 160 + 40, y: 50 });
  });

  test("the number of ghosts is capped; text and reason are trimmed and cut", () => {
    const many = Array.from({ length: 30 }, (_, i) => s({ text: `e${i}` }));
    expect(placeSuggestions(board(), many, "g")).toHaveLength(20);
    expect(placeSuggestions(board(), many, "g", 5)).toHaveLength(5);
    const [g] = placeSuggestions(board(), [s({ text: `  ${"あ".repeat(250)}  `, reason: "r".repeat(400) })], "g");
    expect(g!.text).toBe("あ".repeat(200));
    expect(g!.reason).toHaveLength(300);
  });

  test("a crowded row still yields a spot (placement terminates)", () => {
    const row = Array.from({ length: 300 }, (_, i) => item(`e${i}`, "event", `${i}`, i * 176, 0));
    const [g] = placeSuggestions(board(row), [s({ near_item_id: "e0", placement: "right" }), s({ near_item_id: "e0", placement: "below" })], "g");
    expect(g).toBeDefined();
  });
});

describe("retargetGhosts", () => {
  test("re-points both ends and leaves unrelated ghosts alone", () => {
    const base = { kind: "event" as const, text: "t", x: 0, y: 0, reason: "", source: "llm" as const };
    const out = retargetGhosts(
      [
        { ...base, id: "a", connect: { from: "g", to: "a" } },
        { ...base, id: "b", connect: { from: "b", to: "g" } },
        { ...base, id: "c", connect: { from: "x", to: "c" } },
        { ...base, id: "d" },
      ],
      "g",
      "s1",
    );
    expect(out.map((g) => g.connect)).toEqual([{ from: "s1", to: "a" }, { from: "b", to: "s1" }, { from: "x", to: "c" }, undefined]);
  });
});

describe("facilitatorBrief and facilitatorTurn: limits", () => {
  test("the timer, the step the board is in, and at most 8 sticky names per check / 12 findings", () => {
    const events = Array.from({ length: 12 }, (_, i) => item(`e${i}`, "event", `出来事${i}を書く`, i * 200));
    const b: Board = { ...board(events), workshop: { phase: "chaotic", timerEndsAt: "2026-10-14T10:00:00.000Z" } };
    const brief = facilitatorBrief(b);
    expect(brief.phase.timerEndsAt).toBe("2026-10-14T10:00:00.000Z");
    expect(brief.checks.find((c) => c.label.includes("過去形"))!.stickies).toHaveLength(8);
    expect(brief.findings.length).toBeLessThanOrEqual(12);
    expect(facilitatorBrief({ ...b, workshop: { phase: "design" } }).phase).toMatchObject({ id: "design", index: 4 });
    expect(facilitatorBrief({ ...b, workshop: { phase: "nonsense" } }).phase.id).toBe("chaotic");
  });

  test("a turn keeps frames in focus, proposes another known step, and caps options and ghosts", () => {
    const b: Board = { ...board([item("e1", "event", "a", 0)]), frames: [{ id: "f1", title: "F", x: 0, y: 0, w: 600, h: 400 }] };
    const turn = facilitatorTurn(
      b,
      {
        reply: " ok ",
        suggestions: Array.from({ length: 20 }, (_, i) => ({ kind: "event", text: `e${i}`, near_item_id: "", placement: "right" as const, connect: "none" as const, reason: "" })),
        next_phase: "boundaries",
        focus_item_ids: ["f1", "e1", "zz"],
        options: ["a".repeat(200), "b", "c", "d", "e"],
      },
      "g",
    )!;
    expect(turn.reply).toBe("ok");
    expect(turn.ghosts).toHaveLength(12);
    expect(turn.nextPhase).toBe("boundaries");
    expect(turn.focus).toEqual(["f1", "e1"]);
    expect(turn.options).toEqual(["a".repeat(120), "b", "c", "d"]);
    expect(facilitatorTurn(b, { reply: "x", suggestions: "no" as never, next_phase: "", focus_item_ids: null as never, options: undefined as never }, "g")).toEqual({ reply: "x", ghosts: [], focus: [], options: [] });
  });
});
