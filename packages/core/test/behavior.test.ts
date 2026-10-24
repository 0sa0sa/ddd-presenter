import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { behaviorChanges, validateModelText } from "../src/index.ts";

const ORDERING = readFileSync(new URL("../../generator/test/fixtures/ordering.ddd.yaml", import.meta.url), "utf8");
const SAMPLE = readFileSync(new URL("../../../examples/cleaning-platform/model.ddd.yaml", import.meta.url), "utf8");
const analysis = (t: string) => {
  const r = validateModelText(t);
  expect(r.ok).toBe(true);
  return r.analysis!;
};
const changes = (before: string, after: string) => behaviorChanges(analysis(before), analysis(after));

describe("behaviour changes", () => {
  test("the same model changes nothing", () => {
    expect(changes(ORDERING, ORDERING)).toEqual([]);
  });

  test("dropping a guard to get past a check is flagged first; the transition it opens is listed", () => {
    const after = ORDERING.replace("            require: [is_open, has_line(line_id)]\n            changes:\n              lines: remove_where", "            require: [has_line(line_id)]\n            changes:\n              lines: remove_where");
    const c = changes(ORDERING, after);
    expect(c[0]).toMatchObject({ kind: "guard", weakens: true });
    expect(c[0]!.text).toContain("remove_line の require から is_open がなくなる");
    expect(c.some((x) => x.kind === "lifecycle" && x.text.includes("remove_line が「placed・delivered・cancelled」の Order でもできる"))).toBe(true);
  });

  test("a removed invariant, a looser expression and a removed failing scenario all weaken", () => {
    const after = ORDERING.replace("          - { name: at_most_50_lines, expression: count(lines) <= 50, error: TooManyLines }\n", "")
      .replace("expression: quantity >= 1 and quantity <= 99", "expression: quantity >= 0 and quantity <= 99")
      .replace(/          - name: duplicate_line_is_rejected\n(?:            .*\n)+?(?=          - name: new_line_quantity_is_checked)/, "");
    const c = changes(ORDERING, after);
    const weak = c.filter((x) => x.weakens).map((x) => x.text);
    expect(weak.some((t) => t.includes("Invariant at_most_50_lines（count(lines) <= 50）がなくなる"))).toBe(true);
    expect(weak.some((t) => t.includes("quantity_in_range の式が変わる"))).toBe(true);
    expect(weak.some((t) => t.includes("シナリオ duplicate_line_is_rejected（DuplicateLine になること）がなくなる"))).toBe(true);
  });

  test("a stricter edit is listed but does not weaken; looser constraints and wider roles do", () => {
    const stricter = ORDERING.replace("- { name: currency, type: String, constraints: { min_length: 3, max_length: 3 } }", "- { name: currency, type: String, constraints: { min_length: 3, max_length: 3, pattern: \"^[A-Z]+$\" } }");
    expect(changes(ORDERING, stricter).filter((x) => x.weakens)).toEqual([]);
    const looser = ORDERING.replace("constraints: { min_length: 3, max_length: 3 }", "constraints: { min_length: 1, max_length: 3 }");
    expect(changes(ORDERING, looser)).toEqual([expect.objectContaining({ kind: "constraint", weakens: true, text: "Money.currency の min_length が変わる: 3 → 1。" })]);
    const wider = SAMPLE.replace("authorize: { permissions: [invitation.revoke] }", "authorize: { permissions: [invitation.revoke, invitation.read] }");
    expect(changes(SAMPLE, wider)).toContainEqual(expect.objectContaining({ kind: "access", weakens: true, text: "CleaningStaff › revoke_invitation を許す権限が増える: invitation.read。" }));
  });
});
