import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkExpression, makeEnv, parseExpr, parseModel, ruleUsage, T, validateModelText, type ContextIR, type Type } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

function codes(text: string): string[] {
  return validateModelText(text).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/** Minimal model with one aggregate; `extra` is spliced into the aggregate. */
function model(aggregateExtra = "", contextExtra = ""): string {
  return `schema_version: 1
project: demo
contexts:
  - name: Sales
    errors:
      - { name: Invalid, code: invalid, message: invalid }
    enums:
      - { name: Status, values: [draft, placed] }
${contextExtra}
    aggregates:
      - name: Order
        identity: id
        fields:
          - { name: id, type: UUID }
          - { name: status, type: Status }
          - { name: total, type: Integer }
          - { name: note, type: String, required: false }
${aggregateExtra}
`;
}

describe("sample model", () => {
  test("validates without errors or warnings", () => {
    const r = validateModelText(SAMPLE);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("is deterministic", () => {
    expect(JSON.stringify(validateModelText(SAMPLE).diagnostics)).toBe(JSON.stringify(validateModelText(SAMPLE).diagnostics));
  });

  test("rule usage traces guards to operations, use cases and scenarios", () => {
    const r = validateModelText(SAMPLE);
    const usage = ruleUsage(r.analysis!);
    const guard = usage.find((u) => u.rule === "pending_until_expiry")!;
    expect(guard.kind).toBe("state_guard");
    expect(guard.appliedBy.map((a) => `${a.kind}:${a.name}`)).toEqual(["operation:accept"]);
    expect(guard.scenarios.map((s) => s.name)).toContain("expired_invitation_is_rejected");
    const isOpen = usage.find((u) => u.rule === "is_open")!;
    expect(isOpen.appliedBy.map((a) => `${a.kind}:${a.name}`)).toEqual(["operation:revoke", "use_case:revoke_invitation"]);
    const inv = usage.find((u) => u.rule === "expiry_after_creation")!;
    expect(inv.appliedBy.map((a) => a.kind)).toEqual(["construct", "factory", "operation", "operation"]);
  });
});

describe("structure", () => {
  test("reports YAML syntax errors with a location", () => {
    const r = parseModel("schema_version: 1\ncontexts: [\n");
    expect(r.diagnostics[0]!.code).toBe("yaml-syntax");
    expect(r.diagnostics[0]!.line).toBeGreaterThan(0);
  });

  test("rejects unsupported schema versions", () => {
    expect(codes("schema_version: 99\nproject: x\ncontexts: []\n")).toContain("unsupported-schema-version");
  });

  test("reports unknown keys (typos) with the exact line", () => {
    const r = validateModelText(model("        invariantz: []"));
    const d = r.diagnostics.find((x) => x.code === "unknown-key")!;
    expect(d.message).toContain("invariantz");
    expect(d.line).toBe(18);
  });
});

describe("types and names", () => {
  test("unknown type with suggestion", () => {
    const r = validateModelText(model().replace("type: Status }", "type: Statuss }"));
    const d = r.diagnostics.find((x) => x.code === "unknown-type")!;
    expect(d.hint).toContain('"Status"');
  });

  test("duplicate field and reserved names", () => {
    expect(codes(model().replace("{ name: total, type: Integer }", "{ name: status, type: Integer }"))).toContain("duplicate-name");
    expect(codes(model().replace("name: note,", "name: class,"))).toContain("reserved-name");
    expect(codes(model().replace("name: note,", "name: model_dump,"))).toContain("reserved-name");
  });

  test("aggregate held directly by another aggregate is a boundary violation", () => {
    const text = model(
      "",
      `    value_objects: []`,
    ).replace(
      "    aggregates:\n",
      `    aggregates:
      - name: Customer
        identity: id
        fields:
          - { name: id, type: UUID }
          - { name: last_order, type: Order }
`,
    );
    expect(codes(text)).toContain("aggregate-boundary");
    expect(validateModelText(text.replace("type: Order }", "type: Ref[Order] }")).diagnostics[0]?.hint).toContain("quote");
    expect(codes(text.replace("type: Order }", 'type: "Ref[Order]" }'))).toEqual([]);
  });

  test("value object cycles are detected", () => {
    const text = model(
      "",
      `    value_objects:
      - name: A
        fields: [{ name: b, type: B }]
      - name: B
        fields: [{ name: a, type: A }]`,
    );
    expect(codes(text)).toContain("circular-dependency");
  });

  test("constraints must fit the field type", () => {
    expect(codes(model().replace("type: Integer }", "type: Integer, constraints: { max_length: 3 } }"))).toContain("invalid-constraint");
    expect(codes(model().replace("type: Integer }", "type: Integer, constraints: { min: 5, max: 1 } }"))).toContain("invalid-constraint");
  });
});

describe("rules", () => {
  test("invariant must reference declared errors", () => {
    const text = model(`        invariants:
          - { name: positive_total, expression: total > 0, error: Missing }`);
    const r = validateModelText(text);
    expect(r.diagnostics.find((d) => d.code === "unknown-error")).toBeDefined();
  });

  test("invariant expressions are type-checked", () => {
    const text = model(`        invariants:
          - { name: bad, expression: total > status, error: Invalid }`);
    expect(codes(text)).toContain("invalid-expression");
  });

  test("optional fields require a null check", () => {
    const bad = model(`        invariants:
          - { name: note_short, expression: 'length(note) < 10', error: Invalid }`);
    expect(codes(bad)).toContain("invalid-expression");
    const good = model(`        invariants:
          - { name: note_short, expression: 'note == null or length(note) < 10', error: Invalid }`);
    expect(codes(good)).toEqual([]);
  });

  test("hidden clock access is rejected", () => {
    const text = model(`        invariants:
          - { name: bad, expression: now > total, error: Invalid }`);
    const d = validateModelText(text).diagnostics.find((x) => x.code === "invalid-expression")!;
    expect(d.hint).toContain("parameter");
  });

  test("operations: require must name a guard, identity cannot change, changes are typed", () => {
    const text = model(`        state_guards:
          - { name: is_draft, expression: status == draft, error: Invalid }
        operations:
          - name: place
            require: [is_draft]
            changes: { status: placed }
          - name: broken
            require: ["total > 0"]
            changes: { id: id, total: "'x'" }`);
    const c = codes(text);
    expect(c).toContain("invalid-require");
    expect(c).toContain("identity-change");
    expect(c).toContain("invalid-expression");
    expect(c.length).toBe(3);
  });

  test("duplicate event in the same operation is reported", () => {
    const text = model(`        operations:
          - name: place
            changes: { status: placed }
            emits: [{ name: Placed, fields: [id] }, { name: Placed, fields: [id] }]`);
    expect(codes(text)).toContain("duplicate-event");
  });

  test("the same event emitted with different payloads is a contract mismatch", () => {
    const text = model(`        operations:
          - name: place
            changes: { status: placed }
            emits: [{ name: Changed, fields: [id] }]
          - name: reset
            changes: { status: draft }
            emits: [{ name: Changed, fields: [id, total] }]`);
    expect(codes(text)).toContain("event-contract-mismatch");
  });
});

describe("use cases", () => {
  const withUseCase = (steps: string, extra = "") =>
    model(
      `        operations:
          - name: place
            changes: { status: placed }
            emits: [{ name: Placed, fields: [id] }]`,
    ) +
    `    use_cases:
      - name: place_order
        command: PlaceOrder
        input: [{ name: order_id, type: UUID }]
${extra}
        steps:
${steps}
`;

  test("valid flow", () => {
    const text = withUseCase(`          - load: { aggregate: Order, by: order_id, as: order, not_found: Invalid }
          - invoke: { target: order, operation: place }
          - save: order
          - publish_after_commit: Placed`);
    expect(codes(text)).toEqual([]);
  });

  test("publishing an event that no earlier step produces", () => {
    const text = withUseCase(`          - load: { aggregate: Order, by: order_id, as: order, not_found: Invalid }
          - publish_after_commit: Placed
          - invoke: { target: order, operation: place }
          - save: order`);
    expect(codes(text)).toContain("event-not-produced");
  });

  test("unsaved change is a warning, unknown variable an error", () => {
    const text = withUseCase(`          - load: { aggregate: Order, by: order_id, as: order, not_found: Invalid }
          - invoke: { target: order, operation: place }`);
    expect(validateModelText(text).diagnostics.map((d) => d.code)).toContain("unsaved-change");
    expect(codes(withUseCase(`          - invoke: { target: ghost, operation: place }`))).toContain("unknown-variable");
  });

  test("publish_after_commit needs a transaction", () => {
    const text = withUseCase(
      `          - load: { aggregate: Order, by: order_id, as: order, not_found: Invalid }
          - invoke: { target: order, operation: place }
          - save: order
          - publish_after_commit: Placed`,
      "        transaction: none",
    );
    expect(codes(text)).toContain("publish-after-commit-without-transaction");
  });

  test("steps after fail are unreachable; missing returns are errors", () => {
    expect(codes(withUseCase(`          - fail: Invalid\n          - return: 1`))).toContain("unreachable-step");
    const text = withUseCase(`          - load: { aggregate: Order, by: order_id, as: order, not_found: Invalid }
          - if:
              condition: "order.total > 0"
              then:
                - return: 1`);
    expect(codes(text)).toContain("missing-return");
  });

  test("retry without idempotency key warns", () => {
    const text = withUseCase(`          - fail: Invalid`, "        retry: true");
    expect(validateModelText(text).diagnostics.map((d) => d.code)).toContain("missing-idempotency-key");
  });
});

describe("scenarios", () => {
  const base = model(
    `        state_guards:
          - { name: is_draft, expression: status == draft, error: Invalid }
        operations:
          - name: place
            require: [is_draft]
            changes: { status: placed }
        scenarios:
          - name: s1
            given:
              aggregate: { id: "00000000-0000-0000-0000-000000000001", status: placed, total: 1 }
            when: { operation: place }
            then: THEN`,
  );

  test("then without an expectation is ambiguous", () => {
    expect(codes(base.replace("then: THEN", "then: {}"))).toContain("ambiguous-scenario");
  });

  test("valid scenario", () => {
    expect(codes(base.replace("then: THEN", "then: { raises: Invalid }"))).toEqual([]);
  });

  test("given must be complete and typed", () => {
    const missing = base.replace(", total: 1 }", " }").replace("then: THEN", "then: { raises: Invalid }");
    expect(codes(missing)).toContain("incomplete-scenario");
    const wrong = base.replace("status: placed, total", "status: shipped, total").replace("then: THEN", "then: { raises: Invalid }");
    expect(codes(wrong)).toContain("invalid-scenario-value");
  });

  test("renaming an error invalidates scenarios before generation", () => {
    expect(codes(base.replace("then: THEN", "then: { raises: Invalidd }"))).toContain("unknown-error");
  });
});

describe("expressions", () => {
  const ctx: ContextIR = {
    name: "X",
    glossary: [],
    errors: [],
    enums: [{ name: "Status", values: ["draft", "placed"], path: [] }],
    valueObjects: [],
    aggregates: [],
    extensionPoints: [],
    useCases: [],
    policies: [],
    path: [],
  };
  const env = () =>
    makeEnv(ctx, {
      self: {
        name: "Order",
        fields: new Map<string, Type>([
          ["status", { k: "enum", name: "Status" }],
          ["total", T.Integer],
          ["at", { k: "optional", inner: T.DateTime }],
          ["tags", { k: "list", item: T.String }],
        ]),
      },
    });

  test("parses precedence: not > and > or", () => {
    const e = parseExpr("not a or b and c");
    expect(e.t).toBe("binary");
    expect((e as { op: string }).op).toBe("or");
  });

  test("rejects python-isms", () => {
    expect(() => parseExpr("a = 1")).toThrow();
    expect(() => parseExpr("a && b")).toThrow();
    expect(() => parseExpr("1 < a < 3")).toThrow();
    expect(checkExpression("__import__('os')", env(), T.Boolean).errors.length).toBeGreaterThan(0);
  });

  test("contextual enum resolution on either side", () => {
    expect(checkExpression("status == placed", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("placed == status", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("Status.placed != status", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("status == shipped", env(), T.Boolean).errors.length).toBe(1);
  });

  test("null narrowing through and / or / not", () => {
    expect(checkExpression("at != null and at > at", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("at == null or at > at", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("not (at == null) and at > at", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("at > at", env(), T.Boolean).errors.length).toBe(1);
  });

  test("builtins are typed", () => {
    expect(checkExpression("not is_empty(tags) and contains(tags, 'vip')", env(), T.Boolean).errors).toEqual([]);
    expect(checkExpression("contains(tags, 3)", env(), T.Boolean).errors.length).toBe(1);
    expect(checkExpression("length(total) > 1", env(), T.Boolean).errors.length).toBe(1);
  });
});

describe("QA fixes (2026-10-03)", () => {
  const twoOrders = (extraInput = "") =>
    model(
      `        operations:
          - name: place
            changes: { status: placed }`,
    ) +
    `    use_cases:
      - name: place_both
        command: PlaceBoth
        transaction: required
        input: [{ name: first_id, type: UUID }, { name: second_id, type: UUID }${extraInput}]
        steps:
          - load: { aggregate: Order, by: first_id, as: first, not_found: Invalid }
          - load: { aggregate: Order, by: second_id, as: second, not_found: Invalid }
          - invoke: { target: first, operation: place }
          - invoke: { target: second, operation: place }
          - save: first
          - save: second
`;

  test("two instances of the same aggregate changed in one transaction are reported", () => {
    const d = validateModelText(twoOrders()).diagnostics.find((x) => x.code === "multi-aggregate-transaction");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toBe("Use case place_both changes several aggregates (first: Order, second: Order) in one transaction");
    // One instance changed twice is still one aggregate.
    const once = twoOrders().replace("          - invoke: { target: second, operation: place }\n", "          - invoke: { target: first, operation: place }\n").replace("          - save: second\n", "");
    expect(validateModelText(once).diagnostics.map((x) => x.code)).not.toContain("multi-aggregate-transaction");
  });

  test("YAML that expands too many aliases is a positioned diagnostic, not a crash", () => {
    const yaml = "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n";
    const r = validateModelText(yaml);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: "error", code: "yaml-aliases", line: 2, column: 8, path: ["b", 0] });
  });

  test("an unquoted bracket in a flow map gets a precise hint and location", () => {
    const text = model().replace("          - { name: total, type: Integer }", "          - { name: tags, type: List[String] }");
    const ds = validateModelText(text).diagnostics;
    expect(ds).toHaveLength(1); // the parser's follow-up errors on the same line are dropped
    expect(ds[0]).toMatchObject({ code: "yaml-syntax", path: ["contexts", 0, "aggregates", 0, "fields", 2, "type"] });
    expect(ds[0]!.hint).toBe('Write it quoted: type: "List[String]"');
    expect(ds[0]!.line).toBeGreaterThan(0);
  });

  test("a field named like an enum value: the diagnostic names the shadowing and the qualified form", () => {
    const text = model(
      `        invariants:
          - { name: r, expression: status == placed, error: Invalid }`,
    ).replace("          - { name: note, type: String, required: false }", "          - { name: placed, type: Integer }");
    const d = validateModelText(text).diagnostics.find((x) => x.severity === "error")!;
    expect(d.message).toBe('Cannot compare Status with Integer: "placed" is the field placed (Integer), not the enum value Status.placed');
    expect(d.hint).toContain("Write Status.placed for the enum value");
    // The qualified form works end to end.
    expect(codes(text.replace("status == placed", "status == Status.placed"))).toEqual([]);
  });

  test("a field whose type is wrong is reported once, not again where it is used", () => {
    const text = model(
      `        invariants:
          - { name: r, expression: other != null, error: Invalid }
        operations:
          - name: relink
            changes: { other: other }
        scenarios:
          - name: s
            when:
              construct: { id: "00000000-0000-0000-0000-000000000001", status: draft, total: 1, other: "00000000-0000-0000-0000-000000000002" }
            then: { raises: Invalid }`,
    ).replace("          - { name: note, type: String, required: false }", '          - { name: other, type: "Ref[Status]", required: false }');
    const errors = validateModelText(text).diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toEqual(["unknown-type"]);
  });

  test("entity-typed parameters are flagged: a use case can only pass entities it already holds", () => {
    const text = model(
      `        entities:
          - name: Line
            identity: line_id
            fields: [{ name: line_id, type: Integer }]
        operations:
          - name: replace_lines
            parameters: [{ name: lines, type: "List[Line]" }]
            changes: { lines: lines }`,
    ).replace("          - { name: note, type: String, required: false }", '          - { name: lines, type: "List[Line]" }');
    const d = validateModelText(text).diagnostics.find((x) => x.code === "entity-parameter");
    expect(d).toMatchObject({ severity: "warning", path: ["contexts", 0, "aggregates", 0, "operations", 0, "parameters", 0, "type"] });
    expect(d!.message).toBe('Operation replace_lines takes entity List[Line] as "lines", which a use case cannot create');
    // Passing the lines of a loaded aggregate is the one way a use case can call it.
    const withUseCase =
      text +
      `    use_cases:
      - name: copy_lines
        command: CopyLines
        input: [{ name: from_id, type: UUID }, { name: to_id, type: UUID }]
        steps:
          - load: { aggregate: Order, by: from_id, as: source, not_found: Invalid }
          - load: { aggregate: Order, by: to_id, as: target, not_found: Invalid }
          - invoke: { target: target, operation: replace_lines, args: { lines: source.lines } }
          - save: target
`;
    expect(codes(withUseCase)).toEqual([]);
  });
});
