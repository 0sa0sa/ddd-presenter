import type { Diagnostic, RuleUsage } from "@ddd/core";

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? res.statusText), data);
  return data as T;
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

export const api = {
  users: () => request<{ users: { username: string }[] }>("GET", "/api/users"),
  login: (username: string) => request<{ user: Me["user"] }>("POST", "/api/login", { username }),
  logout: () => request("POST", "/api/logout"),
  me: () => request<Me>("GET", "/api/me"),
  createWorkspace: (name: string) => request<{ id: string }>("POST", "/api/workspaces", { name }),
  workspace: (ws: string) => request<{ workspace: { id: string; name: string }; role: Role }>("GET", `/api/workspaces/${ws}`),
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
  validate: (yaml: string) => request<{ ok: boolean; diagnostics: Diagnostic[]; rules: RuleUsage[] }>("POST", "/api/validate", { yaml }),
};
