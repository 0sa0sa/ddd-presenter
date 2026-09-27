/**
 * Starts the real server process (as `bun run start` does) and exercises it over HTTP,
 * including the built Web UI when packages/web/dist exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");
const DIST = join(import.meta.dir, "../../web/dist/index.html");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`server did not start: ${url}`);
      await Bun.sleep(100);
    }
  }
}

let proc: ReturnType<typeof Bun.spawn>;
let base: string;
let port: number;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ddd-server-"));
  port = await freePort();
  base = `http://localhost:${port}`;
  // The database directory does not exist yet, as on a fresh checkout.
  proc = Bun.spawn(["bun", MAIN], { env: { ...process.env, PORT: String(port), DDD_DB: join(dir, "not", "yet", "db.sqlite") }, stdout: "pipe", stderr: "pipe" });
  await waitFor(`${base}/api/health`);
});

afterAll(() => {
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("server process", () => {
  test("identifies itself on /api/health", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ service: "ddd-presenter", ok: true });
  });

  test("login → project → preview works over real HTTP with a file database", async () => {
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "smoke" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { workspaces: { id: string }[] };
    const created = (await (
      await fetch(`${base}/api/workspaces/${me.workspaces[0]!.id}/projects`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: base },
        body: JSON.stringify({ name: "Smoke" }),
      })
    ).json()) as { id: string };
    const preview = await fetch(`${base}/api/projects/${created.id}/preview`, { headers: { cookie } });
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { files: unknown[] };
    expect(body.files.length).toBeGreaterThan(20);
  });

  test.skipIf(!existsSync(DIST))("serves the built Web UI for any non-API path", async () => {
    const res = await fetch(`${base}/p/some/deep/link`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
    expect((await fetch(`${base}/api/nope`)).status).toBe(401);
  });

  test("a port already in use fails fast with guidance instead of a stack trace", async () => {
    const second = Bun.spawn(["bun", MAIN], { env: { ...process.env, PORT: String(port), DDD_DB: join(dir, "db2.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const code = await second.exited;
    const err = await new Response(second.stderr as ReadableStream).text();
    expect(code).toBe(1);
    expect(err).toContain(`ポート ${port} は別のプロセスが使用中です`);
  });
});
