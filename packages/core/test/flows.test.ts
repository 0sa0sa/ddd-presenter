import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SAMPLE_MODEL } from "../../cli/src/sample.ts";
import { applyFlowBlock, eventFlowToMermaid, flowBlock, flowBlocks, flowDiagrams, flowsMarkdown, sequenceToMermaid, validateModelText, type SeqItem } from "../src/index.ts";

const fixture = (name: string) => readFileSync(new URL(`../../generator/test/fixtures/${name}.ddd.yaml`, import.meta.url), "utf8");
const diagrams = (text: string) => {
  const r = validateModelText(text);
  if (!r.model || !r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("\n"));
  return flowDiagrams(r.model, r.analysis);
};
const texts = (items: SeqItem[]): string[] => items.flatMap((i) => (i.kind === "block" ? i.branches.flatMap((b) => [`[${b.label}]`, ...texts(b.items)]) : [i.text]));

describe("use case sequences", () => {
  const d = diagrams(SAMPLE_MODEL);
  const accept = d.useCases.find((x) => x.ref.name === "accept_invitation")!;

  test("who takes part, left to right: the caller, the servers, the application, the aggregate, the database, events, the other context", () => {
    expect(accept.participants.map((p) => p.label)).toEqual(["スタッフ候補", "Connect API", "セキュリティ", "CleaningStaff アプリケーション", "CleaningStaffInvitation", "PostgreSQL", "イベント配信", "Staffing アプリケーション"]);
  });

  test("the steps in order, with every place it stops", () => {
    const t = texts(accept.items);
    const at = (s: string) => t.findIndex((x) => x.includes(s));
    // Loaded before the allow_if rule is checked; the guard's description, not its expression; the error's message.
    expect(at("読み込む: CleaningStaffInvitation")).toBeLessThan(at("[「本人の email"));
    // allow_if in words (the null check left out, the loaded variable read as its aggregate).
    expect(t).toContain("[「本人の email がスタッフ候補への招待の email と同じ」でない]");
    expect(t).toContain("[「保留中かつ期限前」でない]");
    expect(t).toContain("失敗: InvitationNotFound（招待が見つかりません）");
    expect(at("保存: invitation")).toBeLessThan(at("コミット後に発行: InvitationAccepted"));
    // The policy of the other context that reacts.
    expect(t).toContain("「招待が受諾されたらスタッフとして登録する」register_staff_on_acceptance → register_staff");
    expect(t[t.length - 1]).toBe("応答");
  });

  test("a use case only a policy runs starts at the event dispatch", () => {
    const reg = d.useCases.find((x) => x.ref.name === "register_staff")!;
    expect(reg.participants[0]).toMatchObject({ label: "イベント配信", kind: "events" });
    expect(reg.participants.some((p) => p.label === "Connect API")).toBe(false);
  });

  test("if / else become one alt block; an if without else is an opt", () => {
    const revoke = d.useCases.find((x) => x.ref.name === "revoke_invitation")!;
    const alt = revoke.items.find((i) => i.kind === "block" && i.type === "alt");
    expect(alt?.kind === "block" && alt.branches.map((b) => b.label)).toEqual(["スタッフ候補への招待が is_open を満たす", "それ以外"]);
    const place = diagrams(fixture("ordering")).useCases.find((x) => x.ref.name === "place_order")!;
    expect(place.items.some((i) => i.kind === "block" && i.type === "opt" && i.branches[0]!.label === "total < 10")).toBe(true);
    expect(texts(place.items)).toContain("計算: total = sum(order.lines, item.unit_price.amount * item.quantity) - order.discount");
  });

  test("without a generated API the caller talks to the application directly", () => {
    const place = diagrams(fixture("ordering")).useCases.find((x) => x.ref.name === "place_order")!;
    expect(place.participants.some((p) => p.kind === "server" || p.kind === "security")).toBe(false);
    expect(place.participants[0]!.label).toBe("利用者");
  });
});

describe("query sequences", () => {
  test("conditions, the tenant, the search and the order in words", () => {
    const q = diagrams(SAMPLE_MODEL).queries[0]!;
    const t = texts(q.items).join("\n");
    expect(t).toContain("tenant_id = 本人の組織（RLS でも強制）");
    expect(t).toContain("status = 入力の status（あれば）");
    expect(t).toContain("あいまい検索（類似度 0.3 以上）");
    expect(t).toContain("20 件ずつ（最大 100 件）");
  });
});

describe("the event chain", () => {
  test("use case → event → policy → use case across contexts; events nothing reacts to are marked", () => {
    const g = diagrams(SAMPLE_MODEL).events;
    const edge = (a: string, b: string) => g.edges.some((e) => e.from === a && e.to === b);
    expect(edge("uc:CleaningStaff.accept_invitation", "ev:CleaningStaff.InvitationAccepted")).toBe(true);
    expect(edge("ev:CleaningStaff.InvitationAccepted", "pol:Staffing.register_staff_on_acceptance")).toBe(true);
    expect(edge("pol:Staffing.register_staff_on_acceptance", "uc:Staffing.register_staff")).toBe(true);
    expect(g.nodes.find((n) => n.id === "ev:CleaningStaff.InvitationRevoked")).toMatchObject({ dangling: true });
    expect(g.nodes.find((n) => n.id === "ev:CleaningStaff.InvitationAccepted")!.dangling).toBe(false);
  });
});

describe("mermaid", () => {
  test("sequence and flowchart text; labels cannot end a statement", () => {
    const d = diagrams(SAMPLE_MODEL);
    const seq = sequenceToMermaid(d.useCases.find((x) => x.ref.name === "accept_invitation")!);
    expect(seq).toStartWith("sequenceDiagram\n  actor p0 as スタッフ候補\n");
    expect(seq).toContain("  opt 見つからない\n");
    expect(seq).toMatch(/p\d--xp\d: 失敗: InvitationNotFound/);
    expect(seq).toMatch(/p\d-\)p\d: コミット後に発行: InvitationAccepted/);
    const flow = eventFlowToMermaid(d.events);
    expect(flow).toStartWith("flowchart LR\n");
    expect(flow).toContain('subgraph c0["CleaningStaff"]');
    expect(flow).toMatch(/n\d+ -\.->\|"コミット後"\| n\d+/);
    // `;` ends a Mermaid statement: only the entities the labels are escaped with may hold one.
    for (const line of [...seq.split("\n"), ...flow.split("\n")]) expect(line.replace(/#\w+;/g, "")).not.toContain(";");
    const v = validateModelText(SAMPLE_MODEL);
    const md = flowsMarkdown(v.model!, v.analysis);
    expect(md.match(/```mermaid/g)!.length).toBe(1 + d.useCases.length + d.queries.length);
  });

  test("every fixture gives diagrams", () => {
    for (const name of ["context-map", "queries", "identities", "kitchen-sink", "long-rules", "secure-queries", "tenancy", "security", "ordering"]) {
      const d = diagrams(fixture(name));
      for (const s of [...d.useCases, ...d.queries]) expect(sequenceToMermaid(s)).not.toMatch(/undefined/);
      expect(eventFlowToMermaid(d.events)).not.toMatch(/undefined/);
    }
  });
});

describe("editing a flow block", () => {
  const ctx = "CleaningStaff";
  const revoke = flowBlock(SAMPLE_MODEL, { context: ctx, kind: "use_case", name: "revoke_invitation" })!;

  test("the blocks read the way the .flow file writes them; an unchanged block changes nothing", () => {
    expect(revoke.source).toStartWith("flow revoke_invitation(invitation_id) {\n");
    for (const c of flowBlocks(SAMPLE_MODEL)) {
      for (const b of c.blocks) expect(applyFlowBlock(SAMPLE_MODEL, { context: c.context, kind: b.kind, name: b.name }, b.source + "\n")).toEqual({ ok: true, text: SAMPLE_MODEL, changed: false });
    }
  });

  test("an edit that only respells a block (spaces) writes nothing back, in every fixture", () => {
    for (const name of ["context-map", "queries", "identities", "kitchen-sink", "long-rules", "secure-queries", "tenancy", "security", "ordering"]) {
      const text = fixture(name);
      for (const c of flowBlocks(text)) {
        for (const b of c.blocks) {
          const respelled = b.source.replace(/\{\n/, "{   \n").replace(/\n(\s*)save /, "\n$1save  ");
          const r = applyFlowBlock(text, { context: c.context, kind: b.kind, name: b.name }, respelled);
          if (!r.ok) throw new Error(`${name} ${b.name}: ${JSON.stringify(r)}`);
          expect([name, b.name, r.text === text]).toEqual([name, b.name, true]);
        }
      }
    }
  });

  test("a new step is written into the YAML; the rest of the file stays as it was", () => {
    const src = revoke.source.replace("  if invitation.is_open {", "  if invitation.status == revoked {\n    return false\n  }\n  if invitation.is_open {");
    const r = applyFlowBlock(SAMPLE_MODEL, { context: ctx, kind: "use_case", name: "revoke_invitation" }, src);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.changed).toBe(true);
    const before = SAMPLE_MODEL.split("\n");
    const after = r.text.split("\n");
    // Only added lines: comments, order and the spelling of the other steps (return: true) are kept.
    const at = after.findIndex((l) => l.trim() === "condition: invitation.status == revoked") - 1;
    expect(after.slice(at, at + 4).map((l) => l.trim())).toEqual(["- if:", "condition: invitation.status == revoked", "then:", "- return: false"]);
    expect([...after.slice(0, at), ...after.slice(at + 4)]).toEqual(before);
    expect(validateModelText(r.text).ok).toBe(true);
    expect(flowBlock(r.text, { context: ctx, kind: "use_case", name: "revoke_invitation" })!.source).toBe(src.replace(/\s*$/, "\n"));
  });

  test("a policy's arguments", () => {
    const p = flowBlock(SAMPLE_MODEL, { context: "Staffing", kind: "policy", name: "register_staff_on_acceptance" })!;
    const r = applyFlowBlock(SAMPLE_MODEL, { context: "Staffing", kind: "policy", name: p.name }, p.source.replace("joined_at: event.at", "joined_at: clock.now"));
    if (!r.ok) throw new Error(JSON.stringify(r));
    const ctxs = (parse(r.text) as { contexts: { name: string; policies?: { args: Record<string, string> }[] }[] }).contexts;
    expect(ctxs.find((c) => c.name === "Staffing")!.policies![0]!.args.joined_at).toBe("clock.now");
  });

  test("refused, with the line in the block: a syntax error, an unknown variable, another name", () => {
    const ref = { context: ctx, kind: "use_case" as const, name: "revoke_invitation" };
    const syntax = applyFlowBlock(SAMPLE_MODEL, ref, revoke.source.replace("    save invitation", "    save invitation {"));
    expect(syntax).toMatchObject({ ok: false, problems: [{ line: 5, code: "syntax" }] });
    const unknown = applyFlowBlock(SAMPLE_MODEL, ref, revoke.source.replace("    save invitation", "    save invitatio"));
    expect(unknown).toMatchObject({ ok: false, problems: [{ line: 5, code: "unknown-variable" }] });
    const renamed = applyFlowBlock(SAMPLE_MODEL, ref, revoke.source.replace("flow revoke_invitation", "flow revoke2"));
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error).toContain("名前と種類は変えられません");
    const two = applyFlowBlock(SAMPLE_MODEL, ref, revoke.source + "\n" + revoke.source);
    expect(two.ok).toBe(false);
  });

  test("a query's filters and order", () => {
    const ref = { context: ctx, kind: "query" as const, name: "search_invitations" };
    const q = flowBlock(SAMPLE_MODEL, ref)!;
    const r = applyFlowBlock(SAMPLE_MODEL, ref, q.source.replace(/  page[^\n]*\n|(\n\s*returns)/, (m, ret: string | undefined) => (ret ? `\n  page 50 max 200${ret}` : "  page 50 max 200\n")));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(diagrams(r.text).queries[0]!.items.some((i) => i.kind === "note" && i.text.includes("50 件ずつ（最大 200 件）"))).toBe(true);
  });
});
