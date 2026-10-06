/**
 * Read side of a bounded context (`queries:`): list / search / paging over one aggregate, plus the relational
 * mapping (one table per aggregate) the generated PostgreSQL code and DDL share. Kept in its own module so the
 * rest of the core only needs one hook each (IR field, parse, validate, language).
 *
 * Design and sources: docs/09 §19; DSL: docs/10 §10; contract: docs/05 §9.
 */
import type { DiagnosticBag, Path } from "./diagnostics.ts";
import type { AggregateIR, AuthorizeIR, ContextIR, FieldIR, RateLimitIR, ScenarioPrincipalIR, SecurityIR } from "./ir.ts";
import type { Reader } from "./parse.ts";
import { assignable, closest, resolveType, sameType, T, typeToString, type Type } from "./types.ts";
import { checkRateLimitUse, checkRoles, principalMembers, scenarioPrincipal } from "./security.ts";

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

interface Located {
  path: Path;
}

/** Comparison of a filter: `field <op> param` (or a literal `value`). */
export const QUERY_OPS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

/** How the search parameter matches: pg_trgm similarity, case-insensitive prefix, or case-insensitive equality. */
export const SEARCH_MODES = ["trigram", "prefix", "exact"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Pseudo field of `order_by`: the search score (trigram similarity), highest first. */
export const RELEVANCE = "relevance";

/** Defaults of `page:` and `search.min_similarity` (pg_trgm's default `similarity_threshold` is 0.3). */
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE_LIMIT = 1000;
export const DEFAULT_MIN_SIMILARITY = 0.3;
/** pg_trgm's default `pg_trgm.similarity_threshold`: the GIN index prefilter (`%`) is only exact at or above it. */
export const PG_TRGM_DEFAULT_THRESHOLD = 0.3;
/** Longest accepted search text (trigram extraction is linear, but there is no reason to accept megabytes). */
export const SEARCH_MAX_LENGTH = 200;

/** HTTP query-string names the generated API reserves next to the parameters. */
export const RESERVED_QUERY_PARAMS = ["cursor", "limit"] as const;

export interface QueryFilterIR extends Located {
  /** Field path of the aggregate: `status`, `email.value` (through value objects). */
  field: string;
  op: QueryOp;
  /** Parameter compared with; an optional parameter that is absent disables the filter. */
  param?: string;
  /** Literal compared with (instead of a parameter): the filter always applies. */
  value?: unknown;
  /**
   * Member of the authenticated principal compared with (`id` or a declared claim, `security`): the filter always
   * applies and scopes the rows to the caller (a missing optional claim is NotAuthorized, never "no filter").
   */
  principal?: string;
}

export interface QuerySearchIR extends Located {
  /** Name of the (optional String) search parameter, e.g. `q`. */
  param: string;
  /** String field paths searched (a row matches when any of them matches). */
  fields: string[];
  mode: SearchMode;
  /** trigram only: rows below this similarity (0 < x ≤ 1) do not match. */
  minSimilarity: number;
}

export interface QueryOrderIR extends Located {
  /** Field path, or `relevance`. */
  field: string;
  direction: "asc" | "desc";
}

export interface QueryScenarioIR extends Located {
  name: string;
  description?: string;
  given: { aggregates: { type?: string; fields: Record<string, unknown>; path: Path }[]; principal?: ScenarioPrincipalIR; path: Path };
  when: { params: Record<string, unknown>; limit?: number; pages: number; path: Path };
  then: { items?: unknown[]; nextCursor?: "present" | "absent"; path: Path };
}

export interface QueryIR extends Located {
  name: string;
  description?: string;
  /** Aggregate the query reads. */
  from: string;
  /** Typed parameters (optional unless `required: true`). */
  params: FieldIR[];
  where: QueryFilterIR[];
  search?: QuerySearchIR;
  /** Declared order; the identity is appended as the tie-breaker. */
  orderBy: QueryOrderIR[];
  page: { size: number; maxSize: number; path: Path };
  /** Projection (top-level fields of the aggregate); undefined = every field. */
  returns?: string[];
  scenarios: QueryScenarioIR[];
  /** Who may run it (`authorize`: public / authenticated / roles); required once `security` is declared. */
  authorize?: AuthorizeIR;
  /** Rate limit of its HTTP endpoint (`rate_limit`); `"none"` opts out of `security.rate_limits.default`. */
  rateLimit?: RateLimitIR | "none";
}

// ---------------------------------------------------------------------------
// Parsing (called from parse.ts with its structural reader)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type ReadFields = (r: Reader, o: Obj, key: string, path: Path) => FieldIR[];
/** The parser's readers of `authorize` / `rate_limit` and `given.principal` (shared with use cases). */
export interface QueryReaders {
  fields: ReadFields;
  access: (r: Reader, o: Obj, path: Path) => { authorize?: AuthorizeIR; rateLimit?: RateLimitIR | "none" };
  principal: (r: Reader, given: Obj, path: Path) => ScenarioPrincipalIR | undefined;
}

export const QUERY_KEYS = ["name", "description", "from", "authorize", "rate_limit", "params", "where", "search", "order_by", "page", "returns", "scenarios"] as const;

export function readQueries(r: Reader, context: Obj, path: Path, readers: QueryReaders): QueryIR[] {
  return r.list(context, "queries", path).flatMap(({ value, path: qp }) => readQuery(r, value, qp, readers) ?? []);
}

function intValue(r: Reader, o: Obj, key: string, path: Path, fallback: number): number {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  r.bag.error("invalid-shape", `"${key}" must be an integer`, [...path, key]);
  return fallback;
}

function readQuery(r: Reader, value: unknown, path: Path, readers: QueryReaders): QueryIR | undefined {
  const o = r.obj(value, path, "query");
  if (!o) return undefined;
  r.keys(o, QUERY_KEYS, path, "query");
  const name = r.str(o, "name", path, true);
  const from = r.str(o, "from", path, true);
  if (!name || !from) return undefined;
  const where = r.list(o, "where", path).flatMap(({ value: wv, path: wp }) => {
    const wo = r.obj(wv, wp, "filter");
    if (!wo) return [];
    r.keys(wo, ["field", "op", "param", "value", "principal"], wp, "filter");
    const field = r.str(wo, "field", wp, true);
    const op = r.str(wo, "op", wp, false) ?? "eq";
    if (!(QUERY_OPS as readonly string[]).includes(op)) {
      r.bag.error("invalid-value", `Unknown filter operator "${op}"`, [...wp, "op"], { hint: `Use one of ${QUERY_OPS.join(", ")}` });
    }
    if (!field) return [];
    const filter: QueryFilterIR = { field, op: (QUERY_OPS as readonly string[]).includes(op) ? (op as QueryOp) : "eq", path: wp };
    const param = r.str(wo, "param", wp, false);
    if (param !== undefined) filter.param = param;
    if ("value" in wo) filter.value = wo.value;
    const principal = r.str(wo, "principal", wp, false);
    if (principal !== undefined) filter.principal = principal;
    return [filter];
  });
  let search: QuerySearchIR | undefined;
  if (o.search !== undefined && o.search !== null) {
    const sp = [...path, "search"];
    const so = r.obj(o.search, sp, "search");
    if (so) {
      r.keys(so, ["param", "fields", "mode", "min_similarity"], sp, "search");
      const param = r.str(so, "param", sp, false) ?? "q";
      const mode = r.str(so, "mode", sp, false) ?? "trigram";
      if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
        r.bag.error("invalid-value", `Unknown search mode "${mode}"`, [...sp, "mode"], { hint: `Use one of ${SEARCH_MODES.join(", ")}` });
      }
      const ms = so.min_similarity;
      let minSimilarity = DEFAULT_MIN_SIMILARITY;
      if (ms !== undefined && ms !== null) {
        if (typeof ms === "number" && Number.isFinite(ms)) minSimilarity = ms;
        else r.bag.error("invalid-shape", '"min_similarity" must be a number', [...sp, "min_similarity"]);
      }
      search = { param, fields: r.strList(so, "fields", sp), mode: (SEARCH_MODES as readonly string[]).includes(mode) ? (mode as SearchMode) : "trigram", minSimilarity, path: sp };
      if (ms !== undefined && mode !== "trigram") {
        r.bag.error("invalid-value", '"min_similarity" applies to mode: trigram only', [...sp, "min_similarity"], { hint: "Remove it, or use mode: trigram" });
      }
    }
  }
  const orderBy = r.list(o, "order_by", path).flatMap(({ value: ov, path: op }) => {
    if (typeof ov === "string") return [{ field: ov, direction: ov === RELEVANCE ? ("desc" as const) : ("asc" as const), path: op }];
    const oo = r.obj(ov, op, "order");
    if (!oo) return [];
    r.keys(oo, ["field", "direction"], op, "order");
    const field = r.str(oo, "field", op, true);
    const direction = r.str(oo, "direction", op, false) ?? (field === RELEVANCE ? "desc" : "asc");
    if (direction !== "asc" && direction !== "desc") {
      r.bag.error("invalid-value", `direction must be "asc" or "desc"`, [...op, "direction"]);
    }
    if (!field) return [];
    return [{ field, direction: direction === "desc" ? ("desc" as const) : ("asc" as const), path: op }];
  });
  const pp = [...path, "page"];
  const po = o.page === undefined || o.page === null ? {} : r.obj(o.page, pp, "page") ?? {};
  r.keys(po, ["size", "max_size"], pp, "page");
  const size = intValue(r, po, "size", pp, DEFAULT_PAGE_SIZE);
  const page = { size, maxSize: intValue(r, po, "max_size", pp, Math.max(DEFAULT_MAX_PAGE_SIZE, size)), path: pp };
  // Parameters are optional unless `required: true` (an absent optional parameter disables its filters).
  const required = new Set(
    (Array.isArray(o.params) ? o.params : []).flatMap((p: unknown) => (p !== null && typeof p === "object" && (p as Obj).required === true ? [String((p as Obj).name)] : [])),
  );
  const query: QueryIR = {
    name,
    description: r.str(o, "description", path, false),
    from,
    params: readers.fields(r, o, "params", path).map((f) => ({ ...f, required: required.has(f.name) })),
    where,
    orderBy,
    page,
    scenarios: r.list(o, "scenarios", path).flatMap(({ value: sv, path: sp }) => readQueryScenario(r, sv, sp, readers) ?? []),
    path,
    ...readers.access(r, o, path),
  };
  if (search) query.search = search;
  if (o.returns !== undefined && o.returns !== null) query.returns = r.strList(o, "returns", path);
  return query;
}

function readQueryScenario(r: Reader, value: unknown, path: Path, readers: QueryReaders): QueryScenarioIR | undefined {
  const o = r.obj(value, path, "scenario");
  if (!o) return undefined;
  r.keys(o, ["name", "description", "given", "when", "then"], path, "scenario");
  const name = r.str(o, "name", path, true);
  if (!name) return undefined;
  const gp = [...path, "given"];
  const go = o.given === undefined || o.given === null ? {} : r.obj(o.given, gp, "given") ?? {};
  r.keys(go, ["aggregates", "principal"], gp, "given");
  const principal = readers.principal(r, go, gp);
  const aggregates = r.list(go, "aggregates", gp).flatMap(({ value: av, path: ap }) => {
    const ao = r.obj(av, ap, "given aggregate");
    if (!ao) return [];
    r.keys(ao, ["type", "fields"], ap, "given aggregate");
    const type = r.str(ao, "type", ap, false);
    return [{ ...(type ? { type } : {}), fields: r.dataMap(ao, "fields", ap), path: [...ap, "fields"] }];
  });
  const wp = [...path, "when"];
  const wo = o.when === undefined || o.when === null ? {} : r.obj(o.when, wp, "when") ?? {};
  r.keys(wo, ["params", "limit", "pages"], wp, "when");
  const when: QueryScenarioIR["when"] = { params: r.dataMap(wo, "params", wp), pages: intValue(r, wo, "pages", wp, 1), path: wp };
  if (wo.limit !== undefined && wo.limit !== null) when.limit = intValue(r, wo, "limit", wp, 1);
  const tp = [...path, "then"];
  if (o.then === undefined) r.bag.error("missing-key", 'Missing required key "then"', path);
  const to = o.then === undefined || o.then === null ? {} : r.obj(o.then, tp, "then") ?? {};
  r.keys(to, ["items", "next_cursor"], tp, "then");
  const then: QueryScenarioIR["then"] = { path: tp };
  if (to.items !== undefined) {
    if (Array.isArray(to.items)) then.items = to.items;
    else r.bag.error("invalid-shape", '"items" must be a list', [...tp, "items"]);
  }
  const nc = r.str(to, "next_cursor", tp, false);
  if (nc !== undefined) {
    if (nc === "present" || nc === "absent") then.nextCursor = nc;
    else r.bag.error("invalid-value", 'next_cursor must be "present" or "absent"', [...tp, "next_cursor"]);
  }
  return { name, description: r.str(o, "description", path, false), given: { aggregates, ...(principal ? { principal } : {}), path: gp }, when, then, path };
}

// ---------------------------------------------------------------------------
// Relational mapping: one table per aggregate
// ---------------------------------------------------------------------------

/** PostgreSQL column types the mapping uses. */
export type SqlType = "text" | "bigint" | "numeric" | "boolean" | "uuid" | "timestamptz" | "date" | "jsonb";

export interface ColumnIR {
  /** Column name: the snake_case field path joined with `_` (`email_value`). */
  name: string;
  /** Field path from the aggregate (`["email", "value"]`). */
  path: string[];
  /** Model type of the value (optional unwrapped; for jsonb the whole field type). */
  type: Type;
  nullable: boolean;
  sql: SqlType;
  /** Enum values (text column with a CHECK constraint). */
  enumValues?: string[];
}

export interface TableIR {
  /** PostgreSQL schema: the context in snake_case. */
  schema: string;
  /** Table: the aggregate in snake_case. */
  name: string;
  aggregate: string;
  identity: ColumnIR;
  /** Every column except `version`, in field order (the identity among them). */
  columns: ColumnIR[];
}

/** Name of the optimistic-locking column every table has. */
export const VERSION_COLUMN = "version";
/** PostgreSQL identifiers are truncated beyond this many bytes. */
export const MAX_IDENTIFIER_LENGTH = 63;

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

/** SQL type of a scalar model type (undefined for value objects, lists, entities). */
export function scalarSqlType(ctx: ContextIR, fieldTypes: Map<string, Map<string, Type>>, t: Type): SqlType | undefined {
  switch (t.k) {
    case "primitive":
      return ({ String: "text", Integer: "bigint", Decimal: "numeric", Boolean: "boolean", UUID: "uuid", DateTime: "timestamptz", Date: "date" } as const)[t.name];
    case "enum":
      return "text";
    case "ref": {
      const target = ctx.aggregates.find((a) => a.name === t.target);
      const idType = target ? fieldTypes.get(target.name)?.get(target.identity) : undefined;
      return idType && idType.k !== "ref" ? (scalarSqlType(ctx, fieldTypes, idType) ?? "uuid") : "uuid";
    }
    default:
      return undefined;
  }
}

/**
 * Columns of the aggregate's table. Scalars map to their SQL type; a required value object is flattened into one
 * column per field (`email.value` → `email_value`, recursively); an optional value object, a list or an entity is
 * one jsonb column holding its JSON form (model field names). Enums are text with a CHECK constraint.
 */
export function tableOf(ctx: ContextIR, fieldTypes: Map<string, Map<string, Type>>, aggregate: AggregateIR): TableIR {
  const columns: ColumnIR[] = [];
  const enumValues = (t: Type) => (t.k === "enum" ? ctx.enums.find((e) => e.name === t.name)?.values : undefined);
  const visit = (path: string[], t: Type, nullable: boolean) => {
    if (t.k === "optional") {
      if (t.inner.k === "vo") columns.push({ name: path.join("_"), path, type: t.inner, nullable: true, sql: "jsonb" });
      else visit(path, t.inner, true);
      return;
    }
    if (t.k === "vo") {
      for (const [f, ft] of fieldTypes.get(t.name) ?? new Map<string, Type>()) visit([...path, f], ft, nullable);
      return;
    }
    const sql = scalarSqlType(ctx, fieldTypes, t);
    const values = enumValues(t);
    columns.push({ name: path.join("_"), path, type: t, nullable, sql: sql ?? "jsonb", ...(values ? { enumValues: values } : {}) });
  };
  for (const [f, t] of fieldTypes.get(aggregate.name) ?? new Map<string, Type>()) visit([f], t, false);
  const identity = columns.find((c) => c.path.length === 1 && c.path[0] === aggregate.identity) ?? { name: aggregate.identity, path: [aggregate.identity], type: T.UUID, nullable: false, sql: "uuid" as const };
  return { schema: snake(ctx.name), name: snake(aggregate.name), aggregate: aggregate.name, identity, columns };
}

/** The column a field path maps to, or why it maps to none. */
export function columnAt(table: TableIR, path: string[]): { column: ColumnIR } | { error: "json" | "none" } {
  const exact = table.columns.find((c) => c.path.length === path.length && c.path.every((p, i) => p === path[i]));
  if (exact) return exact.sql === "jsonb" ? { error: "json" } : { column: exact };
  const inside = table.columns.find((c) => c.sql === "jsonb" && c.path.length < path.length && c.path.every((p, i) => p === path[i]));
  return { error: inside ? "json" : "none" };
}

// ---------------------------------------------------------------------------
// Plan: what the generators need, resolved
// ---------------------------------------------------------------------------

export interface QueryKeyPlan {
  /** Undefined for the relevance key. */
  column?: ColumnIR;
  relevance: boolean;
  direction: "asc" | "desc";
}

export interface QueryPlan {
  query: QueryIR;
  aggregate: AggregateIR;
  table: TableIR;
  /** Declared parameters with their types (optional wrapped unless required). */
  params: { field: FieldIR; type: Type }[];
  filters: { filter: QueryFilterIR; column: ColumnIR }[];
  search?: { ir: QuerySearchIR; columns: ColumnIR[]; mode: SearchMode; minSimilarity: number; prefilter: boolean };
  /** Order keys; the identity is the last one (appended unless declared last). */
  keys: QueryKeyPlan[];
  /** Fields of the projection, in declaration order. */
  returns: string[];
}

/** Resolves a validated query. Returns undefined if something does not resolve (the model has errors). */
export function planQuery(ctx: ContextIR, fieldTypes: Map<string, Map<string, Type>>, q: QueryIR): QueryPlan | undefined {
  const aggregate = ctx.aggregates.find((a) => a.name === q.from);
  if (!aggregate) return undefined;
  const table = tableOf(ctx, fieldTypes, aggregate);
  const col = (field: string) => {
    const r = columnAt(table, field.split("."));
    return "column" in r ? r.column : undefined;
  };
  const params: QueryPlan["params"] = [];
  for (const p of q.params) {
    const r = resolveType(p.type, { context: ctx });
    if (!r.ok) return undefined;
    params.push({ field: p, type: p.required ? r.type : { k: "optional", inner: r.type } });
  }
  const filters: QueryPlan["filters"] = [];
  for (const f of q.where) {
    const column = col(f.field);
    if (!column) return undefined;
    filters.push({ filter: f, column });
  }
  let search: QueryPlan["search"];
  if (q.search) {
    const columns = q.search.fields.map(col);
    if (columns.some((c) => !c)) return undefined;
    search = {
      ir: q.search,
      columns: columns as ColumnIR[],
      mode: q.search.mode,
      minSimilarity: q.search.minSimilarity,
      prefilter: q.search.mode !== "trigram" || q.search.minSimilarity >= PG_TRGM_DEFAULT_THRESHOLD,
    };
  }
  const keys: QueryKeyPlan[] = [];
  for (const o of q.orderBy) {
    if (o.field === RELEVANCE) {
      keys.push({ relevance: true, direction: "desc" });
      continue;
    }
    const column = col(o.field);
    if (!column) return undefined;
    keys.push({ column, relevance: false, direction: o.direction });
  }
  const last = keys[keys.length - 1];
  if (!last?.column || last.column.name !== table.identity.name) {
    keys.push({ column: table.identity, relevance: false, direction: last?.direction ?? "asc" });
  }
  const returns = q.returns ?? [...(fieldTypes.get(aggregate.name)?.keys() ?? [])];
  return { query: q, aggregate, table, params, filters, ...(search ? { search } : {}), keys, returns };
}

// ---------------------------------------------------------------------------
// Validation (called from the context validator)
// ---------------------------------------------------------------------------

/** What the query checks need from the context validator (structurally satisfied by it). */
export interface QueryValidationHost {
  readonly bag: DiagnosticBag;
  readonly ctx: ContextIR;
  readonly fieldTypes: Map<string, Map<string, Type>>;
  readonly typeNames: Map<string, { kind: string; path: Path }>;
  el(...parts: (string | undefined)[]): string;
  checkSnake(name: string, what: string, path: Path, element?: string): void;
  checkValue(value: unknown, t: Type, path: Path, el: string, aggregate?: string): void;
  checkRecord(rec: Record<string, unknown>, fields: Map<string, Type>, path: Path, el: string, owner: string, complete: boolean): void;
  checkFields(ownerName: string, fields: FieldIR[], opts: { aggregate?: string; element: string }): Map<string, Type>;
  /** `security` of the model (undefined when not declared). */
  readonly security?: SecurityIR;
  /** Checks a scenario's `given.principal` (declared roles, id and claim types). */
  checkGivenPrincipal(p: ScenarioPrincipalIR, el: string): void;
}

/** Names of the generated classes / types of a query (`SearchInvitations` + suffix). */
export function queryClassNames(name: string): string[] {
  const base = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
  return ["Query", "Reader", "Item", "Input", "Page", "Params", "ItemSchema", "InputSchema", "ItemJson", "PageJson"].map((s) => base + s);
}

/** Owner key of a query's parameters in the field type table. */
export function queryParamsOwner(name: string): string {
  return `query:${name}`;
}

/** Test / module names the generators already use per context; a query cannot be named like them. */
const RESERVED_QUERY_NAMES = new Set(["policies", "invariants", "api", "persistence", "queries", "testing", "rows", "postgres"]);

const ORDERABLE_FOR_RANGE = new Set(["String", "Integer", "Decimal", "DateTime", "Date"]);

function baseOf(t: Type): Type {
  return t.k === "optional" ? t.inner : t;
}

export function checkQueries(h: QueryValidationHost): void {
  const ctx = h.ctx;
  const queries = ctx.queries ?? [];
  if (!queries.length) return;
  const seen = new Set<string>();
  const taken = new Map<string, string>([
    ...ctx.useCases.map((u) => [u.name, `use case ${u.name}`] as [string, string]),
    ...ctx.aggregates.map((a) => [snake(a.name), `aggregate ${a.name}`] as [string, string]),
  ]);
  for (const q of queries) {
    const el = h.el(`query ${q.name}`);
    h.checkSnake(q.name, "Query name", [...q.path, "name"], el);
    if (seen.has(q.name)) h.bag.error("duplicate-name", `Duplicate query "${q.name}"`, [...q.path, "name"], { element: el });
    seen.add(q.name);
    const clash = taken.get(q.name);
    if (clash) {
      h.bag.error("duplicate-name", `Query "${q.name}" has the same name as ${clash} (their generated tests would share a file)`, [...q.path, "name"], { element: el, hint: "Rename the query, e.g. search_" + q.name });
    }
    const readPolicy = h.security ? ctx.aggregates.find((a) => `read_${snake(a.name)}` === q.name) : undefined;
    if (readPolicy) {
      h.bag.error("duplicate-name", `Query "${q.name}" has the name of the rate limit of reading ${readPolicy.name} by identity (they would share a bucket)`, [...q.path, "name"], { element: el, hint: "Rename the query, e.g. list_" + snake(readPolicy.name) });
    }
    if (RESERVED_QUERY_NAMES.has(q.name)) {
      h.bag.error("reserved-name", `"${q.name}" is used by generated modules of the context`, [...q.path, "name"], { element: el, hint: "Rename the query" });
    }
    for (const cls of queryClassNames(q.name)) {
      const prev = h.typeNames.get(cls);
      if (prev) h.bag.error("duplicate-name", `The generated ${cls} clashes with the ${prev.kind} ${cls}`, [...q.path, "name"], { element: el, hint: "Rename the query or the type" });
    }
    checkQuery(h, q, el);
  }
  // Every aggregate of a context with queries gets a table: its columns must not clash.
  for (const ag of ctx.aggregates) checkTable(h, ag);
}

function checkTable(h: QueryValidationHost, ag: AggregateIR): void {
  const table = tableOf(h.ctx, h.fieldTypes, ag);
  const el = h.el(ag.name);
  const byName = new Map<string, string>();
  for (const c of table.columns) {
    const field = c.path.join(".");
    const prev = byName.get(c.name);
    if (prev) {
      h.bag.error("column-clash", `Fields ${prev} and ${field} of ${ag.name} both map to the column "${c.name}"`, ag.path, { element: el, hint: "Rename one of the fields (value object fields are flattened as <field>_<subfield>)" });
    }
    byName.set(c.name, field);
    if (c.name === VERSION_COLUMN) {
      h.bag.error("reserved-name", `Field ${field} of ${ag.name} maps to the column "version", which holds the optimistic-locking version`, ag.path, { element: el, hint: "Rename the field, e.g. revision" });
    }
    if (c.name.length > MAX_IDENTIFIER_LENGTH) {
      h.bag.error("invalid-name", `Column "${c.name}" of ${ag.name} is longer than PostgreSQL's ${MAX_IDENTIFIER_LENGTH}-byte identifier limit`, ag.path, { element: el, hint: "Use shorter field names" });
    }
  }
}

function checkQuery(h: QueryValidationHost, q: QueryIR, el: string): void {
  const ctx = h.ctx;
  const ag = ctx.aggregates.find((a) => a.name === q.from);
  if (q.description !== undefined && !q.description.trim()) h.bag.warning("empty-description", "description is empty", [...q.path, "description"], { element: el });
  // Parameters.
  const params = h.checkFields(queryParamsOwner(q.name), q.params, { element: el });
  for (const p of q.params) {
    const t = params.get(p.name);
    if (!t) continue;
    const b = baseOf(t);
    if (!(b.k === "primitive" || b.k === "enum" || b.k === "ref")) {
      h.bag.error("invalid-type", `Query parameter "${p.name}" must be a primitive, an enum or a Ref, got ${typeToString(b)}`, [...p.path, "type"], { element: el, hint: "Filter on a value object's field path instead (e.g. field: email.value with a String parameter)" });
    }
    if ((RESERVED_QUERY_PARAMS as readonly string[]).includes(p.name)) {
      h.bag.error("reserved-name", `"${p.name}" is reserved for paging (the HTTP API reads ?cursor= and ?limit=)`, [...p.path, "name"], { element: el, hint: "Rename the parameter" });
    }
    if (q.search && p.name === q.search.param) {
      h.bag.error("duplicate-name", `Parameter "${p.name}" is also the search parameter`, [...p.path, "name"], { element: el, hint: "The search parameter is declared by search.param; remove it from params" });
    }
  }
  if (!ag) {
    const s = closest(q.from, ctx.aggregates.map((a) => a.name));
    h.bag.error("unknown-aggregate", `Unknown aggregate "${q.from}"`, [...q.path, "from"], { element: el, hint: s ? `Did you mean "${s}"?` : `Aggregates of ${ctx.name}: ${ctx.aggregates.map((a) => a.name).join(", ") || "none"}` });
    return;
  }
  const table = tableOf(ctx, h.fieldTypes, ag);
  const aggFields = h.fieldTypes.get(ag.name) ?? new Map<string, Type>();

  /** Resolves a field path for a purpose; reports and returns undefined when it cannot be used. */
  const resolvePath = (field: string, path: Path, purpose: "filter" | "search" | "order"): { column: ColumnIR; type: Type } | undefined => {
    const segs = field.split(".");
    let fields = aggFields;
    let owner = ag.name;
    let t: Type | undefined;
    for (const [i, seg] of segs.entries()) {
      t = fields.get(seg);
      if (!t) {
        const s = closest(seg, [...fields.keys()]);
        h.bag.error("unknown-field", `${owner} has no field "${seg}"`, path, { element: el, hint: s ? `Did you mean "${segs.slice(0, i).concat(s).join(".")}"?` : undefined });
        return undefined;
      }
      if (i < segs.length - 1) {
        const b = baseOf(t);
        if (b.k !== "vo") {
          h.bag.error("invalid-reference", `"${segs.slice(0, i + 1).join(".")}" is ${typeToString(t)}, which has no fields to select`, path, { element: el });
          return undefined;
        }
        fields = h.fieldTypes.get(b.name) ?? new Map();
        owner = b.name;
      }
    }
    const at = columnAt(table, segs);
    const leaf = baseOf(t!);
    if (!("column" in at) && leaf.k === "vo" && at.error === "none") {
      const first = [...(h.fieldTypes.get(leaf.name)?.keys() ?? ["value"])][0];
      h.bag.error("invalid-type", `"${field}" is the value object ${leaf.name}; select one of its fields`, path, { element: el, hint: `e.g. ${field}.${first}` });
      return undefined;
    }
    if (!("column" in at)) {
      h.bag.error("unqueryable-field", `"${field}" is stored as JSON (jsonb) and cannot be used in ${purpose === "order" ? "order_by" : purpose === "search" ? "search" : "where"}`, path, {
        element: el,
        hint: "Only scalar fields and fields of required value objects get their own column (an optional value object, a list or an entity is one jsonb column)",
      });
      return undefined;
    }
    return { column: at.column, type: t! };
  };

  // Authorization (docs/09 §21): who may run it, before the filters that scope rows to the caller.
  const members = checkQueryAccess(h, q, el);

  // Filters.
  q.where.forEach((f) => {
    const r = resolvePath(f.field, [...f.path, "field"], "filter");
    const sources = [f.param, f.value, f.principal].filter((x) => x !== undefined).length;
    if (sources === 0) {
      h.bag.error("missing-key", 'A filter needs "param" (compare with a parameter), "value" (compare with a literal) or "principal" (compare with the caller)', f.path, { element: el });
    }
    if (sources > 1) {
      h.bag.error("invalid-shape", 'A filter has one of "param", "value" or "principal", not several', [...f.path, f.principal !== undefined ? "principal" : "value"], { element: el });
    }
    if (!r) return;
    const ft = baseOf(r.type);
    const rangeOk = ft.k === "primitive" && ORDERABLE_FOR_RANGE.has(ft.name);
    if (f.op !== "eq" && f.op !== "ne" && !rangeOk) {
      h.bag.error("invalid-operator", `"${f.op}" needs an ordered field (String, Integer, Decimal, DateTime, Date), but ${f.field} is ${typeToString(ft)}`, [...f.path, "op"], { element: el, hint: "Use eq or ne" });
    }
    if (f.param !== undefined) {
      const pt = params.get(f.param);
      if (!pt) {
        const s = closest(f.param, [...params.keys()]);
        h.bag.error("unknown-parameter", `Unknown parameter "${f.param}"`, [...f.path, "param"], { element: el, hint: s ? `Did you mean "${s}"?` : `Declare it in params: - { name: ${f.param}, type: ${typeToString(ft)} }` });
      } else if (!assignable(baseOf(pt), ft) && !sameType(baseOf(pt), ft)) {
        h.bag.error("type-mismatch", `Parameter ${f.param} is ${typeToString(baseOf(pt))}, but ${f.field} is ${typeToString(ft)}`, [...f.path, "param"], { element: el });
      }
    } else if (f.value !== undefined) {
      h.checkValue(f.value, ft, [...f.path, "value"], el);
    } else if (f.principal !== undefined && members) {
      checkPrincipalFilter(h, f, ft, members, el);
    }
  });
  // Unused parameters are almost always a mistake (the query ignores them).
  for (const p of q.params) {
    if (!q.where.some((f) => f.param === p.name)) {
      h.bag.warning("unused-parameter", `Parameter "${p.name}" is not used by any filter`, [...p.path, "name"], { element: el, hint: `Add a filter: - { field: <field>, op: eq, param: ${p.name} }` });
    }
  }

  // Search.
  const s = q.search;
  if (s) {
    h.checkSnake(s.param, "Search parameter", [...s.path, "param"], el);
    if ((RESERVED_QUERY_PARAMS as readonly string[]).includes(s.param)) {
      h.bag.error("reserved-name", `"${s.param}" is reserved for paging`, [...s.path, "param"], { element: el, hint: "Use q" });
    }
    if (!s.fields.length) h.bag.error("missing-key", "search.fields must list at least one String field", s.path, { element: el, hint: "e.g. fields: [email.value]" });
    const fseen = new Set<string>();
    s.fields.forEach((f, i) => {
      const p = [...s.path, "fields", i];
      if (fseen.has(f)) h.bag.error("duplicate-name", `Field ${f} is listed twice`, p, { element: el });
      fseen.add(f);
      const r = resolvePath(f, p, "search");
      if (!r) return;
      const ft = baseOf(r.type);
      if (!(ft.k === "primitive" && ft.name === "String")) {
        h.bag.error("invalid-type", `Searched fields must be String (or a String field of a value object), but ${f} is ${typeToString(ft)}`, p, { element: el, hint: ft.k === "vo" ? `Search one of its fields, e.g. ${f}.${[...(h.fieldTypes.get(ft.name)?.keys() ?? ["value"])][0]}` : "Filter it with where instead" });
      }
    });
    if (s.mode === "trigram") {
      if (!(s.minSimilarity > 0 && s.minSimilarity <= 1)) {
        h.bag.error("invalid-value", `min_similarity must be greater than 0 and at most 1, got ${s.minSimilarity}`, [...s.path, "min_similarity"], { element: el, hint: "pg_trgm's default threshold is 0.3" });
      } else if (s.minSimilarity < PG_TRGM_DEFAULT_THRESHOLD) {
        h.bag.warning("trigram-threshold-below-default", `min_similarity ${s.minSimilarity} is below pg_trgm's default similarity_threshold (${PG_TRGM_DEFAULT_THRESHOLD}): the generated SQL cannot use the trigram index (% operator) and filters every row with similarity()`, [...s.path, "min_similarity"], {
          element: el,
          hint: "Use 0.3 or more, or accept a sequential scan (fine for small tables)",
        });
      }
    }
  }

  // Order.
  const oseen = new Set<string>();
  q.orderBy.forEach((o, i) => {
    const p = [...o.path];
    if (oseen.has(o.field)) h.bag.error("duplicate-name", `order_by lists ${o.field} twice`, p, { element: el });
    oseen.add(o.field);
    if (o.field === RELEVANCE) {
      if (!s) h.bag.error("invalid-order", "relevance needs a search (it orders by the search score)", p, { element: el, hint: "Add search: { param: q, fields: [...] } or order by a field" });
      else if (s.mode !== "trigram") h.bag.error("invalid-order", `relevance needs mode: trigram (mode ${s.mode} has no score)`, p, { element: el });
      if (o.direction !== "desc") h.bag.error("invalid-order", "relevance is ordered highest first (desc)", p, { element: el, hint: "Remove direction, or write direction: desc" });
      return;
    }
    const r = resolvePath(o.field, p, "order");
    if (!r) return;
    if (r.column.nullable) {
      h.bag.error("invalid-order", `${o.field} is optional; order_by needs required fields (NULLs have no place in a keyset)`, p, { element: el, hint: "Order by a required field (the identity is appended automatically as the tie-breaker)" });
    }
    const ft = baseOf(r.type);
    if (!(ft.k === "primitive" || ft.k === "enum" || ft.k === "ref")) {
      h.bag.error("invalid-order", `${o.field} (${typeToString(ft)}) cannot be ordered`, p, { element: el });
    }
    if (r.column.name === table.identity.name && i < q.orderBy.length - 1) {
      h.bag.warning("redundant-order", `The identity ${o.field} is unique: the keys after it never decide the order`, p, { element: el, hint: "Move it last or remove the keys after it" });
    }
  });

  // Page.
  const pg = q.page;
  if (pg.size < 1) h.bag.error("invalid-value", `page.size must be at least 1, got ${pg.size}`, [...pg.path, "size"], { element: el });
  if (pg.maxSize < pg.size) h.bag.error("invalid-value", `page.max_size (${pg.maxSize}) is smaller than page.size (${pg.size})`, [...pg.path, "max_size"], { element: el });
  if (pg.maxSize > MAX_PAGE_SIZE_LIMIT) h.bag.error("invalid-value", `page.max_size must be at most ${MAX_PAGE_SIZE_LIMIT}, got ${pg.maxSize}`, [...pg.path, "max_size"], { element: el, hint: "Page through large results instead of fetching them at once" });

  // Projection.
  if (q.returns) {
    if (!q.returns.length) h.bag.error("invalid-value", "returns must list at least one field (leave it out to return every field)", [...q.path, "returns"], { element: el });
    const rseen = new Set<string>();
    q.returns.forEach((f, i) => {
      const p = [...q.path, "returns", i];
      if (rseen.has(f)) h.bag.error("duplicate-name", `returns lists ${f} twice`, p, { element: el });
      rseen.add(f);
      if (!aggFields.has(f)) {
        const sug = closest(f, [...aggFields.keys()]);
        h.bag.error("unknown-field", `${ag.name} has no field "${f}"${f.includes(".") ? " (returns lists top-level fields)" : ""}`, p, { element: el, hint: sug ? `Did you mean "${sug}"?` : undefined });
      }
    });
  }

  // Scenarios.
  const sseen = new Set<string>();
  const returned = q.returns ? new Map([...aggFields].filter(([k]) => q.returns!.includes(k))) : aggFields;
  const paramTypes = new Map<string, Type>(params);
  if (s) paramTypes.set(s.param, { k: "optional", inner: T.String });
  const idType = aggFields.get(ag.identity);
  for (const sc of q.scenarios) {
    const sel = h.el(`query ${q.name}`, `scenario ${sc.name}`);
    h.checkSnake(sc.name, "Scenario name", [...sc.path, "name"], sel);
    if (sseen.has(sc.name)) h.bag.error("duplicate-name", `Duplicate scenario "${sc.name}"`, [...sc.path, "name"], { element: sel });
    sseen.add(sc.name);
    const ids = new Set<string>();
    for (const a of sc.given.aggregates) {
      if (a.type !== undefined && a.type !== ag.name) {
        h.bag.error("invalid-scenario", `Query ${q.name} reads ${ag.name}; given.aggregates can only hold ${ag.name} (got ${a.type})`, a.path, { element: sel, hint: "Remove type (it defaults to the query's aggregate)" });
        continue;
      }
      h.checkRecord(a.fields, aggFields, a.path, sel, ag.name, true);
      const id = a.fields[ag.identity];
      const key = typeof id === "string" ? id.toLowerCase() : JSON.stringify(id);
      if (id !== undefined && ids.has(key)) h.bag.error("invalid-scenario", `Two given aggregates have the identity ${JSON.stringify(id)}`, a.path, { element: sel });
      ids.add(key);
    }
    checkQueryScenarioPrincipal(h, q, sc, sel);
    h.checkRecord(sc.when.params, paramTypes, [...sc.when.path, "params"], sel, `${q.name} params`, true);
    if (sc.when.limit !== undefined && (sc.when.limit < 1 || sc.when.limit > pg.maxSize)) {
      h.bag.error("invalid-value", `when.limit must be between 1 and page.max_size (${pg.maxSize}), got ${sc.when.limit}`, [...sc.when.path, "limit"], { element: sel });
    }
    if (sc.when.pages < 1) h.bag.error("invalid-value", `when.pages must be at least 1, got ${sc.when.pages}`, [...sc.when.path, "pages"], { element: sel });
    if (sc.then.items === undefined && sc.then.nextCursor === undefined) {
      h.bag.error("ambiguous-scenario", "then states no expected result", sc.then.path, { element: sel, hint: "Specify items (identities or partial items, in order) and/or next_cursor: present | absent" });
    }
    (sc.then.items ?? []).forEach((it, i) => {
      const p = [...sc.then.path, "items", i];
      if (it !== null && typeof it === "object" && !Array.isArray(it)) h.checkRecord(it as Record<string, unknown>, returned, p, sel, `${q.name} item`, false);
      else if (!returned.has(ag.identity)) {
        h.bag.error("invalid-scenario", `Items of ${q.name} do not include the identity ${ag.identity}; expect partial items ({ field: value }) instead`, p, { element: sel, hint: `Or add ${ag.identity} to returns` });
      } else if (idType) h.checkValue(it, idType, p, sel);
    });
  }
}

// ---------------------------------------------------------------------------
// Authorization of queries (docs/09 §21)
// ---------------------------------------------------------------------------

/** The principal members a filter may compare with: `id` and the declared scalar claims (with their types). */
function scopeMembers(sec: SecurityIR): Map<string, Type> {
  return new Map([...principalMembers(sec)].filter(([name, t]) => name !== "roles" && baseOf(t).k !== "list"));
}

/** Members a query's filters scope rows by (`where: { principal: … }`), in declaration order without duplicates. */
export function queryScope(q: QueryIR): string[] {
  return [...new Set(q.where.flatMap((f) => (f.principal !== undefined ? [f.principal] : [])))];
}

/**
 * `authorize` / `rate_limit` of a query. Deny by default like use cases: with `security` declared every query states
 * who may run it. `internal` and `allow_if` do not apply (a query is a read endpoint; a per-row rule would break the
 * keyset paging). Returns the members principal filters may use when they are allowed at all.
 */
function checkQueryAccess(h: QueryValidationHost, q: QueryIR, el: string): Map<string, Type> | undefined {
  const sec = h.security;
  if (!sec) return undefined;
  const scoped = q.where.filter((f) => f.principal !== undefined);
  const a = q.authorize;
  if (!a) {
    h.bag.error("missing-authorize", `Query ${q.name} declares no authorize; with security declared it is denied until you decide who may run it`, [...q.path, "name"], {
      element: el,
      hint: "Add authorize: public, authenticated, or { roles: [...] } (scope rows to the caller with where: { field, op: eq, principal: <id or claim> })",
    });
    return undefined;
  }
  if (a.kind === "internal") {
    h.bag.error("invalid-authorize", "authorize: internal applies to use cases only", a.path, {
      element: el,
      hint: "A query is a read endpoint: limit it with roles (e.g. roles: [admin]); in-process code can call its reader directly",
    });
  }
  if (a.allowIf !== undefined) {
    h.bag.error("invalid-authorize", "allow_if does not apply to queries: a rule per row would drop rows after the page is cut, breaking the keyset paging", [...a.path, "allow_if"], {
      element: el,
      hint: "Scope the rows in where with the caller instead: - { field: company_id, op: eq, principal: company_id }",
    });
  }
  checkRoles(h.bag, sec, a, el);
  checkRateLimitUse(h.bag, q, el);
  if (a.kind === "public") {
    for (const f of scoped) {
      h.bag.error("invalid-principal-filter", `A public query has no principal to compare ${f.field} with`, [...f.path, "principal"], { element: el, hint: "Use authorize: authenticated or { roles: [...] }" });
    }
    return undefined;
  }
  return scopeMembers(sec);
}

/** `where: { field, op, principal: <id or claim> }`: the member exists and has the field's type. */
function checkPrincipalFilter(h: QueryValidationHost, f: QueryFilterIR, field: Type, members: Map<string, Type>, el: string): void {
  const name = f.principal!;
  const p = [...f.path, "principal"];
  const t = members.get(name);
  if (!t) {
    const list = name === "roles" || principalMembers(h.security!).has(name);
    const s = closest(name, [...members.keys()]);
    h.bag.error("unknown-field", list ? `principal.${name} is a list; a filter compares with one value` : `The principal has no member "${name}"`, p, {
      element: el,
      hint: s && !list ? `Did you mean "${s}"?` : `Compare with id or a declared claim: ${[...members.keys()].join(", ")}`,
    });
    return;
  }
  const mt = baseOf(t);
  // A Ref is stored as its target's identity: compare the claim with that type.
  let target = field;
  if (field.k === "ref") {
    const ag = h.ctx.aggregates.find((a) => a.name === field.target);
    const id = ag ? h.fieldTypes.get(ag.name)?.get(ag.identity) : undefined;
    if (id) target = baseOf(id);
  }
  if (!assignable(mt, target) && !sameType(mt, target)) {
    h.bag.error("type-mismatch", `principal.${name} is ${typeToString(mt)}, but ${f.field} is ${typeToString(field)}`, p, {
      element: el,
      hint: name === "id" ? "Declare security.principal.id: UUID (or String) to match the field" : "Declare the claim with the field's type",
    });
  }
}

/** `given.principal` of a query scenario: protected queries run as it (default: their roles, claims defaulted). */
function checkQueryScenarioPrincipal(h: QueryValidationHost, q: QueryIR, sc: QueryScenarioIR, el: string): void {
  const sec = h.security;
  const p = sc.given.principal;
  if (!sec || !q.authorize) return;
  if (q.authorize.kind !== "principal") {
    if (p) h.bag.warning("unused-principal", `Query ${q.name} is ${q.authorize.kind}: it runs without a principal, so given.principal is ignored`, p.path, { element: el });
    return;
  }
  if (p?.anonymous) {
    h.bag.error("invalid-scenario", `${q.name} needs an authenticated principal; an anonymous caller raises Unauthenticated (the generated tests check that)`, p.path, { element: el, hint: "Give a principal with a required role, or leave given.principal out" });
    return;
  }
  if (p) h.checkGivenPrincipal(p, el);
  const resolved = scenarioPrincipal(sec, q, sc);
  const roles = q.authorize.roles;
  if (p && roles.length && !roles.some((r) => resolved.roles.includes(r))) {
    h.bag.error("invalid-scenario", `The principal holds none of ${roles.join(", ")}: ${q.name} raises NotAuthorized (the generated tests check that)`, [...p.path, "roles"], { element: el, hint: `Give it one of the roles ${roles.join(", ")}` });
  }
  const members = scopeMembers(sec);
  for (const member of queryScope(q)) {
    // id is always there; unknown members are reported on the filter.
    if (member === "id" || !members.has(member)) continue;
    if (resolved.claims[member] === null || resolved.claims[member] === undefined) {
      h.bag.error("invalid-scenario", `${q.name} scopes rows by principal.${member}, which this scenario's principal does not have (NotAuthorized)`, p?.path ?? sc.given.path, {
        element: el,
        hint: `Add given: { principal: { claims: { ${member}: <value> } } }`,
      });
    }
  }
}
