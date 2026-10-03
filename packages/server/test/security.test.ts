/**
 * Accounts, sessions, request hardening, limits and the AI gate (docs/09 §11).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { AiBusyError, cliEnv, codexCompleter, limiter, type ModelAssistant, type Runner } from "../src/ai.ts";
import { createApp, purgeExpiredSessions, zipEntryName, type AppOptions } from "../src/app.ts";
import { runAdmin } from "../src/admin.ts";
import { configFromEnv } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { hostnameOf, isLoopback, TokenBucket } from "../src/security.ts";
import { serveWebApp } from "../src/static.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const ORIGIN = "http://localhost";
type App = ReturnType<typeof createApp>;

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

function client(app: App, cookie: string) {
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    cookie,
    call,
    json: async <T = any>(method: string, path: string, body?: unknown) => {
      const r = await call(method, path, body);
      return { status: r.status, body: (await r.json()) as T };
    },
  };
}

async function register(app: App, username: string, password = "correct horse") {
  const res = await post(app, "/api/register", { username, password });
  expect(res.status).toBe(201);
  return client(app, cookieOf(res));
}

async function devLogin(app: App, username: string) {
  const res = await post(app, "/api/login", { username });
  expect(res.status).toBe(200);
  return client(app, cookieOf(res));
}

describe("password accounts", () => {
  test("register, sign in with the password, wrong passwords are refused", async () => {
    const app = createApp(openDatabase(":memory:"));
    const alice = await register(app, "alice");
    expect((await alice.json("GET", "/api/me")).body.user).toMatchObject({ username: "alice", has_password: true });
    expect((await post(app, "/api/register", { username: "alice", password: "another one" })).status).toBe(409);
    expect((await post(app, "/api/register", { username: "bob", password: "short" })).status).toBe(400);
    expect((await post(app, "/api/login", { username: "alice", password: "wrong password" })).status).toBe(401);
    expect((await post(app, "/api/login", { username: "nobody", password: "whatever1" })).status).toBe(401);
    const ok = await post(app, "/api/login", { username: "alice", password: "correct horse" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("username-only sign-in is refused unless dev login is on", async () => {
    const app = createApp(openDatabase(":memory:"));
    expect((await post(app, "/api/login", { username: "mallory" })).status).toBe(400);
    expect((await (await app.request("/api/auth/config")).json()) as any).toEqual({ dev_login: false, registration: true, proxy_auth: false });
  });

  test("repeated failures for an account are throttled", async () => {
    const app = createApp(openDatabase(":memory:"));
    await register(app, "alice");
    for (let i = 0; i < 10; i++) expect((await post(app, "/api/login", { username: "alice", password: `guess-${i}xx` })).status).toBe(401);
    expect((await post(app, "/api/login", { username: "alice", password: "correct horse" })).status).toBe(429);
  });

  test("registration can be closed", async () => {
    const app = createApp(openDatabase(":memory:"), { registration: "closed" });
    expect((await post(app, "/api/register", { username: "alice", password: "correct horse" })).status).toBe(403);
    expect(((await (await app.request("/api/auth/config")).json()) as any).registration).toBe(false);
  });

  test("changing the password needs the current one and ends the other sessions", async () => {
    const app = createApp(openDatabase(":memory:"));
    const a = await register(app, "alice");
    const other = client(app, cookieOf(await post(app, "/api/login", { username: "alice", password: "correct horse" })));
    expect((await a.json("POST", "/api/account/password", { current_password: "nope nope", new_password: "battery staple" })).status).toBe(403);
    expect((await a.json("POST", "/api/account/password", { current_password: "correct horse", new_password: "battery staple" })).status).toBe(200);
    expect((await a.call("GET", "/api/me")).status).toBe(200); // this session stays
    expect((await other.call("GET", "/api/me")).status).toBe(401); // the other one ended
    expect((await post(app, "/api/login", { username: "alice", password: "correct horse" })).status).toBe(401);
    expect((await post(app, "/api/login", { username: "alice", password: "battery staple" })).status).toBe(200);
  });

  test("log out everywhere ends every session of the user only", async () => {
    const app = createApp(openDatabase(":memory:"));
    const a1 = await register(app, "alice");
    const a2 = client(app, cookieOf(await post(app, "/api/login", { username: "alice", password: "correct horse" })));
    const bob = await register(app, "bob");
    const r = await a1.json("POST", "/api/logout-all");
    expect(r.body).toMatchObject({ ok: true, sessions: 2 });
    expect((await a1.call("GET", "/api/me")).status).toBe(401);
    expect((await a2.call("GET", "/api/me")).status).toBe(401);
    expect((await bob.call("GET", "/api/me")).status).toBe(200);
  });

  test("expired sessions are purged", async () => {
    const db = openDatabase(":memory:");
    const app = createApp(db);
    const a = await register(app, "alice");
    db.query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await a.call("GET", "/api/me")).status).toBe(401);
    expect(purgeExpiredSessions(db)).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  });

  test("the user list needs a session and is never part of the public config outside dev login", async () => {
    const app = createApp(openDatabase(":memory:"));
    expect((await app.request("/api/users")).status).toBe(401);
    const alice = await register(app, "alice");
    await register(app, "bob");
    // Without dev login, only people who share a workspace are listed.
    expect((await alice.json("GET", "/api/users")).body.users).toEqual([{ username: "alice" }]);
  });
});

describe("dev login (local first run)", () => {
  test("auto: on while bound to loopback and no account has a password; registering turns it off", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: "auto", loopback: true });
    const bob = await devLogin(app, "bob");
    let config = (await (await app.request("/api/auth/config")).json()) as any;
    expect(config).toMatchObject({ dev_login: true, users: ["bob"] });
    // bob claims his account by setting a password (no current password needed).
    expect((await bob.json("POST", "/api/account/password", { new_password: "bob's secret" })).status).toBe(200);
    config = (await (await app.request("/api/auth/config")).json()) as any;
    expect(config.dev_login).toBe(false);
    expect(config.users).toBeUndefined();
    expect((await post(app, "/api/login", { username: "carol" })).status).toBe(400);
    expect((await post(app, "/api/login", { username: "bob", password: "bob's secret" })).status).toBe(200);
  });

  test("auto is off for requests relayed by a reverse proxy, and the loopback AI default does not apply to them", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: "auto", loopback: true, assistant: { model: "m", inline: async () => "", propose: async () => undefined, board: async () => [] } });
    const proxied = { "x-forwarded-for": "203.0.113.9" };
    expect((await post(app, "/api/login", { username: "eve" }, proxied)).status).toBe(400);
    expect(((await (await app.request("/api/auth/config", { headers: proxied })).json()) as any).dev_login).toBe(false);
    const first = await devLogin(app, "first");
    const ws = (await first.json("GET", "/api/me")).body.workspaces[0].id;
    const viaProxy = await app.request(`/api/workspaces/${ws}/settings`, { method: "PATCH", headers: { cookie: first.cookie, origin: ORIGIN, "content-type": "application/json", ...proxied }, body: JSON.stringify({ ai_enabled: true }) });
    expect(viaProxy.status).toBe(403);
    expect((await first.json("PATCH", `/api/workspaces/${ws}/settings`, { ai_enabled: true })).status).toBe(200);
  });

  test("auto is off on a network address; explicit on still protects accounts with a password", async () => {
    const network = createApp(openDatabase(":memory:"), { devLogin: "auto", loopback: false });
    expect((await post(network, "/api/login", { username: "x" })).status).toBe(400);
    const dev = createApp(openDatabase(":memory:"), { devLogin: true });
    await register(dev, "alice");
    expect((await post(dev, "/api/login", { username: "alice" })).status).toBe(401);
    expect((await post(dev, "/api/login", { username: "someone" })).status).toBe(200);
  });
});

describe("trusted proxy header (SSO in front)", () => {
  test("only when configured; creates the account on first sight", async () => {
    const plain = createApp(openDatabase(":memory:"));
    expect((await plain.request("/api/me", { headers: { "x-forwarded-user": "alice" } })).status).toBe(401);

    const app = createApp(openDatabase(":memory:"), { trustedUserHeader: "X-Forwarded-User" });
    const me = await app.request("/api/me", { headers: { "x-forwarded-user": "alice@example.com" } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.username).toBe("alice@example.com");
    expect((await app.request("/api/me", { headers: { "x-forwarded-user": "bad name<>" } })).status).toBe(401);
    // Mutations authenticated by the header still need our Origin.
    const noOrigin = await app.request("/api/workspaces", { method: "POST", headers: { "x-forwarded-user": "alice@example.com", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(noOrigin.status).toBe(403);
    const withOrigin = await post(app, "/api/workspaces", { name: "x" }, { "x-forwarded-user": "alice@example.com" });
    expect(withOrigin.status).toBe(201);
  });
});

describe("request hardening", () => {
  test("only allowed host names are answered (DNS rebinding)", async () => {
    const app = createApp(openDatabase(":memory:"), { allowedHosts: ["ddd.example.com"] });
    for (const host of ["localhost:4870", "127.0.0.1:4870", "[::1]:4870", "ddd.example.com", "DDD.example.com:443"]) expect((await app.request("/api/health", { headers: { host } })).status).toBe(200);
    const evil = await app.request("/api/health", { headers: { host: "evil.example:4870" } });
    expect(evil.status).toBe(421);
    expect(((await evil.json()) as any).error).toContain("DDD_ALLOWED_HOSTS");
    expect(evil.headers.get("x-frame-options")).toBe("DENY");
    const any = createApp(openDatabase(":memory:"), { allowedHosts: "*" });
    expect((await any.request("/api/health", { headers: { host: "evil.example" } })).status).toBe(200);
  });

  test("mutations need JSON, a matching Origin when a session cookie is sent, and Origin: null is a clean 403", async () => {
    const app = createApp(openDatabase(":memory:"));
    const s = await register(app, "alice");
    const send = (headers: Record<string, string>, body = JSON.stringify({ name: "x" })) => app.request("/api/workspaces", { method: "POST", headers: { cookie: s.cookie, ...headers }, body });
    expect((await send({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect((await send({ origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, "name=x")).status).toBe(415);
    expect((await send({ origin: ORIGIN })).status).toBe(415);
    expect((await send({ "content-type": "application/json" })).status).toBe(403); // cookie without Origin
    expect((await send({ origin: "null", "content-type": "application/json" })).status).toBe(403);
    expect((await send({ origin: "not a url", "content-type": "application/json" })).status).toBe(403);
    expect((await send({ origin: ORIGIN, "content-type": "application/json; charset=utf-8" })).status).toBe(201);
    // Clients without cookies (scripts, the CLI-style login) are unaffected by the Origin rule.
    expect((await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "correct horse" }) })).status).toBe(200);
  });

  test("security headers on API, error and 404 responses", async () => {
    const app = createApp(openDatabase(":memory:"));
    for (const res of [await app.request("/api/health"), await app.request("/api/me"), await app.request("/nope")]) {
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("the static Web UI: malformed paths are 400, source maps are not served, nothing outside dist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-dist-"));
    try {
      const dist = join(dir, "dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(join(dist, "index.html"), '<div id="root"></div>');
      writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
      writeFileSync(join(dist, "assets", "app.js.map"), "{}");
      writeFileSync(join(dir, "secret.txt"), "secret");
      const app = createApp(openDatabase(":memory:"));
      serveWebApp(app, dist);
      expect((await app.request("/%E0%A4%A")).status).toBe(400);
      expect((await app.request("/assets/app.js.map")).status).toBe(404);
      const js = await app.request("/assets/app.js");
      expect(await js.text()).toBe("console.log(1)");
      expect(js.headers.get("x-content-type-options")).toBe("nosniff");
      for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
        const r = await app.request(p);
        expect(await r.text()).not.toContain("secret");
      }
      const deep = await app.request("/p/some/route");
      expect(await deep.text()).toContain('<div id="root">');
      const withMaps = createApp(openDatabase(":memory:"));
      serveWebApp(withMaps, dist, { sourceMaps: true });
      expect((await withMaps.request("/assets/app.js.map")).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("limits", () => {
  async function project(app: App) {
    const s = await devLogin(app, "alice");
    const ws = (await s.json("GET", "/api/me")).body.workspaces[0].id;
    const id = (await s.json("POST", `/api/workspaces/${ws}/projects`, { name: "P" })).body.id as string;
    return { s, id };
  }

  test("bodies are size-checked before parsing", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: true });
    const { s, id } = await project(app);
    const notJson = `{"yaml": "${"x".repeat(1_400_000)}`; // too large AND malformed: the size wins
    const r = await app.request("/api/validate", { method: "POST", headers: { cookie: s.cookie, origin: ORIGIN, "content-type": "application/json" }, body: notJson });
    expect(r.status).toBe(413);
    const declared = await app.request(`/api/projects/${id}/layout`, { method: "PUT", headers: { cookie: s.cookie, origin: ORIGIN, "content-type": "application/json", "content-length": String(29_000_000) }, body: "{}" });
    expect(declared.status).toBe(413);
    expect((await s.json("PUT", `/api/projects/${id}/layout`, { positions: { a: { x: 1, y: 2 }, pad: "x".repeat(1_100_000) } })).status).toBe(413);
    expect((await s.json("POST", "/api/workspaces", { name: "x".repeat(70_000) })).status).toBe(413);
    expect((await s.json("POST", "/api/workspaces", [1, 2])).status).toBe(400);
  });

  test("layouts keep only { x, y } numbers and a bounded number of keys", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: true });
    const { s, id } = await project(app);
    const many = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, { x: 1, y: 1 }]));
    expect((await s.json("PUT", `/api/projects/${id}/layout`, { positions: many })).status).toBe(413);
    await s.json("PUT", `/api/projects/${id}/layout`, { positions: { a: { x: 1.4, y: 2, extra: "x".repeat(1000) }, b: { x: "1", y: 2 }, c: { x: 1e12, y: 0 }, d: null } });
    expect((await s.json("GET", `/api/projects/${id}/layout`)).body.positions).toEqual({ a: { x: 1, y: 2 } });
  });

  test("the board assistant has the board limits and stays fast on a full row", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: true });
    const { s, id } = await project(app);
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: "command", text: "注文を確定する", x: i * 200, y: 0, w: 160, h: 100 }));
    expect((await s.json("POST", `/api/projects/${id}/assist/board`, { board: { version: 1, frames: [], connectors: [], items: items(3001) } })).status).toBe(413);
    const big = { version: 1, frames: [], connectors: [], items: items(10).map((i) => ({ ...i, text: "x".repeat(500) })), pad: "x".repeat(2_100_000) };
    expect((await s.json("POST", `/api/projects/${id}/assist/board`, { board: big })).status).toBe(413);
    const t = performance.now();
    const r = await s.json("POST", `/api/projects/${id}/assist/board`, { board: { version: 1, frames: [], connectors: [], items: items(3000) } });
    expect(r.status).toBe(200);
    expect(r.body.ghosts).toHaveLength(12);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("a hostile expression is a diagnostic; the preview answers 400, never 500", async () => {
    const app = createApp(openDatabase(":memory:"), { devLogin: true });
    const { s, id } = await project(app);
    const deep = `${"(".repeat(200_000)}status == pending${")".repeat(200_000)}`;
    const yaml = SAMPLE.replace("expression: status == pending\n", `expression: "${deep}"\n`);
    const saved = await s.json("PUT", `/api/projects/${id}/model`, { yaml, base_version: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.ok).toBe(false);
    expect((await s.call("GET", `/api/projects/${id}/preview`)).status).toBe(400);
    // A later valid version previews, comparing against version 1 (the broken one is skipped).
    await s.json("PUT", `/api/projects/${id}/model`, { yaml: `${SAMPLE}\n# v3\n`, base_version: 2 });
    const p = await s.json("GET", `/api/projects/${id}/preview`);
    expect(p.status).toBe(200);
    expect(p.body.base_version).toBe(1);
    // Cached: the second preview does not generate again and returns the same plan.
    const again = await s.json("GET", `/api/projects/${id}/preview`);
    expect(again.body.plan).toEqual(p.body.plan);
    expect((await s.call("GET", `/api/projects/${id}/preview?version=abc`)).status).toBe(400);
  });

  test("zip entry names cannot escape the extraction directory", () => {
    for (const ok of ["src/app/__init__.py", "tests/test_x.py", ".ddd/manifest.json", "model.ddd.yaml"]) expect(zipEntryName(ok)).toBe(ok);
    for (const bad of ["/etc/passwd", "C:/x", "C:\\x", "../x", "a/../../x", "a//b", "", "~/x", "a\u0000b", "./a"]) expect(zipEntryName(bad)).toBeUndefined();
  });
});

describe("AI gate, rate limits and queue", () => {
  class Fake implements ModelAssistant {
    readonly model = "fake";
    calls = 0;
    error?: Error;
    async inline() {
      this.calls++;
      if (this.error) throw this.error;
      return "";
    }
    async propose() {
      this.calls++;
      if (this.error) throw this.error;
      return undefined;
    }
    async board() {
      this.calls++;
      return [];
    }
  }

  async function setup(options: AppOptions, users = ["first", "second"]) {
    const db = openDatabase(":memory:");
    const fake = new Fake();
    const app = createApp(db, { assistant: fake, devLogin: true, ...options });
    const sessions = [];
    for (const u of users) {
      const s = await devLogin(app, u);
      const ws = (await s.json("GET", "/api/me")).body.workspaces[0].id as string;
      const project = (await s.json("POST", `/api/workspaces/${ws}/projects`, { name: "P" })).body.id as string;
      sessions.push({ ...s, ws, project });
    }
    return { db, fake, app, sessions };
  }

  test("on loopback the first user may enable AI, others may not", async () => {
    const { sessions } = await setup({ loopback: true });
    const [first, second] = sessions;
    expect((await first!.json("GET", `/api/workspaces/${first!.ws}`)).body.ai_can_enable).toBe(true);
    expect((await second!.json("GET", `/api/workspaces/${second!.ws}`)).body.ai_can_enable).toBe(false);
    expect((await second!.json("PATCH", `/api/workspaces/${second!.ws}/settings`, { ai_enabled: true })).status).toBe(403);
    expect((await first!.json("PATCH", `/api/workspaces/${first!.ws}/settings`, { ai_enabled: true })).status).toBe(200);
  });

  test("on a network address nobody may enable AI unless listed", async () => {
    const { sessions } = await setup({ loopback: false });
    expect((await sessions[0]!.json("PATCH", `/api/workspaces/${sessions[0]!.ws}/settings`, { ai_enabled: true })).status).toBe(403);
    const listed = await setup({ loopback: false, aiAdmins: ["second"] });
    expect((await listed.sessions[0]!.json("PATCH", `/api/workspaces/${listed.sessions[0]!.ws}/settings`, { ai_enabled: true })).status).toBe(403);
    expect((await listed.sessions[1]!.json("PATCH", `/api/workspaces/${listed.sessions[1]!.ws}/settings`, { ai_enabled: true })).status).toBe(200);
    const all = await setup({ loopback: false, aiWorkspaces: "*" });
    expect((await all.sessions[0]!.json("PATCH", `/api/workspaces/${all.sessions[0]!.ws}/settings`, { ai_enabled: true })).status).toBe(200);
  });

  test("adding an admin as a member does not launder permission; AI stops when the enabler is no longer an admin", async () => {
    const { db, fake, sessions } = await setup({ loopback: false, aiAdmins: ["admin"] }, ["mallory", "admin"]);
    const [mallory, admin] = sessions;
    await mallory!.json("POST", `/api/workspaces/${mallory!.ws}/members`, { username: "admin", role: "owner" });
    expect((await mallory!.json("PATCH", `/api/workspaces/${mallory!.ws}/settings`, { ai_enabled: true })).status).toBe(403);
    expect((await admin!.json("PATCH", `/api/workspaces/${admin!.ws}/settings`, { ai_enabled: true })).status).toBe(200);
    expect((await admin!.json("GET", `/api/projects/${admin!.project}/assist`)).body.active).toBe(true);
    // Same database, server restarted without "admin" in DDD_AI_ADMINS.
    const restarted = createApp(db, { assistant: fake, devLogin: true, aiAdmins: [] });
    const again = client(restarted, admin!.cookie);
    expect((await again.json("GET", `/api/projects/${admin!.project}/assist`)).body.active).toBe(false);
    expect((await again.json("POST", `/api/projects/${admin!.project}/assist/inline`, { yaml: SAMPLE, offset: 1 })).status).toBe(403);
  });

  test("per-user rate limit, input caps and a full queue answer 429 / 413", async () => {
    const { fake, sessions } = await setup({ loopback: true, aiRate: { perMinute: 1, burst: 2 } }, ["first"]);
    const s = sessions[0]!;
    await s.json("PATCH", `/api/workspaces/${s.ws}/settings`, { ai_enabled: true });
    const inline = () => s.json("POST", `/api/projects/${s.project}/assist/inline`, { yaml: SAMPLE, offset: 1 });
    expect((await inline()).status).toBe(200);
    expect((await inline()).status).toBe(200);
    const limited = await inline();
    expect(limited.status).toBe(429);
    expect(limited.body.retry_after).toBeGreaterThan(0);
    expect(fake.calls).toBe(2);

    const { fake: f2, sessions: s2 } = await setup({ loopback: true }, ["first"]);
    const t = s2[0]!;
    await t.json("PATCH", `/api/workspaces/${t.ws}/settings`, { ai_enabled: true });
    const propose = (extra: Record<string, unknown>) => t.json("POST", `/api/projects/${t.project}/assist/propose`, { yaml: SAMPLE, context: "CleaningStaff", kind: "custom", ...extra });
    expect((await propose({ instruction: "x".repeat(2001) })).status).toBe(413);
    expect((await propose({ context: "x".repeat(201) })).status).toBe(413);
    expect((await t.json("POST", `/api/projects/${t.project}/assist/board`, { board: { version: 1, items: [], frames: [], connectors: [] }, llm: true, instruction: "x".repeat(501) })).status).toBe(413);
    f2.error = new AiBusyError();
    expect((await propose({ instruction: "ok" })).status).toBe(429);
    expect((await t.json("POST", `/api/projects/${t.project}/assist/inline`, { yaml: SAMPLE, offset: 1 })).status).toBe(429);
  });

  test("the CLI queue is bounded", async () => {
    const run = limiter(1, 1);
    let release!: () => void;
    const first = run(() => new Promise<void>((r) => (release = r)));
    const second = run(async () => "queued");
    await expect(run(async () => "third")).rejects.toBeInstanceOf(AiBusyError);
    release();
    await first;
    expect(await second).toBe("queued");
  });

  test("CLIs get a minimal environment; Codex does not load the user's config", async () => {
    const env = cliEnv("claude", { PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "k", DDD_DB: "/secret.sqlite", AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", DDD_AI_PASS_ENV: "MY_PROXY_TOKEN", MY_PROXY_TOKEN: "p" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "k", MY_PROXY_TOKEN: "p", NO_COLOR: "1" });
    expect(env.DDD_DB).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(cliEnv("codex", { OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "k" })).toEqual({ OPENAI_API_KEY: "o", NO_COLOR: "1" });

    const seen: { cmd: string[]; env?: Record<string, string> }[] = [];
    const run: Runner = async (cmd, opts) => {
      seen.push({ cmd, env: opts.env });
      return { code: 0, stdout: "", stderr: "" };
    };
    await codexCompleter({ run, cwd: "/tmp", env: { PATH: "/bin" } }).complete({ purpose: "inline", messages: [{ role: "user", content: "x" }], effort: "low", maxTokens: 10 });
    expect(seen[0]!.cmd).toContain("--ignore-user-config");
    expect(seen[0]!.cmd).toContain("--ignore-rules");
    expect(seen[0]!.env).toEqual({ PATH: "/bin" });
    await codexCompleter({ run, cwd: "/tmp", userConfig: true }).complete({ purpose: "inline", messages: [{ role: "user", content: "x" }], effort: "low", maxTokens: 10 });
    expect(seen[1]!.cmd).not.toContain("--ignore-user-config");
  });

  test("token bucket refills over time", () => {
    let t = 0;
    const b = new TokenBucket(60, 1, () => t);
    expect(b.take("u").ok).toBe(true);
    expect(b.take("u").ok).toBe(false);
    t += 1000;
    expect(b.take("u").ok).toBe(true);
    expect(b.take("other").ok).toBe(true);
  });
});

describe("admin command", () => {
  test("set-password creates or resets an account; logout-all ends its sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-admin-"));
    try {
      const file = join(dir, "db.sqlite");
      expect((await runAdmin(["set-password", "root"], async () => "short", file)).code).toBe(1);
      expect(await runAdmin(["set-password", "root"], async () => "root password\n", file)).toEqual({ code: 0, message: "created root with a password" });
      const db = openDatabase(file);
      const app = createApp(db, { registration: "closed" });
      const s = client(app, cookieOf(await post(app, "/api/login", { username: "root", password: "root password" })));
      expect((await s.json("GET", "/api/me")).body.workspaces).toHaveLength(1);
      expect((await runAdmin(["logout-all", "root"], async () => "", file)).code).toBe(0);
      expect((await s.call("GET", "/api/me")).status).toBe(401);
      expect((await runAdmin(["set-password", "root"], async () => "new password", file)).code).toBe(0);
      expect((await post(app, "/api/login", { username: "root", password: "new password" })).status).toBe(200);
      expect((await runAdmin(["frobnicate", "root"], async () => "", file)).code).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server configuration", () => {
  test("binds to loopback by default with dev login on auto", () => {
    const c = configFromEnv({});
    expect(c).toMatchObject({ host: "127.0.0.1", loopback: true, port: 4870, warnings: [] });
    expect(c.app).toMatchObject({ devLogin: "auto", loopback: true, registration: "open", allowedHosts: [], aiAdmins: undefined, aiRate: { perMinute: 30, burst: 10 } });
  });

  test("a network address is announced with warnings and allowed as a host name", () => {
    const c = configFromEnv({ DDD_HOST: "192.168.1.5", DDD_DEV_LOGIN: "1", DDD_ALLOWED_HOSTS: "ddd.example.com", DDD_AI_ADMINS: "alice, bob", DDD_AI_WORKSPACES: "*", DDD_TRUSTED_USER_HEADER: "X-Forwarded-User", DDD_REGISTRATION: "closed" });
    expect(c.loopback).toBe(false);
    expect(c.app).toMatchObject({ devLogin: true, allowedHosts: ["ddd.example.com", "192.168.1.5"], aiAdmins: ["alice", "bob"], aiWorkspaces: "*", trustedUserHeader: "X-Forwarded-User", registration: "closed" });
    expect(c.warnings.join("\n")).toContain("192.168.1.5");
    expect(c.warnings.join("\n")).toContain("DDD_DEV_LOGIN=1");
    expect(configFromEnv({ HOST: "0.0.0.0" }).app.allowedHosts).toEqual([]);
    // Loopback behind a reverse proxy on the same machine is not "local only".
    expect(configFromEnv({ DDD_ALLOWED_HOSTS: "ddd.example.com" }).app.loopback).toBe(false);
    expect(configFromEnv({ DDD_TRUSTED_USER_HEADER: "X-Forwarded-User" }).app.loopback).toBe(false);
    expect(configFromEnv({ DDD_ALLOWED_HOSTS: "localhost" }).app.loopback).toBe(true);
  });

  test("host helpers", () => {
    expect(hostnameOf("LOCALHOST:4870")).toBe("localhost");
    expect(hostnameOf("[::1]:4870")).toBe("[::1]");
    expect(["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "::", "192.168.1.5", "example.com"].some(isLoopback)).toBe(false);
  });
});
