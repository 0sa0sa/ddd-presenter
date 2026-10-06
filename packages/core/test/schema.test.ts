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

  test("generation.typescript.api: base_path and client are checked like the built-in parser", () => {
    const ts = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform-ts/model.ddd.yaml"), "utf8");
    const withApi = (api: string) => ts.replace(/^ {4}api:.*\n/m, "").replace(/^ {4}test_runner: vitest.*$/m, `    test_runner: vitest\n    api: ${api}`);
    for (const ok of ["{ base_path: /api, client: tanstack-query }", "{ base_path: /api/v1 }", '{ base_path: "" }', "{}"]) {
      expect(validate(parse(withApi(ok)))).toBe(true);
    }
    for (const bad of ["{ base_path: /api/ }", "{ base_path: api }", "{ client: swr }", "{ basepath: /api }"]) {
      expect(validate(parse(withApi(bad)))).toBe(false);
    }
  });

  test("accepts queries (params, where, search, order_by, page, returns, scenarios) and rejects unknown keys and values", () => {
    const q = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/queries.ddd.yaml"), "utf8");
    const ok = validate(parse(q));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(validate(parse(q.replace("mode: trigram", "mode: fuzzy")))).toBe(false);
    expect(validate(parse(q.replace("op: gte", "op: between")))).toBe(false);
    expect(validate(parse(q.replace("page: { size: 2, max_size: 50 }", "page: { size: 2, max: 50 }")))).toBe(false);
    expect(validate(parse(q.replace("next_cursor: absent", "next_cursor: maybe")))).toBe(false);
  });

  test("rejects unknown keys and bad names like the built-in parser", () => {
    expect(validate(parse(SAMPLE.replace("    enums:", "    enumz:")))).toBe(false);
    expect(validate(parse(SAMPLE.replace("name: CleaningStaffInvitation", "name: cleaning_staff_invitation")))).toBe(false);
  });
});
