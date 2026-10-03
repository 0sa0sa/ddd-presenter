import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, hover } from "../src/index.ts";

/** The ordering model (arithmetic, durations, collection functions, constructors, let). */
const ORDERING = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/ordering.ddd.yaml"), "utf8");

/** Cursor right after the n-th `needle` (or at `delta` within it). */
function after(needle: string, delta = needle.length, nth = 0): [string, number] {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = ORDERING.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`not found: ${needle}`);
  return [ORDERING, i + delta];
}

/** Replaces `needle` with `replacement` containing `|` (the cursor). */
function edit(needle: string, replacement: string): [string, number] {
  const i = ORDERING.indexOf(needle);
  if (i < 0) throw new Error(`not found: ${needle}`);
  const text = ORDERING.slice(0, i) + replacement + ORDERING.slice(i + needle.length);
  const c = text.indexOf("|", i);
  return [text.slice(0, c) + text.slice(c + 1), c];
}

const labels = (t: [string, number]) => complete(...t).items.map((i) => i.label);

describe("expression language service", () => {
  test("functions are offered and described", () => {
    const items = labels(edit("            expression: any(lines, item.line_id == line_id)", "            expression: |"));
    for (const f of ["sum", "count", "any", "all", "append", "remove_where", "replace_where", "with", "days", "hours", "round"]) expect(items).toContain(f);
    expect(items).toContain("Money");
    expect(items).toContain("OrderLine");
    expect(hover(...after("count(lines, item.line_id", 2))!.markdown).toContain("count(list[, 条件]) → Integer");
    expect(hover(...after("hours(24)", 1))!.markdown).toContain("Duration");
  });

  test("item is the element inside collection functions, with its fields", () => {
    const inside = edit("any(lines, item.line_id == line_id)", "any(lines, |");
    expect(labels(inside)).toContain("item");
    const members = labels(edit("any(lines, item.line_id == line_id)", "any(lines, item.|"));
    expect(members).toEqual(expect.arrayContaining(["line_id", "sku", "quantity", "unit_price"]));
    expect(hover(...after("any(lines, item.line_id", 12))!.markdown).toContain("OrderLine");
    expect(labels(edit("expression: count(lines) <= 50", "expression: |"))).not.toContain("item");
  });

  test("let steps are offered as keys, their values complete like expressions, and later steps see the name", () => {
    expect(labels(edit("          - return: line_count\n", "          - le|\n          - return: line_count\n"))).toContain("let");
    expect(labels(edit("              value: count(order.lines)", "              value: count(order.|"))).toContain("lines");
    const later = labels(edit("          - return: line_count", "          - return: |"));
    expect(later).toContain("line_count");
    const h = hover(...after("- return: total", "- return: ".length + 1))!;
    expect(h.markdown).toContain("`total`: Decimal — let で名付けた値");
  });
});
