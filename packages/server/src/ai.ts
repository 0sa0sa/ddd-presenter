/**
 * LLM assistance for domain modelling. The prompts live here; how they reach a model is a `Completer`:
 * the Claude API (official SDK), or a local agent CLI (Claude Code / Codex) running on the server's machine.
 * The server is the only place that talks to a model: the browser never sees credentials,
 * and nothing is sent unless the workspace owner enabled AI.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Board, Proposal } from "@ddd/core";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dslReference from "../../../docs/10-dsl-reference.md" with { type: "text" };

export interface InlineRequest {
  yaml: string;
  offset: number;
  /** Aborted when the browser gives up on the prediction (the user kept typing). */
  signal?: AbortSignal;
}

export interface ProposeRequest {
  yaml: string;
  context: string;
  aggregate?: string;
  kind: string;
  instruction?: string;
  /** Diagnostics from a previous attempt, for one repair round. */
  repair?: { yaml: string; errors: string[] };
  signal?: AbortSignal;
}

export interface BoardRequest {
  board: Board;
  instruction?: string;
  signal?: AbortSignal;
}

export interface BoardSuggestion {
  kind: string;
  text: string;
  near_item_id: string;
  placement: "right" | "left" | "above" | "below";
  connect: "from_near" | "to_near" | "none";
  reason: string;
}

/** What the rest of the server needs from an LLM. Tests inject a fake implementation. */
export interface ModelAssistant {
  /** Shown to the workspace owner, e.g. "claude-opus-5" or "Claude Code（このサーバーのCLI）". */
  readonly model: string;
  inline(req: InlineRequest): Promise<string | undefined>;
  propose(req: ProposeRequest): Promise<Omit<Proposal, "source"> | undefined>;
  board(req: BoardRequest): Promise<BoardSuggestion[]>;
}

/** Where assistance can come from. */
export type ProviderId = "api" | "claude-code" | "codex";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  api: "Claude API",
  "claude-code": "Claude Code（ローカルCLI）",
  codex: "Codex CLI（ローカル）",
};

// -- transport -----------------------------------------------------------------

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteRequest {
  purpose: "inline" | "propose" | "board";
  messages: Message[];
  /** JSON Schema for a structured answer; the result is then JSON text. */
  schema?: Record<string, unknown>;
  effort: "low" | "medium";
  maxTokens: number;
  signal?: AbortSignal;
}

/** Sends one request to a model; resolves the answer text, or undefined when the model declined. */
export interface Completer {
  readonly model: string;
  complete(req: CompleteRequest): Promise<string | undefined>;
}

// -- prompts -------------------------------------------------------------------

export const SYSTEM = `You help software teams build domain models with DDD (Domain-Driven Design) in "DDD Presenter".
Models are YAML files in the DSL documented below. Code (Python) and tests are generated from them.

Principles:
- Follow the DSL exactly; every name you reference must exist or be added.
- Match the team's existing naming (PascalCase types and events, snake_case members) and write descriptions,
  messages and glossary text in the same natural language the model already uses.
- Keep aggregates small; a rule belongs to the aggregate that must keep it consistent in one change.
- Never invent business facts. When the model does not say something, make the smallest reasonable guess
  and report it as an assumption, and turn open points into questions for the domain expert.

<dsl_reference>
${dslReference}
</dsl_reference>`;

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["yaml", "summary", "facts", "assumptions", "questions"],
  properties: {
    yaml: { type: "string", description: "The complete updated model file" },
    summary: { type: "array", items: { type: "string" }, description: "What was added or changed, one line each" },
    facts: { type: "array", items: { type: "string" }, description: "Facts taken from the current model that the proposal relies on" },
    assumptions: { type: "array", items: { type: "string" }, description: "Guesses that the team must confirm" },
    questions: { type: "array", items: { type: "string" }, description: "Open questions for the domain expert" },
  },
} as const;

const BOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "near_item_id", "placement", "connect", "reason"],
        properties: {
          kind: { type: "string", enum: ["event", "command", "actor", "policy", "aggregate", "rule", "read_model", "external_system", "hotspot"] },
          text: { type: "string" },
          near_item_id: { type: "string" },
          placement: { type: "string", enum: ["right", "left", "above", "below"] },
          connect: { type: "string", enum: ["from_near", "to_near", "none"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const KIND_HINT: Record<string, string> = {
  "next-operation": "Propose the next operation this aggregate needs (lifecycle transitions that are missing), with its guard, changes and emitted event.",
  guards: "Propose the state guards and invariants this aggregate needs, with domain errors for each.",
  scenarios: "Propose Given/When/Then scenarios that cover the success path and each rule's failure for this aggregate. Use concrete, realistic values.",
  events: "Propose or improve the domain events' payloads: what the consumers of each event need to know.",
  custom: "Do what the instruction asks.",
};

const parseJson = <T>(text: string | undefined): T | undefined => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** The modelling assistant on top of any transport. */
export function assistantWith(completer: Completer): ModelAssistant {
  return {
    model: completer.model,
    async inline({ yaml, offset, signal }) {
      const text = await completer.complete({
        purpose: "inline",
        effort: "low",
        maxTokens: 1024,
        signal,
        messages: [
          {
            role: "user",
            content: `Continue the model at <cursor/>. Return ONLY the text to insert at the cursor (no code fences, no explanation). Continue the current YAML item or add the next sensible one, at most about 15 lines, indented to fit. Return an empty response if nothing useful fits.

<model>
${yaml.slice(0, offset)}<cursor/>${yaml.slice(offset)}
</model>`,
          },
        ],
      });
      if (!text) return undefined;
      return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").replace(/\s+$/, "");
    },

    async propose({ yaml, context, aggregate, kind, instruction, repair, signal }) {
      const task = [
        KIND_HINT[kind] ?? KIND_HINT.custom,
        `Target: context "${context}"${aggregate ? `, aggregate "${aggregate}"` : ""}.`,
        instruction ? `Instruction from the team: ${instruction}` : "",
        "Keep every existing element unless the instruction asks to change it. Return the complete updated model in `yaml`.",
        "Write summary, facts, assumptions and questions in the natural language the model's descriptions use.",
      ]
        .filter(Boolean)
        .join("\n");
      const messages: Message[] = [{ role: "user", content: `${task}\n\n<model>\n${yaml}\n</model>` }];
      if (repair) {
        messages.push({ role: "assistant", content: JSON.stringify({ yaml: repair.yaml }) });
        messages.push({ role: "user", content: `The model you returned has validation errors. Fix them and return the complete model again:\n${repair.errors.join("\n")}` });
      }
      return parseJson<Omit<Proposal, "source">>(await completer.complete({ purpose: "propose", effort: "medium", maxTokens: 16000, schema: PROPOSAL_SCHEMA, messages, signal }));
    },

    async board({ board, instruction, signal }) {
      const compact = {
        frames: board.frames.map((f) => ({ id: f.id, title: f.title })),
        items: board.items.map((i) => ({ id: i.id, kind: i.kind, text: i.text })),
        connectors: board.connectors.map((c) => ({ from: c.from, to: c.to })),
      };
      const text = await completer.complete({
        purpose: "board",
        signal,
        effort: "low",
        maxTokens: 8000,
        schema: BOARD_SCHEMA,
        messages: [
          {
            role: "user",
            content: `This is an EventStorming board (JSON). Suggest up to 8 stickies that are most likely missing next: events that follow, commands that cause events, actors, policies between events and commands, aggregates, rules, or hotspots for unclear points. Write sticky text in the board's language. Each suggestion is placed next to an existing sticky (near_item_id) and may connect to it.${instruction ? `\nFocus: ${instruction}` : ""}

<board>
${JSON.stringify(compact)}
</board>`,
          },
        ],
      });
      return parseJson<{ suggestions: BoardSuggestion[] }>(text)?.suggestions ?? [];
    },
  };
}

// -- Claude API ------------------------------------------------------------------

export function apiCompleter(options: { client?: Anthropic; model?: string; inlineModel?: string } = {}): Completer {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? process.env.DDD_AI_MODEL ?? "claude-opus-5";
  const inlineModel = options.inlineModel ?? process.env.DDD_AI_INLINE_MODEL ?? model;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];
  return {
    model,
    async complete({ purpose, messages, schema, effort, maxTokens, signal }) {
      const r = await client.beta.messages.create(
        {
          model: purpose === "inline" ? inlineModel : model,
          max_tokens: maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: schema ? { effort, format: { type: "json_schema", schema } } : { effort },
          system,
          messages,
        },
        { signal },
      );
      if (r.stop_reason === "refusal") return undefined;
      return r.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

/** The Claude API assistant (kept as the name tests and callers use). */
export function claudeAssistant(options: { client?: Anthropic; model?: string; inlineModel?: string } = {}): ModelAssistant {
  return assistantWith(apiCompleter(options));
}

// -- local agent CLIs ------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with stdin; injectable for tests. */
export type Runner = (cmd: string[], opts: { stdin: string; cwd: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }) => Promise<RunResult>;

/** Variables every CLI needs to run (locale, home for its login, temp dir, proxies and CA bundles). */
const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_CONFIG_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

/** Credentials and settings each CLI reads; nothing else of the server's environment (DB path, other secrets) is passed. */
export const CLI_ENV: Record<"claude" | "codex", string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AWS_REGION",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_API_KEY"],
};

/**
 * A minimal environment for a model CLI: the base variables, the CLI's own credentials, and any names the
 * operator lists in `DDD_AI_PASS_ENV` (comma-separated).
 */
export function cliEnv(cli: "claude" | "codex", source: Record<string, string | undefined> = process.env): Record<string, string> {
  const extra = (source.DDD_AI_PASS_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...CLI_ENV[cli], ...extra]) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  env.NO_COLOR = "1";
  return env;
}

export const spawnRunner: Runner = async (cmd, { stdin, cwd, timeoutMs, signal, env }) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: env ?? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" } });
  const kill = () => proc.kill();
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
};

/** Thrown when the model queue is full; the server answers 429. */
export class AiBusyError extends Error {
  constructor() {
    super("The AI queue is full");
  }
}

/** At most `max` model processes at a time and at most `maxQueue` waiting; waiting requests give up when aborted. */
export function limiter(max: number, maxQueue = Infinity) {
  let running = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (running >= max) {
      if (queue.length >= maxQueue) throw new AiBusyError();
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          const i = queue.indexOf(go);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error("aborted"));
        };
        queue.push(go);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

/** A conversation with an earlier answer, flattened for a single-prompt CLI. */
function flatten(messages: Message[]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages.map((m) => (m.role === "user" ? m.content : `<your_previous_answer>\n${m.content}\n</your_previous_answer>`)).join("\n\n");
}

const TIMEOUT: Record<CompleteRequest["purpose"], number> = { inline: 120_000, propose: 600_000, board: 300_000 };

export interface CliOptions {
  /** Executable (default: `claude` / `codex` on PATH). */
  bin?: string;
  /** Model passed to the CLI; default: the CLI's own default. */
  model?: string;
  /** Model for inline predictions (faster is better). */
  inlineModel?: string;
  run?: Runner;
  /** Working directory for the CLI: an empty directory so no project files or instructions are picked up. */
  cwd?: string;
  concurrency?: number;
  /** Requests that may wait for a free process; more are refused with AiBusyError (default DDD_AI_QUEUE or 8). */
  queue?: number;
  /** Environment for the CLI process (default: cliEnv(), a minimal allowlist). */
  env?: Record<string, string>;
  /** Codex only: load the user's config.toml and rules (default false; DDD_CODEX_USER_CONFIG=1). */
  userConfig?: boolean;
}

const queueSize = (o: CliOptions) => o.queue ?? (Number(process.env.DDD_AI_QUEUE) || 8);

const emptyDir = () => mkdtempSync(join(tmpdir(), "ddd-ai-"));

function cliError(name: string, r: RunResult): Error {
  const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return new Error(`${name} exited with ${r.code}: ${detail}`);
}

/**
 * Claude Code in print mode, with every tool disabled, no MCP servers, no settings/hooks,
 * and our system prompt instead of the coding-agent one.
 */
export function claudeCodeCompleter(options: CliOptions = {}): Completer {
  const bin = options.bin ?? "claude";
  const run = options.run ?? spawnRunner;
  const cwd = options.cwd ?? emptyDir();
  const limit = limiter(options.concurrency ?? 2, queueSize(options));
  const env = options.env ?? cliEnv("claude");
  const model = options.model ?? process.env.DDD_AI_MODEL;
  // Ghost text must arrive within seconds; the CLI's default (large) model takes far longer.
  const inlineModel = options.inlineModel ?? process.env.DDD_AI_INLINE_MODEL ?? "haiku";
  return {
    model: `${PROVIDER_LABEL["claude-code"]}${model ? ` ${model}` : ""}`,
    complete: (req) =>
      limit(async () => {
        const m = req.purpose === "inline" ? inlineModel : model;
        const cmd = [
          bin,
          "-p",
          "--output-format",
          "json",
          // `--opt=` form: an empty separate argument would be dropped by the process spawner,
          // and the option would swallow the next flag instead of disabling everything.
          "--tools=",
          "--strict-mcp-config",
          "--setting-sources=",
          "--no-session-persistence",
          "--effort",
          req.effort,
          "--system-prompt",
          SYSTEM,
          ...(m ? ["--model", m] : []),
          ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
        ];
        const r = await run(cmd, { stdin: flatten(req.messages), cwd, timeoutMs: TIMEOUT[req.purpose], signal: req.signal, env });
        const out = parseJson<{ is_error?: boolean; result?: string; structured_output?: unknown; stop_reason?: string }>(r.stdout.trim().split("\n").pop());
        if (!out) throw cliError("claude", r);
        if (out.is_error) throw new Error(`claude: ${String(out.result ?? "error").slice(0, 300)}`);
        if (out.stop_reason === "refusal") return undefined;
        if (req.schema) return out.structured_output !== undefined ? JSON.stringify(out.structured_output) : out.result;
        return out.result;
      }, req.signal),
  };
}

/** Features that let Codex act on the machine; assistance only needs text, so they are all off. */
const CODEX_DISABLED = ["shell_tool", "unified_exec", "shell_snapshot", "browser_use", "in_app_browser", "computer_use", "apps", "plugins", "hooks"];

/** Codex in exec mode, read-only sandbox, with its shell / browser / plugin tools disabled. */
export function codexCompleter(options: CliOptions = {}): Completer {
  const bin = options.bin ?? "codex";
  const run = options.run ?? spawnRunner;
  const cwd = options.cwd ?? emptyDir();
  const limit = limiter(options.concurrency ?? 2, queueSize(options));
  const env = options.env ?? cliEnv("codex");
  // Auth stays in CODEX_HOME (~/.codex); the user's config.toml (MCP servers, profiles, notify hooks) and
  // execpolicy rules are not loaded. DDD_CODEX_USER_CONFIG=1 keeps loading them (e.g. a custom model provider).
  const isolation = (options.userConfig ?? process.env.DDD_CODEX_USER_CONFIG === "1") ? [] : ["--ignore-user-config", "--ignore-rules"];
  const model = options.model ?? process.env.DDD_AI_CODEX_MODEL;
  const inlineModel = options.inlineModel ?? process.env.DDD_AI_CODEX_INLINE_MODEL ?? model;
  return {
    model: `${PROVIDER_LABEL.codex}${model ? ` ${model}` : ""}`,
    complete: (req) =>
      limit(async () => {
        const dir = await mkdtemp(join(tmpdir(), "ddd-codex-"));
        try {
          const outFile = join(dir, "answer.txt");
          const schemaFile = join(dir, "schema.json");
          if (req.schema) await writeFile(schemaFile, JSON.stringify(req.schema));
          const m = req.purpose === "inline" ? inlineModel : model;
          const cmd = [
            bin,
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            ...isolation,
            "--sandbox",
            "read-only",
            "--color",
            "never",
            ...CODEX_DISABLED.flatMap((f) => ["--disable", f]),
            "-c",
            'web_search="disabled"',
            "-c",
            `model_reasoning_effort="${req.effort}"`,
            ...(m ? ["--model", m] : []),
            ...(req.schema ? ["--output-schema", schemaFile] : []),
            "--output-last-message",
            outFile,
            "-",
          ];
          const stdin = `<instructions>\n${SYSTEM}\n</instructions>\n\n${flatten(req.messages)}`;
          const r = await run(cmd, { stdin, cwd, timeoutMs: TIMEOUT[req.purpose], signal: req.signal, env });
          if (r.code !== 0) throw cliError("codex", r);
          const text = await readFile(outFile, "utf8").catch(() => "");
          return text.trim() ? text : undefined;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, req.signal),
  };
}

// -- configuration -----------------------------------------------------------------

/**
 * Every assistant this server can offer, from the environment:
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` → Claude API; `claude` / `codex` on PATH → local CLIs.
 * `DDD_AI=off` disables AI; `DDD_AI=claude-code,codex` limits the choice.
 */
export function assistantsFromEnv(which: (bin: string) => string | null = (b) => Bun.which(b)): Partial<Record<ProviderId, ModelAssistant>> {
  const setting = (process.env.DDD_AI ?? "").trim();
  if (setting === "off") return {};
  const allowed = setting ? new Set(setting.split(",").map((s) => s.trim())) : undefined;
  const ok = (id: ProviderId) => !allowed || allowed.has(id);
  const out: Partial<Record<ProviderId, ModelAssistant>> = {};
  if (ok("api") && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) out.api = claudeAssistant();
  const claudeBin = process.env.DDD_CLAUDE_BIN ?? which("claude");
  if (ok("claude-code") && claudeBin) out["claude-code"] = assistantWith(claudeCodeCompleter({ bin: claudeBin }));
  const codexBin = process.env.DDD_CODEX_BIN ?? which("codex");
  if (ok("codex") && codexBin) out.codex = assistantWith(codexCompleter({ bin: codexBin }));
  return out;
}

/** The first configured assistant (kept for callers that need only one). */
export function assistantFromEnv(): ModelAssistant | undefined {
  return Object.values(assistantsFromEnv())[0];
}
