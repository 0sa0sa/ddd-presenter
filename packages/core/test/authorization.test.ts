/**
 * `security`, `authorize`, `rate_limit` and `given.principal` (docs/09 §20): parsing, validation (deny by default,
 * declared roles, typed principal in allow_if, allow_if only after leading loads, JWT algorithm rules, policies),
 * completion and the published JSON Schema.
 */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { checkExpression, complete, effectiveRateLimit, leadingLoads, makeEnv, principalEnv, scenarioPrincipal, validateModelText, type SecurityIR } from "../src/index.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/security.ddd.yaml"), "utf8");
/** A model without security (the examples declare it). */
const PLAIN = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/context-map.ddd.yaml"), "utf8");

const errors = (text: string) => validateModelText(text).diagnostics.filter((d) => d.severity === "error");
const codes = (text: string) => errors(text).map((d) => d.code);

describe("security: parsing and the valid fixture", () => {
  test("the fixture is valid and reads every part of the security block", () => {
    const r = validateModelText(FIXTURE);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const sec = r.model!.security!;
    expect(sec.roles).toEqual(["admin", "staff", "candidate"]);
    expect(sec.principal.idType).toBe("UUID");
    expect(sec.principal.claims.map((c) => [c.name, c.type, c.required, c.claim])).toEqual([
      ["company_id", "UUID", false, "https://example.com/company_id"],
      ["email", "String", false, undefined],
    ]);
    expect(sec.authentication).toMatchObject({ scheme: "bearer_jwt", issuer: "https://auth.example.com/", audience: "hiring-api", algorithms: ["RS256", "ES256"], rolesClaim: "roles", clockTolerance: 30 });
    expect(sec.rateLimits.default).toMatchObject({ requests: 60, per: "minute", by: "principal" });
    const ctx = r.model!.contexts[0]!;
    const uc = (n: string) => ctx.useCases.find((u) => u.name === n)!;
    expect(uc("post_job").authorize).toMatchObject({ kind: "principal", roles: ["admin", "staff"] });
    expect(uc("check_job_open").authorize?.kind).toBe("public");
    expect(uc("record_audit").authorize?.kind).toBe("internal");
    expect(uc("who_am_i").authorize).toMatchObject({ kind: "principal", roles: [] });
    expect(effectiveRateLimit(r.model!, uc("post_job"))).toMatchObject({ requests: 5, per: "minute" });
    expect(effectiveRateLimit(r.model!, uc("close_job"))).toMatchObject({ requests: 60 });
    expect(effectiveRateLimit(r.model!, ctx.aggregates.find((a) => a.name === "AuditEntry")!)).toBeUndefined();
    expect(leadingLoads(uc("apply_to_job").steps).map((s) => s.as)).toEqual(["job"]);
  });

  test("scenario principals: given, anonymous, or the default with the use case's roles", () => {
    const r = validateModelText(FIXTURE);
    const sec = r.model!.security!;
    const uc = r.model!.contexts[0]!.useCases.find((u) => u.name === "post_job")!;
    expect(scenarioPrincipal(sec, uc, uc.scenarios[0]!)).toEqual({
      anonymous: false,
      id: "00000000-0000-4000-8000-000000000011",
      roles: ["staff"],
      claims: { company_id: "00000000-0000-4000-8000-0000000000c1", email: null },
    });
    expect(scenarioPrincipal(sec, uc, uc.scenarios[2]!).anonymous).toBe(true);
    const noPrincipal = { ...uc.scenarios[0]!, given: { ...uc.scenarios[0]!.given, principal: undefined } };
    expect(scenarioPrincipal(sec, uc, noPrincipal)).toMatchObject({ roles: ["admin", "staff"], id: "00000000-0000-4000-8000-000000000001" });
  });

  test("models without security are unchanged; authorize without security is an error", () => {
    expect(validateModelText(PLAIN).model!.security).toBeUndefined();
    const text = PLAIN.replace("        command: AcceptCandidate\n", "        command: AcceptCandidate\n        authorize: public\n");
    expect(codes(text)).toContain("security-not-declared");
  });
});

describe("security: deny by default and declared roles", () => {
  test("every use case and aggregate needs authorize once security is declared", () => {
    expect(codes(FIXTURE.replace("        authorize: public\n", ""))).toEqual(["missing-authorize"]);
    expect(codes(FIXTURE.replace("        authorize: { roles: [admin] }\n", ""))).toEqual(["missing-authorize"]);
  });

  test("unknown roles are errors with a suggestion", () => {
    const e = errors(FIXTURE.replace("roles: [candidate]\n", "roles: [candidat]\n"));
    expect(e.map((d) => [d.code, d.hint])).toEqual([["unknown-role", 'Did you mean "candidate"?']]);
  });

  test("a policy cannot run a use case that needs a principal (it runs without one)", () => {
    expect(codes(FIXTURE.replace("        authorize: internal\n", "        authorize: authenticated\n"))).toContain("policy-needs-principal");
  });

  test("aggregates are not internal; a public endpoint cannot count by principal", () => {
    expect(codes(FIXTURE.replace("        authorize: { roles: [admin] }\n", "        authorize: internal\n"))).toContain("invalid-authorize");
    expect(codes(FIXTURE.replace("rate_limit: { requests: 100, per: minute, by: ip }", "rate_limit: { requests: 100, per: minute, by: principal }"))).toContain("rate-limit-without-principal");
  });

  test("rate limits: units and keys are checked; none opts out", () => {
    expect(codes(FIXTURE.replace("rate_limit: { requests: 5, per: minute, by: principal }", "rate_limit: { requests: 5, per: fortnight, by: principal }"))).toContain("invalid-value");
    expect(codes(FIXTURE.replace("rate_limit: { requests: 5, per: minute, by: principal }", "rate_limit: { requests: 0, per: minute }"))).toContain("invalid-value");
    expect(codes(FIXTURE.replace("rate_limit: { requests: 5, per: minute, by: principal }", "rate_limit: { requests: 5, per: minute, by: tenant }"))).toContain("invalid-value");
  });
});

describe("security: authentication settings (RFC 8725)", () => {
  test('"none" and mixed HMAC / public-key algorithm lists are rejected', () => {
    expect(codes(FIXTURE.replace("algorithms: [RS256, ES256]", "algorithms: [none]"))).toContain("insecure-algorithm");
    expect(codes(FIXTURE.replace("algorithms: [RS256, ES256]", "algorithms: [RS256, HS256]"))).toContain("mixed-algorithms");
    expect(codes(FIXTURE.replace("algorithms: [RS256, ES256]", "algorithms: [RS265]"))).toContain("invalid-value");
    expect(codes(FIXTURE.replace("clock_tolerance: 30", "clock_tolerance: 3600"))).toContain("invalid-value");
  });

  test("claims: snake_case, supported types, id and roles are built in", () => {
    expect(codes(FIXTURE.replace("{ name: email, type: String, required: false }", "{ name: email, type: Decimal, required: false }"))).toContain("invalid-claim-type");
    expect(codes(FIXTURE.replace("{ name: email, type: String, required: false }", "{ name: roles, type: String, required: false }"))).toContain("reserved-name");
    // Claims become attributes of the generated Principal: Python keywords and Pydantic members are reserved too.
    expect(codes(FIXTURE.replace("{ name: email, type: String, required: false }", "{ name: copy, type: String, required: false }"))).toEqual(["reserved-name"]);
    expect(codes(FIXTURE.replace("{ name: email, type: String, required: false }", "{ name: from, type: String, required: false }"))).toEqual(["reserved-name"]);
  });
});

describe("security: allow_if is a typed rule over the principal", () => {
  const sec = validateModelText(FIXTURE).model!.security as SecurityIR;
  const ctx = validateModelText(FIXTURE).model!.contexts[0]!;
  const check = (src: string) => checkExpression(src, makeEnv(ctx, { principal: principalEnv(sec) }));

  test("principal.id, principal.roles, declared claims and has_role are typed", () => {
    expect(check("principal.id == principal.id").errors).toEqual([]);
    expect(check('has_role(principal, admin) and has_role(principal, "staff")').errors).toEqual([]);
    expect(check('contains(principal.roles, "admin")').errors).toEqual([]);
    expect(check("principal.company_id != null and principal.company_id == principal.id").errors).toEqual([]);
  });

  test("mistakes are diagnostics with hints", () => {
    expect(check("principal.company_id == principal.id").errors[0]!.message).toMatch(/optional/);
    expect(check("principal.tenant == 1").errors[0]!.message).toBe('The principal has no member "tenant"');
    expect(check("has_role(principal, owner)").errors[0]!.message).toBe('Unknown role "owner"');
    expect(check("principal == null").errors[0]!.message).toMatch(/read through its members/);
    expect(checkExpression("principal.id == x", makeEnv(ctx)).errors[0]!.message).toMatch(/only available in authorization rules/);
  });

  test("allow_if may read inputs and the leading loads, not variables bound later", () => {
    expect(codes(FIXTURE.replace("allow_if: principal.id == candidate_id and job.is_open", "allow_if: principal.id == candidate_id and application.status == submitted"))).toEqual(["authorize-too-late"]);
    expect(codes(FIXTURE.replace("allow_if: principal.id == candidate_id and job.is_open", "allow_if: principal.id == job.title"))).toEqual(["invalid-expression"]);
  });

  test("principal is reserved for inputs and variables once security is declared", () => {
    expect(codes(FIXTURE.replace("input: [{ name: job_id, type: UUID }]", "input: [{ name: job_id, type: UUID }, { name: principal, type: UUID }]"))).toContain("reserved-name");
  });
});

describe("security: scenarios", () => {
  test("NotAuthorized / Unauthenticated are expected errors; anonymous callers must expect Unauthenticated", () => {
    expect(codes(FIXTURE.replace("then: { raises: Unauthenticated }", "then: { raises: NotAuthorized }"))).toContain("invalid-scenario");
    expect(codes(FIXTURE.replace("given: { principal: null }", "given: {}"))).toContain("invalid-scenario");
    expect(codes(FIXTURE.replace("principal: { roles: [admin] }\n", "principal: { roles: [root] }\n"))).toContain("unknown-role");
    expect(codes(FIXTURE.replace('claims: { company_id: "00000000-0000-4000-8000-0000000000c2" }', "claims: { company: x }"))).toContain("unknown-field");
  });
});

describe("security: completion and JSON Schema", () => {
  const at = (text: string, marker: string) => complete(text.replace(marker, ""), text.indexOf(marker)).items;

  test("keys and values of the security block, authorize and rate_limit are offered", () => {
    // Keys already present are not offered again: without rate_limits, it is the one offered.
    const withoutLimits = FIXTURE.replace("  rate_limits:\n    default: { requests: 60, per: minute, by: principal }\n", "  |\n");
    expect(at(withoutLimits, "|").map((i) => i.label)).toEqual(["rate_limits"]);
    const claim = at(FIXTURE.replace("      - { name: email, type: String, required: false }\n", "      - { name: email, type: String, required: false }\n      - |\n"), "|").map((i) => i.label);
    expect(claim).toEqual(["name", "type", "required", "claim", "description"]);
    const authorize = at(FIXTURE.replace("        authorize: public\n", "        authorize: |\n"), "|").map((i) => i.label);
    expect(authorize).toEqual(["public", "internal", "authenticated"]);
    const by = at(FIXTURE.replace("rate_limit: { requests: 3, per: hour, by: principal }", "rate_limit: { requests: 3, per: hour, by: | }"), "|").map((i) => i.label);
    expect(by).toEqual(["principal", "ip", "global"]);
    const rule = at(FIXTURE.replace("allow_if: principal.id == candidate_id and job.is_open", "allow_if: |"), "|").map((i) => i.label);
    expect(rule).toEqual(expect.arrayContaining(["principal.id", "principal.company_id", "has_role(principal, admin)"]));
  });

  test("the published schema accepts the fixture and rejects bad security values", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/model.schema.json"), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(parse(FIXTURE))).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    for (const [from, to] of [
      ["algorithms: [RS256, ES256]", "algorithms: [none]"],
      ["        authorize: public\n", "        authorize: everyone\n"],
      ["per: minute, by: ip", "per: week, by: ip"],
      ["clock_tolerance: 30", "clock_tolerance: 900"],
    ] as const) {
      expect({ to, ok: validate(parse(FIXTURE.replace(from, to))) }).toEqual({ to, ok: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Queries (docs/09 §21)
// ---------------------------------------------------------------------------

const SECURE_QUERIES = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/secure-queries.ddd.yaml"), "utf8");
const QUERIES = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/queries.ddd.yaml"), "utf8");

describe("security: queries", () => {
  test("the combined fixture is valid and reads authorize, rate_limit, principal filters and scenario principals", () => {
    const r = validateModelText(SECURE_QUERIES);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const [company, mine, open] = r.model!.contexts[0]!.queries!;
    expect(company!.authorize).toMatchObject({ kind: "principal", roles: ["admin", "staff"] });
    expect(company!.rateLimit).toMatchObject({ requests: 10, per: "minute", by: "principal" });
    expect(company!.where[0]).toMatchObject({ field: "company_id", op: "eq", principal: "company_id" });
    expect(company!.scenarios[0]!.given.principal).toMatchObject({ roles: ["staff"], claims: { company_id: "00000000-0000-4000-8000-0000000000c1" } });
    expect(mine!.authorize).toMatchObject({ kind: "principal", roles: [] });
    expect(mine!.where[0]!.principal).toBe("id");
    expect(open!.authorize!.kind).toBe("public");
    expect(effectiveRateLimit(r.model!, mine!)).toMatchObject({ requests: 60, by: "principal" });
  });

  test("deny by default: with security every query needs authorize; without it authorize and principal filters are errors", () => {
    expect(codes(SECURE_QUERIES.replace("        authorize: authenticated\n", ""))).toEqual(["missing-authorize"]);
    const plain = QUERIES.replace("        from: Member\n", "        from: Member\n        authorize: public\n");
    expect(codes(plain)).toContain("security-not-declared");
  });

  test("internal and allow_if do not apply to queries; public queries have no principal to filter or count by", () => {
    expect(codes(SECURE_QUERIES.replace("        authorize: authenticated\n", "        authorize: internal\n"))).toContain("invalid-authorize");
    const rule = errors(SECURE_QUERIES.replace("        authorize: authenticated\n", "        authorize: { roles: [candidate], allow_if: \"principal.id != null\" }\n"));
    expect(rule.map((d) => d.code)).toEqual(["invalid-authorize"]);
    expect(rule[0]!.hint).toContain("principal: company_id");
    expect(codes(SECURE_QUERIES.replace("        authorize: authenticated\n", "        authorize: public\n"))).toContain("invalid-principal-filter");
    expect(codes(SECURE_QUERIES.replace("rate_limit: { requests: 30, per: minute, by: ip }", "rate_limit: { requests: 30, per: minute, by: principal }"))).toContain("rate-limit-without-principal");
    expect(codes(SECURE_QUERIES.replace("        authorize: { roles: [admin, staff] }\n        rate_limit", "        authorize: { roles: [admn, staff] }\n        rate_limit"))).toContain("unknown-role");
  });

  test("principal filters: id or a declared scalar claim of the field's type; one source per filter", () => {
    const filter = "          - { field: company_id, op: eq, principal: company_id }\n";
    const e = errors(SECURE_QUERIES.replace(filter, "          - { field: company_id, op: eq, principal: compnay_id }\n"));
    expect(e.map((d) => [d.code, d.hint])).toEqual([["unknown-field", 'Did you mean "company_id"?']]);
    expect(codes(SECURE_QUERIES.replace(filter, "          - { field: company_id, op: eq, principal: roles }\n"))).toEqual(["unknown-field"]);
    expect(codes(SECURE_QUERIES.replace(filter, "          - { field: title, op: eq, principal: company_id }\n"))).toEqual(["type-mismatch"]);
    expect(codes(SECURE_QUERIES.replace(filter, "          - { field: company_id, op: eq, principal: company_id, param: status }\n"))).toContain("invalid-shape");
    // A Ref compares with its target's identity type (UUID here).
    const ref = SECURE_QUERIES.replace("          - { field: candidate_id, op: eq, principal: id }\n", "          - { field: job_id, op: eq, principal: id }\n");
    expect(codes(ref).filter((c) => c !== "invalid-scenario")).toEqual([]);
  });

  test("scenarios run as a principal that may run the query and has the claims its rows are scoped by", () => {
    const own = "              principal: { roles: [staff], claims: { company_id: \"00000000-0000-4000-8000-0000000000c1\" } }\n";
    expect(codes(SECURE_QUERIES.replace(own, "              principal: { roles: [staff] }\n"))).toEqual(["invalid-scenario"]);
    expect(codes(SECURE_QUERIES.replace(own, ""))).toEqual(["invalid-scenario"]);
    expect(codes(SECURE_QUERIES.replace(own, "              principal: { roles: [candidate], claims: { company_id: \"00000000-0000-4000-8000-0000000000c1\" } }\n"))).toEqual(["invalid-scenario"]);
    expect(codes(SECURE_QUERIES.replace(own, "              principal: null\n"))).toEqual(["invalid-scenario"]);
    expect(codes(SECURE_QUERIES.replace(own, "              principal: { roles: [stuff], claims: { company_id: \"00000000-0000-4000-8000-0000000000c1\" } }\n"))).toContain("unknown-role");
    const warnings = validateModelText(SECURE_QUERIES.replace("            given: { aggregates: *jobs }\n", "            given: { aggregates: *jobs, principal: { roles: [admin] } }\n")).diagnostics.map((d) => d.code);
    expect(warnings).toContain("unused-principal");
  });

  test("a query cannot take the name of an aggregate's read rate limit (they would share a bucket)", () => {
    expect(codes(SECURE_QUERIES.replace("      - name: open_jobs\n", "      - name: read_job\n"))).toContain("duplicate-name");
  });

  test("completion offers the query's authorize values, its keys and the principal members of a filter", () => {
    const at = (text: string, marker: string) => complete(text.replace(marker, ""), text.indexOf(marker)).items.map((i) => i.label);
    expect(at(SECURE_QUERIES.replace("        authorize: authenticated\n", "        authorize: |\n"), "|")).toEqual(["public", "authenticated"]);
    expect(at(SECURE_QUERIES.replace("principal: company_id }", "principal: | }"), "|")).toEqual(["id", "company_id"]);
    expect(at(SECURE_QUERIES.replace("        authorize: { roles: [admin, staff] }\n        rate_limit", "        authorize: { roles: [|] }\n        rate_limit"), "|")).toEqual(["admin", "staff", "candidate"]);
    const keys = at(SECURE_QUERIES.replace("        authorize: authenticated\n", "        |\n"), "|");
    expect(keys).toContain("authorize");
    expect(keys).not.toContain("from");
    // Without security the query does not offer authorize / rate_limit.
    const plainKeys = at(QUERIES.replace("        from: Member\n", "        from: Member\n        |\n"), "|");
    expect(plainKeys).not.toContain("authorize");
  });

  test("the published schema accepts protected queries and rejects internal / allow_if on them", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/model.schema.json"), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(parse(SECURE_QUERIES))).toBe(true);
    for (const [from, to] of [
      ["        authorize: authenticated\n", "        authorize: internal\n"],
      ["        authorize: authenticated\n", '        authorize: { roles: [admin], allow_if: "true" }\n'],
      ["principal: company_id }", "principal: Company }"],
    ] as const) {
      expect({ to, ok: validate(parse(SECURE_QUERIES.replace(from, to))) }).toEqual({ to, ok: false });
    }
  });
});
