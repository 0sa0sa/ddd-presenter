import { describe, expect, test } from "bun:test";
import { modelSourceText, splitModelText, validateModelFiles, validateModelText } from "@ddd/core";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURES = join(import.meta.dir, "fixtures");
const CORPUS: [string, string][] = [
  ["cleaning-platform", join(ROOT, "examples/cleaning-platform/model.ddd.yaml")],
  ["cleaning-platform-ts", join(ROOT, "examples/cleaning-platform-ts/model.ddd.yaml")],
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".ddd.yaml"))
    .map((f): [string, string] => [f, join(FIXTURES, f)]),
];

describe("the multi-file format generates the same code as YAML", () => {
  for (const [name, path] of CORPUS) {
    for (const target of ["python", "typescript"] as const) {
      test(`${name} (${target})`, () => {
        const text = readFileSync(path, "utf8");
        const yaml = validateModelText(text);
        if (!yaml.ok) return; // fixtures that exist to show diagnostics have nothing to generate
        const files = splitModelText(text).files;
        const split = validateModelFiles(files);
        expect(split.ok).toBe(true);
        const a = generate(yaml.analysis!, text, target);
        const b = generate(split.analysis!, modelSourceText(files), target);
        const byPath = (o: typeof a) => Object.fromEntries(o.files.map((f) => [f.path, f.content]));
        expect(byPath(b)).toEqual(byPath(a));
        // Only the model hash in the manifest differs (it hashes the sources the code was generated from).
        expect({ ...b.manifest, model_sha256: "" }).toEqual({ ...a.manifest, model_sha256: "" });
      });
    }
  }
});
