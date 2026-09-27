import { beforeEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assistantsFromEnv, assistantWith, claudeAssistant, claudeCodeCompleter, codexCompleter, limiter, type ModelAssistant, type Runner } from "../src/ai.ts";
import { writeFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

/** Scriptable fake LLM. */
class FakeAssistant implements ModelAssistant {
  readonly model = "fake-model";
  inlineText: string | undefined = "";
  proposals: (string | undefined)[] = [];
  boardSuggestions: Awaited<ReturnType<ModelAssistant["board"]>> = [];
  calls: string[] = [];
  async inline() {
    this.calls.push("inline");
    return this.inlineText;
  }
  async propose(req: Parameters<ModelAssistant["propose"]>[0]) {
    this.calls.push(req.repair ? "propose:repair" : "propose");
    const yaml = this.proposals.shift();
    return yaml === undefined ? undefined : { yaml, summary: ["changed"], facts: ["f"], assumptions: ["a"], questions: ["q"] };
  }
  async board() {
    this.calls.push("board");
    return this.boardSuggestions;
  }
}

let fake: FakeAssistant;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  fake = new FakeAssistant();
  app = createApp(openDatabase(":memory:"), { assistant: fake });
});

async function login(username: string) {
  const res = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const ws = (await json("GET", "/api/me")).body.workspaces[0].id as string;
  const project = (await json("POST", `/api/workspaces/${ws}/projects`, { name: "P" })).body.id as string;
  return { json, ws, project };
}

describe("AI settings", () => {
  test("AI is off by default; only owners can turn it on, and it is audited", async () => {
    const owner = await login("owner");
    expect((await owner.json("GET", `/api/projects/${owner.project}/assist`)).body).toMatchObject({ available: true, enabled: false, active: false });
    const inline = await owner.json("POST", `/api/projects/${owner.project}/assist/inline`, { yaml: SAMPLE, offset: 10 });
    expect(inline.status).toBe(403);
    expect(fake.calls).toEqual([]); // nothing was sent to the model

    const editor = await login("editor");
    await owner.json("POST", `/api/workspaces/${owner.ws}/members`, { username: "editor", role: "editor" });
    expect((await editor.json("PATCH", `/api/workspaces/${owner.ws}/settings`, { ai_enabled: true })).status).toBe(403);

    expect((await owner.json("PATCH", `/api/workspaces/${owner.ws}/settings`, { ai_enabled: true })).body.ai_enabled).toBe(true);
    expect((await owner.json("GET", `/api/projects/${owner.project}/assist`)).body.active).toBe(true);
    const log = (await owner.json("GET", `/api/workspaces/${owner.ws}/audit`)).body.entries.map((e: any) => e.action);
    expect(log[0]).toBe("ai.enable");
  });

  test("without AI, proposals come from local rules and free-form requests are refused", async () => {
    const s = await login("alice");
    const local = await s.json("POST", `/api/projects/${s.project}/assist/propose`, { yaml: SAMPLE, context: "CleaningStaff", aggregate: "CleaningStaffInvitation", kind: "scenarios" });
    expect(local.body.proposal.source).toBe("local");
    expect(validateModelText(local.body.proposal.yaml).ok).toBe(true);
    const custom = await s.json("POST", `/api/projects/${s.project}/assist/propose`, { yaml: SAMPLE, context: "CleaningStaff", kind: "custom", instruction: "x" });
    expect(custom.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });
});

describe("AI assistance", () => {
  async function enabled() {
    const s = await login("alice");
    await s.json("PATCH", `/api/workspaces/${s.ws}/settings`, { ai_enabled: true });
    return s;
  }

  test("inline suggestions that keep the model valid are returned; breaking ones are dropped", async () => {
    const s = await enabled();
    const offset = SAMPLE.indexOf("\n    use_cases:");
    fake.inlineText = "\n          - name: extra_case\n            when: { operation: revoke }\n            given:\n              aggregate: { id: \"00000000-0000-0000-0000-000000000001\", email: { value: \"a@b.c\" }, status: accepted, created_at: \"2026-01-01T10:00:00+00:00\", expires_at: \"2026-01-08T10:00:00+00:00\", accepted_at: \"2026-01-02T10:00:00+00:00\" }\n            then: { raises: InvitationAlreadyClosed }";
    const ok = await s.json("POST", `/api/projects/${s.project}/assist/inline`, { yaml: SAMPLE, offset });
    expect(ok.body.suggestion).toMatchObject({ source: "llm" });
    fake.inlineText = "\n  - broken: [";
    const bad = await s.json("POST", `/api/projects/${s.project}/assist/inline`, { yaml: SAMPLE, offset });
    expect(bad.body).toMatchObject({ suggestion: null, dropped: true });
  });

  test("an invalid proposal gets one repair round with the validator's errors", async () => {
    const s = await enabled();
    fake.proposals = [SAMPLE.replace("error: InvitationNotDeliverable", "error: Nope"), SAMPLE];
    const r = await s.json("POST", `/api/projects/${s.project}/assist/propose`, { yaml: SAMPLE, context: "CleaningStaff", aggregate: "CleaningStaffInvitation", kind: "custom", instruction: "期限切れを扱いたい" });
    expect(fake.calls).toEqual(["propose", "propose:repair"]);
    expect(r.body.proposal).toMatchObject({ source: "llm", facts: ["f"], assumptions: ["a"], questions: ["q"] });
    expect(r.body.diagnostics.filter((d: any) => d.severity === "error")).toEqual([]);
  });

  test("board: structural ghosts always, LLM ghosts placed next to their anchor when asked", async () => {
    const s = await enabled();
    const board = { version: 1, frames: [], connectors: [], items: [{ id: "c1", kind: "command", text: "注文を確定する", x: 100, y: 100, w: 160, h: 100 }] };
    fake.boardSuggestions = [{ kind: "actor", text: "購入者", near_item_id: "c1", placement: "above", connect: "to_near", reason: "誰が確定するか" }, { kind: "nonsense", text: "x", near_item_id: "c1", placement: "left", connect: "none", reason: "" }];
    const local = await s.json("POST", `/api/projects/${s.project}/assist/board`, { board });
    expect(local.body.ghosts.map((g: any) => [g.kind, g.text, g.source])).toEqual([
      ["event", "注文が確定された", "local"],
      ["aggregate", "注文", "local"],
    ]);
    const withLlm = await s.json("POST", `/api/projects/${s.project}/assist/board`, { board, llm: true });
    const actor = withLlm.body.ghosts.find((g: any) => g.source === "llm");
    expect(actor).toMatchObject({ kind: "actor", text: "購入者", x: 100, y: 100 - 60 - 40, connect: { from: actor.id, to: "c1" } });
    expect(withLlm.body.ghosts.filter((g: any) => g.source === "llm")).toHaveLength(1); // invalid kind dropped
  });
});

describe("Claude request shape", () => {
  function fakeClient(response: Partial<Anthropic.Beta.BetaMessage>) {
    const requests: any[] = [];
    const client = { beta: { messages: { create: async (req: any) => (requests.push(req), { stop_reason: "end_turn", content: [], ...response }) } } } as unknown as Anthropic;
    return { client, requests };
  }

  test("uses the configured model, server-side fallbacks, a cached system prompt and low effort for ghost text", async () => {
    const { client, requests } = fakeClient({ content: [{ type: "text", text: "```yaml\n  - name: x\n```", citations: null }] as any });
    const ai = claudeAssistant({ client, model: "claude-opus-5" });
    const text = await ai.inline({ yaml: "a: 1\n", offset: 5 });
    expect(text).toBe("  - name: x");
    const req = requests[0];
    expect(req.model).toBe("claude-opus-5");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect(req.output_config.effort).toBe("low");
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[0].text).toContain("<dsl_reference>");
    expect(req.messages[0].content).toContain("a: 1\n<cursor/>");
  });

  test("proposals request structured JSON; a refusal yields no proposal", async () => {
    const ok = fakeClient({ content: [{ type: "text", text: JSON.stringify({ yaml: "y", summary: [], facts: [], assumptions: [], questions: [] }), citations: null }] as any });
    const p = await claudeAssistant({ client: ok.client }).propose({ yaml: "x", context: "C", kind: "scenarios" });
    expect(p?.yaml).toBe("y");
    expect(ok.requests[0].output_config.format.type).toBe("json_schema");
    expect(ok.requests[0].model).toBe("claude-opus-5");
    const refused = fakeClient({ stop_reason: "refusal" as any, content: [{ type: "text", text: "{}", citations: null }] as any });
    expect(await claudeAssistant({ client: refused.client }).propose({ yaml: "x", context: "C", kind: "scenarios" })).toBeUndefined();
  });
});

describe("local agent CLIs", () => {
  const recorder = (reply: (cmd: string[], stdin: string) => { code?: number; stdout?: string; stderr?: string }) => {
    const calls: { cmd: string[]; stdin: string; cwd: string }[] = [];
    const run: Runner = async (cmd, { stdin, cwd }) => {
      calls.push({ cmd, stdin, cwd });
      const r = reply(cmd, stdin);
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { calls, run };
  };

  test("Claude Code runs in print mode with no tools, no settings and our system prompt", async () => {
    const { calls, run } = recorder(() => ({ stdout: JSON.stringify({ type: "result", is_error: false, result: "- name: revoke" }) }));
    const ai = assistantWith(claudeCodeCompleter({ bin: "claude", run, cwd: "/tmp/empty" }));
    expect(await ai.inline({ yaml: "a\n", offset: 2 })).toBe("- name: revoke");
    const { cmd, stdin, cwd } = calls[0]!;
    expect(cmd.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(cmd).toContain("--tools="); // no tools; never a separate "" argument
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--setting-sources=");
    expect(cmd).not.toContain("");
    expect(cmd[cmd.indexOf("--system-prompt") + 1]).toContain("<dsl_reference>");
    expect(cmd[cmd.indexOf("--effort") + 1]).toBe("low");
    expect(stdin).toContain("<cursor/>"); // the model goes through stdin, not argv
    expect(cwd).toBe("/tmp/empty");
  });

  test("Claude Code structured answers use --json-schema and structured_output", async () => {
    const proposal = { yaml: "y", summary: ["s"], facts: [], assumptions: [], questions: [] };
    const { calls, run } = recorder(() => ({ stdout: JSON.stringify({ is_error: false, result: "", structured_output: proposal }) }));
    const ai = assistantWith(claudeCodeCompleter({ run, cwd: "/tmp" }));
    expect(await ai.propose({ yaml: "x", context: "C", kind: "scenarios", repair: { yaml: "bad", errors: ["line 1: oops"] } })).toEqual(proposal);
    const { cmd, stdin } = calls[0]!;
    expect(JSON.parse(cmd[cmd.indexOf("--json-schema") + 1]!).required).toContain("yaml");
    expect(stdin).toContain("<your_previous_answer>"); // the repair turn is flattened into one prompt
    expect(stdin).toContain("line 1: oops");
  });

  test("CLI failures surface as errors (the endpoint then reports that the AI did not answer)", async () => {
    const notLoggedIn = recorder(() => ({ stdout: JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }) }));
    await expect(assistantWith(claudeCodeCompleter({ run: notLoggedIn.run, cwd: "/tmp" })).inline({ yaml: "a", offset: 1 })).rejects.toThrow("Not logged in");
    const crashed = recorder(() => ({ code: 1, stderr: "boom" }));
    await expect(assistantWith(claudeCodeCompleter({ run: crashed.run, cwd: "/tmp" })).inline({ yaml: "a", offset: 1 })).rejects.toThrow("boom");
  });

  test("Codex runs read-only with its shell, browser and plugin tools disabled and reads the last message", async () => {
    const { calls, run } = recorder((cmd) => {
      writeFileSync(cmd[cmd.indexOf("--output-last-message") + 1]!, JSON.stringify({ suggestions: [] }));
      return {};
    });
    const ai = assistantWith(codexCompleter({ bin: "codex", run, cwd: "/tmp" }));
    const board = { version: 1 as const, items: [], frames: [], connectors: [] };
    expect(await ai.board({ board })).toEqual([]);
    const { cmd, stdin } = calls[0]!;
    expect(cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("read-only");
    for (const f of ["shell_tool", "unified_exec", "browser_use", "computer_use", "plugins"]) expect(cmd.join(" ")).toContain(`--disable ${f}`);
    expect(cmd).toContain("--output-schema");
    expect(cmd.at(-1)).toBe("-"); // prompt on stdin
    expect(stdin).toStartWith("<instructions>");
  });

  test("at most N model processes run at once; a waiting request can be abandoned", async () => {
    const run = limiter(1);
    let release!: () => void;
    const first = run(() => new Promise<string>((r) => (release = () => r("first"))));
    const ctrl = new AbortController();
    const second = run(async () => "second", ctrl.signal);
    ctrl.abort();
    await expect(second).rejects.toThrow("aborted");
    const third = run(async () => "third");
    release();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
  });

  test("the server offers every configured provider; DDD_AI narrows or disables them", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.DDD_CLAUDE_BIN;
      delete process.env.DDD_CODEX_BIN;
      delete process.env.DDD_AI;
      const which = (b: string) => (b === "claude" || b === "codex" ? `/usr/bin/${b}` : null);
      expect(Object.keys(assistantsFromEnv(which))).toEqual(["claude-code", "codex"]);
      process.env.DDD_AI = "codex";
      expect(Object.keys(assistantsFromEnv(which))).toEqual(["codex"]);
      process.env.DDD_AI = "off";
      expect(Object.keys(assistantsFromEnv(which))).toEqual([]);
      process.env.DDD_AI = "";
      expect(Object.keys(assistantsFromEnv(() => null))).toEqual([]);
    } finally {
      process.env = saved;
    }
  });
});

describe("choosing the assistant per workspace", () => {
  test("owners pick among the server's providers; requests go to the chosen one", async () => {
    const a = new FakeAssistant();
    const b = new FakeAssistant();
    (a as { model: string }).model = "Claude Code（ローカルCLI）";
    (b as { model: string }).model = "Codex CLI（ローカル）";
    a.inlineText = "a";
    b.inlineText = "b";
    app = createApp(openDatabase(":memory:"), { assistants: { "claude-code": a, codex: b } });
    const s = await login("owner");
    const ws = (await s.json("GET", `/api/workspaces/${s.ws}`)).body;
    expect(ws.ai_providers.map((p: any) => p.id)).toEqual(["claude-code", "codex"]);
    expect(ws.workspace.ai_provider).toBe("claude-code"); // the first is the default
    expect((await s.json("PATCH", `/api/workspaces/${s.ws}/settings`, { ai_provider: "gpt" })).status).toBe(400);
    const set = await s.json("PATCH", `/api/workspaces/${s.ws}/settings`, { ai_enabled: true, ai_provider: "codex" });
    expect(set.body).toMatchObject({ ai_enabled: true, ai_provider: "codex", ai_model: "Codex CLI（ローカル）" });
    await s.json("POST", `/api/projects/${s.project}/assist/inline`, { yaml: SAMPLE, offset: SAMPLE.length });
    expect(b.calls).toEqual(["inline"]);
    expect(a.calls).toEqual([]);
    const log = (await s.json("GET", `/api/workspaces/${s.ws}/audit`)).body.entries.map((e: any) => e.action);
    expect(log).toContain("ai.provider");
  });
});
