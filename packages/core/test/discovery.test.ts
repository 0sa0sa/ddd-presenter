import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeBoard,
  boardToModel,
  contextMap,
  emptyBoard,
  frameOf,
  guessNoun,
  normalizeBoard,
  sampleBoard,
  suggestAggregates,
  suggestCodeName,
  validateModelText,
  type Board,
} from "../src/index.ts";

const SAMPLE_MODEL = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const EMPTY_MODEL = `schema_version: 1
project: staff
generation:
  package: staff

contexts:
  - name: Core
    description: ""
    errors: []
    aggregates: []
    use_cases: []
`;

const codes = (b: Board) => analyzeBoard(b).map((f) => f.code);

describe("geometry", () => {
  test("membership is decided by where the sticky sits", () => {
    const b = sampleBoard();
    expect(frameOf(b, b.items.find((i) => i.id === "c-accept")!)?.id).toBe("f-invite");
    expect(frameOf(b, b.items.find((i) => i.id === "c-welcome")!)?.id).toBe("f-notify");
    const moved = { ...b.items.find((i) => i.id === "c-accept")!, x: 3000 };
    expect(frameOf(b, moved)).toBeUndefined();
  });

  test("untrusted board JSON is normalized", () => {
    const b = normalizeBoard({ items: [{ id: "a", kind: "event", text: "x".repeat(900), x: 1.6 }, { id: "b", kind: "virus" }], connectors: [{ id: "c", from: "a", to: "zz" }] })!;
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.text.length).toBe(500);
    expect(b.items[0]!.x).toBe(2);
    expect(b.connectors).toEqual([]);
    expect(normalizeBoard("nope")).toBeUndefined();
  });
});

describe("assistance", () => {
  test("an empty board suggests starting with events", () => {
    expect(codes(emptyBoard())).toEqual(["empty-board"]);
  });

  test("sample board: only the intentional open points are reported", () => {
    const c = codes(sampleBoard());
    expect(c).toContain("open-hotspots");
    expect(c).toContain("aggregate-without-rules"); // Notification has no rule stickies
    expect(c).not.toContain("command-without-event");
    expect(c).not.toContain("commands-without-aggregate");
  });

  test("typical EventStorming mistakes are pointed out", () => {
    const b: Board = {
      version: 1,
      frames: [],
      connectors: [],
      items: [
        { id: "e1", kind: "event", text: "招待を送る", x: 0, y: 0, w: 160, h: 100 },
        { id: "c1", kind: "command", text: "招待を受諾する", x: 200, y: 0, w: 160, h: 100 },
        { id: "p1", kind: "policy", text: "受諾されたらメール", x: 400, y: 0, w: 160, h: 100 },
      ],
    };
    const c = codes(b);
    expect(c).toEqual(expect.arrayContaining(["event-not-past", "event-without-cause", "command-without-event", "command-without-trigger", "policy-without-trigger", "commands-without-aggregate"]));
  });
});

describe("suggestions", () => {
  test("commands and events are grouped with the aggregate they are connected to", () => {
    const cands = suggestAggregates(sampleBoard());
    const inv = cands.find((c) => c.aggregateItemId === "ag-inv")!;
    expect(inv.commandIds.sort()).toEqual(["c-accept", "c-issue", "c-revoke"]);
    expect(inv.eventIds.sort()).toEqual(["e-accepted", "e-issued", "e-revoked"]);
    // The policy-triggered command belongs to the other aggregate, not to Invitation.
    expect(cands.find((c) => c.aggregateItemId === "ag-mail")!.commandIds).toEqual(["c-welcome"]);
  });

  test("an unanchored group gets a name from the common noun", () => {
    const b: Board = {
      version: 1,
      frames: [],
      items: [
        { id: "c1", kind: "command", text: "注文を確定する", x: 0, y: 0, w: 160, h: 100 },
        { id: "e1", kind: "event", text: "注文が確定された", x: 200, y: 0, w: 160, h: 100 },
      ],
      connectors: [{ id: "k", from: "c1", to: "e1" }],
    };
    const [c] = suggestAggregates(b);
    expect(c!.aggregateItemId).toBeUndefined();
    expect(c!.name).toBe("注文");
    expect(guessNoun(["Accept invitation", "Invitation accepted"])).toBe("Invitation");
  });

  test("context map shows the policy link between frames", () => {
    expect(contextMap(sampleBoard())).toEqual([{ fromFrameId: "f-invite", toFrameId: "f-notify", via: ["招待が受諾された", "受諾されたら歓迎メールを送る", "歓迎メールを送る"] }]);
  });

  test("code names are suggested only from ASCII labels", () => {
    expect(suggestCodeName("Accept invitation", "snake")).toBe("accept_invitation");
    expect(suggestCodeName("invitation accepted", "pascal")).toBe("InvitationAccepted");
    expect(suggestCodeName("招待を受諾する", "snake")).toBe("");
  });
});

describe("board → model", () => {
  test("the sample board becomes a valid model from the empty template", () => {
    const r = boardToModel(sampleBoard(), EMPTY_MODEL);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const v = validateModelText(r.yaml!);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const ctx = v.model!.contexts;
    expect(ctx.map((c) => c.name)).toEqual(["StaffInvitation", "Notification"]);
    const inv = ctx[0]!.aggregates[0]!;
    expect(inv.name).toBe("Invitation");
    expect(inv.factories.map((f) => f.name)).toEqual(["issue_invitation"]);
    expect(inv.operations.map((o) => o.name).sort()).toEqual(["accept_invitation", "revoke_invitation"]);
    expect(inv.description).toContain("TODO ルール: 受諾・取り消し済みの招待は変更できない");
    expect(ctx[0]!.useCases.map((u) => u.name).sort()).toEqual(["accept_invitation", "issue_invitation", "revoke_invitation"]);
    expect(ctx[0]!.useCases.find((u) => u.name === "accept_invitation")!.actor).toBe("スタッフ候補");
    expect(ctx[0]!.glossary.map((g) => g.term)).toContain("招待が受諾された");
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["h-resend", "p-welcome", "rm-list", "x-mail"]);
    expect(r.yaml).toContain("project: staff");
  });

  test("an existing model only gains what is missing", () => {
    const b = sampleBoard();
    // Point the board at the existing context and aggregate of the sample model.
    b.frames[0]!.codeName = "CleaningStaff";
    b.items.find((i) => i.id === "ag-inv")!.codeName = "CleaningStaffInvitation";
    b.items.find((i) => i.id === "c-accept")!.codeName = "accept"; // already exists → untouched
    b.items.find((i) => i.id === "c-revoke")!.codeName = "suspend";
    b.items.find((i) => i.id === "e-revoked")!.codeName = "InvitationSuspended";
    const r = boardToModel(b, SAMPLE_MODEL);
    expect(r.ok).toBe(true);
    const v = validateModelText(r.yaml!);
    const ctx = v.model!.contexts.find((c) => c.name === "CleaningStaff")!;
    const ops = ctx.aggregates.find((a) => a.name === "CleaningStaffInvitation")!.operations.map((o) => o.name);
    expect(ops).toEqual(["accept", "revoke", "suspend"]);
    expect(v.model!.contexts.map((c) => c.name)).toEqual(["CleaningStaff", "Notification"]);
    expect(r.skipped.find((x) => x.id === "c-issue")?.reason).toContain("必須フィールド");
    // Everything that existed is still there.
    expect(r.yaml).toContain("pending_until_expiry");
    expect(r.yaml).toContain("scenarios:");
  });

  test("Japanese labels without code names ask for names instead of guessing", () => {
    const b = sampleBoard();
    for (const i of b.items) delete i.codeName;
    for (const f of b.frames) delete f.codeName;
    const r = boardToModel(b, EMPTY_MODEL);
    expect(r.ok).toBe(false);
    expect(r.yaml).toBeUndefined();
    expect(r.missing.map((m) => m.id)).toEqual(expect.arrayContaining(["f-invite", "ag-inv", "c-accept", "e-accepted"]));
    expect(r.missing.every((m) => m.suggested === "")).toBe(true);
    const names = Object.fromEntries(
      r.missing.map((m) => [m.id, m.style === "pascal" ? `N${m.id.replace(/[^a-z]/g, "")}` : `n_${m.id.replace(/[^a-z]/g, "")}`]),
    );
    const again = boardToModel(b, EMPTY_MODEL, names);
    expect(again.ok).toBe(true);
  });

  test("vocabulary written before the board is kept (errors, enums, glossary)", () => {
    const withVocabulary = EMPTY_MODEL.replace(
      "    errors: []",
      `    glossary:
      - { term: 招待, definition: スタッフ候補への参加依頼 }
    errors:
      - { name: Blocked, code: blocked, message: blocked }
    enums:
      - { name: Channel, values: [email, sms] }`,
    ).replace("  - name: Core", "  - name: StaffInvitation");
    const r = boardToModel(sampleBoard(), withVocabulary);
    expect(r.ok).toBe(true);
    const ctx = validateModelText(r.yaml!).model!.contexts.find((c) => c.name === "StaffInvitation")!;
    expect(ctx.errors.map((e) => e.name)).toEqual(["Blocked", "InvitationNotFound"]);
    expect(ctx.enums.map((e) => e.name)).toEqual(["Channel"]);
    // The team's own definition wins; new labels are still added to the glossary.
    expect(ctx.glossary.find((g) => g.term === "招待")!.definition).toBe("スタッフ候補への参加依頼");
    expect(ctx.glossary.map((g) => g.term)).toContain("招待が受諾された");
    expect(ctx.aggregates.map((a) => a.name)).toEqual(["Invitation"]);
  });

  test("a board without aggregates cannot be reflected", () => {
    const r = boardToModel({ ...emptyBoard(), items: [{ id: "e", kind: "event", text: "x happened", x: 0, y: 0, w: 1, h: 1 }] }, EMPTY_MODEL);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("集約");
  });
});
