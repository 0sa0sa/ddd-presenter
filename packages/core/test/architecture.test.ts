/** Architecture model (C4-style levels), its Mermaid / SVG / draw.io renderings and the layered auto layout (docs/09 §23). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  architectureLevels,
  architectureMarkdown,
  architectureToDrawio,
  architectureToMermaid,
  architectureToSvg,
  architectureView,
  archNodeSize,
  deriveArchitecture,
  layoutArchitecture,
  parseDrawio,
  placeArchitecture,
  validateModelText,
  type ArchView,
  type Architecture,
  type Point,
} from "../src/index.ts";

const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const PY = read("examples/cleaning-platform/model.ddd.yaml");
const TS = read("examples/cleaning-platform-ts/model.ddd.yaml");
const FIXTURES = ["kitchen-sink", "context-map", "queries", "secure-queries", "security", "tenancy"].map((f) => read(`packages/generator/test/fixtures/${f}.ddd.yaml`));

function arch(text: string, lang?: "en" | "ja"): Architecture {
  const r = validateModelText(text);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return deriveArchitecture(r.model!, r.analysis, { lang });
}
const replaced = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`text does not contain ${from}`);
  return text.replace(from, to);
};
const el = (v: ArchView, id: string) => {
  const e = v.elements.find((x) => x.id === id);
  if (!e) throw new Error(`no ${id} in ${v.level}: ${v.elements.map((x) => x.id).join(", ")}`);
  return e;
};
const allViews = (a: Architecture) => architectureLevels(a).map((l) => architectureView(a, l)!);

/** Structural Mermaid checks: header, balanced subgraphs, safe ids, every edge endpoint declared, quotes balanced. */
function checkMermaid(src: string): void {
  const lines = src.trimEnd().split("\n");
  expect(lines[0]).toBe("flowchart TB");
  let depth = 0;
  const declared = new Set<string>();
  const RESERVED = new Set(["end", "graph", "subgraph", "flowchart", "class", "classDef", "style", "click", "direction"]);
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith("subgraph ")) {
      depth++;
      const id = /^subgraph ([A-Za-z0-9_]+)\["[^"]*"\]$/.exec(line)?.[1];
      expect(id).toBeDefined();
      declared.add(id!);
      continue;
    }
    if (line === "end") {
      depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
      continue;
    }
    if (line.startsWith("classDef ") || line.startsWith("class ")) continue;
    expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    const edge = /^([A-Za-z0-9_]+) (-->|-\.->)\|"[^"]*"\| ([A-Za-z0-9_]+)$/.exec(line);
    if (edge) {
      expect(declared.has(edge[1]!)).toBe(true);
      expect(declared.has(edge[3]!)).toBe(true);
      continue;
    }
    const node = /^([A-Za-z0-9_]+)(\(\[|\{\{|\[\[|\[\(|\[\/|\(|>|\[)"[^"]*"(\]\)|\}\}|\]\]|\)\]|\/\]|\)|\])$/.exec(line);
    expect(node, line).not.toBeNull();
    const id = node![1]!;
    expect(RESERVED.has(id)).toBe(false);
    expect(id).toMatch(/^n_[A-Za-z0-9_]+$/);
    expect(declared.has(id)).toBe(false);
    declared.add(id);
  }
  expect(depth).toBe(0);
}

function overlaps(view: ArchView, pos: Record<string, Point>): string[] {
  const boxes = view.elements.map((e) => ({ id: e.id, ...pos[e.id]!, ...archNodeSize(e) }));
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id} × ${b.id}`);
    }
  return out;
}

describe("system context (L1)", () => {
  test("contexts, the context map, actors, platform roles and external systems", () => {
    const a = arch(PY);
    const v = a.system;
    expect(el(v, "ctx:CleaningStaff").drill).toBe("context:CleaningStaff");
    expect(el(v, "ctx:CleaningStaff").path).toEqual(["contexts", 0]);
    expect(el(v, "ctx:CleaningStaff").badges).toContain("tenant");
    expect(el(v, "role:operator").badges).toContain("cross-tenant");
    expect(el(v, "ext:CleaningStaff.is_blocked_email").kind).toBe("external");
    expect(el(v, "person:清掃会社の管理者").kind).toBe("person");
    const rel = v.relations.find((r) => r.source === "ctx:CleaningStaff" && r.target === "ctx:Staffing")!;
    expect(rel.label).toContain("Customer/Supplier");
    expect(rel.label).toContain("InvitationAccepted");
    expect(rel.path).toEqual(["relationships", 0]);
    expect(v.relations.some((r) => r.source === "role:operator" && r.target === "ctx:CleaningStaff")).toBe(true);
  });

  test("a subdomain shows as a badge", () => {
    const v = arch(replaced(PY, "  - name: Staffing\n", "  - name: Staffing\n    subdomain: supporting\n")).system;
    expect(el(v, "ctx:Staffing").badges).toContain("supporting");
  });
});

describe("containers (L2)", () => {
  test("TypeScript with the HTTP API: web client, API, security, PostgreSQL (RLS, trigram), identity provider", () => {
    const v = arch(TS).containers;
    expect(el(v, "ctr:web-client").technology).toContain("TanStack Query");
    expect(el(v, "ctr:http-api").badges).toEqual(expect.arrayContaining(["/api", "JWT", "rate 60/min by tenant", "tenant"]));
    expect(el(v, "ctr:postgres").badges).toEqual(expect.arrayContaining(["RLS on", "trigram", "tenant_id"]));
    expect(el(v, "ctr:idp").badges).toContain("RS256");
    expect(el(v, "ctr:events").kind).toBe("container");
    const link = (s: string, t: string) => v.relations.find((r) => r.source === s && r.target === t);
    expect(link("ctr:web-client", "ctr:http-api")!.technology).toBe("HTTPS JSON, Bearer JWT");
    expect(link("ctr:security", "ctr:idp")!.technology).toBe("JWKS (HTTPS)");
    expect(link("ctr:app:CleaningStaff", "ctr:postgres")!.technology).toContain("RLS");
    expect(link("ctr:events", "ctr:app:Staffing")).toBeDefined();
    // Only callers of served use cases use the client (the policy-only actor does not).
    expect(v.elements.some((e) => e.id === "person:システム（ポリシー）")).toBe(false);
  });

  test("Python: no HTTP API or web client, but security with the PyJWT authenticator and the identity provider", () => {
    const v = arch(PY).containers;
    expect(v.elements.some((e) => e.id === "ctr:http-api" || e.id === "ctr:web-client")).toBe(false);
    expect(el(v, "ctr:security").technology).toBe("Python, PyJWT");
    expect(el(v, "ctr:idp")).toBeDefined();
  });

  test("RLS off, no security, no queries", () => {
    const off = arch(replaced(PY, "    isolation: row\n", "    isolation: row\n    rls: off\n")).containers;
    expect(el(off, "ctr:postgres").badges).toContain("RLS off");
    const plain = arch(FIXTURES[0]!).containers;
    expect(plain.elements.map((e) => e.id).filter((id) => /security|idp|postgres|http-api/.test(id))).toEqual([]);
    const queries = arch(FIXTURES[2]!).containers;
    expect(el(queries, "ctr:postgres").badges).not.toContain("RLS on");
    // TypeScript without the API does not verify JWTs (the authenticator lives in the HTTP layer).
    const noApi = arch(replaced(TS, "    api: { base_path: /api, client: tanstack-query }", "")).containers;
    expect(noApi.elements.some((e) => e.id === "ctr:idp" || e.id === "ctr:http-api")).toBe(false);
  });
});

describe("components (L3)", () => {
  test("aggregates with tenancy, use cases with authorize / rate limits, queries, ports and adapters", () => {
    const a = arch(TS);
    const v = architectureView(a, "context:CleaningStaff")!;
    expect(el(v, "cmp:CleaningStaff/agg:CleaningStaffInvitation").badges).toContain("tenant");
    const issue = el(v, "cmp:CleaningStaff/uc:issue_invitation");
    expect(issue.badges).toEqual(expect.arrayContaining(["perms: invitation.issue", "rate 10/min by tenant"]));
    expect(issue.path).toEqual(["contexts", 0, "use_cases", 0]);
    expect(el(v, "cmp:CleaningStaff/uc:inspect_invitation").badges).toContain("cross-tenant");
    expect(el(v, "cmp:CleaningStaff/query:search_invitations").badges).toEqual(expect.arrayContaining(["trigram", "page 20/100", "perms: invitation.list"]));
    for (const port of ["CleaningStaffInvitationRepository", "SearchInvitationsReader", "Extensions", "Clock", "IdGenerator", "CrossTenantAudit"]) expect(el(v, `cmp:CleaningStaff/port:${port}`).kind).toBe("port");
    for (const adapter of ["http", "memory", "postgres", "extensions"]) expect(el(v, `cmp:CleaningStaff/adapter:${adapter}`).kind).toBe("adapter");
    expect(v.relations.some((r) => r.source === "cmp:CleaningStaff/uc:issue_invitation" && r.target === "cmp:CleaningStaff/port:Extensions" && r.label === "is_blocked_email")).toBe(true);
    const staffing = architectureView(a, "context:Staffing")!;
    expect(el(staffing, "ctx:CleaningStaff").drill).toBe("context:CleaningStaff");
    expect(staffing.relations.some((r) => r.source === "ctx:CleaningStaff" && r.target === "cmp:Staffing/policy:register_staff_on_acceptance" && r.label === "InvitationAccepted")).toBe(true);
    expect(staffing.elements.some((e) => e.id === "cmp:Staffing/adapter:postgres")).toBe(false);
  });

  test("an anticorruption layer adds the translator port", () => {
    const a = arch(FIXTURES[1]!);
    const payroll = architectureView(a, "context:Payroll")!;
    expect(el(payroll, "cmp:Payroll/port:StaffingTranslator").badges).toContain("ACL");
    expect(payroll.relations.some((r) => r.source === "cmp:Payroll/adapter:extensions" && r.target === "cmp:Payroll/port:StaffingTranslator")).toBe(true);
    expect(a.system.relations.find((r) => r.source === "ctx:Staffing" && r.target === "ctx:Payroll")!.label).toContain("Anticorruption layer");
    // A policy on the context's own event is fed by the emitting aggregate.
    const staffing = architectureView(a, "context:Staffing")!;
    expect(staffing.relations.some((r) => r.source === "cmp:Staffing/agg:StaffMember" && r.target === "cmp:Staffing/policy:welcome_registered_staff")).toBe(true);
  });
});

describe("stability", () => {
  test("deterministic, unique ids, relations between known elements, same ids in Japanese", () => {
    for (const text of [PY, TS, ...FIXTURES]) {
      const a = arch(text);
      expect(arch(text)).toEqual(a);
      const ja = arch(text, "ja");
      for (const v of allViews(a)) {
        const ids = v.elements.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(v.relations.map((r) => r.id)).size).toBe(v.relations.length);
        for (const r of v.relations) expect(ids.includes(r.source) && ids.includes(r.target)).toBe(true);
        expect(architectureView(ja, v.level)!.elements.map((e) => e.id)).toEqual(ids);
      }
    }
  });

  test("ids survive unrelated edits and the IR alone (no analysis) gives the same picture", () => {
    const a = arch(PY);
    const b = arch(replaced(PY, "description: 清掃スタッフの招待と受諾を扱うサンプルモデル", "description: changed"));
    expect(allViews(b).map((v) => v.elements.map((e) => e.id))).toEqual(allViews(a).map((v) => v.elements.map((e) => e.id)));
    const r = validateModelText(TS);
    expect(deriveArchitecture(r.model!)).toEqual(deriveArchitecture(r.model!, r.analysis));
  });
});

describe("Mermaid and ARCHITECTURE.md", () => {
  test("every view of every fixture is structurally valid Mermaid", () => {
    for (const text of [PY, TS, ...FIXTURES]) for (const v of allViews(arch(text))) checkMermaid(architectureToMermaid(v));
  });

  test("labels escape the characters Mermaid parses", () => {
    const a = arch(replaced(PY, "description: 清掃スタッフの招待・受諾・取り消しを扱う", 'description: "a \\"quoted\\" <b>#1</b>"'));
    const md = architectureToMermaid(a.system);
    checkMermaid(md);
    expect(md).not.toContain("<b>#1");
  });

  test("the markdown has L1, L2 and one L3 per context", () => {
    const md = architectureMarkdown(arch(PY));
    expect(md.startsWith('<!-- Generated by DDD Presenter from model "cleaning-platform". DO NOT EDIT. -->')).toBe(true);
    expect(md.match(/^```mermaid$/gm)).toHaveLength(4);
    expect(md).toContain("## 1. System context");
    expect(md).toContain("## 2. Containers");
    expect(md).toContain("## 3.1 Components of CleaningStaff");
    expect(md).toContain("## 3.2 Components of Staffing");
    expect(md.endsWith("\n") && !md.endsWith("\n\n")).toBe(true);
  });
});

describe("layout and exports", () => {
  test("auto layout never overlaps boxes", () => {
    for (const text of [PY, TS, ...FIXTURES]) for (const v of allViews(arch(text))) expect(overlaps(v, layoutArchitecture(v))).toEqual([]);
  });

  test("saved positions are kept; new elements go below them without overlapping", () => {
    const v = arch(TS).containers;
    const auto = layoutArchitecture(v);
    const saved: Record<string, Point> = { "ctr:http-api": { x: 5000, y: -300 }, "ctr:web-client": { x: 5300, y: -300 } };
    const pos = placeArchitecture(v, saved);
    expect(pos["ctr:http-api"]).toEqual({ x: 5000, y: -300 });
    expect(Object.keys(pos).sort()).toEqual(Object.keys(auto).sort());
    expect(overlaps(v, pos)).toEqual([]);
    expect(placeArchitecture(v, {})).toEqual(auto);
  });

  test("SVG and draw.io exports contain every element; draw.io reads back", () => {
    const v = arch(TS).containers;
    const pos = layoutArchitecture(v);
    const svg = architectureToSvg(v, pos);
    expect(svg.startsWith("<svg")).toBe(true);
    for (const e of v.elements) expect(svg).toContain(e.label.replace(/&/g, "&amp;"));
    const drawio = architectureToDrawio(v, pos);
    const parsed = parseDrawio(drawio);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.pages[0]!.shapes.length).toBe(v.elements.length + v.groups.length);
      expect(parsed.pages[0]!.edges.length).toBe(v.relations.length);
    }
  });
});
