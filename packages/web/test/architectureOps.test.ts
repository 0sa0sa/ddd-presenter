/** Operations of the アーキテクチャ tab: every applied edit leaves a valid model; invalid ones come back with diagnostics. */
import { describe, expect, test } from "bun:test";
import { deriveArchitecture, layoutArchitecture, placeArchitecture, archNodeSize, validateModelText, type ModelIR } from "@ddd/core";
import { generate } from "@ddd/generator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addContext,
  addExternalSystem,
  addRelationship,
  addSecurity,
  generatedFilesFor,
  OpHistory,
  removeRelationship,
  setDefaultRateLimit,
  setHttpApi,
  setRls,
  setSubdomain,
  setTarget,
  updateRelationship,
  upstreamEvents,
  type OpResult,
} from "../src/lib/architectureOps.ts";

const root = join(import.meta.dir, "../../..");
const PY = readFileSync(join(root, "examples/cleaning-platform/model.ddd.yaml"), "utf8");
const TS = readFileSync(join(root, "examples/cleaning-platform-ts/model.ddd.yaml"), "utf8");
const CONTEXT_MAP = readFileSync(join(root, "packages/generator/test/fixtures/context-map.ddd.yaml"), "utf8");
const QUERIES = readFileSync(join(root, "packages/generator/test/fixtures/queries.ddd.yaml"), "utf8");

const model = (text: string): ModelIR => validateModelText(text).model!;
const valid = (r: OpResult): string => {
  if (!r.ok) throw new Error(`${r.error}: ${r.diagnostics.map((d) => d.message).join(" | ")}`);
  const v = validateModelText(r.text);
  expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.text;
};
const refused = (r: OpResult, code?: string) => {
  expect(r.ok).toBe(false);
  if (!r.ok && code) expect(r.diagnostics.map((d) => d.code)).toContain(code);
};

describe("contexts", () => {
  test("add a context (with a subdomain) to both examples; names are checked", () => {
    for (const text of [PY, TS]) {
      const next = valid(addContext(text, model(text), "Billing", "generic"));
      expect(model(next).contexts.at(-1)).toMatchObject({ name: "Billing", subdomain: "generic" });
      // The architecture shows it at once.
      expect(deriveArchitecture(model(next)).system.elements.some((e) => e.id === "ctx:Billing")).toBe(true);
    }
    refused(addContext(PY, model(PY), "billing"));
    refused(addContext(PY, model(PY), "Staffing"));
  });

  test("set and clear a subdomain", () => {
    const set = valid(setSubdomain(PY, model(PY), "Staffing", "supporting"));
    expect(model(set).contexts[1]!.subdomain).toBe("supporting");
    const cleared = valid(setSubdomain(set, model(set), "Staffing", undefined));
    expect(model(cleared).contexts[1]!.subdomain).toBeUndefined();
  });
});

describe("relationships", () => {
  test("connect two contexts, edit and delete the relationship", () => {
    const base = valid(addContext(PY, model(PY), "Billing"));
    const added = valid(addRelationship(base, model(base), { upstream: "Staffing", downstream: "Billing", pattern: "conformist", events: ["StaffRegistered"], description: "給与の起点" }));
    expect(model(added).relationships.at(-1)).toMatchObject({ upstream: "Staffing", downstream: "Billing", pattern: "conformist", events: ["StaffRegistered"] });
    const i = model(added).relationships.length - 1;
    const edited = valid(updateRelationship(added, model(added), i, { upstream: "Staffing", downstream: "Billing", pattern: "anticorruption_layer", events: [] }));
    expect(model(edited).relationships[i]).toMatchObject({ pattern: "anticorruption_layer", events: [] });
    const removed = valid(removeRelationship(edited, model(edited), i));
    expect(model(removed).relationships).toHaveLength(1);
  });

  test("the validator's diagnostics come back for invalid relationships", () => {
    // A policy consumes CleaningStaff.InvitationAccepted through this relationship.
    refused(removeRelationship(PY, model(PY), 0), "missing-relationship");
    refused(addRelationship(PY, model(PY), { upstream: "Staffing", downstream: "CleaningStaff", pattern: "separate_ways", events: ["StaffRegistered"] }), "separate-ways-with-events");
    refused(addRelationship(PY, model(PY), { upstream: "Staffing", downstream: "CleaningStaff", pattern: "conformist", events: ["Nope"] }), "unknown-event");
    refused(addRelationship(PY, model(PY), { upstream: "CleaningStaff", downstream: "Staffing", pattern: "conformist", events: [] }));
    refused(addRelationship(PY, model(PY), { upstream: "Staffing", downstream: "Staffing", pattern: "conformist", events: [] }));
  });

  test("upstream events are the events the context emits", () => {
    expect(upstreamEvents(model(PY), "CleaningStaff")).toContain("InvitationAccepted");
    expect(upstreamEvents(model(PY), "Staffing")).toEqual(["StaffRegistered"]);
  });
});

describe("generation and security settings", () => {
  test("switch the target and the HTTP API", () => {
    const ts = valid(setTarget(PY, model(PY), "typescript"));
    expect(model(ts).generation.target).toBe("typescript");
    const api = valid(setHttpApi(ts, model(ts), true));
    expect(model(api).generation.typescript.api).toEqual({ basePath: "/api", client: "tanstack-query" });
    expect(deriveArchitecture(model(api)).containers.elements.some((e) => e.id === "ctr:http-api")).toBe(true);
    const off = valid(setHttpApi(TS, model(TS), false));
    expect(model(off).generation.typescript.api).toBeUndefined();
    expect(off).not.toContain("api: {");
  });

  test("RLS off is written as off; on removes the key (the default)", () => {
    const off = valid(setRls(PY, model(PY), false));
    expect(off).toContain("    rls: off\n");
    expect(model(off).security!.tenancy!.rls).toBe(false);
    const on = valid(setRls(off, model(off), true));
    expect(on).toBe(PY);
    refused(setRls(QUERIES, model(QUERIES), false));
  });

  test("the default rate limit; by: tenant needs tenancy", () => {
    const next = valid(setDefaultRateLimit(PY, model(PY), { requests: 120, per: "minute", by: "principal" }));
    expect(model(next).security!.rateLimits.default).toMatchObject({ requests: 120, per: "minute", by: "principal" });
    const none = valid(setDefaultRateLimit(next, model(next), undefined));
    expect(model(none).security!.rateLimits.default).toBeUndefined();
    const secured = valid(addSecurity(CONTEXT_MAP, model(CONTEXT_MAP), { role: "member" }));
    refused(setDefaultRateLimit(secured, model(secured), { requests: 60, per: "minute", by: "tenant" }), "tenancy-not-declared");
    refused(setDefaultRateLimit(CONTEXT_MAP, model(CONTEXT_MAP), { requests: 60, per: "minute", by: "ip" }));
  });

  test("adding security inserts a role, a bearer JWT and authorize everywhere (internal for policy-run use cases)", () => {
    for (const text of [CONTEXT_MAP, QUERIES]) {
      const next = valid(addSecurity(text, model(text), { role: "member", issuer: "https://id.example.com/" }));
      const m = model(next);
      expect(m.security!.roles).toEqual(["member"]);
      expect(m.security!.authentication!.scheme).toBe("bearer_jwt");
      for (const c of m.contexts) {
        for (const u of c.useCases) expect(u.authorize?.kind).toBe(c.policies.some((p) => p.run === u.name) ? "internal" : "principal");
        for (const a of c.aggregates) expect(a.authorize?.kind).toBe("principal");
        for (const q of c.queries) expect(q.authorize?.kind).toBe("principal");
      }
      expect(deriveArchitecture(m).containers.elements.some((e) => e.id === "ctr:security")).toBe(true);
    }
    refused(addSecurity(PY, model(PY), { role: "member" }));
  });

  test("an external system becomes an extension point of the context", () => {
    const next = valid(addExternalSystem(PY, model(PY), "Staffing", { name: "payroll_service", description: "給与システム" }));
    expect(model(next).contexts[1]!.extensionPoints[0]).toMatchObject({ name: "payroll_service", returns: "Boolean" });
    expect(deriveArchitecture(model(next)).system.elements.some((e) => e.id === "ext:Staffing.payroll_service")).toBe(true);
    refused(addExternalSystem(PY, model(PY), "CleaningStaff", { name: "is_blocked_email" }));
    refused(addExternalSystem(PY, model(PY), "CleaningStaff", { name: "Bad Name" }));
  });
});

describe("generated file links", () => {
  test("every element with code finds its files in both targets' output", () => {
    for (const text of [PY, TS]) {
      const r = validateModelText(text);
      const paths = generate(r.analysis!, text).files.map((f) => f.path);
      const a = deriveArchitecture(r.model!, r.analysis);
      for (const v of [a.system, a.containers, ...a.contexts]) {
        for (const e of v.elements) {
          if (!e.code?.length || e.kind === "adapter" || e.kind === "external") continue;
          expect([e.id, generatedFilesFor(e.code, paths).length > 0]).toEqual([e.id, true]);
        }
      }
      const files = generatedFilesFor([{ context: "CleaningStaff", area: "sql" }, { area: "security" }], paths);
      expect(files).toContain("sql/cleaning_staff.sql");
      expect(files.some((p) => /\/generated\/security\.(py|ts)$/.test(p))).toBe(true);
    }
  });
});

describe("undo and layout", () => {
  test("undo restores the text before the last operation unless the model was edited since", () => {
    const h = new OpHistory();
    const a = valid(setSubdomain(PY, model(PY), "Staffing", "core"));
    h.push(PY, a, "subdomain");
    expect(h.undo(a)).toEqual({ text: PY, label: "subdomain" });
    h.push(PY, a, "subdomain");
    expect(h.undo(a + "\n# hand edit")).toHaveProperty("error");
    expect(h.size).toBe(0);
  });

  test("a new context lands below the placed ones without overlapping", () => {
    const placed = layoutArchitecture(deriveArchitecture(model(PY)).system);
    const next = valid(addContext(PY, model(PY), "Billing"));
    const view = deriveArchitecture(model(next)).system;
    const pos = placeArchitecture(view, placed);
    const billing = pos["ctx:Billing"]!;
    for (const e of view.elements) {
      if (e.id === "ctx:Billing") continue;
      const p = pos[e.id]!;
      const s = archNodeSize(e);
      expect(billing.y >= p.y + s.h || billing.x >= p.x + s.w || billing.x + 240 <= p.x).toBe(true);
    }
  });
});
