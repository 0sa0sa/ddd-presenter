import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateModelText } from "../src/index.ts";

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
