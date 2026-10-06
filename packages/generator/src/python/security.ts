/**
 * Authentication, authorization and rate limiting for the Python target (`security`, docs/09 §20): the shared
 * `generated/security.py` (roles, Principal, NotAuthorized / Unauthenticated, the authorization checks, the endpoints'
 * rate limits), the framework-agnostic `generated/rate_limit.py`, the PyJWT authenticator `generated/authentication.py`
 * (scheme bearer_jwt) and each context's read access.
 */
import { claimType, effectiveRateLimit, formatPath, requiresPrincipal, servedOverHttp, windowSeconds, type AggregateIR, type ModelIR } from "@ddd/core";
import type { PyFile } from "./domain.ts";
import { assemble, header, ModuleImports, type Layout } from "./layout.ts";
import { Code, docstringLines, emitExpr, pyString, pyType, toSnake } from "./support.ts";
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
export function securityFiles(model: ModelIR, served: { useCases: { name: string; authorize?: unknown; rateLimit?: unknown }[]; aggregates: AggregateIR[] }): PyFile[] {
  const sec = model.security!;
  const mod = securityModule(model);
  const imp = new ModuleImports(mod);
  imp.from("typing", "Final", "Literal");
  imp.from(model.generation.package + ".generated._runtime", "DomainError", "DomainModel");
  const c = new Code();
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
  // The endpoints' rate limits, for a web framework's middleware or dependency.
  const limits: { name: string; text: string }[] = [];
  for (const uc of served.useCases) {
    const l = effectiveRateLimit(model, uc as never);
    if (l) limits.push({ name: uc.name, text: `RateLimit(${pyString(uc.name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(l.by)})` });
  }
  for (const ag of served.aggregates) {
    const l = effectiveRateLimit(model, ag);
    const name = `read_${toSnake(ag.name)}`;
    if (l) limits.push({ name, text: `RateLimit(${pyString(name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(l.by)})` });
  }
  for (const q of model.contexts.flatMap((ctx) => ctx.queries ?? [])) {
    const l = effectiveRateLimit(model, q);
    if (l) limits.push({ name: q.name, text: `RateLimit(${pyString(q.name)}, ${l.requests}, ${windowSeconds(l)}, ${pyString(l.by)})` });
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
  const files: PyFile[] = [
    { path: modulePath(model, mod), content: assemble(model, "Authorization shared by every context: roles, the principal, the authorization errors and checks, and the endpoints' rate limits.", imp, c.toString()) },
    {
      path: modulePath(model, rateLimitModule(model)),
      content: `${header(model)}\n\n${docstringLines("Rate limiting for any web framework: token buckets, a pluggable store and the IETF RateLimit header fields (stdlib only).", "").join("\n")}\n\n${RATE_LIMIT_PY.trimEnd()}\n`,
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
  imp.from(sec, "Principal", "authorize");
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
          `Loads ${ag.name} for \`principal\` (\`authorize\` of ${ag.name}): ${rolesText(a.roles)}${a.allowIf ? `, and \`${a.allowIf}\` must hold for the loaded aggregate` : ""}.`,
          "",
          "The roles are checked before loading. Returns None when it does not exist; raises Unauthenticated or NotAuthorized.",
        ].join("\n"),
      );
      c.line(`principal = authorize(principal, ${pyString(action)}, ${rolesTuple(a.roles)})`);
      if (a.allowIf === undefined) {
        c.line(`return repository.get(${ag.identity})`);
        return;
      }
      c.line(`aggregate = repository.get(${ag.identity})`);
      imp.from(sec, "allow_if");
      const e = L.ca.exprs.get(formatPath([...a.path, "allow_if"]))!;
      c.line("if aggregate is not None:");
      c.indent(() => c.line(`allow_if(${emitExpr(e, L.exprCtx(imp, "aggregate"))}, ${pyString(action)})`));
      c.line("return aggregate");
    });
  }
  return { path: L.path(mod), content: assemble(L.model, `Read access of the ${L.ca.ir.name} aggregates: authorization around loading by identity.`, imp, c.toString()) };
}

export { servedOverHttp };
