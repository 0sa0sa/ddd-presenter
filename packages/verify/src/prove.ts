/**
 * Proving the Lean theorems with a model and checking them with Lean (docs/09 §29).
 *
 * The prover (Claude Code in print mode, with every tool disabled) only ever returns the text of a proof: the file,
 * the definitions and the statements are written by this module, so a proof cannot change what it proves. A proof
 * that uses `sorry`, `admit`, an axiom, `native_decide` (which trusts compiled code) or changes Lean's options is
 * refused before Lean sees it; Lean then checks the rest. Lean's errors go back to the prover for a few attempts.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LeanProject, LeanTheorem } from "./lean.ts";

export interface ProveOptions {
  /** Command that checks one file: `[...lean, file]`, run in the project directory (default `["lean"]`). */
  lean?: string[];
  /** Extra environment for Lean (e.g. ELAN_HOME). */
  leanEnv?: Record<string, string>;
  /** Asks for a proof; returns the reply text (default: Claude Code, see `claudeProver`). */
  prover?: (prompt: string) => Promise<string>;
  /** Attempts per theorem (default 3). */
  attempts?: number;
  onProgress?: (message: string) => void;
}

export interface LeanOutcome {
  id: string;
  theorem: string;
  status: "proven" | "failed";
  attempts: number;
  /** The accepted proof (tactics after `:= by`). */
  proof?: string;
  /** Lean's last error, or why a reply was refused. */
  error?: string;
}

/** What a proof may not contain: holes, axioms, trusting compiled code, changing options or attributes. */
const FORBIDDEN = /\b(sorry|admit|axiom|native_decide|ofReduceBool|trustCompiler|implemented_by|extern|unsafe|opaque|set_option|decreasing_by|partial)\b|#exit|#eval|@\[|\bprivate\b/;

/** The axioms a proof may rest on (Lean's standard ones); anything else (sorryAx, trusting compiled code) fails it. */
const STANDARD_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

const SYSTEM = [
  "You prove theorems in Lean 4 (version 4.35) with only Lean's core library: no Mathlib, no Batteries.",
  "Useful tactics: simp, simp only, omega, grind, decide, induction, cases, rcases, obtain, constructor, intro, exact, unfold, show, have, calc, List lemmas such as List.length_filter_le, List.length_map, List.mem_map, List.mem_filter, List.forall_mem_append, List.sum_append.",
  "Reply with the tactic block only: the lines that replace `sorry` after `:= by`. No code fences, no explanation, no new definitions.",
  "Never use sorry, admit, axioms, native_decide or set_option.",
].join("\n");

/** Claude Code as the prover: print mode, every tool disabled, our system prompt, in an empty directory. */
export function claudeProver(opts: { bin?: string; model?: string; timeoutMs?: number } = {}): (prompt: string) => Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "ddd-prover-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (/^(PATH|HOME|USER|LANG|LC_\w+|TMPDIR|TZ)$/.test(k) || /^(ANTHROPIC_|CLAUDE_|AWS_|CLOUD_ML_|GOOGLE_)/.test(k))) env[k] = v;
  env.NO_COLOR = "1";
  return async (prompt) => {
    const model = opts.model ?? process.env.DDD_PROVER_MODEL;
    const cmd = [opts.bin ?? process.env.DDD_CLAUDE_BIN ?? "claude", "-p", "--output-format", "text", "--tools=", "--strict-mcp-config", "--setting-sources=", "--no-session-persistence", "--system-prompt", SYSTEM, ...(model ? ["--model", model] : [])];
    const proc = Bun.spawn(cmd, { cwd, env, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 300_000);
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      if (code !== 0) throw new Error(`prover exited with ${code}: ${err.trim().slice(0, 300)}`);
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The proof text of a reply: code fences and a repeated statement are removed; undefined when nothing is left. */
export function proofOf(reply: string, theorem: LeanTheorem): string | undefined {
  let text = reply.trim();
  const fence = /```(?:lean4?|)\n([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1]!.trim();
  // A reply that repeats the theorem: keep what follows its `:= by`.
  if (text.includes(`theorem ${theorem.name}`)) {
    const at = text.indexOf(":= by");
    if (at >= 0) text = text.slice(at + ":= by".length);
  }
  text = text.replace(/^\s*by\s*\n/, "");
  // Blank lines would end the theorem's block in the file: drop them.
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return undefined;
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => (l.trim() ? `  ${l.slice(indent)}` : "")).join("\n");
}

interface LeanError {
  line: number;
  message: string;
}

/** Runs Lean on `file` (relative to `dir`); errors with their line numbers. */
function checkFile(dir: string, file: string, opts: ProveOptions): LeanError[] {
  const cmd = [...(opts.lean ?? ["lean"]), file];
  const r = Bun.spawnSync(cmd, { cwd: dir, env: { ...process.env, ...opts.leanEnv }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  const errors: LeanError[] = [];
  const re = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):\\d+: error: ([\\s\\S]*?)(?=^\\S+\\.lean:\\d+:\\d+: |(?![\\s\\S]))`, "gm");
  for (const m of out.matchAll(re)) errors.push({ line: Number(m[1]), message: m[2]!.trim() });
  if (r.exitCode !== 0 && !errors.length) errors.push({ line: 0, message: out.trim().slice(0, 2000) || `lean exited with ${r.exitCode}` });
  return errors;
}

/** Line range (1-based, inclusive) of a theorem's statement and proof in `text`. */
function range(text: string, theorem: LeanTheorem): [number, number] {
  const start = text.indexOf(theorem.statement);
  const before = text.slice(0, start).split("\n").length;
  const rest = text.slice(start);
  const end = rest.search(/\n\n/);
  const lines = (end < 0 ? rest : rest.slice(0, end)).split("\n").length;
  return [before, before + lines - 1];
}

/** Replaces the proof of `theorem` (its `sorry`, or an earlier attempt) with `proof`. */
function withProof(text: string, theorem: LeanTheorem, proof: string): string {
  const start = text.indexOf(theorem.statement);
  if (start < 0) throw new Error(`statement of ${theorem.name} not found`);
  const bodyStart = start + theorem.statement.length + 1;
  const rest = text.slice(bodyStart);
  const end = rest.search(/\n\n/);
  return text.slice(0, bodyStart) + proof + (end < 0 ? "" : rest.slice(end));
}

/**
 * Writes the project to `dir` and proves its theorems one by one. Accepted proofs stay in the files (later theorems
 * may use them); a theorem whose attempts all fail keeps `sorry` and is reported as failed.
 */
export async function proveProject(project: LeanProject, dir: string, opts: ProveOptions = {}): Promise<LeanOutcome[]> {
  for (const [f, content] of Object.entries(project.files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  const prover = opts.prover ?? claudeProver();
  const attempts = opts.attempts ?? 3;
  const out: LeanOutcome[] = [];
  for (const th of project.theorems) {
    const file = `${th.module.replace(/\./g, "/")}.lean`;
    const path = join(dir, file);
    const original = readFileSync(path, "utf8");
    let feedback = "";
    let outcome: LeanOutcome = { id: th.id, theorem: th.name, status: "failed", attempts: 0 };
    for (let i = 1; i <= attempts; i++) {
      opts.onProgress?.(`${th.name}: attempt ${i}`);
      const prompt = [
        `Prove the theorem \`${th.name}\` in this Lean 4 file (it currently ends in \`sorry\`). Reply with the tactic block only.`,
        "",
        "```lean",
        original,
        "```",
        ...(feedback ? ["", "Your previous proof failed:", feedback] : []),
      ].join("\n");
      let reply: string;
      try {
        reply = await prover(prompt);
      } catch (e) {
        outcome = { ...outcome, attempts: i, error: (e as Error).message };
        break;
      }
      const proof = proofOf(reply, th);
      if (!proof) {
        feedback = "(the reply had no proof)";
        outcome = { ...outcome, attempts: i, error: "the reply had no proof" };
        continue;
      }
      if (FORBIDDEN.test(proof)) {
        const word = FORBIDDEN.exec(proof)![0];
        feedback = `The proof uses \`${word}\`, which is not allowed.`;
        outcome = { ...outcome, attempts: i, error: `refused: uses ${word}` };
        continue;
      }
      const text = withProof(original, th, proof);
      writeFileSync(path, text);
      const [from, to] = range(text, th);
      const errors = checkFile(dir, file, opts).filter((e) => e.line === 0 || (e.line >= from && e.line <= to));
      if (!errors.length) {
        outcome = { id: th.id, theorem: th.name, status: "proven", attempts: i, proof: proof.trim() };
        break;
      }
      feedback = errors.map((e) => `line ${e.line - from + 1}: ${e.message}`).join("\n").slice(0, 4000);
      outcome = { ...outcome, attempts: i, proof: proof.trim(), error: feedback };
      writeFileSync(path, original);
    }
    out.push(outcome);
    opts.onProgress?.(`${th.name}: ${outcome.status}`);
  }
  // The whole project once more: every accepted proof checks in its final file, and rests only on Lean's standard
  // axioms (`#print axioms`: a hidden sorry or a trusted computation would show here).
  for (const f of Object.keys(project.files).filter((x) => x.startsWith("Proofs/"))) {
    const mine = out.filter((o) => o.status === "proven" && project.theorems.some((t) => t.id === o.id && `${t.module.replace(/\./g, "/")}.lean` === f));
    if (!mine.length) continue;
    const path = join(dir, f);
    const text = readFileSync(path, "utf8");
    const ns = /^namespace (.+)$/m.exec(text)?.[1];
    const probe = `${f.replace(/\.lean$/, "")}_axioms.lean`;
    const end = ns ? text.lastIndexOf(`end ${ns}`) : text.length;
    writeFileSync(join(dir, probe), `${text.slice(0, end)}${mine.map((o) => `#print axioms ${o.theorem}`).join("\n")}\n${text.slice(end)}`);
    const r = Bun.spawnSync([...(opts.lean ?? ["lean"]), probe], { cwd: dir, env: { ...process.env, ...opts.leanEnv }, stdout: "pipe", stderr: "pipe" });
    const printed = r.stdout.toString() + r.stderr.toString();
    for (const o of mine) {
      const short = o.theorem.split(".").pop()!;
      const m = new RegExp(`'[^']*${short.replace(/[«»]/g, "")}' (?:depends on axioms: \\[([^\\]]*)\\]|does not depend on any axioms)`).exec(printed.replace(/«|»/g, ""));
      const axioms = m?.[1]?.split(",").map((a) => a.trim()).filter(Boolean) ?? [];
      const extra = axioms.filter((a) => !STANDARD_AXIOMS.has(a));
      if (!m || extra.length) Object.assign(o, { status: "failed", error: m ? `rests on ${extra.join(", ")}` : `could not read its axioms` });
    }
    const errors = checkFile(dir, f, opts);
    if (errors.length) for (const o of mine) Object.assign(o, { status: "failed", error: `final check: ${errors[0]!.message}` });
    Bun.spawnSync(["rm", "-f", join(dir, probe)]);
  }
  return out;
}
