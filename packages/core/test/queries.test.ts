import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, hover, planQuery, tableOf, validateModelText, type Diagnostic } from "../src/index.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/queries.ddd.yaml"), "utf8");

/** A small model with one aggregate and the given query block (indented under `queries:`). */
function model(query: string, extraFields = ""): string {
  return `schema_version: 1
project: q
generation: { package: q }
contexts:
  - name: Shop
    enums:
      - { name: Status, values: [open, closed] }
    value_objects:
      - name: Email
        fields: [{ name: value, type: String }]
      - name: Note
        fields: [{ name: text, type: String }]
    aggregates:
      - name: Order
        identity: id
        fields:
          - { name: id, type: UUID }
          - { name: email, type: Email }
          - { name: status, type: Status }
          - { name: placed_at, type: DateTime }
          - { name: total, type: Decimal }
          - { name: note, type: Note, required: false }
          - { name: tags, type: "List[String]" }
          - { name: closed_at, type: DateTime, required: false }${extraFields}
    queries:
${query}
`;
}

function errors(text: string): Diagnostic[] {
  return validateModelText(text).diagnostics.filter((d) => d.severity === "error");
}
function codes(text: string, severity: "error" | "warning" = "error"): string[] {
  return validateModelText(text).diagnostics.filter((d) => d.severity === severity).map((d) => d.code);
}

describe("queries: parsing and validation", () => {
  test("the fixture is valid and plans resolve (identity appended, relevance only with search)", () => {
    const r = validateModelText(FIXTURE);
    expect(r.diagnostics).toEqual([]);
    const ca = r.analysis!.contexts.get("Directory")!;
    const plans = ca.ir.queries.map((q) => planQuery(ca.ir, ca.fieldTypes, q)!);
    expect(plans.map((p) => p.keys.map((k) => (k.relevance ? "relevance" : `${k.column!.name} ${k.direction}`)))).toEqual([
      ["relevance", "joined_at desc", "id desc"],
      ["status asc", "points desc", "id desc"],
      ["display_name asc", "id asc"],
      ["joined_at asc", "id asc"],
    ]);
    // Parameters are optional unless `required: true`.
    expect(plans[0]!.params.map((p) => p.type.k)).toEqual(["optional", "optional"]);
    expect(plans[2]!.params.map((p) => p.type.k)).toEqual(["primitive"]);
    expect(plans[0]!.search).toMatchObject({ mode: "trigram", minSimilarity: 0.3, prefilter: true });
  });

  test("table mapping: value objects flattened, optional value objects / lists / entities as jsonb, enums with values", () => {
    const ca = validateModelText(FIXTURE).analysis!.contexts.get("Directory")!;
    const t = tableOf(ca.ir, ca.fieldTypes, ca.ir.aggregates[0]!);
    expect(t.schema).toBe("directory");
    expect(t.name).toBe("member");
    expect(t.columns.map((c) => `${c.name}:${c.sql}${c.nullable ? "?" : ""}`)).toEqual([
      "id:uuid",
      "display_name:text",
      "email_value:text",
      "status:text",
      "joined_at:timestamptz",
      "birthday:date?",
      "points:bigint",
      "balance_amount:numeric",
      "balance_currency:text",
      "nickname:text?",
      "referrer:uuid?",
      "tags:jsonb",
      "badges:jsonb",
      "home:jsonb?",
    ]);
    expect(t.columns.find((c) => c.name === "status")!.enumValues).toEqual(["active", "suspended", "left"]);
  });

  test("unknown keys, operators and modes are parse errors", () => {
    expect(codes(model("      - { name: q1, from: Order, colour: red }"))).toContain("unknown-key");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: status, op: like, value: open }] }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value], mode: fuzzy } }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value], mode: exact, min_similarity: 0.5 } }"))).toContain("invalid-value");
  });

  test("names: snake_case, unique, not a use case / aggregate / generated module, no clash with generated classes", () => {
    expect(codes(model("      - { name: ListOrders, from: Order }"))).toContain("invalid-name");
    expect(codes(model("      - { name: list_orders, from: Order }\n      - { name: list_orders, from: Order }"))).toContain("duplicate-name");
    expect(codes(model("      - { name: order, from: Order }"))).toContain("duplicate-name");
    expect(codes(model("      - { name: persistence, from: Order }"))).toContain("reserved-name");
    expect(codes(model("      - { name: list_orders, from: Ordr }"))).toContain("unknown-aggregate");
  });

  test("parameters: primitive / enum / Ref only, not cursor / limit / the search parameter, unused ones warned", () => {
    expect(codes(model("      - { name: q1, from: Order, params: [{ name: e, type: Email }], where: [{ field: email.value, param: e }] }"))).toContain("invalid-type");
    expect(codes(model("      - { name: q1, from: Order, params: [{ name: cursor, type: String }], where: [{ field: email.value, param: cursor }] }"))).toContain("reserved-name");
    expect(codes(model("      - { name: q1, from: Order, params: [{ name: q, type: String }], where: [{ field: email.value, param: q }], search: { param: q, fields: [email.value] } }"))).toContain("duplicate-name");
    expect(codes(model("      - { name: q1, from: Order, params: [{ name: s, type: Status }] }"), "warning")).toContain("unused-parameter");
  });

  test("filters: field paths through value objects, operators by type, parameter types, literals", () => {
    expect(errors(model("      - { name: q1, from: Order, params: [{ name: e, type: String }], where: [{ field: email.value, op: eq, param: e }] }"))).toEqual([]);
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: emial.value, value: x }] }"))).toContain("unknown-field");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: note.text, value: x }] }"))).toContain("unqueryable-field");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: tags, value: x }] }"))).toContain("unqueryable-field");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: status, op: lt, value: open }] }"))).toContain("invalid-operator");
    expect(codes(model("      - { name: q1, from: Order, params: [{ name: s, type: Integer }], where: [{ field: status, param: s }] }"))).toContain("type-mismatch");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: status, value: shipped }] }"))).toContain("invalid-scenario-value");
    expect(codes(model("      - { name: q1, from: Order, where: [{ field: status }] }"))).toContain("missing-key");
    // Integer widens to Decimal.
    expect(errors(model("      - { name: q1, from: Order, params: [{ name: n, type: Integer }], where: [{ field: total, op: gte, param: n }] }"))).toEqual([]);
  });

  test("search: String fields with their own column, trigram threshold range, a warning below pg_trgm's default", () => {
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [total] } }"))).toContain("invalid-type");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email] } }"))).toContain("invalid-type");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [note.text] } }"))).toContain("unqueryable-field");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [] } }"))).toContain("missing-key");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value], min_similarity: 1.5 } }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value], min_similarity: 0.1 } }"), "warning")).toContain("trigram-threshold-below-default");
  });

  test("order_by: required sortable fields, relevance only with a trigram search (desc), no duplicates", () => {
    expect(codes(model("      - { name: q1, from: Order, order_by: [relevance] }"))).toContain("invalid-order");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value], mode: prefix }, order_by: [relevance] }"))).toContain("invalid-order");
    expect(codes(model("      - { name: q1, from: Order, search: { fields: [email.value] }, order_by: [{ field: relevance, direction: asc }] }"))).toContain("invalid-order");
    expect(codes(model("      - { name: q1, from: Order, order_by: [closed_at] }"))).toContain("invalid-order");
    expect(codes(model("      - { name: q1, from: Order, order_by: [tags] }"))).toContain("unqueryable-field");
    expect(codes(model("      - { name: q1, from: Order, order_by: [placed_at, placed_at] }"))).toContain("duplicate-name");
    expect(codes(model("      - { name: q1, from: Order, order_by: [id, placed_at] }"), "warning")).toContain("redundant-order");
    expect(errors(model("      - { name: q1, from: Order, search: { fields: [email.value] }, order_by: [relevance, { field: placed_at, direction: desc }] }"))).toEqual([]);
  });

  test("page bounds and projection", () => {
    expect(codes(model("      - { name: q1, from: Order, page: { size: 0 } }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, page: { size: 50, max_size: 10 } }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, page: { size: 10, max_size: 5000 } }"))).toContain("invalid-value");
    expect(codes(model("      - { name: q1, from: Order, returns: [id, emial] }"))).toContain("unknown-field");
    expect(codes(model("      - { name: q1, from: Order, returns: [email.value] }"))).toContain("unknown-field");
  });

  test("columns of a context with queries must not clash (flattening, the version column)", () => {
    expect(codes(model("      - { name: q1, from: Order }", "\n          - { name: email_value, type: String }"))).toContain("column-clash");
    expect(codes(model("      - { name: q1, from: Order }", "\n          - { name: version, type: Integer }"))).toContain("reserved-name");
    // Without queries the same fields are fine (no table is generated).
    expect(codes(model("      []", "\n          - { name: version, type: Integer }"))).not.toContain("reserved-name");
  });

  test("scenarios: given aggregates checked like stored aggregates, params typed, items are identities or partial items", () => {
    const base = (scenario: string, extra = "") => model(`      - name: q1
        from: Order
        params: [{ name: s, type: Status }]
        where: [{ field: status, param: s }]${extra}
        scenarios:
${scenario}`);
    const given = `          - name: one
            given:
              aggregates:
                - fields: { id: "00000000-0000-0000-0000-000000000001", email: { value: a@b.c }, status: open, placed_at: "2026-01-01T00:00:00+00:00", total: "1", tags: [] }`;
    expect(errors(base(`${given}\n            when: { params: { s: open } }\n            then: { items: ["00000000-0000-0000-0000-000000000001"], next_cursor: absent }`))).toEqual([]);
    expect(codes(base(`${given}\n            when: { params: { s: shut } }\n            then: { next_cursor: absent }`))).toContain("invalid-scenario-value");
    expect(codes(base(`${given}\n            when: { params: { x: open } }\n            then: { next_cursor: absent }`))).toContain("unknown-field");
    expect(codes(base(`${given}\n            then: {}`))).toContain("ambiguous-scenario");
    expect(codes(base(`${given}\n            then: { items: [{ colour: red }] }`))).toContain("unknown-field");
    expect(codes(base(`${given}\n            when: { limit: 500 }\n            then: { next_cursor: absent }`))).toContain("invalid-value");
    expect(codes(base(`          - name: two\n            given: { aggregates: [{ fields: { id: "00000000-0000-0000-0000-000000000001" } }] }\n            then: { next_cursor: absent }`))).toContain("incomplete-scenario");
    expect(codes(base(`${given}\n            then: { items: ["00000000-0000-0000-0000-000000000001"] }`, "\n        returns: [status]"))).toContain("invalid-scenario");
  });
});

describe("queries: completion and hover", () => {
  /** The fixture with `needle` replaced by `replacement` (which holds the cursor `|`). */
  function edit(needle: string, replacement: string): [string, number] {
    const i = FIXTURE.indexOf(needle);
    if (i < 0) throw new Error(`not found: ${needle}`);
    const text = FIXTURE.slice(0, i) + replacement + FIXTURE.slice(i + needle.length);
    const at = text.indexOf("|");
    return [text.slice(0, at) + text.slice(at + 1), at];
  }
  const labels = ([text, offset]: [string, number]) => complete(text, offset).items.map((x) => x.label);

  test("keys of a query and of its search", () => {
    expect(labels(edit("        page: { size: 3, max_size: 10 }\n", "        pa|\n"))).toEqual(["page"]);
    expect(labels(edit("search: { param: prefix, fields: [display_name], mode: prefix }", "search: { param: prefix, fields: [display_name], mode: prefix, mi| }"))).toEqual(["min_similarity"]);
  });

  test("values: the aggregate, operators, modes, directions, field paths and parameters", () => {
    expect(labels(edit("        from: Member\n        params:\n          - { name: min_points", "        from: |\n        params:\n          - { name: min_points"))).toEqual(["Member"]);
    expect(labels(edit("{ field: points, op: gte, param: min_points }", "{ field: points, op: |, param: min_points }"))).toEqual(["eq", "ne", "lt", "lte", "gt", "gte"]);
    expect(labels(edit("search: { param: prefix, fields: [display_name], mode: prefix }", "search: { param: prefix, fields: [display_name], mode: | }"))).toEqual(["trigram", "prefix", "exact"]);
    const fields = labels(edit("{ field: points, op: gte, param: min_points }", "{ field: |, op: gte, param: min_points }"));
    expect(fields).toContain("email.value");
    expect(fields).toContain("balance.currency");
    expect(fields).not.toContain("tags");
    expect(labels(edit("{ field: points, op: gte, param: min_points }", "{ field: points, op: gte, param: | }"))).toEqual(["min_points"]);
    expect(labels(edit("          - { field: joined_at, direction: desc }\n        page: { size: 2", "          - { field: |, direction: desc }\n        page: { size: 2"))).toContain("relevance");
  });

  test("hover explains query keys", () => {
    const i = FIXTURE.indexOf("order_by:");
    expect(hover(FIXTURE, i + 2)?.markdown).toContain("識別子");
  });
});
