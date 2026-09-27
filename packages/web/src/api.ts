import type { Board, BoardGhost, Diagnostic, Proposal, RuleUsage } from "@ddd/core";

export type Role = "owner" | "editor" | "viewer";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Status 0 = the request never reached a DDD Presenter server (network down, server stopped, wrong app on the port). */
export const OFFLINE_MESSAGE =
  "サーバーに接続できません。APIサーバー（bun run dev:server または bun run start）が起動しているか確認してください。";

export async function request<T>(method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
  } catch {
    throw new ApiError(0, OFFLINE_MESSAGE, {});
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A proxy error page or another application answered instead of the API.
      throw new ApiError(0, res.status >= 500 ? OFFLINE_MESSAGE : `APIではない応答を受け取りました（HTTP ${res.status}）。別のアプリが同じポートを使っていないか確認してください。`, {});
    }
  }
  if (!res.ok) {
    // Our API always answers errors with { error }. A bare 5xx comes from a proxy whose backend is down (e.g. Vite → 502).
    if (data.error === undefined && res.status >= 500) throw new ApiError(0, OFFLINE_MESSAGE, {});
    throw new ApiError(res.status, String(data.error ?? res.statusText), data);
  }
  return data as T;
}

/** Human-readable message for any error thrown by the API client or UI code. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return `予期しないエラー: ${String(e)}`;
}

export interface Me {
  user: { id: string; username: string };
  workspaces: { id: string; name: string; role: Role }[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  created_at: string;
  version: number;
  updated_at: string;
}
export interface Member {
  id: string;
  username: string;
  role: Role;
}
export interface AuditEntry {
  id: number;
  action: string;
  target: string;
  actor: string | null;
  at: string;
  detail: Record<string, unknown>;
}
export interface VersionInfo {
  version: number;
  message: string;
  created_at: string;
  author: string | null;
}
export interface PreviewFile {
  path: string;
  ownership: "generated" | "scaffold";
  content: string;
}
export interface PreviewPlanEntry {
  path: string;
  action: "create" | "update" | "unchanged" | "conflict" | "keep" | "stale";
  ownership: string;
  reason?: string;
  diff?: string;
}
export interface Preview {
  version: number;
  base_version: number | null;
  files: PreviewFile[];
  plan: PreviewPlanEntry[];
  breaking: { path: string; symbol: string; reason: string }[];
}

export type AiProviderId = "api" | "claude-code" | "codex";
export interface AiProvider {
  id: AiProviderId;
  label: string;
  model: string;
}

export const api = {
  health: async () => {
    const r = await request<{ service?: string }>("GET", "/api/health");
    if (r.service !== "ddd-presenter") throw new ApiError(0, "接続先がDDD Presenterのサーバーではありません。ポート設定（PORT / DDD_PORT）を確認してください。", {});
    return r;
  },
  users: () => request<{ users: { username: string }[] }>("GET", "/api/users"),
  login: (username: string) => request<{ user: Me["user"] }>("POST", "/api/login", { username }),
  logout: () => request("POST", "/api/logout"),
  me: () => request<Me>("GET", "/api/me"),
  createWorkspace: (name: string) => request<{ id: string }>("POST", "/api/workspaces", { name }),
  workspace: (ws: string) =>
    request<{
      workspace: { id: string; name: string; ai_enabled: boolean; ai_provider: AiProviderId | null };
      role: Role;
      ai_available: boolean;
      ai_model: string | null;
      ai_providers: AiProvider[];
    }>("GET", `/api/workspaces/${ws}`),
  setAi: (ws: string, settings: { ai_enabled?: boolean; ai_provider?: AiProviderId }) =>
    request<{ ai_enabled: boolean; ai_provider: AiProviderId | null; ai_model: string | null }>("PATCH", `/api/workspaces/${ws}/settings`, settings),
  assistStatus: (id: string) => request<{ available: boolean; enabled: boolean; active: boolean; model: string | null }>("GET", `/api/projects/${id}/assist`),
  assistInline: (id: string, yaml: string, offset: number, signal?: AbortSignal) =>
    request<{ suggestion: { text: string; label: string; source: "llm" } | null }>("POST", `/api/projects/${id}/assist/inline`, { yaml, offset }, fetch, signal),
  propose: (id: string, body: { yaml: string; context: string; aggregate?: string; kind: string; instruction?: string }) =>
    request<{ proposal: Proposal | null; diagnostics?: Diagnostic[]; message?: string }>("POST", `/api/projects/${id}/assist/propose`, body),
  boardAssist: (id: string, board: Board, llm: boolean, instruction?: string) =>
    request<{ ghosts: BoardGhost[]; ai: boolean }>("POST", `/api/projects/${id}/assist/board`, { board, llm, instruction }),
  members: (ws: string) => request<{ members: Member[] }>("GET", `/api/workspaces/${ws}/members`),
  addMember: (ws: string, username: string, role: Role) => request("POST", `/api/workspaces/${ws}/members`, { username, role }),
  setRole: (ws: string, userId: string, role: Role) => request("PATCH", `/api/workspaces/${ws}/members/${userId}`, { role }),
  removeMember: (ws: string, userId: string) => request("DELETE", `/api/workspaces/${ws}/members/${userId}`),
  audit: (ws: string) => request<{ entries: AuditEntry[] }>("GET", `/api/workspaces/${ws}/audit`),
  projects: (ws: string) => request<{ projects: ProjectSummary[] }>("GET", `/api/workspaces/${ws}/projects`),
  createProject: (ws: string, body: { name: string; description?: string; template?: "sample" | "empty"; yaml?: string }) =>
    request<{ id: string }>("POST", `/api/workspaces/${ws}/projects`, body),
  project: (id: string) =>
    request<{ project: { id: string; workspace_id: string; name: string; description: string }; role: Role; version: number }>("GET", `/api/projects/${id}`),
  deleteProject: (id: string) => request("DELETE", `/api/projects/${id}`),
  model: (id: string) => request<{ version: number; yaml: string; role: Role }>("GET", `/api/projects/${id}/model`),
  saveModel: (id: string, yaml: string, baseVersion: number, message: string) =>
    request<{ version: number; ok: boolean; diagnostics: Diagnostic[] }>("PUT", `/api/projects/${id}/model`, { yaml, base_version: baseVersion, message }),
  versions: (id: string) => request<{ versions: VersionInfo[] }>("GET", `/api/projects/${id}/versions`),
  versionYaml: (id: string, v: number) => request<{ version: number; yaml: string }>("GET", `/api/projects/${id}/versions/${v}`),
  diff: (id: string, from: number, to: number) => request<{ diff: string }>("GET", `/api/projects/${id}/diff?from=${from}&to=${to}`),
  preview: (id: string, version?: number) => request<Preview>("GET", `/api/projects/${id}/preview${version ? `?version=${version}` : ""}`),
  layout: (id: string) => request<{ positions: Record<string, { x: number; y: number }> }>("GET", `/api/projects/${id}/layout`),
  saveLayout: (id: string, positions: Record<string, { x: number; y: number }>) => request("PUT", `/api/projects/${id}/layout`, { positions }),
  board: (id: string) => request<{ version: number; board: Board; updated_at: string | null; updated_by: string | null; role: Role }>("GET", `/api/projects/${id}/board`),
  saveBoard: (id: string, board: Board, baseVersion: number) => request<{ version: number; board: Board }>("PUT", `/api/projects/${id}/board`, { board, base_version: baseVersion }),
  validate: (yaml: string) => request<{ ok: boolean; diagnostics: Diagnostic[]; rules: RuleUsage[] }>("POST", "/api/validate", { yaml }),
};
