import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/model.schema.json"), "utf8"));
const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

describe("published JSON Schema", () => {
  test("accepts the sample model", () => {
    const ok = validate(parse(SAMPLE));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("rejects unknown keys and bad names like the built-in parser", () => {
    expect(validate(parse(SAMPLE.replace("    enums:", "    enumz:")))).toBe(false);
    expect(validate(parse(SAMPLE.replace("name: CleaningStaffInvitation", "name: cleaning_staff_invitation")))).toBe(false);
  });
});
