/**
 * What the Connect layer serves (docs/09 §25), independent of the target language: the procedures (rpcs of the
 * model's protobuf contract) with their request fields, results and pages, the messages and enums they reach, and
 * field numbers exactly as the .proto writer (`protoFiles`, `ddd migrate --split`) numbers them.
 */
import {
  enumPrefix,
  planQuery,
  procedurePath,
  protoPackage,
  queryRpc,
  useCaseRpc,
  type Analysis,
  type ContextAnalysis,
  type QueryPlan,
  type Type,
  type UseCaseIR,
} from "@ddd/core";
import { servedOverHttp } from "@ddd/core";

export type CType =
  | { t: "string" | "int64" | "bool" | "timestamp" }
  | { t: "enum"; context: string; name: string }
  | { t: "message"; name: string }
  | { t: "list"; item: CType };

export interface CField {
  no: number;
  name: string;
  type: CType;
  optional: boolean;
}

export interface CProcedure {
  /** `/cleaning_staff.v1.CleaningStaffService/IssueInvitation` */
  path: string;
  ca: ContextAnalysis;
  kind: "useCase" | "query";
  useCase?: UseCaseIR;
  plan?: QueryPlan;
  request: CField[];
  /** Use cases: the result's type (undefined: none). */
  result?: CType;
  /** Queries: the full name of the page item message. */
  item?: string;
  /** Domain error codes that mean "not found" (the use case's load steps). */
  notFound: string[];
}

export interface CMessage {
  name: string;
  fields: CField[];
}

export interface CEnum {
  ca: ContextAnalysis;
  name: string;
  prefix: string;
  values: string[];
}

export interface ConnectPlan {
  procedures: CProcedure[];
  messages: CMessage[];
  enums: CEnum[];
}

/** Full name of a model message: `cleaning_staff.v1.EmailAddress`, `ordering.v1.Order.OrderLine`. */
function messageName(ca: ContextAnalysis, name: string): string {
  const owner = ca.ir.aggregates.find((a) => a.entities.some((e) => e.name === name));
  return `${protoPackage(ca.ir)}.${owner ? `${owner.name}.` : ""}${name}`;
}

function typeOf(ca: ContextAnalysis, t: Type, used: Set<string>): CType {
  switch (t.k) {
    case "optional":
      return typeOf(ca, t.inner, used);
    case "primitive":
      return { t: t.name === "Integer" ? "int64" : t.name === "Boolean" ? "bool" : t.name === "DateTime" ? "timestamp" : "string" };
    case "enum":
      used.add(`enum:${t.name}`);
      return { t: "enum", context: ca.ir.name, name: t.name };
    case "vo":
    case "entity":
    case "aggregate":
      used.add(`message:${t.name}`);
      return { t: "message", name: messageName(ca, t.name) };
    case "ref": {
      const ag = ca.ir.aggregates.find((a) => a.name === t.target);
      const id = ag ? ca.fieldTypes.get(ag.name)?.get(ag.identity) : undefined;
      return { t: id?.k === "primitive" && id.name === "Integer" ? "int64" : "string" };
    }
    case "list":
      return { t: "list", item: typeOf(ca, t.item, used) };
    default:
      return { t: "string" };
  }
}

function field(ca: ContextAnalysis, no: number, name: string, t: Type | undefined, used: Set<string>, optional?: boolean): CField {
  return { no, name, type: t ? typeOf(ca, t, used) : { t: "string" }, optional: optional ?? t?.k === "optional" };
}

function loadErrors(uc: UseCaseIR): string[] {
  const out: string[] = [];
  const walk = (steps: UseCaseIR["steps"]) => {
    for (const s of steps) {
      if (s.kind === "load" && s.notFound) out.push(s.notFound);
      if (s.kind === "if") {
        walk(s.then);
        walk(s.else);
      }
    }
  };
  walk(uc.steps);
  return out;
}

export function connectPlan(analysis: Analysis): ConnectPlan {
  const model = analysis.model;
  const procedures: CProcedure[] = [];
  const messages: CMessage[] = [];
  const enums: CEnum[] = [];
  for (const ca of analysis.contexts.values()) {
    const used = new Set<string>();
    for (const uc of ca.ir.useCases.filter(servedOverHttp)) {
      const request: CField[] = [];
      if (uc.authorize?.crossTenant && model.security?.tenancy) request.push({ no: 1, name: "tenant_id", type: { t: "string" }, optional: false });
      for (const f of uc.input) request.push(field(ca, request.length + 1, f.name, ca.fieldTypes.get(uc.command)?.get(f.name), used));
      const ret = ca.useCases.get(uc.name)?.returnType;
      const inner = ret?.k === "optional" ? ret.inner : ret;
      const result = inner && inner.k !== "null" && inner.k !== "duration" && inner.k !== "event" ? typeOf(ca, inner, used) : undefined;
      const codes = loadErrors(uc).map((e) => ca.ir.errors.find((x) => x.name === e)?.code ?? e);
      procedures.push({ path: procedurePath(ca.ir, useCaseRpc(uc)), ca, kind: "useCase", useCase: uc, request, ...(result ? { result } : {}), notFound: codes });
    }
    for (const q of ca.ir.queries) {
      const plan = planQuery(ca.ir, ca.fieldTypes, q, model.security);
      if (!plan) continue;
      const request = q.params.map((p, i) => field(ca, i + 1, p.name, plan.params.find((x) => x.field.name === p.name)?.type, used));
      if (plan.search) request.push({ no: request.length + 1, name: plan.search.ir.param, type: { t: "string" }, optional: true });
      request.push({ no: request.length + 1, name: "limit", type: { t: "int64" }, optional: true });
      request.push({ no: request.length + 1, name: "cursor", type: { t: "string" }, optional: true });
      const item = `${protoPackage(ca.ir)}.${queryRpc(q)}Response.Item`;
      const names = plan.aggregate.fields.map((f) => f.name);
      const returned = q.returns ? q.returns.filter((r) => names.includes(r)) : names;
      messages.push({ name: item, fields: returned.map((n, i) => field(ca, i + 1, n, ca.fieldTypes.get(plan.aggregate.name)?.get(n), used)) });
      procedures.push({ path: procedurePath(ca.ir, queryRpc(q)), ca, kind: "query", plan, request, item, notFound: [] });
    }
    // Messages the procedures reach, and the messages those reach.
    const done = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const key of [...used]) {
        if (!key.startsWith("message:") || done.has(key)) continue;
        done.add(key);
        changed = true;
        const name = key.slice("message:".length);
        const owner = ca.ir.valueObjects.find((v) => v.name === name) ?? ca.ir.aggregates.find((a) => a.name === name) ?? ca.ir.aggregates.flatMap((a) => a.entities).find((e) => e.name === name);
        if (owner) messages.push({ name: messageName(ca, name), fields: owner.fields.map((f, i) => field(ca, i + 1, f.name, ca.fieldTypes.get(name)?.get(f.name), used)) });
      }
    }
    for (const e of ca.ir.enums) if (used.has(`enum:${e.name}`)) enums.push({ ca, name: e.name, prefix: enumPrefix(e.name), values: e.values });
  }
  return { procedures, messages, enums };
}
