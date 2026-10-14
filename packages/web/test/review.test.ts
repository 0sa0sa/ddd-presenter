import { describe, expect, test } from "bun:test";
import { reviewQuestions, validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answersOf, filterQuestions, reviewState, type StoredAnswer } from "../src/lib/review.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const questions = reviewQuestions(validateModelText(SAMPLE).analysis!);
const stored = (answer: "yes" | "no" | null, note = ""): StoredAnswer => ({ answer, note, text: "", by: "pm", at: "2026-10-14T00:00:00Z" });

describe("review tab state", () => {
  const answers: Record<string, StoredAnswer> = {
    "tenancy:read-other:CleaningStaff.CleaningStaffInvitation": stored("no"),
    "tenancy:parent-reads-children": stored("yes"),
    "tenancy:hierarchy": stored("no"),
    "access:staff:CleaningStaff.revoke_invitation": stored(null, "営業に確認"),
    "lifecycle:gone:Old.Thing": { ...stored("yes"), text: "古い質問" },
  };

  test("counts answers (a note alone is not an answer), findings and answers to questions no longer asked", () => {
    const s = reviewState(questions, answers);
    expect(s.answered).toBe(3);
    expect(s.findings.map((f) => [f.question.id, f.kind])).toEqual([["tenancy:parent-reads-children", "differs"]]);
    expect([...s.findingIds]).toEqual(["tenancy:parent-reads-children"]);
    expect(s.stale.map((x) => [x.id, x.stored.text])).toEqual([["lifecycle:gone:Old.Thing", "古い質問"]]);
    expect(answersOf(answers)).not.toHaveProperty("access:staff:CleaningStaff.revoke_invitation");
  });

  test("filters: everything, the unanswered ones (a note does not count), the findings", () => {
    const s = reviewState(questions, answers);
    expect(filterQuestions(questions, answers, "all", s.findingIds)).toHaveLength(questions.length);
    const open = filterQuestions(questions, answers, "open", s.findingIds);
    expect(open).toHaveLength(questions.length - 3);
    expect(open.some((q) => q.id === "access:staff:CleaningStaff.revoke_invitation")).toBe(true);
    expect(filterQuestions(questions, answers, "findings", s.findingIds).map((q) => q.id)).toEqual(["tenancy:parent-reads-children"]);
  });
});
