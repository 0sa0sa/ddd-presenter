/**
 * Authentication, authorization and rate limiting for the Python target (`security`, docs/09 §20): the shared
 * `generated/security.py` (roles, Principal, NotAuthorized / Unauthenticated, the authorization checks, the endpoints'
 * rate limits), the framework-agnostic `generated/rate_limit.py`, the PyJWT authenticator `generated/authentication.py`
 * (scheme bearer_jwt) and each context's read access.
 */
import {
  aggregateScope,
  allPermissions,
  claimType,
  effectiveRateLimit,
  formatPath,
  rateLimitKey,
  requiresPrincipal,
  roleIncludes,
  rolePermissions,
  servedOverHttp,
  useCaseScope,
  usesPermissions,
  windowSeconds,
  type AccessScope,
  type AggregateIR,
  type ModelIR,
  type RateLimitIR,
  type UseCaseIR,
} from "@ddd/core";
import type { PyFile } from "./domain.ts";
import { assemble, header, ModuleImports, type Layout } from "./layout.ts";
import { Code, docstringLines, emitExpr, MAX_LINE, pyString, pyType, toSnake } from "./support.ts";

import AUTHENTICATION_PY from "./templates/authentication.py.txt" with { type: "text" };
import RATE_LIMIT_PY from "./templates/rate_limit.py.txt" with { type: "text" };

export function securityModule(model: ModelIR): string {
  return `${model.generation.package}.generated.security`;
}
export function rateLimitModule(model: ModelIR): string {
  return `${model.generation.package}.generated.rate_limit`;
}
export function authenticationModule(model: ModelIR): string {
  return `${model.generation.package}.generated.authentication`;
}
function modulePath(model: ModelIR, module: string): string {
  return `${model.generation.srcDir}/${module.replace(/\./g, "/")}.py`;
}

/** "one of the roles admin, staff" / "the role admin" / "any authenticated principal". */
export function rolesText(roles: string[]): string {
  if (!roles.length) return "any authenticated principal";
  return roles.length === 1 ? `the role ${roles[0]}` : `one of the roles ${roles.join(", ")}`;
}

/** rolesText, with the permissions that also admit: "the role admin or the permission invitation.read". */
export function requirementText(roles: string[], permissions: string[]): string {
  if (!permissions.length) return rolesText(roles);
  const p = permissions.length === 1 ? `the permission ${permissions[0]}` : `one of the permissions ${permissions.join(", ")}`;
  return roles.length ? `${rolesText(roles)} or ${p}` : p;
}

/** `, roles=("admin",), permissions=("invitation.read",)`: the keyword arguments of the authorize checks. */
export function requirementKwargs(roles: string[], permissions: string[]): string {
  return `${roles.length ? `, roles=${rolesTuple(roles)}` : ""}${permissions.length ? `, permissions=${rolesTuple(permissions)}` : ""}`;
}

/** The expression context of an authorization rule with permissions / tenancy. */
export function accessCtx(L: Layout, scope: AccessScope): { securityModule: string; scope: AccessScope; platformRoles: boolean } {
  return { securityModule: securityModule(L.model), scope, platformRoles: !!L.model.security?.platformRoles.length };
}

/** `("admin", "staff")`: the roles argument of `authorize(...)`. */
export function rolesTuple(roles: string[]): string {
  return roles.length === 1 ? `(${pyString(roles[0]!)},)` : `(${roles.map(pyString).join(", ")})`;
}

/** Python annotation of a principal claim / id. */
function claimPyType(src: string): string {
  const t = claimType(src);
  if (t?.k === "list") return "tuple[str, ...]";
  if (t?.k === "primitive") return t.name === "UUID" ? "UUID" : t.name === "Integer" ? "int" : t.name === "Boolean" ? "bool" : "str";
  return "str";
}

/** The model-level files: security.py, rate_limit.py and (bearer_jwt) authentication.py. */
export function securityFiles(model: ModelIR, served: { useCases: UseCaseIR[]; aggregates: AggregateIR[] }): PyFile[] {
  const sec = model.security!;
  const mod = securityModule(model);
  const imp = new ModuleImports(mod);
  imp.from("typing", "Final", "Literal");
  imp.from(model.generation.package + ".generated._runtime", "DomainError", "DomainModel");
  const c = new Code();
  if (usesPermissions(sec) || sec.tenancy) {
    rbacSecurity(model, c, imp);
    return [...securityTail(model, served, c, imp, mod)];
  }
  c.line().line();
  c.line(`Role = Literal[${sec.roles.map(pyString).join(", ")}]`);
  c.line(`ROLES: Final[tuple[Role, ...]] = ${rolesTuple(sec.roles)}`);
  c.line().line();
  c.line("class Principal(DomainModel):");
  c.indent(() => {
    c.docstring(
      [
        "The authenticated caller: an id, the roles it holds and the declared claims (`security.principal`).",
        "",
        "Use cases that declare `authorize` with roles or a rule take it as `execute(command, principal)`; build it from the request (e.g. `BearerJwtAuthenticator`) or in tests as `Principal(id=..., roles=(...))`.",
      ].join("\n"),
    );
    c.line();
    if (sec.principal.idType === "UUID") imp.from("uuid", "UUID");
    c.line(`id: ${sec.principal.idType === "UUID" ? "UUID" : "str"}`);
    c.line("roles: tuple[Role, ...]");
    for (const cl of sec.principal.claims) {
      const t = claimPyType(cl.type);
      if (t === "UUID") imp.from("uuid", "UUID");
      c.line(cl.required ? `${cl.name}: ${t}` : `${cl.name}: ${t} | None = None`);
    }
  });
  c.line().line();
  c.line("def has_role(principal: Principal, role: Role) -> bool:");
  c.indent(() => {
    c.docstring("Whether the principal holds `role` (`has_role(principal, role)` in rules).");
    c.line("return role in principal.roles");
  });
  c.line().line();
  c.line("class NotAuthorized(DomainError):");
  c.indent(() => {
    c.docstring("The principal may not do this (HTTP 403).\n\n`details` names the action and the unmet requirement (`required_roles` or `rule`), never the data that was checked.");
    c.line();
    c.line('code = "not_authorized"');
    c.line('default_message = "You are not allowed to do this"');
  });
  c.line().line();
  c.line("class Unauthenticated(DomainError):");
  c.indent(() => {
    c.docstring("No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first.");
    c.line();
    c.line('code = "unauthenticated"');
    c.line('default_message = "Authentication is required"');
  });
  c.line().line();
  imp.from("collections.abc", "Sequence");
  c.line("def authorize(principal: Principal | None, action: str, roles: Sequence[Role]) -> Principal:");
  c.indent(() => {
    c.docstring(
      "The first check of every use case that needs a principal, before anything is loaded.\n\nThere must be a principal, holding one of `roles` (any principal when `roles` is empty), so a caller without the role learns nothing about the data. Raises Unauthenticated or NotAuthorized; returns the principal.",
    );
    c.line("if principal is None:");
    c.indent(() => c.line("raise Unauthenticated(action=action)"));
    c.line("if roles and not any(role in principal.roles for role in roles):");
    c.indent(() => c.line("raise NotAuthorized(action=action, required_roles=list(roles))"));
    c.line("return principal");
  });
  c.line().line();
  c.line("def allow_if(allowed: bool, action: str) -> None:");
  c.indent(() => {
    c.docstring("An `authorize.allow_if` rule: raises NotAuthorized (naming the rule, not the values) unless it holds.");
    c.line("if not allowed:");
    c.indent(() => c.line('raise NotAuthorized(action=action, rule="allow_if")'));
  });
  const auth = sec.authentication;
  if (auth?.scheme === "bearer_jwt") {
    imp.from("collections.abc", "Mapping");
    imp.from(model.generation.package + ".generated._runtime", "ConstraintViolation");
    c.line().line();
    c.line(`JWT_ISSUER: Final[str | None] = ${auth.issuer === undefined ? "None" : pyString(auth.issuer)}`);
    c.line(`JWT_AUDIENCE: Final[str | None] = ${auth.audience === undefined ? "None" : pyString(auth.audience)}`);
    c.line(`JWT_ALGORITHMS: Final[tuple[str, ...]] = ${rolesTuple(auth.algorithms)}`);
    c.line(`JWT_ROLES_CLAIM: Final = ${pyString(auth.rolesClaim)}`);
    c.line(`JWT_LEEWAY: Final = ${auth.clockTolerance}`);
    c.line().line();
    c.line("def principal_from_claims(claims: Mapping[str, object]) -> Principal | None:");
    c.indent(() => {
      c.docstring(
        [
          "The principal a verified token stands for, or None when the claims do not fit.",
          "",
          `\`sub\` is the id, \`${auth.rolesClaim}\` the roles (a list, or one space-separated string; roles the model does not declare are dropped)${sec.principal.claims.length ? `, ${sec.principal.claims.map((cl) => `\`${cl.claim ?? cl.name}\` ${cl.name}`).join(", ")}` : ""}.`,
        ].join("\n"),
      );
      c.line("raw = claims.get(JWT_ROLES_CLAIM)");
      c.line("listed = raw.split(\" \") if isinstance(raw, str) else raw if isinstance(raw, list) else []");
      c.line("try:");
      c.indent(() => {
        c.line("return Principal.model_validate(");
        c.indent(() => {
          c.line("{");
          c.indent(() => {
            c.line('"id": claims.get("sub"),');
            c.line('"roles": tuple(role for role in ROLES if role in listed),');
            for (const cl of sec.principal.claims) c.line(`${pyString(cl.name)}: claims.get(${pyString(cl.claim ?? cl.name)}),`);
          });
          c.line("}");
        });
        c.line(")");
      });
      c.line("except ConstraintViolation:");
      c.indent(() => c.line("return None"));
    });
  }
  return securityTail(model, served, c, imp, mod);
}

/** RATE_LIMITS and the files: security.py, rate_limit.py and (bearer_jwt) authentication.py. */
function securityTail(model: ModelIR, served: { useCases: UseCaseIR[]; aggregates: AggregateIR[] }, c: Code, imp: ModuleImports, mod: string): PyFile[] {
  const sec = model.security!;
  const auth = sec.authentication;
  // The endpoints' rate limits, for a web framework's middleware or dependency. With tenancy, `by: tenant` counts per
  // tenant only where there is one (else per principal, or per IP without a principal).
  const by = (l: RateLimitIR, scope: AccessScope, principal: boolean) => (sec.tenancy ? rateLimitKey(l, scope, principal) : l.by);
  const limits: { name: string; text: string }[] = [];
  for (const uc of served.useCases) {
    const l = effectiveRateLimit(model, uc);
    const ctx = model.contexts.find((x) => x.useCases.includes(uc))!;
    if (l) limits.push({ name: uc.name, text: `RateLimit(${pyString(uc.name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(by(l, useCaseScope(sec, ctx, uc), uc.authorize?.kind === "principal"))})` });
  }
  for (const ag of served.aggregates) {
    const l = effectiveRateLimit(model, ag);
    const name = `read_${toSnake(ag.name)}`;
    if (l) limits.push({ name, text: `RateLimit(${pyString(name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(by(l, aggregateScope(sec, ag), ag.authorize?.kind === "principal"))})` });
  }
  for (const ctx of model.contexts) {
    for (const q of ctx.queries ?? []) {
      const l = effectiveRateLimit(model, q);
      const from = ctx.aggregates.find((a) => a.name === q.from);
      if (l) limits.push({ name: q.name, text: `RateLimit(${pyString(q.name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(by(l, from ? aggregateScope(sec, from) : "none", q.authorize?.kind === "principal"))})` });
    }
  }
  imp.from("collections.abc", "Mapping");
  imp.from(rateLimitModule(model), "RateLimit");
  c.line().line();
  c.line(`RATE_LIMITS: Final[Mapping[str, RateLimit]] = {${limits.length ? "" : "}"}`);
  if (limits.length) {
    c.indent(() => limits.forEach((l) => c.line(`${pyString(l.name)}: ${l.text},`)));
    c.line("}");
  }
  c.line(`\"\"\"Rate limit per endpoint (use case name, ${model.contexts.some((ctx) => ctx.queries?.length) ? "read_<aggregate> or query name" : "or read_<aggregate>"}), for your web layer.`);
  c.line();
  c.line("Use it as `RateLimiter().consume(RATE_LIMITS[name], subject)` (see rate_limit.py).");
  c.line('\"\"\"');
  const doc =
    usesPermissions(sec) || sec.tenancy
      ? `Authorization shared by every context: roles, permissions (inheritance resolved at generation time)${sec.tenancy ? ", the tenant id" : ""}, the principal, the authorization errors and checks, and the endpoints' rate limits.`
      : "Authorization shared by every context: roles, the principal, the authorization errors and checks, and the endpoints' rate limits.";
  const files: PyFile[] = [
    { path: modulePath(model, mod), content: assemble(model, doc, imp, c.toString()) },
    {
      path: modulePath(model, rateLimitModule(model)),
      content: `${header(model)}\n\n${docstringLines("Rate limiting for any web framework: token buckets, a pluggable store and the IETF RateLimit header fields (stdlib only).", "").join("\n")}\n\n${RATE_LIMIT_PY.replace("__TENANT_KEY__", model.security?.tenancy ? ', "tenant"' : "").trimEnd()}\n`,
    },
  ];
  if (auth?.scheme === "bearer_jwt") {
    files.push({
      path: modulePath(model, authenticationModule(model)),
      content: `${header(model)}\n\n${docstringLines("Bearer JWT authentication (RFC 6750, RFC 7519, RFC 8725) with PyJWT, for any web framework.", "").join("\n")}\n\n${AUTHENTICATION_PY.replace(/__PKG__/g, model.generation.package).trimEnd()}\n`,
    });
  }
  return files;
}

/** `MappingProxyType({...})` of a role → tuple map (read-only at run time). */
function frozenMapping(c: Code, name: string, type: string, entries: [string, string[]][], doc: string): void {
  c.line().line();
  c.line(`${name}: Final[Mapping[${type}]] = MappingProxyType(`);
  c.indent(() => {
    c.line("{");
    c.indent(() => {
      for (const [k, v] of entries) {
        const value = v.length === 1 ? `(${pyString(v[0]!)},)` : `(${v.map(pyString).join(", ")})`;
        const one = `${pyString(k)}: ${value},`;
        if (one.length + 12 <= MAX_LINE) c.line(one);
        else {
          c.line(`${pyString(k)}: (`);
          c.indent(() => v.forEach((x) => c.line(`${pyString(x)},`)));
          c.line("),");
        }
      }
    });
    c.line("}");
  });
  c.line(")");
  c.line(`"""${doc}"""`);
}

/** security.py of a model with permissions (map-form roles) or tenancy. */
function rbacSecurity(model: ModelIR, c: Code, imp: ModuleImports): void {
  const sec = model.security!;
  const tenancy = sec.tenancy;
  const platform = sec.platformRoles.map((d) => d.name);
  const runtime = model.generation.package + ".generated._runtime";
  imp.from("collections.abc", "Mapping", "Sequence");
  imp.from("types", "MappingProxyType");
  const literal = (name: string, values: string[]) => {
    const one = `${name} = Literal[${values.map(pyString).join(", ")}]`;
    if (one.length <= MAX_LINE) c.line(one);
    else {
      c.line(`${name} = Literal[`);
      c.indent(() => values.forEach((v) => c.line(`${pyString(v)},`)));
      c.line("]");
    }
  };
  const tupleLine = (head: string, values: string[]) => {
    const one = `${head} = ${rolesTuple(values)}`;
    if (one.length <= MAX_LINE) c.line(one);
    else {
      c.line(`${head} = (`);
      c.indent(() => values.forEach((v) => c.line(`${pyString(v)},`)));
      c.line(")");
    }
  };
  c.line().line();
  literal("Role", sec.roles);
  tupleLine("ROLES: Final[tuple[Role, ...]]", sec.roles);
  if (platform.length) {
    c.line();
    literal("PlatformRole", platform);
    tupleLine("PLATFORM_ROLES: Final[tuple[PlatformRole, ...]]", platform);
    c.line(`"""Global, cross-tenant roles (read from \`${tenancy!.platformRolesClaim}\` only, never from a tenant's roles)."""`);
  }
  const permissions = allPermissions(sec);
  c.line();
  if (permissions.length) literal("Permission", permissions);
  else c.line("Permission = str");
  if (permissions.length) tupleLine("PERMISSIONS: Final[tuple[Permission, ...]]", permissions);
  else c.line("PERMISSIONS: Final[tuple[Permission, ...]] = ()");
  frozenMapping(c, "ROLE_INCLUDES", "Role, tuple[Role, ...]", [...roleIncludes(sec, "tenant")], "Role → itself and every role it inherits (NIST RBAC1), resolved at generation time.");
  frozenMapping(c, "ROLE_PERMISSIONS", "Role, tuple[Permission, ...]", [...rolePermissions(sec, "tenant")], "Role → the permissions it grants, its inherited roles' included.");
  if (platform.length) {
    frozenMapping(c, "PLATFORM_ROLE_INCLUDES", "PlatformRole, tuple[PlatformRole, ...]", [...roleIncludes(sec, "platform")], "Platform role → itself and every platform role it inherits.");
    frozenMapping(c, "PLATFORM_ROLE_PERMISSIONS", "PlatformRole, tuple[Permission, ...]", [...rolePermissions(sec, "platform")], "Platform role → the permissions it grants across tenants.");
  }
  if (tenancy) {
    imp.from("typing", "NewType");
    if (tenancy.type === "UUID") imp.from("uuid", "UUID");
    c.line().line();
    c.line(`TenantId = NewType("TenantId", ${tenancy.type === "UUID" ? "UUID" : "str"})`);
    c.line(`"""A tenant id: the caller's active tenant comes from claim \`${tenancy.claim}\` of the verified token."""`);
    c.line().line();
    c.line("class TenantContext(DomainModel):");
    c.indent(() => {
      c.docstring("The tenant an internal use case runs in (a policy passes its event's tenant; a job the tenant it works for).");
      c.line();
      c.line("tenant_id: TenantId");
    });
  }
  c.line().line();
  c.line("class Principal(DomainModel):");
  c.indent(() => {
    c.docstring(
      [
        tenancy
          ? `The authenticated caller: an id, the active tenant (\`tenant_id\`, from claim \`${tenancy.claim}\` only; None when the token names none), the roles it holds in that tenant${platform.length ? ", its platform roles" : ""} and the declared claims.`
          : "The authenticated caller: an id, the roles it holds and the declared claims (`security.principal`).",
        "",
        `Use cases that declare \`authorize\` with roles, permissions or a rule take it as \`execute(command, principal)\`; build it from the request (e.g. \`BearerJwtAuthenticator\`) or in tests as \`Principal(id=..., ${tenancy ? "tenant_id=..., " : ""}roles=(...))\`.`,
      ].join("\n"),
    );
    c.line();
    if (sec.principal.idType === "UUID") imp.from("uuid", "UUID");
    c.line(`id: ${sec.principal.idType === "UUID" ? "UUID" : "str"}`);
    if (tenancy) c.line("tenant_id: TenantId | None = None");
    c.line("roles: tuple[Role, ...]");
    if (platform.length) c.line("platform_roles: tuple[PlatformRole, ...] = ()");
    for (const cl of sec.principal.claims) {
      const t = claimPyType(cl.type);
      if (t === "UUID") imp.from("uuid", "UUID");
      c.line(cl.required ? `${cl.name}: ${t}` : `${cl.name}: ${t} | None = None`);
    }
  });
  c.line().line();
  c.line(`def has_role(principal: Principal, role: ${platform.length ? "Role | PlatformRole" : "Role"}) -> bool:`);
  c.indent(() => {
    c.docstring("Whether the principal holds `role`, itself or through a role inheriting it (`has_role(principal, role)` in rules).");
    if (platform.length) {
      c.line("if role in PLATFORM_ROLES:");
      c.indent(() => c.line("return any(role in PLATFORM_ROLE_INCLUDES[held] for held in principal.platform_roles)"));
    }
    c.line("return any(role in ROLE_INCLUDES[held] for held in principal.roles)");
  });
  c.line().line();
  c.line("def has_permission(principal: Principal, permission: Permission) -> bool:");
  c.indent(() => {
    c.docstring(tenancy ? "Whether a role the principal holds in its active tenant grants `permission`." : "Whether a role the principal holds grants `permission`.");
    c.line("return any(permission in ROLE_PERMISSIONS[role] for role in principal.roles)");
  });
  if (platform.length) {
    c.line().line();
    c.line("def has_platform_permission(principal: Principal, permission: Permission) -> bool:");
    c.indent(() => {
      c.docstring("Whether a platform role of the principal grants `permission` (cross-tenant operations).");
      c.line("return any(permission in PLATFORM_ROLE_PERMISSIONS[role] for role in principal.platform_roles)");
    });
  }
  c.line().line();
  c.line("class NotAuthorized(DomainError):");
  c.indent(() => {
    c.docstring(
      "The principal may not do this (HTTP 403).\n\n`details` names the action and the unmet requirement (`required_roles` / `required_permissions` or `rule`), never the data that was checked.",
    );
    c.line();
    c.line('code = "not_authorized"');
    c.line('default_message = "You are not allowed to do this"');
  });
  c.line().line();
  c.line("class Unauthenticated(DomainError):");
  c.indent(() => {
    c.docstring(
      tenancy
        ? 'No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first.\n\n`details["error"]` is "missing_tenant" when the token names no active tenant for a tenant-scoped operation.'
        : "No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first.",
    );
    c.line();
    c.line('code = "unauthenticated"');
    c.line('default_message = "Authentication is required"');
  });
  if (tenancy) {
    c.line().line();
    c.line("class TenantMismatch(DomainError):");
    c.indent(() => {
      c.docstring("An aggregate of one tenant was about to be stored for another (a repository refuses it): a programming error, not a caller's mistake.");
      c.line();
      c.line('code = "tenant_mismatch"');
      c.line('default_message = "The data belongs to another tenant"');
    });
  }
  const anyRole = platform.length ? "Role | PlatformRole" : "Role";
  c.line().line();
  c.line("def _admits(");
  c.indent(() => {
    c.line("principal: Principal,");
    c.line(`roles: Sequence[${anyRole}],`);
    c.line("permissions: Sequence[Permission],");
    if (platform.length) {
      c.line("*,");
      c.line("tenant: bool,");
      c.line("platform: bool,");
    }
  });
  c.line(") -> bool:");
  c.indent(() => {
    c.docstring("Whether the principal meets the requirement with its tenant roles and / or its platform roles.");
    c.line("if not roles and not permissions:");
    c.indent(() => c.line("return True"));
    if (!platform.length) {
      c.line("return any(role in ROLE_INCLUDES[held] for role in roles for held in principal.roles) or any(");
      c.indent(() => c.line("has_permission(principal, permission) for permission in permissions"));
      c.line(")");
    }
    if (platform.length) {
      c.line("if tenant and (");
      c.indent(() => {
        c.line("any(role in ROLE_INCLUDES[held] for role in roles for held in principal.roles)");
        c.line("or any(has_permission(principal, permission) for permission in permissions)");
      });
      c.line("):");
      c.indent(() => c.line("return True"));
      c.line("return platform and (");
      c.indent(() => {
        c.line("any(role in PLATFORM_ROLE_INCLUDES[held] for role in roles for held in principal.platform_roles)");
        c.line("or any(has_platform_permission(principal, permission) for permission in permissions)");
      });
      c.line(")");
    }
  });
  c.line().line();
  c.line(`def _denied(action: str, roles: Sequence[${anyRole}], permissions: Sequence[Permission]) -> NotAuthorized:`);
  c.indent(() => {
    c.docstring("NotAuthorized naming the unmet requirement (never the data that was checked).");
    c.line("if roles and permissions:");
    c.indent(() => {
      c.line("return NotAuthorized(");
      c.indent(() => c.line("action=action, required_roles=list(roles), required_permissions=list(permissions)"));
      c.line(")");
    });
    c.line("if roles:");
    c.indent(() => c.line("return NotAuthorized(action=action, required_roles=list(roles))"));
    c.line("return NotAuthorized(action=action, required_permissions=list(permissions))");
  });
  const signature = (name: string, ret: string) => {
    c.line().line();
    c.line(`def ${name}(`);
    c.indent(() => {
      c.line("principal: Principal | None,");
      c.line("action: str,");
      c.line("*,");
      c.line(`roles: Sequence[${anyRole}] = (),`);
      c.line("permissions: Sequence[Permission] = (),");
    });
    c.line(`) -> ${ret}:`);
  };
  signature("authorize", "Principal");
  c.indent(() => {
    c.docstring(
      tenancy
        ? `The first check of an operation that needs a principal but no tenant (shared data): there is a principal, and it meets the requirement with its roles${platform.length ? " or its platform roles" : ""}. Raises Unauthenticated or NotAuthorized.`
        : "The first check of every use case that needs a principal, before anything is loaded: there is a principal, and it holds one of `roles` (or a role inheriting one) or one of `permissions` (any principal when both are empty). Raises Unauthenticated or NotAuthorized; returns the principal.",
    );
    c.line("if principal is None:");
    c.indent(() => c.line("raise Unauthenticated(action=action)"));
    c.line(`if not _admits(principal, roles, permissions${platform.length ? ", tenant=True, platform=True" : ""}):`);
    c.indent(() => c.line("raise _denied(action, roles, permissions)"));
    c.line("return principal");
  });
  if (tenancy) {
    signature("authorize_in_tenant", "tuple[Principal, TenantId]");
    c.indent(() => {
      c.docstring(
        [
          "The first check of a tenant-scoped operation, before anything is loaded.",
          "",
          'There must be a principal (else Unauthenticated), its token must name an active tenant (else Unauthenticated with error="missing_tenant"), and its roles in that tenant must meet the requirement (else NotAuthorized). Platform roles do not count here. Returns the principal and the tenant every repository and reader call is bound to.',
        ].join("\n"),
      );
      c.line("if principal is None:");
      c.indent(() => c.line("raise Unauthenticated(action=action)"));
      c.line("if principal.tenant_id is None:");
      c.indent(() => c.line('raise Unauthenticated(action=action, error="missing_tenant")'));
      c.line(`if not _admits(principal, roles, permissions${platform.length ? ", tenant=True, platform=False" : ""}):`);

      c.indent(() => c.line("raise _denied(action, roles, permissions)"));
      c.line("return principal, principal.tenant_id");
    });
    if (platform.length) {
      signature("authorize_across_tenants", "Principal");
      c.indent(() => {
        c.docstring(
          "The first check of a cross-tenant use case (`cross_tenant: true`): only platform roles meet the requirement. The target tenant comes from the command, and the use case records the access through CrossTenantAudit before it loads anything.",
        );
        c.line("if principal is None:");
        c.indent(() => c.line("raise Unauthenticated(action=action)"));
        c.line("if not _admits(principal, roles, permissions, tenant=False, platform=True):");
        c.indent(() => c.line("raise _denied(action, roles, permissions)"));
        c.line("return principal");
      });
      imp.from("typing", "Protocol");
      c.line().line();
      c.line("class CrossTenantAccess(DomainModel):");
      c.indent(() => {
        c.docstring("One access of a platform principal to a tenant's data (a cross-tenant use case).");
        c.line();
        c.line("action: str");
        c.line("principal: Principal");
        c.line("tenant_id: TenantId");
      });
      c.line().line();
      c.line("class CrossTenantAudit(Protocol):");
      c.indent(() => {
        c.docstring(
          "Port: records every cross-tenant access before the use case touches the tenant's data (an audit log, a SIEM).\n\nIf it raises, the use case fails without loading anything. Tests use `RecordingCrossTenantAudit`.",
        );
        c.line();
        c.line("def record(self, access: CrossTenantAccess) -> None: ...");
      });
    }
  }
  c.line().line();
  c.line("def allow_if(allowed: bool, action: str) -> None:");
  c.indent(() => {
    c.docstring("An `authorize.allow_if` rule: raises NotAuthorized (naming the rule, not the values) unless it holds.");
    c.line("if not allowed:");
    c.indent(() => c.line('raise NotAuthorized(action=action, rule="allow_if")'));
  });
  const auth = sec.authentication;
  if (auth?.scheme === "bearer_jwt") {
    imp.from(runtime, "ConstraintViolation");
    c.line().line();
    c.line(`JWT_ISSUER: Final[str | None] = ${auth.issuer === undefined ? "None" : pyString(auth.issuer)}`);
    c.line(`JWT_AUDIENCE: Final[str | None] = ${auth.audience === undefined ? "None" : pyString(auth.audience)}`);
    c.line(`JWT_ALGORITHMS: Final[tuple[str, ...]] = ${rolesTuple(auth.algorithms)}`);
    c.line(`JWT_ROLES_CLAIM: Final = ${pyString(auth.rolesClaim)}`);
    if (tenancy) c.line(`JWT_TENANT_CLAIM: Final = ${pyString(tenancy.claim)}`);
    if (platform.length) c.line(`JWT_PLATFORM_ROLES_CLAIM: Final = ${pyString(tenancy!.platformRolesClaim)}`);
    c.line(`JWT_LEEWAY: Final = ${auth.clockTolerance}`);
    c.line().line();
    c.line("def _listed(claim: object) -> list[object]:");
    c.indent(() => {
      c.docstring("A list claim: a JSON array, or one space-separated string.");
      c.line("if isinstance(claim, str):");
      c.indent(() => c.line('return list(claim.split(" "))'));
      c.line("return list(claim) if isinstance(claim, list) else []");
    });
    c.line().line();
    c.line("def principal_from_claims(claims: Mapping[str, object]) -> Principal | None:");
    c.indent(() => {
      c.docstring(
        [
          "The principal a verified token stands for, or None when the claims do not fit.",
          "",
          `\`sub\` is the id, ${tenancy ? `\`${tenancy.claim}\` the active tenant, ` : ""}\`${auth.rolesClaim}\` the roles (undeclared roles are dropped${tenancy ? "; without an active tenant the token holds none" : ""})${platform.length ? `, \`${tenancy!.platformRolesClaim}\` the platform roles` : ""}${sec.principal.claims.length ? `, ${sec.principal.claims.map((cl) => `\`${cl.claim ?? cl.name}\` ${cl.name}`).join(", ")}` : ""}.`,
        ].join("\n"),
      );
      if (tenancy) c.line("tenant = claims.get(JWT_TENANT_CLAIM)");
      c.line("listed = _listed(claims.get(JWT_ROLES_CLAIM))");
      if (tenancy) {
        c.line("# Tenant roles hold in the active tenant only.");
        c.line("roles = tuple(role for role in ROLES if role in listed) if tenant is not None else ()");
      }
      if (platform.length) c.line("platform = _listed(claims.get(JWT_PLATFORM_ROLES_CLAIM))");
      c.line("try:");
      c.indent(() => {
        c.line("return Principal.model_validate(");
        c.indent(() => {
          c.line("{");
          c.indent(() => {
            c.line('"id": claims.get("sub"),');
            if (tenancy) {
              c.line('"tenant_id": tenant,');
              c.line('"roles": roles,');
            } else {
              c.line('"roles": tuple(role for role in ROLES if role in listed),');
            }
            if (platform.length) c.line('"platform_roles": tuple(role for role in PLATFORM_ROLES if role in platform),');
            for (const cl of sec.principal.claims) c.line(`${pyString(cl.name)}: claims.get(${pyString(cl.claim ?? cl.name)}),`);
          });
          c.line("}");
        });
        c.line(")");
      });
      c.line("except ConstraintViolation:");
      c.indent(() => c.line("return None"));
    });
  }
}

/** Aggregates whose read access needs a principal. */
export function protectedAggregates(L: Layout): AggregateIR[] {
  return L.model.security ? L.ca.ir.aggregates.filter(requiresPrincipal) : [];
}

/** `application/read_access.py`: authorized loading by identity per aggregate whose `authorize` needs a principal. */
export function readAccessFile(L: Layout): PyFile | undefined {
  const ags = protectedAggregates(L);
  if (!ags.length) return undefined;
  const mod = `${L.base}.application.read_access`;
  const imp = new ModuleImports(mod);
  const sec = securityModule(L.model);
  imp.from(sec, "Principal");
  if (!(L.model.security?.tenancy && ags.every((ag) => L.tenantScoped(ag)))) imp.from(sec, "authorize");
  const c = new Code();
  for (const ag of ags) {
    const a = ag.authorize!;
    imp.from(L.ports, `${ag.name}Repository`);
    imp.from(L.mod("aggregates"), ag.name);
    const idType = pyType(L.fieldTypes(ag.name).get(ag.identity)!, imp, L.typeModule, { field: false });
    const action = `read ${ag.name}`;
    c.line().line();
    const params = `repository: ${ag.name}Repository, ${ag.identity}: ${idType}, principal: Principal | None`;
    const one = `def read_${toSnake(ag.name)}(${params}) -> ${ag.name} | None:`;
    if (one.length <= 100) c.line(one);
    else {
      c.line(`def read_${toSnake(ag.name)}(`);
      c.indent(() => c.line(params));
      c.line(`) -> ${ag.name} | None:`);
    }
    c.indent(() => {
      c.docstring(
        [
          `Loads ${ag.name} for \`principal\` (\`authorize\` of ${ag.name}): ${requirementText(a.roles, a.permissions ?? [])}${a.allowIf ? `, and \`${a.allowIf}\` must hold for the loaded aggregate` : ""}.${L.tenantScoped(ag) ? " Loaded from the caller's tenant only." : ""}`,
          "",
          "The roles are checked before loading. Returns None when it does not exist; raises Unauthenticated or NotAuthorized.",
        ].join("\n"),
      );
      const rbac = usesPermissions(L.model.security) || !!L.model.security?.tenancy;
      const tenant = L.tenantScoped(ag);
      const required = requirementKwargs(a.roles, a.permissions ?? []);
      let get = `repository.get(${ag.identity})`;
      if (!rbac) c.line(`principal = authorize(principal, ${pyString(action)}, ${rolesTuple(a.roles)})`);
      else if (tenant) {
        imp.from(sec, "authorize_in_tenant");
        c.line(`principal, tenant = authorize_in_tenant(principal, ${pyString(action)}${required})`);
        get = `repository.get(tenant, ${ag.identity})`;
      } else c.line(`principal = authorize(principal, ${pyString(action)}${required})`);
      if (a.allowIf === undefined) {
        c.line(`return ${get}`);
        return;
      }
      c.line(`aggregate = ${get}`);
      imp.from(sec, "allow_if");
      const e = L.ca.exprs.get(formatPath([...a.path, "allow_if"]))!;
      c.line("if aggregate is not None:");
      c.indent(() => c.line(`allow_if(${emitExpr(e, L.exprCtx(imp, "aggregate", rbac ? { access: accessCtx(L, aggregateScope(L.model.security, ag)) } : {}))}, ${pyString(action)})`));
      c.line("return aggregate");
    });
  }
  return { path: L.path(mod), content: assemble(L.model, `Read access of the ${L.ca.ir.name} aggregates: authorization around loading by identity.`, imp, c.toString()) };
}

export { servedOverHttp };
