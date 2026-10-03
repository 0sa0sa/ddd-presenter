import type { AppOptions } from "./app.ts";
import { isLoopback } from "./security.ts";

/** Everything main.ts reads from the environment (documented in the README, "セキュアに動かす"). */
export interface ServerConfig {
  port: number;
  host: string;
  loopback: boolean;
  sourceMaps: boolean;
  app: Omit<AppOptions, "assistant" | "assistants">;
  warnings: string[];
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  /** Default port; 8787 is commonly taken by other local dev servers. Override with PORT or DDD_PORT. */
  const port = Number(env.PORT ?? env.DDD_PORT ?? 4870);
  // Loopback unless the operator asks otherwise (DDD_HOST first: zsh keeps a HOST shell variable).
  const host = (env.DDD_HOST ?? env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const warnings: string[] = [];

  const dev = env.DDD_DEV_LOGIN;
  const devLogin: AppOptions["devLogin"] = dev === "1" ? true : dev === "0" ? false : "auto";
  const trustedUserHeader = env.DDD_TRUSTED_USER_HEADER?.trim() || undefined;
  const allowed = list(env.DDD_ALLOWED_HOSTS);
  // "Only this machine reaches the server": a loopback address, and no other host names allowed (those mean a
  // reverse proxy on this machine relays requests from the network), and no proxy-authenticated users.
  const loopback = isLoopback(host) && allowed.every(isLoopback) && !trustedUserHeader;
  const wildcardBind = host === "0.0.0.0" || host === "::" || host === "[::]";
  const allowedHosts: AppOptions["allowedHosts"] = allowed.includes("*") ? "*" : [...allowed, ...(!isLoopback(host) && !wildcardBind ? [host] : [])];
  const workspaces = list(env.DDD_AI_WORKSPACES);
  const app: ServerConfig["app"] = {
    secureCookies: env.DDD_SECURE_COOKIES === "1",
    loopback,
    devLogin,
    trustedUserHeader,
    registration: env.DDD_REGISTRATION === "closed" ? "closed" : "open",
    allowedHosts,
    aiAdmins: env.DDD_AI_ADMINS !== undefined ? list(env.DDD_AI_ADMINS) : undefined,
    aiWorkspaces: env.DDD_AI_WORKSPACES !== undefined ? (workspaces.includes("*") ? "*" : workspaces) : undefined,
    aiRate: { perMinute: Number(env.DDD_AI_RATE_PER_MIN) || 30, burst: Number(env.DDD_AI_BURST) || 10 },
  };

  if (!isLoopback(host)) {
    warnings.push(`警告: ${host} で待ち受けます（このマシンの外からも接続できます）。パスワードでのログインが必要です。HTTPS の裏で動かし DDD_SECURE_COOKIES=1 を設定してください。`);
    if (devLogin === true) warnings.push("警告: DDD_DEV_LOGIN=1 です。ネットワークの誰でもユーザー名だけで任意のユーザーになれます。");
    if (wildcardBind && allowedHosts !== "*" && allowed.length === 0) warnings.push("注意: DDD_ALLOWED_HOSTS が未設定のため、localhost 以外のホスト名でのアクセスは 421 で拒否されます。");
  }
  if (isLoopback(host) && !loopback && devLogin === true) warnings.push("警告: DDD_DEV_LOGIN=1 です。DDD_ALLOWED_HOSTS のホスト名で届く要求も、ユーザー名だけで任意のユーザーになれます。");
  if (allowedHosts === "*") warnings.push("警告: DDD_ALLOWED_HOSTS=* です。DNS リバインディング対策が無効になります。");
  if (trustedUserHeader) warnings.push(`注意: ${trustedUserHeader} ヘッダーをユーザー名として信頼します。このサーバーに届くのが認証プロキシ経由の要求だけで、プロキシがクライアントからの同名ヘッダーを消すことを確認してください。`);
  return { port, host, loopback, sourceMaps: env.DDD_SERVE_SOURCEMAPS === "1", app, warnings };
}
