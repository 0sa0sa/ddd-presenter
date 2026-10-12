/**
 * Authentication, authorization and rate limiting for the TypeScript target (`security`, docs/09 §20): the shared
 * `generated/security.ts` module (roles, the Principal schema, NotAuthorized / Unauthenticated, the authorization
 * helpers every protected use case calls first) and each context's read access (`application/read-access.ts`).
 */
import { aggregateScope, allPermissions, claimType, formatPath, requiresPrincipal, roleIncludes, rolePermissions, usesPermissions, type AggregateIR, type ModelIR, type Type } from "@ddd/core";
import { requirementLiteral } from "./application.ts";


import { assemble, Code, header, TsImports, tsString } from "./code.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { file, type TsFile } from "./domain.ts";
import { emitExpr, type ExprContext } from "./expr.ts";
import type { TsLayout, TsPaths } from "./layout.ts";
import { prop } from "./names.ts";
import { tsType } from "./types.ts";

/** Whether the HTTP API gets the generated bearer JWT authenticator (and depends on jose). */
export function usesJwt(model: ModelIR): boolean {
  return !!model.generation.typescript.api && model.security?.authentication?.scheme === "bearer_jwt";
}

/** Zod schema of a principal claim / id (claims are context-free: primitives and List[String]). */
function claimSchema(t: Type, imp: TsImports, P: TsPaths): string {
  if (t.k === "optional") return `${claimSchema(t.inner, imp, P)}.nullable().default(null)`;
  if (t.k === "list") return `z.array(${claimSchema(t.item, imp, P)}).readonly()`;
  if (t.k === "primitive") {
    switch (t.name) {
      case "UUID":
        imp.value(P.runtime, "uuidSchema");
        return "uuidSchema";
      case "Integer":
        return "z.number().int()";
      case "Boolean":
        return "z.boolean()";
      default:
        return "z.string()";
    }
  }
  throw new Error(`unsupported claim type ${JSON.stringify(t)}`);
}

export function securityFile(model: ModelIR, P: TsPaths): TsFile {
  const sec = model.security!;
  const mod = P.security;
  const imp = new TsImports(mod);
  imp.value("zod", "z");
  imp.value(P.runtime, "DomainError", "parseWith");
  imp.type(P.runtime, "ErrorDetails");
  const rbac = usesPermissions(sec) || !!sec.tenancy;
  const tenancy = sec.tenancy;
  const platform = sec.platformRoles.length > 0;
  const c = new Code();
  c.line();
  c.doc(tenancy ? "Roles declared in the model (`security.roles`). A role holds only in the caller's active tenant." : "Roles declared in the model (`security.roles`).");
  c.line(`export const ROLES = [${sec.roles.map(tsString).join(", ")}] as const;`);
  c.line("export const RoleSchema = z.enum(ROLES);");
  c.line("export type Role = z.output<typeof RoleSchema>;");
  if (rbac) rbacDeclarations(c, sec, imp, P);
  c.line();
  const fields = [
    `id: ${sec.principal.idType === "UUID" ? (imp.value(P.runtime, "uuidSchema"), "uuidSchema") : "z.string().min(1)"},`,
    ...(tenancy ? ["tenantId: TenantIdSchema.nullable().default(null),"] : []),
    "roles: z.array(RoleSchema).readonly(),",
    ...(platform ? ["platformRoles: z.array(PlatformRoleSchema).readonly().default([]),"] : []),
    ...sec.principal.claims.map((cl) => {
      const t = claimType(cl.type)!;
      return `${prop(cl.name)}: ${claimSchema(cl.required ? t : { k: "optional", inner: t }, imp, P)},`;
    }),
  ];
  c.line("const PrincipalFields = z");
  c.indent(() => {
    c.open(".strictObject({", () => c.lines_(fields), "})");
    c.line(".readonly();");
  });
  c.line();
  c.doc(
    [
      tenancy
        ? `The authenticated caller: an id, the active tenant (\`tenantId\`, from claim \`${tenancy.claim}\` only; null when the token names none), the roles it holds in that tenant${platform ? ", its platform (cross-tenant) roles" : ""} and the declared claims.`
        : "The authenticated caller: an id, the roles it holds and the declared claims (`security.principal`).",
      "",
      `Use cases that declare \`authorize\` with roles${rbac ? ", permissions" : ""} or a rule take it as \`execute(command, principal)\`; the HTTP layer builds it from the bearer token. Create one in tests with \`Principal.create({ id, ${tenancy ? "tenantId, " : ""}roles })\`.`,
    ].join("\n"),
  );
  c.line("export type Principal = z.output<typeof PrincipalFields>;");
  c.line("export type PrincipalInput = z.input<typeof PrincipalFields>;");
  c.line();
  c.block("export const Principal =", () => {
    c.line("schema: PrincipalFields,");
    c.block("create(input: PrincipalInput): Principal", () => c.line('return parseWith(PrincipalFields, input, "Principal");'), ",");
    c.block("parse(input: unknown): Principal", () => c.line('return parseWith(PrincipalFields, input, "Principal");'), ",");
  }, " as const;");
  const auth = sec.authentication;
  if (auth?.scheme === "bearer_jwt") {
    c.line();
    c.doc("Bearer JWT settings (`security.authentication`): the defaults of the generated authenticator.");
    c.block("export const AUTHENTICATION =", () => {
      c.line(`issuer: ${auth.issuer === undefined ? "undefined" : tsString(auth.issuer)} as string | undefined,`);
      c.line(`audience: ${auth.audience === undefined ? "undefined" : tsString(auth.audience)} as string | undefined,`);
      c.line(`algorithms: [${auth.algorithms.map(tsString).join(", ")}],`);
      c.line(`rolesClaim: ${tsString(auth.rolesClaim)},`);
      if (tenancy) c.line(`tenantClaim: ${tsString(tenancy.claim)},`);
      if (platform) c.line(`platformRolesClaim: ${tsString(tenancy!.platformRolesClaim)},`);
      c.line(`clockTolerance: ${auth.clockTolerance},`);
    }, " as const;");
    c.line();
    if (rbac) {
      c.doc("A list claim: a JSON array, or one space-separated string (OAuth scope style).");
      c.block("function listClaim(value: unknown): unknown[]", () => {
        c.line("if (Array.isArray(value)) return value as unknown[];");
        c.line('return typeof value === "string" ? value.split(" ") : [];');
      });
      c.line();
    }
    c.doc(
      [
        `The principal a verified token stands for: \`sub\` is the id, ${tenancy ? `\`${tenancy.claim}\` the active tenant, ` : ""}\`${auth.rolesClaim}\` the roles (a list, or one space-separated string; roles the model does not declare are dropped${tenancy ? "; without an active tenant the token holds no role" : ""})${platform ? `, \`${tenancy!.platformRolesClaim}\` the platform roles` : ""}${sec.principal.claims.length ? `, ${sec.principal.claims.map((cl) => `\`${cl.claim ?? cl.name}\` ${prop(cl.name)}`).join(", ")}` : ""}.`,
        "",
        tenancy
          ? "Null when the claims do not fit the Principal schema (e.g. a required claim is missing, or the tenant is not a valid tenant id). The tenant comes from the verified token only, never from the request."
          : "Null when the claims do not fit the Principal schema (e.g. a required claim is missing).",
      ].join("\n"),
    );
    c.block("export function principalFromClaims(claims: Readonly<Record<string, unknown>>): Principal | null", () => {
      if (rbac) {
        if (tenancy) c.line(`const tenantId = claims[${tsString(tenancy.claim)}] ?? null;`);
        c.block("const result = PrincipalFields.safeParse(", () => {
          c.line('id: claims["sub"],');
          if (tenancy) {
            c.line("tenantId,");
            c.comment("Tenant roles hold in the active tenant only: a token naming no tenant holds none.");
            c.line(`roles: tenantId === null ? [] : listClaim(claims[${tsString(auth.rolesClaim)}]).filter((role) => RoleSchema.safeParse(role).success),`);
          } else {
            c.line(`roles: listClaim(claims[${tsString(auth.rolesClaim)}]).filter((role) => RoleSchema.safeParse(role).success),`);
          }
          if (platform) c.line(`platformRoles: listClaim(claims[${tsString(tenancy!.platformRolesClaim)}]).filter((role) => PlatformRoleSchema.safeParse(role).success),`);
          for (const cl of sec.principal.claims) c.line(`${prop(cl.name)}: claims[${tsString(cl.claim ?? cl.name)}]${cl.required ? "" : " ?? null"},`);
        }, ");");
        c.line("return result.success ? result.data : null;");
        return;
      }
      c.line(`const roles = claims[${tsString(auth.rolesClaim)}];`);
      c.line("const listed: unknown[] = Array.isArray(roles)");
      c.indent(() => {
        c.line("? roles");
        c.line(': typeof roles === "string"');
        c.indent(() => {
          c.line('? roles.split(" ")');
          c.line(": [];");
        });
      });
      c.block("const result = PrincipalFields.safeParse(", () => {
        c.line('id: claims["sub"],');
        c.line("roles: listed.filter((role) => RoleSchema.safeParse(role).success),");
        for (const cl of sec.principal.claims) c.line(`${prop(cl.name)}: claims[${tsString(cl.claim ?? cl.name)}]${cl.required ? "" : " ?? null"},`);
      }, ");");
      c.line("return result.success ? result.data : null;");
    });
  }
  c.line();
  if (rbac) {
    rbacChecks(c, sec, imp, P);
    return { path: P.file(mod), content: assemble(header(model), securityModuleDoc(sec), imp, c.toString()) };
  }
  c.doc("Whether the principal holds `role` (`has_role(principal, role)` in rules).");
  c.block("export function hasRole(principal: Principal, role: Role): boolean", () => c.line("return principal.roles.includes(role);"));
  c.line();
  c.doc(
    "The principal may not do this (HTTP 403). `details` names the action and the unmet requirement (`requiredRoles` or `rule`), never the data that was checked.",
  );
  errorClass(c, "NotAuthorized", "not_authorized", "You are not allowed to do this");
  c.line();
  c.doc("No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first.");
  errorClass(c, "Unauthenticated", "unauthenticated", "Authentication is required");
  c.line();
  c.doc("The errors of authorization, for an error registry next to a context's `ALL_ERRORS`.");
  c.line("export const SECURITY_ERRORS = [NotAuthorized, Unauthenticated] as const;");
  c.line();
  c.doc(
    [
      "The first check of every use case that needs a principal, before anything is loaded (so a caller without the role learns nothing about the data): there is a principal, and it holds one of `roles` (any principal when `roles` is empty).",
      "",
      "Throws Unauthenticated or NotAuthorized; afterwards `principal` is known to be present.",
    ].join("\n"),
  );
  c.line("export function authorize(");
  c.indent(() => {
    c.line("principal: Principal | null,");
    c.line("action: string,");
    c.line("roles: ReadonlyArray<Role>,");
  });
  c.block("): asserts principal is Principal", () => {
    c.line("if (principal === null) throw new Unauthenticated({ action });");
    c.block("if (roles.length > 0 && !roles.some((role) => principal.roles.includes(role)))", () => {
      c.line("throw new NotAuthorized({ action, requiredRoles: [...roles] });");
    });
  });
  c.line();
  c.doc("An `authorize.allow_if` rule: throws NotAuthorized (naming the rule, not the values) unless it holds.");
  c.block("export function allowIf(allowed: boolean, action: string): void", () => {
    c.line('if (!allowed) throw new NotAuthorized({ action, rule: "allow_if" });');
  });
  return { path: P.file(mod), content: assemble(header(model), "Authorization shared by every context: roles, the principal, the authorization errors and checks (zod only).", imp, c.toString()) };
}

function securityModuleDoc(sec: NonNullable<ModelIR["security"]>): string {
  const parts = ["roles"];
  if (usesPermissions(sec)) parts.push("permissions (inheritance resolved at generation time)");
  if (sec.tenancy) parts.push("the tenant id");
  return `Authorization shared by every context: ${parts.join(", ")}, the principal, the authorization errors and checks (zod only).`;
}

/** `Object.freeze({ a: Object.freeze([...]), … })` lines of a role → list map. */
function frozenMap(c: Code, name: string, type: string, doc: string, entries: [string, string[]][]): void {
  c.line();
  c.doc(doc);
  const body = () => {
    for (const [k, v] of entries) c.line(`${/^[A-Za-z_$][\w$]*$/.test(k) ? k : tsString(k)}: frozen(${v.map(tsString).join(", ")}),`);
  };
  const head = `export const ${name}: ${type} = Object.freeze({`;
  if (strWidth(head) <= PRINT_WIDTH) c.block(`export const ${name}: ${type} = Object.freeze(`, body, ");");
  else {
    // Prettier moves the call to its own line when the declaration does not fit.
    c.line(`export const ${name}: ${type} =`);
    c.indent(() => c.block("Object.freeze(", body, ");"));
  }
}

/** Permissions, the resolved role hierarchy, platform roles and the tenant id (models with permissions or tenancy). */
function rbacDeclarations(c: Code, sec: NonNullable<ModelIR["security"]>, imp: TsImports, P: TsPaths): void {
  const platform = sec.platformRoles.length > 0;
  if (platform) {
    c.line();
    c.doc(`Platform roles (\`security.platform_roles\`): global, cross-tenant roles read from claim \`${sec.tenancy!.platformRolesClaim}\` only, never from a tenant's roles.`);
    c.line(`export const PLATFORM_ROLES = [${sec.platformRoles.map((d) => tsString(d.name)).join(", ")}] as const;`);
    c.line("export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);");
    c.line("export type PlatformRole = z.output<typeof PlatformRoleSchema>;");
  }
  const permissions = allPermissions(sec);
  c.line();
  c.doc("Every permission a role grants (`permissions` of the roles), sorted.");
  c.line(`export const PERMISSIONS = [${permissions.map(tsString).join(", ")}] as const;`);
  c.line(`export type Permission = ${permissions.length ? "(typeof PERMISSIONS)[number]" : "never"};`);
  c.line();
  c.doc("A frozen list (the role maps below cannot be changed at run time).");
  c.block("function frozen<T extends string>(...items: T[]): ReadonlyArray<T>", () => c.line("return Object.freeze(items);"));
  const resolved = (kind: "tenant" | "platform") => [...roleIncludes(sec, kind)].map(([r, inc]) => [r, inc] as [string, string[]]);
  const granted = (kind: "tenant" | "platform") => [...rolePermissions(sec, kind)].map(([r, ps]) => [r, ps] as [string, string[]]);
  frozenMap(c, "ROLE_INCLUDES", "Readonly<Record<Role, ReadonlyArray<Role>>>", "Role → itself and every role it inherits (NIST RBAC1 hierarchy), resolved at generation time: holding a role satisfies `authorize.roles` naming any of these.", resolved("tenant"));
  frozenMap(c, "ROLE_PERMISSIONS", "Readonly<Record<Role, ReadonlyArray<Permission>>>", "Role → the permissions it grants, its inherited roles' included (resolved at generation time).", granted("tenant"));
  if (platform) {
    frozenMap(c, "PLATFORM_ROLE_INCLUDES", "Readonly<Record<PlatformRole, ReadonlyArray<PlatformRole>>>", "Platform role → itself and every platform role it inherits.", resolved("platform"));
    frozenMap(c, "PLATFORM_ROLE_PERMISSIONS", "Readonly<Record<PlatformRole, ReadonlyArray<Permission>>>", "Platform role → the permissions it grants across tenants (inherited ones included).", granted("platform"));
  }
  const tenancy = sec.tenancy;
  if (tenancy) {
    c.line();
    c.doc(`The id of a tenant (\`security.tenancy\`): the caller's active tenant comes from claim \`${tenancy.claim}\` of the verified token only.`);
    if (tenancy.type === "UUID") {
      imp.value(P.runtime, "uuidSchema");
      c.line('export const TenantIdSchema = uuidSchema.brand<"TenantId">();');
    } else {
      c.line('export const TenantIdSchema = z.string().min(1).brand<"TenantId">();');
    }
    c.line("export type TenantId = z.output<typeof TenantIdSchema>;");
    c.line();
    c.doc("A tenant id from a trusted source (configuration, an event, a test). Throws ConstraintViolation when invalid.");
    c.block("export function tenantId(value: string): TenantId", () => c.line('return parseWith(TenantIdSchema, value, "TenantId");'));
    c.line();
    c.doc(
      "The tenant an internal use case runs in (a policy passes its event's tenant; a job passes the tenant it works for). Internal use cases get a tenant, never a principal.",
    );
    c.block("export interface TenantContext", () => c.line("readonly tenantId: TenantId;"));
  }
}

/** hasRole / hasPermission, the errors, and the checks of a model with permissions or tenancy. */
function rbacChecks(c: Code, sec: NonNullable<ModelIR["security"]>, imp: TsImports, P: TsPaths): void {
  const tenancy = sec.tenancy;
  const platform = sec.platformRoles.length > 0;
  const anyRole = platform ? "Role | PlatformRole" : "Role";
  c.doc(
    platform
      ? "Whether the principal holds `role`, itself or through a role inheriting it (`has_role(principal, role)` in rules). Tenant roles count in the active tenant, platform roles anywhere."
      : "Whether the principal holds `role`, itself or through a role inheriting it (`has_role(principal, role)` in rules).",
  );
  c.block(`export function hasRole(principal: Principal, role: ${anyRole}): boolean`, () => {
    if (platform) {
      c.block("if (isPlatformRole(role))", () => c.line("return principal.platformRoles.some((held) => PLATFORM_ROLE_INCLUDES[held].includes(role));"));
      c.line("return principal.roles.some((held) => ROLE_INCLUDES[held].includes(role));");
    } else {
      c.line("return principal.roles.some((held) => ROLE_INCLUDES[held].includes(role));");
    }
  });
  if (platform) {
    c.line();
    c.block("function isPlatformRole(role: string): role is PlatformRole", () => c.line("return PlatformRoleSchema.safeParse(role).success;"));
  }
  c.line();
  c.doc(
    tenancy
      ? "Whether a role the principal holds in its active tenant grants `permission` (`has_permission(principal, …)` in rules of tenant-scoped operations)."
      : "Whether a role the principal holds grants `permission` (`has_permission(principal, …)` in rules).",
  );
  c.block("export function hasPermission(principal: Principal, permission: Permission): boolean", () => {
    c.line("return principal.roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));");
  });
  if (platform) {
    c.line();
    c.doc("Whether a platform role of the principal grants `permission` (rules of cross-tenant operations).");
    c.block("export function hasPlatformPermission(principal: Principal, permission: Permission): boolean", () => {
      c.line("return principal.platformRoles.some((role) => PLATFORM_ROLE_PERMISSIONS[role].includes(permission));");
    });
  }
  c.line();
  c.doc(
    "The principal may not do this (HTTP 403). `details` names the action and the unmet requirement (`requiredRoles` / `requiredPermissions` or `rule`), never the data that was checked.",
  );
  errorClass(c, "NotAuthorized", "not_authorized", "You are not allowed to do this");
  c.line();
  c.doc(
    tenancy
      ? 'No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first. `details.error` is `"missing_tenant"` when the token names no active tenant for a tenant-scoped operation.'
      : "No authenticated principal (HTTP 401): the caller must sign in (or present a valid token) first.",
  );
  errorClass(c, "Unauthenticated", "unauthenticated", "Authentication is required");
  if (tenancy) {
    c.line();
    c.doc(
      "An aggregate of one tenant was about to be stored for another (a repository's `save` refuses it). It means a programming error, not a caller's mistake, so it is not mapped to an HTTP status (500).",
    );
    errorClass(c, "TenantMismatch", "tenant_mismatch", "The data belongs to another tenant");
  }
  c.line();
  c.doc("The errors of authorization, for an error registry next to a context's `ALL_ERRORS`.");
  c.line("export const SECURITY_ERRORS = [NotAuthorized, Unauthenticated] as const;");
  c.line();
  c.doc("What an `authorize` block admits: any of the roles (or a role inheriting one) or any of the permissions; nothing listed admits every principal.");
  c.block("export interface Requirement", () => {
    c.line(`readonly roles?: ReadonlyArray<${anyRole}>;`);
    c.line("readonly permissions?: ReadonlyArray<Permission>;");
  });
  c.line();
  c.doc("Whether the principal meets `required` with its tenant roles and / or its platform roles.");
  c.line("function admits(");
  c.indent(() => {
    c.line("principal: Principal,");
    c.line("required: Requirement,");
    c.line(`by: { readonly tenant: boolean; readonly platform: boolean },`);
  });
  c.block("): boolean", () => {
    c.line("const roles = required.roles ?? [];");
    c.line("const permissions = required.permissions ?? [];");
    c.line("if (roles.length === 0 && permissions.length === 0) return true;");
    c.block("if (by.tenant)", () => {
      c.line("const held = principal.roles;");
      c.line("if (roles.some((role) => held.some((r) => (ROLE_INCLUDES[r] as ReadonlyArray<string>).includes(role)))) return true;");
      c.line("if (permissions.some((p) => hasPermission(principal, p))) return true;");
    });
    if (platform) {
      c.block("if (by.platform)", () => {
        c.line("const held = principal.platformRoles;");
        c.line("if (roles.some((role) => held.some((r) => (PLATFORM_ROLE_INCLUDES[r] as ReadonlyArray<string>).includes(role)))) return true;");
        c.line("if (permissions.some((p) => hasPlatformPermission(principal, p))) return true;");
      });
    }
    c.line("return false;");
  });
  c.line();
  c.block("function denied(action: string, required: Requirement): NotAuthorized", () => {
    c.block("return new NotAuthorized(", () => {
      c.line("action,");
      c.line("...(required.roles?.length ? { requiredRoles: [...required.roles] } : {}),");
      c.line("...(required.permissions?.length ? { requiredPermissions: [...required.permissions] } : {}),");
    }, ");");
  });
  c.line();
  c.doc(
    [
      tenancy
        ? "The first check of a use case, query or read that needs a principal but no tenant (shared data): there is a principal, and it meets `required` with its roles" + (platform ? " or its platform roles" : "") + "."
        : "The first check of every use case that needs a principal, before anything is loaded (so a caller without the role learns nothing about the data): there is a principal, and it meets `required` (any principal when it lists nothing).",
      "",
      "Throws Unauthenticated or NotAuthorized; afterwards `principal` is known to be present.",
    ].join("\n"),
  );
  c.line("export function authorize(");
  c.indent(() => {
    c.line("principal: Principal | null,");
    c.line("action: string,");
    c.line("required: Requirement,");
  });
  c.block("): asserts principal is Principal", () => {
    c.line("if (principal === null) throw new Unauthenticated({ action });");
    c.line(`if (!admits(principal, required, { tenant: true, platform: ${platform ? "true" : "false"} })) throw denied(action, required);`);
  });
  if (tenancy) {
    imp.type(P.runtime, "Awaitable");
    c.line();
    c.doc("A principal acting in its active tenant (after `authorizeInTenant`).");
    c.line("export type TenantPrincipal = Principal & { readonly tenantId: TenantId };");
    c.line();
    c.doc(
      [
        "The first check of a tenant-scoped use case, query or read, before anything is loaded: there is a principal (else Unauthenticated), its token names an active tenant (else Unauthenticated with `error: \"missing_tenant\"`), and its roles in that tenant meet `required` (else NotAuthorized). Platform roles do not count here: they act across tenants only through `authorizeAcrossTenants`.",
        "",
        "Afterwards `principal.tenantId` is the tenant every repository and reader call is bound to.",
      ].join("\n"),
    );
    c.line("export function authorizeInTenant(");
    c.indent(() => {
      c.line("principal: Principal | null,");
      c.line("action: string,");
      c.line("required: Requirement,");
    });
    c.block("): asserts principal is TenantPrincipal", () => {
      c.line("if (principal === null) throw new Unauthenticated({ action });");
      c.line('if (principal.tenantId === null) throw new Unauthenticated({ action, error: "missing_tenant" });');
      c.line("if (!admits(principal, required, { tenant: true, platform: false })) throw denied(action, required);");
    });
    if (platform) {
      c.line();
      c.doc(
        "The first check of a cross-tenant use case (`cross_tenant: true`): only platform roles meet `required`; the caller's own tenant and tenant roles do not matter. The target tenant comes from the command, and the use case records the access through `CrossTenantAudit` before it loads anything.",
      );
      c.line("export function authorizeAcrossTenants(");
      c.indent(() => {
        c.line("principal: Principal | null,");
        c.line("action: string,");
        c.line("required: Requirement,");
      });
      c.block("): asserts principal is Principal", () => {
        c.line("if (principal === null) throw new Unauthenticated({ action });");
        c.line("if (!admits(principal, required, { tenant: false, platform: true })) throw denied(action, required);");
      });
      c.line();
      c.doc("One access of a platform principal to a tenant's data (a cross-tenant use case).");
      c.block("export interface CrossTenantAccess", () => {
        c.line("readonly action: string;");
        c.line("readonly principal: Principal;");
        c.line("readonly tenantId: TenantId;");
      });
      c.line();
      c.doc(
        "Port: records every cross-tenant access before the use case touches the tenant's data (an audit log, a SIEM). If it throws, the use case fails without loading anything. Implement it next to your logging; tests use `RecordingCrossTenantAudit`.",
      );
      c.block("export interface CrossTenantAudit", () => c.line("record(access: CrossTenantAccess): Awaitable<void>;"));
    }
  }
  c.line();
  c.doc("An `authorize.allow_if` rule: throws NotAuthorized (naming the rule, not the values) unless it holds.");
  c.block("export function allowIf(allowed: boolean, action: string): void", () => {
    c.line('if (!allowed) throw new NotAuthorized({ action, rule: "allow_if" });');
  });
}

function errorClass(c: Code, name: string, code: string, message: string): void {
  c.block(`export class ${name} extends DomainError`, () => {
    c.line(`static override readonly code = ${tsString(code)};`);
    c.line(`override readonly code = ${tsString(code)};`);
    c.line();
    c.line("constructor(");
    c.indent(() => {
      c.line("details: ErrorDetails = {},");
      c.line(`message = ${tsString(message)},`);
      c.line("options?: ErrorOptions,");
    });
    c.block(")", () => c.line("super(details, message, options);"));
  });
}

/** "one of the roles admin, staff" / "the role admin" / "any authenticated principal". */
export function rolesText(roles: string[]): string {
  if (!roles.length) return "any authenticated principal";
  return roles.length === 1 ? `the role ${roles[0]}` : `one of the roles ${roles.join(", ")}`;
}

/** rolesText, with the permissions that also admit (map-form roles): "the role admin or the permission invitation.read". */
export function requirementText(roles: string[], permissions: string[]): string {
  if (!permissions.length) return rolesText(roles);
  const p = permissions.length === 1 ? `the permission ${permissions[0]}` : `one of the permissions ${permissions.join(", ")}`;
  return roles.length ? `${rolesText(roles)} or ${p}` : p;
}

/** `["admin", "staff"]`: the roles argument of `authorize(...)`. */
export function rolesLiteral(roles: string[]): string {
  return `[${roles.map(tsString).join(", ")}]`;
}

/** `readCleaningStaffInvitation`: the read access function of an aggregate that needs a principal. */
export function readAccessName(ag: AggregateIR): string {
  return `read${ag.name}`;
}

/** Aggregates whose read access needs a principal (they get a function in read-access.ts). */
export function protectedAggregates(L: TsLayout): AggregateIR[] {
  return L.model.security ? L.ca.ir.aggregates.filter(requiresPrincipal) : [];
}

/**
 * `application/read-access.ts`: per aggregate whose `authorize` needs a principal, a function that checks the roles,
 * loads the aggregate and checks `allow_if` on it. The generated GET endpoint reads through it.
 */
export function readAccessFile(L: TsLayout): TsFile | undefined {
  const ags = protectedAggregates(L);
  if (!ags.length) return undefined;
  const mod = L.readAccess;
  const imp = new TsImports(mod);
  const c = new Code();
  if (!(L.model.security?.tenancy && ags.every((ag) => L.tenantScoped(ag)))) imp.value(L.security, "authorize");
  imp.type(L.security, "Principal");
  const rbac = usesPermissions(L.model.security) || !!L.model.security?.tenancy;
  for (const ag of ags) {
    const a = ag.authorize!;
    imp.type(L.ports, `${ag.name}Repository`);
    imp.type(L.mod("aggregates"), ag.name);
    const repo = `Pick<${ag.name}Repository, "get">`;
    const idType = tsType(L.tsFieldType(ag.name, ag.identity)!, imp, L);
    const action = `read ${ag.name}`;
    const tenant = L.tenantScoped(ag);
    c.line();
    const doc = [
      `Loads ${ag.name} for \`principal\` (\`authorize\` of ${ag.name}): ${requirementText(a.roles, a.permissions ?? [])}${a.allowIf ? `, and \`${a.allowIf}\` must hold for the loaded aggregate` : ""}.`,
      "",
      tenant
        ? "The roles are checked before loading, in the caller's active tenant; the aggregate is loaded from that tenant only (another tenant's is null, like a missing one). Returns null when it does not exist; throws Unauthenticated or NotAuthorized."
        : "The roles are checked before loading. Returns null when it does not exist; throws Unauthenticated or NotAuthorized.",
    ];
    c.doc(doc.join("\n"));
    c.line(`export async function ${readAccessName(ag)}(`);
    c.indent(() => {
      c.line(`repository: ${repo},`);
      c.line(`${prop(ag.identity)}: ${idType},`);
      c.line("principal: Principal | null,");
    });
    c.block(`): Promise<${ag.name} | null>`, () => {
      if (!rbac) {
        c.line(`authorize(principal, ${tsString(action)}, ${rolesLiteral(a.roles)});`);
        c.line(`const aggregate = await repository.get(${prop(ag.identity)});`);
      } else if (tenant) {
        imp.value(L.security, "authorizeInTenant");
        c.line(`authorizeInTenant(principal, ${tsString(action)}, ${requirementLiteral({ roles: a.roles, permissions: a.permissions ?? [] })});`);
        c.line(`const aggregate = await repository.get(principal.tenantId, ${prop(ag.identity)});`);
      } else {
        c.line(`authorize(principal, ${tsString(action)}, ${requirementLiteral({ roles: a.roles, permissions: a.permissions ?? [] })});`);
        c.line(`const aggregate = await repository.get(${prop(ag.identity)});`);
      }
      if (a.allowIf !== undefined) {
        imp.value(L.security, "allowIf");
        const e = L.ca.exprs.get(formatPath([...a.path, "allow_if"]))!;
        const scope = aggregateScope(L.model.security, ag);
        const ctx: ExprContext = { L, imports: imp, self: "aggregate", selfOwner: ag.name, ...(scope !== "none" ? { scope } : {}) };
        c.block("if (aggregate !== null)", () => c.line(`allowIf(${emitExpr(e, ctx)}, ${tsString(action)});`));
      }
      c.line("return aggregate;");
    });
  }
  return file(L, mod, `Read access of the ${L.ca.ir.name} aggregates: authorization around loading by identity.`, imp, c.toString());
}

