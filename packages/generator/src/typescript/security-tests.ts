/**
 * Generated tests of the HTTP API's security parts that do not depend on one context (docs/09 §20): the bearer JWT
 * authenticator against keys made in the test (valid, expired, wrong issuer / audience, `alg: none`, an HMAC token
 * signed with the public key), the token bucket with a fake clock, the RateLimit headers, the client's typed errors
 * and the recommended retry policy.
 */
import { claimType, servedOverHttp, type UseCaseIR } from "@ddd/core";
import { contextKey } from "./api.ts";
import { Code, TsImports, tsString } from "./code.ts";
import type { TsFile } from "./domain.ts";
import { usesJwt } from "./security.ts";
import type { TsLayout } from "./layout.ts";
import { prop } from "./names.ts";
import { principalLiteral, testFile } from "./tests.ts";
import { record } from "./values.ts";

const ORIGIN = "http://localhost";

/** A sample claim value of a declared claim type (what the test token carries). */
function sampleClaim(type: string): unknown {
  const t = claimType(type);
  if (t?.k === "list") return ["sample"];
  if (t?.k === "primitive" && t.name === "UUID") return "00000000-0000-4000-8000-0000000000c1";
  if (t?.k === "primitive" && t.name === "Integer") return 7;
  if (t?.k === "primitive" && t.name === "Boolean") return true;
  return "sample";
}

/** An object key as Prettier prints it (quotes only where needed). */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : tsString(name);
}

function literal(v: unknown): string {
  return Array.isArray(v) ? `[${v.map(literal).join(", ")}]` : typeof v === "string" ? tsString(v) : String(v);
}

export function securityTestFile(Ls: TsLayout[]): TsFile | undefined {
  const L = Ls[0];
  if (!L?.model.security || !L.model.generation.typescript.api) return undefined;
  const module = [L.model.generation.testsDir, "generated", "security.test"].filter((p) => p && p !== ".").join("/");
  const imp = new TsImports(module);
  const c = new Code();
  if (usesJwt(L.model)) jwtTests(L, c, imp);
  rateLimitTests(L, c, imp);
  clientTests(Ls, c, imp);
  return testFile(L, module, "Security of the HTTP API: bearer JWT authentication, token-bucket rate limiting, the client's typed errors and retry policy.", imp, c.toString());
}

function jwtTests(L: TsLayout, c: Code, imp: TsImports): void {
  const sec = L.model.security!;
  const auth = sec.authentication!;
  const alg = auth.algorithms[0]!;
  const hmac = alg.startsWith("HS");
  imp.value("jose", "SignJWT");
  imp.type("jose", "JWTPayload");
  imp.value(L.apiModule("authentication"), "createBearerJwtAuthenticator");
  imp.value(L.security, "Unauthenticated");
  imp.value(L.contextTesting, "expectRejects");
  const issuer = auth.issuer ?? "https://issuer.test/";
  const audience = auth.audience ?? "api.test";
  const sub = sec.principal.idType === "UUID" ? "00000000-0000-4000-8000-0000000000aa" : "user-1";
  c.line();
  c.line(`const ISSUER = ${tsString(issuer)};`);
  c.line(`const AUDIENCE = ${tsString(audience)};`);
  c.line(`const ALG = ${tsString(alg)};`);
  if (hmac) {
    c.comment("The shared secret of the HS* algorithm (32 random bytes).");
    c.line("const key = crypto.getRandomValues(new Uint8Array(32));");
    c.line("const signingKey = key;");
  } else {
    imp.value("jose", "exportSPKI", "generateKeyPair");
    c.comment("A key pair made for the test: the authenticator gets the public key, the tokens are signed with the private key.");
    c.line("const { publicKey, privateKey: signingKey } = await generateKeyPair(ALG, { extractable: true });");
    c.line("const key = publicKey;");
  }
  const options = [`key`, ...(auth.issuer === undefined ? ["issuer: ISSUER"] : []), ...(auth.audience === undefined ? ["audience: AUDIENCE"] : [])];
  c.line(`const authenticate = createBearerJwtAuthenticator({ ${options.join(", ")} });`);
  c.line();
  c.doc("A token as the identity provider issues it; `change` alters the claims or the signing.");
  c.line("async function token(");
  c.indent(() => {
    c.line("claims: JWTPayload = {},");
    c.open("change: {", () => {
      c.line("readonly issuer?: string;");
      c.line("readonly audience?: string;");
      c.line("readonly expires?: string | number;");
    }, "} = {},");
  });
  c.block("): Promise<string>", () => {
    c.line("return await new SignJWT(claims)");
    c.indent(() => {
      c.line(".setProtectedHeader({ alg: ALG })");
      c.line(`.setSubject(${tsString(sub)})`);
      c.line(".setIssuer(change.issuer ?? ISSUER)");
      c.line(".setAudience(change.audience ?? AUDIENCE)");
      c.line(".setIssuedAt()");
      c.line('.setExpirationTime(change.expires ?? "5m")');
      c.line(".sign(signingKey);");
    });
  });
  c.line();
  c.doc("A request carrying `Authorization: Bearer <value>` (none for undefined).");
  c.block("function request(value?: string): Request", () => {
    c.line("const headers: Record<string, string> =");
    c.indent(() => c.line("value === undefined ? {} : { authorization: `Bearer ${value}` };"));
    c.line(`return new Request(${tsString(`${ORIGIN}/`)}, { headers });`);
  });
  c.line();
  c.doc("base64url of a JSON value (for hand-made tokens).");
  c.block("function base64url(value: unknown): string", () => {
    c.line('return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\\+/g, "-").replace(/\\//g, "_");');
  });
  const roles = sec.roles.slice(0, 2);
  const claims = sec.principal.claims.map((cl) => ({ cl, v: sampleClaim(cl.type) }));
  c.line();
  c.block('describe("bearer JWT authentication (RFC 6750, RFC 7519, RFC 8725)", () =>', () => {
    c.doc(`\`sub\` is the id, \`${auth.rolesClaim}\` the roles (undeclared roles are dropped), the declared claims their values.`);
    c.block('test("a valid token becomes the principal", async () =>', () => {
      const payload = [`${key(auth.rolesClaim)}: [${[...roles, "not_a_declared_role"].map(tsString).join(", ")}]`, ...claims.map(({ cl, v }) => `${key(cl.claim ?? cl.name)}: ${literal(v)}`)];
      c.line(`const valid = await token({ ${payload.join(", ")} });`);
      const expected = principalLiteral(L, { anonymous: false, id: sub, roles, claims: Object.fromEntries(claims.map(({ cl, v }) => [cl.name, v])) }, imp);
      c.line(`expect(await authenticate(request(valid))).toEqual(${expected});`);
    }, ");");
    c.line();
    c.doc("Without credentials there is no principal: the handler answers 401 with `WWW-Authenticate: Bearer`.");
    c.block('test("no Authorization header: no principal", async () =>', () => {
      c.line("expect(await authenticate(request())).toBeNull();");
    }, ");");
    c.line();
    c.doc('Every rejected token is Unauthenticated with `error: "invalid_token"` (401 with that challenge).');
    c.block('test("expired, wrong issuer or audience, tampered or malformed tokens are invalid", async () =>', () => {
      c.line("const now = Math.floor(Date.now() / 1000);");
      c.line("const valid = await token();");
      c.line("const [header, payload] = valid.split(\".\");");
      c.open("const rejected = [", () => {
        c.comment(`Expired beyond the clock tolerance (${auth.clockTolerance} s).`);
        c.line(`await token({}, { expires: now - ${auth.clockTolerance + 60} }),`);
        c.line('await token({}, { issuer: "https://attacker.example/" }),');
        c.line('await token({}, { audience: "another-api" }),');
        c.comment("A valid header and payload with a forged signature.");
        c.line('`${header ?? ""}.${payload ?? ""}.${base64url("forged")}`,');
        c.line('"not-a-jwt",');
      }, "];");
      c.block("for (const value of rejected)", () => {
        c.line("const error = await expectRejects(() => authenticate(request(value)), Unauthenticated);");
        c.line('expect(error.details).toEqual({ error: "invalid_token" });');
      });
      c.comment("Not a bearer token at all.");
      c.line(`const basic = new Request(${tsString(`${ORIGIN}/`)}, { headers: { authorization: "Basic dXNlcjpwYXNz" } });`);
      c.line("await expectRejects(() => authenticate(basic), Unauthenticated);");
    }, ");");
    c.line();
    c.doc(
      hmac
        ? "Only the declared algorithms are accepted: an unsigned token (`alg: none`) is rejected."
        : "Only the declared algorithms are accepted (RFC 8725 §3.1): an unsigned token (`alg: none`) and an HS256 token whose HMAC secret is the public key (algorithm confusion) are rejected.",
    );
    c.block(`test(${tsString(hmac ? "alg none is rejected" : "alg none and HS256 signed with the public key are rejected")}, async () =>`, () => {
      c.line("const now = Math.floor(Date.now() / 1000);");
      c.line(`const claims = { sub: ${tsString(sub)}, iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300 };`);
      c.line('const unsigned = `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;');
      c.line("const tokens = [unsigned];");
      if (!hmac) {
        c.line("const secret = new TextEncoder().encode(await exportSPKI(publicKey));");
        c.line('tokens.push(await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(secret));');
      }
      c.block("for (const value of tokens)", () => {
        c.line("await expectRejects(() => authenticate(request(value)), Unauthenticated);");
      });
    }, ");");
  }, ");");
}

function rateLimitTests(L: TsLayout, c: Code, imp: TsImports): void {
  imp.value(L.apiModule("rate-limit"), "InMemoryRateLimitStore", "RateLimiter", "rateLimitHeaders", "takeToken");
  imp.type(L.apiModule("rate-limit"), "RateLimitPolicy");
  c.line();
  c.block('describe("rate limiting (token bucket)", () =>', () => {
    c.line('const policy: RateLimitPolicy = { name: "example", requests: 2, windowSeconds: 10, by: "principal" };');
    c.line();
    c.doc("A bucket holds `requests` tokens and refills one every `windowSeconds / requests` seconds.");
    c.block('test("the bucket empties, refuses with the time to the next token, and refills", () =>', () => {
      c.line("let step = takeToken(null, policy, 0);");
      c.line("expect(step.decision).toEqual({ allowed: true, remaining: 1, retryAfter: 0, reset: 5 });");
      c.line("step = takeToken(step.state, policy, 0);");
      c.line("expect(step.decision).toEqual({ allowed: true, remaining: 0, retryAfter: 0, reset: 10 });");
      c.line("step = takeToken(step.state, policy, 1_000);");
      c.line("expect(step.decision).toMatchObject({ allowed: false, remaining: 0, retryAfter: 4 });");
      c.line("step = takeToken(step.state, policy, 5_000);");
      c.line("expect(step.decision).toMatchObject({ allowed: true, remaining: 0 });");
      c.comment("A long pause refills the bucket up to its size, not beyond.");
      c.line("step = takeToken(step.state, policy, 3_600_000);");
      c.line("expect(step.decision).toMatchObject({ allowed: true, remaining: 1 });");
    }, ");");
    c.line();
    c.doc("The limiter keeps one bucket per policy and subject; `now` is injected (a fake clock).");
    c.block('test("buckets are per subject; a fake clock moves time", async () =>', () => {
      c.line("let now = 0;");
      c.line("const limiter = new RateLimiter({ store: new InMemoryRateLimitStore(), now: () => now });");
      c.line('expect((await limiter.consume(policy, "alice")).allowed).toBe(true);');
      c.line('expect((await limiter.consume(policy, "alice")).allowed).toBe(true);');
      c.line('expect((await limiter.consume(policy, "alice")).allowed).toBe(false);');
      c.line('expect((await limiter.consume(policy, "bob")).allowed).toBe(true);');
      c.line("now += 5_000;");
      c.line('expect((await limiter.consume(policy, "alice")).allowed).toBe(true);');
    }, ");");
    c.line();
    c.doc("draft-ietf-httpapi-ratelimit-headers: `RateLimit-Policy` (quota q, window w) and `RateLimit` (remaining r, seconds t); Retry-After on refusal.");
    c.block('test("RateLimit header fields", () =>', () => {
      c.line("const refused = takeToken({ tokens: 0, updatedAt: 0 }, policy, 0).decision;");
      c.block("expect(rateLimitHeaders(policy, refused)).toEqual(", () => {
        c.line('"ratelimit-policy": \'"example";q=2;w=10\',');
        c.line('ratelimit: \'"example";r=0;t=5\',');
        c.line('"retry-after": "5",');
      }, ");");
      c.line("const allowed = takeToken(null, policy, 0).decision;");
      c.line('expect(rateLimitHeaders(policy, allowed)).not.toHaveProperty("retry-after");');
    }, ");");
  }, ");");
}

function clientTests(Ls: TsLayout[], c: Code, imp: TsImports): void {
  const L = Ls[0]!;
  imp.value(L.apiModule("runtime"), "ApiError", "apiRetry", "apiRetryDelay", "RateLimitedError");
  imp.value(L.security, "NotAuthorized", "Unauthenticated");
  imp.value(L.contextTesting, "expectRejects");
  let target: { L: TsLayout; uc: UseCaseIR } | undefined;
  for (const x of Ls) {
    const uc = x.ca.ir.useCases.find((u) => servedOverHttp(u) && u.scenarios.length);
    if (uc) {
      target = { L: x, uc };
      break;
    }
  }
  c.line();
  c.block('describe("client errors and the retry policy", () =>', () => {
    if (target) {
      const { L: T, uc } = target;
      imp.value(L.apiModule("client"), "createApiClient");
      c.doc(
        `The client sends the token of \`getToken\` and rejects 401 with Unauthenticated, 403 with NotAuthorized and 429 with RateLimitedError (\`retryAfter\` from Retry-After), here for \`${uc.name}\`.`,
      );
      c.block('test("typed errors for 401, 403 and 429; getToken is sent as a bearer token", async () =>', () => {
        c.line("const sent: (string | null)[] = [];");
        c.line("const responses = [");
        c.indent(() => {
          c.line('Response.json({ code: "unauthenticated", message: "Authentication is required" }, { status: 401 }),');
          c.line('Response.json({ code: "not_authorized", message: "You are not allowed to do this" }, { status: 403 }),');
          c.line('Response.json({ code: "rate_limited", message: "Too many requests" }, { status: 429, headers: { "retry-after": "7" } }),');
        });
        c.line("];");
        c.block("const api = createApiClient(", () => {
          c.line(`baseUrl: ${tsString(ORIGIN)},`);
          c.line('getToken: () => "token-1",');
          c.block("fetch: (request) =>", () => {
            c.line('sent.push(request.headers.get("authorization"));');
            c.line('const response = responses.shift() ?? Response.json({}, { status: 500 });');
            c.line("return Promise.resolve(response);");
          }, ",");
        }, ");");
        c.line(`const call = () => api.${contextKey(T)}.useCases.${prop(uc.name)}(${record(uc.command, uc.scenarios[0]!.when.input, imp, T)});`);
        c.line("await expectRejects(call, Unauthenticated);");
        c.line("await expectRejects(call, NotAuthorized);");
        c.line("const limited = await expectRejects(call, RateLimitedError);");
        c.line("expect(limited.retryAfter).toBe(7);");
        c.line("expect(limited.status).toBe(429);");
        c.line('expect(sent).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-1"]);');
      }, ");");
      c.line();
    }
    c.doc("Never retry an answer that would not change (4xx, domain errors); retry network failures, 5xx and 429, which waits for Retry-After.");
    c.block('test("apiRetry and apiRetryDelay", () =>', () => {
      c.line("expect(apiRetry(0, new RateLimitedError(3))).toBe(true);");
      c.line("expect(apiRetry(3, new RateLimitedError(3))).toBe(false);");
      c.line('expect(apiRetry(0, new ApiError(503, "internal_error", "Unavailable"))).toBe(true);');
      c.line('expect(apiRetry(0, new ApiError(0, "network_error", "Offline"))).toBe(true);');
      c.line('expect(apiRetry(0, new ApiError(404, "route_not_found", "No endpoint"))).toBe(false);');
      c.line("expect(apiRetry(0, new NotAuthorized())).toBe(false);");
      c.line("expect(apiRetry(0, new Unauthenticated())).toBe(false);");
      c.line("expect(apiRetryDelay(0, new RateLimitedError(7))).toBe(7_000);");
      c.line("expect(apiRetryDelay(0, new RateLimitedError(3_600))).toBe(60_000);");
      c.line('expect(apiRetryDelay(2, new ApiError(500, "internal_error", "Failed"))).toBe(4_000);');
      c.line('expect(apiRetryDelay(9, new ApiError(500, "internal_error", "Failed"))).toBe(30_000);');
    }, ");");
  }, ");");
}
