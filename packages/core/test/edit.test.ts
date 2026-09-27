import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, templates, validateModelText } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const edit = (...ops: Parameters<typeof applyEdits>[1]) => {
  const r = applyEdits(SAMPLE, ops);
  if (!r.ok) throw new Error(r.error);
  return r.text;
};

describe("structural edits", () => {
  test("no-op round trip preserves the document", () => {
    const r = applyEdits(SAMPLE, []);
    expect(r.ok && validateModelText(r.text).ok).toBe(true);
  });

  test("comments survive edits", () => {
    const text = "# top comment\n" + SAMPLE.replace("    enums:", "    # enums below\n    enums:");
    const r = applyEdits(text, [{ op: "set", path: ["description"], value: "changed" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("# top comment");
      expect(r.text).toContain("# enums below");
      expect(r.text).toContain("description: changed");
    }
  });

  test("add a field and a new aggregate from templates", () => {
    const text = edit(
      { op: "add", path: ["contexts", 0, "aggregates", 0, "fields"], value: { name: "note", type: "String", required: false } },
      { op: "add", path: ["contexts", 0, "aggregates"], value: templates.aggregate("Crew") },
    );
    expect(text).toMatch(/- \{ ?name: note, type: String, required: false ?\}/);
    const r = validateModelText(text);
    expect(r.ok).toBe(true);
    expect(r.model!.contexts[0]!.aggregates.map((a) => a.name)).toEqual(["CleaningStaffInvitation", "Crew"]);
  });

  test("remove an element", () => {
    const text = edit({ op: "remove", path: ["contexts", 0, "glossary"] });
    expect(validateModelText(text).model!.contexts[0]!.glossary).toEqual([]);
  });

  test("renaming an error updates every reference and keeps the model valid", () => {
    const text = edit({ op: "renameType", context: "CleaningStaff", from: "InvitationNotDeliverable", to: "InvitationClosed" });
    expect(text).not.toContain("InvitationNotDeliverable");
    expect(validateModelText(text).ok).toBe(true);
  });

  test("renaming an enum updates field types but not scenario literals", () => {
    const text = edit({ op: "renameType", context: "CleaningStaff", from: "InvitationStatus", to: "Status" });
    expect(text).toMatch(/type: Status ?\}/);
    expect(validateModelText(text).ok).toBe(true);
  });

  test("renaming an aggregate updates steps, scenarios and repositories", () => {
    const text = edit({ op: "renameType", context: "CleaningStaff", from: "CleaningStaffInvitation", to: "Invitation" });
    expect(text).not.toContain("CleaningStaffInvitation");
    expect(validateModelText(text).ok).toBe(true);
  });

  test("renaming an event updates emits, publish steps and expectations", () => {
    const text = edit({ op: "renameType", context: "CleaningStaff", from: "InvitationAccepted", to: "InvitationWasAccepted" });
    expect(text).not.toContain("InvitationAccepted");
    expect(validateModelText(text).ok).toBe(true);
  });

  test("renaming a guard updates require lists and use case conditions", () => {
    const text = edit({ op: "renameGuard", context: "CleaningStaff", aggregate: "CleaningStaffInvitation", from: "is_open", to: "still_open" });
    expect(text).toContain("require: [still_open]");
    expect(text).toContain("condition: invitation.still_open");
    expect(validateModelText(text).ok).toBe(true);
  });

  test("invalid operations report errors instead of corrupting the text", () => {
    const r = applyEdits(SAMPLE, [{ op: "renameType", context: "CleaningStaff", from: "Nope", to: "X" }]);
    expect(r.ok).toBe(false);
    const r2 = applyEdits(SAMPLE, [{ op: "add", path: ["project"], value: 1 }]);
    expect(r2.ok).toBe(false);
  });
});
