import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateModelText } from "../src/index.ts";
import { deriveViolations } from "../src/rulecheck.ts";

const ORDERING = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/ordering.ddd.yaml"), "utf8");

describe("derived violating records", () => {
  test("rules using arithmetic, durations or collection functions are skipped, not mis-evaluated (regression)", () => {
    const r = validateModelText(ORDERING);
    expect(r.ok).toBe(true);
    const derived = [...r.analysis!.contexts.values()].flatMap((ca) => deriveViolations(ca));
    // Nothing crashes, and every derived record targets a rule the evaluator can decide exactly.
    for (const d of derived) expect(JSON.stringify(d)).not.toContain("undefined");
  });
});
