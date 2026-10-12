/**
 * Multi-tenancy and RBAC (docs/09 §22): the map form of roles (inheritance, permissions), platform roles,
 * `security.tenancy`, aggregate tenancy, cross-tenant use cases, permission checks in authorize and rules, the scope
 * rules (tenant roles in a tenant, platform roles across tenants and for shared data), completion and the schema.
 */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  aggregateScope,
  complete,
  defaultRoles,
  otherRoles,
  roleIncludes,
  rolePermissions,
  satisfies,
  scenarioPrincipal,
  useCaseScope,
  validateModelText,
} from "../src/index.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/tenancy.ddd.yaml"), "utf8");
const SECURITY = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/security.ddd.yaml"), "utf8");

const errors = (text: string) => validateModelText(text).diagnostics.filter((d) => d.severity === "error");
const codes = (text: string) => errors(text).map((d) => d.code);
const replaced = (from: string, to: string, text = FIXTURE) => {
  if (!text.includes(from)) throw new Error(`fixture does not contain ${from}`);
  return text.replace(from, to);
};

describe("tenancy and RBAC: parsing and resolution", () => {
  const r = validateModelText(FIXTURE);
  const sec = r.model!.security!;

  test("the fixture is valid", () => {
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("tenancy, map-form roles and platform roles are read", () => {
    expect(sec.tenancy).toMatchObject({ claim: "org_id", type: "UUID", isolation: "row", platformRolesClaim: "platform_roles" });
    expect(sec.roles).toEqual(["admin", "staff", "candidate"]);
    expect(sec.roleDefs!.map((d) => [d.name, d.inherits, d.permissions])).toEqual([
      ["admin", ["staff"], ["invitation.revoke"]],
      ["staff", [], ["invitation.issue", "invitation.read", "invitation.list"]],
      ["candidate", [], ["invitation.accept"]],
    ]);
    expect(sec.platformRoles.map((d) => d.name)).toEqual(["operator", "support"]);
    expect(r.model!.contexts[0]!.aggregates.map((a) => a.tenancy)).toEqual(["global", undefined]);
  });

  test("inheritance is resolved into role closures and permission sets (NIST RBAC1)", () => {
    expect(Object.fromEntries(roleIncludes(sec, "tenant"))).toEqual({ admin: ["admin", "staff"], staff: ["staff"], candidate: ["candidate"] });
    expect(Object.fromEntries(rolePermissions(sec, "tenant"))).toEqual({
      admin: ["invitation.issue", "invitation.list", "invitation.read", "invitation.revoke"],
      staff: ["invitation.issue", "invitation.list", "invitation.read"],
      candidate: ["invitation.accept"],
    });
    expect(Object.fromEntries(rolePermissions(sec, "platform"))).toEqual({
      operator: ["invitation.read", "template.manage"],
      support: ["invitation.read", "invitation.revoke", "template.manage"],
    });
  });

  test("the scope of each operation and the default scenario principal", () => {
    const ctx = r.model!.contexts[0]!;
    const uc = (n: string) => ctx.useCases.find((u) => u.name === n)!;
    expect(useCaseScope(sec, ctx, uc("issue_invitation"))).toBe("tenant");
    expect(useCaseScope(sec, ctx, uc("support_revoke_invitation"))).toBe("cross_tenant");
    expect(useCaseScope(sec, ctx, uc("define_template"))).toBe("global");
    expect(aggregateScope(sec, ctx.aggregates[0]!)).toBe("global");
    expect(aggregateScope(sec, ctx.aggregates[1]!)).toBe("tenant");
    // The first tenant role granting a listed permission; platform roles across tenants.
    expect(defaultRoles(sec, uc("revoke_invitation").authorize)).toEqual({ roles: ["admin"], platformRoles: [] });
    expect(defaultRoles(sec, uc("support_revoke_invitation").authorize)).toEqual({ roles: [], platformRoles: ["support"] });
    const p = scenarioPrincipal(sec, uc("issue_invitation"), { given: {} });
    expect(p).toMatchObject({ roles: ["staff"], tenant: "00000000-0000-4000-8000-0000000000a1", platformRoles: [] });
    // Inherited roles pass; tenant roles never pass across tenants.
    expect(satisfies(sec, uc("issue_invitation").authorize!, { ...p, roles: ["admin"] }, "tenant")).toBe(true);
    expect(satisfies(sec, uc("support_revoke_invitation").authorize!, { ...p, roles: ["admin"] }, "cross_tenant")).toBe(false);
    expect(otherRoles(sec, uc("revoke_invitation").authorize!)).toEqual(["staff", "candidate"]);
  });

  test("models without tenancy and with list-form roles are unchanged", () => {
    const plain = validateModelText(SECURITY);
    expect(plain.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plain.model!.security!.roleDefs).toBeUndefined();
    expect(plain.model!.security!.tenancy).toBeUndefined();
    const ctx = plain.model!.contexts[0]!;
    expect(useCaseScope(plain.model!.security, ctx, ctx.useCases[0]!)).toBe("none");
    expect(scenarioPrincipal(plain.model!.security!, ctx.useCases[0]!, { given: {} })).not.toHaveProperty("tenant");
  });
});

describe("tenancy and RBAC: validation", () => {
  test("permission names, unknown permissions and roles", () => {
    expect(codes(replaced("candidate: { permissions: [invitation.accept] }", "candidate: { permissions: [Invitation.Accept, accept] }"))).toEqual(expect.arrayContaining(["invalid-name"]));
    expect(codes(replaced("authorize: { permissions: [invitation.issue] }", "authorize: { permissions: [invitation.isue] }"))).toContain("unknown-permission");
    expect(codes(replaced("authorize: { roles: [admin] }\n        fields:\n          - { name: id, type: UUID }\n          - { name: invitation_id", "authorize: { roles: [root] }\n        fields:\n          - { name: id, type: UUID }\n          - { name: invitation_id"))).toContain("unknown-role");
    // List-form roles grant no permissions.
    expect(codes(replaced("authorize: { roles: [admin] }", "authorize: { permissions: [job.post] }", SECURITY))).toContain("unknown-permission");
  });

  test("inheritance: unknown roles, cycles, and never across tenant and platform roles", () => {
    expect(codes(replaced("admin: { inherits: [staff],", "admin: { inherits: [stuff],"))).toContain("unknown-role");
    expect(codes(replaced("staff: { permissions:", "staff: { inherits: [admin], permissions:"))).toContain("inheritance-cycle");
    expect(codes(replaced("admin: { inherits: [staff],", "admin: { inherits: [staff, operator],"))).toContain("invalid-inheritance");
    expect(codes(replaced("support: { inherits: [operator],", "support: { inherits: [staff],"))).toContain("invalid-inheritance");
    expect(codes(replaced("    support: {", "    staff: {"))).toContain("duplicate-name");
  });

  test("platform roles and cross_tenant need tenancy; by: tenant needs tenancy", () => {
    const noTenancy = replaced("  tenancy:\n    claim: org_id\n    type: UUID\n    isolation: row\n", "");
    expect(codes(noTenancy)).toEqual(expect.arrayContaining(["tenancy-not-declared"]));
    expect(codes(replaced("authorize: { roles: [admin] }", "authorize: { roles: [admin], cross_tenant: true }", SECURITY))).toContain("tenancy-not-declared");
  });

  test("scopes: tenant roles in a tenant, platform roles across tenants and for shared data", () => {
    // A platform role inside a tenant's own operation.
    expect(codes(replaced("authorize: { permissions: [invitation.issue] }", "authorize: { roles: [operator] }"))).toContain("platform-role-in-tenant");
    // A permission only platform roles grant, inside a tenant.
    expect(codes(replaced("authorize: { permissions: [invitation.issue] }", "authorize: { permissions: [template.manage] }"))).toContain("permission-not-granted");
    // A tenant role across tenants.
    expect(codes(replaced("authorize: { permissions: [invitation.revoke], cross_tenant: true }", "authorize: { roles: [admin], cross_tenant: true }"))).toContain("tenant-role-across-tenants");
    expect(codes(replaced("authorize: { permissions: [invitation.revoke], cross_tenant: true }", "authorize: { permissions: [invitation.accept], cross_tenant: true }"))).toContain("permission-not-granted");
    // Shared data is changed by platform roles only.
    expect(codes(replaced("authorize: { permissions: [template.manage] }", "authorize: { roles: [admin] }"))).toContain("global-write-needs-platform-role");
    expect(codes(replaced("authorize: { permissions: [template.manage] }", "authorize: authenticated"))).toContain("global-write-needs-platform-role");
    // cross_tenant applies to use cases only, and only to ones touching tenant data.
    expect(codes(replaced("authorize: { permissions: [invitation.list] }", "authorize: { permissions: [invitation.list], cross_tenant: true }"))).toContain("invalid-authorize");
    expect(codes(replaced("authorize: { permissions: [template.manage] }", "authorize: { permissions: [template.manage], cross_tenant: true }"))).toContain("invalid-authorize");
  });

  test("public access to tenant data has no tenant", () => {
    expect(codes(replaced("authorize: { permissions: [invitation.list] }", "authorize: public"))).toContain("tenant-required");
    expect(codes(replaced("authorize: { permissions: [invitation.issue] }", "authorize: public"))).toContain("tenant-required");
    // Shared data may be public.
    expect(codes(replaced("authorize: authenticated\n", "authorize: public\n"))).not.toContain("tenant-required");
  });

  test("tenant_id is reserved; shared data cannot reference tenant data", () => {
    expect(codes(replaced("          - { name: title, type: String }\n        factories:", "          - { name: title, type: String }\n          - { name: tenant_id, type: UUID }\n        factories:"))).toContain("reserved-name");
    expect(codes(replaced("        input: [{ name: title, type: String }]", "        input: [{ name: title, type: String }, { name: tenant_id, type: UUID }]"))).toContain("reserved-name");
    expect(codes(replaced("          - { name: title, type: String }\n        factories:", "          - { name: title, type: String }\n          - { name: example, type: \"Ref[Invitation]\", required: false }\n        factories:"))).toContain("global-references-tenant");
  });

  test("rate limits by tenant only where there is a tenant", () => {
    expect(codes(replaced("authorize: { permissions: [invitation.read], cross_tenant: true }", "authorize: { permissions: [invitation.read], cross_tenant: true }\n        rate_limit: { requests: 5, per: minute, by: tenant }"))).toContain("rate-limit-without-tenant");
  });

  test("a policy needs a tenant-scoped event to run a tenant-scoped use case", () => {
    const text = replaced("    events: [InvitationAccepted]", "    events: [InvitationAccepted, TemplateDefined]").replace(
      "        args: { invitation_id: event.id }",
      "        args: { invitation_id: event.id }\n      - name: register_on_template\n        when: Hiring.TemplateDefined\n        run: register_staff\n        args: { invitation_id: event.id }",
    );
    expect(codes(text)).toContain("policy-without-tenant");
  });

  test("has_permission in rules: declared permissions only", () => {
    expect(codes(replaced('has_permission(principal, "invitation.read")', "has_permission(principal, invitation.read)"))).toEqual([]);
    expect(errors(replaced('has_permission(principal, "invitation.read")', 'has_permission(principal, "invitation.rad")')).map((d) => d.message).join("\n")).toContain('Unknown permission "invitation.rad"');
  });

  test("scenario principals: tenant and platform roles", () => {
    expect(codes(replaced("platform_roles: [operator] }\n              aggregates:", "platform_roles: [operatr] }\n              aggregates:"))).toContain("unknown-role");
    expect(codes(replaced('tenant: "00000000-0000-4000-8000-0000000000b2"', "tenant: not-a-uuid"))).toContain("invalid-scenario-value");
  });
});

describe("tenancy and RBAC: completion and JSON Schema", () => {
  const at = (text: string, marker: string) => complete(text.replace(marker, ""), text.indexOf(marker)).items.map((i) => i.label);

  test("keys and values are offered", () => {
    expect(at(replaced("    isolation: row\n", "    isolation: row\n    |\n"), "|")).toEqual(["platform_roles_claim"]);
    expect(at(replaced("candidate: { permissions: [invitation.accept] }", "candidate: { permissions: [invitation.accept], | }"), "|")).toEqual(expect.arrayContaining(["inherits", "description"]));
    expect(at(replaced("authorize: { permissions: [invitation.issue] }", "authorize: { permissions: [|] }"), "|")).toEqual(expect.arrayContaining(["invitation.issue", "template.manage"]));
    expect(at(replaced("        tenancy: global\n", "        tenancy: |\n"), "|")).toEqual(["tenant", "global"]);
    expect(at(replaced("by: tenant }\n\ncontexts", "by: | }\n\ncontexts"), "|")).toContain("tenant");
  });

  test("the published schema accepts the fixture and rejects bad tenancy values", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/model.schema.json"), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(parse(FIXTURE))).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    for (const [from, to] of [
      ["isolation: row", "isolation: schema"],
      ["candidate: { permissions: [invitation.accept] }", "candidate: { permissions: [Invitation] }"],
      ["        tenancy: global\n", "        tenancy: shared\n"],
      ["by: tenant }\n\ncontexts", "by: org }\n\ncontexts"],
    ] as const) {
      expect(validate(parse(replaced(from, to)))).toBe(false);
    }
    // The list form of roles stays valid.
    expect(validate(parse(SECURITY))).toBe(true);
  });
});
