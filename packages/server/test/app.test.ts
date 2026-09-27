import { beforeEach, describe, expect, test } from "bun:test";
import { validateModelText } from "@ddd/core";
import { unzipSync, strFromU8 } from "fflate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(openDatabase(":memory:"));
});

type Session = { cookie: string; call: (method: string, path: string, body?: unknown) => Promise<Response>; json: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }> };

async function login(username: string): Promise<Session> {
  const res = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    cookie,
    call,
    json: async (method, path, body) => {
      const r = await call(method, path, body);
      return { status: r.status, body: (await r.json()) as any };
    },
  };
}

async function workspaceOf(s: Session): Promise<string> {
  return (await s.json("GET", "/api/me")).body.workspaces[0].id;
}

async function newProject(s: Session, ws?: string): Promise<string> {
  const r = await s.json("POST", `/api/workspaces/${ws ?? (await workspaceOf(s))}/projects`, { name: "Cleaning" });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe("auth", () => {
  test("API requires a session", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
  });

  test("first login creates the user and a personal workspace", async () => {
    const s = await login("alice");
    const me = await s.json("GET", "/api/me");
    expect(me.body.user.username).toBe("alice");
    expect(me.body.workspaces).toHaveLength(1);
    expect(me.body.workspaces[0].role).toBe("owner");
  });

  test("logout invalidates the session", async () => {
    const s = await login("alice");
    await s.call("POST", "/api/logout");
    expect((await s.call("GET", "/api/me")).status).toBe(401);
  });

  test("cross-origin mutations are rejected", async () => {
    const s = await login("alice");
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { cookie: s.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("tenant isolation (NFR-SEC-01)", () => {
  test("another tenant's workspace, projects and model are indistinguishable from missing", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const ws = await workspaceOf(alice);
    const project = await newProject(alice);
    const paths = [
      ["GET", `/api/workspaces/${ws}`],
      ["GET", `/api/workspaces/${ws}/projects`],
      ["GET", `/api/workspaces/${ws}/members`],
      ["POST", `/api/workspaces/${ws}/projects`],
      ["GET", `/api/projects/${project}`],
      ["GET", `/api/projects/${project}/model`],
      ["PUT", `/api/projects/${project}/model`],
      ["GET", `/api/projects/${project}/versions`],
      ["GET", `/api/projects/${project}/preview`],
      ["GET", `/api/projects/${project}/export`],
      ["GET", `/api/projects/${project}/layout`],
      ["DELETE", `/api/projects/${project}`],
    ] as const;
    for (const [method, path] of paths) {
      const r = await bob.call(method, path, method === "GET" || method === "DELETE" ? undefined : { name: "x", yaml: "x", base_version: 1 });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 });
    }
    const missing = await bob.call("GET", `/api/projects/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

describe("roles", () => {
  async function team() {
    const owner = await login("owner");
    const editor = await login("editor");
    const viewer = await login("viewer");
    const ws = await workspaceOf(owner);
    expect((await owner.json("POST", `/api/workspaces/${ws}/members`, { username: "editor", role: "editor" })).status).toBe(201);
    expect((await owner.json("POST", `/api/workspaces/${ws}/members`, { username: "viewer", role: "viewer" })).status).toBe(201);
    const project = await newProject(owner, ws);
    return { owner, editor, viewer, ws, project };
  }

  test("viewer can read but not write", async () => {
    const { viewer, project } = await team();
    expect((await viewer.call("GET", `/api/projects/${project}/model`)).status).toBe(200);
    expect((await viewer.call("PUT", `/api/projects/${project}/model`, { yaml: "x", base_version: 1 })).status).toBe(403);
    expect((await viewer.call("PUT", `/api/projects/${project}/layout`, { positions: {} })).status).toBe(403);
  });

  test("editor can edit models but not delete projects or manage members", async () => {
    const { editor, project, ws } = await team();
    expect((await editor.json("PUT", `/api/projects/${project}/model`, { yaml: SAMPLE + "\n", base_version: 1 })).status).toBe(200);
    expect((await editor.call("DELETE", `/api/projects/${project}`)).status).toBe(403);
    expect((await editor.call("POST", `/api/workspaces/${ws}/members`, { username: "viewer", role: "owner" })).status).toBe(403);
    expect((await editor.call("GET", `/api/workspaces/${ws}/audit`)).status).toBe(403);
  });

  test("the last owner cannot be demoted or removed", async () => {
    const { owner, ws } = await team();
    const me = (await owner.json("GET", "/api/me")).body.user.id;
    expect((await owner.call("PATCH", `/api/workspaces/${ws}/members/${me}`, { role: "viewer" })).status).toBe(409);
    expect((await owner.call("DELETE", `/api/workspaces/${ws}/members/${me}`)).status).toBe(409);
  });

  test("member changes, deletion and export are audited", async () => {
    const { owner, ws, project, viewer } = await team();
    const viewerId = (await viewer.json("GET", "/api/me")).body.user.id;
    await owner.call("PATCH", `/api/workspaces/${ws}/members/${viewerId}`, { role: "editor" });
    await owner.call("GET", `/api/projects/${project}/export`);
    await owner.call("DELETE", `/api/projects/${project}`);
    const log = (await owner.json("GET", `/api/workspaces/${ws}/audit`)).body.entries.map((e: any) => `${e.action}:${e.target}`);
    expect(log).toEqual([
      "project.delete:Cleaning",
      "project.export:Cleaning",
      "member.role:viewer",
      "project.create:Cleaning",
      "member.add:viewer",
      "member.add:editor",
      "workspace.create:" + ws,
    ]);
  });
});

describe("models", () => {
  test("new projects start from the sample model (FR-001)", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const m = await s.json("GET", `/api/projects/${project}/model`);
    expect(m.body.version).toBe(1);
    expect(m.body.yaml).toBe(SAMPLE);
  });

  test("stale base_version is rejected with 409 and nothing is overwritten", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const first = await s.json("PUT", `/api/projects/${project}/model`, { yaml: SAMPLE.replace("清掃", "Cleaning"), base_version: 1 });
    expect(first.body.version).toBe(2);
    const conflict = await s.json("PUT", `/api/projects/${project}/model`, { yaml: "schema_version: 1\n", base_version: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.current_version).toBe(2);
    expect((await s.json("GET", `/api/projects/${project}/model`)).body.yaml).toBe(SAMPLE.replace("清掃", "Cleaning"));
  });

  test("invalid drafts can be saved and return diagnostics", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const r = await s.json("PUT", `/api/projects/${project}/model`, { yaml: SAMPLE.replace("type: InvitationStatus", "type: Nope"), base_version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.diagnostics[0].code).toBe("unknown-type");
  });

  test("history and diff between versions", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    await s.json("PUT", `/api/projects/${project}/model`, { yaml: SAMPLE.replace("project: cleaning-platform", "project: cleaning"), base_version: 1, message: "rename" });
    const versions = (await s.json("GET", `/api/projects/${project}/versions`)).body.versions;
    expect(versions.map((v: any) => [v.version, v.message, v.author])).toEqual([
      [2, "rename", "alice"],
      [1, "Created", "alice"],
    ]);
    const diff = (await s.json("GET", `/api/projects/${project}/diff?from=1&to=2`)).body.diff;
    expect(diff).toContain("-project: cleaning-platform\n+project: cleaning");
  });

  test("import and export round-trip (FR-033)", async () => {
    const s = await login("alice");
    const ws = await workspaceOf(s);
    const imported = await s.json("POST", `/api/workspaces/${ws}/projects`, { name: "Imported", yaml: SAMPLE });
    const res = await s.call("GET", `/api/projects/${imported.body.id}/export`);
    expect(res.headers.get("content-disposition")).toContain("Imported.ddd.yaml");
    expect(await res.text()).toBe(SAMPLE);
  });

  test("oversized models are refused", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const r = await s.call("PUT", `/api/projects/${project}/model`, { yaml: "x".repeat(1_100_000), base_version: 1 });
    expect(r.status).toBe(413);
  });
});

describe("validation parity (FR-030 / FR-034)", () => {
  test("POST /api/validate returns exactly what the CLI's core returns", async () => {
    expect((await app.request("/api/validate", { method: "POST", body: "{}" })).status).toBe(401);
    const s = await login("alice");
    for (const text of [SAMPLE, SAMPLE.replace("error: InvalidInvitationWindow", "error: Nope"), "schema_version: 1\ncontexts: ["]) {
      const res = await s.call("POST", "/api/validate", { yaml: text });
      const body = (await res.json()) as any;
      const local = validateModelText(text);
      expect(body.ok).toBe(local.ok);
      expect(body.diagnostics).toEqual(JSON.parse(JSON.stringify(local.diagnostics)));
    }
  });
});

describe("generation preview", () => {
  test("lists files and a plan relative to the previous version", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const first = await s.json("GET", `/api/projects/${project}/preview`);
    expect(first.body.base_version).toBeNull();
    expect(first.body.files.length).toBeGreaterThan(20);
    expect(first.body.plan.every((e: any) => e.action === "create")).toBe(true);

    const changed = SAMPLE.slice(0, SAMPLE.indexOf("      - name: revoke_invitation")) + SAMPLE.slice(SAMPLE.indexOf("\n  - name: Staffing") + 1);
    await s.json("PUT", `/api/projects/${project}/model`, { yaml: changed, base_version: 1 });
    const second = await s.json("GET", `/api/projects/${project}/preview`);
    expect(second.body.base_version).toBe(1);
    const byAction = (a: string) => second.body.plan.filter((e: any) => e.action === a).map((e: any) => e.path);
    expect(byAction("stale")).toEqual(["tests/generated/test_cleaning_staff_revoke_invitation.py"]);
    expect(byAction("update")).toContain("src/cleaning_platform/generated/cleaning_staff/application/use_cases.py");
    expect(second.body.breaking.map((b: any) => b.symbol)).toContain("RevokeInvitationUseCase");
  });

  test("preview of an invalid model returns diagnostics", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    await s.json("PUT", `/api/projects/${project}/model`, { yaml: SAMPLE.replace("type: InvitationStatus", "type: Nope"), base_version: 1 });
    const r = await s.json("GET", `/api/projects/${project}/preview`);
    expect(r.status).toBe(400);
    expect(r.body.diagnostics.length).toBeGreaterThan(0);
  });

  test("zip download contains the model, generated files and manifest", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const res = await s.call("GET", `/api/projects/${project}/preview.zip`);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(strFromU8(files["model.ddd.yaml"]!)).toBe(SAMPLE);
    expect(Object.keys(files)).toContain("src/cleaning_platform/generated/model_manifest.json");
  });
});

describe("layout", () => {
  test("positions are stored separately from the model and sanitized", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    await s.call("PUT", `/api/projects/${project}/layout`, { positions: { "CleaningStaff/CleaningStaffInvitation": { x: 10.4, y: 20 }, bad: { x: "no" } } });
    const r = await s.json("GET", `/api/projects/${project}/layout`);
    expect(r.body.positions).toEqual({ "CleaningStaff/CleaningStaffInvitation": { x: 10, y: 20 } });
    expect((await s.json("GET", `/api/projects/${project}/model`)).body.version).toBe(1);
  });
});

describe("health", () => {
  test("is public and identifies the service", async () => {
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ service: "ddd-presenter", ok: true });
  });
});

describe("discovery board", () => {
  const board = (text: string) => ({ version: 1, frames: [], connectors: [], items: [{ id: "e1", kind: "event", text, x: 10, y: 20, w: 160, h: 100 }] });

  test("a project can hold several boards; the main one always exists and cannot be deleted", async () => {
    const s = await login("multi");
    const project = await newProject(s);
    expect((await s.json("GET", `/api/projects/${project}/boards`)).body.boards).toEqual([expect.objectContaining({ id: "main", name: "メイン", stickies: 0 })]);
    await s.json("PUT", `/api/projects/${project}/board`, { base_version: 0, board: board("招待が送られた") });
    const created = await s.json("POST", `/api/projects/${project}/boards`, { name: "支払いワークショップ" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await s.json("GET", `/api/projects/${project}/boards/${id}`)).body).toMatchObject({ id, name: "支払いワークショップ", version: 0, board: { items: [] } });
    const saved = await s.json("PUT", `/api/projects/${project}/boards/${id}`, { base_version: 0, board: board("支払われた") });
    expect(saved.body.version).toBe(1);
    expect((await s.json("GET", `/api/projects/${project}/board`)).body.board.items[0].text).toBe("招待が送られた"); // boards are independent
    expect((await s.json("PATCH", `/api/projects/${project}/boards/${id}`, { name: "支払い" })).body.name).toBe("支払い");
    const list = (await s.json("GET", `/api/projects/${project}/boards`)).body.boards;
    expect(list.map((b: any) => [b.id, b.name, b.stickies])).toEqual([["main", "メイン", 1], [id, "支払い", 1]]);
    expect((await s.json("DELETE", `/api/projects/${project}/boards/main`)).status).toBe(400);
    expect((await s.json("DELETE", `/api/projects/${project}/boards/${id}`)).status).toBe(200);
    expect((await s.json("GET", `/api/projects/${project}/boards/${id}`)).status).toBe(404);
    expect((await s.json("PUT", `/api/projects/${project}/boards/nope`, { base_version: 0, board: board("x") })).status).toBe(404);
    const stranger = await login("stranger2");
    expect((await stranger.json("GET", `/api/projects/${project}/boards`)).status).toBe(404);
  });

  test("starts empty, saves with optimistic concurrency and normalizes input", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    const first = await s.json("GET", `/api/projects/${project}/board`);
    expect(first.body).toMatchObject({ version: 0, board: { items: [], frames: [], connectors: [] } });
    const saved = await s.json("PUT", `/api/projects/${project}/board`, { base_version: 0, board: { ...board("招待が送られた"), junk: 1, items: [...board("招待が送られた").items, { id: "x", kind: "bogus" }] } });
    expect(saved.body.version).toBe(1);
    expect(saved.body.board.items).toHaveLength(1);
    const conflict = await s.json("PUT", `/api/projects/${project}/board`, { base_version: 0, board: board("上書き") });
    expect(conflict.status).toBe(409);
    expect(conflict.body.current_version).toBe(1);
    expect(conflict.body.board.items[0].text).toBe("招待が送られた");
    const again = await s.json("GET", `/api/projects/${project}/board`);
    expect(again.body.updated_by).toBe("alice");
    // Saving the board never touches the model.
    expect((await s.json("GET", `/api/projects/${project}/model`)).body.version).toBe(1);
  });

  test("viewers can read but not write; other tenants get 404", async () => {
    const owner = await login("owner");
    const viewer = await login("viewer");
    const stranger = await login("stranger");
    const ws = await workspaceOf(owner);
    await owner.json("POST", `/api/workspaces/${ws}/members`, { username: "viewer", role: "viewer" });
    const project = await newProject(owner, ws);
    expect((await viewer.call("GET", `/api/projects/${project}/board`)).status).toBe(200);
    expect((await viewer.call("PUT", `/api/projects/${project}/board`, { base_version: 0, board: board("x") })).status).toBe(403);
    expect((await stranger.call("GET", `/api/projects/${project}/board`)).status).toBe(404);
    expect((await stranger.call("PUT", `/api/projects/${project}/board`, { base_version: 0, board: board("x") })).status).toBe(404);
  });

  test("rejects invalid and oversized boards", async () => {
    const s = await login("alice");
    const project = await newProject(s);
    expect((await s.call("PUT", `/api/projects/${project}/board`, { base_version: 0, board: "nope" })).status).toBe(400);
    expect((await s.call("PUT", `/api/projects/${project}/board`, { base_version: 0, board: board("x".repeat(2_100_000)) })).status).toBe(413);
  });
});
