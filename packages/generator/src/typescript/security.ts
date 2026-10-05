/**
 * Authentication, authorization and rate limiting for the TypeScript target (`security`, docs/09 §20): the shared
 * `generated/security.ts` module (roles, the Principal schema, NotAuthorized / Unauthenticated, the authorization
 * helpers every protected use case calls first) and each context's read access (`application/read-access.ts`).
 */
import { claimType, formatPath, requiresPrincipal, type AggregateIR, type ModelIR, type Type } from "@ddd/core";
import { assemble, Code, header, TsImports, tsString } from "./code.ts";
import { file, type TsFile } from "./domain.ts";
import { emitExpr, type ExprContext } from "./expr.ts";
import type { TsLayout, TsPaths } from "./layout.ts";
import { prop } from "./names.ts";
import { tsType } from "./types.ts";

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
  const c = new Code();
  c.line();
  c.doc("Roles declared in the model (`security.roles`).");
  c.line(`export const ROLES = [${sec.roles.map(tsString).join(", ")}] as const;`);
  c.line("export const RoleSchema = z.enum(ROLES);");
  c.line("export type Role = z.output<typeof RoleSchema>;");
  c.line();
  const fields = [
    `id: ${sec.principal.idType === "UUID" ? (imp.value(P.runtime, "uuidSchema"), "uuidSchema") : "z.string().min(1)"},`,
    "roles: z.array(RoleSchema).readonly(),",
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
      "The authenticated caller: an id, the roles it holds and the declared claims (`security.principal`).",
      "",
      "Use cases that declare `authorize` with roles or a rule take it as `execute(command, principal)`; the HTTP layer builds it from the bearer token. Create one in tests with `Principal.create({ id, roles })`.",
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
      c.line(`clockTolerance: ${auth.clockTolerance},`);
    }, " as const;");
    c.line();
    c.doc(
      [
        `The principal a verified token stands for: \`sub\` is the id, \`${auth.rolesClaim}\` the roles (a list, or one space-separated string; roles the model does not declare are dropped)${sec.principal.claims.length ? `, ${sec.principal.claims.map((cl) => `\`${cl.claim ?? cl.name}\` ${prop(cl.name)}`).join(", ")}` : ""}.`,
        "",
        "Null when the claims do not fit the Principal schema (e.g. a required claim is missing).",
      ].join("\n"),
    );
    c.block("export function principalFromClaims(claims: Readonly<Record<string, unknown>>): Principal | null", () => {
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
  imp.value(L.security, "authorize");
  imp.type(L.security, "Principal");
  for (const ag of ags) {
    const a = ag.authorize!;
    imp.type(L.ports, `${ag.name}Repository`);
    imp.type(L.mod("aggregates"), ag.name);
    const repo = `Pick<${ag.name}Repository, "get">`;
    const idType = tsType(L.tsFieldType(ag.name, ag.identity)!, imp, L);
    const action = `read ${ag.name}`;
    c.line();
    const doc = [
      `Loads ${ag.name} for \`principal\` (\`authorize\` of ${ag.name}): ${rolesText(a.roles)}${a.allowIf ? `, and \`${a.allowIf}\` must hold for the loaded aggregate` : ""}.`,
      "",
      "The roles are checked before loading. Returns null when it does not exist; throws Unauthenticated or NotAuthorized.",
    ];
    c.doc(doc.join("\n"));
    c.line(`export async function ${readAccessName(ag)}(`);
    c.indent(() => {
      c.line(`repository: ${repo},`);
      c.line(`${prop(ag.identity)}: ${idType},`);
      c.line("principal: Principal | null,");
    });
    c.block(`): Promise<${ag.name} | null>`, () => {
      c.line(`authorize(principal, ${tsString(action)}, ${rolesLiteral(a.roles)});`);
      c.line(`const aggregate = await repository.get(${prop(ag.identity)});`);
      if (a.allowIf !== undefined) {
        imp.value(L.security, "allowIf");
        const e = L.ca.exprs.get(formatPath([...a.path, "allow_if"]))!;
        const ctx: ExprContext = { L, imports: imp, self: "aggregate", selfOwner: ag.name };
        c.block("if (aggregate !== null)", () => c.line(`allowIf(${emitExpr(e, ctx)}, ${tsString(action)});`));
      }
      c.line("return aggregate;");
    });
  }
  return file(L, mod, `Read access of the ${L.ca.ir.name} aggregates: authorization around loading by identity.`, imp, c.toString());
}

