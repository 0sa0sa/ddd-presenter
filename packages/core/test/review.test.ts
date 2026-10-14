import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SAMPLE_MODEL } from "../../cli/src/sample.ts";
import { reviewFindings, reviewQuestions, validateModelText, type ReviewQuestion } from "../src/index.ts";

const fixture = (name: string) => readFileSync(new URL(`../../generator/test/fixtures/${name}.ddd.yaml`, import.meta.url), "utf8");
const questions = (text: string) => {
  const r = validateModelText(text);
  if (!r.analysis || !r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("\n"));
  return reviewQuestions(r.analysis);
};
const byId = (qs: ReviewQuestion[]) => new Map(qs.map((q) => [q.id, q]));
const answer = (qs: ReviewQuestion[], id: string) => {
  const q = byId(qs).get(id);
  if (!q) throw new Error(`no question ${id}; have:\n${qs.map((x) => x.id).join("\n")}`);
  return [q.modelAnswer, q.text];
};

describe("review questions: the sample model", () => {
  const qs = questions(SAMPLE_MODEL);

  test("organizations: another organization's data is out of reach; a hierarchy is not in the model", () => {
    expect(answer(qs, "tenancy:read-other:CleaningStaff.CleaningStaffInvitation")).toEqual(["no", "ある組織のユーザーは、別の組織のスタッフ候補への招待（CleaningStaffInvitation）を見られる。"]);
    expect(answer(qs, "tenancy:change-other:CleaningStaff.CleaningStaffInvitation")[0]).toBe("no");
    expect(answer(qs, "tenancy:hierarchy")[0]).toBe("undefined");
    expect(answer(qs, "tenancy:parent-reads-children")).toEqual(["no", "上位の組織の管理者は、配下の組織のメンバーやデータをすべて見られる。"]);
    expect(answer(qs, "tenancy:platform-roles-inside")[0]).toBe("no");
  });

  test("who may do what: permissions through inheritance, allow_if put into words per role", () => {
    expect(answer(qs, "access:inherits:admin.staff")).toEqual(["yes", "admin は、staff ができることをすべてできる。"]);
    expect(answer(qs, "access:staff:CleaningStaff.issue_invitation")[0]).toBe("yes");
    expect(answer(qs, "access:candidate:CleaningStaff.issue_invitation")[0]).toBe("no");
    expect(answer(qs, "access:staff:CleaningStaff.revoke_invitation")).toEqual(["no", "staff は「revoke_invitation」を実行できる。"]);
    expect(answer(qs, "access:admin:CleaningStaff.revoke_invitation")[0]).toBe("yes");
    // The null check before the comparison is left out; the loaded variable reads as its aggregate.
    expect(answer(qs, "access:candidate:CleaningStaff.accept_invitation:when")).toEqual(["yes", "candidate は、本人の email がスタッフ候補への招待の email と同じときだけ「招待を受諾する」（accept_invitation）を実行できる。"]);
    expect(answer(qs, "access:candidate:CleaningStaff.accept_invitation:always")[0]).toBe("no");
    // staff holds invitation.read, so the aggregate's allow_if always holds for it.
    expect(answer(qs, "access:staff:CleaningStaff.CleaningStaffInvitation:read")[0]).toBe("yes");
    expect(answer(qs, "access:staff:Staffing.StaffMember:read")[0]).toBe("no");
    expect(answer(qs, "access:operator:CleaningStaff.inspect_invitation")).toEqual(["yes", "運営側の operator は（指定した組織に対して）「inspect_invitation」を実行できる。"]);
    expect(answer(qs, "access:internal:Staffing.register_staff")[0]).toBe("yes");
    // Tenant roles do not run a cross-tenant use case, platform roles not a tenant one.
    expect(qs.some((q) => q.id === "access:admin:CleaningStaff.inspect_invitation" || q.id === "access:operator:CleaningStaff.issue_invitation")).toBe(false);
  });

  test("states: created pending, accept / revoke only while pending, accepted and revoked are final", () => {
    expect(answer(qs, "lifecycle:initial:CleaningStaff.CleaningStaffInvitation.status")[0]).toBe("yes");
    expect(answer(qs, "lifecycle:can:CleaningStaff.CleaningStaffInvitation.status.revoke.pending")).toEqual(["yes", "「pending」のスタッフ候補への招待（CleaningStaffInvitation）に対して、「招待を取り消す」（revoke）ができる。"]);
    // accept needs more than the state (before the expiry): the statement says so, or an expired invitation would read as a "no".
    expect(answer(qs, "lifecycle:can:CleaningStaff.CleaningStaffInvitation.status.accept.pending")).toEqual([
      "yes",
      "「pending」のスタッフ候補への招待（CleaningStaffInvitation）は、「保留中かつ期限前」（pending_until_expiry）のときなら、「招待を受諾する」（accept）ができる。",
    ]);
    expect(answer(qs, "lifecycle:can:CleaningStaff.CleaningStaffInvitation.status.revoke.accepted")).toEqual(["no", "「accepted」のスタッフ候補への招待（CleaningStaffInvitation）に対して、「招待を取り消す」（revoke）ができる。"]);
    expect(answer(qs, "lifecycle:final:CleaningStaff.CleaningStaffInvitation.status.revoked")[0]).toBe("yes");
    expect(answer(qs, "lifecycle:delete:CleaningStaff.CleaningStaffInvitation")[0]).toBe("undefined");
    // A guard that reads only the state is asked state by state, not again as a rule.
    expect(qs.some((q) => q.id === "rules:guard:CleaningStaff.CleaningStaffInvitation.revoke.is_open")).toBe(false);
    expect(answer(qs, "rules:guard:CleaningStaff.CleaningStaffInvitation.accept.pending_until_expiry")[0]).toBe("yes");
  });

  test("connections, data and what happens by itself", () => {
    expect(answer(qs, "relations:unique:CleaningStaff.CleaningStaffInvitation.email")).toEqual(["yes", "同じ email を持つスタッフ候補への招待（CleaningStaffInvitation）が 2 つ以上あってもよい。"]);
    expect(answer(qs, "relations:case:CleaningStaff.EmailAddress.value")[0]).toBe("yes");
    expect(answer(qs, "data:required:CleaningStaff.CleaningStaffInvitation.accepted_at")[0]).toBe("no");
    expect(answer(qs, "automation:policy:Staffing.register_staff_on_acceptance")).toEqual(["yes", "CleaningStaff の「InvitationAccepted」が起きたら、自動で「招待を受諾した人をスタッフとして登録する」（register_staff）が行われる。"]);
    expect(answer(qs, "automation:no-reaction:CleaningStaff.InvitationRevoked")).toEqual(["yes", "「招待を取り消す」（revoke）で「InvitationRevoked」が起きたとき、ほかに自動で行うこと（通知・別の記録の更新など）はない。"]);
    expect(answer(qs, "automation:idempotent:CleaningStaff.issue_invitation")[0]).toBe("no");
  });

  test("ids are unique, every question says why and what to change, the categories come in order", () => {
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    for (const q of qs) {
      expect(q.basis.length).toBeGreaterThan(0);
      expect(q.ifDifferent.length).toBeGreaterThan(0);
      expect(q.text).not.toMatch(/undefined|\[object|NaN/);
      expect(q.text).toMatch(/。$/);
      expect(q.path.length).toBeGreaterThan(0);
    }
    const cats = [...new Set(qs.map((q) => q.category))];
    expect(cats).toEqual(["tenancy", "access", "lifecycle", "relations", "rules", "data", "automation"]);
    // Both polarities: a reviewer cannot answer everything with yes.
    expect(qs.filter((q) => q.modelAnswer === "no").length).toBeGreaterThan(10);
  });

  test("ids survive an edit elsewhere in the model; a renamed element gets new ids", () => {
    const edited = SAMPLE_MODEL.replace("description: 招待を取り消す", "description: 招待をやめる");
    const ids = new Set(questions(edited).map((q) => q.id));
    expect(qs.every((q) => ids.has(q.id))).toBe(true);
  });
});

describe("review questions: other models", () => {
  test("an operation without a guard can run in every state, even after cancelling (a finding to confirm)", () => {
    const qs = questions(fixture("ordering"));
    expect(answer(qs, "lifecycle:can:Sales.Order.status.deliver.cancelled")).toEqual(["yes", "「cancelled」の Order に対して、「deliver」ができる。"]);
    expect(answer(qs, "lifecycle:back:Sales.Order.status.placed.open")[0]).toBe("no");
    // count(lines) <= 50 is an upper bound even without max_items.
    expect(answer(qs, "relations:entity-max:Sales.Order.OrderLine")[0]).toBe("yes");
    expect(byId(qs).get("relations:entity-max:Sales.Order.OrderLine")!.basis).toContain("最大 50 個");
  });

  test("not is_empty(lines) means at least one entity; a Ref is a required parent", () => {
    const qs = questions(fixture("kitchen-sink"));
    expect(answer(qs, "relations:entity-none:Ordering.Order.OrderLine")[0]).toBe("no");
    expect(answer(qs, "relations:belongs:Ordering.Order.customer_id")[0]).toBe("yes");
    expect(answer(qs, "relations:many-per:Ordering.Order.customer_id")[0]).toBe("yes");
    expect(answer(qs, "lifecycle:reachable:Ordering.Order.status.cancelled")[0]).toBe("no");
  });

  test("a UUID named after an aggregate reads as a reference; inputs and loads are named in conditions", () => {
    const qs = questions(fixture("security"));
    const belongs = byId(qs).get("relations:belongs:Hiring.Application.job_id")!;
    expect(belongs.modelAnswer).toBe("yes");
    expect(belongs.basis).toContain("名前から Job を指すと読んだ");
    expect(qs.some((q) => q.id === "data:required:Hiring.Application.job_id")).toBe(false);
    expect(answer(qs, "access:staff:Hiring.post_job:when")[1]).toBe("staff は、本人の company_id が入力の company_id と同じときだけ「post_job」を実行できる。");
    expect(answer(qs, "access:staff:Hiring.Job:read:when")[1]).toBe("staff は、Job の status が open、または本人の company_id が Job の company_id と同じときだけ Job を（ID を指定して）見られる。");
  });

  test("shared (global) data and several platform roles", () => {
    const qs = questions(fixture("tenancy"));
    const shared = qs.filter((q) => q.id.startsWith("tenancy:shared:"));
    expect(shared.map((q) => [q.modelAnswer, q.text])).toEqual([["yes", "InvitationTemplate はすべての組織で共有され、どの組織のユーザーにも同じものが見える。"]]);
    expect(qs.find((q) => q.id === "tenancy:platform-roles-inside")!.text).toContain("（operator・support）");
  });

  test("without security: one organization, and everything open", () => {
    const qs = questions(fixture("ordering"));
    expect(answer(qs, "tenancy:multi-organization")[0]).toBe("no");
    expect(answer(qs, "access:no-login")[0]).toBe("yes");
  });

  test("every fixture gives questions without failing", () => {
    for (const name of ["context-map", "queries", "identities", "kitchen-sink", "long-rules", "secure-queries", "tenancy", "security", "ordering"]) {
      const qs = questions(fixture(name));
      expect(qs.length).toBeGreaterThan(3);
      expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    }
  });
});

describe("review findings", () => {
  const qs = questions(SAMPLE_MODEL);
  test("answers that differ from the model, and a yes to what the model has no place for", () => {
    const findings = reviewFindings(qs, {
      "tenancy:parent-reads-children": "yes",
      "tenancy:hierarchy": "yes",
      "tenancy:multiple-memberships": "no",
      "access:staff:CleaningStaff.revoke_invitation": "no",
      "relations:unique:CleaningStaff.CleaningStaffInvitation.email": "no",
      "unknown:id": "yes",
    });
    expect(findings.map((f) => [f.question.id, f.kind])).toEqual([
      ["tenancy:hierarchy", "missing"],
      ["tenancy:parent-reads-children", "differs"],
      ["relations:unique:CleaningStaff.CleaningStaffInvitation.email", "differs"],
    ]);
  });
});
