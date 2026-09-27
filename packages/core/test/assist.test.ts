import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  boardGhosts,
  commandTextFor,
  eventNameFor,
  eventTextFor,
  pastParticiple,
  proposeLocally,
  sampleBoard,
  suggestInline,
  unifiedDiff,
  validateModelText,
  verbFromState,
  type Board,
} from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
/** The sample without the revoke operation (and what depends on it). */
const NO_REVOKE = SAMPLE.replace(/          - name: revoke\n[\s\S]*?(?=        scenarios:)/, "").replace(/          - name: revoked_invitation_cannot_be_revoked_again[\s\S]*?(?=\n    use_cases:)/, "").replace(/      - name: revoke_invitation[\s\S]*$/, "");

function at(text: string, marker: string): [string, number] {
  const i = text.indexOf(marker);
  return [text.slice(0, i) + text.slice(i + marker.length), i];
}

describe("words", () => {
  test("English verbs and states", () => {
    expect(["accept", "revoke", "submit", "send", "cancel", "visit", "open"].map(pastParticiple)).toEqual(["accepted", "revoked", "submitted", "sent", "canceled", "visited", "opened"]);
    expect(["accepted", "revoked", "cancelled", "completed", "approved", "opened", "closed", "paid", "delivered"].map(verbFromState)).toEqual([
      "accept",
      "revoke",
      "cancel",
      "complete",
      "approve",
      "open",
      "close",
      "pay",
      "deliver",
    ]);
    expect(eventNameFor("accept", "Invitation")).toBe("InvitationAccepted");
    expect(eventNameFor("send_welcome_mail", "Notification")).toBe("WelcomeMailSent");
  });

  test("Japanese commands and events convert both ways", () => {
    const pairs: [string, string][] = [
      ["招待を受諾する", "招待が受諾された"],
      ["招待を送る", "招待が送られた"],
      ["招待を取り消す", "招待が取り消された"],
      ["注文を確定する", "注文が確定された"],
      ["請求書を書く", "請求書が書かれた"],
      ["料金を払う", "料金が払われた"],
    ];
    for (const [cmd, evt] of pairs) {
      expect(eventTextFor(cmd)).toBe(evt);
      expect(commandTextFor(evt)).toBe(cmd);
    }
    expect(eventTextFor("Accept invitation")).toBe("Invitation accepted");
    expect(commandTextFor("Invitation accepted")).toBe("Accept invitation");
  });
});

describe("inline suggestions (ghost text)", () => {
  test("the no-revoke fixture is a valid model", () => {
    expect(validateModelText(NO_REVOKE).ok).toBe(true);
  });

  test("a new operation item proposes the lifecycle step nobody reaches yet", () => {
    const o = NO_REVOKE.indexOf("        scenarios:\n          - name: invitation_window_must_be_positive");
    const text = NO_REVOKE.slice(0, o) + "          - |\n" + NO_REVOKE.slice(o);
    const [t2, o2] = at(text, "|");
    const s = suggestInline(t2, o2)!;
    expect(s.label).toContain("revoke");
    expect(s.text).toStartWith("name: revoke");
    expect(s.text).toContain("status: revoked");
    expect(s.text).toContain("require: [is_open]");
    expect(s.text).toContain("name: InvitationRevoked"); // follows the existing InvitationIssued / InvitationAccepted naming
    // Accepting it keeps the model valid.
    expect(validateModelText(t2.slice(0, o2) + s.text + t2.slice(o2)).ok).toBe(true);
  });

  test("emits: of an operation without events proposes the event and its payload", () => {
    const text = NO_REVOKE.replace("              - name: InvitationAccepted\n                fields: [id, at]\n", "").replace("            emits:\n          - name: accept", "          - name: accept");
    const i = text.indexOf("              accepted_at: at\n") + "              accepted_at: at\n".length;
    // Remove the (now empty) emits block of accept and type a fresh `emits:`.
    const cleaned = text.replace(/(              accepted_at: at\n)            emits:\n/, "$1");
    const j = cleaned.indexOf("              accepted_at: at\n") + "              accepted_at: at\n".length;
    const withKey = cleaned.slice(0, j) + "            emits:" + "\n" + cleaned.slice(j);
    const cursor = j + "            emits:".length;
    void i;
    const s = suggestInline(withKey, cursor);
    expect(s?.text).toContain("- name: InvitationAccepted");
    expect(s?.text).toContain("fields: [id, at]");
  });

  test("a new scenario item proposes a failing case from a guard", () => {
    const o = SAMPLE.indexOf("\n    use_cases:");
    const text = SAMPLE.slice(0, o) + "\n          - " + SAMPLE.slice(o);
    const s = suggestInline(text, o + "\n          - ".length)!;
    expect(s.label).toContain("シナリオ");
    expect(s.text).toContain("raises:");
    expect(s.text).toContain("status: revoked"); // not "accepted", which an invariant would reject first
    expect(s.text).toContain("user@example.com");
    expect(validateModelText(text.slice(0, o + 13) + s.text + text.slice(o + 13)).ok).toBe(true);
  });

  test("nothing is suggested in the middle of a line", () => {
    const i = SAMPLE.indexOf("expression: expires_at > created_at") + 5;
    expect(suggestInline(SAMPLE, i)).toBeUndefined();
  });
});

describe("local proposals", () => {
  test("scenarios: adds valid scenarios for guarded operations", () => {
    const p = proposeLocally(NO_REVOKE, "CleaningStaff", "CleaningStaffInvitation", "scenarios")!;
    expect(p.summary.length).toBeGreaterThan(0);
    expect(validateModelText(p.yaml).ok).toBe(true);
    expect(p.assumptions.length).toBeGreaterThan(0);
    expect(p.source).toBe("local");
  });

  test("proposals keep the author's layout, so the diff only adds lines", () => {
    const p = proposeLocally(SAMPLE, "CleaningStaff", "CleaningStaffInvitation", "scenarios")!;
    const removed = unifiedDiff("m", SAMPLE, p.yaml).split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(removed).toEqual([]);
  });

  test("next-operation: proposes revoke with its reasoning separated into facts, assumptions and questions", () => {
    const p = proposeLocally(NO_REVOKE, "CleaningStaff", "CleaningStaffInvitation", "next-operation")!;
    expect(p.summary[0]).toContain("revoke");
    expect(p.facts.join()).toContain("revoked");
    expect(p.questions.length).toBeGreaterThan(0);
    expect(validateModelText(p.yaml).ok).toBe(true);
  });
});

describe("board ghosts", () => {
  test("a command without a result gets a ghost event; an event without a cause gets a ghost command", () => {
    const b: Board = {
      version: 1,
      frames: [],
      connectors: [],
      items: [
        { id: "c1", kind: "command", text: "注文を確定する", x: 0, y: 0, w: 160, h: 100 },
        { id: "e1", kind: "event", text: "支払いが完了した", x: 0, y: 300, w: 160, h: 100 },
      ],
    };
    const g = boardGhosts(b);
    const evt = g.find((x) => x.kind === "event")!;
    expect(evt.text).toBe("注文が確定された");
    expect(evt.connect).toEqual({ from: "c1", to: evt.id });
    expect(g.find((x) => x.kind === "command")!.connect!.to).toBe("e1");
  });

  test("a complete board has only structural gaps suggested", () => {
    expect(boardGhosts(sampleBoard()).filter((g) => g.kind !== "command")).toEqual([]);
  });
});
