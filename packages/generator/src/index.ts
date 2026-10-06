import type { Analysis, GenerationTarget } from "@ddd/core";
import { portsFile, resolveReturn, useCasesFile } from "./python/application.ts";
import { contextReadme } from "./python/docs.ts";
import { aggregatesFile, commandsFile, entitiesFile, enumsFile, errorsFile, eventsFile, paramTypes, rulesFile, valueObjectsFile } from "./python/domain.ts";
import { assemble, header, Layout, ModuleImports } from "./python/layout.ts";
import { policiesFile, policyTestFile, translatorScaffolds } from "./python/policies.ts";
import { ADAPTERS_PY, RUNTIME_PY } from "./python/runtime.ts";
import { Code, docstringLines, GENERATOR_NAME, GENERATOR_VERSION, pyType } from "./python/support.ts";
import { aggregateTestFile, invariantTestFile, testingFile, useCaseTestFile } from "./python/tests.ts";
import { readAccessFile, securityFiles, servedOverHttp } from "./python/security.ts";
import { securityTestFile } from "./python/security-tests.ts";
import { modelHash, sha256, type GeneratedFile, type GenerationOutput, type Manifest } from "./output.ts";
import { generateTypeScript } from "./typescript/index.ts";
import { persistenceRuntime } from "./python/persistence.ts";
import { pyContextPlans, pyHasQueries, pyPersistenceTestFile, pyPostgresFile, pyQueriesFile, pyQueryTestFile, pyRowsFile } from "./python/queries.ts";
import { contextSqlFile } from "./sql.ts";

export { GENERATOR_NAME, GENERATOR_VERSION };
export * from "./plan.ts";
export * from "./output.ts";
export { generateTypeScript } from "./typescript/index.ts";

/** Deterministic Python generation. The analysis must come from a model without errors. */
export function generatePython(analysis: Analysis, modelText: string): GenerationOutput {
  if (analysis.diagnostics.some((d) => d.severity === "error")) {
    throw new Error("Cannot generate code from a model with errors; run validation first");
  }
  const model = analysis.model;
  const pkg = model.generation.package;
  const src = model.generation.srcDir;
  const files: GeneratedFile[] = [];
  const gen = (path: string, content: string) => files.push({ path, content, ownership: "generated" });
  const scaffold = (path: string, content: string) => {
    if (!files.some((f) => f.path === path)) files.push({ path, content, ownership: "scaffold" });
  };
  const initPy = (doc: string) => `${header(model)}\n\n${docstringLines(doc, "").join("\n")}\n`;

  scaffold(`${src}/${pkg}/__init__.py`, `${docstringLines(`${model.project}${model.description ? ` — ${model.description}` : ""}`, "").join("\n")}\n`);
  // PEP 561 marker: type checkers of other packages use the inline annotations (the top-level package is customer-owned).
  scaffold(`${src}/${pkg}/py.typed`, "");
  gen(`${src}/${pkg}/generated/__init__.py`,initPy(`Code generated from model "${model.project}". Do not edit; regenerate instead.`));
  gen(`${src}/${pkg}/generated/_runtime.py`, `${header(model)}\n\n"""Base classes shared by the generated domain code (Pydantic v2 + stdlib only)."""\n\n${RUNTIME_PY}`);
  gen(`${src}/${pkg}/generated/adapters.py`, `${header(model)}\n\n"""Reference adapters for the clock and id ports (structurally typed; usable in every context)."""\n\n${ADAPTERS_PY}`);
  if (model.security) {
    const contexts = [...analysis.contexts.values()];
    const served = { useCases: contexts.flatMap((ca) => ca.ir.useCases.filter(servedOverHttp)), aggregates: contexts.flatMap((ca) => ca.ir.aggregates) };
    for (const f of securityFiles(model, served)) gen(f.path, f.content);
    const t = securityTestFile(model, contexts.map((ca) => new Layout(model, ca)));
    if (t) gen(t.path, t.content);
  }

  let withQueries = false;
  for (const ca of analysis.contexts.values()) {
    const L = new Layout(model, ca);
    const dir = `${src}/${L.base.replace(/\./g, "/")}`;
    gen(`${dir}/__init__.py`, initPy(`Bounded context ${ca.ir.name}.${ca.ir.description ? ` ${ca.ir.description}` : ""}`));
    gen(`${dir}/domain/__init__.py`, initPy(`Domain layer of ${ca.ir.name}.`));
    gen(`${dir}/application/__init__.py`, initPy(`Application layer of ${ca.ir.name}.`));
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
    ]) {
      gen(f.path, f.content);
    }
    const readAccess = readAccessFile(L);
    if (readAccess) gen(readAccess.path, readAccess.content);
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
    const policies = policiesFile(L);
    if (policies) gen(policies.path, policies.content);
    const policyTests = policyTestFile(L, analysis);
    if (policyTests) gen(policyTests.path, policyTests.content);
    const translators = translatorScaffolds(L);
    if (translators) {
      scaffold(`${src}/${pkg}/extensions/__init__.py`, `"""Customer-owned code. The generator never overwrites files in this package."""\n`);
      scaffold(`${src}/${pkg}/extensions/${L.ctxModule}/__init__.py`, "");
      scaffold(translators.path, translators.content);
    }
    if (ca.ir.extensionPoints.length) {
      scaffold(`${src}/${pkg}/extensions/__init__.py`, `"""Customer-owned code. The generator never overwrites files in this package."""\n`);
      scaffold(`${src}/${pkg}/extensions/${L.ctxModule}/__init__.py`, "");
      scaffold(`${src}/${pkg}/extensions/${L.ctxModule}/extensions.py`, extensionsScaffold(L));
    }
    // Read side and PostgreSQL persistence: only for contexts that declare queries (docs/09 §19).
    if (pyHasQueries(L)) {
      gen(`${dir}/persistence/__init__.py`, initPy(`PostgreSQL adapters of ${ca.ir.name} (repositories with optimistic locking, query readers).`));
      for (const f of [pyQueriesFile(L), pyRowsFile(L), pyPostgresFile(L), pyPersistenceTestFile(L), ...pyContextPlans(L).map((p) => pyQueryTestFile(L, p))]) gen(f.path, f.content);
      const sql = contextSqlFile(model, ca);
      if (sql) gen(sql.path, sql.content);
      withQueries = true;
    }
  }
  if (withQueries) {
    const doc = docstringLines("Read side and PostgreSQL runtime: connection port, cursor codec (HMAC-SHA256), keyset paging, pg_trgm similarity, optimistic locking (no model-specific code).", "").join("\n");
    gen(`${src}/${pkg}/generated/_persistence.py`, `${header(model)}\n\n${doc}\n\n${persistenceRuntime(`${pkg}.generated._runtime`)}`);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestPath = `${src}/${pkg}/generated/model_manifest.json`;
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

/** Generates code for the model's `generation.target` (or `target` when given, e.g. `ddd generate --target`). */
export function generate(analysis: Analysis, modelText: string, target: GenerationTarget = analysis.model.generation.target): GenerationOutput {
  return target === "typescript" ? generateTypeScript(analysis, modelText) : generatePython(analysis, modelText);
}

export function renderManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

function extensionsScaffold(L: Layout): string {
  const imp = new ModuleImports("__scaffold__");
  imp.from(L.ports, "Extensions");
  const c = new Code();
  const cls = `${L.ca.ir.name}Extensions`;
  c.line().line();
  c.line(`class ${cls}:`);
  c.indent(() => {
    c.docstring(`Implementation of the ${L.ca.ir.name} extension points.\n\nThis file was created once by DDD Presenter and belongs to you; it is never overwritten.`);
    for (const x of L.ca.ir.extensionPoints) {
      const pt = paramTypes(L, undefined, x.parameters);
      const sig = x.parameters.map((p) => `${p.name}: ${pyType(pt.get(p.name)!, imp, L.typeModule, { field: false })}`).join(", ");
      const rt = pyType(resolveReturn(L, x.returns), imp, L.typeModule, { field: false });
      c.line();
      c.line(`def ${x.name}(self${sig ? `, ${sig}` : ""}) -> ${rt}:`);
      c.indent(() => {
        c.docstring(x.description ?? x.name);
        c.line(`raise NotImplementedError("${x.name} is not implemented yet")`);
      });
    }
  });
  c.line().line();
  c.line("# Static check that the class satisfies the generated protocol (verified by mypy).");
  c.line(`_conforms: Extensions = ${cls}()`);
  return assemble(L.model, undefined, imp, c.toString(), { exports: false }).replace(/^# Generated by[^\n]*\n# Regenerate[^\n]*\n\n/, "# Created by DDD Presenter as a starting point. This file is yours to edit.\n\n");
}
