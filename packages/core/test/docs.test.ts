import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlow, validateModelFiles, validateModelText } from "../src/index.ts";

const docs = (name: string) => readFileSync(join(import.meta.dir, "../../../docs", name), "utf8");

describe("tutorial documentation", () => {
  test("the YAML the tutorial asks learners to write is a valid model", () => {
    const md = docs("12-tutorial.md");
    const block = md.split("ステップ 8〜10 の書き足しの例")[1]!.split("```yaml\n")[1]!.split("```")[0]!;
    const model = `schema_version: 1\nproject: staff\ngeneration:\n  package: staff\ncontexts:\n  - name: StaffInvitation\n${block}`;
    const r = validateModelText(model);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });
});

describe("DSL reference §12 (multi-file format)", () => {
  test("the .proto, .domain, .flow and scenario examples form a valid model", () => {
    const md = docs("10-dsl-reference.md").split("## 12. 複数ファイル形式")[1]!;
    const block = (lang: string) => md.split("```" + lang + "\n")[1]!.split("```")[0]!;
    const r = validateModelFiles({
      "ddd.yaml": "schema_version: 1\nproject: shop\nsecurity: { roles: [clerk] }\ncontexts: [Ordering]\n",
      "ordering.proto": md.split("### 12.2")[1]!.split("```proto\n")[1]!.split("```")[0]!,
      "ordering.domain": block("ddd-domain"),
      "ordering.flow": block("ddd-flow"),
      "ordering.scenarios.yaml": md.split("### 12.5")[1]!.split("```yaml\n")[1]!.split("```")[0]!,
    });
    expect(r.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.file}:${d.line} ${d.code} ${d.message}`)).toEqual([]);
  });

  test("the query and policy example parses", () => {
    const md = docs("10-dsl-reference.md").split("## 12. 複数ファイル形式")[1]!;
    const second = md.split("```ddd-flow\n")[2]!.split("```")[0]!;
    const f = parseFlow(`context CleaningStaff\n${second}`);
    expect(f.queries[0]).toMatchObject({ name: "search_invitations", from: "Invitation", returns: ["id", "email", "status"] });
    expect(f.queries[0]!.where.map((w) => [w.field, w.op, w.param ?? w.principal ?? w.value])).toEqual([
      ["status", "eq", "status"],
      ["created_at", "gt", "created_after"],
      ["company_id", "eq", "company_id"],
      ["archived", "eq", false],
    ]);
    expect(f.policies[0]).toMatchObject({ name: "register_staff_on_acceptance", event: "CleaningStaff.InvitationAccepted", run: "register_staff", doc: "Registers the staff member when an invitation is accepted." });
  });
});
