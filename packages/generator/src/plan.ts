import { createHash } from "node:crypto";
import type { GenerationOutput, Manifest, Ownership } from "./output.ts";

export { unifiedDiff } from "@ddd/core";

export type PlanAction =
  | "create"
  | "update"
  | "unchanged"
  /** Generated file edited by hand, or an unrelated file in the way. Blocks writing unless forced. */
  | "conflict"
  /** Scaffold that already exists; left untouched. */
  | "keep"
  /** No longer produced by the model. Never deleted unless explicitly pruned. */
  | "stale";

export interface PlanEntry {
  path: string;
  action: PlanAction;
  ownership: Ownership | "manifest";
  reason?: string;
  /** Stale file whose content differs from what the generator wrote. */
  modified?: boolean;
  /** Stale file under the generated tests directory (tests of code the model no longer produces). */
  generatedTest?: boolean;
  /**
   * Stale generated test left exactly as the generator wrote it: deleted by `generate` without --prune, because it
   * imports removed code and would only fail. Stale source modules are never deleted without --prune.
   */
  autoPrune?: boolean;
  before?: string;
  after?: string;
}

export interface BreakingChange {
  path: string;
  symbol: string;
  reason: string;
}

export interface Plan {
  entries: PlanEntry[];
  conflicts: PlanEntry[];
  stale: PlanEntry[];
  /** Stale generated tests edited by hand: they would fail to import, so `generate` refuses until resolved. */
  staleEditedTests: PlanEntry[];
  breaking: BreakingChange[];
  changed: boolean;
}

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Compares generator output with what is on disk and with the previous manifest.
 * `read` returns the current file content or undefined if missing.
 */
export function computePlan(
  output: GenerationOutput,
  previous: Manifest | undefined,
  read: (path: string) => string | undefined,
  options: { prune?: boolean; force?: boolean } = {},
): Plan {
  const entries: PlanEntry[] = [];
  const testsPrefix = `${output.testsDir}/generated/`;
  const prevHashes = new Map(previous?.files.map((f) => [f.path, f.sha256]) ?? []);
  const newPaths = new Set(output.files.map((f) => f.path));

  for (const f of output.files) {
    const disk = read(f.path);
    if (f.ownership === "scaffold") {
      entries.push(disk === undefined ? { path: f.path, action: "create", ownership: "scaffold", after: f.content } : { path: f.path, action: "keep", ownership: "scaffold", reason: "customer-owned" });
      continue;
    }
    if (disk === undefined) {
      entries.push({ path: f.path, action: "create", ownership: "generated", after: f.content });
      continue;
    }
    if (disk === f.content) {
      entries.push({ path: f.path, action: "unchanged", ownership: "generated" });
      continue;
    }
    const prev = prevHashes.get(f.path);
    if (prev === undefined) {
      entries.push({ path: f.path, action: "conflict", ownership: "generated", reason: "file exists but was not created by the generator", before: disk, after: f.content });
    } else if (prev !== hash(disk)) {
      entries.push({ path: f.path, action: "conflict", ownership: "generated", reason: "generated file was edited by hand", before: disk, after: f.content });
    } else {
      entries.push({ path: f.path, action: "update", ownership: "generated", before: disk, after: f.content });
    }
  }

  const keptStale: { path: string; sha256: string }[] = [];
  for (const p of [...(previous?.files ?? []), ...(previous?.stale ?? [])]) {
    if (newPaths.has(p.path)) continue;
    const disk = read(p.path);
    if (disk === undefined) continue;
    const modified = hash(disk) !== p.sha256;
    const generatedTest = p.path.startsWith(testsPrefix);
    const autoPrune = generatedTest && !modified;
    if (!autoPrune && (!options.prune || (modified && !options.force))) keptStale.push(p);
    entries.push({
      path: p.path,
      action: "stale",
      ownership: "generated",
      reason: autoPrune
        ? "test of code the model no longer produces; deleted"
        : modified
          ? "no longer produced by the model (and edited by hand)"
          : "no longer produced by the model",
      modified,
      generatedTest,
      autoPrune,
      before: disk,
    });
  }

  keptStale.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: Manifest = keptStale.length ? { ...output.manifest, stale: keptStale } : output.manifest;
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const diskManifest = read(output.manifestPath);
  entries.push({
    path: output.manifestPath,
    action: diskManifest === undefined ? "create" : diskManifest === manifestText ? "unchanged" : "update",
    ownership: "manifest",
    before: diskManifest,
    after: manifestText,
  });

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const breaking = detectBreaking(entries);
  return {
    entries,
    conflicts: entries.filter((e) => e.action === "conflict"),
    stale: entries.filter((e) => e.action === "stale"),
    staleEditedTests: entries.filter((e) => e.action === "stale" && e.generatedTest && e.modified && !(options.prune && options.force)),
    breaking,
    changed: entries.some((e) => e.action === "create" || e.action === "update" || e.action === "stale" || e.action === "conflict"),
  };
}

/** Public symbols (Python classes, methods, functions; TypeScript exports and class members) removed by this generation. */
function detectBreaking(entries: PlanEntry[]): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const e of entries) {
    if (e.ownership !== "generated" || !e.before) continue;
    const ts = e.path.endsWith(".ts");
    if (!e.path.endsWith(".py") && !ts) continue;
    if (e.path.includes("/tests/") || /(^|\/)test_[^/]*\.py$/.test(e.path) || /\.test\.ts$/.test(e.path)) continue;
    const scan = ts ? tsSymbols : symbols;
    const before = scan(e.before);
    const after = e.action === "stale" ? new Map<string, string>() : scan(e.after ?? "");
    for (const [sym, sig] of before) {
      if (!after.has(sym)) out.push({ path: e.path, symbol: sym, reason: e.action === "stale" ? "module removed" : "removed or renamed" });
      else if (after.get(sym) !== sig) out.push({ path: e.path, symbol: sym, reason: `signature changed: ${sig} → ${after.get(sym)}` });
    }
  }
  return out;
}

/** Source lines with bracketed continuations joined, so wrapped signatures read as one line. */
function logicalLines(src: string): string[] {
  const out: string[] = [];
  let buf: string | undefined;
  let depth = 0;
  let inDoc = false;
  for (const line of src.split("\n")) {
    const quotes = (line.match(/"""/g) ?? []).length;
    if (buf === undefined && (inDoc || quotes > 0)) {
      // Docstring text never takes part in bracket matching.
      if (quotes % 2 === 1) inDoc = !inDoc;
      out.push(line);
      continue;
    }
    buf = buf === undefined ? line : `${buf} ${line.trim()}`;
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) {
      // Normalize the wrapping itself away: "( a, b, )" and "(a, b)" are the same signature.
      out.push(buf.replace(/([([{]) /g, "$1").replace(/,? ([)\]}])/g, "$1"));
      buf = undefined;
      depth = 0;
    }
  }
  if (buf !== undefined) out.push(buf);
  return out;
}

function symbols(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let cls: string | undefined;
  for (const line of logicalLines(src)) {
    const c = /^class (\w+)/.exec(line);
    if (c) {
      cls = c[1];
      if (!cls!.startsWith("_")) out.set(cls!, "class");
      continue;
    }
    const f = /^def (\w+)\((.*)\)/.exec(line);
    if (f) {
      cls = undefined;
      if (!f[1]!.startsWith("_")) out.set(f[1]!, `(${f[2]})`);
      continue;
    }
    const m = /^ {4}def (\w+)\((.*)\)/.exec(line);
    if (m && cls && !m[1]!.startsWith("_")) out.set(`${cls}.${m[1]}`, `(${m[2]})`);
  }
  return out;
}

/**
 * Exported TypeScript symbols: classes, functions, constants, types and interfaces, plus the public members of
 * exported classes with their parameter lists (wrapped signatures are joined first).
 */
function tsSymbols(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines: string[] = [];
  let buf: string | undefined;
  let depth = 0;
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (buf === undefined && (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"))) continue;
    buf = buf === undefined ? line : `${buf} ${t}`;
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
    }
    if (depth <= 0) {
      // Normalize the wrapping itself away (keeping the indentation): "( a, b, )" and "(a, b)" are the same signature.
      const indent = /^ */.exec(buf)![0];
      lines.push(indent + buf.slice(indent.length).replace(/ {2,}/g, " ").replace(/([([{]) +/g, "$1").replace(/,? +([)\]}])/g, "$1"));
      buf = undefined;
      depth = 0;
    }
  }
  let cls: string | undefined;
  for (const line of lines) {
    const c = /^export (?:abstract )?class (\w+)/.exec(line);
    if (c) {
      cls = c[1]!;
      out.set(cls, "class");
      continue;
    }
    if (/^\}/.test(line)) cls = undefined;
    const f = /^export (?:async )?function (\w+)(?:<[^(]*>)?\((.*?)\)(?::|\s*\{)/.exec(line);
    if (f) {
      out.set(f[1]!, `(${f[2]})`);
      continue;
    }
    const d = /^export (?:const|type|interface) (\w+)/.exec(line);
    if (d) {
      out.set(d[1]!, "declared");
      continue;
    }
    const m = /^ {2}(?:static |async |override |get )*([A-Za-z]\w*)\((.*?)\)(?::| \{)/.exec(line);
    if (m && cls && m[1] !== "if") out.set(`${cls}.${m[1]}`, `(${m[2]})`);
  }
  return out;
}
