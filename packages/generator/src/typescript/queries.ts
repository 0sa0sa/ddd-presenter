/**
 * Read side and PostgreSQL persistence of the TypeScript target, for contexts that declare `queries:`:
 *
 * - `<context>/application/queries.ts`: per query the input schema, the item schema, the spec, the reader port and
 *   the `<Query>Query` application service (validates, normalizes, decodes / encodes the cursor);
 * - `<context>/persistence/rows.ts`: aggregate ↔ row mapping (validated on load) and the item decoders;
 * - `<context>/persistence/postgres.ts`: the SQL (shared emitter, sql.ts), repositories with optimistic locking and
 *   readers over a node-postgres / PGlite compatible `SqlClient`;
 * - in-memory readers (testing.ts) and generated tests.
 *
 * Contract: docs/05 §9; decisions: docs/09 §19.
 */
import { planQuery, queryParamsOwner, type ColumnIR, type QueryPlan, type QueryScenarioIR, type TableIR, tableOf, type Type } from "@ddd/core";
import { Code, TsImports, tsString } from "./code.ts";
import { file, type TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { camel, ident, pascal, prop, toSnake } from "./names.ts";
import { activeKeys, itemColumns, queryStatements, repositorySql, type SqlArg, type SqlStatement } from "../sql.ts";
import { testFile } from "./tests.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { tsType, zodSchema } from "./types.ts";

/** `name(params): result {` at class-member depth, broken like Prettier when it does not fit. */
function method(c: Code, name: string, params: string[], result: string, body: () => void): void {
  const one = `  ${name}(${params.join(", ")}): ${result} {`;
  if (strWidth(one) <= PRINT_WIDTH) {
    c.block(`${name}(${params.join(", ")}): ${result}`, body);
    return;
  }
  c.line(`${name}(`);
  c.indent(() => params.forEach((p) => c.line(`${p},`)));
  c.block(`): ${result}`, body);
}
import { canonicalInstant, expectEqual, inputValue, record } from "./values.ts";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function contextPlans(L: TsLayout): QueryPlan[] {
  return (L.ca.ir.queries ?? []).map((q) => planQuery(L.ca.ir, L.ca.fieldTypes, q)!);
}

export function hasQueries(L: TsLayout): boolean {
  return (L.ca.ir.queries ?? []).length > 0;
}

/** Tables of every aggregate of the context (a context with queries persists all of them). */
export function contextTables(L: TsLayout): TableIR[] {
  return L.ca.ir.aggregates.map((a) => tableOf(L.ca.ir, L.ca.fieldTypes, a));
}

const Q = (plan: QueryPlan) => pascal(plan.query.name);
export const queryClass = (plan: QueryPlan) => `${Q(plan)}Query`;
export const readerName = (plan: QueryPlan) => `${Q(plan)}Reader`;
export const itemName = (plan: QueryPlan) => `${Q(plan)}Item`;
export const inputName = (plan: QueryPlan) => `${Q(plan)}Input`;
export const paramsName = (plan: QueryPlan) => `${Q(plan)}Params`;
export const pageName = (plan: QueryPlan) => `${Q(plan)}Page`;
export const specName = (plan: QueryPlan) => `${toSnake(plan.query.name).toUpperCase()}_SPEC`;
const sqlName = (plan: QueryPlan) => `${toSnake(plan.query.name).toUpperCase()}_SQL`;
const itemFromRow = (plan: QueryPlan) => `${camel(plan.query.name)}ItemFromRow`;
const lower = (name: string) => name[0]!.toLowerCase() + name.slice(1);
const toRowName = (aggregate: string) => `${lower(aggregate)}ToRow`;
const fromRowName = (aggregate: string) => `${lower(aggregate)}FromRow`;
const toValuesName = (aggregate: string) => `${lower(aggregate)}ToValues`;
const columnsName = (aggregate: string) => `${toSnake(aggregate).toUpperCase()}_COLUMNS`;
const tableName = (aggregate: string) => `${toSnake(aggregate).toUpperCase()}_TABLE`;
const toJsonName = (type: string) => `${lower(type)}ToJson`;
const fromJsonName = (type: string) => `${lower(type)}FromJson`;
/** The search parameter's property in the input (`q`). */
const searchProp = (plan: QueryPlan) => prop(plan.search!.ir.param);

/** How the runtime compares values of a column (persistence.ts `ValueKind`). */
function valueKind(c: ColumnIR): string {
  return ({ text: "text", bigint: "integer", numeric: "decimal", boolean: "boolean", uuid: "uuid", timestamptz: "instant", date: "date", jsonb: "text" } as const)[c.sql];
}

/** A literal filter value as the SQL / the in-memory reader see it. */
function encodedLiteral(v: unknown, c: ColumnIR): string {
  if (c.sql === "bigint") return String(Number(v));
  if (c.sql === "boolean") return v ? "true" : "false";
  if (c.sql === "uuid") return tsString(String(v).toLowerCase());
  if (c.sql === "timestamptz") return tsString(canonicalInstant(v) ?? String(v));
  return tsString(String(v));
}

// ---------------------------------------------------------------------------
// application/queries.ts
// ---------------------------------------------------------------------------

function paramType(plan: QueryPlan, name: string): Type {
  return plan.params.find((p) => p.field.name === name)!.type;
}

export function applicationQueriesFile(L: TsLayout): TsFile {
  const mod = L.queries;
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value("zod", "z");
  for (const plan of contextPlans(L)) {
    const q = plan.query;
    const ag = plan.aggregate;
    // Input: parameters, search text, cursor, limit.
    const fields: string[] = [];
    for (const p of plan.params) fields.push(`${prop(p.field.name)}: ${zodSchema(p.type, imp, L, p.field.constraints)},`);
    if (plan.search) fields.push(`${searchProp(plan)}: z.string().max(${SEARCH_MAX}).nullable().default(null),`);
    fields.push("cursor: z.string().max(4096).nullable().default(null),");
    fields.push(`limit: z.number().int().min(1).nullable().default(null),`);
    c.line();
    c.doc(
      [
        `Input of ${q.name}.`,
        ...(q.description ? ["", q.description] : []),
        "",
        `Parameters are optional unless the model requires them (an absent one disables its filter). ${plan.search ? `\`${searchProp(plan)}\` is the search text (${plan.search.mode}; blank = no search). ` : ""}\`cursor\` is the \`nextCursor\` of the previous page, \`limit\` the page size (default ${q.page.size}, at most ${q.page.maxSize}).`,
      ].join("\n"),
    );
    c.block(`export const ${inputName(plan)}Schema = z.strictObject(`, () => c.lines_(fields), ");");
    c.line(`export type ${inputName(plan)} = z.input<typeof ${inputName(plan)}Schema>;`);
    // Params (what readers get).
    c.line();
    c.doc(`Parameters of ${q.name} as readers get them (null: not given).`);
    if (!plan.params.length) c.line(`export type ${paramsName(plan)} = Readonly<Record<string, never>>;`);
    // A type alias, not an interface: it is assignable to the runtime's `Readonly<Record<string, unknown>>`.
    else c.block(`export type ${paramsName(plan)} =`, () => plan.params.forEach((p) => c.line(`readonly ${prop(p.field.name)}: ${tsType(p.type, imp, L)};`)), ";");
    // Item.
    const itemFields = plan.returns.map((f) => {
      const t = L.tsFieldType(ag.name, f)!;
      const decl = ag.fields.find((x) => x.name === f)!;
      return `${prop(f)}: ${zodSchema(t, imp, L, decl.constraints)},`;
    });
    c.line();
    c.doc(`One result of ${q.name}: ${plan.returns.length === L.fieldTypes(ag.name).size ? `the fields of ${ag.name}` : `${plan.returns.join(", ")} of ${ag.name}`} (validated when read).`);
    // Prettier breaks the member chain: `z` / `.strictObject({ … })` / `.readonly()`.
    c.line(`export const ${itemName(plan)}Schema = z`);
    c.indent(() => c.block(".strictObject(", () => c.lines_(itemFields), ")").line(".readonly();"));
    c.line(`export type ${itemName(plan)} = z.output<typeof ${itemName(plan)}Schema>;`);
    imp.type(L.persistenceRuntime, "Page");
    c.line(`export type ${pageName(plan)} = Page<${itemName(plan)}>;`);
    // Spec.
    imp.type(L.persistenceRuntime, "QuerySpec");
    c.line();
    c.doc(`What ${q.name} filters, searches and orders by (column names of the ${plan.table.schema}.${plan.table.name} table). Shared by the readers and the cursor fingerprint.`);
    c.block(`export const ${specName(plan)}: QuerySpec =`, () => {
      c.line(`name: ${tsString(q.name)},`);
      const filters = plan.filters.map(({ filter, column }) => {
        const target = filter.param !== undefined ? `param: ${tsString(prop(filter.param))}` : `value: ${encodedLiteral(filter.value, column)}`;
        return `{ column: ${tsString(column.name)}, kind: ${tsString(valueKind(column))}, op: ${tsString(filter.op)}, ${target} }`;
      });
      // Prettier: an array of one object stays on one line when it fits; several objects break one per line.
      if (filters.length <= 1 && strWidth(`  filters: [${filters.join("")}],`) <= PRINT_WIDTH) c.line(`filters: [${filters.join("")}],`);
      else c.open("filters: [", () => filters.forEach((f) => c.line(`${f},`)), "],");
      if (!plan.search) c.line("search: null,");
      else {
        const s = plan.search;
        c.block("search:", () => {
          c.line(`param: ${tsString(searchProp(plan))},`);
          c.line(`columns: [${s.columns.map((x) => tsString(x.name)).join(", ")}],`);
          c.line(`mode: ${tsString(s.mode)},`);
          c.line(`minSimilarity: ${s.minSimilarity},`);
        }, ",");
      }
      c.open("keys: [", () => {
        for (const k of plan.keys) {
          if (k.relevance) c.line(`{ column: null, kind: "score", direction: "desc" },`);
          else c.line(`{ column: ${tsString(k.column!.name)}, kind: ${tsString(valueKind(k.column!))}, direction: ${tsString(k.direction)} },`);
        }
      }, "],");
      c.line(`size: ${q.page.size},`);
      c.line(`maxSize: ${q.page.maxSize},`);
    }, ";");
    // Reader port.
    imp.type(L.runtime, "Awaitable");
    imp.type(L.persistenceRuntime, "QueryRequest", "QueryResult");
    c.line();
    c.doc(`Reads ${q.name} (PostgresReader in persistence/postgres.ts, InMemory…Reader in testing.ts): one page after \`request.after\`, plus the keys of its last item when more follow.`);
    c.block(`export interface ${readerName(plan)}`, () => {
      const sig = `read(request: QueryRequest<${paramsName(plan)}>): Awaitable<QueryResult<${itemName(plan)}>>;`;
      if (strWidth(`  ${sig}`) <= PRINT_WIDTH) c.line(sig);
      else c.open("read(", () => c.line(`request: QueryRequest<${paramsName(plan)}>,`), `): Awaitable<QueryResult<${itemName(plan)}>>;`);
    });
    // Query service.
    imp.type(L.persistenceRuntime, "CursorCodec");
    imp.value(L.persistenceRuntime, "runQuery");
    imp.value(L.runtime, "parseWith");
    const required = plan.params.some((p) => p.type.k !== "optional");
    const rest = [...(plan.search ? [searchProp(plan)] : []), "cursor", "limit"];
    c.line();
    c.doc(
      [
        ...(q.description ? [q.description, ""] : []),
        `Query ${q.name} (reads ${ag.name}).`,
        "",
        `Validates the input (ConstraintViolation), clamps \`limit\` to ${q.page.maxSize}, checks the cursor (InvalidCursor: tampered, expired, or made for other parameters) and returns a page whose \`nextCursor\` is null at the end.`,
      ].join("\n"),
    );
    c.block(`export class ${queryClass(plan)}`, () => {
      c.line(`readonly #reader: ${readerName(plan)};`);
      c.line("readonly #cursors: CursorCodec;");
      c.line();
      c.block(`constructor(deps: { readonly reader: ${readerName(plan)}; readonly cursors: CursorCodec })`, () => {
        c.line("this.#reader = deps.reader;");
        c.line("this.#cursors = deps.cursors;");
      });
      c.line();
      c.block(`async execute(input: ${inputName(plan)}${required ? "" : " = {}"}): Promise<${pageName(plan)}>`, () => {
        const head = `const { ${rest.join(", ")}${plan.params.length ? ", ...params" : ""} } = parseWith(`;
        const args = [`${inputName(plan)}Schema`, "input", tsString(inputName(plan))];
        if (strWidth(`    ${head}${args.join(", ")});`) <= PRINT_WIDTH) c.line(`${head}${args.join(", ")});`);
        else c.open(head, () => args.forEach((a) => c.line(`${a},`)), ");");
        const search = plan.search ? `search: ${searchProp(plan)}, ` : "";
        c.line(`const page = { ${search}cursor, limit };`);
        c.line(`return await runQuery(${specName(plan)}, this.#cursors, ${plan.params.length ? "params" : "{}"}, page, (request) =>`);
        c.indent(() => c.line("this.#reader.read(request),"));
        c.line(");");
      });
    });
  }
  return file(L, mod, `Queries (read side) of the ${L.ca.ir.name} context: inputs, items, reader ports and query services.`, imp, c.toString());
}

/** Longest accepted search text (core SEARCH_MAX_LENGTH). */
const SEARCH_MAX = 200;

// ---------------------------------------------------------------------------
// persistence/rows.ts
// ---------------------------------------------------------------------------

/** Value objects and entities whose JSON form (model field names) a jsonb column or item holds. */
function jsonTypes(L: TsLayout, tables: TableIR[]): string[] {
  const out: string[] = [];
  const visit = (t: Type) => {
    if (t.k === "optional") visit(t.inner);
    else if (t.k === "list") visit(t.item);
    else if ((t.k === "vo" || t.k === "entity") && !out.includes(t.name)) {
      out.push(t.name);
      L.fieldTypes(t.name).forEach(visit);
    }
  };
  for (const t of tables) for (const c of t.columns) if (c.sql === "jsonb") visit(c.nullable && c.type.k !== "optional" ? c.type : c.type);
  return out;
}

function needsConversion(t: Type): boolean {
  if (t.k === "optional") return needsConversion(t.inner);
  if (t.k === "list") return needsConversion(t.item);
  return t.k === "vo" || t.k === "entity";
}

/** `expr` (a model value) in its JSON form with model field names. */
function toJson(t: Type, expr: string, depth = 0): string {
  if (!needsConversion(t)) return expr;
  if (t.k === "optional") return `${expr} === null ? null : ${toJson(t.inner, expr, depth)}`;
  if (t.k === "list") {
    const x = depth ? `item${depth}` : "item";
    return `${expr}.map((${x}) => ${toJson(t.item, x, depth + 1)})`;
  }
  return `${toJsonName((t as { name: string }).name)}(${expr})`;
}

/** The model value (input form; entities built) of `expr`, a parsed JSON value. */
function fromJson(t: Type, expr: string, imp: TsImports, L: TsLayout, depth = 0): string {
  if (!needsConversion(t)) return expr;
  const x = depth ? `item${depth}` : "item";
  if (t.k === "optional") {
    imp.value(L.persistenceRuntime, "nullable");
    return `nullable(${expr}, (${x}) => ${fromJson(t.inner, x, imp, L, depth + 1)})`;
  }
  if (t.k === "list") {
    imp.value(L.persistenceRuntime, "jsonList");
    return `jsonList(${expr}, (${x}) => ${fromJson(t.item, x, imp, L, depth + 1)})`;
  }
  return `${fromJsonName((t as { name: string }).name)}(${expr})`;
}

/** The value a column binds for an aggregate held in `self`. */
function columnValue(c: ColumnIR, self: string, L: TsLayout): string {
  const access = `${self}.${c.path.map(prop).join(".")}`;
  if (c.sql === "jsonb") {
    const t = c.type;
    if (c.nullable) return `${access} === null ? null : JSON.stringify(${toJson(t, access)})`;
    return `JSON.stringify(${toJson(t, access)})`;
  }
  if (c.sql === "numeric") return c.nullable ? `${access}?.toString() ?? null` : `${access}.toString()`;
  void L;
  return access;
}

/** A row value of `c` decoded to the model's input form. */
function columnDecode(c: ColumnIR, imp: TsImports, L: TsLayout): string {
  const cell = `row.${c.name}`;
  if (c.sql === "bigint") {
    imp.value(L.persistenceRuntime, "sqlInteger");
    return `sqlInteger(${cell})`;
  }
  if (c.sql === "jsonb") {
    imp.value(L.persistenceRuntime, "sqlJson");
    if (c.nullable) {
      imp.value(L.persistenceRuntime, "nullable");
      return `nullable(${cell}, (value) => ${fromJson(c.type, "sqlJson(value)", imp, L)})`;
    }
    return fromJson(c.type, `sqlJson(${cell})`, imp, L);
  }
  return cell;
}

/** `{ field: <decoded>, … }` for the top-level `fields` of a table (value objects rebuilt from their columns). */
function rowObject(table: TableIR, fields: string[], imp: TsImports, L: TsLayout): string[] {
  const build = (prefix: string[], indent: string, only?: string[]): string[] => {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const c of table.columns) {
      if (!(c.path.length > prefix.length && prefix.every((p, i) => c.path[i] === p))) continue;
      const name = c.path[prefix.length]!;
      if (seen.has(name) || (only && !only.includes(name))) continue;
      seen.add(name);
      if (c.path.length === prefix.length + 1) lines.push(`${indent}${prop(name)}: ${columnDecode(c, imp, L)},`);
      else lines.push(`${indent}${prop(name)}: {`, ...build([...prefix, name], `${indent}  `), `${indent}},`);
    }
    return lines;
  };
  return build([], "", fields);
}

export function rowsFile(L: TsLayout): TsFile {
  const mod = L.rows;
  const imp = new TsImports(mod);
  const c = new Code();
  const tables = contextTables(L);
  imp.type(L.persistenceRuntime, "SqlRow");
  for (const t of tables) {
    const ag = t.aggregate;
    imp.value(L.mod("aggregates"), ag);
    c.line();
    c.doc(`Columns of ${t.schema}.${t.name} in the order the INSERT / UPDATE statements bind them.`);
    c.line(`export const ${columnsName(ag)} = [${t.columns.map((x) => tsString(x.name)).join(", ")}] as const;`);
    c.line();
    c.doc(`A ${ag} as a row: what the repository binds and the in-memory readers filter and order on. Value objects are flattened; ${t.columns.some((x) => x.sql === "jsonb") ? "lists, entities and optional value objects are JSON (model field names)." : "there are no jsonb columns."}`);
    c.block(`export function ${toRowName(ag)}(aggregate: ${ag}): SqlRow`, () => {
      c.block("return", () => t.columns.forEach((col) => c.line(`${col.name}: ${columnValue(col, "aggregate", L)},`)), ";");
    });
    c.line();
    c.block(`export function ${toValuesName(ag)}(aggregate: ${ag}): unknown[]`, () => {
      c.line(`const row = ${toRowName(ag)}(aggregate);`);
      c.line(`return ${columnsName(ag)}.map((column) => row[column]);`);
    });
    c.line();
    c.doc(`The ${ag} of a row, validated like any new instance (schemas, normalization, construct-time invariants).`);
    c.block(`export function ${fromRowName(ag)}(row: SqlRow): ${ag}`, () => {
      const lines = rowObject(t, [...L.fieldTypes(ag).keys()], imp, L);
      // The input is validated by `from`; `as never` only skips the static check of the untyped row values.
      c.line(`return ${ag}.from({`);
      c.indent(() => c.lines_(lines));
      c.line("} as never);");
    });
  }
  // JSON forms of value objects and entities inside jsonb columns.
  for (const name of jsonTypes(L, tables)) {
    const isEntity = L.ca.ir.aggregates.some((a) => a.entities.some((e) => e.name === name));
    const fields = [...L.fieldTypes(name).entries()];
    imp.type(L.typeModule(isEntity ? "entity" : "vo"), name);
    c.line();
    c.block(`function ${toJsonName(name)}(value: ${name}): unknown`, () => {
      c.block("return", () => fields.forEach(([f]) => c.line(`${f}: ${toJson(L.tsFieldType(name, f)!, `value.${prop(f)}`)},`)), ";");
    });
    imp.value(L.persistenceRuntime, "jsonField");
    c.line();
    c.block(`function ${fromJsonName(name)}(value: unknown): ${isEntity ? name : "unknown"}`, () => {
      const lines = fields.map(([f]) => `${prop(f)}: ${fromJson(L.tsFieldType(name, f)!, `jsonField(value, ${tsString(f)})`, imp, L)},`);
      if (isEntity) {
        imp.value(L.typeModule("entity"), name);
        c.line(`return ${name}.from({`);
        c.indent(() => c.lines_(lines));
        c.line("} as never);");
      } else c.block("return", () => c.lines_(lines), ";");
    });
  }
  // Items.
  for (const plan of contextPlans(L)) {
    imp.value(L.queries, `${itemName(plan)}Schema`);
    imp.type(L.queries, itemName(plan));
    imp.value(L.runtime, "parseWith");
    c.line();
    c.doc(`One ${plan.query.name} item from a row (the SELECT of the reader, or a row of the in-memory reader).`);
    c.block(`export function ${itemFromRow(plan)}(row: SqlRow): ${itemName(plan)}`, () => {
      c.line(`return parseWith(`);
      c.indent(() => {
        c.line(`${itemName(plan)}Schema,`);
        c.line("{");
        c.indent(() => c.lines_(rowObject(plan.table, plan.returns, imp, L)));
        c.line("},");
        c.line(`${tsString(itemName(plan))},`);
      });
      c.line(");");
    });
  }
  return file(L, mod, `Rows of the ${L.ca.ir.name} tables: aggregates ↔ rows (validated on load), JSON forms of jsonb columns, query items.`, imp, c.toString());
}

// ---------------------------------------------------------------------------
// persistence/postgres.ts
// ---------------------------------------------------------------------------

/** SQL text as a template literal (the generated SQL has no backticks, `${` or backslashes). */
function sqlLiteral(text: string): string {
  if (/[`\\]|\$\{/.test(text)) throw new Error("unexpected character in generated SQL");
  return `\`${text}\``;
}

function argLiteral(a: SqlArg): string {
  switch (a.kind) {
    case "param":
      return `{ param: ${tsString(prop(a.name))} }`;
    case "value":
      return `{ value: ${encodedLiteral(a.value, a.column)} }`;
    case "search":
      return "{ search: true }";
    case "key":
      return `{ key: ${a.index} }`;
    case "limit":
      return "{ limit: true }";
    default:
      throw new Error(`unexpected query argument ${a.kind}`);
  }
}

function rawTemplate(c: Code, head: string, text: string, tail: string): void {
  const [first, ...rest] = sqlLiteral(text).split("\n");
  if (!rest.length) {
    c.line(`${head}${first}${tail}`);
    return;
  }
  c.line(`${head}${first}`);
  // Prettier keeps a template literal as written: its continuation lines start at column 0.
  rest.forEach((l, i) => c.raw(i === rest.length - 1 ? `${l}${tail}` : l));
}

export function postgresFile(L: TsLayout): TsFile {
  const mod = L.postgres;
  const imp = new TsImports(mod);
  const c = new Code();
  imp.type(L.persistenceRuntime, "SqlClient");
  for (const t of contextTables(L)) {
    const ag = t.aggregate;
    const idType = tsType(L.tsFieldType(ag, L.aggregate(ag)!.identity)!, imp, L);
    const sql = repositorySql(t);
    imp.type(L.persistenceRuntime, "TableMapping");
    imp.value(L.persistenceRuntime, "PostgresStore");
    imp.type(L.mod("aggregates"), ag);
    imp.type(L.ports, `${ag}Repository`);
    imp.value(L.rows, toValuesName(ag), fromRowName(ag));
    c.line();
    c.doc(`How ${ag} maps to ${t.schema}.${t.name} (see sql/${t.schema}.sql).`);
    const head = `export const ${tableName(ag)}: TableMapping<${ag}, ${idType}> =`;
    // Prettier breaks long type arguments one per line: `TableMapping<\n  A,\n  K\n> = {`.
    if (strWidth(`${head} {`) > PRINT_WIDTH) c.line(`export const ${tableName(ag)}: TableMapping<`).indent(() => c.line(`${ag},`).line(idType));
    c.block(strWidth(`${head} {`) > PRINT_WIDTH ? "> =" : head, () => {
      c.line(`aggregate: ${tsString(ag)},`);
      rawTemplate(c, "select: ", sql.select.text, ",");
      rawTemplate(c, "insert: ", sql.insert.text, ",");
      rawTemplate(c, "update: ", sql.update.text, ",");
      c.line(`identity: (aggregate) => aggregate.${prop(L.aggregate(ag)!.identity)},`);
      c.line(`toValues: ${toValuesName(ag)},`);
      c.line(`fromRow: ${fromRowName(ag)},`);
    }, ";");
    c.line();
    c.doc(
      `${ag}Repository on PostgreSQL with optimistic locking: \`save\` inserts what it did not load and updates what it loaded only if the row still has the loaded version (else ConcurrencyConflict). Use one instance per unit of work (it remembers the versions it read).`,
    );
    c.block(`export class Postgres${ag}Repository implements ${ag}Repository`, () => {
      c.line(`readonly #store: PostgresStore<${ag}, ${idType}>;`);
      c.line();
      c.block("constructor(client: SqlClient)", () => c.line(`this.#store = new PostgresStore(client, ${tableName(ag)});`));
      c.line();
      c.block(`get(${ident(L.aggregate(ag)!.identity)}: ${idType}): Promise<${ag} | null>`, () => c.line(`return this.#store.get(${ident(L.aggregate(ag)!.identity)});`));
      c.line();
      c.block(`save(aggregate: ${ag}): Promise<void>`, () => c.line("return this.#store.save(aggregate);"));
    });
  }
  for (const plan of contextPlans(L)) {
    const st = queryStatements(plan);
    imp.type(L.persistenceRuntime, "QueryStatements", "QueryRequest", "QueryResult");
    imp.value(L.persistenceRuntime, "readSql");
    imp.value(L.queries, specName(plan));
    imp.type(L.queries, readerName(plan), paramsName(plan), itemName(plan));
    imp.value(L.rows, itemFromRow(plan));
    c.line();
    c.doc(`Statements of ${plan.query.name}: keyset pagination (no OFFSET), ${plan.search ? "with and without the search, " : ""}first and next page.`);
    c.block(`export const ${sqlName(plan)}: QueryStatements =`, () => {
      for (const [key, s] of Object.entries(st)) {
        c.block(`${key}:`, () => {
          rawTemplate(c, "text: ", s.text, ",");
          c.line(`args: [${s.args.map(argLiteral).join(", ")}],`);
        }, ",");
      }
    }, ";");
    c.line();
    c.doc(`${readerName(plan)} on PostgreSQL.`);
    c.block(`export class Postgres${readerName(plan)} implements ${readerName(plan)}`, () => {
      c.line("readonly #client: SqlClient;");
      c.line();
      c.block("constructor(client: SqlClient)", () => c.line("this.#client = client;"));
      c.line();
      method(c, "read", [`request: QueryRequest<${paramsName(plan)}>`], `Promise<QueryResult<${itemName(plan)}>>`, () => {
        c.line(`return readSql(this.#client, ${specName(plan)}, ${sqlName(plan)}, request, ${itemFromRow(plan)});`);
      });
    });
  }
  return file(L, mod, `PostgreSQL adapters of the ${L.ca.ir.name} context: repositories (optimistic locking) and query readers over a node-postgres / PGlite compatible client.`, imp, c.toString());
}

// ---------------------------------------------------------------------------
// testing.ts: in-memory readers
// ---------------------------------------------------------------------------

export function inMemoryReaders(L: TsLayout, c: Code, imp: TsImports): void {
  for (const plan of contextPlans(L)) {
    const ag = plan.aggregate.name;
    imp.value(L.persistenceRuntime, "readRows");
    imp.type(L.persistenceRuntime, "QueryRequest", "QueryResult");
    imp.value(L.queries, specName(plan));
    imp.type(L.queries, readerName(plan), paramsName(plan), itemName(plan));
    imp.value(L.rows, toRowName(ag), itemFromRow(plan));
    imp.type(L.mod("aggregates"), ag);
    c.line();
    c.doc(`In-memory ${readerName(plan)} over a repository's committed aggregates, with the semantics of the generated SQL (filters, ${plan.search ? `${plan.search.mode} search, ` : ""}keyset order).`);
    c.block(`export class InMemory${readerName(plan)} implements ${readerName(plan)}`, () => {
      c.line(`readonly #source: { all(): ReadonlyArray<${ag}> };`);
      c.line();
      c.block(`constructor(source: { all(): ReadonlyArray<${ag}> })`, () => c.line("this.#source = source;"));
      c.line();
      method(c, "read", [`request: QueryRequest<${paramsName(plan)}>`], `QueryResult<${itemName(plan)}>`, () => {
        c.line(`const rows = this.#source.all().map(${toRowName(ag)});`);
        c.line(`return readRows(${specName(plan)}, request, rows, ${itemFromRow(plan)});`);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export const TEST_SECRET = "generated-tests-cursor-secret-0123456789";

/** Given aggregates of the scenarios, deduplicated into module constants. */
class GivenTable {
  readonly consts = new Map<string, string>();
  constructor(
    readonly L: TsLayout,
    readonly aggregate: string,
    readonly imp: TsImports,
  ) {}
  name(rows: QueryScenarioIR["given"]["aggregates"]): string {
    const key = JSON.stringify(rows.map((r) => r.fields));
    let n = this.consts.get(key);
    if (!n) {
      n = `GIVEN_${this.consts.size + 1}`;
      this.consts.set(key, n);
    }
    return n;
  }
  emit(c: Code): void {
    const { L, aggregate, imp } = this;
    imp.type(L.mod("aggregates"), `${aggregate}Input`);
    for (const [key, n] of this.consts) {
      const rows = JSON.parse(key) as Record<string, unknown>[];
      c.line();
      if (!rows.length) c.line(`const ${n}: ReadonlyArray<${aggregate}Input> = [];`);
      else c.open(`const ${n}: ReadonlyArray<${aggregate}Input> = [`, () => rows.forEach((r) => c.line(`${record(aggregate, r, imp, L)},`)), "];");
    }
  }
}

/** A value of `t` different from `avoid` (for "cursor reused with other parameters"). */
function otherValue(L: TsLayout, t: Type, avoid: unknown, imp: TsImports): string {
  const b = t.k === "optional" ? t.inner : t;
  if (b.k === "enum") {
    const values = L.ca.ir.enums.find((e) => e.name === b.name)!.values;
    return inputValue(values.find((v) => v !== avoid) ?? values[0], b, imp, L);
  }
  if (b.k === "ref") return tsString(avoid === "00000000-0000-0000-0000-00000000ffff" ? "00000000-0000-0000-0000-00000000fffe" : "00000000-0000-0000-0000-00000000ffff");
  if (b.k === "primitive") {
    switch (b.name) {
      case "Integer":
        return String(typeof avoid === "number" ? avoid + 1 : 1);
      case "Decimal":
        return tsString(avoid === "1" ? "2" : "1");
      case "Boolean":
        return avoid === true ? "false" : "true";
      case "UUID":
        return tsString(avoid === "00000000-0000-0000-0000-00000000ffff" ? "00000000-0000-0000-0000-00000000fffe" : "00000000-0000-0000-0000-00000000ffff");
      case "DateTime":
        return tsString(avoid === "2000-01-01T00:00:00+00:00" ? "2000-01-02T00:00:00+00:00" : "2000-01-01T00:00:00+00:00");
      case "Date":
        return tsString(avoid === "2000-01-01" ? "2000-01-02" : "2000-01-01");
      default:
        return tsString(`${typeof avoid === "string" ? avoid : ""}~other`);
    }
  }
  return "null";
}

/** `{ status: "active", q: "x" }` as the query's input. */
export function inputObject(L: TsLayout, plan: QueryPlan, params: Record<string, unknown>, imp: TsImports, extra: string[] = []): string {
  const parts: string[] = [];
  for (const p of plan.params) if (p.field.name in params) parts.push(`${prop(p.field.name)}: ${inputValue(params[p.field.name], p.type, imp, L)}`);
  if (plan.search && plan.search.ir.param in params) parts.push(`${searchProp(plan)}: ${tsString(String(params[plan.search.ir.param]))}`);
  parts.push(...extra);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

export function queryTestFile(L: TsLayout, plan: QueryPlan): TsFile {
  const module = L.testModule(plan.query.name);
  const imp = new TsImports(module);
  const c = new Code();
  const ag = plan.aggregate;
  const q = plan.query;
  const given = new GivenTable(L, ag.name, imp);
  imp.value(L.persistenceRuntime, "HmacCursorCodec");
  imp.value(L.queries, queryClass(plan));
  imp.value(L.contextTesting, `InMemory${ag.name}Repository`, `InMemory${readerName(plan)}`);
  imp.value(L.mod("aggregates"), ag.name);
  imp.type(L.mod("aggregates"), `${ag.name}Input`);
  imp.type(L.queries, pageName(plan), inputName(plan));
  const body = new Code();
  const idProjected = plan.returns.includes(ag.identity);
  body.line();
  body.block(`describe(${tsString(q.name)}, () =>`, () => {
    q.scenarios.forEach((sc, i) => {
      if (i) body.line();
      const data = given.name(sc.given.aggregates);
      const then: string[] = [];
      if (sc.then.items) then.push(`items ${spaced(sc.then.items)}`);
      if (sc.then.nextCursor) then.push(`next_cursor ${sc.then.nextCursor}`);
      body.doc([sc.description ?? "Scenario generated from the model.", "", `Given: ${sc.given.aggregates.length} ${ag.name}`, `When: ${spaced(sc.when.params)}${sc.when.limit ? `, limit ${sc.when.limit}` : ""}, ${sc.when.pages} page(s)`, `Then: ${then.join("; ")}`].join("\n"));
      body.block(`test(${tsString(sc.name)}, async () =>`, () => {
        body.line(`const query = setup(${data});`);
        const extra = sc.when.limit !== undefined ? [`limit: ${sc.when.limit}`] : [];
        body.line(`const pages = await fetchPages(query, ${inputObject(L, plan, sc.when.params, imp, extra)}, ${sc.when.pages});`);
        body.line("const items = pages.flatMap((page) => page.items);");
        if (sc.then.items) {
          const items = sc.then.items;
          if (items.every((it) => typeof it !== "object" || it === null) && idProjected) {
            body.line(`expect(items.map((item) => String(item.${prop(ag.identity)}))).toEqual([${items.map((it) => inputValue(it, L.tsFieldType(ag.name, ag.identity)!, imp, L)).join(", ")}]);`);
          } else {
            body.line(`expect(items).toHaveLength(${items.length});`);
            items.forEach((it, j) => {
              if (it !== null && typeof it === "object") {
                for (const [k, v] of Object.entries(it as Record<string, unknown>)) body.line(expectEqual(`items[${j}]?.${prop(k)}`, v, L.tsFieldType(ag.name, k)!, imp, L));
              } else body.line(`expect(String(items[${j}]?.${prop(ag.identity)})).toBe(${inputValue(it, L.tsFieldType(ag.name, ag.identity)!, imp, L)});`);
            });
          }
        }
        if (sc.then.nextCursor === "absent") body.line("expect(pages.at(-1)?.nextCursor).toBeNull();");
        if (sc.then.nextCursor === "present") body.line(`expect(typeof pages.at(-1)?.nextCursor).toBe("string");`);
      }, ");");
    });
    // Paging properties over the data of a scenario that returns at least two items.
    const sample = q.scenarios.find((sc) => (sc.then.items?.length ?? 0) >= 2);
    if (!q.scenarios.length) body.comment("No scenarios: add one with at least two results to generate the paging tests.");
    body.line();
    body.doc(`\`limit\` above the maximum page size (${q.page.maxSize}) is clamped, not rejected; below 1 it is a ConstraintViolation.`);
    body.block(`test("limit is clamped to the maximum page size", async () =>`, () => {
      const data = given.name(sample?.given.aggregates ?? q.scenarios[0]?.given.aggregates ?? []);
      const params = sample?.when.params ?? q.scenarios[0]?.when.params ?? {};
      body.line(`const query = setup(${data});`);
      body.line(`const page = await query.execute(${inputObject(L, plan, params, imp, [`limit: ${q.page.maxSize + 1}`])});`);
      body.line(`expect(page.items.length).toBeLessThanOrEqual(${q.page.maxSize});`);
      imp.value(L.contextTesting, "expectRejects");
      imp.value(L.runtime, "ConstraintViolation");
      body.line(`await expectRejects(() => query.execute(${inputObject(L, plan, params, imp, ["limit: 0"])}), ConstraintViolation);`);
    }, ");");
    if (!sample) {
      body.comment("No scenario expects two or more items: the cursor tests need at least two results.");
      return;
    }
    const data = given.name(sample.given.aggregates);
    const params = sample.when.params;
    const input = inputObject(L, plan, params, imp);
    const withCursor = (cursor: string) => inputObject(L, plan, params, imp, [`cursor: ${cursor}`]);
    body.line();
    body.doc(
      `Paging through ${sample.name}'s data one item at a time gives exactly the single-page result: same items, same order, nothing twice, nothing missing (keyset pagination with the identity as the tie-breaker).`,
    );
    body.block(`test("pages of one item cover the whole result in order", async () =>`, () => {
      imp.value(L.contextTesting, "plain");
      body.line(`const query = setup(${data});`);
      body.line(`const whole = await query.execute(${inputObject(L, plan, params, imp, [`limit: ${q.page.maxSize}`])});`);
      body.line("expect(whole.nextCursor).toBeNull();");
      body.line(`const pages = await fetchPages(query, ${inputObject(L, plan, params, imp, ["limit: 1"])}, whole.items.length + 1);`);
      body.line("expect(pages.every((page) => page.items.length === 1)).toBe(true);");
      body.line("expect(pages.at(-1)?.nextCursor).toBeNull();");
      body.line("expect(plain(pages.flatMap((page) => page.items))).toEqual(plain(whole.items));");
      if (idProjected) {
        body.line(`const ids = pages.flatMap((page) => page.items.map((item) => String(item.${prop(ag.identity)})));`);
        body.line("expect(new Set(ids).size).toBe(ids.length);");
      }
    }, ");");
    body.line();
    body.doc("A cursor whose payload or signature was changed is rejected (it is signed with HMAC-SHA256).");
    body.block(`test("a tampered cursor is rejected", async () =>`, () => {
      imp.value(L.contextTesting, "expectRejects", "expectPresent");
      imp.value(L.persistenceRuntime, "InvalidCursor");
      body.line(`const query = setup(${data});`);
      body.line(`const first = await query.execute(${inputObject(L, plan, params, imp, ["limit: 1"])});`);
      body.line(`const cursor = expectPresent(first.nextCursor, "nextCursor");`);
      body.line(`const tampered = (cursor.startsWith("e") ? "f" : "e") + cursor.slice(1);`);
      body.line(`await expectRejects(() => query.execute(${withCursor("tampered")}), InvalidCursor);`);
      body.line(`const resigned = cursor.slice(0, -2) + (cursor.endsWith("AA") ? "BB" : "AA");`);
      body.line(`await expectRejects(() => query.execute(${withCursor("resigned")}), InvalidCursor);`);
      body.line(`await expectRejects(() => query.execute(${withCursor('"not-a-cursor"')}), InvalidCursor);`);
    }, ");");
    // Another parameter value.
    let changed: string | undefined;
    if (plan.search) changed = inputObject(L, plan, { ...params, [plan.search.ir.param]: `${typeof params[plan.search.ir.param] === "string" ? String(params[plan.search.ir.param]) : ""}zz` }, imp, ["cursor"]);
    else {
      const p = plan.params[0];
      if (p) {
        const parts = plan.params.filter((x) => x !== p && x.field.name in params).map((x) => `${prop(x.field.name)}: ${inputValue(params[x.field.name], x.type, imp, L)}`);
        changed = `{ ${[...parts, `${prop(p.field.name)}: ${otherValue(L, p.type, params[p.field.name], imp)}`, "cursor"].join(", ")} }`;
      }
    }
    if (changed) {
      body.line();
      body.doc("A cursor only continues the query it was made for: with other parameters (or search text) it is rejected instead of returning a wrong page.");
      body.block(`test("a cursor reused with other parameters is rejected", async () =>`, () => {
        imp.value(L.contextTesting, "expectRejects", "expectPresent");
        imp.value(L.persistenceRuntime, "InvalidCursor");
        body.line(`const query = setup(${data});`);
        body.line(`const first = await query.execute(${inputObject(L, plan, params, imp, ["limit: 1"])});`);
        body.line(`const cursor = expectPresent(first.nextCursor, "nextCursor");`);
        body.line(`await expectRejects(() => query.execute(${changed}), InvalidCursor);`);
        body.line(`const next = await query.execute(${inputObject(L, plan, params, imp, ["cursor", "limit: 1"])});`);
        body.line("expect(next.items).toHaveLength(1);");
      }, ");");
    }
    void input;
  }, ");");
  // Module-level helpers (after the body is known, so the given constants are complete).
  c.line();
  c.line(`const cursors = new HmacCursorCodec({ secrets: [${tsString(TEST_SECRET)}] });`);
  given.emit(c);
  c.line();
  c.doc(`A ${queryClass(plan)} over an in-memory repository holding \`aggregates\`.`);
  c.block(`function setup(aggregates: ReadonlyArray<${ag.name}Input>): ${queryClass(plan)}`, () => {
    c.line(`const repository = new InMemory${ag.name}Repository();`);
    c.line(`repository.seed(...aggregates.map((input) => ${ag.name}.from(input)));`);
    c.line(`return new ${queryClass(plan)}({ reader: new InMemory${readerName(plan)}(repository), cursors });`);
  });
  c.line();
  c.doc("Up to `count` pages from the first one, following `nextCursor`.");
  c.line("async function fetchPages(");
  c.indent(() => {
    c.line(`query: ${queryClass(plan)},`);
    c.line(`input: ${inputName(plan)},`);
    c.line("count: number,");
  });
  c.block(`): Promise<${pageName(plan)}[]>`, () => {
    c.line(`const pages: ${pageName(plan)}[] = [];`);
    c.line("let cursor: string | null = null;");
    c.block("for (let i = 0; i < count; i++)", () => {
      c.line("const page = await query.execute({ ...input, cursor });");
      c.line("pages.push(page);");
      c.line("cursor = page.nextCursor;");
      c.line("if (cursor === null) break;");
    });
    c.line("return pages;");
  });
  c.lines_(body.toString().split("\n"));
  return testFile(L, module, `Query ${q.name} (${L.ca.ir.name}): scenarios and keyset paging over the in-memory reader.`, imp, c.toString());
}

/** Field values of every aggregate the context's scenarios mention (for the row mapping tests). */
function sampleAggregates(L: TsLayout): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const q of L.ca.ir.queries ?? []) for (const sc of q.scenarios) for (const a of sc.given.aggregates) if (!out.has(q.from)) out.set(q.from, a.fields);
  for (const uc of L.ca.ir.useCases) for (const sc of uc.scenarios) for (const a of sc.given.aggregates) if (!out.has(a.type)) out.set(a.type, a.fields);
  for (const ag of L.ca.ir.aggregates) for (const sc of ag.scenarios) if (sc.given && !out.has(ag.name)) out.set(ag.name, sc.given.aggregate);
  return out;
}

export function persistenceTestFile(L: TsLayout): TsFile {
  const module = L.testModule("persistence");
  const imp = new TsImports(module);
  const c = new Code();
  const samples = sampleAggregates(L);
  imp.value(L.persistenceRuntime, "HmacCursorCodec", "InvalidCursor", "similarity", "trigrams", "ConcurrencyConflict");
  imp.type(L.persistenceRuntime, "SqlClient", "SqlRow");
  imp.value(L.contextTesting, "expectThrows", "expectRejects", "jsonOf");
  c.line();
  c.doc("A SqlClient that records the statements and answers each with the next scripted rows.");
  c.line("function scripted(");
  c.indent(() => c.line("...answers: SqlRow[][]"));
  c.block("): SqlClient & { readonly texts: string[]; readonly values: unknown[][] }", () => {
    c.line("const texts: string[] = [];");
    c.line("const values: unknown[][] = [];");
    c.block("return", () => {
      c.line("texts,");
      c.line("values,");
      c.block("query(text: string, bound: unknown[])", () => {
        c.line("texts.push(text);");
        c.line("values.push(bound);");
        c.line("return Promise.resolve({ rows: answers.shift() ?? [] });");
      }, ",");
    }, ";");
  });
  c.line();
  c.block(`describe(${tsString(`${L.ca.ir.name} persistence`)}, () =>`, () => {
    let first = true;
    for (const t of contextTables(L)) {
      const ag = t.aggregate;
      const rec = samples.get(ag);
      if (!rec) {
        c.comment(`${ag}: no scenario gives an instance, so its mapping has no generated test.`);
        continue;
      }
      if (!first) c.line();
      first = false;
      imp.value(L.mod("aggregates"), ag);
      imp.value(L.rows, toRowName(ag), fromRowName(ag));
      imp.value(L.postgres, `Postgres${ag}Repository`, tableName(ag));
      c.doc(`A ${ag} written as a row and read back is the same aggregate (validated on load).`);
      c.block(`test(${tsString(`${ag}: row round trip`)}, () =>`, () => {
        c.line(`const aggregate = ${ag}.from(${record(ag, rec, imp, L)});`);
        c.line(`expect(jsonOf(${fromRowName(ag)}(${toRowName(ag)}(aggregate)))).toEqual(jsonOf(aggregate));`);
      }, ");");
      c.line();
      c.doc(
        "Optimistic locking: an aggregate the repository did not load is inserted (version 1); one it loaded is updated only at the loaded version. No row back (a lost race) is a ConcurrencyConflict.",
      );
      c.block(`test(${tsString(`${ag}: insert, update at the loaded version, conflicts`)}, async () =>`, () => {
        c.line(`const aggregate = ${ag}.from(${record(ag, rec, imp, L)});`);
        c.line("const client = scripted([{ version: 1 }], [{ version: 2 }], []);");
        c.line(`const repository = new Postgres${ag}Repository(client);`);
        c.line("await repository.save(aggregate);");
        c.line("await repository.save(aggregate);");
        c.line(`await expectRejects(() => repository.save(aggregate), ConcurrencyConflict);`);
        c.line(`expect(client.texts).toEqual([${tableName(ag)}.insert, ${tableName(ag)}.update, ${tableName(ag)}.update]);`);
        c.line("expect(client.values.map((values) => values.at(-1))).toEqual([");
        c.indent(() => {
          c.line(`${toRowName(ag)}(aggregate).${t.columns[t.columns.length - 1]!.name},`);
          c.line("1,");
          c.line("2,");
        });
        c.line("]);");
        c.line(`const loaded = scripted([{ ...${toRowName(ag)}(aggregate), version: "7" }], []);`);
        c.line(`const other = new Postgres${ag}Repository(loaded);`);
        c.line(`const found = await other.get(aggregate.${prop(L.aggregate(ag)!.identity)});`);
        c.line("expect(jsonOf(found)).toEqual(jsonOf(aggregate));");
        c.line(`await expectRejects(() => other.save(aggregate), ConcurrencyConflict);`);
        c.line("expect(loaded.values[1]?.at(-1)).toBe(7);");
      }, ");");
    }
    c.line();
    c.doc("Cursors are signed: another secret, another fingerprint or an expired token is rejected; rotation accepts the old secret.");
    c.block(`test("cursor codec: signature, fingerprint, rotation and expiry", () =>`, () => {
      c.line(`const old = new HmacCursorCodec({ secrets: [${tsString("old-secret-0123456789-0123456789-0123")}] });`);
      c.line(`const token = old.encode(["a", 1, true], "fingerprint");`);
      c.line(`expect(token).toMatch(/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/);`);
      c.line(`const rotated = new HmacCursorCodec({ secrets: [${tsString("new-secret-0123456789-0123456789-0123")}, ${tsString("old-secret-0123456789-0123456789-0123")}] });`);
      c.line(`expect(rotated.decode(token, "fingerprint")).toEqual(["a", 1, true]);`);
      c.line(`const fresh = new HmacCursorCodec({ secrets: [${tsString("new-secret-0123456789-0123456789-0123")}] });`);
      c.line(`expect(expectThrows(() => fresh.decode(token, "fingerprint"), InvalidCursor).details.reason).toBe("signature");`);
      c.line(`expect(expectThrows(() => rotated.decode(token, "other"), InvalidCursor).details.reason).toBe("mismatch");`);
      c.line("let now = 1_000_000;");
      c.line(`const expiring = new HmacCursorCodec({ secrets: [${tsString("new-secret-0123456789-0123456789-0123")}], ttlSeconds: 60, now: () => now });`);
      c.line(`const short = expiring.encode(["x"], "fingerprint");`);
      c.line(`expect(expiring.decode(short, "fingerprint")).toEqual(["x"]);`);
      c.line("now += 60_000;");
      c.line(`expect(expectThrows(() => expiring.decode(short, "fingerprint"), InvalidCursor).details.reason).toBe("expired");`);
      c.line(`expect(() => new HmacCursorCodec({ secrets: ["short"] })).toThrow();`);
    }, ");");
    c.line();
    c.doc("The in-memory trigram similarity is pg_trgm's (expected values from PostgreSQL's show_trgm / similarity).");
    c.block(`test("trigram similarity follows pg_trgm", () =>`, () => {
      c.line(`expect([...trigrams("staff@example.com")].sort()).toEqual([`);
      c.indent(() => {
        for (const t of PG_TRGM_STAFF) c.line(`${tsString(t)},`);
      });
      c.line("]);");
      c.line(`expect([...trigrams("ab-cd")].sort()).toEqual(["  a", "  c", " ab", " cd", "ab ", "cd "]);`);
      c.line(`expect(similarity("staff@example.com", "staf")).toBe(Math.fround(4 / 19));`);
      c.line(`expect(similarity("abc", "abd")).toBe(Math.fround(2 / 6));`);
      c.line(`expect(similarity("", "abc")).toBe(0);`);
    }, ");");
  }, ");");
  return testFile(L, module, `PostgreSQL mapping, optimistic locking, cursor codec and trigram similarity of the ${L.ca.ir.name} context (no database needed).`, imp, c.toString());
}

/** `show_trgm('staff@example.com')` on PostgreSQL 18 (pg_trgm), sorted. */
export const PG_TRGM_STAFF = ["  c", "  e", "  s", " co", " ex", " st", "aff", "amp", "com", "exa", "ff ", "le ", "mpl", "om ", "ple", "sta", "taf", "xam"];

export { activeKeys, itemColumns, queryParamsOwner };

/** JSON with a space after each separator, so long doc lines can wrap at spaces. */
function spaced(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spaced).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spaced(x)}`).join(", ")}}`;
  return JSON.stringify(v ?? null);
}
