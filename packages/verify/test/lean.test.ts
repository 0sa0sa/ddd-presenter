import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateModelText, type ProofReport } from "@ddd/core";
import { leanCandidates, leanProject, proveProject, verifyModel } from "../src/index.ts";
import { leanName } from "../src/lean.ts";
import { proofOf } from "../src/prove.ts";

const ORDERING = readFileSync(new URL("../../generator/test/fixtures/ordering.ddd.yaml", import.meta.url), "utf8");
/** A Lean 4 binary (`DDD_LEAN=/path/to/lean`, with ELAN_HOME if needed): the tests that run Lean are skipped without it. */
const LEAN = process.env.DDD_LEAN;

let report: ProofReport;
let analysis: NonNullable<ReturnType<typeof validateModelText>["analysis"]>;
beforeAll(async () => {
  analysis = validateModelText(ORDERING).analysis!;
  report = await verifyModel(analysis, { traceDepth: 0 });
}, 60_000);

describe("Lean statements", () => {
  test("the bounded proofs become theorems (lists of any length); counterexamples do not", () => {
    const candidates = leanCandidates(report);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((r) => r.outcome !== "counterexample" && (r.bound !== undefined || r.outcome === "unknown"))).toBe(true);
    const p = leanProject(analysis, report);
    expect(p.skipped).toEqual([]);
    expect(p.theorems.map((t) => t.name)).toContain("Order.remove_line_keeps_at_most_50_lines");
    const file = p.files["Proofs/Sales.lean"]!;
    // Keywords are quoted; the definitions follow the model.
    expect(file).toContain("| «open»");
    expect(file).toContain("def Order.op_remove_line (self : Order) (line_id : Int) : Order :=\n  { self with lines := (self.lines.filter (fun item0 => !decide ((item0.line_id = line_id)))) }");
    // The built entity's own checks are hypotheses (they run before the aggregate's, as in the generated code).
    const st = p.theorems.find((t) => t.name === "Order.add_line_keeps_discount_within_subtotal")!.statement;
    expect(st).toContain("(hbuilt0 : (({ line_id := line_id, sku := sku, quantity := quantity, unit_price := unit_price } : OrderLine)).Valid)");
    expect(st).toContain("(hreq0 : (self.guard_is_open))");
    expect(st.endsWith(".inv_discount_within_subtotal := by")).toBe(true);
    expect(p.files["lean-toolchain"]).toMatch(/^leanprover\/lean4:v4\.\d+\.\d+\n$/);
    expect(leanName("at")).toBe("«at»");
    expect(leanName("line_id")).toBe("line_id");
  });

  test("a reply's proof: fences and a repeated statement are dropped, blank lines too", () => {
    const th = { id: "x", name: "Order.t", module: "Proofs.Sales", statement: "theorem Order.t : True := by" };
    expect(proofOf("```lean\ntrivial\n```", th)).toBe("  trivial");
    expect(proofOf("theorem Order.t : True := by\n  constructor\n\n  rfl", th)).toBe("  constructor\n  rfl");
    expect(proofOf("   ", th)).toBeUndefined();
  });
});

describe.skipIf(!LEAN)("Lean checks the theorems", () => {
  test("the project type-checks; a correct proof is kept, sorry is refused, a wrong proof fails", async () => {
    const p = leanProject(analysis, report);
    p.theorems = p.theorems.filter((t) => /remove_line_keeps_at_most_50_lines|change_quantity_keeps_at_most_50_lines|remove_line_keeps_lines_share_currency/.test(t.name));
    const prover = async (prompt: string) => {
      if (prompt.includes("`Order.remove_line_keeps_at_most_50_lines`"))
        return "have h50 := h.2.1\nunfold Order.inv_at_most_50_lines at h50\nunfold Order.op_remove_line Order.inv_at_most_50_lines\nhave hl := List.length_filter_le (fun item0 => !decide (item0.line_id = line_id)) self.lines\nsimp only at *\nomega";
      if (prompt.includes("`Order.change_quantity_keeps_at_most_50_lines`")) return "sorry";
      return "omega";
    };
    const dir = mkdtempSync(join(tmpdir(), "ddd-lean-"));
    const out = await proveProject(p, dir, { lean: [LEAN!], prover, attempts: 2 });
    const by = Object.fromEntries(out.map((o) => [o.theorem, o]));
    expect(by["Order.remove_line_keeps_at_most_50_lines"]).toMatchObject({ status: "proven", attempts: 1 });
    expect(by["Order.change_quantity_keeps_at_most_50_lines"]).toMatchObject({ status: "failed", error: "refused: uses sorry" });
    expect(by["Order.remove_line_keeps_lines_share_currency"]!.status).toBe("failed");
    // The accepted proof stays in the file; the others keep sorry.
    const file = readFileSync(join(dir, "Proofs/Sales.lean"), "utf8");
    expect(file).toContain("List.length_filter_le");
  }, 300_000);
});
