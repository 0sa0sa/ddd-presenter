import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assistantsFromEnv, PROVIDER_LABEL, type ProviderId } from "./ai.ts";
import { createApp, purgeExpiredSessions } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { openDatabase } from "./db.ts";
import { serveWebApp } from "./static.ts";

const config = configFromEnv();
const { port, host } = config;
const dbPath = process.env.DDD_DB ?? join(import.meta.dir, "../data/ddd.sqlite");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const assistants = assistantsFromEnv();
const app = createApp(db, { ...config.app, assistants });

// Serve the built web app (packages/web/dist) when present; the Vite dev server proxies /api otherwise.
serveWebApp(app, join(import.meta.dir, "../../web/dist"), { sourceMaps: config.sourceMaps });

// Expired sessions are removed hourly (and on every sign-in).
purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 3600_000).unref();

try {
  // 4 MB is the most any route accepts (boards: 2 MB, models: ~1.3 MB); larger bodies are cut off by Bun.
  Bun.serve({ port, hostname: host.replace(/^\[|\]$/g, ""), fetch: app.fetch, maxRequestBodySize: 4 * 1024 * 1024 });
} catch (e) {
  const code = (e as { code?: string }).code;
  if (code === "EADDRINUSE") {
    console.error(`ポート ${port} は別のプロセスが使用中です。PORT=<空いている番号> bun run dev:server で起動し、Web側は DDD_PORT=<同じ番号> bun run dev:web で指定してください。`);
    process.exit(1);
  }
  throw e;
}
const shown = config.loopback ? "localhost" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
console.log(
  `DDD Presenter server on http://${shown}:${port} (listening on ${host}; db: ${dbPath}; AI: ${Object.keys(assistants).length ? (Object.keys(assistants) as ProviderId[]).map((id) => PROVIDER_LABEL[id]).join(", ") : "off - set ANTHROPIC_API_KEY or install the claude / codex CLI"})`,
);
for (const w of config.warnings) console.warn(w);
