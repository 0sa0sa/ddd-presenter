import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, definition, hover, prepareRename, rename, validateModelText } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

/** `marker` in `text` is replaced by the cursor; returns [text, offset]. */
function at(text: string, marker = "|"): [string, number] {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error("no cursor marker");
  return [text.slice(0, i) + text.slice(i + marker.length), i];
}

/** Puts the cursor at the n-th occurrence of `needle` in the sample, after `needle` (or at offset `delta` within it). */
function inSample(needle: string, delta = needle.length, nth = 0, text = SAMPLE): [string, number] {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`not found: ${needle}`);
  return [text, i + delta];
}

/** Replaces the n-th `needle` with `replacement` (containing `|`) and returns the cursor position. */
function editSample(needle: string, replacement: string, nth = 0): [string, number] {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = SAMPLE.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`not found: ${needle}`);
  return at(SAMPLE.slice(0, i) + replacement + SAMPLE.slice(i + needle.length));
}

const labels = (text: string, offset: number) => complete(text, offset).items.map((i) => i.label);

describe("completion: keys", () => {
  test("keys of an aggregate, excluding ones already present", () => {
    // The sample aggregate already has every key except `entities`.
    const [t, o] = editSample("        invariants:\n          - name: expiry_after_creation", "        |\n        invariants:\n          - name: expiry_after_creation");
    expect(labels(t, o)).toEqual(["entities"]);
    const bare = SAMPLE.replace(/        state_guards:[\s\S]*?        factories:/, "        factories:");
    const [t2, o2] = at(bare.replace("        factories:", "        sta|\n        factories:"));
    expect(labels(t2, o2)).toEqual(["state_guards"]);
  });

  test("keys of a new state guard list item", () => {
    const [t, o] = editSample("          - name: is_open\n", "          - |\n          - name: is_open\n");
    expect(labels(t, o)).toEqual(["name", "description", "parameters", "expression", "error"]);
  });

  test("keys of a step", () => {
    const [t, o] = editSample("          - save: invitation\n          - publish_after_commit: InvitationAccepted", "          - pub|\n          - save: invitation\n          - publish_after_commit: InvitationAccepted");
    expect(labels(t, o)).toEqual(["publish", "publish_after_commit"]);
  });

  test("keys inside a flow mapping", () => {
    const [t, o] = editSample("{ name: accepted_at, type: DateTime, required: false }", "{ name: accepted_at, type: DateTime, r| }");
    expect(labels(t, o)).toEqual(["required"]);
  });
});

describe("completion: references", () => {
  test("types include primitives, enums and value objects", () => {
    const [t, o] = editSample("{ name: status, type: InvitationStatus }", "{ name: status, type: Inv| }");
    expect(labels(t, o)).toEqual(["InvitationStatus"]);
    const [t2, o2] = editSample("{ name: status, type: InvitationStatus }", "{ name: status, type: | }");
    expect(labels(t2, o2)).toEqual(expect.arrayContaining(["InvitationStatus", "EmailAddress", "String", "UUID", "List[", "Ref["]));
  });

  test("errors for error: and raises:", () => {
    const [t, o] = editSample("            error: InvitationAlreadyClosed", "            error: InvitationA|");
    expect(labels(t, o)).toEqual(["InvitationAlreadyClosed"]);
    const [t2, o2] = editSample("              raises: InvitationNotFound", "              raises: |");
    expect(labels(t2, o2)).toEqual(expect.arrayContaining(["InvitationNotFound", "ConstraintViolation", "AggregateNotFound"]));
  });

  test("events for publish steps and aggregates for load", () => {
    const [t, o] = editSample("          - publish_after_commit: InvitationAccepted", "          - publish_after_commit: |");
    expect(labels(t, o).sort()).toEqual(["InvitationAccepted", "InvitationIssued", "InvitationRevoked"]);
    const [t2, o2] = editSample("              aggregate: CleaningStaffInvitation\n              by: invitation_id", "              aggregate: |\n              by: invitation_id");
    expect(labels(t2, o2)).toEqual(["CleaningStaffInvitation"]);
  });

  test("operations of the loaded aggregate and variables bound earlier", () => {
    const [t, o] = editSample("              operation: accept\n              args: { at: clock.now }", "              operation: |\n              args: { at: clock.now }");
    expect(labels(t, o)).toEqual(["accept", "revoke"]);
    const [t2, o2] = editSample("          - save: invitation\n          - publish_after_commit: InvitationAccepted", "          - save: |\n          - publish_after_commit: InvitationAccepted");
    expect(labels(t2, o2)).toEqual(["invitation"]);
  });

  test("check_on and transaction values", () => {
    const [t, o] = editSample("            check_on: [construct, transition]", "            check_on: [construct, |]");
    expect(labels(t, o)).toEqual(["construct", "transition"]);
    const [t2, o2] = editSample("        command: AcceptInvitation\n        transaction: required", "        command: AcceptInvitation\n        transaction: |");
    expect(labels(t2, o2)).toEqual(["required", "none"]);
  });
});

describe("completion: rule expressions", () => {
  test("fields, parameters, functions in a state guard", () => {
    const [t, o] = editSample("            expression: status == pending and at < expires_at", "            expression: status == pending and at < ex|");
    expect(labels(t, o)).toEqual(["expires_at"]);
    const [t2, o2] = editSample("            expression: status == pending and at < expires_at", "            expression: |");
    const all = complete(t2, o2).items;
    expect(all.find((i) => i.label === "at")).toMatchObject({ kind: "parameter", detail: "DateTime" });
    expect(all.find((i) => i.label === "status")).toMatchObject({ kind: "field", detail: "InvitationStatus" });
    expect(all.map((i) => i.label)).toContain("is_empty");
  });

  test("enum values after comparing with an enum field", () => {
    const [t, o] = editSample("            expression: status == pending\n            error: InvitationAlreadyClosed", "            expression: status == |\n            error: InvitationAlreadyClosed");
    expect(labels(t, o).slice(0, 3)).toEqual(["pending", "accepted", "revoked"]);
  });

  test("enum values for changes of an enum field", () => {
    const [t, o] = editSample("              status: revoked\n", "              status: |\n");
    expect(labels(t, o).slice(0, 3)).toEqual(["pending", "accepted", "revoked"]);
  });

  test("guards in require lists", () => {
    const [t, o] = editSample("            require: [is_open]", "            require: [|]");
    const items = complete(t, o).items;
    expect(items.slice(0, 2).map((i) => i.label)).toEqual(["pending_until_expiry", "is_open"]);
    expect(items[0]!.insertText).toBe("pending_until_expiry(");
  });

  test("use case conditions: variables, member guards and ports", () => {
    const [t, o] = editSample("              condition: invitation.is_open", "              condition: invitation.|");
    const l = labels(t, o);
    expect(l).toContain("is_open");
    expect(l).toContain("expires_at");
    const [t2, o2] = editSample("              args: { at: clock.now }", "              args: { at: clock.| }");
    expect(labels(t2, o2)).toEqual(["now"]);
    const [t3, o3] = editSample("              condition: is_blocked_email(email)", "              condition: |");
    const l3 = labels(t3, o3);
    expect(l3).toEqual(expect.arrayContaining(["email", "valid_until", "is_blocked_email", "clock", "ids"]));
  });

  test("argument names of an invoked operation", () => {
    const [t, o] = editSample("              args: { at: clock.now }", "              args: { | }");
    expect(labels(t, o)).toEqual(["at"]);
  });
});

describe("completion: scenario data", () => {
  test("field names and enum values in given aggregates", () => {
    const [t, o] = editSample("                    status: accepted\n", "                    status: |\n");
    expect(labels(t, o)).toEqual(["pending", "accepted", "revoked"]);
  });

  test("works while the current line is incomplete YAML", () => {
    const [t, o] = editSample("          - { name: accepted_at, type: DateTime, required: false }", "          - { name: accepted_at, type: Da|");
    expect(labels(t, o)).toEqual(expect.arrayContaining(["DateTime", "Date"]));
  });
});

describe("hover", () => {
  test("describes errors, guards, fields and keys", () => {
    expect(hover(...inSample("error: InvitationNotDeliverable", 12))!.markdown).toContain("invitation_not_deliverable");
    expect(hover(...inSample("require: [pending_until_expiry(at)]", 14))!.markdown).toContain("State guard");
    expect(hover(...inSample("expression: expires_at > created_at", 14))!.markdown).toContain("expires_at`: DateTime");
    expect(hover(...inSample("    state_guards:", 6))!.markdown).toContain("特定の操作時点");
    expect(hover(...inSample("condition: invitation.is_open", 24))!.markdown).toContain("State guard");
  });
});

describe("definition", () => {
  test("jumps from references to definitions", () => {
    const [t, o] = inSample("error: InvitationNotDeliverable", 12);
    const d = definition(t, o)!;
    expect(t.slice(d.from, d.to)).toBe("InvitationNotDeliverable");
    expect(t.slice(0, d.from)).toContain("errors:");
    expect(t.slice(0, d.from)).not.toContain("state_guards:");

    const [t2, o2] = inSample("require: [pending_until_expiry(at)]", 14);
    const d2 = definition(t2, o2)!;
    expect(t2.slice(d2.from - 20, d2.to)).toContain("name: pending_until_expiry");

    const [t3, o3] = inSample("- save: invitation", 10, 1);
    const d3 = definition(t3, o3)!;
    expect(t3.slice(d3.from - 4, d3.to)).toBe("as: invitation");
  });
});

describe("rename", () => {
  test("renames a type from any reference and keeps the model valid", () => {
    const [t, o] = inSample("raises: InvitationAlreadyClosed", 10);
    expect(prepareRename(t, o)).toMatchObject({ ok: true, name: "InvitationAlreadyClosed" });
    const r = rename(t, o, "InvitationClosed");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toContain("InvitationAlreadyClosed");
      expect(validateModelText(r.text).ok).toBe(true);
    }
  });

  test("renames a guard from a use case condition", () => {
    const r = rename(...inSample("condition: invitation.is_open", 24), "still_open");
    expect(r.ok && r.text.includes("require: [still_open]")).toBe(true);
  });

  test("refuses symbols that cannot be renamed safely", () => {
    expect(prepareRename(...inSample("expression: expires_at > created_at", 14)).ok).toBe(false);
  });
});
