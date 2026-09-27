import { createHash } from "node:crypto";
import type { GenerationOutput, Manifest, Ownership } from "./index.ts";

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
    if (!options.prune || (modified && !options.force)) keptStale.push(p);
    entries.push({
      path: p.path,
      action: "stale",
      ownership: "generated",
      reason: modified ? "no longer produced by the model (and edited by hand)" : "no longer produced by the model",
      modified,
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
    breaking,
    changed: entries.some((e) => e.action === "create" || e.action === "update" || e.action === "stale" || e.action === "conflict"),
  };
}

/** Public Python symbols (classes, methods, functions) removed by this generation. */
function detectBreaking(entries: PlanEntry[]): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const e of entries) {
    if (!e.path.endsWith(".py") || e.ownership !== "generated" || !e.before) continue;
    if (e.path.includes("/tests/") || /(^|\/)test_[^/]*\.py$/.test(e.path)) continue;
    const before = symbols(e.before);
    const after = e.action === "stale" ? new Map<string, string>() : symbols(e.after ?? "");
    for (const [sym, sig] of before) {
      if (!after.has(sym)) out.push({ path: e.path, symbol: sym, reason: e.action === "stale" ? "module removed" : "removed or renamed" });
      else if (after.get(sym) !== sig) out.push({ path: e.path, symbol: sym, reason: `signature changed: ${sig} → ${after.get(sym)}` });
    }
  }
  return out;
}

function symbols(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let cls: string | undefined;
  for (const line of src.split("\n")) {
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

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  const ops = diffLines(a, b);
  const header = [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`];
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.t === "=") i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    // extend hunk while changes are within 2*context of each other
    for (;;) {
      while (end < ops.length && ops[end]!.t !== "=") end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === "=") next++;
      if (next < ops.length && next - end <= context * 2) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const slice = ops.slice(start, stop);
    const aStart = slice[0]!.ai;
    const bStart = slice[0]!.bi;
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) hunks.push(`${o.t === "=" ? " " : o.t}${o.line}`);
    i = stop;
    start = stop;
  }
  if (!hunks.length) return "";
  return [...header, ...hunks].join("\n") + "\n";
}

type Op = { t: "=" | "-" | "+"; line: string; ai: number; bi: number };

function diffLines(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix, then LCS on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: "=", line: a[k]!, ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ t: "=", line: A[i]!, ai: pre + i, bi: pre + j });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ t: "-", line: A[i]!, ai: pre + i, bi: pre + j });
      i++;
    } else {
      ops.push({ t: "+", line: B[j]!, ai: pre + i, bi: pre + j });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: "=", line: a[a.length - suf + k]!, ai: a.length - suf + k, bi: b.length - suf + k });
  return ops;
}
