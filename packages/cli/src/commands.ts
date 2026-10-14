import {
  coverageDiagnostics,
  formatDiagnostic,
  isModelSource,
  MANIFEST_FILE,
  modelSourceText,
  parseModel,
  parseReviewAnswers,
  reviewAnswersTemplate,
  reviewFindings,
  reviewMarkdown,
  reviewQuestions,
  ruleUsage,
  SCHEMA_VERSION,
  sortDiagnostics,
  sourceKind,
  splitModelText,
  toSnake,
  validateModelFiles,
  validateModelText,
  type Diagnostic,
  type GenerationTarget,
  type Path,
} from "@ddd/core";
import { computePlan, generate, GENERATOR_VERSION, unifiedDiff, type Manifest, type Plan } from "@ddd/generator";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { atomicApply, readText, safeJoin, type WriteOp } from "./fsops.ts";
import { SAMPLE_MODEL, SAMPLE_MODEL_TS } from "./sample.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
}

export interface CommonOpts {
  model: string;
  out?: string;
  format: "text" | "json";
  /** Overrides the model's `generation.target` (`--target`). */
  target?: GenerationTarget;
}

const paint = (io: Io, code: string, s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Directories never searched for model sources (dependencies, virtual environments, caches, build output). */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "dist", "build", "venv", "generated"]);
const MAX_SOURCES = 2000;

/** The model sources under a multi-file model's root (ddd.yaml, .domain, .flow, .scenarios.yaml, and the .proto files that declare a context), keyed by relative path. */
export function collectSources(root: string): { files: Record<string, string>; error?: string } {
  const files: Record<string, string> = {};
  let count = 0;
  let error: string | undefined;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || error) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && sourceKind(entry.name)) {
        const rel = relative(root, abs).split("\\").join("/");
        // Only the root ddd.yaml is the project's; a nested one belongs to another project.
        if (sourceKind(rel) === "manifest" && rel !== MANIFEST_FILE) continue;
        const text = readText(abs) ?? "";
        // Other .proto files (vendored, other services, buf dependencies) are not the model's.
        if (!isModelSource(rel, text)) continue;
        if (++count > MAX_SOURCES) {
          error = `More than ${MAX_SOURCES} model sources under ${root}; is the model root (the directory with ${MANIFEST_FILE}) the right one?`;
          return;
        }
        files[rel] = text;
      }
    }
  };
  walk(root, 0);
  return { files, ...(error ? { error } : {}) };
}

/** Where the model is: a YAML file, or the root of a multi-file model (a directory with ddd.yaml, or ddd.yaml itself). */
export function resolveModel(model: string): { kind: "yaml"; path: string } | { kind: "split"; root: string; path: string } | undefined {
  const abs = resolve(model);
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  if (isDir(abs)) {
    if (existsSync(join(abs, MANIFEST_FILE))) return { kind: "split", root: abs, path: join(abs, MANIFEST_FILE) };
    if (existsSync(join(abs, "model.ddd.yaml"))) return { kind: "yaml", path: join(abs, "model.ddd.yaml") };
    return undefined;
  }
  if (basename(abs) === MANIFEST_FILE) return existsSync(abs) ? { kind: "split", root: dirname(abs), path: abs } : undefined;
  if (existsSync(abs)) return { kind: "yaml", path: abs };
  // The default ./model.ddd.yaml is missing: a multi-file model in the current directory is the model then.
  if (model === "model.ddd.yaml" && existsSync(resolve(MANIFEST_FILE))) return { kind: "split", root: resolve("."), path: resolve(MANIFEST_FILE) };
  return undefined;
}

function loadModel(io: Io, opts: CommonOpts) {
  const where = resolveModel(opts.model);
  if (!where) {
    io.err(`Model not found: ${opts.model}\nCreate one with "ddd init" or pass a path: ddd validate path/to/model.ddd.yaml (or a directory with ${MANIFEST_FILE})`);
    return undefined;
  }
  if (where.kind === "split") {
    const { files, error } = collectSources(where.root);
    if (error) {
      io.err(`✗ ${error}`);
      return undefined;
    }
    const result = validateModelFiles(files);
    const prefix = relative(process.cwd(), where.root);
    return {
      path: where.path,
      text: modelSourceText(files),
      result,
      root: resolve(opts.out ?? where.root),
      /** Shown before each diagnostic's own file (relative to the model root). */
      label: prefix,
      split: true as const,
      locate: (p: Path) => result.parsed.locate(p),
    };
  }
  const path = where.path;
  const text = readText(path) ?? "";
  const result = validateModelText(text);
  return { path, text, result, root: resolve(opts.out ?? dirname(path)), label: basename(path), split: false as const, locate: (p: Path) => parseModel(text).locate(p) };
}

function printDiagnostics(io: Io, diagnostics: Diagnostic[], file: string, split = false): void {
  for (const d of diagnostics) {
    // Multi-file models: each diagnostic names its own source, relative to the model root (`file` is that root).
    const own = split ? { ...d, file: d.file ? (file ? join(file, d.file) : d.file) : file || "ddd.yaml" } : d;
    const s = formatDiagnostic(own, file);
    const color = d.severity === "error" ? "31" : d.severity === "warning" ? "33" : "36";
    io.err(s.replace(/: (error|warning|info) /, (m) => paint(io, color, m)));
  }
}

function summary(diagnostics: Diagnostic[]): string {
  const n = (s: string) => diagnostics.filter((d) => d.severity === s).length;
  return `${n("error")} error(s), ${n("warning")} warning(s), ${n("info")} info`;
}

// ---------------------------------------------------------------------------

export function cmdValidate(io: Io, opts: CommonOpts & { strict: boolean }): number {
  const m = loadModel(io, opts);
  if (!m) return EXIT.usage;
  const { result } = m;
  // --strict also reviews coverage: rules no scenario tests, errors nothing raises, extension points nothing calls.
  const diagnostics =
    opts.strict && result.analysis ? sortDiagnostics([...result.diagnostics, ...coverageDiagnostics(result.analysis, m.locate)]) : result.diagnostics;
  const failed = !result.ok || (opts.strict && diagnostics.some((d) => d.severity === "warning"));
  if (opts.format === "json") {
    io.out(JSON.stringify({ ok: !failed, diagnostics }, null, 2));
  } else {
    printDiagnostics(io, diagnostics, m.label, m.split);
    io.out(failed ? paint(io, "31", `✗ ${summary(diagnostics)}`) : paint(io, "32", `✓ Model is valid (${summary(diagnostics)})`));
  }
  return failed ? EXIT.failed : EXIT.ok;
}

// ---------------------------------------------------------------------------

interface Lock {
  generator_version: string;
  schema_version: number;
}

function lockPath(modelPath: string): string {
  return join(dirname(modelPath), "ddd.lock");
}

function readLock(modelPath: string): Lock | undefined {
  const t = readText(lockPath(modelPath));
  if (!t) return undefined;
  try {
    return JSON.parse(t) as Lock;
  } catch {
    return undefined;
  }
}

function prepare(io: Io, opts: CommonOpts & { prune?: boolean; force?: boolean }) {
  const m = loadModel(io, opts);
  if (!m) return { ok: false as const, code: EXIT.usage };
  if (!m.result.ok || !m.result.analysis) {
    printDiagnostics(io, m.result.diagnostics, m.label, m.split);
    io.err(paint(io, "31", `✗ Generation stopped: ${summary(m.result.diagnostics)}`));
    return { ok: false as const, code: EXIT.failed };
  }
  const output = generate(m.result.analysis, m.text, opts.target);
  const previousText = readText(join(m.root, output.manifestPath));
  let previous: Manifest | undefined;
  if (previousText) {
    try {
      previous = JSON.parse(previousText) as Manifest;
    } catch {
      io.err(paint(io, "33", `warning: ${output.manifestPath} is not valid JSON; treating all existing files as unknown`));
    }
  }
  const plan = computePlan(output, previous, (p) => readText(safeJoin(m.root, p)), { prune: opts.prune, force: opts.force });
  return { ok: true as const, m, analysis: m.result.analysis, output, plan, previous };
}

const SYMBOL: Record<string, string> = { create: "+", update: "~", unchanged: "=", conflict: "!", keep: "·", stale: "-" };

function printPlan(io: Io, plan: Plan, verbose: boolean): void {
  for (const e of plan.entries) {
    if (!verbose && (e.action === "unchanged" || e.action === "keep")) continue;
    const color = e.action === "conflict" ? "31" : e.action === "stale" ? "33" : e.action === "create" ? "32" : e.action === "update" ? "36" : "90";
    io.out(`${paint(io, color, `${SYMBOL[e.action]} ${e.action.padEnd(9)}`)} ${e.path}${e.reason ? paint(io, "90", `  (${e.reason})`) : ""}`);
  }
  const count = (a: string) => plan.entries.filter((e) => e.action === a).length;
  io.out(
    `${count("create")} to create, ${count("update")} to update, ${count("unchanged")} unchanged, ${count("conflict")} conflict(s), ${count("stale")} stale, ${count("keep")} customer-owned kept`,
  );
  if (plan.breaking.length) {
    io.out(paint(io, "33", `\nBreaking changes to the generated API (${plan.breaking.length}):`));
    for (const b of plan.breaking) io.out(`  ${b.symbol}  ${paint(io, "90", `${b.reason} — ${b.path}`)}`);
    io.out(paint(io, "90", "  Code that imports these symbols (including your extensions) must be updated."));
  }
}

function extensionWarnings(io: Io, root: string, analysis: NonNullable<ReturnType<typeof validateModelText>["analysis"]>, pkg: string, src: string, target: GenerationTarget): void {
  if (target === "typescript") return typeScriptExtensionWarnings(io, root, analysis, pkg, src);
  for (const ca of analysis.contexts.values()) {
    if (!ca.ir.extensionPoints.length) continue;
    const snake = ca.ir.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const file = `${src}/${pkg}/extensions/${snake}/extensions.py`;
    const text = readText(join(root, file));
    if (text === undefined) continue;
    for (const x of ca.ir.extensionPoints) {
      const def = new RegExp(`def ${x.name}\\(([\\s\\S]*?)(?=\\n    def |\\n\\S|$)`).exec(text);
      if (!def) io.err(paint(io, "33", `warning: extension ${x.name} is not implemented in ${file}`));
      else if (/raise NotImplementedError/.test(def[0])) io.err(paint(io, "33", `warning: extension ${x.name} still raises NotImplementedError (${file})`));
    }
  }
}

/** The TypeScript scaffold: a method per extension point that throws "<name> is not implemented yet" until written. */
function typeScriptExtensionWarnings(io: Io, root: string, analysis: NonNullable<ReturnType<typeof validateModelText>["analysis"]>, pkg: string, src: string): void {
  for (const ca of analysis.contexts.values()) {
    if (!ca.ir.extensionPoints.length) continue;
    const dir = toSnake(ca.ir.name).replace(/_/g, "-");
    const file = [src, pkg, "extensions", dir, "extensions.ts"].filter((p) => p !== ".").join("/");
    const text = readText(join(root, file));
    if (text === undefined) continue;
    for (const x of ca.ir.extensionPoints) {
      const method = x.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const def = new RegExp(`\\n {2}(?:async )?${method}\\(([\\s\\S]*?)(?=\\n {2}(?:async )?\\w+\\(|\\n\\}|$)`).exec(text);
      if (!def) io.err(paint(io, "33", `warning: extension ${x.name} is not implemented in ${file}`));
      else if (/is not implemented yet/.test(def[0])) io.err(paint(io, "33", `warning: extension ${x.name} still throws "not implemented yet" (${file})`));
    }
  }
}

export function cmdDiff(io: Io, opts: CommonOpts & { patch: boolean; check: boolean }): number {
  const p = prepare(io, opts);
  if (!p.ok) return p.code;
  const { plan } = p;
  if (opts.format === "json") {
    io.out(
      JSON.stringify(
        { changed: plan.changed, entries: plan.entries.map(({ before: _b, after: _a, ...rest }) => rest), breaking: plan.breaking },
        null,
        2,
      ),
    );
  } else {
    printPlan(io, plan, false);
    if (opts.patch) {
      for (const e of plan.entries) {
        if (e.action === "create" || e.action === "update" || e.action === "conflict" || e.action === "stale") {
          const d = unifiedDiff(e.path, e.before, e.action === "stale" ? undefined : e.after);
          if (d) io.out(d.trimEnd());
        }
      }
    }
    if (!plan.changed) io.out(paint(io, "32", "✓ Generated code is up to date"));
  }
  if (opts.check && plan.changed) {
    io.err(paint(io, "31", "✗ Generated code is out of date with the model."));
    for (const line of checkAdvice(plan)) io.err(`  ${line}`);
    return EXIT.failed;
  }
  return EXIT.ok;
}

/** What actually brings the project up to date, per kind of difference (plain `ddd generate` does not always). */
export function checkAdvice(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.conflicts.length) {
    out.push(
      `${plan.conflicts.length} generated file(s) were edited by hand, so \`ddd generate\` will refuse: move the custom code into the extensions package, or run \`ddd generate --force\` to discard the edits.`,
    );
  }
  if (plan.staleEditedTests.length) {
    out.push(
      `${plan.staleEditedTests.length} stale generated test(s) were edited by hand and import code the model no longer produces: keep what you need under tests/ outside generated/, then run \`ddd generate --prune --force\`.`,
    );
  }
  const keptStale = plan.stale.filter((e) => !e.autoPrune && !e.generatedTest);
  if (keptStale.some((e) => !e.modified)) out.push("Stale generated files remain: review them, then run `ddd generate --prune` to delete them.");
  if (keptStale.some((e) => e.modified)) out.push("Stale generated files with hand edits remain: run `ddd generate --prune --force` to delete them.");
  const plain = plan.entries.some((e) => e.action === "create" || e.action === "update" || (e.action === "stale" && e.autoPrune));
  if (plain && !plan.conflicts.length && !plan.staleEditedTests.length) out.push("Run `ddd generate`.");
  else if (plain) out.push("The remaining changes are applied by `ddd generate` once the above is resolved.");
  return out;
}

export function cmdGenerate(io: Io, opts: CommonOpts & { force: boolean; prune: boolean; dryRun: boolean; updateLock: boolean }): number {
  const pre = loadModel(io, opts);
  if (!pre) return EXIT.usage;
  const lock = readLock(pre.path);
  if (lock && lock.generator_version !== GENERATOR_VERSION && !opts.updateLock) {
    io.err(
      paint(io, "31", `✗ ddd.lock pins generator ${lock.generator_version}, but this is ${GENERATOR_VERSION}.`) +
        `\n  Install the pinned version, or run "ddd generate --update-lock" and review the resulting diff.`,
    );
    return EXIT.usage;
  }
  const p = prepare(io, opts);
  if (!p.ok) return p.code;
  const { m, plan } = p;
  printPlan(io, plan, false);

  if (plan.conflicts.length && !opts.force) {
    io.err(paint(io, "31", `\n✗ ${plan.conflicts.length} conflict(s); nothing was written.`));
    for (const c of plan.conflicts) {
      io.err(`\n${c.path}: ${c.reason}`);
      const d = unifiedDiff(c.path, c.before, c.after);
      io.err(d.split("\n").slice(0, 40).join("\n") + (d.split("\n").length > 40 ? "\n  … (use ddd diff --patch to see everything)" : ""));
    }
    io.err(
      "\nMove custom code into the extensions package, then re-run. To discard the hand edits, re-run with --force.",
    );
    return EXIT.failed;
  }
  if (plan.staleEditedTests.length) {
    io.err(paint(io, "31", `\n✗ ${plan.staleEditedTests.length} stale generated test(s) were edited by hand; nothing was written.`));
    for (const e of plan.staleEditedTests) io.err(`  ${e.path}`);
    io.err(
      "\nThey test code the model no longer produces and would fail to import. Keep what you need in a test file outside\n" +
        "the generated/ directory, then re-run with --prune --force to delete them.",
    );
    return EXIT.failed;
  }

  const ops: WriteOp[] = [];
  for (const e of plan.entries) {
    if (e.action === "create" || e.action === "update" || (e.action === "conflict" && opts.force)) ops.push({ path: e.path, content: e.after });
    if (e.action === "stale" && e.autoPrune) ops.push({ path: e.path, remove: true });
    else if (e.action === "stale" && opts.prune) {
      if (e.modified && !opts.force) io.err(paint(io, "33", `warning: not pruning ${e.path} because it was edited by hand (use --force)`));
      else ops.push({ path: e.path, remove: true });
    }
  }
  const lockText = JSON.stringify({ generator_version: GENERATOR_VERSION, schema_version: SCHEMA_VERSION } satisfies Lock, null, 2) + "\n";
  const lockFile = lockPath(m.path);
  const writeLock = readText(lockFile) !== lockText;

  if (opts.dryRun) {
    io.out(paint(io, "90", `(dry run) ${ops.length} file(s) would be written${writeLock ? ", ddd.lock would be updated" : ""}`));
    return EXIT.ok;
  }
  atomicApply(m.root, ops);
  if (writeLock) atomicApply(dirname(lockFile), [{ path: "ddd.lock", content: lockText }]);
  const autoPruned = plan.stale.filter((e) => e.autoPrune).length;
  if (autoPruned) io.out(paint(io, "33", `Deleted ${autoPruned} generated test file(s) for code the model no longer produces.`));
  const kept = plan.stale.filter((e) => !e.autoPrune).length;
  if (kept && !opts.prune) {
    io.out(paint(io, "33", `${kept} stale file(s) kept. Review them and re-run with --prune to delete.`));
  }
  extensionWarnings(io, m.root, p.analysis, p.analysis.model.generation.package, p.analysis.model.generation.srcDir, opts.target ?? p.analysis.model.generation.target);
  io.out(paint(io, "32", `✓ Wrote ${ops.length} file(s) to ${m.root}`));
  return EXIT.ok;
}

export function cmdVersion(io: Io, format: "text" | "json"): number {
  const info = {
    generator: "ddd-presenter",
    generator_version: GENERATOR_VERSION,
    schema_version: SCHEMA_VERSION,
    target: "python>=3.11 / pydantic v2",
    targets: { python: "python>=3.11 / pydantic v2 / pytest", typescript: "typescript (strict, ESM) / zod v4 / decimal.js / vitest or bun test" },
  };
  io.out(format === "json" ? JSON.stringify(info, null, 2) : `ddd-presenter ${info.generator_version}\nmodel schema_version ${info.schema_version}\ntargets: python (${info.targets.python}), typescript (${info.targets.typescript})`);
  return EXIT.ok;
}

export function cmdMigrate(io: Io, opts: CommonOpts & { write: boolean; split?: boolean; force?: boolean }): number {
  const path = resolve(opts.model);
  const text = readText(path);
  if (text === undefined) {
    io.err(`Model file not found: ${opts.model}`);
    return EXIT.usage;
  }
  if (opts.split) return migrateToSplit(io, path, text, opts);
  const v = /^schema_version:\s*(\d+)/m.exec(text)?.[1];
  const version = v ? Number(v) : undefined;
  if (version === SCHEMA_VERSION) {
    io.out(`✓ ${basename(path)} already uses schema_version ${SCHEMA_VERSION}; nothing to migrate.`);
    return EXIT.ok;
  }
  if (version === undefined || version > SCHEMA_VERSION) {
    io.err(`✗ Cannot migrate schema_version ${v ?? "(missing)"}; this tool supports up to ${SCHEMA_VERSION}.`);
    return EXIT.failed;
  }
  // Migration chain placeholder: each step rewrites the text from version N to N+1.
  io.err(`✗ No migration path from ${version} to ${SCHEMA_VERSION}.`);
  void opts.write;
  return EXIT.failed;
}

/** `ddd migrate --split`: writes the multi-file format (docs/10 §12) next to the YAML model (or into --out). */
function migrateToSplit(io: Io, path: string, text: string, opts: CommonOpts & { force?: boolean }): number {
  const out = splitModelText(text);
  if (!Object.keys(out.files).length) {
    printDiagnostics(io, out.diagnostics, basename(path));
    io.err(paint(io, "31", "✗ The YAML model has errors; fix them before converting it."));
    return EXIT.failed;
  }
  const root = resolve(opts.out ?? dirname(path));
  const existing = Object.keys(out.files).filter((p) => existsSync(join(root, p)));
  if (existing.length && !opts.force) {
    io.err(paint(io, "31", `✗ ${existing.length} file(s) already exist in ${root}: ${existing.slice(0, 5).join(", ")}${existing.length > 5 ? ", …" : ""}`));
    io.err("Nothing was written. Pass --out <dir> to write somewhere else, or --force to overwrite them.");
    return EXIT.failed;
  }
  atomicApply(root, Object.entries(out.files).map(([p, content]) => ({ path: p, content })));
  // Check what was written reads back as the same model before telling anyone to switch.
  const check = validateModelFiles(out.files);
  for (const p of Object.keys(out.files).sort()) io.out(`${paint(io, "32", "+")} ${relative(process.cwd(), join(root, p))}`);
  if (!check.ok) {
    printDiagnostics(io, check.diagnostics, relative(process.cwd(), root), true);
    io.err(paint(io, "33", "warning: the converted model has the diagnostics above (the YAML has them too)"));
  }
  const dir = relative(process.cwd(), root) || ".";
  io.out(
    paint(io, "32", `✓ Wrote ${Object.keys(out.files).length} file(s).`) +
      `\n\nThe YAML model is unchanged. Once the multi-file model is the one you edit:\n  ddd validate ${dir}\n  ddd generate ${dir}   (updates the model hash in the generated manifest)\nthen delete ${relative(process.cwd(), path)}.`,
  );
  return EXIT.ok;
}

export function cmdInit(io: Io, dir: string, language: GenerationTarget = "python", split = false): number {
  const sample = language === "typescript" ? SAMPLE_MODEL_TS : SAMPLE_MODEL;
  if (split) {
    const files = splitModelText(sample).files;
    const existing = Object.keys(files).filter((p) => existsSync(join(resolve(dir), p)));
    if (existing.length) {
      io.err(`✗ ${join(resolve(dir), existing[0]!)} already exists`);
      return EXIT.failed;
    }
    atomicApply(resolve(dir), Object.entries(files).map(([path, content]) => ({ path, content })));
    const run = language === "typescript" ? `\n  npm install && npm test   (in ${dir}; or bun install && bun run test)` : "";
    io.out(`✓ Created a multi-file model in ${resolve(dir)} (${Object.keys(files).length} files: ddd.yaml, .proto, .domain, .flow, .scenarios.yaml)\n\nNext steps:\n  ddd validate ${dir}\n  ddd diff ${dir}\n  ddd generate ${dir}${run}`);
    return EXIT.ok;
  }
  const target = join(resolve(dir), "model.ddd.yaml");
  if (existsSync(target)) {
    io.err(`✗ ${target} already exists`);
    return EXIT.failed;
  }
  atomicApply(resolve(dir), [{ path: "model.ddd.yaml", content: sample }]);
  const model = join(dir, "model.ddd.yaml");
  const run = language === "typescript" ? `\n  npm install && npm test   (in ${dir}; or bun install && bun run test)` : "";
  io.out(`✓ Created ${target}\n\nNext steps:\n  ddd validate ${model}\n  ddd diff ${model}\n  ddd generate ${model}${run}`);
  return EXIT.ok;
}

export function cmdRules(io: Io, opts: CommonOpts): number {
  const m = loadModel(io, opts);
  if (!m) return EXIT.usage;
  if (!m.result.analysis) {
    printDiagnostics(io, m.result.diagnostics, m.label, m.split);
    return EXIT.failed;
  }
  const usage = ruleUsage(m.result.analysis);
  if (opts.format === "json") {
    io.out(JSON.stringify(usage, null, 2));
    return EXIT.ok;
  }
  for (const u of usage) {
    io.out(`${paint(io, "1", u.rule)} ${paint(io, "90", `(${u.kind}, ${u.context} › ${u.owner})`)}`);
    io.out(`  condition: ${u.expression}`);
    io.out(`  error:     ${u.error}`);
    io.out(`  applied:   ${u.appliedBy.map((a) => `${a.kind} ${a.name}`).join(", ") || "—"}`);
    io.out(`  tested by: ${u.scenarios.map((s) => `test_${s.name}`).join(", ") || (u.derived ? "—" : paint(io, "33", "nothing (no scenario that only this rule can fail)"))}`);
    if (u.derived) io.out(`  derived:   ${u.derived.test} ${paint(io, "90", `(values of ${u.derived.from}, ${u.derived.changed.join(" and ")} changed)`)}`);
    for (const a of u.ambiguous) {
      io.out(paint(io, "90", `  not counted: ${a.name} expects ${u.error}, which ${a.alsoRaisedBy.join(", ")} can also raise`));
    }
  }
  return EXIT.ok;
}

/**
 * Yes/no questions for a product manager (docs/11 §11): the sheet without the model's answers, the key with them,
 * an answers file to fill in, or — with `--answers` — the answers that mean the model has to change.
 */
export function cmdReview(io: Io, opts: CommonOpts & { key: boolean; template: boolean; answers?: string }): number {
  const m = loadModel(io, opts);
  if (!m) return EXIT.usage;
  if (!m.result.analysis || !m.result.ok) {
    printDiagnostics(io, m.result.diagnostics, m.label, m.split);
    io.err("✗ Fix the errors first: the questions are read from a valid model");
    return EXIT.failed;
  }
  const questions = reviewQuestions(m.result.analysis);
  const project = m.result.model?.project ?? "model";
  let answers: Record<string, "yes" | "no"> | undefined;
  if (opts.answers !== undefined) {
    const text = readText(opts.answers);
    if (text === undefined) {
      io.err(`✗ Cannot read ${opts.answers}`);
      return EXIT.usage;
    }
    const parsed = parseReviewAnswers(text, questions);
    for (const p of parsed.problems) io.err(paint(io, "33", `warning: ${p}`));
    answers = parsed.answers;
  }
  if (opts.template) {
    io.out(reviewAnswersTemplate(questions, answers));
    return EXIT.ok;
  }
  const findings = answers ? reviewFindings(questions, answers) : [];
  if (opts.format === "json") {
    io.out(JSON.stringify(answers ? { questions, answers, findings } : questions, null, 2));
  } else {
    io.out(reviewMarkdown(project, questions, { key: opts.key, ...(answers ? { answers } : {}) }));
  }
  // Answers that differ from the model fail like `diff --check`: the model has to change.
  return findings.length ? EXIT.failed : EXIT.ok;
}
