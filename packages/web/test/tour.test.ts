import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOURS } from "../src/lib/tour.ts";
import { TUTORIAL_STEPS } from "../src/lib/tutorial.ts";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".tsx") ? [join(dir, f)] : []));
const source = files(SRC).map((f) => readFileSync(f, "utf8")).join("\n");

/** data-tour values present in the UI, including templated ones like `palette-${k}` and `tab-${t.id}`. */
function exists(target: string): boolean {
  if (source.includes(`data-tour="${target}"`)) return true;
  if (target.startsWith("palette-") && source.includes("data-tour={`palette-${k}`}")) return true;
  if (target.startsWith("tab-") && source.includes("data-tour={`tab-${t.id}`}")) return true;
  return false;
}

describe("spotlight tours", () => {
  test("every tutorial step has a tour", () => {
    for (const s of TUTORIAL_STEPS) expect({ step: s.id, stops: TOURS[s.id]?.length ?? 0 }).toEqual({ step: s.id, stops: expect.any(Number) });
    expect(TUTORIAL_STEPS.every((s) => (TOURS[s.id]?.length ?? 0) > 0)).toBe(true);
  });

  test("every highlighted element exists in the UI", () => {
    const missing = Object.entries(TOURS).flatMap(([step, stops]) => stops.filter((s) => !exists(s.target)).map((s) => `${step}: ${s.target}`));
    expect(missing).toEqual([]);
  });

  test("each stop explains what to do", () => {
    for (const stops of Object.values(TOURS)) for (const s of stops) expect(s.title.length > 4 && s.body.length > 20).toBe(true);
  });
});
