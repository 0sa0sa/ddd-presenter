import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/model.schema.json"), "utf8"));
const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const ORDERING = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/ordering.ddd.yaml"), "utf8");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

describe("published JSON Schema", () => {
  test("accepts the sample model", () => {
    const ok = validate(parse(SAMPLE));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("accepts the expression extensions (let steps, [] values, constructors)", () => {
    const ok = validate(parse(ORDERING));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(validate(parse(ORDERING.replace("              value: count(order.lines)\n", "")))).toBe(false);
  });

  test("accepts the TypeScript example (generation.target, typescript.test_runner) and rejects unknown values", () => {
    const ts = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform-ts/model.ddd.yaml"), "utf8");
    const ok = validate(parse(ts));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(validate(parse(ts.replace("target: typescript", "target: rust")))).toBe(false);
    expect(validate(parse(ts.replace("test_runner: vitest", "test_runner: jest")))).toBe(false);
  });

  test("rejects unknown keys and bad names like the built-in parser", () => {
    expect(validate(parse(SAMPLE.replace("    enums:", "    enumz:")))).toBe(false);
    expect(validate(parse(SAMPLE.replace("name: CleaningStaffInvitation", "name: cleaning_staff_invitation")))).toBe(false);
  });
});
