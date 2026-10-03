/**
 * HTTP hardening shared by the API and the static Web UI: host allowlist (DNS rebinding), security headers,
 * and small in-memory rate limiters. See docs/09 §11 for the decisions.
 */

/** Host names a loopback-bound server answers to without configuration. */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/** `Host` header (or URL host) → lowercase host name without the port; IPv6 keeps its brackets. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  return colon >= 0 ? h.slice(0, colon) : h;
}

/** True for addresses / names that only the local machine can reach. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Content Security Policy for the built SPA: scripts only from this origin (Vite emits external module
 * scripts, no inline ones); styles from this origin plus Google Fonts, and inline `<style>` elements because
 * CodeMirror injects its theme at runtime; images from data:/blob: for board and diagram exports.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The response with the security headers set (a copy when its headers are immutable). */
export function withSecurityHeaders(res: Response): Response {
  let out = res;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  } catch {
    out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  }
  return out;
}

/** Token bucket per key: `burst` requests at once, refilled at `perMinute`. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly perMinute: number,
    readonly burst: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Takes one token; `retryAfter` (seconds) when none is left. */
  take(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.clock();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (this.buckets.size > 10_000) this.buckets.clear(); // bounded memory; a reset only loosens the limit briefly
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: rate > 0 ? Math.ceil((1 - b.tokens) / rate / 1000) : 60 };
  }
}

/** Failed sign-ins per account: after `max` failures within `windowMs`, further attempts are refused until it passes. */
export class FailureThrottle {
  private readonly failures = new Map<string, { count: number; since: number }>();
  constructor(
    readonly max = 10,
    readonly windowMs = 15 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const f = this.failures.get(key);
    if (!f) return false;
    if (this.clock() - f.since > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return f.count >= this.max;
  }

  fail(key: string): void {
    const t = this.clock();
    const f = this.failures.get(key);
    if (!f || t - f.since > this.windowMs) {
      if (this.failures.size > 10_000) this.failures.clear();
      this.failures.set(key, { count: 1, since: t });
    } else f.count++;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
