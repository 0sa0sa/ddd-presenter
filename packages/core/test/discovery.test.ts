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
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["h-resend", "rm-list", "x-mail"]);
    // Event → policy → command across frames: a policy in the command's context and a relationship (context map).
    expect(ctx[1]!.policies).toEqual([
      {
        name: "send_welcome_mail_on_invitation_accepted",
        description: "受諾されたら歓迎メールを送る",
        when: "StaffInvitation.InvitationAccepted",
        run: "send_welcome_mail",
        args: {},
        path: ["contexts", 1, "policies", 0],
      },
    ]);
    expect(v.model!.relationships.map(({ path: _, ...rel }) => rel)).toEqual([
      { upstream: "StaffInvitation", downstream: "Notification", pattern: "customer_supplier", events: ["InvitationAccepted"], description: undefined },
    ]);
    expect(r.names.find((n) => n.id === "p-welcome")).toMatchObject({ kind: "policy", style: "snake", suggested: "send_welcome_mail_on_invitation_accepted" });
    expect(r.summary).toContain("Notification: ポリシー 1");
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
    expect(v.model!.contexts.map((c) => c.name)).toEqual(["CleaningStaff", "Staffing", "Notification"]);
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

describe("board → model: policies and the context map", () => {
  const item = (id: string, kind: Board["items"][number]["kind"], text: string, x: number, extra: Partial<Board["items"][number]> = {}) => ({ id, kind, text, x, y: 100, w: 160, h: 100, ...extra });
  /** One context: accepting an invitation triggers (policy) archiving the same invitation. */
  const sameContext = (): Board => ({
    version: 1,
    frames: [],
    items: [
      item("ag", "aggregate", "Invitation", 0, { y: 300 }),
      item("c1", "command", "accept invitation", 0, { codeName: "accept_invitation" }),
      item("e1", "event", "invitation accepted", 200, { codeName: "InvitationAccepted" }),
      item("p", "policy", "when accepted, archive", 400, { codeName: "archive_when_accepted" }),
      item("c2", "command", "archive invitation", 600, { codeName: "archive_invitation" }),
      item("e2", "event", "invitation archived", 800, { codeName: "InvitationArchived" }),
    ],
    connectors: [
      { id: "k1", from: "c1", to: "e1" },
      { id: "k2", from: "c1", to: "ag" },
      { id: "k3", from: "e1", to: "p" },
      { id: "k4", from: "p", to: "c2" },
      { id: "k5", from: "c2", to: "e2" },
      { id: "k6", from: "c2", to: "ag" },
    ],
  });

  test("a chain inside one context maps the aggregate id from the event", () => {
    const r = boardToModel(sameContext(), EMPTY_MODEL);
    expect(r.ok).toBe(true);
    const ctx = validateModelText(r.yaml!).model!.contexts[0]!;
    expect(ctx.policies.map(({ path: _, ...p }) => p)).toEqual([
      { name: "archive_when_accepted", description: "when accepted, archive", when: "InvitationAccepted", run: "archive_invitation", args: { invitation_id: "event.id" } },
    ]);
    expect(validateModelText(r.yaml!).model!.relationships).toEqual([]);
  });

  test("reflecting again adds nothing twice", () => {
    const first = boardToModel(sampleBoard(), EMPTY_MODEL);
    const again = boardToModel(sampleBoard(), first.yaml!);
    expect(again.ok).toBe(true);
    const v = validateModelText(again.yaml!);
    expect(v.model!.contexts.flatMap((c) => c.policies.map((p) => p.name))).toEqual(["send_welcome_mail_on_invitation_accepted"]);
    expect(v.model!.relationships).toHaveLength(1);
    expect(again.yaml).toBe(first.yaml);
  });

  test("an existing relationship gains the event; separate_ways is respected", () => {
    const b = sampleBoard();
    const base = boardToModel(b, EMPTY_MODEL).yaml!;
    // Remove the reflected policy and empty the contract, then reflect again.
    const stripped = base.replace(/    policies:\n[\s\S]*?(?=\n\S)/, "").replace(/events: \[ ?InvitationAccepted ?\]/, "events: []");
    expect(validateModelText(stripped).model!.relationships[0]!.events).toEqual([]);
    const again = boardToModel(b, stripped);
    expect(again.ok).toBe(true);
    const v = validateModelText(again.yaml!);
    expect(v.model!.relationships.map((r) => r.events)).toEqual([["InvitationAccepted"]]);
    const apart = boardToModel(b, stripped.replace("pattern: customer_supplier", "pattern: separate_ways"));
    expect(apart.skipped.find((s) => s.id === "p-welcome")?.reason).toContain("separate_ways");
  });

  test("inputs that cannot be read from the event are left for the team, with the reason", () => {
    const b = sampleBoard();
    b.items.find((i) => i.id === "c-welcome")!.creates = false; // now the use case needs notification_id
    const r = boardToModel(b, EMPTY_MODEL);
    expect(r.ok).toBe(true);
    expect(r.skipped.find((s) => s.id === "p-welcome")?.reason).toContain("notification_id");
    expect(validateModelText(r.yaml!).model!.contexts.flatMap((c) => c.policies)).toEqual([]);
  });

  test("a policy without a command is pointed out and not reflected", () => {
    const b = sameContext();
    b.connectors = b.connectors.filter((c) => c.id !== "k4");
    expect(codes(b)).toContain("policy-without-command");
    const r = boardToModel(b, EMPTY_MODEL);
    expect(r.skipped.find((s) => s.id === "p")?.reason).toContain("コマンド");
  });

  test("a Japanese policy label gets a default name derived from the command and the event", () => {
    const b = sameContext();
    b.items.find((i) => i.id === "p")!.text = "受諾されたら保管する";
    delete b.items.find((i) => i.id === "p")!.codeName;
    const r = boardToModel(b, EMPTY_MODEL);
    expect(r.missing).toEqual([]);
    expect(validateModelText(r.yaml!).model!.contexts[0]!.policies[0]!.name).toBe("archive_invitation_on_invitation_accepted");
    const named = boardToModel(b, EMPTY_MODEL, { p: "archive_on_acceptance" });
    expect(validateModelText(named.yaml!).model!.contexts[0]!.policies[0]!.name).toBe("archive_on_acceptance");
  });
});
