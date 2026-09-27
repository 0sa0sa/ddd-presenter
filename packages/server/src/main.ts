import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { assistantFromEnv } from "./ai.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

/** Default port; 8787 is commonly taken by other local dev servers. Override with PORT or DDD_PORT. */
const port = Number(process.env.PORT ?? process.env.DDD_PORT ?? 4870);
const dbPath = process.env.DDD_DB ?? join(import.meta.dir, "../data/ddd.sqlite");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const assistant = assistantFromEnv();
const app = createApp(db, { secureCookies: process.env.DDD_SECURE_COOKIES === "1", assistant });

// Serve the built web app (packages/web/dist) when present; the Vite dev server proxies /api otherwise.
const dist = join(import.meta.dir, "../../web/dist");
app.get("*", async (c) => {
  if (!existsSync(dist)) return c.text("Web UI not built. Run `bun run build:web`, or use `bun run dev:web` for development.", 404);
  const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(dist, rel));
  if (rel !== "/" && (await file.exists())) return new Response(file);
  return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
});

try {
  Bun.serve({ port, fetch: app.fetch });
} catch (e) {
  const code = (e as { code?: string }).code;
  if (code === "EADDRINUSE") {
    console.error(`ポート ${port} は別のプロセスが使用中です。PORT=<空いている番号> bun run dev:server で起動し、Web側は DDD_PORT=<同じ番号> bun run dev:web で指定してください。`);
    process.exit(1);
  }
  throw e;
}
console.log(`DDD Presenter server on http://localhost:${port} (db: ${dbPath}; AI: ${assistant ? assistant.model : "off - set ANTHROPIC_API_KEY to enable"})`);
