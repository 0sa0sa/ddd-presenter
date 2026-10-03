import type { Analysis, ModelIR } from "@ddd/core";
import { modelHash, sha256, type GeneratedFile, type GenerationOutput, type Manifest } from "../output.ts";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../python/support.ts";
import { extensionSignature, portsFile, useCasesFile } from "./application.ts";
import { assemble, Code, docLines, header, relativeSpecifier, SCAFFOLD_HEADER, TsImports, tsString } from "./code.ts";
import { contextReadme } from "./docs.ts";
import { PRINT_WIDTH } from "./format.ts";
import { aggregatesFile, commandsFile, entitiesFile, enumsFile, errorsFile, eventsFile, rulesFile, valueObjectsFile } from "./domain.ts";
import { TsLayout, TsPaths } from "./layout.ts";
import { ident, prop, toSnake } from "./names.ts";
import { policiesFile, policyTestFile, translatorScaffold } from "./policies.ts";
import ADAPTERS_TS from "./templates/adapters.ts.txt" with { type: "text" };
import RUNTIME_TS from "./templates/runtime.ts.txt" with { type: "text" };
import TESTING_TS from "./templates/testing.ts.txt" with { type: "text" };
import { aggregateTestFile, invariantTestFile, testingFile, useCaseTestFile } from "./tests.ts";
import { tsType } from "./types.ts";

/** Versions written into the scaffolded package.json (customer-owned afterwards). */
export const TS_DEPENDENCIES = {
  zod: "^4.1.0",
  "decimal.js": "^10.6.0",
  typescript: "^7.0.2",
  vitest: "^5.0.3",
  "@types/node": "^26.0.0",
  "@types/bun": "^1.2.0",
} as const;

/** Deterministic TypeScript (Zod v4) generation. The analysis must come from a model without errors. */
export function generateTypeScript(analysis: Analysis, modelText: string): GenerationOutput {
  if (analysis.diagnostics.some((d) => d.severity === "error")) {
    throw new Error("Cannot generate code from a model with errors; run validation first");
  }
  const model = analysis.model;
  const P = new TsPaths(model);
  const files: GeneratedFile[] = [];
  const gen = (path: string, content: string) => files.push({ path, content, ownership: "generated" });
  const scaffold = (path: string, content: string) => {
    if (!files.some((f) => f.path === path)) files.push({ path, content, ownership: "scaffold" });
  };
  const template = (doc: string, source: string) => `${header(model)}\n\n${docLines(doc, "").join("\n")}\n\n${source.trimEnd()}\n`;

  gen(P.file(P.runtime), template("Base classes, value schemas and helpers shared by the generated domain code (zod + decimal.js only).", RUNTIME_TS));
  gen(P.file(P.adapters), template("Reference adapters for the clock and id ports (usable in every context).", ADAPTERS_TS));
  gen(P.file(P.testing), template("In-memory test doubles and assertion helpers shared by every context.", TESTING_TS));

  const contexts = [...analysis.contexts.values()];
  gen(P.file(`${P.generated}/index`), rootIndex(model, P, contexts.map((c) => c.ir.name)));
  scaffold(P.file(`${P.root}/index`), `${SCAFFOLD_HEADER}\n\n${docLines(`${model.project}${model.description ? ` — ${model.description.trim()}` : ""}`, "").join("\n")}\n\nexport * from "./generated/index.js";\n`);

  for (const ca of contexts) {
    const L = new TsLayout(model, ca);
    const policies = policiesFile(L);
    for (const f of [
      errorsFile(L),
      enumsFile(L),
      valueObjectsFile(L),
      entitiesFile(L),
      eventsFile(L),
      aggregatesFile(L),
      commandsFile(L),
      rulesFile(L),
      portsFile(L),
      useCasesFile(L),
      testingFile(L),
      contextReadme(L, analysis),
      contextIndex(L, !!policies),
    ]) {
      gen(f.path, f.content);
    }
    for (const ag of ca.ir.aggregates) {
      const t = aggregateTestFile(L, ag);
      if (t) gen(t.path, t.content);
    }
    for (const uc of ca.ir.useCases) {
      const t = useCaseTestFile(L, uc);
      if (t) gen(t.path, t.content);
    }
    const invariants = invariantTestFile(L);
    if (invariants) gen(invariants.path, invariants.content);
    if (policies) gen(policies.path, policies.content);
    const policyTests = policyTestFile(L, analysis);
    if (policyTests) gen(policyTests.path, policyTests.content);
    const translators = translatorScaffold(L);
    if (translators) scaffold(translators.path, translators.content);
    if (ca.ir.extensionPoints.length) {
      const ext = extensionsScaffold(L);
      scaffold(ext.path, ext.content);
    }
  }
  scaffold("package.json", packageJson(model));
  scaffold("tsconfig.json", tsconfigJson(model));
  // The generated code is Prettier-clean at this width (Prettier's default is 80).
  scaffold(".prettierrc.json", `${JSON.stringify({ printWidth: PRINT_WIDTH }, null, 2)}\n`);

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestPath = `${P.generated}/model_manifest.json`;
  const manifest: Manifest = {
    generator: GENERATOR_NAME,
    generator_version: GENERATOR_VERSION,
    schema_version: model.schemaVersion,
    project: model.project,
    model_sha256: modelHash(modelText),
    files: files.filter((f) => f.ownership === "generated").map((f) => ({ path: f.path, sha256: sha256(f.content) })),
    scaffold: files.filter((f) => f.ownership === "scaffold").map((f) => f.path),
  };
  return { files, manifest, manifestPath, testsDir: model.generation.testsDir };
}

function rootIndex(model: ModelIR, P: TsPaths, contexts: string[]): string {
  const self = `${P.generated}/index`;
  const lines = [`export * from "${relativeSpecifier(self, P.runtime)}";`];
  for (const ctx of [...contexts].sort()) lines.push(`export * as ${ident(toSnake(ctx))} from "${relativeSpecifier(self, `${P.contextBase(ctx)}/index`)}";`);
  return `${header(model)}\n\n${docLines(`Code generated from model "${model.project}": the runtime, plus one namespace per bounded context.`, "").join("\n")}\n\n${lines.join("\n")}\n`;
}

function contextIndex(L: TsLayout, policies: boolean): { path: string; content: string } {
  const mods = [
    L.mod("errors"),
    L.mod("enums"),
    L.mod("value-objects"),
    L.mod("entities"),
    L.mod("aggregates"),
    L.mod("events"),
    L.mod("commands"),
    L.mod("rules"),
    L.ports,
    L.useCases,
    ...(policies ? [L.policies] : []),
  ];
  const body = mods.map((m) => `export * from "${relativeSpecifier(L.index, m)}";`).join("\n");
  const doc = `Bounded context ${L.ca.ir.name}.${L.ca.ir.description ? ` ${L.ca.ir.description.trim()}` : ""}\n\nTest doubles are in testing.ts (not exported here).`;
  return { path: L.file(L.index), content: `${header(L.model)}\n\n${docLines(doc, "").join("\n")}\n\n${body}\n` };
}

function extensionsScaffold(L: TsLayout): { path: string; content: string } {
  const module = L.extensions(L.ca.ir.name, "extensions");
  const imp = new TsImports(module);
  imp.type(L.ports, "Extensions");
  const c = new Code();
  const cls = `${L.ca.ir.name}Extensions`;
  c.line();
  c.doc(`Implementation of the ${L.ca.ir.name} extension points.\n\nThis file was created once by DDD Presenter and belongs to you; it is never overwritten.`);
  c.block(`export class ${cls} implements Extensions`, () => {
    L.ca.ir.extensionPoints.forEach((x, i) => {
      if (i) c.line();
      // The stub takes no parameters (still assignable to the interface); add the ones you use.
      const signature = extensionSignature(L, x, new TsImports(module));
      c.doc(`${x.description ?? x.name}\n\nInterface: \`${signature}\``);
      c.block(`${prop(x.name)}(): ${tsType(L.resolve(x.returns), imp, L)}`, () => {
        c.line(`throw new Error(${tsString(`${x.name} is not implemented yet`)});`);
      });
    });
  });
  return { path: L.file(module), content: assemble(SCAFFOLD_HEADER, undefined, imp, c.toString()) };
}

function packageJson(model: ModelIR): string {
  const bun = model.generation.typescript.testRunner === "bun";
  const name = model.project.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "") || "domain";
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    ...(model.description ? { description: model.description.trim() } : {}),
    scripts: { test: bun ? "bun test" : "vitest run", typecheck: "tsc --noEmit" },
    dependencies: { "decimal.js": TS_DEPENDENCIES["decimal.js"], zod: TS_DEPENDENCIES.zod },
    devDependencies: bun
      ? { "@types/bun": TS_DEPENDENCIES["@types/bun"], typescript: TS_DEPENDENCIES.typescript }
      : { "@types/node": TS_DEPENDENCIES["@types/node"], typescript: TS_DEPENDENCIES.typescript, vitest: TS_DEPENDENCIES.vitest },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function tsconfigJson(model: ModelIR): string {
  const dirs = [model.generation.srcDir, model.generation.testsDir].map((d) => (d === "." ? "." : d.replace(/\/+$/, "")));
  const config = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      erasableSyntaxOnly: true,
      skipLibCheck: true,
      noEmit: true,
      types: [model.generation.typescript.testRunner === "bun" ? "bun" : "node"],
    },
    include: [...new Set(dirs)],
  };
  return JSON.stringify(config, null, 2) + "\n";
}
