import { describe, expect, test } from "bun:test";
import { SAMPLE_MODEL } from "../../cli/src/sample.ts";
import { stateMachines, validateModelText } from "../src/index.ts";

/** One aggregate with a status enum; `body` is the aggregate's members after its fields. */
const model = (values: string, body: string, fields = "") => `schema_version: 1
project: demo
contexts:
  - name: Shop
    errors:
      - { name: Closed, code: closed, message: closed }
    enums:
      - { name: Status, values: [${values}] }
    aggregates:
      - name: Order
        identity: id
        fields:
          - { name: id, type: UUID }
          - { name: status, type: Status }
          - { name: paid_at, type: DateTime, required: false }
${fields}
${body}
`;

const analyze = (text: string) => {
  const r = validateModelText(text);
  if (!r.analysis || !r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("\n"));
  return { r, sms: stateMachines(r.analysis) };
};
const codes = (text: string) =>
  validateModelText(text)
    .diagnostics.filter((d) => d.code === "unreachable-state" || d.code === "never-enabled-operation")
    .map((d) => `${d.code} ${d.message}`);

describe("state machines", () => {
  test("the sample invitation: created pending; accept and revoke only while pending; both end states are terminal", () => {
    const { r, sms } = analyze(SAMPLE_MODEL);
    expect(r.ok).toBe(true);
    expect(sms).toHaveLength(1);
    const sm = sms[0]!;
    expect(sm).toMatchObject({ aggregate: "CleaningStaffInvitation", field: "status", initial: ["pending"], terminal: ["accepted", "revoked"], unreachable: [], neverEnabled: [] });
    expect(sm.transitions).toEqual([
      // accept also needs `at < expires_at`: possible in pending, decided at run time.
      { operation: "accept", from: ["pending"], conditional: ["pending"], to: ["accepted"], unguarded: false, keepsState: false },
      { operation: "revoke", from: ["pending"], conditional: [], to: ["revoked"], unguarded: false, keepsState: false },
    ]);
    expect(codes(SAMPLE_MODEL)).toEqual([]);
  });

  test("other fields stay unknown: a guard that also reads them is never decided by them", () => {
    // With other fields read as null, `paid_at != null` would be false and make pay look impossible.
    const text = model(
      "open, paid",
      `        state_guards:
          - { name: payable, expression: "status == open and paid_at == null", error: Closed }
          - { name: settled, expression: "status != open or paid_at != null", error: Closed }
        factories:
          - { name: place, parameters: [{ name: id, type: UUID }], fields: { id: id, status: open } }
        operations:
          - name: pay
            parameters: [{ name: at, type: DateTime }]
            require: [payable]
            changes: { status: paid, paid_at: at }
          - name: archive
            require: [settled]
            changes: { paid_at: paid_at }`,
    );
    const sm = analyze(text).sms[0]!;
    expect(sm.transitions.find((t) => t.operation === "pay")).toMatchObject({ from: ["open"], to: ["paid"] });
    // `settled` holds for paid whatever paid_at is, and may hold for open: possible in both.
    expect(sm.transitions.find((t) => t.operation === "archive")).toMatchObject({ from: ["open", "paid"], to: ["open", "paid"], unguarded: true });
    expect(sm.terminal).toEqual(["paid"]);
    expect(codes(text)).toEqual([]);
  });

  test("a state nothing reaches and an operation that only runs there are warnings", () => {
    const text = model(
      "open, paid, refunded",
      `        state_guards:
          - { name: is_refunded, expression: "status == refunded", error: Closed }
        factories:
          - { name: place, parameters: [{ name: id, type: UUID }], fields: { id: id, status: open } }
        operations:
          - { name: pay, changes: { status: paid } }
          - { name: reopen, require: [is_refunded], changes: { status: open } }`,
    );
    expect(codes(text)).toEqual([
      "unreachable-state Order.status can never become refunded: no factory creates it and no operation changes it to refunded",
      "never-enabled-operation Operation reopen can only run when status is refunded, which Order never reaches",
    ]);
    const d = validateModelText(text).diagnostics.find((x) => x.code === "unreachable-state")!;
    expect(d.severity).toBe("warning");
    expect(d.line).toBeGreaterThan(0);
  });

  test("several guards must all hold: two that exclude each other leave no state", () => {
    const text = model(
      "open, paid",
      `        state_guards:
          - { name: is_open, expression: "status == open", error: Closed }
          - { name: is_paid, expression: "status == paid", error: Closed }
          - { name: unpaid, expression: "paid_at == null", error: Closed }
        factories:
          - { name: place, parameters: [{ name: id, type: UUID }], fields: { id: id, status: open } }
        operations:
          - { name: pay, require: [is_open, unpaid], changes: { status: paid } }
          - { name: never, require: [is_open, is_paid], changes: { status: open } }`,
    );
    const sm = analyze(text).sms[0]!;
    expect(sm.transitions.find((t) => t.operation === "pay")!.from).toEqual(["open"]);
    expect(codes(text)).toEqual(["never-enabled-operation Operation never can never run: its guards are false for every status"]);
  });

  test("a state taken from a parameter may be any state; without a factory reachability is not checked", () => {
    const fromParam = model(
      "open, paid",
      `        factories:
          - { name: import_order, parameters: [{ name: id, type: UUID }, { name: s, type: Status }], fields: { id: id, status: s } }
        operations:
          - { name: pay, changes: { status: paid } }`,
    );
    expect(analyze(fromParam).sms[0]!.initial).toEqual(["open", "paid"]);
    expect(codes(fromParam)).toEqual([]);
    const noFactory = model("open, paid, lost", `        operations:\n          - { name: pay, changes: { status: paid } }`);
    const sm = analyze(noFactory).sms[0]!;
    expect(sm.reachable).toEqual(["open", "paid", "lost"]);
    expect(codes(noFactory)).toEqual([]);
  });

  test("an enum field nothing sets is not a state machine; a model with errors gets no state warnings", () => {
    const plain = model("open, paid", `        operations:\n          - { name: touch, changes: { paid_at: paid_at } }`, "          - { name: kind, type: Status }");
    expect(analyze(plain).sms.map((s) => s.field)).toEqual([]);
    const broken = model(
      "open, paid, lost",
      `        factories:
          - { name: place, parameters: [{ name: id, type: UUID }], fields: { id: id, status: open, nope: 1 } }`,
    );
    expect(validateModelText(broken).ok).toBe(false);
    expect(codes(broken)).toEqual([]);
  });
});
