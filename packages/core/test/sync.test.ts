import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addModelElementsToBoard, applyEdits, boardToModel, compareBoardWithModel, emptyBoard, frameOf, renameOnBoard, validateModelText, type Board } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const model = (text: string) => validateModelText(text).model!;

describe("board ↔ model", () => {
  test("an empty board is missing every context, aggregate, command and event of the model", () => {
    const c = compareBoardWithModel(emptyBoard(), model(SAMPLE));
    const kinds = new Set(c.missing.map((m) => m.kind));
    expect([...kinds].sort()).toEqual(["aggregate", "command", "context", "event", "policy"]);
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
    // A policy sits between the event it reacts to (in another context) and the command its use case runs.
    const policy = board.items.find((i) => i.kind === "policy")!;
    expect(board.connectors.some((k) => k.from === accepted.id && k.to === policy.id)).toBe(true);
    expect(board.connectors.some((k) => k.from === policy.id && board.items.find((i) => i.id === k.to)?.kind === "command")).toBe(true);
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
    expect(re.board.frames).toHaveLength(full.frames.length); // joined the existing frame, no new one
  });
});

describe("subdomains", () => {
  const withSubdomain = (value: string) => SAMPLE.replace("  - name: CleaningStaff\n", `  - name: CleaningStaff\n    subdomain: ${value}\n`);

  test("contexts may declare a subdomain; an unknown value is an error with the allowed values", () => {
    expect(validateModelText(withSubdomain("core")).model!.contexts[0]!.subdomain).toBe("core");
    const bad = validateModelText(withSubdomain("important"));
    expect(bad.diagnostics.find((d) => d.severity === "error")?.message).toContain('Unknown subdomain "important"');
  });

  test("the board's classification is reflected into a context that has none, and differences are reported", () => {
    const m = model(SAMPLE);
    const board = addModelElementsToBoard(emptyBoard(), m, compareBoardWithModel(emptyBoard(), m).missing).board;
    const classified: Board = { ...board, frames: board.frames.map((f) => (f.codeName === "CleaningStaff" ? { ...f, subdomain: "core" } : f)) };
    const diff = compareBoardWithModel(classified, m).subdomains;
    expect(diff).toEqual([expect.objectContaining({ context: "CleaningStaff", board: "core", model: undefined })]);
    const reflected = boardToModel(classified, SAMPLE);
    expect(reflected.ok).toBe(true);
    const m2 = model(reflected.yaml!);
    expect(m2.contexts.find((c) => c.name === "CleaningStaff")!.subdomain).toBe("core");
    expect(compareBoardWithModel(classified, m2).subdomains).toEqual([]);
    // A frame placed from the model carries the model's classification.
    const fromModel = addModelElementsToBoard(emptyBoard(), m2, compareBoardWithModel(emptyBoard(), m2).missing).board;
    expect(fromModel.frames.find((f) => f.codeName === "CleaningStaff")!.subdomain).toBe("core");
  });
});
