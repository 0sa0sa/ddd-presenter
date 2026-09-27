import { describe, expect, test } from "bun:test";
import { validateModelText } from "@ddd/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, buildOutline, describeSteps, flatten, nodeAtPath, scenarioCards } from "../src/lib/outline.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");
const r = validateModelText(SAMPLE);
const model = r.model!;

describe("outline", () => {
  test("lists contexts, aggregates with members, and use cases", () => {
    const tree = buildOutline(model);
    expect(tree.map((n) => n.name)).toEqual(["CleaningStaff"]);
    const kinds = tree[0]!.children.map((n) => `${n.kind}:${n.name}`);
    expect(kinds).toContain("aggregate:CleaningStaffInvitation");
    expect(kinds).toContain("event:InvitationAccepted");
    expect(kinds).toContain("useCase:accept_invitation");
    const agg = tree[0]!.children.find((n) => n.kind === "aggregate")!;
    expect(agg.children.filter((n) => n.kind === "guard").map((n) => n.name)).toEqual(["pending_until_expiry", "is_open"]);
    expect(new Set(flatten(tree).map((n) => n.id)).size).toBe(flatten(tree).length);
  });

  test("diagnostic counts roll up to the owning element", () => {
    const bad = validateModelText(SAMPLE.replace("error: InvitationNotDeliverable", "error: Nope"));
    const tree = buildOutline(bad.model!, bad.diagnostics);
    const agg = tree[0]!.children.find((n) => n.kind === "aggregate")!;
    expect(agg.errors).toBe(1);
    expect(agg.children.find((n) => n.name === "pending_until_expiry")!.errors).toBe(1);
    expect(tree[0]!.errors).toBe(1);
  });

  test("cursor path maps to the deepest element", () => {
    const tree = buildOutline(model);
    const guard = flatten(tree).find((n) => n.name === "is_open")!;
    expect(nodeAtPath(tree, [...guard.path, "expression"])?.id).toBe(guard.id);
  });
});

describe("diagram graph", () => {
  test("nodes for aggregates, events, value objects and use cases with typed edges", () => {
    const { nodes, edges } = buildGraph(model, r.analysis);
    expect(nodes.filter((n) => n.kind === "aggregate").map((n) => n.name)).toEqual(["CleaningStaffInvitation"]);
    expect(nodes.filter((n) => n.kind === "event").map((n) => n.name).sort()).toEqual(["InvitationAccepted", "InvitationIssued", "InvitationRevoked"]);
    expect(edges.find((e) => e.kind === "uses" && e.source.endsWith("accept_invitation"))?.label).toBe("load, accept");
    expect(edges.find((e) => e.kind === "holds")?.label).toBe("email");
    expect(edges.filter((e) => e.kind === "emits").map((e) => e.label).sort()).toEqual(["accept", "issue", "revoke"]);
  });

  test("stored positions override the automatic layout", () => {
    const { nodes } = buildGraph(model, r.analysis, { "CleaningStaff/aggregate/CleaningStaffInvitation": { x: 5, y: 7 } });
    expect(nodes.find((n) => n.kind === "aggregate")).toMatchObject({ x: 5, y: 7 });
  });
});

describe("plain-language views", () => {
  test("use case steps read as a numbered sequence", () => {
    const uc = model.contexts[0]!.useCases.find((u) => u.name === "revoke_invitation")!;
    expect(describeSteps(uc.steps)).toEqual([
      "1. invitation = load CleaningStaffInvitation by invitation_id",
      "2. if invitation.is_open",
      "  3. invitation.revoke()",
      "  4. save invitation",
      "  5. publish InvitationRevoked (after commit)",
      "  6. return true",
      "   else",
      "  7. return false",
    ]);
  });

  test("scenarios render as Given / When / Then sentences", () => {
    const cards = scenarioCards(model);
    const expired = cards.find((c) => c.name === "expired_invitation_is_rejected")!;
    expect(expired.given[0]).toBe("現在時刻は 2026-01-08T10:00:00+00:00");
    expect(expired.when).toContain("スタッフ候補が accept_invitation を実行する");
    expect(expired.then).toEqual([
      "InvitationNotDeliverable で失敗する",
      "CleaningStaffInvitation 00000000-0000-0000-0000-000000000001 の status は pending",
      "イベントは発生しない",
    ]);
  });
});
