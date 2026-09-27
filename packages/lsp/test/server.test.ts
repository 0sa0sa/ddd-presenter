/** Speaks LSP (JSON-RPC over stdio) to the real server process, as VS Code does. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const SOURCE = join(import.meta.dir, "../src/server.ts");
const BUNDLE = join(import.meta.dir, "../../vscode/dist/server.cjs");
const URI = "file:///tmp/model.ddd.yaml";

class Client {
  private buf = Buffer.alloc(0);
  private id = 0;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private waiters: ((msg: any) => boolean)[] = [];

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const sep = this.buf.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, sep).toString())![1]);
        if (this.buf.length < sep + 4 + len) return;
        const msg = JSON.parse(this.buf.subarray(sep + 4, sep + 4 + len).toString("utf8"));
        this.buf = this.buf.subarray(sep + 4 + len);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        } else if (msg.method) {
          this.notifications.push(msg);
          this.waiters = this.waiters.filter((w) => !w(msg));
        }
      }
    });
  }

  private write(msg: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  waitFor(pred: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
    const found = this.notifications.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for notification")), timeoutMs);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      });
    });
  }
}

function positionOf(text: string, needle: string, delta: number): { line: number; character: number } {
  const offset = text.indexOf(needle) + delta;
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before[before.length - 1]!.length };
}

const runs: [string, string[]][] = [["TypeScript source (bun)", ["bun", SOURCE, "--stdio"]]];
if (existsSync(BUNDLE)) runs.push(["VS Code bundle (node)", ["node", BUNDLE, "--stdio"]]);

describe.each(runs)("language server: %s", (_label, cmd) => {
  let client: Client;

  beforeAll(async () => {
    client = new Client(spawn(cmd[0]!, cmd.slice(1), { stdio: "pipe" }));
    const init = await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    expect(init.result.capabilities.completionProvider).toBeDefined();
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", { textDocument: { uri: URI, languageId: "ddd-yaml", version: 1, text: SAMPLE } });
  });

  afterAll(() => client.proc.kill());

  test("publishes diagnostics on open and on change", async () => {
    const first = await client.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.version === 1);
    expect(first.params.diagnostics.filter((d: any) => d.severity === 1)).toEqual([]);
    const broken = SAMPLE.replace("error: InvitationNotDeliverable", "error: Missing");
    client.notify("textDocument/didChange", { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: broken }] });
    const second = await client.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.version === 2);
    const err = second.params.diagnostics.find((d: any) => d.code === "unknown-error");
    expect(err.severity).toBe(1);
    expect(err.range.start.line).toBe(positionOf(broken, "error: Missing", 0).line);
    client.notify("textDocument/didChange", { textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: SAMPLE }] });
    await client.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.version === 3);
  });

  test("completion of enum values inside a rule expression", async () => {
    const r = await client.request("textDocument/completion", { textDocument: { uri: URI }, position: positionOf(SAMPLE, "expression: status == pending\n            error: InvitationAlreadyClosed", 22) });
    const labels = r.result.items.map((i: any) => i.label);
    expect(labels.slice(0, 3).sort()).toEqual(["accepted", "pending", "revoked"]);
    expect(r.result.items[0].textEdit.range.start).toBeDefined();
  });

  test("hover and definition", async () => {
    const pos = positionOf(SAMPLE, "error: InvitationNotDeliverable", 12);
    const h = await client.request("textDocument/hover", { textDocument: { uri: URI }, position: pos });
    expect(h.result.contents.value).toContain("invitation_not_deliverable");
    const d = await client.request("textDocument/definition", { textDocument: { uri: URI }, position: pos });
    expect(d.result.range.start.line).toBe(positionOf(SAMPLE, "- name: InvitationNotDeliverable", 0).line);
  });

  test("prepareRename and rename", async () => {
    const pos = positionOf(SAMPLE, "raises: InvitationAlreadyClosed", 10);
    const prep = await client.request("textDocument/prepareRename", { textDocument: { uri: URI }, position: pos });
    expect(prep.result.placeholder).toBe("InvitationAlreadyClosed");
    const r = await client.request("textDocument/rename", { textDocument: { uri: URI }, position: pos, newName: "InvitationClosed" });
    const newText: string = r.result.changes[URI][0].newText;
    expect(newText).not.toContain("InvitationAlreadyClosed");
    const bad = await client.request("textDocument/prepareRename", { textDocument: { uri: URI }, position: positionOf(SAMPLE, "expression: expires_at", 14) });
    expect(bad.error.message).toContain("型");
  });
});
