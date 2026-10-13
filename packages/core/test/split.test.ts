import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDiagnostic, isModelSource, splitRename, modelSourceText, parseFlow, parseModel, parseModelFiles, splitModelText, splitToYaml, validateModelFiles, validateModelText, type Diagnostic } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURES = join(ROOT, "packages/generator/test/fixtures");
const CORPUS: [string, string][] = [
  ["cleaning-platform", join(ROOT, "examples/cleaning-platform/model.ddd.yaml")],
  ["cleaning-platform-ts", join(ROOT, "examples/cleaning-platform-ts/model.ddd.yaml")],
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".ddd.yaml"))
    .map((f): [string, string] => [f, join(FIXTURES, f)]),
];

/** IR without source paths (they differ by design: YAML paths vs assembled paths are the same, but stay out of it). */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== "path" && x !== undefined).map(([k, x]) => [k, strip(x)]));
  return v;
}

const errors = (ds: Diagnostic[]) => ds.filter((d) => d.severity === "error");

describe("YAML → multi-file → IR round trip", () => {
  for (const [name, path] of CORPUS) {
    test(`${name}: the split files read back into the same IR`, () => {
      const text = readFileSync(path, "utf8");
      const out = splitModelText(text);
      expect(errors(out.diagnostics)).toEqual([]);
      const back = parseModelFiles(out.files);
      expect(errors(back.diagnostics).map((d) => formatDiagnostic(d))).toEqual([]);
      expect(strip(back.model)).toEqual(strip(parseModel(text).model));
    });

    test(`${name}: the split files convert back to a YAML model with the same IR`, () => {
      const text = readFileSync(path, "utf8");
      const back = splitToYaml(splitModelText(text).files);
      expect(back.yaml).toBeDefined();
      expect(strip(parseModel(back.yaml!).model)).toEqual(strip(parseModel(text).model));
    });

    test(`${name}: validation gives the same diagnostics in both formats`, () => {
      const text = readFileSync(path, "utf8");
      const yaml = validateModelText(text);
      const split = validateModelFiles(splitModelText(text).files);
      const key = (d: Diagnostic) => `${d.severity} ${d.code} ${d.message}`;
      expect(split.diagnostics.map(key).sort()).toEqual(yaml.diagnostics.map(key).sort());
      expect(split.ok).toBe(yaml.ok);
    });
  }

  test("the files of the example look like the documented format", () => {
    const { files } = splitModelText(readFileSync(CORPUS[0]![1], "utf8"));
    expect(Object.keys(files).sort()).toEqual([
      "buf.yaml",
      "cleaning_staff.domain",
      "cleaning_staff.flow",
      "cleaning_staff.scenarios.yaml",
      "cleaning_staff/v1/cleaning_staff.proto",
      "ddd.yaml",
      "ddd/v1/options.proto",
      "staffing.domain",
      "staffing.flow",
      "staffing.scenarios.yaml",
      "staffing/v1/staffing.proto",
    ]);
    expect(files["cleaning_staff.flow"]).toContain("flow issue_invitation(email, valid_until) {\n  if is_blocked_email(email) fail EmailBlocked\n");
    expect(files["cleaning_staff.domain"]).toContain("invariant expiry_after_creation: expires_at > created_at else InvalidInvitationWindow\n");
    expect(files["cleaning_staff/v1/cleaning_staff.proto"]).toContain("  INVITATION_STATUS_PENDING = 1;\n");
    expect(files["cleaning_staff/v1/cleaning_staff.proto"]).toContain('option (ddd.v1.rate_limit) = { requests: 10 per: MINUTE by: TENANT };');
    // Settings and scenarios keep their YAML comments.
    expect(files["ddd.yaml"]).toContain("# 認証・認可・レート制限");
    expect(files["ddd.yaml"]).toContain("contexts:\n  - CleaningStaff\n  - Staffing\n");
    expect(files["cleaning_staff.scenarios.yaml"]).toStartWith("context: CleaningStaff\naggregates:\n");
  });
});

// ---------------------------------------------------------------------------
// A small hand-written model for diagnostics
// ---------------------------------------------------------------------------

const MANIFEST = `schema_version: 1
project: shop
contexts: [Ordering]
`;

const PROTO = `syntax = "proto3";
package ordering.v1;
import "ddd/v1/options.proto";
import "google/protobuf/timestamp.proto";

option (ddd.v1.context) = { name: "Ordering" subdomain: CORE };

// The order was not found.
message OrderNotFound {
  option (ddd.v1.error) = { code: "order_not_found" message: "No such order" };
}

message OrderClosed {
  option (ddd.v1.error) = { code: "order_closed" message: "The order is closed" };
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_OPEN = 1;
  ORDER_STATUS_PLACED = 2;
  ORDER_STATUS_PAUSED = 3 [(ddd.v1.value) = "on_hold"];
}

// An order
message Order {
  option (ddd.v1.aggregate) = { identity: "id" };
  string id = 1 [(ddd.v1.type) = UUID];
  OrderStatus status = 2;
  // When it was placed.
  optional google.protobuf.Timestamp placed_at = 3;
  repeated string tags = 4 [(ddd.v1.rules) = { max_items: 5 }];
  string customer_id = 5 [(ddd.v1.ref) = "Order"];
  string total = 6 [(ddd.v1.type) = DECIMAL];
}

service OrderingService {
  // Opens an order.
  rpc OpenOrder(OpenOrderRequest) returns (OpenOrderResponse) {}
  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse) {
    option (ddd.v1.use_case) = { actor: "Clerk" };
  }
}

message OpenOrderRequest {}
message OpenOrderResponse {}
message PlaceOrderRequest {
  string order_id = 1 [(ddd.v1.type) = UUID];
  google.protobuf.Timestamp at = 2;
}
message PlaceOrderResponse {}
`;

const DOMAIN = `context Ordering

aggregate Order {
  // Placed orders know when.
  invariant placed_has_time: status != placed or placed_at != null else OrderClosed

  guard is_open: status == open else OrderClosed

  // Opens an order.
  factory open(id: UUID) {
    new { id, status: open, tags: [], customer_id: id, total: 0 }
  }

  operation place(at: DateTime) requires is_open {
    change { status: placed, placed_at: at }
    emit OrderPlaced { id, at }
  }
}
`;

const FLOW = `context Ordering

flow open_order() {
  let order = Order.open(id: ids.new)
  save order
  return order.id
}

flow place_order(order_id, at) {
  let order = load Order(order_id) else fail OrderNotFound
  if order.status == placed {
    return false
  } else if order.status == open {
    order.place(at: at)
  } else {
    fail OrderClosed
  }
  save order
  publish OrderPlaced after commit
  return true
}
`;

const files = (over: Record<string, string> = {}) => ({ "ddd.yaml": MANIFEST, "ordering.proto": PROTO, "ordering.domain": DOMAIN, "ordering.flow": FLOW, ...over });

describe("multi-file format: reading", () => {
  test("a hand-written model reads and validates", () => {
    const r = validateModelFiles(files());
    expect(errors(r.diagnostics).map((d) => formatDiagnostic(d))).toEqual([]);
    const ctx = r.model!.contexts[0]!;
    expect(ctx.subdomain).toBe("core");
    expect(ctx.errors[0]).toMatchObject({ name: "OrderNotFound", description: "The order was not found." });
    expect(ctx.errors[1]!.description).toBeUndefined();
    expect(ctx.enums[0]!.values).toEqual(["open", "placed", "on_hold"]);
    const order = ctx.aggregates[0]!;
    expect(order.description).toBe("An order");
    expect(order.fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ["id", "UUID", true],
      ["status", "OrderStatus", true],
      ["placed_at", "DateTime", false],
      ["tags", "List[String]", true],
      ["customer_id", "Ref[Order]", true],
      ["total", "Decimal", true],
    ]);
    expect(order.fields[2]!.description).toBe("When it was placed.");
    expect(order.fields[3]!.constraints).toEqual({ max_items: 5 });
    expect(order.invariants[0]).toMatchObject({ name: "placed_has_time", description: "Placed orders know when.", checkOn: ["construct", "transition"] });
    expect(order.factories[0]!.fields).toEqual({ id: "id", status: "open", tags: "[]", customer_id: "id", total: "0" });
    expect(order.operations[0]!.require).toEqual(["is_open"]);
    const [open, place] = ctx.useCases;
    expect(open).toMatchObject({ name: "open_order", command: "OpenOrder", description: "Opens an order.", transaction: "required" });
    expect(place!.actor).toBe("Clerk");
    expect(place!.input.map((f) => f.name)).toEqual(["order_id", "at"]);
    const ifStep = place!.steps[1]!;
    expect(ifStep.kind).toBe("if");
    if (ifStep.kind === "if") {
      expect(ifStep.condition).toBe("order.status == placed");
      expect(ifStep.else[0]!.kind).toBe("if");
    }
  });

  test("a let of Name.member(...) is a factory call only when Name is an aggregate", () => {
    const flow = FLOW.replace("let order = Order.open(id: ids.new)", "let x = Money.of(amount: 1)\n  let order = Order.open(id: ids.new)");
    const r = parseModelFiles(files({ "ordering.flow": flow }));
    const steps = r.model!.contexts[0]!.useCases[0]!.steps;
    expect(steps[0]).toMatchObject({ kind: "let", name: "x", value: "Money.of(amount: 1)" });
    expect(steps[1]).toMatchObject({ kind: "create", aggregate: "Order", factory: "open", as: "order", args: { id: "ids.new" } });
  });

  test("a syntax error points at its file, line and column", () => {
    const r = parseModelFiles(files({ "ordering.flow": FLOW.replace("save order\n  return", "save order extra\n  return") }));
    const [d] = errors(r.diagnostics);
    expect(d).toMatchObject({ code: "syntax", file: "ordering.flow", line: 5, column: 14 });
    expect(d!.message).toContain('Unexpected "extra" after save');
  });

  test("semantic errors from the shared validator point into the right file", () => {
    const r = validateModelFiles(files({ "ordering.flow": FLOW.replace("fail OrderClosed", "fail NoSuchError") }));
    const d = errors(r.diagnostics).find((x) => x.message.includes("NoSuchError"));
    expect(d).toBeDefined();
    expect(d!.file).toBe("ordering.flow");
    expect(d!.line).toBe(16);

    const r2 = validateModelFiles(files({ "ordering.domain": DOMAIN.replace("else OrderClosed\n\n  guard", "else Missing\n\n  guard") }));
    const d2 = errors(r2.diagnostics).find((x) => x.message.includes("Missing"));
    expect(d2).toMatchObject({ file: "ordering.domain", line: 5 });

    const r3 = validateModelFiles(files({ "ordering.proto": PROTO.replace("OrderStatus status = 2;", "OrderState status = 2;") }));
    const d3 = errors(r3.diagnostics).find((x) => x.message.includes("OrderState"));
    expect(d3).toMatchObject({ file: "ordering.proto", line: 28, column: 3 });
  });

  test("rpcs and flows must match, and a flow lists its request fields", () => {
    const missingFlow = parseModelFiles(files({ "ordering.flow": FLOW.replace(/flow open_order[\s\S]*?\n}\n/, "") }));
    expect(errors(missingFlow.diagnostics).map((d) => d.code)).toContain("missing-flow");
    const missingRpc = parseModelFiles(files({ "ordering.flow": FLOW + "\nflow cancel_order() {\n  return 1\n}\n" }));
    expect(errors(missingRpc.diagnostics).find((d) => d.code === "missing-rpc")).toMatchObject({ file: "ordering.flow", line: 23, column: 6 });
    const wrongInput = parseModelFiles(files({ "ordering.flow": FLOW.replace("flow place_order(order_id, at)", "flow place_order(order, at)") }));
    expect(errors(wrongInput.diagnostics).map((d) => d.code).sort()).toEqual(["missing-input", "unknown-input"]);
  });

  test("unknown option fields, unlisted contexts and missing files are reported", () => {
    const r = parseModelFiles(files({ "ordering.proto": PROTO.replace('{ actor: "Clerk" }', '{ actr: "Clerk" }') }));
    expect(errors(r.diagnostics).find((d) => d.code === "unknown-key")).toMatchObject({ file: "ordering.proto", message: 'Unknown field "actr" in (ddd.v1.use_case)' });
    const r2 = parseModelFiles(files({ "ddd.yaml": "schema_version: 1\nproject: shop\ncontexts: []\n" }));
    expect(errors(r2.diagnostics).map((d) => d.code)).toContain("unlisted-context");
    const r3 = parseModelFiles({ "ddd.yaml": MANIFEST });
    expect(errors(r3.diagnostics).map((d) => d.code)).toEqual(["missing-proto"]);
    const r4 = parseModelFiles({ "ordering.proto": PROTO });
    expect(errors(r4.diagnostics).map((d) => d.code)).toEqual(["missing-manifest"]);
  });

  test("scenarios in their own file are located there", () => {
    const scenarios = `context: Ordering
aggregates:
  Order:
    - name: open_order_is_open
      when:
        factory: open
        args: { id: "00000000-0000-0000-0000-000000000001" }
      then:
        state: { status: placed }
use_cases:
  nothing_here: []
`;
    const r = validateModelFiles(files({ "ordering.scenarios.yaml": scenarios }));
    expect(errors(r.diagnostics).find((d) => d.code === "unknown-scenario-owner")).toMatchObject({ file: "ordering.scenarios.yaml", line: 11 });
    const ok = validateModelFiles(files({ "ordering.scenarios.yaml": scenarios.replace("use_cases:\n  nothing_here: []\n", "") }));
    expect(errors(ok.diagnostics)).toEqual([]);
    expect(ok.model!.contexts[0]!.aggregates[0]!.scenarios[0]!.name).toBe("open_order_is_open");
  });

  test("a detached comment is not a description", () => {
    const proto = PROTO.replace("// An order\nmessage Order {", "// Just a note.\n\nmessage Order {");
    const r = parseModelFiles(files({ "ordering.proto": proto }));
    expect(r.model!.contexts[0]!.aggregates[0]!.description).toBeUndefined();
  });
});

describe("multi-file format: hostile input", () => {
  test("deep nesting is a diagnostic, not a crash", () => {
    const deepProto = PROTO.replace('option (ddd.v1.context) = { name: "Ordering" subdomain: CORE };', `option (ddd.v1.context) = { name: "Ordering" x ${"{ a ".repeat(5000)}${"}".repeat(5000)} };`);
    const r1 = parseModelFiles(files({ "ordering.proto": deepProto }));
    expect(errors(r1.diagnostics)[0]).toMatchObject({ code: "syntax", file: "ordering.proto", message: "Nested too deeply (more than 64 levels)" });
    const deepFlow = `context Ordering\n\nflow open_order() {\n${"if true {\n".repeat(3000)}${"}\n".repeat(3000)}}\n`;
    const r2 = parseModelFiles(files({ "ordering.flow": deepFlow }));
    expect(errors(r2.diagnostics)[0]!.message).toContain("Nested too deeply");
    const elseIfs = `context Ordering\n\nflow open_order() {\n  if a {\n  }${" else if a {\n  }".repeat(3000)}\n}\n`;
    expect(errors(parseModelFiles(files({ "ordering.flow": elseIfs })).diagnostics)[0]!.message).toContain("Nested too deeply");
  });

  test("garbage in any file is a syntax error with a position", () => {
    for (const [f, text] of [
      ["ordering.proto", 'option (ddd.v1.context) = { name: "Ordering" };\nmessage { ;; ]]'],
      ["ordering.domain", "context Ordering\naggregate Order { invariant }"],
      ["ordering.flow", "context Ordering\nflow x( {"],
      ["ordering.flow", "\u0000\u0001"],
    ] as const) {
      const r = parseModelFiles(files({ [f]: text }));
      const d = errors(r.diagnostics)[0]!;
      expect(d.file).toBe(f);
      expect(d.line).toBeGreaterThan(0);
    }
  });
});

describe("multi-file format: what a hand-written project has", () => {
  const THIRD_PARTY = `syntax = "proto2";
package vendor;
message Thing {
  map<string, int32> counts = 1;
  oneof kind { string a = 2; int32 b = 3; }
}
`;

  test("a .proto that does not declare a context is not part of the model", () => {
    const r = validateModelFiles(files({ "third_party/vendor.proto": THIRD_PARTY }));
    expect(errors(r.diagnostics)).toEqual([]);
    expect(modelSourceText(files({ "third_party/vendor.proto": THIRD_PARTY }))).toBe(modelSourceText(files()));
    expect(isModelSource("third_party/vendor.proto", THIRD_PARTY)).toBe(false);
    expect(isModelSource("ordering.proto", PROTO)).toBe(true);
  });

  test("a misspelt field inside a nested option is reported, not dropped", () => {
    const typo = PROTO.replace('option (ddd.v1.aggregate) = { identity: "id" };', 'option (ddd.v1.aggregate) = { identity: "id" authorize { permisions: ["order.read"] } };');
    const r = parseModelFiles(files({ "ordering.proto": typo }));
    expect(errors(r.diagnostics).find((d) => d.code === "unknown-key")).toMatchObject({ file: "ordering.proto", line: 26, message: 'Unknown field "permisions" in authorize of (ddd.v1.aggregate)' });
    const norm = PROTO.replace('option (ddd.v1.aggregate) = { identity: "id" };', 'option (ddd.v1.aggregate) = { identity: "id" rate_limit { requests: 1 per: MINUTE bye: IP } };');
    expect(errors(parseModelFiles(files({ "ordering.proto": norm })).diagnostics).map((d) => d.message)).toContain('Unknown field "bye" in rate_limit of (ddd.v1.aggregate)');
    const misspeltOption = PROTO.replace("option (ddd.v1.aggregate) =", "option (ddd.v1.agregate) =");
    expect(errors(parseModelFiles(files({ "ordering.proto": misspeltOption })).diagnostics).find((d) => d.code === "unknown-option")).toMatchObject({ line: 26, message: "(ddd.v1.agregate) is not an option of message Order" });
  });

  test("long lists and rules continue on the next line; else may start a line", () => {
    const domain = DOMAIN.replace("operation place(at: DateTime) requires is_open {", "operation place(at: DateTime) requires is_open,\n      is_open {").replace(
      "invariant placed_has_time: status != placed or placed_at != null else OrderClosed",
      "invariant placed_has_time: (status != placed\n    or placed_at != null) else OrderClosed",
    );
    const flow = FLOW.replace("  } else if order.status == open {", "  }\n  else if order.status == open {");
    const r = validateModelFiles(files({ "ordering.domain": domain, "ordering.flow": flow }));
    expect(errors(r.diagnostics).map((d) => formatDiagnostic(d))).toEqual([]);
    const order = r.model!.contexts[0]!.aggregates[0]!;
    expect(order.operations[0]!.require).toEqual(["is_open", "is_open"]);
    expect(order.invariants[0]!.expression).toBe("(status != placed\n    or placed_at != null)");
    const q = parseFlow("context X\nquery q(a) from Order {\n  where a == :a and\n    b == :a\n  search s on x,\n    y trigram\n  order by a,\n    b desc\n  returns a,\n    b\n}\n").queries[0]!;
    expect(q.where.map((w) => w.field)).toEqual(["a", "b"]);
    expect(q.search!.fields).toEqual(["x", "y"]);
    expect(q.orderBy.map((o) => o.field)).toEqual(["a", "b"]);
    expect(q.returns).toEqual(["a", "b"]);
  });

  test("a context may spread over several .flow / .domain / .scenarios.yaml files", () => {
    const [first, second] = [FLOW.slice(0, FLOW.indexOf("flow place_order")), "context Ordering\n\n" + FLOW.slice(FLOW.indexOf("flow place_order"))];
    const scenario = (name: string, factory: string) => `context: Ordering
aggregates:
  Order:
    - name: ${name}
      when: { factory: ${factory}, args: { id: "00000000-0000-0000-0000-000000000001" } }
      then: { state: { status: open } }
`;
    const r = validateModelFiles({
      ...files({ "ordering.flow": first! }),
      "ordering.place.flow": second!, // files are read in path order
      "a.scenarios.yaml": scenario("opens", "open"),
      "b.scenarios.yaml": scenario("is_not_placed_yet", "opn"),
    });
    expect(r.model!.contexts[0]!.useCases.map((u) => u.name)).toEqual(["open_order", "place_order"]);
    expect(r.model!.contexts[0]!.aggregates[0]!.scenarios.map((s) => s.name)).toEqual(["opens", "is_not_placed_yet"]);
    // The second file's scenario is wrong; its diagnostic points into that file.
    const d = errors(r.diagnostics);
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.file === "b.scenarios.yaml" && x.line === 5)).toBe(true);
  });
});

describe("multi-file format: rename", () => {
  const sample = () => splitModelText(readFileSync(CORPUS[0]![1], "utf8")).files;
  const at = (files: Record<string, string>, file: string, needle: string, delta = 1) => files[file]!.indexOf(needle) + delta;

  test("an error, an event, an enum and a guard are renamed in every file", () => {
    const files = sample();
    const err = splitRename(files, "cleaning_staff.flow", at(files, "cleaning_staff.flow", "EmailBlocked"), "EmailRefused");
    expect(err.ok).toBe(true);
    if (!err.ok) return;
    expect(err.changed.sort()).toEqual(["cleaning_staff.flow", "cleaning_staff.scenarios.yaml", "cleaning_staff/v1/cleaning_staff.proto"]);
    expect(err.files["cleaning_staff/v1/cleaning_staff.proto"]).toContain("message EmailRefused {");
    expect(err.files["cleaning_staff.scenarios.yaml"]).toContain("raises: EmailRefused");
    expect(validateModelFiles(err.files).ok).toBe(true);

    const ev = splitRename(files, "cleaning_staff.domain", at(files, "cleaning_staff.domain", "emit InvitationAccepted", 6), "InvitationTaken");
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.files["staffing.flow"]).toContain("on CleaningStaff.InvitationTaken {");
      expect(ev.files["ddd.yaml"]).toContain("events: [InvitationTaken]");
      expect(validateModelFiles(ev.files).ok).toBe(true);
    }

    const en = splitRename(files, "cleaning_staff/v1/cleaning_staff.proto", at(files, "cleaning_staff/v1/cleaning_staff.proto", "enum InvitationStatus", 6), "InviteState");
    expect(en.ok).toBe(true);
    if (en.ok) {
      expect(en.files["cleaning_staff/v1/cleaning_staff.proto"]).toContain("INVITE_STATE_PENDING = 1;");
      expect(validateModelFiles(en.files).ok).toBe(true);
    }

    const g = splitRename(files, "cleaning_staff.domain", at(files, "cleaning_staff.domain", "guard is_open", 7), "still_open");
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.files["cleaning_staff.domain"]).toContain("requires still_open");
      expect(g.files["cleaning_staff.flow"]).toContain("if invitation.still_open {");
      expect(validateModelFiles(g.files).ok).toBe(true);
    }
  });

  test("an aggregate is renamed in references written as strings too", () => {
    const r = validateModelFiles(files());
    expect(r.ok).toBe(true);
    const f = files();
    const res = splitRename(f, "ordering.flow", at(f, "ordering.flow", "load Order(", 5), "Purchase");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.files["ordering.proto"]).toContain('[(ddd.v1.ref) = "Purchase"]');
      expect(validateModelFiles(res.files).ok).toBe(true);
    }
  });

  test("what cannot be renamed says why", () => {
    const files = sample();
    expect(splitRename(files, "cleaning_staff.flow", at(files, "cleaning_staff.flow", "email, valid_until"), "mail")).toMatchObject({ ok: false });
    expect(splitRename(files, "cleaning_staff.flow", at(files, "cleaning_staff.flow", "EmailBlocked"), "emailRefused")).toMatchObject({ ok: false, error: "emailRefused must be PascalCase" });
    expect(splitRename(files, "cleaning_staff.flow", at(files, "cleaning_staff.flow", "EmailBlocked"), "InvitationNotFound")).toMatchObject({ ok: false, error: "InvitationNotFound is already used" });
  });
});
