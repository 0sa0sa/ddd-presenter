import type { Database } from "bun:sqlite";
import { boardGhosts, emptyBoard, normalizeBoard, proposeLocally, ruleUsage, STICKY_KINDS, validateModelText, type Board, type BoardGhost, type ProposalKind, type StickyKind, type ValidateResult } from "@ddd/core";
import { AiBusyError, PROVIDER_LABEL, type ModelAssistant, type ProviderId } from "./ai.ts";
import { fitToCursor } from "./fit.ts";
import { computePlan, generatePython, renderManifest, unifiedDiff, type GenerationOutput } from "@ddd/generator";
import { strToU8, zipSync } from "fflate";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { newId, now, ROLE_RANK, type Role } from "./db.ts";
import { FailureThrottle, hostnameOf, LOOPBACK_HOSTNAMES, TokenBucket, withSecurityHeaders } from "./security.ts";
import { emptyModel, sampleModel } from "./templates.ts";

type User = { id: string; username: string };
type Env = { Variables: { user: User } };

const SESSION_COOKIE = "ddd_session";
const SESSION_DAYS = 14;
const MAX_MODEL_BYTES = 1_000_000;
/** Request body caps (bytes), checked before JSON is parsed. Bun.serve's maxRequestBodySize (4 MB) is the outer bound. */
const BODY_SMALL = 64_000;
const BODY_MODEL = MAX_MODEL_BYTES + 256_000; // the model plus JSON escaping and the other fields
const BODY_BOARD = 2_000_000;
const BODY_LAYOUT = 1_000_000;
const MAX_LAYOUT_KEYS = 5000;
const MAX_BOARD_ITEMS = 3000;
const MAX_BOARD_FRAMES = 1000;
const MAX_BOARD_CONNECTORS = 10_000;
const USERNAME = /^[A-Za-z0-9_.-]+$/;
/** Names from an authenticating proxy may be e-mail addresses. */
const PROXY_USERNAME = /^[A-Za-z0-9_.@+-]{1,100}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
/** Generated previews kept in memory (versions never change, so entries never go stale). */
const GENERATION_CACHE = 64;

export interface AppOptions {
  /** Set the Secure flag on cookies (production over HTTPS). */
  secureCookies?: boolean;
  /** LLM used for assistance when a workspace enables AI; undefined = local suggestions only. */
  assistant?: ModelAssistant;
  /** Assistants the workspace owner can choose from (Claude API, local Claude Code / Codex CLIs). */
  assistants?: Partial<Record<ProviderId, ModelAssistant>>;
  /**
   * Username-only sign-in for local development. `true` = always on, `false` (default) = off,
   * `"auto"` = on while the server is bound to loopback, no proxy header is trusted and no account has a password yet.
   */
  devLogin?: boolean | "auto";
  /** The server listens on a loopback address only (affects the `"auto"` dev login and the default AI admin). */
  loopback?: boolean;
  /** Trust this request header (set by an authenticating reverse proxy, e.g. X-Forwarded-User) as the user name. */
  trustedUserHeader?: string;
  /** Self-service registration with a password (default "open"). */
  registration?: "open" | "closed";
  /** Host names accepted besides localhost / 127.0.0.1 / [::1]; "*" accepts any host (no DNS-rebinding protection). */
  allowedHosts?: string[] | "*";
  /** Usernames allowed to turn AI on. Default: the first user when `loopback`, nobody otherwise. */
  aiAdmins?: string[];
  /** Workspace ids whose owners may turn AI on regardless of `aiAdmins`; "*" = every workspace. */
  aiWorkspaces?: string[] | "*";
  /** Per-user rate limit for AI calls (default 30 per minute, bursts of 10). */
  aiRate?: { perMinute: number; burst: number };
}

/** Deletes expired sessions; returns how many were removed. main.ts runs it periodically, login runs it too. */
export function purgeExpiredSessions(db: Database): number {
  return db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now()).changes;
}

export function createApp(db: Database, options: AppOptions = {}) {
  const app = new Hono<Env>();
  const assistants: Partial<Record<ProviderId, ModelAssistant>> = options.assistants ?? (options.assistant ? { api: options.assistant } : {});
  const providerIds = Object.keys(assistants) as ProviderId[];
  const providers = providerIds.map((id) => ({ id, label: PROVIDER_LABEL[id], model: assistants[id]!.model }));
  /** The provider a workspace uses: its choice if the server still offers it, else the first one. */
  const providerOf = (choice: string | null): ProviderId | undefined => (choice && choice in assistants ? (choice as ProviderId) : providerIds[0]);

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  const fail = (status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 421 | 429, message: string, extra: Record<string, unknown> = {}): never => {
    throw new HTTPException(status, { res: Response.json({ error: message, ...extra }, { status }) });
  };

  const audit = (workspaceId: string, actor: string | null, action: string, target: string, detail: Record<string, unknown> = {}) => {
    db.query("INSERT INTO audit_log (workspace_id, actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(
      workspaceId,
      actor,
      action,
      target,
      JSON.stringify(detail),
      now(),
    );
  };

  /** Membership check. Non-members get 404 so other tenants' ids cannot be probed. */
  const roleIn = (workspaceId: string, userId: string): Role => {
    const row = db.query("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { role: Role } | null;
    if (!row) fail(404, "Not found");
    return row!.role;
  };

  const requireRole = (have: Role, need: Role) => {
    if (ROLE_RANK[have] < ROLE_RANK[need]) fail(403, `This action requires the ${need} role`);
  };

  type ProjectRow = { id: string; workspace_id: string; name: string; description: string; created_at: string };
  const loadProject = (c: Context<Env>, need: Role = "viewer") => {
    const row = db.query("SELECT * FROM projects WHERE id = ?").get(c.req.param("projectId")!) as ProjectRow | null;
    if (!row) fail(404, "Not found");
    const role = roleIn(row!.workspace_id, c.get("user").id);
    requireRole(role, need);
    return { project: row!, role };
  };

  const latestVersion = (projectId: string) =>
    db.query("SELECT version, yaml, message, author_id, created_at FROM model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1").get(projectId) as {
      version: number;
      yaml: string;
      message: string;
      author_id: string | null;
      created_at: string;
    } | null;

  const versionYaml = (projectId: string, version: number) => {
    const row = db.query("SELECT yaml FROM model_versions WHERE project_id = ? AND version = ?").get(projectId, version) as { yaml: string } | null;
    if (!row) fail(404, `Version ${version} not found`);
    return row!.yaml;
  };

  const insertVersion = (projectId: string, version: number, yaml: string, message: string, authorId: string) => {
    db.query("INSERT INTO model_versions (project_id, version, yaml, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      projectId,
      version,
      yaml,
      message,
      authorId,
      now(),
    );
  };

  /** Reads a JSON object body of at most `max` bytes; the size is checked before anything is parsed. */
  const body = async <T>(c: Context<Env>, max = BODY_SMALL): Promise<T> => {
    const tooLarge = () => fail(413, `The request body is larger than ${max >= 1_000_000 ? `${Math.round(max / 100_000) / 10} MB` : `${Math.round(max / 1000)} KB`}`);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > max) tooLarge();
    const raw = await c.req.text();
    if (raw.length > max || Buffer.byteLength(raw) > max) tooLarge();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail(400, "Request body must be JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(400, "Request body must be a JSON object");
    return parsed as T;
  };

  /** Validation that never throws: a crash in the validator becomes an error diagnostic. */
  const validate = (yaml: string): ValidateResult => {
    try {
      return validateModelText(yaml);
    } catch (e) {
      console.error("validation crashed:", (e as Error).message);
      return { ok: false, diagnostics: [{ severity: "error", code: "invalid-model", message: "The model could not be validated (it may be too large or too deeply nested)", path: [] }] };
    }
  };

  const str = (v: unknown, name: string, max = 200): string => {
    if (typeof v !== "string" || !v.trim()) fail(400, `${name} is required`);
    if ((v as string).length > max) fail(400, `${name} is too long`);
    return (v as string).trim();
  };

  const checkModelSize = (yaml: string) => {
    if (new TextEncoder().encode(yaml).length > MAX_MODEL_BYTES) fail(413, "The model is larger than 1 MB; split it into several bounded contexts or projects");
  };

  const createWorkspace = (name: string, ownerId: string) => {
    const id = newId();
    db.transaction(() => {
      db.query("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
      db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(id, ownerId);
      audit(id, ownerId, "workspace.create", id, { name });
    })();
    return id;
  };

  // ---------------------------------------------------------------------------
  // error handling
  // ---------------------------------------------------------------------------

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // Security headers on every response (API, static files, errors).
  app.use("*", async (c, next) => {
    await next();
    c.res = withSecurityHeaders(c.res);
  });

  // DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1 sends `Host: evil.example`.
  // Only the names this server is meant to be reached by are answered.
  const allowedHosts = options.allowedHosts === "*" ? undefined : new Set<string>([...LOOPBACK_HOSTNAMES, ...(options.allowedHosts ?? []).map((h) => hostnameOf(h))]);
  const requestHost = (c: Context<Env>) => c.req.header("host") ?? new URL(c.req.url).host;
  app.use("*", async (c, next) => {
    if (allowedHosts && !allowedHosts.has(hostnameOf(requestHost(c)))) {
      return c.json({ error: "This host name is not allowed; add it to DDD_ALLOWED_HOSTS" }, 421);
    }
    await next();
  });

  // Mutating requests must come from our own origin (CSRF defense in addition to SameSite cookies),
  // carry JSON (HTML forms cannot send application/json), and name their origin when they carry credentials.
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  app.use("/api/*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        let originHost: string | undefined;
        try {
          originHost = new URL(origin).host.toLowerCase(); // "null" (sandboxed frames, file://) does not parse
        } catch {
          originHost = undefined;
        }
        if (!originHost || originHost !== requestHost(c).toLowerCase()) fail(403, "Cross-origin request rejected");
      } else if (getCookie(c, SESSION_COOKIE) || (options.trustedUserHeader && c.req.header(options.trustedUserHeader) !== undefined)) {
        // Browsers always send Origin on these requests; credentials without it are not from our pages.
        fail(403, "Origin header required");
      }
      const type = c.req.header("content-type");
      const length = c.req.header("content-length");
      const hasBody = c.req.raw.body !== null && length !== "0";
      if (type ? !/^application\/json\s*(;|$)/i.test(type) : hasBody) fail(415, "Content-Type must be application/json");
    }
    await next();
  });

  // ---------------------------------------------------------------------------
  // auth: password accounts, optional dev login and trusted proxy header (docs/09 §11)
  // ---------------------------------------------------------------------------

  const throttle = new FailureThrottle();
  const passwordAccounts = () => (db.query("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL").get() as { n: number }).n;
  /** A request relayed by a reverse proxy is not "local", even when the server listens on loopback. */
  const viaProxy = (c: Context<Env>) => ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"].some((h) => c.req.header(h) !== undefined);
  const devLoginActive = (c: Context<Env>) => options.devLogin === true || (options.devLogin === "auto" && !!options.loopback && !viaProxy(c) && !options.trustedUserHeader && passwordAccounts() === 0);
  let dummyHash: Promise<string> | undefined;
  /** Verifying against a fixed hash when there is no account keeps the response time the same. */
  const verifyPassword = async (password: string, hash: string | null | undefined) => {
    dummyHash ??= Bun.password.hash("not-a-password-of-anyone");
    const ok = await Bun.password.verify(password, hash ?? (await dummyHash));
    return ok && !!hash;
  };

  const usernameOf = (v: unknown): string => {
    const name = str(v, "username", 40);
    if (!USERNAME.test(name)) fail(400, "username may contain letters, digits, '.', '-' and '_'");
    return name;
  };
  const newPassword = (v: unknown, name: string): string => {
    if (typeof v !== "string" || v.length < PASSWORD_MIN) fail(400, `${name} must be at least ${PASSWORD_MIN} characters`);
    if ((v as string).length > PASSWORD_MAX) fail(400, `${name} is too long`);
    return v as string;
  };

  const createUser = (name: string, passwordHash: string | null): User => {
    const user = { id: newId(), username: name };
    db.transaction(() => {
      db.query("INSERT INTO users (id, username, created_at, password_hash) VALUES (?, ?, ?, ?)").run(user.id, name, now(), passwordHash);
      createWorkspace(`${name}'s workspace`, user.id);
    })();
    return user;
  };

  const startSession = (c: Context<Env>, user: User) => {
    purgeExpiredSessions(db);
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.query("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, user.id, now(), expires.toISOString());
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", secure: !!options.secureCookies, expires });
    return token;
  };

  // Lets the Web client verify it is talking to a DDD Presenter server (not another app on the same port).
  app.get("/api/health", (c) => c.json({ service: "ddd-presenter", ok: true }));

  /** What the sign-in page offers. The user list exists only in dev-login mode (it is what that mode signs in with). */
  app.get("/api/auth/config", (c) => {
    const dev = devLoginActive(c);
    const users = dev ? (db.query("SELECT username FROM users WHERE password_hash IS NULL ORDER BY username LIMIT 100").all() as { username: string }[]).map((u) => u.username) : undefined;
    return c.json({ dev_login: dev, registration: options.registration !== "closed", proxy_auth: !!options.trustedUserHeader, users });
  });

  app.post("/api/login", async (c) => {
    const b = await body<{ username?: unknown; password?: unknown }>(c);
    const name = usernameOf(b.username);
    const row = db.query("SELECT id, username, password_hash FROM users WHERE username = ?").get(name) as (User & { password_hash: string | null }) | null;
    if (typeof b.password === "string" && b.password !== "") {
      if (throttle.blocked(name)) fail(429, "Too many failed sign-ins; try again in 15 minutes");
      const ok = b.password.length <= PASSWORD_MAX && (await verifyPassword(b.password, row?.password_hash));
      if (!ok || !row) {
        throttle.fail(name);
        fail(401, "Invalid username or password");
      }
      throttle.reset(name);
      const user = { id: row!.id, username: row!.username };
      startSession(c, user);
      return c.json({ user });
    }
    if (!devLoginActive(c)) fail(400, "password is required");
    if (row?.password_hash) fail(401, "This account has a password; sign in with it");
    const user = row ? { id: row.id, username: row.username } : createUser(name, null);
    startSession(c, user);
    return c.json({ user });
  });

  app.post("/api/register", async (c) => {
    if (options.registration === "closed") fail(403, "Registration is closed; ask the administrator for an account");
    const b = await body<{ username?: unknown; password?: unknown }>(c);
    const name = usernameOf(b.username);
    const password = newPassword(b.password, "password");
    if (db.query("SELECT 1 FROM users WHERE username = ?").get(name)) fail(409, "That username is taken");
    const hash = await Bun.password.hash(password);
    let user: User;
    try {
      user = createUser(name, hash);
    } catch {
      return fail(409, "That username is taken"); // registered by someone else while hashing
    }
    startSession(c, user);
    return c.json({ user }, 201);
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) db.query("DELETE FROM sessions WHERE token = ?").run(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const userByName = (name: string) => db.query("SELECT id, username FROM users WHERE username = ?").get(name) as User | null;

  app.use("/api/*", async (c, next) => {
    let user: User | null = null;
    const proxyUser = options.trustedUserHeader ? c.req.header(options.trustedUserHeader) : undefined;
    if (proxyUser !== undefined) {
      // Only reachable when the operator configured DDD_TRUSTED_USER_HEADER; the proxy must strip it from clients.
      const name = proxyUser.trim();
      if (!PROXY_USERNAME.test(name)) fail(401, "The authenticating proxy sent an invalid user name");
      try {
        user = userByName(name) ?? createUser(name, null);
      } catch {
        user = userByName(name); // created by a concurrent request
      }
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      user = token ? (db.query("SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?").get(token, now()) as User | null) : null;
    }
    if (!user) fail(401, "Not logged in");
    c.set("user", user!);
    await next();
  });

  /** Ends every session of the signed-in user (all browsers and devices). */
  app.post("/api/logout-all", (c) => {
    const n = db.query("DELETE FROM sessions WHERE user_id = ?").run(c.get("user").id).changes;
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true, sessions: n });
  });

  /** Sets or changes the password. Accounts without one (dev login / proxy users) set it without the current one. */
  app.post("/api/account/password", async (c) => {
    const user = c.get("user");
    const b = await body<{ current_password?: unknown; new_password?: unknown }>(c);
    const password = newPassword(b.new_password, "new_password");
    const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string | null };
    if (row.password_hash) {
      if (throttle.blocked(user.username)) fail(429, "Too many failed attempts; try again in 15 minutes");
      const current = b.current_password;
      if (typeof current !== "string" || current.length > PASSWORD_MAX || !(await verifyPassword(current, row.password_hash))) {
        throttle.fail(user.username);
        fail(403, "The current password is incorrect");
      }
    }
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(await Bun.password.hash(password), user.id);
    // Other sessions (possibly opened with the old password) end; this one stays.
    db.query("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(user.id, getCookie(c, SESSION_COOKIE) ?? "");
    return c.json({ ok: true });
  });

  /** Usernames for adding members: everyone in dev-login mode, otherwise people who share a workspace with you. */
  app.get("/api/users", (c) => {
    const users = devLoginActive(c)
      ? db.query("SELECT username FROM users ORDER BY username LIMIT 500").all()
      : db
          .query("SELECT DISTINCT u.username FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id = ?) ORDER BY u.username LIMIT 500")
          .all(c.get("user").id);
    return c.json({ users });
  });

  // Stateless validation: same core function as the CLI (FR-030 / FR-034 parity).
  app.post("/api/validate", async (c) => {
    const { yaml } = await body<{ yaml?: string }>(c, BODY_MODEL);
    if (typeof yaml !== "string") fail(400, "yaml is required");
    checkModelSize(yaml!);
    const r = validate(yaml!);
    return c.json({ ok: r.ok, diagnostics: r.diagnostics, rules: r.analysis ? ruleUsage(r.analysis) : [] });
  });

  app.get("/api/me", (c) => {
    const user = c.get("user");
    const workspaces = db
      .query("SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at")
      .all(user.id);
    const { password_hash } = db.query("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string | null };
    return c.json({ user: { ...user, has_password: !!password_hash }, workspaces, proxy_auth: !!options.trustedUserHeader });
  });

  // ---------------------------------------------------------------------------
  // workspaces & members
  // ---------------------------------------------------------------------------

  app.post("/api/workspaces", async (c) => {
    const { name } = await body<{ name?: string }>(c);
    const id = createWorkspace(str(name, "name", 80), c.get("user").id);
    return c.json({ id }, 201);
  });

  // -- who may spend the server's AI (API key / CLI subscription) ------------------
  // AI is active in a workspace only while it was turned on by someone the operator allows (or the workspace is
  // listed). Membership alone never grants it: owners can add anyone as a member without their consent.
  const aiGateConfigured = options.aiAdmins !== undefined || options.aiWorkspaces !== undefined;
  const firstUserId = () => (db.query("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | null)?.id;
  /** `local` = the request did not come through a reverse proxy (the loopback default applies only then). */
  const isAiAdmin = (userId: string | null | undefined, local = true): boolean => {
    if (!userId) return false;
    if (options.aiAdmins) {
      const row = db.query("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | null;
      return !!row && options.aiAdmins.includes(row.username);
    }
    return !aiGateConfigured && !!options.loopback && local && firstUserId() === userId;
  };
  const aiWorkspaceListed = (wsId: string) => options.aiWorkspaces === "*" || (Array.isArray(options.aiWorkspaces) && options.aiWorkspaces.includes(wsId));
  const mayEnableAi = (wsId: string, userId: string, c: Context<Env>) => aiWorkspaceListed(wsId) || isAiAdmin(userId, !viaProxy(c));
  const aiBucket = new TokenBucket(options.aiRate?.perMinute ?? 30, options.aiRate?.burst ?? 10);
  /** One AI call for the signed-in user; 429 when their budget is spent. */
  const spendAi = (c: Context<Env>) => {
    const r = aiBucket.take(c.get("user").id);
    if (!r.ok) {
      c.header("retry-after", String(r.retryAfter));
      fail(429, "Too many AI requests; wait a moment and try again", { retry_after: r.retryAfter });
    }
  };

  app.get("/api/workspaces/:wsId", (c) => {
    const wsId = c.req.param("wsId");
    const role = roleIn(wsId, c.get("user").id);
    const { ai_provider, ai_enabled_by, ...ws } = db.query("SELECT id, name, created_at, ai_enabled, ai_provider, ai_enabled_by FROM workspaces WHERE id = ?").get(wsId) as {
      ai_enabled: number;
      ai_provider: string | null;
      ai_enabled_by: string | null;
    } & Record<string, unknown>;
    const provider = providerOf(ai_provider);
    return c.json({
      workspace: { ...ws, ai_enabled: !!ws.ai_enabled, ai_provider: provider ?? null },
      role,
      ai_available: providerIds.length > 0,
      ai_model: provider ? assistants[provider]!.model : null,
      ai_providers: providers,
      ai_can_enable: providerIds.length > 0 && mayEnableAi(wsId, c.get("user").id, c),
      ai_active: !!aiFor(wsId),
    });
  });

  app.patch("/api/workspaces/:wsId/settings", async (c) => {
    const wsId = c.req.param("wsId");
    const actor = c.get("user");
    requireRole(roleIn(wsId, actor.id), "owner");
    const { ai_enabled, ai_provider } = await body<{ ai_enabled?: boolean; ai_provider?: string }>(c);
    if (ai_enabled === undefined && ai_provider === undefined) fail(400, "ai_enabled or ai_provider is required");
    if (ai_enabled !== undefined && typeof ai_enabled !== "boolean") fail(400, "ai_enabled must be true or false");
    if (ai_provider !== undefined && !(ai_provider in assistants)) fail(400, `ai_provider must be one of: ${providerIds.join(", ") || "(none configured)"}`);
    if (ai_enabled === true && !mayEnableAi(wsId, actor.id, c)) fail(403, "Only users the server operator allows (DDD_AI_ADMINS) can turn AI on");
    if (ai_provider !== undefined) {
      db.query("UPDATE workspaces SET ai_provider = ? WHERE id = ?").run(ai_provider, wsId);
      audit(wsId, actor.id, "ai.provider", wsId, { provider: ai_provider });
    }
    if (ai_enabled !== undefined) {
      db.query("UPDATE workspaces SET ai_enabled = ?, ai_enabled_by = ? WHERE id = ?").run(ai_enabled ? 1 : 0, ai_enabled ? actor.id : null, wsId);
      audit(wsId, actor.id, ai_enabled ? "ai.enable" : "ai.disable", wsId);
    }
    const row = db.query("SELECT ai_enabled, ai_provider FROM workspaces WHERE id = ?").get(wsId) as { ai_enabled: number; ai_provider: string | null };
    const provider = providerOf(row.ai_provider);
    return c.json({ ok: true, ai_enabled: !!row.ai_enabled, ai_provider: provider ?? null, ai_model: provider ? assistants[provider]!.model : null });
  });

  app.get("/api/workspaces/:wsId/members", (c) => {
    const wsId = c.req.param("wsId");
    roleIn(wsId, c.get("user").id);
    const members = db
      .query("SELECT u.id, u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.username")
      .all(wsId);
    return c.json({ members });
  });

  const parseRole = (r: unknown): Role => {
    if (r !== "owner" && r !== "editor" && r !== "viewer") fail(400, "role must be owner, editor or viewer");
    return r as Role;
  };

  const ownerCount = (wsId: string) => (db.query("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'").get(wsId) as { n: number }).n;

  app.post("/api/workspaces/:wsId/members", async (c) => {
    const wsId = c.req.param("wsId");
    const actor = c.get("user");
    requireRole(roleIn(wsId, actor.id), "owner");
    const { username, role } = await body<{ username?: string; role?: string }>(c);
    const r = parseRole(role);
    const user = db.query("SELECT id, username FROM users WHERE username = ?").get(str(username, "username", 100)) as User | null;
    if (!user) fail(404, "No such user; they must log in once first");
    const exists = db.query("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?").get(wsId, user!.id);
    if (exists) fail(409, `${user!.username} is already a member`);
    db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)").run(wsId, user!.id, r);
    audit(wsId, actor.id, "member.add", user!.username, { role: r });
    return c.json({ ok: true }, 201);
  });

  app.patch("/api/workspaces/:wsId/members/:userId", async (c) => {
    const wsId = c.req.param("wsId");
    const actor = c.get("user");
    requireRole(roleIn(wsId, actor.id), "owner");
    const { role } = await body<{ role?: string }>(c);
    const r = parseRole(role);
    const target = db
      .query("SELECT u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?")
      .get(wsId, c.req.param("userId")) as { username: string; role: Role } | null;
    if (!target) fail(404, "Not a member");
    if (target!.role === "owner" && r !== "owner" && ownerCount(wsId) === 1) fail(409, "A workspace needs at least one owner");
    db.query("UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?").run(r, wsId, c.req.param("userId"));
    audit(wsId, actor.id, "member.role", target!.username, { from: target!.role, to: r });
    return c.json({ ok: true });
  });

  app.delete("/api/workspaces/:wsId/members/:userId", (c) => {
    const wsId = c.req.param("wsId");
    const actor = c.get("user");
    requireRole(roleIn(wsId, actor.id), "owner");
    const target = db
      .query("SELECT u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?")
      .get(wsId, c.req.param("userId")) as { username: string; role: Role } | null;
    if (!target) fail(404, "Not a member");
    if (target!.role === "owner" && ownerCount(wsId) === 1) fail(409, "A workspace needs at least one owner");
    db.query("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").run(wsId, c.req.param("userId"));
    audit(wsId, actor.id, "member.remove", target!.username, { role: target!.role });
    return c.json({ ok: true });
  });

  app.get("/api/workspaces/:wsId/audit", (c) => {
    const wsId = c.req.param("wsId");
    requireRole(roleIn(wsId, c.get("user").id), "owner");
    const entries = db
      .query(
        "SELECT a.id, a.action, a.target, a.detail, a.at, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 200",
      )
      .all(wsId) as { detail: string }[];
    return c.json({ entries: entries.map((e) => ({ ...e, detail: JSON.parse(e.detail) })) });
  });

  // ---------------------------------------------------------------------------
  // projects
  // ---------------------------------------------------------------------------

  app.get("/api/workspaces/:wsId/projects", (c) => {
    const wsId = c.req.param("wsId");
    roleIn(wsId, c.get("user").id);
    const projects = db
      .query(
        `SELECT p.id, p.name, p.description, p.created_at,
                (SELECT MAX(version) FROM model_versions v WHERE v.project_id = p.id) AS version,
                (SELECT MAX(created_at) FROM model_versions v WHERE v.project_id = p.id) AS updated_at
         FROM projects p WHERE p.workspace_id = ? ORDER BY p.created_at`,
      )
      .all(wsId);
    return c.json({ projects });
  });

  app.post("/api/workspaces/:wsId/projects", async (c) => {
    const wsId = c.req.param("wsId");
    const actor = c.get("user");
    requireRole(roleIn(wsId, actor.id), "editor");
    const b = await body<{ name?: string; description?: string; template?: string; yaml?: string }>(c, BODY_MODEL);
    const name = str(b.name, "name", 80);
    let yaml: string;
    if (typeof b.yaml === "string") {
      checkModelSize(b.yaml);
      yaml = b.yaml;
    } else {
      yaml = b.template === "empty" ? emptyModel(name) : sampleModel();
    }
    const id = newId();
    db.transaction(() => {
      db.query("INSERT INTO projects (id, workspace_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        wsId,
        name,
        typeof b.description === "string" ? b.description.slice(0, 500) : "",
        now(),
      );
      insertVersion(id, 1, yaml, typeof b.yaml === "string" ? "Imported" : "Created", actor.id);
      audit(wsId, actor.id, typeof b.yaml === "string" ? "project.import" : "project.create", name, { project: id });
    })();
    return c.json({ id }, 201);
  });

  app.get("/api/projects/:projectId", (c) => {
    const { project, role } = loadProject(c);
    const latest = latestVersion(project.id);
    return c.json({ project, role, version: latest?.version ?? 0 });
  });

  app.patch("/api/projects/:projectId", async (c) => {
    const { project } = loadProject(c, "editor");
    const b = await body<{ name?: string; description?: string }>(c);
    const name = b.name === undefined ? project.name : str(b.name, "name", 80);
    const description = typeof b.description === "string" ? b.description.slice(0, 500) : project.description;
    db.query("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(name, description, project.id);
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:projectId", (c) => {
    const { project } = loadProject(c, "owner");
    db.query("DELETE FROM projects WHERE id = ?").run(project.id);
    audit(project.workspace_id, c.get("user").id, "project.delete", project.name, { project: project.id });
    return c.json({ ok: true });
  });

  // -- model ------------------------------------------------------------------

  app.get("/api/projects/:projectId/model", (c) => {
    const { project, role } = loadProject(c);
    const latest = latestVersion(project.id)!;
    return c.json({ version: latest.version, yaml: latest.yaml, role });
  });

  /** Optimistic concurrency: the client sends the version it edited; a newer stored version wins and is returned. */
  app.put("/api/projects/:projectId/model", async (c) => {
    const { project } = loadProject(c, "editor");
    const b = await body<{ yaml?: string; base_version?: number; message?: string }>(c, BODY_MODEL);
    if (typeof b.yaml !== "string") fail(400, "yaml is required");
    if (typeof b.base_version !== "number") fail(400, "base_version is required");
    checkModelSize(b.yaml!);
    // Validate before storing: a model the validator cannot handle is refused instead of becoming a version
    // that breaks the preview. Models with ordinary errors are still saved (drafts), with their diagnostics.
    const v = validate(b.yaml!);
    if (v.diagnostics.some((d) => d.code === "invalid-model")) fail(400, "The model could not be validated; it was not saved", { diagnostics: v.diagnostics });
    const actor = c.get("user");
    let result: { version: number } | undefined;
    db.transaction(() => {
      const latest = latestVersion(project.id)!;
      if (latest.version !== b.base_version) {
        fail(409, "The model was changed by someone else", { current_version: latest.version, yaml: latest.yaml });
      }
      if (latest.yaml === b.yaml) {
        result = { version: latest.version };
        return;
      }
      insertVersion(project.id, latest.version + 1, b.yaml!, (b.message ?? "").slice(0, 200), actor.id);
      result = { version: latest.version + 1 };
    })();
    return c.json({ ...result!, ok: v.ok, diagnostics: v.diagnostics });
  });

  app.get("/api/projects/:projectId/versions", (c) => {
    const { project } = loadProject(c);
    const versions = db
      .query(
        "SELECT v.version, v.message, v.created_at, u.username AS author FROM model_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.project_id = ? ORDER BY v.version DESC",
      )
      .all(project.id);
    return c.json({ versions });
  });

  app.get("/api/projects/:projectId/versions/:version", (c) => {
    const { project } = loadProject(c);
    return c.json({ version: Number(c.req.param("version")), yaml: versionYaml(project.id, Number(c.req.param("version"))) });
  });

  app.get("/api/projects/:projectId/diff", (c) => {
    const { project } = loadProject(c);
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to)) fail(400, "from and to must be version numbers");
    return c.json({ diff: unifiedDiff("model.ddd.yaml", versionYaml(project.id, from), versionYaml(project.id, to)) });
  });

  app.get("/api/projects/:projectId/export", (c) => {
    const { project } = loadProject(c);
    const latest = latestVersion(project.id)!;
    audit(project.workspace_id, c.get("user").id, "project.export", project.name, { version: latest.version });
    return new Response(latest.yaml, {
      headers: {
        "content-type": "application/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="${safeFile(project.name)}.ddd.yaml"`,
      },
    });
  });

  // -- generation preview (review only; nothing is written to customer repositories) --

  /** Generated code per stored version (versions are immutable). null = the version does not generate. */
  const generated = new Map<string, GenerationOutput | null>();
  const generateVersion = (projectId: string, version: number, yaml?: string): GenerationOutput | undefined => {
    const key = `${projectId}:${version}`;
    if (generated.has(key)) {
      const hit = generated.get(key)!;
      generated.delete(key); // most recently used goes last
      generated.set(key, hit);
      return hit ?? undefined;
    }
    let out: GenerationOutput | null = null;
    try {
      const text = yaml ?? versionYaml(projectId, version);
      const r = validate(text);
      if (r.ok && r.analysis) out = generatePython(r.analysis, text);
    } catch (e) {
      // A stored version that crashes the generator is treated like one with errors; the preview never 500s on it.
      if (e instanceof HTTPException) throw e;
      console.error(`generation failed for ${key}:`, (e as Error).message);
    }
    generated.set(key, out);
    if (generated.size > GENERATION_CACHE) generated.delete(generated.keys().next().value!);
    return out ?? undefined;
  };

  const previewFor = (projectId: string, versionParam: string | undefined) => {
    const latest = latestVersion(projectId)!;
    const version = versionParam ? Number(versionParam) : latest.version;
    if (!Number.isInteger(version)) fail(400, "version must be a version number");
    const yaml = versionYaml(projectId, version);
    const out = generateVersion(projectId, version, yaml);
    if (!out) fail(400, "The model has errors; fix them before previewing generated code", { diagnostics: validate(yaml).diagnostics });
    return { version, out: out! };
  };

  app.get("/api/projects/:projectId/preview", (c) => {
    const { project } = loadProject(c);
    const { version, out } = previewFor(project.id, c.req.query("version"));
    // Compare with the newest earlier version that generated successfully (each version is generated once, then cached).
    let base: { version: number; out: GenerationOutput } | undefined;
    const earlier = db.query("SELECT version FROM model_versions WHERE project_id = ? AND version < ? ORDER BY version DESC").all(project.id, version) as { version: number }[];
    for (const e of earlier) {
      const o = generateVersion(project.id, e.version);
      if (o) {
        base = { version: e.version, out: o };
        break;
      }
    }
    const baseFiles = new Map(base?.out.files.map((f) => [f.path, f.content]) ?? []);
    if (base) baseFiles.set(base.out.manifestPath, renderManifest(base.out.manifest));
    const plan = computePlan(out, base?.out.manifest, (p) => baseFiles.get(p));
    return c.json({
      version,
      base_version: base?.version ?? null,
      files: out.files.map((f) => ({ path: f.path, ownership: f.ownership, content: f.content })),
      manifest: out.manifest,
      plan: plan.entries.map((e) => ({
        path: e.path,
        action: e.action,
        ownership: e.ownership,
        reason: e.reason,
        diff: e.action === "update" || e.action === "stale" ? unifiedDiff(e.path, e.before, e.action === "stale" ? undefined : e.after) : undefined,
      })),
      breaking: plan.breaking,
    });
  });

  app.get("/api/projects/:projectId/preview.zip", (c) => {
    const { project } = loadProject(c);
    const { version, out } = previewFor(project.id, c.req.query("version"));
    const entries: Record<string, Uint8Array> = {};
    const add = (path: string, content: string) => {
      const name = zipEntryName(path);
      if (name) entries[name] = strToU8(content);
      else console.error(`preview.zip: skipped unsafe path ${JSON.stringify(path).slice(0, 200)}`);
    };
    for (const f of out.files) add(f.path, f.content);
    add(out.manifestPath, renderManifest(out.manifest));
    add("model.ddd.yaml", versionYaml(project.id, version));
    const zip = zipSync(entries, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${safeFile(project.name)}-v${version}.zip"`,
      },
    });
  });

  // -- layout (diagram positions; separate from the semantic model) ------------

  app.get("/api/projects/:projectId/layout", (c) => {
    const { project } = loadProject(c);
    const row = db.query("SELECT json FROM layouts WHERE project_id = ?").get(project.id) as { json: string } | null;
    return c.json({ positions: row ? JSON.parse(row.json) : {} });
  });

  app.put("/api/projects/:projectId/layout", async (c) => {
    const { project } = loadProject(c, "editor");
    const { positions } = await body<{ positions?: Record<string, unknown> }>(c, BODY_LAYOUT);
    if (!positions || typeof positions !== "object" || Array.isArray(positions)) fail(400, "positions is required");
    const keys = Object.keys(positions!);
    if (keys.length > MAX_LAYOUT_KEYS) fail(413, `A layout can hold up to ${MAX_LAYOUT_KEYS} positions`);
    const clean: Record<string, { x: number; y: number }> = {};
    const coord = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10_000_000;
    for (const k of keys) {
      const v = positions![k] as { x?: unknown; y?: unknown } | null;
      // Only { x, y } numbers are kept; anything else in the value is dropped.
      if (k.length <= 200 && v && typeof v === "object" && coord(v.x) && coord(v.y)) clean[k] = { x: Math.round(v.x as number), y: Math.round(v.y as number) };
    }
    db.query("INSERT INTO layouts (project_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
      project.id,
      JSON.stringify(clean),
      now(),
    );
    return c.json({ ok: true });
  });

  // -- AI assistance ---------------------------------------------------------------

  /** The workspace's assistant when AI is on and still allowed (turned on by a current AI admin, or the workspace is listed). */
  const aiFor = (workspaceId: string): ModelAssistant | undefined => {
    const row = db.query("SELECT ai_enabled, ai_provider, ai_enabled_by FROM workspaces WHERE id = ?").get(workspaceId) as { ai_enabled: number; ai_provider: string | null; ai_enabled_by: string | null } | null;
    if (!row?.ai_enabled || !(aiWorkspaceListed(workspaceId) || isAiAdmin(row.ai_enabled_by))) return undefined;
    const provider = providerOf(row.ai_provider);
    return provider ? assistants[provider] : undefined;
  };

  /** A full model queue answers 429 (the client may retry later); other failures are reported as "no answer". */
  const busy = (e: unknown) => {
    if (e instanceof AiBusyError) fail(429, "The AI is busy with other requests; try again shortly");
  };
  const capped = (v: unknown, name: string, max: number): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") fail(400, `${name} must be a string`);
    if ((v as string).length > max) fail(413, `${name} is longer than ${max} characters`);
    return v as string;
  };

  const errorCount = (yaml: string) => validate(yaml).diagnostics.filter((d) => d.severity === "error").length;

  app.get("/api/projects/:projectId/assist", (c) => {
    const { project } = loadProject(c);
    const row = db.query("SELECT ai_enabled, ai_provider FROM workspaces WHERE id = ?").get(project.workspace_id) as { ai_enabled: number; ai_provider: string | null };
    const provider = providerOf(row.ai_provider);
    return c.json({ available: providerIds.length > 0, enabled: !!row.ai_enabled, active: !!aiFor(project.workspace_id), model: provider ? assistants[provider]!.model : null, provider: provider ?? null });
  });

  /** Ghost text from the LLM. Suggestions that break the YAML or add validation errors are dropped. */
  app.post("/api/projects/:projectId/assist/inline", async (c) => {
    const { project } = loadProject(c, "editor");
    const ai = aiFor(project.workspace_id);
    if (!ai) fail(403, "AI assistance is not enabled for this workspace");
    const { yaml, offset } = await body<{ yaml?: string; offset?: number }>(c, BODY_MODEL);
    if (typeof yaml !== "string" || typeof offset !== "number" || offset < 0 || offset > yaml.length) fail(400, "yaml and offset are required");
    checkModelSize(yaml!);
    spendAi(c);
    let text: string | undefined;
    try {
      // The browser aborts when the user keeps typing; that also stops a local CLI process.
      text = await ai!.inline({ yaml: yaml!, offset: offset!, signal: c.req.raw.signal });
    } catch (e) {
      busy(e);
      console.error("assist.inline failed:", (e as Error).message);
      return c.json({ suggestion: null, error: "AI の応答を取得できませんでした" });
    }
    if (!text || !text.trim()) return c.json({ suggestion: null });
    text = fitToCursor(yaml!, offset!, text);
    const next = yaml!.slice(0, offset) + text + yaml!.slice(offset);
    if (errorCount(next) > errorCount(yaml!)) return c.json({ suggestion: null, dropped: true });
    return c.json({ suggestion: { text, label: "AI の提案", source: "llm" } });
  });

  /** Proposal for an aggregate (or the whole context): LLM when enabled, local rules otherwise. */
  app.post("/api/projects/:projectId/assist/propose", async (c) => {
    const { project } = loadProject(c, "editor");
    const b = await body<{ yaml?: string; context?: string; aggregate?: string; kind?: string; instruction?: string }>(c, BODY_MODEL);
    if (typeof b.yaml !== "string" || typeof b.context !== "string" || typeof b.kind !== "string") fail(400, "yaml, context and kind are required");
    checkModelSize(b.yaml!);
    const context = capped(b.context, "context", 200)!;
    const aggregate = capped(b.aggregate, "aggregate", 200) || undefined;
    const kind = capped(b.kind, "kind", 40)!;
    const instruction = capped(b.instruction, "instruction", 2000);
    const ai = aiFor(project.workspace_id);
    if (!ai) {
      if (kind === "custom" || !aggregate) fail(403, "Free-form proposals need AI to be enabled for this workspace");
      const p = proposeLocally(b.yaml!, context, aggregate!, kind as ProposalKind);
      if (!p) return c.json({ proposal: null, message: "モデルの構造から提案できることはありません" });
      return c.json({ proposal: p, diagnostics: validate(p.yaml).diagnostics });
    }
    spendAi(c);
    const req = { yaml: b.yaml!, context, aggregate, kind, instruction, signal: c.req.raw.signal };
    try {
      let p = await ai.propose(req);
      if (!p) return c.json({ proposal: null, message: "AI が提案を返しませんでした" });
      let v = validate(p.yaml);
      if (!v.ok) {
        // One repair round with the validator's errors.
        const errors = v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.line ? `line ${d.line}: ` : ""}${d.element ? `${d.element}: ` : ""}${d.message}`);
        const repaired = await ai.propose({ ...req, repair: { yaml: p.yaml, errors } });
        if (repaired) {
          p = repaired;
          v = validate(p.yaml);
        }
      }
      return c.json({ proposal: { ...p, source: "llm" }, diagnostics: v.diagnostics });
    } catch (e) {
      busy(e);
      console.error("assist.propose failed:", (e as Error).message);
      return c.json({ proposal: null, message: "AI の応答を取得できませんでした" });
    }
  });

  /** Ghost stickies for the discovery board: structural predictions plus LLM ideas when enabled. */
  app.post("/api/projects/:projectId/assist/board", async (c) => {
    const { project } = loadProject(c, "editor");
    const raw = await body<{ board?: unknown; instruction?: string; llm?: boolean }>(c, BODY_BOARD);
    const board = checkedBoard(raw.board);
    const instruction = capped(raw.instruction, "instruction", 500);
    const ghosts: BoardGhost[] = boardGhosts(board);
    const ai = aiFor(project.workspace_id);
    if (ai && raw.llm) {
      spendAi(c);
      try {
        const suggestions = await ai.board({ board, instruction, signal: c.req.raw.signal });
        suggestions.slice(0, 20).forEach((s, i) => {
          const near = board.items.find((it) => it.id === s.near_item_id);
          if (!near || !(s.kind in STICKY_KINDS) || !s.text.trim()) return;
          const meta = STICKY_KINDS[s.kind as StickyKind];
          const gap = 40;
          const pos =
            s.placement === "left" ? { x: near.x - meta.w - gap, y: near.y } : s.placement === "above" ? { x: near.x, y: near.y - meta.h - gap } : s.placement === "below" ? { x: near.x, y: near.y + near.h + gap } : { x: near.x + near.w + gap, y: near.y };
          const id = `ghost-llm-${i}-${near.id}`;
          ghosts.push({
            id,
            kind: s.kind as StickyKind,
            text: s.text.slice(0, 200),
            ...pos,
            connect: s.connect === "from_near" ? { from: near.id, to: id } : s.connect === "to_near" ? { from: id, to: near.id } : undefined,
            reason: s.reason.slice(0, 300),
            source: "llm",
          });
        });
      } catch (e) {
        busy(e);
        console.error("assist.board failed:", (e as Error).message);
      }
    }
    return c.json({ ghosts, ai: !!ai });
  });

  // -- discovery board (EventStorming canvas) -----------------------------------

  /** Normalized board within the limits shared by saving and the board assistant. */
  function checkedBoard(raw: unknown): Board {
    const board = normalizeBoard(raw);
    if (!board) return fail(400, "board is invalid");
    if (board.items.length > MAX_BOARD_ITEMS) fail(413, `A board can hold up to ${MAX_BOARD_ITEMS} stickies`);
    if (board.frames.length > MAX_BOARD_FRAMES) fail(413, `A board can hold up to ${MAX_BOARD_FRAMES} frames`);
    if (board.connectors.length > MAX_BOARD_CONNECTORS) fail(413, `A board can hold up to ${MAX_BOARD_CONNECTORS} arrows`);
    return board;
  }

  const MAIN_BOARD = "main";
  const MAX_BOARDS = 20;

  type BoardRow = { board_id: string; name: string; position: number; version: number; json: string; updated_at: string | null; updated_by: string | null };
  const boardRow = (projectId: string, boardId: string) =>
    db
      .query("SELECT b.board_id, b.name, b.position, b.version, b.json, b.updated_at, u.username AS updated_by FROM project_boards b LEFT JOIN users u ON u.id = b.updated_by WHERE b.project_id = ? AND b.board_id = ?")
      .get(projectId, boardId) as BoardRow | null;
  /** The main board always exists (it is created on first save); other boards must have been created. */
  const requireBoard = (projectId: string, boardId: string) => {
    const row = boardRow(projectId, boardId);
    if (!row && boardId !== MAIN_BOARD) fail(404, "Board not found");
    return row;
  };

  const getBoard = (c: Context<Env>, boardId: string) => {
    const { project, role } = loadProject(c);
    const row = requireBoard(project.id, boardId);
    return c.json({ id: boardId, name: row?.name ?? "メイン", version: row?.version ?? 0, board: row ? JSON.parse(row.json) : emptyBoard(), updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null, role });
  };

  const putBoard = async (c: Context<Env>, boardId: string) => {
    const { project } = loadProject(c, "editor");
    const b = await body<{ board?: unknown; base_version?: unknown }>(c, BODY_BOARD);
    if (typeof b.base_version !== "number") fail(400, "base_version is required");
    const board = checkedBoard(b.board);
    const json = JSON.stringify(board);
    let version = 0;
    db.transaction(() => {
      const row = requireBoard(project.id, boardId);
      const current = row?.version ?? 0;
      if (current !== b.base_version) fail(409, "The board was changed by someone else", { current_version: current, board: row ? JSON.parse(row.json) : emptyBoard() });
      if (row && row.json === json) {
        version = current;
        return;
      }
      version = current + 1;
      if (row) db.query("UPDATE project_boards SET version = ?, json = ?, updated_by = ?, updated_at = ? WHERE project_id = ? AND board_id = ?").run(version, json, c.get("user").id, now(), project.id, boardId);
      else
        db.query("INSERT INTO project_boards (project_id, board_id, name, position, created_at, version, json, updated_by, updated_at) VALUES (?, ?, 'メイン', 0, ?, ?, ?, ?, ?)").run(project.id, boardId, now(), version, json, c.get("user").id, now());
    })();
    return c.json({ version, board });
  };

  // The project's main board (kept for existing clients).
  app.get("/api/projects/:projectId/board", (c) => getBoard(c, MAIN_BOARD));
  app.put("/api/projects/:projectId/board", (c) => putBoard(c, MAIN_BOARD));

  app.get("/api/projects/:projectId/boards", (c) => {
    const { project } = loadProject(c);
    const rows = db
      .query("SELECT b.board_id AS id, b.name, b.position, b.version, b.json, b.updated_at, u.username AS updated_by FROM project_boards b LEFT JOIN users u ON u.id = b.updated_by WHERE b.project_id = ? ORDER BY b.position, b.created_at")
      .all(project.id) as (Omit<BoardRow, "board_id"> & { id: string })[];
    const boards = rows.map(({ json, ...r }) => ({ ...r, stickies: (JSON.parse(json) as { items: unknown[] }).items.length }));
    if (!boards.some((b) => b.id === MAIN_BOARD)) boards.unshift({ id: MAIN_BOARD, name: "メイン", position: 0, version: 0, updated_at: null, updated_by: null, stickies: 0 });
    return c.json({ boards });
  });

  app.post("/api/projects/:projectId/boards", async (c) => {
    const { project } = loadProject(c, "editor");
    const { name } = await body<{ name?: string }>(c);
    const title = str(name, "name", 80);
    const count = (db.query("SELECT COUNT(*) AS n FROM project_boards WHERE project_id = ?").get(project.id) as { n: number }).n;
    if (count >= MAX_BOARDS) fail(413, `A project can have up to ${MAX_BOARDS} boards`);
    const id = `b${newId().replace(/-/g, "").slice(0, 12)}`;
    const position = (db.query("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM project_boards WHERE project_id = ?").get(project.id) as { p: number }).p;
    db.query("INSERT INTO project_boards (project_id, board_id, name, position, created_at, version, json) VALUES (?, ?, ?, ?, ?, 0, ?)").run(project.id, id, title, position, now(), JSON.stringify(emptyBoard()));
    audit(project.workspace_id, c.get("user").id, "board.create", title, { project: project.id, board: id });
    return c.json({ id, name: title }, 201);
  });

  app.patch("/api/projects/:projectId/boards/:boardId", async (c) => {
    const { project } = loadProject(c, "editor");
    const boardId = c.req.param("boardId");
    const { name } = await body<{ name?: string }>(c);
    const title = str(name, "name", 80);
    if (!boardRow(project.id, boardId)) {
      if (boardId !== MAIN_BOARD) fail(404, "Board not found");
      db.query("INSERT INTO project_boards (project_id, board_id, name, position, created_at, version, json) VALUES (?, ?, ?, 0, ?, 0, ?)").run(project.id, boardId, title, now(), JSON.stringify(emptyBoard()));
    } else db.query("UPDATE project_boards SET name = ? WHERE project_id = ? AND board_id = ?").run(title, project.id, boardId);
    audit(project.workspace_id, c.get("user").id, "board.rename", title, { project: project.id, board: boardId });
    return c.json({ id: boardId, name: title });
  });

  app.delete("/api/projects/:projectId/boards/:boardId", (c) => {
    const { project } = loadProject(c, "editor");
    const boardId = c.req.param("boardId");
    if (boardId === MAIN_BOARD) fail(400, "The main board cannot be deleted");
    const row = boardRow(project.id, boardId);
    if (!row) fail(404, "Board not found");
    db.query("DELETE FROM project_boards WHERE project_id = ? AND board_id = ?").run(project.id, boardId);
    audit(project.workspace_id, c.get("user").id, "board.delete", row!.name, { project: project.id, board: boardId });
    return c.json({ ok: true });
  });

  app.get("/api/projects/:projectId/boards/:boardId", (c) => getBoard(c, c.req.param("boardId")));
  app.put("/api/projects/:projectId/boards/:boardId", (c) => putBoard(c, c.req.param("boardId")));

  return app;
}

/**
 * A zip entry name that cannot escape the extraction directory: relative, "/"-separated segments of
 * letters, digits, "_", "." and "-" (no empty, ".", ".." or drive-letter segments). undefined = unsafe.
 */
export function zipEntryName(path: string): string | undefined {
  const parts = path.split("/");
  if (path.length > 500 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..")) return undefined;
  return parts.join("/");
}

function safeFile(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "model";
}
