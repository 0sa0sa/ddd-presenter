/** The .proto files `ddd migrate --split` writes pass `buf build` and `buf lint` (when buf is installed; BUF=path/to/buf). */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { splitModelText } from "../src/index.ts";

const BUF = process.env.BUF ?? "buf";
const available = !spawnSync(BUF, ["--version"]).error;
const ROOT = join(import.meta.dir, "../../..");
const FIXTURES = join(ROOT, "packages/generator/test/fixtures");
const CORPUS = [join(ROOT, "examples/cleaning-platform/model.ddd.yaml"), join(ROOT, "examples/cleaning-platform-ts/model.ddd.yaml"), ...readdirSync(FIXTURES).filter((f) => f.endsWith(".ddd.yaml")).map((f) => join(FIXTURES, f))];

describe.skipIf(!available)("buf accepts the converted .proto files", () => {
  for (const path of CORPUS) {
    test(path.split("/").slice(-2).join("/"), () => {
      const dir = mkdtempSync(join(tmpdir(), "ddd-buf-"));
      for (const [p, c] of Object.entries(splitModelText(readFileSync(path, "utf8")).files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
      const build = spawnSync(BUF, ["build"], { cwd: dir, encoding: "utf8" });
      expect(build.stderr + build.stdout).toBe("");
      expect(build.status).toBe(0);
      const lint = spawnSync(BUF, ["lint"], { cwd: dir, encoding: "utf8" });
      expect(lint.stdout + lint.stderr).toBe("");
      expect(lint.status).toBe(0);
    });
  }
});
