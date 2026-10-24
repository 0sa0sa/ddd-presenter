import { describe, expect, test } from "bun:test";
import { flowDiagrams, validateModelText } from "@ddd/core";
import { SAMPLE_MODEL } from "../../cli/src/sample.ts";
import { layoutEvents, layoutSequence, textWidth, wrap } from "../src/lib/flowLayout.ts";

const r = validateModelText(SAMPLE_MODEL);
const d = flowDiagrams(r.model!, r.analysis);

describe("text", () => {
  test("CJK counts double; lines stay within the width and keep Latin words whole", () => {
    expect(textWidth("ab")).toBeLessThan(textWidth("あい"));
    const lines = wrap("失敗: InvitationNotDeliverable（この招待は受諾できません（受諾済み・取り消し済み・期限切れ））", 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(200 + 13);
    expect(lines.join("")).toContain("InvitationNotDeliverable");
    expect(wrap("", 100)).toEqual([""]);
  });
});

describe("sequence layout", () => {
  test("columns left to right without overlapping headers; every message between its columns; rows go down", () => {
    for (const s of [...d.useCases, ...d.queries]) {
      const l = layoutSequence(s);
      for (let i = 1; i < l.headers.length; i++) expect(l.headers[i]!.x - l.headers[i]!.w / 2).toBeGreaterThan(l.headers[i - 1]!.x + l.headers[i - 1]!.w / 2);
      const msgs = l.shapes.filter((x) => x.kind === "msg");
      for (let i = 1; i < msgs.length; i++) expect(msgs[i]!.y).toBeGreaterThan(msgs[i - 1]!.y);
      for (const s2 of l.shapes) {
        if (s2.kind !== "msg") expect(s2.x).toBeGreaterThanOrEqual(0);
        if (s2.kind !== "msg") expect(s2.x + s2.w).toBeLessThanOrEqual(l.width);
      }
      expect(l.height).toBeGreaterThan(msgs[msgs.length - 1]!.y);
    }
  });

  test("the same diagram lays out the same", () => {
    const s = d.useCases[1]!;
    expect(layoutSequence(s)).toEqual(layoutSequence(s));
  });
});

describe("event layout", () => {
  test("every edge goes right (no cycles in the sample); boxes in a column do not overlap", () => {
    const l = layoutEvents(d.events);
    for (const e of l.lines) expect(e.to.x).toBeGreaterThan(e.from.x);
    const byX = new Map<number, typeof l.boxes>();
    for (const b of l.boxes) byX.set(b.x, [...(byX.get(b.x) ?? []), b]);
    for (const col of byX.values()) for (let i = 1; i < col.length; i++) expect(col[i]!.y).toBeGreaterThanOrEqual(col[i - 1]!.y + col[i - 1]!.h);
  });

  test("a cycle (a policy that runs the use case publishing its event) still gets a layout", () => {
    const g = {
      nodes: [
        { id: "a", kind: "use_case" as const, label: "a" },
        { id: "e", kind: "event" as const, label: "e" },
        { id: "p", kind: "policy" as const, label: "p" },
      ],
      edges: [
        { from: "a", to: "e" },
        { from: "e", to: "p" },
        { from: "p", to: "a" },
      ],
    };
    const l = layoutEvents(g);
    expect(l.boxes.map((b) => b.x)).toEqual([24, 24 + 280, 24 + 560]);
  });
});
