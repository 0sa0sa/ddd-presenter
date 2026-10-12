/**
 * ARCHITECTURE.md (docs/05 §10): generated in both targets next to the context READMEs, hashed in the manifest, equal to
 * the committed examples, and its containers match what the generator really emits (so core and generator never drift).
 */
import { describe, expect, test } from "bun:test";
import { deriveArchitecture, validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, sha256, type GenerationOutput } from "../src/index.ts";

const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const FIXTURES = ["kitchen-sink", "context-map", "queries", "secure-queries", "security", "tenancy", "identities", "ordering"];

function analyze(text: string) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  return r.analysis!;
}
const withApi = (text: string) => text.replace(/^generation:\n/m, "generation:\n  typescript:\n    api: { base_path: /api }\n");
const architectureOf = (out: GenerationOutput) => out.files.find((f) => f.path.endsWith("/generated/ARCHITECTURE.md"));

describe("ARCHITECTURE.md", () => {
  test("generated (not a scaffold) in both targets and hashed in the manifest", () => {
    for (const target of ["python", "typescript"] as const) {
      const text = read("examples/cleaning-platform/model.ddd.yaml");
      const out = generate(analyze(text), text, target);
      const f = architectureOf(out)!;
      expect(f.path).toBe("src/cleaning_platform/generated/ARCHITECTURE.md");
      expect(f.ownership).toBe("generated");
      expect(out.manifest.files).toContainEqual({ path: f.path, sha256: sha256(f.content) });
      // `--target` decides what the document describes, not `generation.target`.
      expect(f.content).toContain(`(target: ${target})`);
    }
  });

  test("equals the committed examples (golden)", () => {
    for (const dir of ["examples/cleaning-platform", "examples/cleaning-platform-ts"]) {
      const text = read(`${dir}/model.ddd.yaml`);
      const f = architectureOf(generate(analyze(text), text))!;
      expect(f.content).toBe(read(`${dir}/${f.path}`));
    }
  });

  test("its containers are exactly what the generator emits", () => {
    for (const name of FIXTURES) {
      for (const target of ["python", "typescript"] as const) {
        for (const api of [false, true]) {
          if (api && target === "python") continue;
          const raw = read(`packages/generator/test/fixtures/${name}.ddd.yaml`);
          const text = api ? withApi(raw) : raw;
          const analysis = analyze(text);
          const out = generate(analysis, text, target);
          const paths = out.files.map((f) => f.path);
          const has = (re: RegExp) => paths.some((p) => re.test(p));
          const ids = new Set(deriveArchitecture(analysis.model, analysis, { target }).containers.elements.map((e) => e.id));
          const where = `${name} (${target}${api ? ", api" : ""})`;
          expect([where, ids.has("ctr:http-api")]).toEqual([where, has(/\/generated\/api\/server\.ts$/)]);
          expect([where, ids.has("ctr:web-client")]).toEqual([where, has(/\/generated\/api\/client\.ts$/)]);
          expect([where, ids.has("ctr:security")]).toEqual([where, has(/\/generated\/security\.(py|ts)$/)]);
          expect([where, ids.has("ctr:idp")]).toEqual([where, has(/\/generated\/(authentication\.py|api\/authentication\.ts)$/)]);
          expect([where, ids.has("ctr:postgres")]).toEqual([where, has(/^sql\/.*\.sql$/)]);
          expect([where, ids.has("ctr:events")]).toEqual([where, has(/\/application\/policies\.(py|ts)$/)]);
          for (const ctx of analysis.model.contexts) {
            expect(ids.has(`ctr:app:${ctx.name}`) && ids.has(`ctr:domain:${ctx.name}`)).toBe(true);
          }
        }
      }
    }
  });

  test("other generated files stay as they were (only the new file and the manifest change)", () => {
    const text = read("examples/cleaning-platform-ts/model.ddd.yaml");
    const out = generate(analyze(text), text);
    for (const f of out.files.filter((x) => x.ownership === "generated" && !x.path.endsWith("ARCHITECTURE.md"))) {
      expect(f.content).toBe(read(`examples/cleaning-platform-ts/${f.path}`));
    }
  });
});
