import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DDD_DB ?? join(import.meta.dir, "../data/ddd.sqlite");
if (dbPath !== ":memory:") {
  const dir = join(dbPath, "..");
  if (!existsSync(dir)) await Bun.write(join(dir, ".keep"), "");
}
const db = openDatabase(dbPath);
const app = createApp(db, { secureCookies: process.env.DDD_SECURE_COOKIES === "1" });

// Serve the built web app (packages/web/dist) when present; the Vite dev server proxies /api otherwise.
const dist = join(import.meta.dir, "../../web/dist");
app.get("*", async (c) => {
  if (!existsSync(dist)) return c.text("Web UI not built. Run `bun run build:web`, or use `bun run dev:web` for development.", 404);
  const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(dist, rel));
  if (rel !== "/" && (await file.exists())) return new Response(file);
  return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
});

console.log(`DDD Presenter server on http://localhost:${port} (db: ${dbPath})`);
export default { port, fetch: app.fetch };
