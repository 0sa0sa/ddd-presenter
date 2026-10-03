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
/** Japanese wording for the server messages people see (the server keeps English for the CLI and logs). */
const MESSAGE_JA: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^Invalid username or password$/, "ユーザー名かパスワードが違います"],
  [/^This account has a password; sign in with it$/, "このアカウントにはパスワードがあります。パスワードでログインしてください"],
  [/^That username is taken$/, "そのユーザー名はすでに使われています"],
  [/^Registration is closed; ask the administrator for an account$/, "アカウントの登録は締め切られています。管理者にアカウントを作ってもらってください"],
  [/^The current password is incorrect$/, "いまのパスワードが違います"],
  [/^(\w+) must be at least (\d+) characters$/, (m) => `パスワードは ${m[2]} 文字以上にしてください`],
  [/^password is required$/, "パスワードを入力してください"],
  [/^username may contain letters, digits/, "ユーザー名に使えるのは英数字と . - _ だけです"],
  [/^Not logged in$/, "ログインしていません。もう一度ログインしてください"],
  [/^Too many failed (sign-ins|attempts)/, "失敗が続いたため、15分ほど操作できません。時間をおいてやり直してください"],
  [/^Too many AI requests/, "AI へのリクエストが多すぎます。少し待ってからやり直してください"],
  [/^Only users the server operator allows \(DDD_AI_ADMINS\) can turn AI on$/, "AI をオンにできるのは、サーバーの運用者が許可した人だけです（DDD_AI_ADMINS）"],
  [/^AI assistance is not enabled for this workspace$/, "このワークスペースでは AI の提案がオフです"],
  [/^Free-form proposals need AI to be enabled for this workspace$/, "自由な指示での提案には、ワークスペースで AI をオンにする必要があります"],
  [/^A board can hold up to (\d+) stickies$/, (m) => `ボードに置ける付箋は ${m[1]} 枚までです`],
  [/^A project can have up to (\d+) boards$/, (m) => `ボードはプロジェクトに ${m[1]} 枚までです`],
  [/^The model is larger than 1 MB/, "モデルが 1 MB を超えています。コンテキストやプロジェクトを分けてください"],
  [/^The main board cannot be deleted$/, "メインのボードは削除できません"],
];

export function localizeMessage(message: string): string {
  for (const [re, ja] of MESSAGE_JA) {
    const m = message.match(re);
    if (m) return typeof ja === "string" ? ja : ja(m);
  }
  return message;
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return localizeMessage(e.message);
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return `予期しないエラー: ${String(e)}`;
}

export interface Me {
  user: { id: string; username: string; has_password?: boolean };
  workspaces: { id: string; name: string; role: Role }[];
  /** Signed in through the authenticating proxy (SSO); sign-out happens there. */
  proxy_auth?: boolean;
}

/** What the sign-in page offers (public). `users` exists only in dev-login mode. */
export interface AuthConfig {
  dev_login: boolean;
  registration: boolean;
  proxy_auth: boolean;
  users?: string[];
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

export interface BoardSummary {
  id: string;
  name: string;
  version: number;
  stickies: number;
  updated_at: string | null;
  updated_by: string | null;
}

export const api = {
  health: async () => {
    const r = await request<{ service?: string }>("GET", "/api/health");
    if (r.service !== "ddd-presenter") throw new ApiError(0, "接続先がDDD Presenterのサーバーではありません。ポート設定（PORT / DDD_PORT）を確認してください。", {});
    return r;
  },
  authConfig: () => request<AuthConfig>("GET", "/api/auth/config"),
  users: () => request<{ users: { username: string }[] }>("GET", "/api/users"),
  login: (username: string, password?: string) => request<{ user: Me["user"] }>("POST", "/api/login", password ? { username, password } : { username }),
  register: (username: string, password: string) => request<{ user: Me["user"] }>("POST", "/api/register", { username, password }),
  logout: () => request("POST", "/api/logout"),
  logoutEverywhere: () => request<{ ok: boolean; sessions: number }>("POST", "/api/logout-all"),
  changePassword: (newPassword: string, currentPassword?: string) =>
    request("POST", "/api/account/password", currentPassword === undefined ? { new_password: newPassword } : { current_password: currentPassword, new_password: newPassword }),
  me: () => request<Me>("GET", "/api/me"),
  createWorkspace: (name: string) => request<{ id: string }>("POST", "/api/workspaces", { name }),
  workspace: (ws: string) =>
    request<{
      workspace: { id: string; name: string; ai_enabled: boolean; ai_provider: AiProviderId | null };
      role: Role;
      ai_available: boolean;
      ai_model: string | null;
      ai_providers: AiProvider[];
      /** This user may turn AI on here (the server operator allows it: DDD_AI_ADMINS / DDD_AI_WORKSPACES). */
      ai_can_enable?: boolean;
      ai_active?: boolean;
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
  board: (id: string, boardId = "main") =>
    request<{ id: string; name: string; version: number; board: Board; updated_at: string | null; updated_by: string | null; role: Role }>("GET", `/api/projects/${id}/boards/${boardId}`),
  saveBoard: (id: string, board: Board, baseVersion: number, boardId = "main") =>
    request<{ version: number; board: Board }>("PUT", `/api/projects/${id}/boards/${boardId}`, { board, base_version: baseVersion }),
  boards: (id: string) => request<{ boards: BoardSummary[] }>("GET", `/api/projects/${id}/boards`),
  createBoard: (id: string, name: string) => request<{ id: string; name: string }>("POST", `/api/projects/${id}/boards`, { name }),
  renameBoard: (id: string, boardId: string, name: string) => request<{ id: string; name: string }>("PATCH", `/api/projects/${id}/boards/${boardId}`, { name }),
  deleteBoard: (id: string, boardId: string) => request<{ ok: boolean }>("DELETE", `/api/projects/${id}/boards/${boardId}`),
  validate: (yaml: string) => request<{ ok: boolean; diagnostics: Diagnostic[]; rules: RuleUsage[] }>("POST", "/api/validate", { yaml }),
};
