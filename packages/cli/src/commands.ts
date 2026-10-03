import { coverageDiagnostics, formatDiagnostic, parseModel, ruleUsage, SCHEMA_VERSION, sortDiagnostics, validateModelText, type Diagnostic } from "@ddd/core";
import { computePlan, GENERATOR_VERSION, generatePython, unifiedDiff, type Manifest, type Plan } from "@ddd/generator";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atomicApply, readText, safeJoin, type WriteOp } from "./fsops.ts";
import { SAMPLE_MODEL } from "./sample.ts";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
}

export interface CommonOpts {
  model: string;
  out?: string;
  format: "text" | "json";
}

const paint = (io: Io, code: string, s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

function loadModel(io: Io, opts: CommonOpts) {
  const path = resolve(opts.model);
  const text = readText(path);
  if (text === undefined) {
    io.err(`Model file not found: ${opts.model}\nCreate one with "ddd init" or pass a path: ddd validate path/to/model.ddd.yaml`);
    return undefined;
  }
  const result = validateModelText(text);
  return { path, text, result, root: resolve(opts.out ?? dirname(path)) };
}

function printDiagnostics(io: Io, diagnostics: Diagnostic[], file: string): void {
  for (const d of diagnostics) {
    const s = formatDiagnostic(d, file);
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
    opts.strict && result.analysis ? sortDiagnostics([...result.diagnostics, ...coverageDiagnostics(result.analysis, parseModel(m.text).locate)]) : result.diagnostics;
  const failed = !result.ok || (opts.strict && diagnostics.some((d) => d.severity === "warning"));
  if (opts.format === "json") {
    io.out(JSON.stringify({ ok: !failed, diagnostics }, null, 2));
  } else {
    printDiagnostics(io, diagnostics, basename(m.path));
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
    printDiagnostics(io, m.result.diagnostics, basename(m.path));
    io.err(paint(io, "31", `✗ Generation stopped: ${summary(m.result.diagnostics)}`));
    return { ok: false as const, code: EXIT.failed };
  }
  const output = generatePython(m.result.analysis, m.text);
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

function extensionWarnings(io: Io, root: string, analysis: NonNullable<ReturnType<typeof validateModelText>["analysis"]>, pkg: string, src: string): void {
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
  extensionWarnings(io, m.root, p.analysis, p.analysis.model.generation.package, p.analysis.model.generation.srcDir);
  io.out(paint(io, "32", `✓ Wrote ${ops.length} file(s) to ${m.root}`));
  return EXIT.ok;
}

export function cmdVersion(io: Io, format: "text" | "json"): number {
  const info = { generator: "ddd-presenter", generator_version: GENERATOR_VERSION, schema_version: SCHEMA_VERSION, target: "python>=3.11 / pydantic v2" };
  io.out(format === "json" ? JSON.stringify(info, null, 2) : `ddd-presenter ${info.generator_version}\nmodel schema_version ${info.schema_version}\ntarget ${info.target}`);
  return EXIT.ok;
}

export function cmdMigrate(io: Io, opts: CommonOpts & { write: boolean }): number {
  const path = resolve(opts.model);
  const text = readText(path);
  if (text === undefined) {
    io.err(`Model file not found: ${opts.model}`);
    return EXIT.usage;
  }
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

export function cmdInit(io: Io, dir: string): number {
  const target = join(resolve(dir), "model.ddd.yaml");
  if (existsSync(target)) {
    io.err(`✗ ${target} already exists`);
    return EXIT.failed;
  }
  atomicApply(resolve(dir), [{ path: "model.ddd.yaml", content: SAMPLE_MODEL }]);
  io.out(`✓ Created ${target}\n\nNext steps:\n  ddd validate ${join(dir, "model.ddd.yaml")}\n  ddd diff ${join(dir, "model.ddd.yaml")}\n  ddd generate ${join(dir, "model.ddd.yaml")}`);
  return EXIT.ok;
}

export function cmdRules(io: Io, opts: CommonOpts): number {
  const m = loadModel(io, opts);
  if (!m) return EXIT.usage;
  if (!m.result.analysis) {
    printDiagnostics(io, m.result.diagnostics, basename(m.path));
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
