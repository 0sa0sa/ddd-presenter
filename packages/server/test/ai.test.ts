import { beforeEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAssistant, type ModelAssistant } from "../src/ai.ts";
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
