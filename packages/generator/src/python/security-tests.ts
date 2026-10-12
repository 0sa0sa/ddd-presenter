/**
 * Generated `tests/generated/test_security.py` (docs/09 §20): the PyJWT authenticator against keys made in the test
 * (valid, expired, wrong issuer / audience, forged, `alg: none`, an HMAC token signed with the public key), the
 * authorization checks, the token bucket with a fake clock and the RateLimit headers.
 */
import { claimType, DEFAULT_TENANT_IDS, roleIncludes, rolePermissions, usesPermissions, type ModelIR, type ResolvedPrincipal } from "@ddd/core";

import type { PyFile } from "./domain.ts";
import { assemble, type Layout } from "./layout.ts";
import { authenticationModule, rateLimitModule, securityModule } from "./security.ts";
import { Code, Imports, pyString } from "./support.ts";
import { principalPy } from "./tests.ts";

function sampleClaim(type: string): unknown {
  const t = claimType(type);
  if (t?.k === "list") return ["sample"];
  if (t?.k === "primitive" && t.name === "UUID") return "00000000-0000-4000-8000-0000000000c1";
  if (t?.k === "primitive" && t.name === "Integer") return 7;
  if (t?.k === "primitive" && t.name === "Boolean") return true;
  return "sample";
}

function jsonLiteral(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonLiteral).join(", ")}]`;
  if (typeof v === "boolean") return v ? "True" : "False";
  return typeof v === "string" ? pyString(v) : String(v);
}

/** Key generation of a JWS algorithm with `cryptography` (the private key, PEM-encoded below). */
function keyGeneration(alg: string, imp: Imports): string {
  if (alg.startsWith("ES")) {
    imp.from("cryptography.hazmat.primitives.asymmetric", "ec");
    const curve = alg === "ES256" ? "SECP256R1" : alg === "ES384" ? "SECP384R1" : "SECP521R1";
    return `ec.generate_private_key(ec.${curve}())`;
  }
  if (alg === "EdDSA") {
    imp.from("cryptography.hazmat.primitives.asymmetric", "ed25519");
    return "ed25519.Ed25519PrivateKey.generate()";
  }
  imp.from("cryptography.hazmat.primitives.asymmetric", "rsa");
  return "rsa.generate_private_key(public_exponent=65537, key_size=2048)";
}

export function securityTestFile(model: ModelIR, Ls: Layout[]): PyFile | undefined {
  const sec = model.security;
  const L = Ls[0];
  if (!sec || !L) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.import("pytest");
  const c = new Code();
  const secMod = securityModule(model);
  const auth = sec.authentication?.scheme === "bearer_jwt" ? sec.authentication : undefined;
  if (auth) {
    const alg = auth.algorithms[0]!;
    const hmacOnly = alg.startsWith("HS");
    imp.import("jwt");
    imp.import("time");
    imp.import("base64");
    imp.import("json");
    imp.from(authenticationModule(model), "BearerJwtAuthenticator");
    const sub = sec.principal.idType === "UUID" ? "00000000-0000-4000-8000-0000000000aa" : "user-1";
    c.line();
    c.line(`ISSUER = ${pyString(auth.issuer ?? "https://issuer.test/")}`);
    c.line(`AUDIENCE = ${pyString(auth.audience ?? "api.test")}`);
    c.line(`ALG = ${pyString(alg)}`);
    c.line(`SUBJECT = ${pyString(sub)}`);
    if (hmacOnly) {
      c.line('SIGNING_KEY = b"generated-test-secret-of-32-bytes!"');
      c.line("VERIFY_KEY = SIGNING_KEY");
    } else {
      imp.from("cryptography.hazmat.primitives", "serialization");
      c.line(`_PRIVATE_KEY = ${keyGeneration(alg, imp)}`);
      c.line("SIGNING_KEY = _PRIVATE_KEY.private_bytes(");
      c.indent(() => {
        c.line("serialization.Encoding.PEM,");
        c.line("serialization.PrivateFormat.PKCS8,");
        c.line("serialization.NoEncryption(),");
      });
      c.line(")");
      c.line("VERIFY_KEY = _PRIVATE_KEY.public_key().public_bytes(");
      c.indent(() => c.line("serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo"));
      c.line(")");
    }
    const extra = [...(auth.issuer === undefined ? ["issuer=ISSUER"] : []), ...(auth.audience === undefined ? ["audience=AUDIENCE"] : [])];
    c.line(`AUTHENTICATOR = BearerJwtAuthenticator(key=VERIFY_KEY${extra.map((x) => `, ${x}`).join("")})`);
    c.line().line();
    c.line("def _token(");
    c.indent(() => {
      c.line("claims: dict[str, object] | None = None,");
      c.line("*,");
      c.line("issuer: str = ISSUER,");
      c.line("audience: str = AUDIENCE,");
      c.line("expires_in: int = 300,");
    });
    c.line(") -> str:");
    c.indent(() => {
      c.docstring("A token as the identity provider issues it.");
      c.line("now = int(time.time())");
      c.line('payload = {"sub": SUBJECT, "iss": issuer, "aud": audience, "iat": now, "exp": now + expires_in}');
      c.line("return jwt.encode({**payload, **(claims or {})}, SIGNING_KEY, algorithm=ALG)");
    });
    c.line().line();
    c.line("def _b64(value: object) -> str:");
    c.indent(() => {
      c.docstring("base64url of a JSON value (for hand-made tokens).");
      c.line('return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()');
    });
    const roles = sec.roles.slice(0, 2);
    const claims = sec.principal.claims.map((cl) => ({ cl, v: sampleClaim(cl.type) }));
    c.line().line();
    const tenancy = sec.tenancy;
    const platform = sec.platformRoles.map((d) => d.name).slice(0, 1);
    c.line("def test_a_valid_token_becomes_the_principal() -> None:");
    c.indent(() => {
      c.docstring(`\`sub\` is the id, ${tenancy ? `\`${tenancy.claim}\` the active tenant, ` : ""}\`${auth.rolesClaim}\` the roles (undeclared roles are dropped), the declared claims their values.`);
      const payload = [
        ...(tenancy ? [`${pyString(tenancy.claim)}: ${pyString(DEFAULT_TENANT_IDS[tenancy.type])}`] : []),
        `${pyString(auth.rolesClaim)}: [${[...roles, "not_a_declared_role"].map(pyString).join(", ")}]`,
        ...(platform.length ? [`${pyString(tenancy!.platformRolesClaim)}: [${platform.map(pyString).join(", ")}]`] : []),
        ...claims.map(({ cl, v }) => `${pyString(cl.claim ?? cl.name)}: ${jsonLiteral(v)}`),
      ];
      const one = `token = _token({${payload.join(", ")}})`;
      if (one.length + 4 <= 100) c.line(one);
      else {
        c.line("token = _token(");
        c.indent(() => {
          c.line("{");
          c.indent(() => payload.forEach((p) => c.line(`${p},`)));
          c.line("}");
        });
        c.line(")");
      }
      const expected = principalPy(L, { anonymous: false, id: sub, roles, claims: Object.fromEntries(claims.map(({ cl, v }) => [cl.name, v])), ...(tenancy ? { tenant: DEFAULT_TENANT_IDS[tenancy.type], platformRoles: platform } : {}) }, imp);
      if (tenancy) {
        c.line(`expected = ${expected}`);
        c.line('assert AUTHENTICATOR.authenticate(f"Bearer {token}") == expected');
      } else c.line(`assert AUTHENTICATOR.authenticate(f"Bearer {token}") == ${expected}`);
    });
    if (tenancy) {
      c.line().line();
      c.line("def test_roles_need_an_active_tenant_and_platform_roles_their_own_claim() -> None:");
      c.indent(() => {
        c.docstring(
          `Tenant roles hold in the active tenant only: a token without \`${tenancy.claim}\` holds none.${platform.length ? ` Platform roles come from \`${tenancy.platformRolesClaim}\` only.` : ""}`,
        );
        const noTenant = [`${pyString(auth.rolesClaim)}: [${[...roles, ...platform].map(pyString).join(", ")}]`, ...(platform.length ? [`${pyString(tenancy.platformRolesClaim)}: [${roles.map(pyString).join(", ")}]`] : [])];
        c.line(`token = _token({${noTenant.join(", ")}})`);
        c.line('principal = AUTHENTICATOR.authenticate(f"Bearer {token}")');
        c.line("assert principal is not None");
        c.line("assert principal.tenant_id is None");
        c.line("assert principal.roles == ()");
        if (platform.length) c.line("assert principal.platform_roles == ()");
      });
    }
    c.line().line();
    c.line("def test_no_authorization_header_is_no_principal() -> None:");
    c.indent(() => c.line("assert AUTHENTICATOR.authenticate(None) is None"));
    c.line().line();
    c.line("@pytest.mark.parametrize(");
    c.indent(() => {
      c.line('"header",');
      c.line("[");
      c.indent(() => {
        c.line(`f"Bearer {_token(expires_in=-${auth.clockTolerance + 60})}",`);
        c.line('f"Bearer {_token(issuer=\'https://attacker.example/\')}",');
        c.line('f"Bearer {_token(audience=\'another-api\')}",');
        c.line('f"Bearer {_token().rsplit(\'.\', 1)[0]}.{_b64(\'forged\')}",');
        c.line('"Bearer not-a-jwt",');
        c.line('"Basic dXNlcjpwYXNz",');
      });
      c.line("],");
      c.line('ids=["expired", "wrong-issuer", "wrong-audience", "forged-signature", "malformed", "not-bearer"],');
    });
    c.line(")");
    c.line("def test_invalid_tokens_are_rejected(header: str) -> None:");
    c.indent(() => {
      c.docstring('Every rejected token is Unauthenticated with `error="invalid_token"` (answer 401 with that challenge).');
      imp.from(secMod, "Unauthenticated");
      c.line("with pytest.raises(Unauthenticated) as raised:");
      c.indent(() => c.line("AUTHENTICATOR.authenticate(header)"));
      c.line('assert raised.value.details == {"error": "invalid_token"}');
    });
    c.line().line();
    c.line(`def ${hmacOnly ? "test_alg_none_is_rejected" : "test_alg_none_and_hmac_signed_with_the_public_key_are_rejected"}() -> None:`);
    c.indent(() => {
      c.docstring(
        hmacOnly
          ? "Only the declared algorithms are accepted: an unsigned token (`alg: none`) is rejected."
          : "Only the declared algorithms are accepted (RFC 8725 §3.1).\n\nAn unsigned token (`alg: none`) and an HS256 token whose HMAC secret is the public key (algorithm confusion) are both rejected.",
      );
      c.line("now = int(time.time())");
      c.line('claims = _b64({"sub": SUBJECT, "iss": ISSUER, "aud": AUDIENCE, "iat": now, "exp": now + 300})');
      c.line('tokens = [f"{_b64({\'alg\': \'none\', \'typ\': \'JWT\'})}.{claims}."]');
      if (!hmacOnly) {
        imp.import("hashlib");
        imp.import("hmac");
        c.line('signing_input = f"{_b64({\'alg\': \'HS256\', \'typ\': \'JWT\'})}.{claims}"');
        c.line("signature = hmac.new(VERIFY_KEY, signing_input.encode(), hashlib.sha256).digest()");
        c.line('tokens.append(f"{signing_input}.{base64.urlsafe_b64encode(signature).rstrip(b\'=\').decode()}")');
      }
      imp.from(secMod, "Unauthenticated");
      c.line("for token in tokens:");
      c.indent(() => {
        c.line("with pytest.raises(Unauthenticated):");
        c.indent(() => c.line('AUTHENTICATOR.authenticate(f"Bearer {token}")'));
      });
    });
  }
  if (usesPermissions(sec) || sec.tenancy) {
    rbacTests(model, L, c, imp);
    rateLimitTests(model, c, imp);
    return { path: `${model.generation.testsDir}/generated/test_security.py`, content: assemble(model, "Security: bearer JWT authentication (PyJWT), roles and permissions, the authorization checks, token-bucket rate limiting.", imp, c.toString(), { exports: false }) };
  }
  // Authorization checks
  imp.from(secMod, "NotAuthorized", "Unauthenticated", "allow_if", "authorize");
  const role = sec.roles[0]!;
  const other = sec.roles.find((r) => r !== role);
  c.line().line();
  c.line("def test_authorize_needs_a_principal_with_one_of_the_roles() -> None:");
  c.indent(() => {
    c.docstring("The first check of every protected use case: Unauthenticated without a principal, NotAuthorized without a role.");
    c.line(`holder = ${principalPy(L, { anonymous: false, id: sec.principal.idType === "UUID" ? "00000000-0000-4000-8000-000000000001" : "user-1", roles: [role], claims: {} }, imp)}`);
    c.line(`assert authorize(holder, "action", (${pyString(role)},)) is holder`);
    c.line('assert authorize(holder, "action", ()) is holder');
    c.line("with pytest.raises(Unauthenticated):");
    c.indent(() => c.line(`authorize(None, "action", (${pyString(role)},))`));
    if (other) {
      c.line("with pytest.raises(NotAuthorized) as raised:");
      c.indent(() => c.line(`authorize(holder, "action", (${pyString(other)},))`));
      c.line(`assert raised.value.details == {"action": "action", "required_roles": [${pyString(other)}]}`);
    }
    c.line("with pytest.raises(NotAuthorized):");
    c.indent(() => c.line('allow_if(False, "action")'));
  });
  rateLimitTests(model, c, imp);
  return { path: `${model.generation.testsDir}/generated/test_security.py`, content: assemble(model, "Security: bearer JWT authentication (PyJWT), the authorization checks, token-bucket rate limiting.", imp, c.toString(), { exports: false }) };
}

/** The role hierarchy and permissions resolved at generation time, and the authorization checks by scope. */
function rbacTests(model: ModelIR, L: Layout, c: Code, imp: Imports): void {
  const sec = model.security!;
  const secMod = securityModule(model);
  const tenancy = sec.tenancy;
  const includes = roleIncludes(sec, "tenant");
  const perms = rolePermissions(sec, "tenant");
  const id = sec.principal.idType === "UUID" ? "00000000-0000-4000-8000-000000000001" : "user-1";
  const as = (roles: string[], extra: Partial<ResolvedPrincipal> = {}) =>
    principalPy(L, { anonymous: false, id, roles, claims: {}, ...(tenancy ? { tenant: DEFAULT_TENANT_IDS[tenancy.type], platformRoles: [] } : {}), ...extra }, imp);
  imp.from(secMod, "NotAuthorized", "Unauthenticated", "allow_if", "ROLE_INCLUDES", "ROLE_PERMISSIONS", "has_role", "has_permission");
  imp.from("types", "MappingProxyType");
  c.line().line();
  c.line("def test_the_role_hierarchy_and_permissions_are_resolved() -> None:");
  c.indent(() => {
    c.docstring("Each role includes itself and every role it inherits (NIST RBAC1); its permissions include the inherited roles' ones. The maps are read-only.");
    c.line("assert dict(ROLE_INCLUDES) == {");
    c.indent(() => [...includes].forEach(([r, inc]) => c.line(`${pyString(r)}: (${inc.map(pyString).join(", ")}${inc.length === 1 ? "," : ""}),`)));
    c.line("}");
    c.line("assert dict(ROLE_PERMISSIONS) == {");
    c.indent(() => [...perms].forEach(([r, ps]) => c.line(`${pyString(r)}: (${ps.map(pyString).join(", ")}${ps.length === 1 ? "," : ""}),`)));
    c.line("}");
    c.line("assert isinstance(ROLE_PERMISSIONS, MappingProxyType)");
    c.line("with pytest.raises(NotAuthorized):");
    c.indent(() => c.line('allow_if(False, "action")'));
  });
  const senior = [...includes].find(([, inc]) => inc.length > 1);
  if (senior) {
    const [role, inc] = senior;
    const junior = inc[1]!;
    const extra = (perms.get(role) ?? []).find((p) => !(perms.get(junior) ?? []).includes(p));
    const inherited = (perms.get(junior) ?? [])[0];
    c.line().line();
    c.line(`def test_${role}_inherits_${junior}() -> None:`);
    c.indent(() => {
      c.docstring(`${role} inherits ${junior}: holding ${role} satisfies has_role(${junior})${inherited ? ` and grants ${inherited}` : ""}; ${junior} does not hold ${role}.`);
      c.line(`senior = ${as([role])}`);
      c.line(`junior = ${as([junior])}`);
      c.line(`assert has_role(senior, ${pyString(junior)})`);
      c.line(`assert not has_role(junior, ${pyString(role)})`);
      if (inherited) c.line(`assert has_permission(senior, ${pyString(inherited)})`);
      if (extra) c.line(`assert not has_permission(junior, ${pyString(extra)})`);
      if (!tenancy) {
        imp.from(secMod, "authorize");
        c.line(`assert authorize(senior, "action", roles=(${pyString(junior)},)) is senior`);
        c.line("with pytest.raises(NotAuthorized):");
        c.indent(() => c.line(`authorize(junior, "action", roles=(${pyString(role)},))`));
      }
    });
  }
  if (!tenancy) return;
  const anyPerm = [...perms].find(([, ps]) => ps.length);
  if (anyPerm) {
    imp.from(secMod, "authorize_in_tenant");
    const [role, ps] = anyPerm;
    const p = ps[0]!;
    c.line().line();
    c.line("def test_authorize_in_tenant_needs_a_principal_an_active_tenant_and_the_roles_in_it() -> None:");
    c.indent(() => {
      c.docstring(`No principal is Unauthenticated, no active tenant is Unauthenticated (missing_tenant), a role without ${p} is NotAuthorized naming it.`);
      c.line("with pytest.raises(Unauthenticated) as anonymous:");
      c.indent(() => c.line(`authorize_in_tenant(None, "action", permissions=(${pyString(p)},))`));
      c.line('assert anonymous.value.details == {"action": "action"}');
      c.line(`tenantless = ${as([role], { tenant: null })}`);
      c.line("with pytest.raises(Unauthenticated) as no_tenant:");
      c.indent(() => c.line(`authorize_in_tenant(tenantless, "action", permissions=(${pyString(p)},))`));
      c.line('assert no_tenant.value.details == {"action": "action", "error": "missing_tenant"}');
      c.line(`holder = ${as([role])}`);
      c.line(`assert authorize_in_tenant(holder, "action", permissions=(${pyString(p)},)) == (holder, holder.tenant_id)`);
      c.line(`none = ${as([])}`);
      c.line("with pytest.raises(NotAuthorized) as refused:");
      c.indent(() => c.line(`authorize_in_tenant(none, "action", permissions=(${pyString(p)},))`));
      c.line(`assert refused.value.details == {"action": "action", "required_permissions": [${pyString(p)}]}`);
    });
  }
  const pr = [...rolePermissions(sec, "platform")].find(([, ps]) => ps.length);
  if (pr) {
    imp.from(secMod, "authorize_across_tenants", "authorize_in_tenant");
    const [prole, pps] = pr;
    const p = pps[0]!;
    c.line().line();
    c.line("def test_platform_roles_act_across_tenants_only() -> None:");
    c.indent(() => {
      c.docstring(`Across tenants only platform roles count: ${prole} may act with ${p}; every tenant role together may not; in a tenant, the platform role alone does not count.`);
      c.line(`operator = ${as([], { platformRoles: [prole], tenant: null })}`);
      c.line(`acting = authorize_across_tenants(operator, "action", permissions=(${pyString(p)},))`);
      c.line("assert acting is operator");
      c.line(`tenant_only = ${as(sec.roles)}`);
      c.line("with pytest.raises(NotAuthorized):");
      c.indent(() => c.line(`authorize_across_tenants(tenant_only, "action", permissions=(${pyString(p)},))`));
      c.line(`platform_only = ${as([], { platformRoles: [prole] })}`);
      c.line("with pytest.raises(NotAuthorized):");
      c.indent(() => c.line(`authorize_in_tenant(platform_only, "action", permissions=(${pyString(p)},))`));
    });
  }
}

/** The token bucket, per-subject buckets and the RateLimit header fields. */
function rateLimitTests(model: ModelIR, c: Code, imp: Imports): void {
  // Rate limiting
  const rl = rateLimitModule(model);
  imp.from(rl, "BucketState", "InMemoryRateLimitStore", "RateLimit", "RateLimiter", "rate_limit_headers", "take_token");
  c.line().line();
  c.line('POLICY = RateLimit(name="example", requests=2, window_seconds=10, by="principal")');
  c.line().line();
  c.line("def test_the_bucket_empties_refuses_and_refills() -> None:");
  c.indent(() => {
    c.docstring("A bucket holds `requests` tokens and refills one every `window_seconds / requests` seconds.");
    c.line("state, decision = take_token(None, POLICY, 0)");
    c.line("assert (decision.allowed, decision.remaining, decision.reset) == (True, 1, 5)");
    c.line("state, decision = take_token(state, POLICY, 0)");
    c.line("assert (decision.allowed, decision.remaining, decision.reset) == (True, 0, 10)");
    c.line("state, decision = take_token(state, POLICY, 1)");
    c.line("assert (decision.allowed, decision.retry_after) == (False, 4)");
    c.line("state, decision = take_token(state, POLICY, 5)");
    c.line("assert decision.allowed");
    c.line("# A long pause refills the bucket up to its size, not beyond.");
    c.line("_, decision = take_token(state, POLICY, 3600)");
    c.line("assert (decision.allowed, decision.remaining) == (True, 1)");
  });
  c.line().line();
  c.line("def test_buckets_are_per_subject_and_follow_a_fake_clock() -> None:");
  c.indent(() => {
    c.line("now = [0.0]");
    c.line("limiter = RateLimiter(InMemoryRateLimitStore(), clock=lambda: now[0])");
    c.line('assert [limiter.consume(POLICY, "alice").allowed for _ in range(3)] == [True, True, False]');
    c.line('assert limiter.consume(POLICY, "bob").allowed');
    c.line("now[0] += 5");
    c.line('assert limiter.consume(POLICY, "alice").allowed');
  });
  c.line().line();
  c.line("def test_rate_limit_header_fields() -> None:");
  c.indent(() => {
    c.docstring("draft-ietf-httpapi-ratelimit-headers: RateLimit-Policy (q, w) and RateLimit (r, t); Retry-After on refusal.");
    c.line("_, refused = take_token(BucketState(tokens=0, updated_at=0), POLICY, 0)");
    c.line("assert rate_limit_headers(POLICY, refused) == {");
    c.indent(() => {
      c.line('"RateLimit-Policy": \'"example";q=2;w=10\',');
      c.line('"RateLimit": \'"example";r=0;t=5\',');
      c.line('"Retry-After": "5",');
    });
    c.line("}");
    c.line("_, allowed = take_token(None, POLICY, 0)");
    c.line('assert "Retry-After" not in rate_limit_headers(POLICY, allowed)');
  });
  if (model.security?.tenancy) {
    c.line().line();
    c.line("def test_a_limit_by_tenant_keeps_one_bucket_per_tenant() -> None:");
    c.indent(() => {
      c.docstring("`by: tenant`: one tenant using up its bucket does not starve another (noisy-neighbour isolation).");
      c.line('per_tenant = RateLimit(name="example", requests=1, window_seconds=60, by="tenant")');
      c.line("limiter = RateLimiter(InMemoryRateLimitStore(), clock=lambda: 0.0)");
      c.line('assert limiter.consume(per_tenant, "tenant-a").allowed');
      c.line('assert not limiter.consume(per_tenant, "tenant-a").allowed');
      c.line('assert limiter.consume(per_tenant, "tenant-b").allowed');
    });
  }
}
