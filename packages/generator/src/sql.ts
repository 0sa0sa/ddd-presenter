/**
 * Shared PostgreSQL emitter of both targets: the desired-schema DDL (`sql/<context>.sql`) and the statements of the
 * generated repositories and query readers. The TypeScript and Python code embed the same statement text (Python
 * with psycopg placeholders), so the PGlite tests of the TypeScript output exercise the SQL of both.
 *
 * Conventions (docs/05 §9, decisions docs/09 §19):
 * - every placeholder carries an explicit cast (`$1::uuid`), so untyped drivers (node-postgres, PGlite, psycopg's
 *   unknown-typed strings) behave the same;
 * - text order is `COLLATE "C"` in ORDER BY, keyset predicates and indexes: code point order, which the in-memory
 *   readers reproduce exactly;
 * - SELECT lists are driver-neutral: instants as ISO 8601 UTC text with microseconds, dates as `YYYY-MM-DD`,
 *   numerics as text; keys as text (the relevance score as float8 text, which round-trips the float4 exactly);
 * - optional parameters are `($n::t IS NULL OR …)`; the search predicate is a separate statement variant so the
 *   trigram index is used whenever a search runs.
 */
import type { ColumnIR, ContextAnalysis, ModelIR, QueryPlan, SqlType, TableIR } from "@ddd/core";
import { MAX_IDENTIFIER_LENGTH, planQuery, tableOf, VERSION_COLUMN } from "@ddd/core";
import { createHash } from "node:crypto";

/** Words PostgreSQL reserves (as column names they must be quoted). */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column " +
    "concurrently constraint create cross current_catalog current_date current_role current_schema current_time " +
    "current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze " +
    "from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit " +
    "localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references " +
    "returning right select session_user similar some symmetric system_user table tablesample then to trailing true union " +
    "unique user using variadic verbose when where window with"
  ).split(" "),
);

/** An identifier, double-quoted when PostgreSQL would not read it as written. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function tableRef(t: TableIR): string {
  return `${ident(t.schema)}.${ident(t.name)}`;
}

/** Cast of a placeholder holding a value of this column. */
function cast(sql: SqlType): string {
  return sql;
}

/** The column as an ORDER BY / comparison expression (text in code point order), optionally qualified. */
function orderExpr(c: ColumnIR, qualifier?: string): string {
  const name = qualifier ? `${qualifier}.${ident(c.name)}` : ident(c.name);
  return c.sql === "text" ? `${name} COLLATE "C"` : name;
}

/** Driver-neutral SELECT expression of a column (aliased to its name). */
export function selectExpr(c: ColumnIR): string {
  const n = ident(c.name);
  switch (c.sql) {
    case "timestamptz":
      return `to_char(${n} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${n}`;
    case "date":
      return `to_char(${n}, 'YYYY-MM-DD') AS ${n}`;
    case "numeric":
      return `${n}::text AS ${n}`;
    default:
      return n;
  }
}

/** A bound value of a statement, in placeholder order. */
export type SqlArg =
  | { kind: "column"; column: string }
  | { kind: "version" }
  | { kind: "param"; name: string }
  | { kind: "value"; value: unknown; column: ColumnIR }
  | { kind: "principal"; name: string }
  | { kind: "search" }
  | { kind: "key"; index: number }
  | { kind: "limit" };

export interface SqlStatement {
  text: string;
  args: SqlArg[];
}

/** Writes `items` separated by `sep`, one per line at `indent` when the single line would be too long. */
function list(items: string[], indent: string, head: string, max = 96): string {
  const one = `${head}${items.join(", ")}`;
  if (indent.length + one.length <= max) return one;
  return `${head.trimEnd()}\n${items.map((x, i) => `${indent}  ${x}${i < items.length - 1 ? "," : ""}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface RepositorySql {
  /** `SELECT <columns>, version FROM t WHERE id = $1`; arg: the identity. */
  select: SqlStatement;
  /** `INSERT … ON CONFLICT DO NOTHING RETURNING version` (version 1); args: every column in table order. */
  insert: SqlStatement;
  /** `UPDATE … SET … version = version + 1 WHERE id = … AND version = $n RETURNING version`; args: columns, then the expected version. */
  update: SqlStatement;
}

export function repositorySql(t: TableIR): RepositorySql {
  const ref = tableRef(t);
  const id = t.identity;
  const selectList = [...t.columns.map(selectExpr), VERSION_COLUMN];
  const select = {
    text: `${list(selectList, "", "SELECT ")}\nFROM ${ref}\nWHERE ${ident(id.name)} = $1::${cast(id.sql)}`,
    args: [{ kind: "column", column: id.name } as SqlArg],
  };
  const cols = t.columns.map((c) => ident(c.name));
  const values = t.columns.map((c, i) => `$${i + 1}::${cast(c.sql)}`);
  const insert = {
    text: [
      `INSERT INTO ${ref} (`,
      ...[...cols, VERSION_COLUMN].map((c, i, a) => `  ${c}${i < a.length - 1 ? "," : ""}`),
      `) VALUES (`,
      ...[...values, "1"].map((v, i, a) => `  ${v}${i < a.length - 1 ? "," : ""}`),
      `)`,
      `ON CONFLICT (${ident(id.name)}) DO NOTHING`,
      `RETURNING ${VERSION_COLUMN}`,
    ].join("\n"),
    args: t.columns.map((c) => ({ kind: "column", column: c.name }) as SqlArg),
  };
  const idIndex = t.columns.indexOf(id) + 1;
  const sets = t.columns.flatMap((c, i) => (c === id ? [] : [`${ident(c.name)} = $${i + 1}::${cast(c.sql)}`]));
  const update = {
    text: [
      `UPDATE ${ref} SET`,
      ...[...sets, `${VERSION_COLUMN} = ${VERSION_COLUMN} + 1`].map((s, i, a) => `  ${s}${i < a.length - 1 ? "," : ""}`),
      `WHERE ${ident(id.name)} = $${idIndex}::${cast(id.sql)} AND ${VERSION_COLUMN} = $${t.columns.length + 1}::bigint`,
      `RETURNING ${VERSION_COLUMN}`,
    ].join("\n"),
    args: [...t.columns.map((c) => ({ kind: "column", column: c.name }) as SqlArg), { kind: "version" } as SqlArg],
  };
  return { select, insert, update };
}

// ---------------------------------------------------------------------------
// Query reader
// ---------------------------------------------------------------------------

const OPS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/** Columns a query's items need (the projection's fields, flattened), in table order. */
export function itemColumns(plan: QueryPlan): ColumnIR[] {
  return plan.table.columns.filter((c) => plan.returns.includes(c.path[0]!));
}

/** Alias of the LATERAL subquery computing the search score once (model names never start with `_`). */
const SCORE = "_s._score";

/** `CROSS JOIN LATERAL (SELECT <highest similarity of the searched columns> AS _score) AS _s`. */
function scoreJoin(plan: QueryPlan, q: string): string {
  const parts = plan.search!.columns.map((c) => `similarity(lower(${ident(c.name)}), lower(${q}))`);
  const one = `CROSS JOIN LATERAL (SELECT ${parts.length === 1 ? parts[0] : `GREATEST(${parts.join(", ")})`} AS _score) AS _s`;
  if (one.length <= 96) return one;
  const inner = parts.length === 1 ? `  SELECT ${parts[0]} AS _score` : `  SELECT GREATEST(\n${parts.map((p, i) => `    ${p}${i < parts.length - 1 ? "," : ""}`).join("\n")}\n  ) AS _score`;
  return `CROSS JOIN LATERAL (\n${inner}\n) AS _s`;
}

/** `(a OR b)` on one line, or one alternative per line when too long (inside a WHERE … AND list). */
function anyOf(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  const one = `(${parts.join(" OR ")})`;
  return one.length <= 90 && !one.includes("\n") ? one : `(\n    ${parts.join("\n    OR ")}\n  )`;
}

/** `left op right`, broken inside the parentheses of a row value when too long. */
function compare(left: string[], op: string, right: string[]): string {
  if (left.length === 1) return `${left[0]} ${op} ${right[0]}`;
  const one = `(${left.join(", ")}) ${op} (${right.join(", ")})`;
  if (one.length <= 90) return one;
  return `(\n    ${left.join(",\n    ")}\n  ) ${op} (\n    ${right.join(",\n    ")}\n  )`;
}

export interface QueryVariant {
  /** The search parameter is given (the search predicate applies, relevance orders). */
  search: boolean;
  /** A cursor is given (the keyset predicate applies). */
  after: boolean;
}

/** Order keys active in a variant: the relevance key only while searching. */
export function activeKeys(plan: QueryPlan, search: boolean) {
  return plan.keys.filter((k) => !k.relevance || search);
}

export function querySql(plan: QueryPlan, v: QueryVariant): SqlStatement {
  const args: SqlArg[] = [];
  const arg = (a: SqlArg, sql: string) => {
    const same = args.findIndex((x) => JSON.stringify(x) === JSON.stringify(a));
    if (same >= 0) return `$${same + 1}::${sql}`;
    args.push(a);
    return `$${args.length}::${sql}`;
  };
  const where: string[] = [];
  for (const { filter, column } of plan.filters) {
    const lhs = filter.op === "eq" || filter.op === "ne" ? ident(column.name) : orderExpr(column);
    if (filter.param !== undefined) {
      const p = plan.params.find((x) => x.field.name === filter.param)!;
      const ph = arg({ kind: "param", name: filter.param }, cast(column.sql));
      const cond = `${lhs} ${OPS[filter.op]} ${ph}`;
      where.push(p.type.k === "optional" ? `(${ph} IS NULL OR ${cond})` : cond);
    } else if (filter.principal !== undefined) {
      // Scoped to the caller: always applies (no IS NULL escape; the query service refuses a missing claim).
      where.push(`${lhs} ${OPS[filter.op]} ${arg({ kind: "principal", name: filter.principal }, cast(column.sql))}`);
    } else {
      where.push(`${lhs} ${OPS[filter.op]} ${arg({ kind: "value", value: filter.value, column }, cast(column.sql))}`);
    }
  }
  const s = plan.search;
  let join: string | undefined;
  if (s && v.search) {
    const q = arg({ kind: "search" }, "text");
    const cols = s.columns.map((c) => ident(c.name));
    if (s.mode === "trigram") {
      join = scoreJoin(plan, q);
      // `%` is the indexable form (GIN gin_trgm_ops); it compares with pg_trgm.similarity_threshold (default 0.3),
      // so it is only a correct prefilter when min_similarity is at least that. The explicit threshold decides.
      if (s.prefilter) where.push(anyOf(cols.map((c) => `lower(${c}) % lower(${q})`)));
      where.push(`${SCORE} >= ${s.minSimilarity}`);
    } else if (s.mode === "prefix") {
      // LIKE with `!` as the escape character: the search text's own % and _ match literally.
      const pattern = `replace(replace(replace(lower(${q}), '!', '!!'), '%', '!%'), '_', '!_') || '%'`;
      where.push(anyOf(cols.map((c) => `lower(${c}) LIKE (\n    ${pattern}\n  ) ESCAPE '!'`)));
    } else {
      where.push(anyOf(cols.map((c) => `lower(${c}) = lower(${q})`)));
    }
  }
  const keys = activeKeys(plan, v.search);
  // Qualified with the table: in ORDER BY a bare name would mean the SELECT list's output column of that name
  // (e.g. `to_char(joined_at …) AS joined_at`, text), not the column the index orders.
  const keyExpr = keys.map((k) => (k.relevance ? SCORE : orderExpr(k.column!, ident(plan.table.name))));
  if (v.after) {
    const vals = keys.map((k, i) => arg({ kind: "key", index: i }, k.relevance ? "real" : cast(k.column!.sql)));
    const op = (d: "asc" | "desc") => (d === "asc" ? ">" : "<");
    if (keys.every((k) => k.direction === keys[0]!.direction)) {
      // Row-value comparison: one condition the btree index can seek to (all keys share a direction).
      where.push(compare(keyExpr, op(keys[0]!.direction), vals));
    } else {
      // Mixed directions: (k0 > v0) OR (k0 = v0 AND k1 < v1) OR …
      const ors = keys.map((k, i) => {
        const terms = [...keys.slice(0, i).map((_, j) => `${keyExpr[j]} = ${vals[j]}`), `${keyExpr[i]} ${op(k.direction)} ${vals[i]}`];
        const one = `(${terms.join(" AND ")})`;
        return one.length <= 88 ? one : `(\n      ${terms.join("\n      AND ")}\n    )`;
      });
      where.push(`(\n    ${ors.join("\n    OR ")}\n  )`);
    }
  }
  const select = [
    ...itemColumns(plan).map(selectExpr),
    ...keys.map((k, i) => (k.relevance ? `${SCORE}::float8::text AS _k${i}` : `${ident(k.column!.name)}::text AS _k${i}`)),
  ];
  const lines = [list(select, "", "SELECT "), `FROM ${tableRef(plan.table)}`];
  if (join) lines.push(join);
  if (where.length) lines.push(`WHERE ${where.join("\n  AND ")}`);
  lines.push(list(keys.map((k, i) => `${keyExpr[i]} ${k.direction.toUpperCase()}`), "", "ORDER BY "));
  lines.push(`LIMIT ${arg({ kind: "limit" }, "integer")}`);
  return { text: lines.join("\n"), args };
}

/** The statement variants of a query: `first` / `next` page, and with a search `searchFirst` / `searchNext`. */
export function queryStatements(plan: QueryPlan): Record<string, SqlStatement> {
  const out: Record<string, SqlStatement> = {
    first: querySql(plan, { search: false, after: false }),
    next: querySql(plan, { search: false, after: true }),
  };
  if (plan.search) {
    out.searchFirst = querySql(plan, { search: true, after: false });
    out.searchNext = querySql(plan, { search: true, after: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/** An index name within PostgreSQL's identifier limit (long names keep a hash suffix). */
function indexName(...parts: string[]): string {
  const name = parts.join("_");
  if (name.length <= MAX_IDENTIFIER_LENGTH) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER_LENGTH - 9)}_${hash}`;
}

function columnDdl(c: ColumnIR, identity: boolean): string {
  const parts = [ident(c.name), c.sql];
  if (identity) parts.push("PRIMARY KEY");
  else if (!c.nullable) parts.push("NOT NULL");
  if (c.enumValues) parts.push(`CHECK (${ident(c.name)} IN (${c.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}))`);
  return parts.join(" ");
}

/**
 * Desired schema of one context: the pg_trgm extension (when a query searches by trigram), a schema named after the
 * context, a table per aggregate, the trigram / prefix / equality indexes of the searched columns and a btree index
 * matching each query's order. Idempotent (`IF NOT EXISTS`); it does not migrate existing tables.
 */
export function contextDdl(header: string[], context: string, tables: TableIR[], plans: QueryPlan[]): string {
  const out: string[] = [...header.map((h) => (h ? `-- ${h}` : "--")), ""];
  if (plans.some((p) => p.search?.mode === "trigram")) out.push("CREATE EXTENSION IF NOT EXISTS pg_trgm;", "");
  const schema = tables[0]?.schema ?? context;
  out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)};`);
  const indexes = new Map<string, string>();
  const addIndex = (t: TableIR, name: string, body: string, comment: string) => {
    if (!indexes.has(name)) indexes.set(name, `-- ${comment}\nCREATE INDEX IF NOT EXISTS ${ident(name)}\n  ON ${tableRef(t)} ${body};`);
  };
  for (const t of tables) {
    out.push("");
    out.push(`-- Aggregate ${t.aggregate}. version: optimistic locking (incremented by every save).`);
    out.push(`CREATE TABLE IF NOT EXISTS ${tableRef(t)} (`);
    const cols = [...t.columns.map((c) => columnDdl(c, c === t.identity)), `${VERSION_COLUMN} bigint NOT NULL`];
    cols.forEach((c, i) => out.push(`  ${c}${i < cols.length - 1 ? "," : ""}`));
    out.push(");");
  }
  for (const p of plans) {
    const t = p.table;
    if (p.search) {
      for (const c of p.search.columns) {
        if (p.search.mode === "trigram") {
          const note = p.search.prefilter
            ? `\n-- The search filters with % (served by this index), which compares with pg_trgm.similarity_threshold\n-- (default 0.3): keep that setting at or below min_similarity (${p.search.minSimilarity}), or rows are missed.`
            : `\n-- min_similarity ${p.search.minSimilarity} is below pg_trgm's default threshold: the search cannot use % and this index.`;
          addIndex(t, indexName(t.name, c.name, "trgm_idx"), `USING gin (lower(${ident(c.name)}) gin_trgm_ops)`, `Trigram search on ${c.path.join(".")} (${p.query.name}).${note}`);
        }
        else if (p.search.mode === "prefix") addIndex(t, indexName(t.name, c.name, "prefix_idx"), `(lower(${ident(c.name)}) text_pattern_ops)`, `Prefix search on ${c.path.join(".")} (${p.query.name}).`);
        else addIndex(t, indexName(t.name, c.name, "lower_idx"), `(lower(${ident(c.name)}))`, `Case-insensitive equality on ${c.path.join(".")} (${p.query.name}).`);
      }
    }
    // The order without the relevance key (what the query uses when it does not search). The primary key already
    // serves an order by the identity alone (scanned either way).
    const keys = p.keys.filter((k) => !k.relevance);
    // Rows scoped to the caller by equality (`principal:` filters) lead the index: one range per caller.
    const scoped = [...new Set(p.filters.filter(({ filter }) => filter.principal !== undefined && filter.op === "eq").map(({ column }) => column))];
    if (scoped.length || !(keys.length === 1 && keys[0]!.column === t.identity)) {
      const body = `(${[...scoped.map((c) => ident(c.name)), ...keys.map((k) => `${orderExpr(k.column!)} ${k.direction.toUpperCase()}`)].join(", ")})`;
      const when = p.keys[0]?.relevance ? " when it does not search (a search orders by relevance first)" : "";
      const per = scoped.length ? `, per ${scoped.map((c) => c.path.join(".")).join(", ")} of the caller` : "";
      addIndex(t, indexName(t.name, p.query.name, "order_idx"), body, `Keyset order of ${p.query.name}${per}${when}.`);
    }
  }
  if (indexes.size) out.push("", [...indexes.values()].join("\n\n"));
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

/** The statement for psycopg 3 (`%(p1)s` named placeholders; a literal % is written %%). */
export function psycopgText(text: string): string {
  return text.replace(/%/g, "%%").replace(/\$(\d+)/g, "%(p$1)s");
}

/** `sql/<context>.sql`: the desired schema of a context with queries (both targets generate the same file). */
export function contextSqlFile(model: ModelIR, ca: ContextAnalysis): { path: string; content: string } | undefined {
  const queries = ca.ir.queries ?? [];
  if (!queries.length) return undefined;
  const tables = ca.ir.aggregates.map((a) => tableOf(ca.ir, ca.fieldTypes, a));
  const plans = queries.map((q) => planQuery(ca.ir, ca.fieldTypes, q)!);
  const header = [
    `Generated by DDD Presenter from model "${model.project}". DO NOT EDIT.`,
    "Regenerate with `ddd generate`.",
    "",
    `Desired PostgreSQL schema (13 or later) of the ${ca.ir.name} context: one table per aggregate and the indexes`,
    "its queries need. Idempotent (IF NOT EXISTS): apply it to create a database. It does not alter existing",
    "tables; derive migrations by comparing a database with this file (e.g. with a schema diff tool).",
  ];
  const schema = tables[0]?.schema ?? ca.ir.name.toLowerCase();
  return { path: `sql/${schema}.sql`, content: contextDdl(header, schema, tables, plans) };
}
