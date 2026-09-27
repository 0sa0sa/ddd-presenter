import type { Database } from "bun:sqlite";
import { boardGhosts, emptyBoard, normalizeBoard, proposeLocally, ruleUsage, STICKY_KINDS, validateModelText, type BoardGhost, type ProposalKind, type StickyKind } from "@ddd/core";
import { PROVIDER_LABEL, type ModelAssistant, type ProviderId } from "./ai.ts";
import { fitToCursor } from "./fit.ts";
import { computePlan, generatePython, renderManifest, unifiedDiff, type GenerationOutput } from "@ddd/generator";
import { strToU8, zipSync } from "fflate";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { newId, now, ROLE_RANK, type Role } from "./db.ts";
import { emptyModel, sampleModel } from "./templates.ts";

type User = { id: string; username: string };
type Env = { Variables: { user: User } };

const SESSION_COOKIE = "ddd_session";
const SESSION_DAYS = 14;
const MAX_MODEL_BYTES = 1_000_000;

export interface AppOptions {
  /** Set the Secure flag on cookies (production over HTTPS). */
  secureCookies?: boolean;
  /** LLM used for assistance when a workspace enables AI; undefined = local suggestions only. */
  assistant?: ModelAssistant;
  /** Assistants the workspace owner can choose from (Claude API, local Claude Code / Codex CLIs). */
  assistants?: Partial<Record<ProviderId, ModelAssistant>>;
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

  const fail = (status: 400 | 401 | 403 | 404 | 409 | 413, message: string, extra: Record<string, unknown> = {}): never => {
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

  const body = async <T>(c: Context<Env>): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      return fail(400, "Request body must be JSON");
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

  // Mutating requests must come from our own origin (CSRF defense in addition to SameSite cookies).
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== new URL(c.req.url).host) fail(403, "Cross-origin request rejected");
    }
    await next();
  });

  // ---------------------------------------------------------------------------
  // auth (development login: username only, by decision in docs/09)
  // ---------------------------------------------------------------------------

  // Lets the Web client verify it is talking to a DDD Presenter server (not another app on the same port).
  app.get("/api/health", (c) => c.json({ service: "ddd-presenter", ok: true }));

  app.get("/api/users", (c) => c.json({ users: db.query("SELECT username FROM users ORDER BY username").all() }));

  app.post("/api/login", async (c) => {
    const { username } = await body<{ username?: string }>(c);
    const name = str(username, "username", 40);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail(400, "username may contain letters, digits, '.', '-' and '_'");
    let user = db.query("SELECT id, username FROM users WHERE username = ?").get(name) as User | null;
    if (!user) {
      user = { id: newId(), username: name };
      db.query("INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)").run(user.id, name, now());
      createWorkspace(`${name}'s workspace`, user.id);
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.query("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, user.id, now(), expires.toISOString());
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", secure: !!options.secureCookies, expires });
    return c.json({ user });
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) db.query("DELETE FROM sessions WHERE token = ?").run(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token
      ? (db
          .query("SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?")
          .get(token, now()) as User | null)
      : null;
    if (!user) fail(401, "Not logged in");
    c.set("user", user!);
    await next();
  });

  // Stateless validation: same core function as the CLI (FR-030 / FR-034 parity).
  app.post("/api/validate", async (c) => {
    const { yaml } = await body<{ yaml?: string }>(c);
    if (typeof yaml !== "string") fail(400, "yaml is required");
    checkModelSize(yaml!);
    const r = validateModelText(yaml!);
    return c.json({ ok: r.ok, diagnostics: r.diagnostics, rules: r.analysis ? ruleUsage(r.analysis) : [] });
  });

  app.get("/api/me", (c) => {
    const user = c.get("user");
    const workspaces = db
      .query("SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at")
      .all(user.id);
    return c.json({ user, workspaces });
  });

  // ---------------------------------------------------------------------------
  // workspaces & members
  // ---------------------------------------------------------------------------

  app.post("/api/workspaces", async (c) => {
    const { name } = await body<{ name?: string }>(c);
    const id = createWorkspace(str(name, "name", 80), c.get("user").id);
    return c.json({ id }, 201);
  });

  app.get("/api/workspaces/:wsId", (c) => {
    const wsId = c.req.param("wsId");
    const role = roleIn(wsId, c.get("user").id);
    const { ai_provider, ...ws } = db.query("SELECT id, name, created_at, ai_enabled, ai_provider FROM workspaces WHERE id = ?").get(wsId) as { ai_enabled: number; ai_provider: string | null } & Record<string, unknown>;
    const provider = providerOf(ai_provider);
    return c.json({
      workspace: { ...ws, ai_enabled: !!ws.ai_enabled, ai_provider: provider ?? null },
      role,
      ai_available: providerIds.length > 0,
      ai_model: provider ? assistants[provider]!.model : null,
      ai_providers: providers,
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
    if (ai_provider !== undefined) {
      db.query("UPDATE workspaces SET ai_provider = ? WHERE id = ?").run(ai_provider, wsId);
      audit(wsId, actor.id, "ai.provider", wsId, { provider: ai_provider });
    }
    if (ai_enabled !== undefined) {
      db.query("UPDATE workspaces SET ai_enabled = ? WHERE id = ?").run(ai_enabled ? 1 : 0, wsId);
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
    const user = db.query("SELECT id, username FROM users WHERE username = ?").get(str(username, "username", 40)) as User | null;
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
    const b = await body<{ name?: string; description?: string; template?: string; yaml?: string }>(c);
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
    const b = await body<{ yaml?: string; base_version?: number; message?: string }>(c);
    if (typeof b.yaml !== "string") fail(400, "yaml is required");
    if (typeof b.base_version !== "number") fail(400, "base_version is required");
    checkModelSize(b.yaml!);
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
    const v = validateModelText(b.yaml!);
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

  const generateFor = (yaml: string): GenerationOutput | undefined => {
    const r = validateModelText(yaml);
    if (!r.ok || !r.analysis) return undefined;
    return generatePython(r.analysis, yaml);
  };

  const previewFor = (projectId: string, versionParam: string | undefined) => {
    const latest = latestVersion(projectId)!;
    const version = versionParam ? Number(versionParam) : latest.version;
    const yaml = versionYaml(projectId, version);
    const out = generateFor(yaml);
    if (!out) fail(400, "The model has errors; fix them before previewing generated code", { diagnostics: validateModelText(yaml).diagnostics });
    return { version, out: out! };
  };

  app.get("/api/projects/:projectId/preview", (c) => {
    const { project } = loadProject(c);
    const { version, out } = previewFor(project.id, c.req.query("version"));
    // Compare with the newest earlier version that generated successfully.
    let base: { version: number; out: GenerationOutput } | undefined;
    const earlier = db.query("SELECT version, yaml FROM model_versions WHERE project_id = ? AND version < ? ORDER BY version DESC").all(project.id, version) as {
      version: number;
      yaml: string;
    }[];
    for (const e of earlier) {
      const o = generateFor(e.yaml);
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
    for (const f of out.files) entries[f.path] = strToU8(f.content);
    entries[out.manifestPath] = strToU8(renderManifest(out.manifest));
    entries["model.ddd.yaml"] = strToU8(versionYaml(project.id, version));
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
    const { positions } = await body<{ positions?: Record<string, { x: number; y: number }> }>(c);
    if (!positions || typeof positions !== "object") fail(400, "positions is required");
    const clean: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(positions!)) {
      if (k.length <= 200 && v && Number.isFinite(v.x) && Number.isFinite(v.y)) clean[k] = { x: Math.round(v.x), y: Math.round(v.y) };
    }
    db.query("INSERT INTO layouts (project_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
      project.id,
      JSON.stringify(clean),
      now(),
    );
    return c.json({ ok: true });
  });

  // -- AI assistance ---------------------------------------------------------------

  const aiFor = (workspaceId: string): ModelAssistant | undefined => {
    const row = db.query("SELECT ai_enabled, ai_provider FROM workspaces WHERE id = ?").get(workspaceId) as { ai_enabled: number; ai_provider: string | null } | null;
    const provider = row?.ai_enabled ? providerOf(row.ai_provider) : undefined;
    return provider ? assistants[provider] : undefined;
  };

  const errorCount = (yaml: string) => validateModelText(yaml).diagnostics.filter((d) => d.severity === "error").length;

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
    const { yaml, offset } = await body<{ yaml?: string; offset?: number }>(c);
    if (typeof yaml !== "string" || typeof offset !== "number" || offset < 0 || offset > yaml.length) fail(400, "yaml and offset are required");
    checkModelSize(yaml!);
    let text: string | undefined;
    try {
      // The browser aborts when the user keeps typing; that also stops a local CLI process.
      text = await ai!.inline({ yaml: yaml!, offset: offset!, signal: c.req.raw.signal });
    } catch (e) {
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
    const b = await body<{ yaml?: string; context?: string; aggregate?: string; kind?: string; instruction?: string }>(c);
    if (typeof b.yaml !== "string" || typeof b.context !== "string" || typeof b.kind !== "string") fail(400, "yaml, context and kind are required");
    checkModelSize(b.yaml!);
    const ai = aiFor(project.workspace_id);
    if (!ai) {
      if (b.kind === "custom" || !b.aggregate) fail(403, "Free-form proposals need AI to be enabled for this workspace");
      const p = proposeLocally(b.yaml!, b.context!, b.aggregate!, b.kind as ProposalKind);
      if (!p) return c.json({ proposal: null, message: "モデルの構造から提案できることはありません" });
      return c.json({ proposal: p, diagnostics: validateModelText(p.yaml).diagnostics });
    }
    const req = { yaml: b.yaml!, context: b.context!, aggregate: b.aggregate, kind: b.kind!, instruction: typeof b.instruction === "string" ? b.instruction.slice(0, 2000) : undefined, signal: c.req.raw.signal };
    try {
      let p = await ai.propose(req);
      if (!p) return c.json({ proposal: null, message: "AI が提案を返しませんでした" });
      let v = validateModelText(p.yaml);
      if (!v.ok) {
        // One repair round with the validator's errors.
        const errors = v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.line ? `line ${d.line}: ` : ""}${d.element ? `${d.element}: ` : ""}${d.message}`);
        const repaired = await ai.propose({ ...req, repair: { yaml: p.yaml, errors } });
        if (repaired) {
          p = repaired;
          v = validateModelText(p.yaml);
        }
      }
      return c.json({ proposal: { ...p, source: "llm" }, diagnostics: v.diagnostics });
    } catch (e) {
      console.error("assist.propose failed:", (e as Error).message);
      return c.json({ proposal: null, message: "AI の応答を取得できませんでした" });
    }
  });

  /** Ghost stickies for the discovery board: structural predictions plus LLM ideas when enabled. */
  app.post("/api/projects/:projectId/assist/board", async (c) => {
    const { project } = loadProject(c, "editor");
    const raw = await body<{ board?: unknown; instruction?: string; llm?: boolean }>(c);
    const board = normalizeBoard(raw.board);
    if (!board) fail(400, "board is invalid");
    const ghosts: BoardGhost[] = boardGhosts(board!);
    const ai = aiFor(project.workspace_id);
    if (ai && raw.llm) {
      try {
        const suggestions = await ai.board({ board: board!, instruction: typeof raw.instruction === "string" ? raw.instruction.slice(0, 500) : undefined, signal: c.req.raw.signal });
        suggestions.forEach((s, i) => {
          const near = board!.items.find((it) => it.id === s.near_item_id);
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
        console.error("assist.board failed:", (e as Error).message);
      }
    }
    return c.json({ ghosts, ai: !!ai });
  });

  // -- discovery board (EventStorming canvas) -----------------------------------

  const MAX_BOARD_BYTES = 2_000_000;

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
    const raw = await c.req.text();
    if (raw.length > MAX_BOARD_BYTES) fail(413, "The board is larger than 2 MB");
    let b: { board?: unknown; base_version?: unknown };
    try {
      b = JSON.parse(raw);
    } catch {
      return fail(400, "Request body must be JSON");
    }
    if (typeof b.base_version !== "number") fail(400, "base_version is required");
    const board = normalizeBoard(b.board);
    if (!board) fail(400, "board is invalid");
    if (board!.items.length > 3000) fail(413, "A board can hold up to 3000 stickies");
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

function safeFile(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "model";
}
