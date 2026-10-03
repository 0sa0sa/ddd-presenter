import { describe, expect, test } from "bun:test";
import { ApiError, describeError, OFFLINE_MESSAGE, request } from "../src/api.ts";

const fakeFetch = (impl: () => Response | Promise<Response>) => (async () => impl()) as unknown as typeof fetch;

async function error(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("API client error handling", () => {
  test("a stopped server (fetch rejects) becomes a readable offline error, not 'TypeError: Failed to fetch'", async () => {
    const e = await error(
      request("GET", "/api/me", undefined, (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
    expect(e.message).toBe(OFFLINE_MESSAGE);
    expect(describeError(e)).not.toContain("TypeError");
  });

  test("a proxy error page (Vite returns 500 HTML when the API is down) is reported as offline", async () => {
    const e = await error(request("GET", "/api/me", undefined, fakeFetch(() => new Response("<html>proxy error</html>", { status: 500 }))));
    expect(e.status).toBe(0);
    expect(e.message).toBe(OFFLINE_MESSAGE);
  });

  test("an empty 502 from the Vite proxy (API server stopped) is reported as offline, not 'Bad Gateway'", async () => {
    const e = await error(request("GET", "/api/x", undefined, fakeFetch(() => new Response("", { status: 502, statusText: "Bad Gateway" }))));
    expect(e.status).toBe(0);
    expect(e.message).toBe(OFFLINE_MESSAGE);
  });

  test("a real API 500 keeps its own message", async () => {
    const e = await error(request("GET", "/api/x", undefined, fakeFetch(() => Response.json({ error: "Internal server error" }, { status: 500 }))));
    expect(e.status).toBe(500);
    expect(e.message).toBe("Internal server error");
  });

  test("another application answering on the port is detected", async () => {
    const e = await error(request("GET", "/api/me", undefined, fakeFetch(() => new Response("<html>not found</html>", { status: 404 }))));
    expect(e.status).toBe(0);
    expect(e.message).toContain("別のアプリ");
  });

  test("API errors keep their status, message and body", async () => {
    const e = await error(
      request("GET", "/api/x", undefined, fakeFetch(() => Response.json({ error: "The model has errors", diagnostics: [{ code: "x" }] }, { status: 400 }))),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe("The model has errors");
    expect(e.body.diagnostics).toEqual([{ code: "x" }]);
  });

  test("successful JSON and empty bodies", async () => {
    expect(await request<unknown>("GET", "/api/x", undefined, fakeFetch(() => Response.json({ ok: 1 })))).toEqual({ ok: 1 });
    expect(await request<unknown>("POST", "/api/x", undefined, fakeFetch(() => new Response("", { status: 200 })))).toEqual({});
  });
});

describe("server messages in Japanese", () => {
  test("sign-in, limit and AI errors are shown in Japanese; unknown messages pass through", async () => {
    const { localizeMessage } = await import("../src/api.ts");
    expect(localizeMessage("Invalid username or password")).toBe("ユーザー名かパスワードが違います");
    expect(localizeMessage("password must be at least 8 characters")).toBe("パスワードは 8 文字以上にしてください");
    expect(localizeMessage("Too many failed sign-ins; try again in 15 minutes")).toContain("15分");
    expect(localizeMessage("Too many AI requests; wait a moment and try again")).toContain("AI へのリクエスト");
    expect(localizeMessage("A board can hold up to 3000 stickies")).toBe("ボードに置ける付箋は 3000 枚までです");
    expect(localizeMessage("Something new")).toBe("Something new");
  });
});
