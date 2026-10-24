import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { proofDiagnostics, proofQuestions, proofsMarkdown, validateModelText, type ProofReport } from "@ddd/core";
import { verifyModel } from "../src/index.ts";

const fixture = (name: string) => readFileSync(new URL(`../../generator/test/fixtures/${name}.ddd.yaml`, import.meta.url), "utf8");

async function verify(text: string, opts = {}): Promise<{ report: ProofReport; analysis: NonNullable<ReturnType<typeof validateModelText>["analysis"]> }> {
  const r = validateModelText(text);
  expect(r.ok).toBe(true);
  return { report: await verifyModel(r.analysis!, opts), analysis: r.analysis! };
}

const find = (rep: ProofReport, op: string, source: string) => rep.results.find((r) => r.name === op && r.source.name === source);

describe("ordering", () => {
  let report: ProofReport;
  let analysis: Parameters<typeof proofQuestions>[0];
  beforeAll(async () => {
    ({ report, analysis } = await verify(fixture("ordering")));
  }, 60_000);

  test("a factory that sets constants keeps every invariant (a complete proof: no list bound is needed)", () => {
    for (const r of report.results.filter((x) => x.kind === "factory")) {
      expect(r.outcome).toBe("proven");
      expect(r.bound).toBeUndefined();
    }
  });

  test("removing a line can break 'discount within subtotal'; the starting state is reached from the factory", () => {
    const r = find(report, "remove_line", "discount_within_subtotal")!;
    expect(r.outcome).toBe("counterexample");
    expect(r.source.error).toBe("DiscountTooLarge");
    expect(r.trace).toEqual(["open", "add_line", "apply_discount", "remove_line"]);
    // The example is consistent: the removed line was the subtotal, the discount is positive.
    const st = r.example!.state!;
    expect(Number(st.discount)).toBeGreaterThan(0);
    expect(r.example!.args.line_id).toBe((st.lines as { line_id: number }[])[0]!.line_id);
    expect(r.example!.focus).toContain("discount");
    expect(r.example!.focus).not.toContain("promised_on");
  });

  test("adding a line keeps the discount within the subtotal for lists up to the bound the model compares with", () => {
    const r = find(report, "add_line", "discount_within_subtotal")!;
    expect(r.outcome).toBe("proven");
    expect(r.bound).toBe(51);
  });

  test("the 51st line: found with the list bound derived from count(lines) <= 50", () => {
    const r = find(report, "add_line", "at_most_50_lines")!;
    expect(r.outcome).toBe("counterexample");
    expect((r.example!.state!.lines as unknown[]).length).toBe(50);
  });

  test("a value object or entity built by the change is checked (quantity 100 → InvalidLine)", () => {
    const r = find(report, "add_line", "quantity_in_range")!;
    expect(r.source.kind).toBe("entity-invariant");
    expect(r.outcome).toBe("counterexample");
    expect(r.example!.args.quantity === 100 || (r.example!.args.quantity as number) < 1 || (r.example!.args.quantity as number) > 99).toBe(true);
  });

  test("a negative percent breaks the discount; refunds in an open order are not reachable (no trace)", () => {
    const d = find(report, "apply_discount", "discount_within_subtotal")!;
    expect(d.outcome).toBe("counterexample");
    expect(d.trace?.[0]).toBe("open");
    const r = find(report, "change_quantity", "refund_within_paid")!;
    expect(r.outcome).toBe("counterexample");
    // refunded > 0 only after delivery, and an open order is never delivered: the search does not reach it.
    expect(r.trace).toBeUndefined();
  });

  test("every operation can succeed (a witness each)", () => {
    for (const run of report.runs) {
      expect(run.canSucceed).toBe(true);
      expect(run.witness).toBeDefined();
    }
  });

  test("ids are stable for the same model and carry the fingerprint", async () => {
    const again = await verify(fixture("ordering"), { traceDepth: 0 });
    expect(again.report.results.map((r) => r.id)).toEqual(report.results.map((r) => r.id));
    expect(report.results.every((r) => /^proof:Sales\.Order\.\w+\.[\w-]+\.\w+\.\w+:[0-9a-f]{8}$/.test(r.id))).toBe(true);
  }, 60_000);

  test("review questions: one per counterexample, the model answers yes", () => {
    const qs = proofQuestions(analysis, report);
    expect(qs.length).toBe(report.results.filter((r) => r.outcome === "counterexample").length);
    const q = qs.find((x) => x.id === find(report, "remove_line", "discount_within_subtotal")!.id)!;
    expect(q.modelAnswer).toBe("yes");
    expect(q.text).toContain("DiscountTooLarge");
    expect(q.basis).toContain("open → add_line → apply_discount → remove_line");
  });

  test("markdown lists the assumptions and every result", () => {
    const md = proofsMarkdown("ordering", report);
    expect(md).toContain("## 前提");
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 操作")).length).toBe(report.results.length);
  });
});

describe("small models", () => {
  test("constants are constrained values: a decimal_places check on a literal is proven, an unchecked parameter is not", async () => {
    const { report } = await verify(fixture("queries"));
    expect(report.results.find((r) => r.name === "register" && r.source.owner === "Money" && r.source.name === "amount")?.outcome).toBe("proven");
    const long = report.results.find((r) => r.name === "register" && r.source.name === "display_name")!;
    expect(long.outcome).toBe("counterexample");
    // min_length 1, max_length 100: the example is outside.
    const n = String(long.example!.args.display_name).length;
    expect(n < 1 || n > 100).toBe(true);
  }, 60_000);

  test("an operation that can never succeed is a warning", async () => {
    const text = fixture("ordering").replace(
      "            changes: { promised_on: on }",
      "            changes: { promised_on: on, discount: -1 }",
    );
    const { report } = await verify(text, { traceDepth: 0 });
    const run = report.runs.find((r) => r.name === "promise_delivery")!;
    expect(run.canSucceed).toBe(false);
    const d = proofDiagnostics(report);
    expect(d.map((x) => x.code)).toEqual(["never-succeeds"]);
    expect(d[0]!.message).toContain("promise_delivery");
  }, 60_000);

  test("every fixture verifies without an unsupported construct breaking a run", async () => {
    for (const name of ["kitchen-sink", "long-rules", "identities", "context-map", "security", "tenancy", "secure-queries"]) {
      const { report } = await verify(fixture(name), { traceDepth: 1 });
      for (const run of report.runs) expect(run.note ?? "").not.toContain("対象外");
    }
  }, 120_000);
});
