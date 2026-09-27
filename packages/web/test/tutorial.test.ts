import { describe, expect, test } from "bun:test";
import { boardToModel, emptyBoard, sampleBoard, validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextStep, TUTORIAL_STEPS, tutorialProgress, type ProgressInput } from "../src/lib/tutorial.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const EMPTY = "schema_version: 1\nproject: t\ngeneration:\n  package: t\n\ncontexts:\n  - name: Core\n    errors: []\n    aggregates: []\n    use_cases: []\n";
const base = (over: Partial<ProgressInput> = {}): ProgressInput => ({ savedOk: true, savedVersion: 1, visited: new Set(), manualDone: new Set(), ...over });

describe("tutorial progress", () => {
  test("a new project starts at the first step", () => {
    const p = tutorialProgress(base({ board: emptyBoard(), saved: validateModelText(EMPTY).model }));
    expect(Object.values(p).every((v) => !v)).toBe(true);
    expect(nextStep(p)?.id).toBe("events");
  });

  test("the sample board completes every discovery step", () => {
    const p = tutorialProgress(base({ board: sampleBoard() }));
    expect(["events", "commands", "actors", "aggregate", "rule", "context"].every((id) => p[id])).toBe(true);
    expect(nextStep(p)?.id).toBe("reflect");
  });

  test("reflecting and saving moves on to fields and rules", () => {
    const yaml = boardToModel(sampleBoard(), EMPTY).yaml!;
    const model = validateModelText(yaml).model;
    const p = tutorialProgress(base({ board: sampleBoard(), draft: model, saved: model, savedVersion: 2 }));
    expect(p.reflect).toBe(true);
    expect(p.save).toBe(true);
    expect(nextStep(p)?.id).toBe("fields");
  });

  test("the full sample model satisfies the modelling steps", () => {
    const model = validateModelText(SAMPLE).model;
    const p = tutorialProgress(base({ board: sampleBoard(), draft: model, saved: model, savedVersion: 3, visited: new Set(["preview"]) }));
    expect(p.fields && p["rules-in-model"] && p.scenario && p.save && p.preview).toBe(true);
    expect(nextStep(p)?.id).toBe("cli");
    const done = tutorialProgress(base({ board: sampleBoard(), draft: model, saved: model, savedVersion: 3, visited: new Set(["preview"]), manualDone: new Set(["cli"]) }));
    expect(nextStep(done)).toBeUndefined();
  });

  test("saving with errors does not count", () => {
    const model = validateModelText(SAMPLE).model;
    expect(tutorialProgress(base({ saved: model, savedVersion: 3, savedOk: false })).save).toBe(false);
  });

  test("every step has instructions and a tab", () => {
    for (const s of TUTORIAL_STEPS) {
      expect(s.how.length).toBeGreaterThan(0);
      expect(s.why.length).toBeGreaterThan(10);
    }
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(TUTORIAL_STEPS.length);
  });
});
