import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Hono } from "hono";

/**
 * Serves the built Web UI (packages/web/dist): files by path, index.html for every other non-API path
 * (client-side routes). Malformed paths are a 400, never a 500; source maps are not served unless asked for.
 */
export function serveWebApp(app: Hono<any>, dist: string, options: { sourceMaps?: boolean } = {}): void {
  app.get("*", async (c) => {
    if (!existsSync(dist)) return c.text("Web UI not built. Run `bun run build:web`, or use `bun run dev:web` for development.", 404);
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: "Malformed path" }, 400);
    }
    if (path.includes("\0")) return c.json({ error: "Malformed path" }, 400);
    if (path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
    if (!options.sourceMaps && path.endsWith(".map")) return c.json({ error: "Not found" }, 404);
    const rel = normalize(path).replace(/^([/\\]*\.\.([/\\]|$))+/, "");
    const full = join(dist, rel);
    // Never outside dist, whatever the path normalizes to.
    if (full !== dist && !full.startsWith(dist.endsWith(sep) ? dist : dist + sep)) return c.json({ error: "Not found" }, 404);
    const file = Bun.file(full);
    if (rel !== "/" && rel !== sep && (await file.exists())) return new Response(file);
    return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}
