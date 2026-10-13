import { describe, expect, test } from "bun:test";
import { splitModelText, splitToYaml } from "@ddd/core";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, createZip, readZip, stripCommonFolder } from "../src/lib/zip.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

describe("zip (multi-file model export / import)", () => {
  test("crc32 of a known string", () => {
    expect(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  test("the exported archive reads back, and converts to the same YAML model", async () => {
    const { files } = splitModelText(SAMPLE);
    const zip = createZip(files);
    const back = await readZip(zip);
    expect(back).toEqual(files);
    expect(splitToYaml(back).yaml).toBe(splitToYaml(files).yaml);
  });

  test("the system unzip accepts the archive (when unzip is installed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-zip-"));
    writeFileSync(join(dir, "m.zip"), createZip({ "ddd.yaml": "schema_version: 1\n", "ddd/v1/options.proto": "// 日本語\n" }));
    const r = spawnSync("unzip", ["-t", join(dir, "m.zip")], { encoding: "utf8" });
    if (r.error) return; // no unzip here
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No errors detected");
  });

  test("deflated archives made by zip read too (when zip is installed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-zip-"));
    writeFileSync(join(dir, "ddd.yaml"), "schema_version: 1\nproject: x\n".repeat(50));
    const r = spawnSync("zip", ["-q", "-r", "m.zip", "ddd.yaml"], { cwd: dir });
    if (r.error) return;
    const files = await readZip(new Uint8Array(readFileSync(join(dir, "m.zip"))));
    expect(files["ddd.yaml"]).toBe("schema_version: 1\nproject: x\n".repeat(50));
  });

  test("a folder that wraps everything is removed", () => {
    expect(stripCommonFolder({ "shop/ddd.yaml": "a", "shop/x/y.flow": "b" })).toEqual({ "ddd.yaml": "a", "x/y.flow": "b" });
    expect(stripCommonFolder({ "ddd.yaml": "a", "x/y.flow": "b" })).toEqual({ "ddd.yaml": "a", "x/y.flow": "b" });
  });
});
