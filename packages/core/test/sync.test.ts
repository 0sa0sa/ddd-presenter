import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addModelElementsToBoard, applyEdits, compareBoardWithModel, emptyBoard, frameOf, renameOnBoard, validateModelText, type Board } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const model = (text: string) => validateModelText(text).model!;

describe("board ↔ model", () => {
  test("an empty board is missing every context, aggregate, command and event of the model", () => {
    const c = compareBoardWithModel(emptyBoard(), model(SAMPLE));
    const kinds = new Set(c.missing.map((m) => m.kind));
    expect([...kinds].sort()).toEqual(["aggregate", "command", "context", "event"]);
    expect(c.missing.some((m) => m.kind === "event" && m.name === "InvitationAccepted")).toBe(true);
    expect(c.stale).toEqual([]);
  });

  test("placing the model on the board links every element and draws the flow inside a context frame", () => {
    const m = model(SAMPLE);
    const { board, added } = addModelElementsToBoard(emptyBoard(), m, compareBoardWithModel(emptyBoard(), m).missing);
    expect(added.length).toBeGreaterThan(5);
    const after = compareBoardWithModel(board, m);
    expect(after.missing).toEqual([]);
    expect(after.stale).toEqual([]);
    const frame = board.frames.find((f) => f.codeName === "CleaningStaff")!;
    const accept = board.items.find((i) => i.kind === "command" && i.codeName === "accept")!;
    const accepted = board.items.find((i) => i.kind === "event" && i.codeName === "InvitationAccepted")!;
    const aggregate = board.items.find((i) => i.kind === "aggregate")!;
    for (const i of [accept, accepted, aggregate]) expect(frameOf(board, i)?.id).toBe(frame.id);
    expect(board.connectors.some((k) => k.from === accept.id && k.to === accepted.id)).toBe(true);
    expect(board.connectors.some((k) => k.from === accept.id && k.to === aggregate.id)).toBe(true);
    expect(board.items.find((i) => i.codeName === "issue")?.creates).toBe(true); // factories create the aggregate
  });

  test("a rename in the model shows up as a stale sticky with the new name as the first candidate", () => {
    const m = model(SAMPLE);
    const board = addModelElementsToBoard(emptyBoard(), m, compareBoardWithModel(emptyBoard(), m).missing).board;
    const renamed = applyEdits(SAMPLE, [{ op: "renameType", context: "CleaningStaff", from: "InvitationAccepted", to: "InvitationWasAccepted" }]);
    expect(renamed.ok).toBe(true);
    const m2 = model((renamed as { text: string }).text);
    const c = compareBoardWithModel(board, m2);
    expect(c.stale).toEqual([expect.objectContaining({ kind: "event", codeName: "InvitationAccepted", candidates: ["InvitationWasAccepted"] })]);
    const fixed = renameOnBoard(board, "InvitationAccepted", "InvitationWasAccepted", ["event"]);
    expect(compareBoardWithModel(fixed, m2)).toMatchObject({ stale: [], missing: [] });
  });

  test("stickies without a code name are reported as not reflected; a missing element joins its context's frame", () => {
    const m = model(SAMPLE);
    const full = addModelElementsToBoard(emptyBoard(), m, compareBoardWithModel(emptyBoard(), m).missing).board;
    const withoutEvent: Board = { ...full, items: full.items.filter((i) => i.codeName !== "InvitationRevoked"), connectors: full.connectors };
    const draft: Board = { ...withoutEvent, items: [...withoutEvent.items, { id: "n1", kind: "event", text: "招待が期限切れになった", x: 0, y: -400, w: 160, h: 100 }] };
    const c = compareBoardWithModel(draft, m);
    expect(c.unreflected).toEqual(["n1"]);
    expect(c.missing.map((x) => x.name)).toEqual(["InvitationRevoked"]);
    const re = addModelElementsToBoard(draft, m, c.missing);
    const revoked = re.board.items.find((i) => i.codeName === "InvitationRevoked")!;
    expect(frameOf(re.board, revoked)?.codeName).toBe("CleaningStaff");
    expect(re.board.frames).toHaveLength(1);
  });
});
