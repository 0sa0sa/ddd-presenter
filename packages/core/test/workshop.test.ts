import { describe, expect, test } from "bun:test";
import { analyzeBoard, boardToSvg, duplicateStickies, normalizeBoard, phaseOf, sampleBoard, timelineIssues, toggleVote, voteRanking, votesLeft, WORKSHOP_PHASES, type Board } from "../src/index.ts";

const ev = (id: string, text: string, x: number) => ({ id, kind: "event" as const, text, x, y: 0, w: 160, h: 100 });

describe("workshop steps", () => {
  test("steps run from big picture to reflection; the board remembers the current one", () => {
    expect(WORKSHOP_PHASES.map((p) => p.id)).toEqual(["chaotic", "timeline", "process", "design", "boundaries", "reflect"]);
    expect(phaseOf({ version: 1, items: [], frames: [], connectors: [] }).id).toBe("chaotic");
    expect(phaseOf({ version: 1, items: [], frames: [], connectors: [], workshop: { phase: "design" } }).id).toBe("design");
  });

  test("the first step checks the number of events and that they are written in the past tense", () => {
    const items = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, `出来事${i}が起きた`, i * 200));
    const done = WORKSHOP_PHASES[0]!.checks({ version: 1, items, frames: [], connectors: [] });
    expect(done.every((c) => c.done)).toBe(true);
    const bad = WORKSHOP_PHASES[0]!.checks({ version: 1, items: [...items, ev("x", "招待を送る", 0)], frames: [], connectors: [] });
    expect(bad[1]).toMatchObject({ done: false, itemIds: ["x"] });
  });

  test("the sample board passes the process step", () => {
    const process = WORKSHOP_PHASES.find((p) => p.id === "process")!;
    expect(process.checks(sampleBoard()).map((c) => c.done)).toEqual([true, true]);
  });
});

describe("timeline and duplicates", () => {
  test("an arrow that runs right-to-left between events is a timeline issue", () => {
    const b: Board = { version: 1, frames: [], items: [ev("a", "注文された", 600), ev("b", "支払われた", 0)], connectors: [{ id: "k", from: "a", to: "b" }] };
    expect(timelineIssues(b)).toEqual([{ from: "a", to: "b" }]);
    expect(timelineIssues({ ...b, connectors: [{ id: "k", from: "b", to: "a" }] })).toEqual([]);
  });

  test("the same text written twice (ignoring spaces and punctuation) is a duplicate", () => {
    const b: Board = { version: 1, frames: [], connectors: [], items: [ev("a", "招待が 受諾された。", 0), ev("b", "招待が受諾された", 200), ev("c", "招待が取り消された", 400)] };
    expect(duplicateStickies(b)).toEqual([["a", "b"]]);
  });
});

describe("dot voting", () => {
  const board: Board = { version: 1, frames: [], connectors: [], items: [ev("a", "A", 0), ev("b", "B", 200)], workshop: { phase: "boundaries", votesPerPerson: 2 } };

  test("each person has a limited number of votes and can take them back", () => {
    let b = toggleVote(board, "a", "alice");
    b = toggleVote(b, "b", "alice");
    expect(votesLeft(b, "alice")).toBe(0);
    expect(toggleVote(b, "a", "alice")).toBe(b); // no votes left
    b = toggleVote(b, "a", "bob");
    expect(voteRanking(b).map((r) => [r.item.id, r.count])).toEqual([["a", 2], ["b", 1]]);
    b = toggleVote(b, "a", "alice", true);
    expect(b.items.find((i) => i.id === "a")!.votes).toEqual(["bob"]);
    expect(votesLeft(b, "alice")).toBe(1);
  });
});

describe("workshop data on the board", () => {
  test("votes, comments, pivotal events, resolved hotspots, lanes, subdomains and the step survive normalization", () => {
    const raw = {
      items: [
        { id: "e", kind: "event", text: "x", x: 0, y: 0, pivotal: true, votes: ["a", "b", 3], comments: [{ id: "c1", author: "a", text: "本当？", at: "2026-09-27T00:00:00Z" }, { id: "c2", text: "" }] },
        { id: "h", kind: "hotspot", text: "?", x: 0, y: 0, resolved: true, resolution: "再送はしない", pivotal: true },
      ],
      frames: [{ id: "f", title: "採用", x: 0, y: 0, w: 400, h: 300, subdomain: "core" }, { id: "g", title: "g", x: 0, y: 0, subdomain: "nope" }],
      connectors: [],
      lanes: [{ id: "l", title: "スタッフ候補", y: 100, h: 200 }],
      workshop: { phase: "timeline", timerEndsAt: "2026-09-27T10:00:00Z", votesPerPerson: 5 },
    };
    const b = normalizeBoard(raw)!;
    expect(b.items[0]).toMatchObject({ pivotal: true, votes: ["a", "b"], comments: [{ id: "c1", author: "a", text: "本当？" }] });
    expect(b.items[1]).toMatchObject({ resolved: true, resolution: "再送はしない" });
    expect(b.items[1]!.pivotal).toBeUndefined(); // only events are pivotal
    expect(b.frames.map((f) => f.subdomain)).toEqual(["core", undefined]);
    expect(b.lanes).toEqual([{ id: "l", title: "スタッフ候補", y: 100, h: 200 }]);
    expect(b.workshop).toEqual({ phase: "timeline", timerEndsAt: "2026-09-27T10:00:00Z", votesPerPerson: 5 });
  });

  test("resolved hotspots no longer count as open questions", () => {
    const open = (b: Board) => analyzeBoard(b).some((f) => f.code === "open-hotspots");
    const h = { id: "h", kind: "hotspot" as const, text: "再送できる？", x: 0, y: 0, w: 160, h: 100 };
    expect(open({ version: 1, frames: [], connectors: [], items: [h] })).toBe(true);
    expect(open({ version: 1, frames: [], connectors: [], items: [{ ...h, resolved: true }] })).toBe(false);
  });
});

describe("image export", () => {
  test("the SVG shows stickies, arrows, frames with their subdomain, lanes and votes, with text escaped", () => {
    const b: Board = {
      version: 1,
      items: [ev("a", "<注文> & 支払い", 0), { ...ev("b", "発送された", 300), pivotal: true, votes: ["x", "y"] }],
      frames: [{ id: "f", title: "物流", x: -40, y: -60, w: 600, h: 260, subdomain: "supporting" }],
      connectors: [{ id: "k", from: "a", to: "b", label: "次に" }],
      lanes: [{ id: "l", title: "倉庫", y: 300, h: 200 }],
    };
    const svg = boardToSvg(b, "ワークショップ 9/27");
    expect(svg).toStartWith("<svg");
    expect(svg).toContain("&lt;注文&gt; &amp; 支払い");
    expect(svg).toContain("［支援］物流");
    expect(svg).toContain("倉庫");
    expect(svg).toContain("●●");
    expect(svg).toContain("marker-end");
    expect(svg).toContain('stroke="#c0392b"'); // pivotal
  });
});
