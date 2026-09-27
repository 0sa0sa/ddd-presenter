import { describe, expect, test } from "bun:test";
import { applyEdits, complete, definition, hover, validateModelText } from "../src/index.ts";

/** Two contexts: Hiring publishes CandidateAccepted; Staffing reacts to it (policy) and to its own event. */
export const CONTEXT_MAP_MODEL = `schema_version: 1
project: demo
contexts:
  - name: Hiring
    enums:
      - { name: Level, values: [junior, senior] }
    value_objects:
      - { name: EmailAddress, fields: [{ name: value, type: String }] }
    aggregates:
      - name: Candidate
        identity: id
        fields: [{ name: id, type: UUID }, { name: email, type: EmailAddress }, { name: level, type: Level }, { name: note, type: String, required: false }]
        operations:
          - name: accept
            parameters: [{ name: at, type: DateTime }]
            changes: { note: '"accepted"' }
            emits: [{ name: CandidateAccepted, fields: [id, email, level, note, at] }]
  - name: Staffing
    enums:
      - { name: Level, values: [junior, senior] }
    aggregates:
      - name: Staff
        identity: id
        fields: [{ name: id, type: UUID }, { name: welcomed, type: Boolean }]
        factories:
          - name: register
            parameters: [{ name: id, type: UUID }]
            fields: { id: id, welcomed: false }
            emits: [{ name: StaffRegistered, fields: [id] }]
        operations:
          - name: welcome
            changes: { welcomed: true }
            emits: [{ name: StaffWelcomed, fields: [id] }]
    use_cases:
      - name: register_staff
        command: RegisterStaff
        input: [{ name: candidate_id, type: UUID }, { name: email, type: String }, { name: joined_at, type: DateTime }]
        steps:
          - create: { aggregate: Staff, factory: register, as: staff, args: { id: ids.new } }
          - save: staff
          - publish_after_commit: StaffRegistered
      - name: welcome_staff
        command: WelcomeStaff
        input: [{ name: staff_id, type: UUID }]
        steps:
          - load: { aggregate: Staff, by: staff_id, as: staff }
          - invoke: { target: staff, operation: welcome }
          - save: staff
          - publish_after_commit: StaffWelcomed
    policies:
      - name: register_accepted_candidate
        when: Hiring.CandidateAccepted
        run: register_staff
        args: { candidate_id: event.id, email: event.email.value, joined_at: event.at }
      - name: welcome_new_staff
        when: StaffRegistered
        run: welcome_staff
        args: { staff_id: event.id }
relationships:
  - { upstream: Hiring, downstream: Staffing, pattern: customer_supplier, events: [CandidateAccepted] }
`;
const BASE = CONTEXT_MAP_MODEL;

const errors = (text: string) => validateModelText(text).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
const only = (text: string, code: string) => validateModelText(text).diagnostics.filter((d) => d.code === code);

describe("validation: policies and the context map", () => {
  test("a valid context map: typed args, resolved events, no errors or warnings", () => {
    const r = validateModelText(BASE);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const staffing = r.analysis!.contexts.get("Staffing")!;
    expect(staffing.policies.get("register_accepted_candidate")).toMatchObject({ event: { context: "Hiring", name: "CandidateAccepted" }, crossContext: true, relationship: { pattern: "customer_supplier" } });
    expect(staffing.policies.get("welcome_new_staff")).toMatchObject({ event: { context: "Staffing", name: "StaffRegistered" }, crossContext: false });
  });

  test("a cross-context policy needs a relationship that lists the event (FR-002), with the YAML to add as hint", () => {
    const noRel = BASE.replace(/relationships:[\s\S]*$/, "");
    const [d] = only(noRel, "missing-relationship");
    expect(d!.severity).toBe("error");
    expect(d!.line).toBe(BASE.split("\n").findIndex((l) => l.includes("when: Hiring.CandidateAccepted")) + 1);
    expect(d!.hint).toContain("- { upstream: Hiring, downstream: Staffing, pattern: customer_supplier, events: [CandidateAccepted] }");
    const notListed = BASE.replace("events: [CandidateAccepted] }", "events: [] }");
    expect(only(notListed, "event-not-in-contract")[0]!.hint).toContain("events: [CandidateAccepted]");
  });

  test("unknown event, context and use case are reported at the reference", () => {
    expect(only(BASE.replace("when: Hiring.CandidateAccepted", "when: Hiring.CandidateAcepted"), "unknown-event")[0]!.hint).toBe('Did you mean "CandidateAccepted"?');
    expect(only(BASE.replace("when: Hiring.CandidateAccepted", "when: Hirin.CandidateAccepted"), "unknown-context")[0]!.hint).toBe('Did you mean "Hiring"?');
    expect(only(BASE.replace("when: Hiring.CandidateAccepted", "when: CandidateAccepted"), "unknown-event")[0]!.hint).toBe("It is emitted by Hiring; write when: Hiring.CandidateAccepted");
    expect(only(BASE.replace("run: register_staff", "run: register_staf"), "unknown-use-case")[0]!.hint).toBe('Did you mean "register_staff"?');
  });

  test("args must cover required inputs, name existing inputs and event fields, and be type compatible", () => {
    const missing = only(BASE.replace(", joined_at: event.at }", " }"), "missing-argument");
    expect(missing.map((d) => d.message)).toEqual(['Missing argument "joined_at" for use case register_staff']);
    expect(only(BASE.replace("args: { staff_id: event.id }", "args: {}"), "missing-argument")[0]!.hint).toBe("Map it from the event: args: { staff_id: event.id }");
    expect(only(BASE.replace("joined_at: event.at", "joined_at: event.at, extra: event.id"), "unknown-argument")).toHaveLength(1);
    expect(only(BASE.replace("joined_at: event.at", "joined_at: event.when"), "unknown-field")[0]!.hint).toContain("Fields:");
    expect(only(BASE.replace("joined_at: event.at", "joined_at: event.id"), "type-mismatch")[0]!.message).toBe('event.id is UUID but input "joined_at" of register_staff is DateTime');
    expect(only(BASE.replace("email: event.email.value", "email: event.note"), "type-mismatch")[0]!.hint).toContain("may be null");
  });

  test("model types (value objects, enums) do not cross a context boundary; values do", () => {
    const vo = BASE.replace("{ name: email, type: String }", "{ name: email, type: EmailAddress }")
      .replace("  - name: Staffing\n", "  - name: Staffing\n    value_objects:\n      - { name: EmailAddress, fields: [{ name: value, type: String }] }\n")
      .replace("email: event.email.value", "email: event.email");
    expect(only(vo, "cross-context-type")[0]!.hint).toContain("event.email.value");
    const en = BASE.replace("{ name: joined_at, type: DateTime }]", "{ name: joined_at, type: DateTime }, { name: level, type: Level }]").replace(
      "joined_at: event.at }",
      "joined_at: event.at, level: event.level }",
    );
    expect(only(en, "cross-context-type")).toHaveLength(1);
  });

  test("clock.now, ids.new and literals are allowed as args", () => {
    const r = validateModelText(BASE.replace("joined_at: event.at", "joined_at: clock.now"));
    expect(r.ok).toBe(true);
    expect(r.analysis!.contexts.get("Staffing")!.policies.get("register_accepted_candidate")!.usesClock).toBe(true);
    expect(errors(BASE.replace("email: event.email.value", "email: '\"someone@example.com\"'"))).toEqual([]);
    expect(errors(BASE.replace("email: event.email.value", "email: 1"))).toContain("invalid-expression");
  });

  test("relationships: unknown contexts and events, self, duplicates, separate_ways with events, patterns", () => {
    const rel = (r: string) => BASE.replace(/relationships:[\s\S]*$/, `relationships:\n${r}\n`);
    expect(errors(rel("  - { upstream: Hirin, downstream: Staffing, events: [CandidateAccepted] }"))).toContain("unknown-context");
    expect(errors(rel("  - { upstream: Hiring, downstream: Staffing, events: [CandidateAccepted, Nope] }"))).toContain("unknown-event");
    expect(errors(rel("  - { upstream: Hiring, downstream: Staffing, events: [CandidateAccepted] }\n  - { upstream: Staffing, downstream: Staffing }"))).toContain("self-relationship");
    expect(errors(rel("  - { upstream: Hiring, downstream: Staffing, events: [CandidateAccepted] }\n  - { upstream: Hiring, downstream: Staffing }"))).toContain("duplicate-relationship");
    expect(errors(rel("  - { upstream: Hiring, downstream: Staffing, pattern: separate_ways, events: [CandidateAccepted] }"))).toContain("separate-ways-with-events");
    expect(errors(rel("  - { upstream: Hiring, downstream: Staffing, pattern: big_ball_of_mud, events: [CandidateAccepted] }"))).toContain("invalid-value");
    // The default pattern is customer_supplier.
    expect(validateModelText(rel("  - { upstream: Hiring, downstream: Staffing, events: [CandidateAccepted] }")).model!.relationships[0]!.pattern).toBe("customer_supplier");
  });

  test("a contract event nobody consumes is reported as info", () => {
    const d = only(BASE.replace(/      - name: register_accepted_candidate[\s\S]*?joined_at: event.at \}\n/, ""), "unused-contract-event");
    expect(d.map((x) => [x.severity, x.message])).toEqual([["info", "Staffing has no policy that consumes Hiring.CandidateAccepted"]]);
  });

  test("a use case that publishes the event its own policy consumes is a loop (directly or transitively)", () => {
    const direct = BASE.replace("when: StaffRegistered", "when: StaffWelcomed");
    expect(only(direct, "policy-cycle")[0]!.message).toBe("Policies form a loop: Staffing.StaffWelcomed → (Staffing.welcome_new_staff) → Staffing.StaffWelcomed");
    const transitive = BASE.replace(
      "        args: { staff_id: event.id }\n",
      "        args: { staff_id: event.id }\n      - name: register_again\n        when: StaffWelcomed\n        run: register_staff\n        args: { candidate_id: event.id, email: '\"x@example.com\"', joined_at: clock.now }\n",
    );
    const cycle = only(transitive, "policy-cycle");
    expect(cycle).toHaveLength(1);
    expect(cycle[0]!.severity).toBe("warning");
    expect(cycle[0]!.message).toContain("(Staffing.welcome_new_staff)");
    expect(cycle[0]!.message).toContain("(Staffing.register_again)");
  });

  test("policy names are snake_case, unique, and their handler class does not clash with other types", () => {
    expect(errors(BASE.replace("name: welcome_new_staff", "name: WelcomeNewStaff"))).toContain("invalid-name");
    expect(errors(BASE.replace("name: welcome_new_staff", "name: register_accepted_candidate"))).toContain("duplicate-name");
    expect(errors(BASE.replace("command: WelcomeStaff", "command: WelcomeNewStaffPolicy"))).toContain("duplicate-name");
  });
});

/** Cursor at the `|` marker. */
function at(text: string): [string, number] {
  const i = text.indexOf("|");
  return [text.slice(0, i) + text.slice(i + 1), i];
}
const labels = (text: string, offset: number) => complete(text, offset).items.map((i) => i.label);
const cursorAfter = (needle: string, delta = needle.length): [string, number] => [BASE, BASE.indexOf(needle) + delta];

describe("language service: policies and relationships", () => {
  test("keys of a policy and of a relationship", () => {
    const [t, o] = at(BASE.replace("      - name: welcome_new_staff\n", "      - |\n      - name: welcome_new_staff\n"));
    expect(labels(t, o)).toEqual(["name", "description", "when", "run", "args"]);
    const [t2, o2] = at(BASE + "  - |\n");
    expect(labels(t2, o2)).toEqual(["upstream", "downstream", "pattern", "events", "description"]);
    const [t3, o3] = at(BASE.replace("    policies:\n", "    pol|\n    policies:\n").replace("    policies:\n      - name: register", "    policiez:\n      - name: register"));
    expect(labels(t3, o3)).toContain("policies");
    const [t4, o4] = at(BASE.replace("relationships:", "rel|\nrelationships:").replace("\nrelationships:", "\nrelationshipz:"));
    expect(labels(t4, o4)).toEqual(["relationships"]);
  });

  test("when: events of this context first, then contract events of other contexts (qualified)", () => {
    const [t, o] = at(BASE.replace("when: StaffRegistered", "when: |"));
    const items = complete(t, o).items;
    expect(items.map((i) => i.label).slice(0, 2)).toEqual(["StaffRegistered", "StaffWelcomed"]);
    expect(items.map((i) => i.label)).toContain("Hiring.CandidateAccepted");
    expect(items.find((i) => i.label === "Hiring.CandidateAccepted")!.detail).toContain("customer_supplier");
  });

  test("run: use cases of the context; args: inputs as keys and event fields after event.", () => {
    const [t, o] = at(BASE.replace("run: welcome_staff", "run: |"));
    expect(labels(t, o)).toEqual(["register_staff", "welcome_staff"]);
    const [t2, o2] = at(BASE.replace("args: { candidate_id: event.id, email: event.email.value, joined_at: event.at }", "args: { candidate_id: event.id, | }"));
    expect(labels(t2, o2)).toEqual(["email", "joined_at"]);
    const [t3, o3] = at(BASE.replace("joined_at: event.at }", "joined_at: event.| }"));
    expect(labels(t3, o3)).toEqual(["id", "email", "level", "note", "at"]);
    const [t4, o4] = at(BASE.replace("email: event.email.value", "email: event.email.|"));
    expect(labels(t4, o4)).toEqual(["value"]);
    const [t5, o5] = at(BASE.replace("joined_at: event.at }", "joined_at: | }"));
    expect(labels(t5, o5)).toEqual(expect.arrayContaining(["event", "clock", "ids"]));
  });

  test("relationship values: contexts, patterns and upstream events", () => {
    const rel = (r: string) => at(BASE.replace(/relationships:[\s\S]*$/, `relationships:\n${r}\n`));
    expect(labels(...rel("  - { upstream: |"))).toEqual(["Hiring", "Staffing"]);
    expect(labels(...rel("  - { upstream: Hiring, downstream: Staffing, pattern: anti|"))).toEqual(["anticorruption_layer"]);
    expect(labels(...rel("  - { upstream: Hiring, downstream: Staffing, events: [|"))).toEqual(["CandidateAccepted"]);
    const block = at(BASE.replace(/relationships:[\s\S]*$/, "relationships:\n  - upstream: Hiring\n    downstream: Staffing\n    events:\n      - Cand|\n"));
    expect(labels(...block)).toEqual(["CandidateAccepted"]);
  });

  test("hover and definition on the consumed event, the use case, a context and event fields", () => {
    const [t, o] = cursorAfter("when: Hiring.CandidateAccepted", "when: Hiring.Cand".length);
    expect(hover(t, o)!.markdown).toContain("**CandidateAccepted** — Domain event");
    const def = definition(t, o)!;
    expect(t.slice(def.from, def.to)).toBe("CandidateAccepted");
    expect(t.slice(0, def.from)).toContain("name: accept");
    const [t2, o2] = cursorAfter("when: Hiring.CandidateAccepted", "when: Hi".length);
    expect(hover(t2, o2)!.markdown).toContain("**Hiring** — Bounded context");
    const [t3, o3] = cursorAfter("run: register_staff", "run: reg".length);
    expect(hover(t3, o3)!.markdown).toContain("**register_staff** — Use case");
    const d3 = definition(t3, o3)!;
    expect(t3.slice(d3.from, d3.to)).toBe("register_staff");
    const [t4, o4] = cursorAfter("joined_at: event.at", "joined_at: event.a".length);
    expect(hover(t4, o4)!.markdown).toContain("`at`: DateTime — CandidateAccepted のフィールド");
    const [t5, o5] = cursorAfter("pattern: customer_supplier", "pattern: cust".length);
    expect(hover(t5, o5)!.markdown).toContain("customer_supplier");
    const [t6, o6] = cursorAfter("events: [CandidateAccepted]", "events: [Cand".length);
    expect(hover(t6, o6)!.markdown).toContain("**CandidateAccepted** — Domain event");
    const [t7, o7] = cursorAfter("when:", 2);
    expect(hover(t7, o7)!.markdown).toContain("`when`");
  });

  test("renaming an event updates policies and contracts in other contexts", () => {
    const r = applyEdits(BASE, [{ op: "renameType", context: "Hiring", from: "CandidateAccepted", to: "CandidateHired" }]);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain("when: Hiring.CandidateHired");
    expect(text).toContain("events: [CandidateHired]");
    expect(validateModelText(text).ok).toBe(true);
    const own = applyEdits(BASE, [{ op: "renameType", context: "Staffing", from: "StaffRegistered", to: "StaffJoined" }]);
    expect((own as { text: string }).text).toContain("when: StaffJoined");
    expect(validateModelText((own as { text: string }).text).ok).toBe(true);
  });
});
