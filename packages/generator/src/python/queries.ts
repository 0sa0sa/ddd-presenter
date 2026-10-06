/**
 * Read side and PostgreSQL persistence of the Python target, for contexts that declare `queries:` (mirrors
 * typescript/queries.ts): application/queries.py, persistence/{rows,postgres}.py, in-memory readers (testing.py) and
 * generated tests. The SQL text comes from the shared emitter (../sql.ts) with psycopg placeholders.
 *
 * Contract: docs/05 §9; decisions: docs/09 §19.
 */
import {
  makePrincipal,
  otherRoles,
  planQuery,
  queryParamsOwner,
  queryScope,
  requiresPrincipal,
  scenarioPrincipal,
  tableOf,
  type ColumnIR,
  type QueryPlan,
  type QueryScenarioIR,
  type TableIR,
  type Type,
} from "@ddd/core";
import { rolesText, rolesTuple, securityModule } from "./security.ts";
import { principalPy } from "./tests.ts";
import { psycopgText, queryStatements, repositorySql, type SqlArg } from "../sql.ts";
import { fieldLines, type PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { assertEquals, Code, Imports, pascal, pyString, pyType, pyValue, toSnake, type ValueContext } from "./support.ts";

export function pyContextPlans(L: Layout): QueryPlan[] {
  return (L.ca.ir.queries ?? []).map((q) => planQuery(L.ca.ir, L.ca.fieldTypes, q)!);
}

export function pyHasQueries(L: Layout): boolean {
  return (L.ca.ir.queries ?? []).length > 0;
}

/** Whether running the query needs an authenticated principal (`security` with roles / authenticated). */
function protectedQuery(L: Layout, plan: QueryPlan): boolean {
  return !!L.model.security && requiresPrincipal(plan.query);
}

/** Principal members the rows are scoped to, with whether the claim may be missing. */
function scopeMembers(L: Layout, plan: QueryPlan): { member: string; optional: boolean }[] {
  const sec = L.model.security;
  if (!sec) return [];
  return queryScope(plan.query).map((member) => ({ member, optional: member !== "id" && !sec.principal.claims.find((c) => c.name === member)?.required }));
}

/** An id of the principal's type other than `id` (a cursor of another principal). */
function otherPrincipalId(L: Layout, id: string): string {
  if (L.model.security!.principal.idType === "UUID") return id === "00000000-0000-4000-8000-0000000000ff" ? "00000000-0000-4000-8000-0000000000fe" : "00000000-0000-4000-8000-0000000000ff";
  return id === "other-principal" ? "another-principal" : "other-principal";
}

function tables(L: Layout): TableIR[] {
  return L.ca.ir.aggregates.map((a) => tableOf(L.ca.ir, L.ca.fieldTypes, a));
}

const Q = (plan: QueryPlan) => pascal(plan.query.name);
const queryClass = (plan: QueryPlan) => `${Q(plan)}Query`;
const readerName = (plan: QueryPlan) => `${Q(plan)}Reader`;
const itemName = (plan: QueryPlan) => `${Q(plan)}Item`;
const inputName = (plan: QueryPlan) => `${Q(plan)}Input`;
const specName = (plan: QueryPlan) => `${plan.query.name.toUpperCase()}_SPEC`;
const sqlName = (plan: QueryPlan) => `${plan.query.name.toUpperCase()}_SQL`;
const itemFromRow = (plan: QueryPlan) => `${plan.query.name}_item_from_row`;
const snake = (aggregate: string) => toSnake(aggregate);
const toRowName = (aggregate: string) => `${snake(aggregate)}_to_row`;
const fromRowName = (aggregate: string) => `${snake(aggregate)}_from_row`;
const toValuesName = (aggregate: string) => `${snake(aggregate)}_to_values`;
const columnsName = (aggregate: string) => `${snake(aggregate).toUpperCase()}_COLUMNS`;
const tableName = (aggregate: string) => `${snake(aggregate).toUpperCase()}_TABLE`;
const adapterName = (aggregate: string, c: ColumnIR) => `_${snake(aggregate).toUpperCase()}_${c.name.toUpperCase()}`;

const SEARCH_MAX = 200;
export const PY_TEST_SECRET = "generated-tests-cursor-secret-0123456789";

function valueKind(c: ColumnIR): string {
  return ({ text: "text", bigint: "integer", numeric: "decimal", boolean: "boolean", uuid: "uuid", timestamptz: "instant", date: "date", jsonb: "text" } as const)[c.sql];
}

function vctxOf(L: Layout, imp: Imports): ValueContext {
  return { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
}

/** A literal filter value as the row holds it (enums as their value, other scalars native). */
function literal(L: Layout, v: unknown, c: ColumnIR, imp: Imports): string {
  if (c.type.k === "enum") return pyString(String(v));
  return pyValue(v, c.type, vctxOf(L, imp));
}

/**
 * `(a, b)` over several lines (magic trailing comma), `()`, or `(a,)` on one line when it fits (ruff format does not
 * treat the comma of a one-element tuple as magic). `depth` is the indentation level of the line.
 */
function tupleLines(c: Code, head: string, items: string[], tail = ",", depth = 1): void {
  if (!items.length) {
    c.line(`${head}()${tail}`);
    return;
  }
  const one = `${head}(${items[0]},)${tail}`;
  if (items.length === 1 && 4 * depth + one.length <= 100) {
    c.line(one);
    return;
  }
  c.line(`${head}(`);
  c.indent(() => items.forEach((x) => c.line(`${x},`)));
  c.line(`)${tail}`);
}

// ---------------------------------------------------------------------------
// application/queries.py
// ---------------------------------------------------------------------------

export function pyQueriesFile(L: Layout): PyFile {
  const mod = L.queries;
  const imp = new ModuleImports(mod);
  const c = new Code();
  imp.from("typing", "Final", "Protocol");
  imp.from(L.runtime, "DomainModel");
  imp.from(L.persistenceRuntime, "CursorCodec", "KeySpec", "Page", "QueryRequest", "QueryResult", "QuerySpec", "run_query");
  for (const plan of pyContextPlans(L)) {
    const q = plan.query;
    const ag = plan.aggregate;
    // Input.
    c.line().line();
    c.line(`class ${inputName(plan)}(DomainModel):`);
    c.indent(() => {
      c.docstring(
        [
          `Input of ${q.name}.`,
          ...(q.description ? ["", q.description] : []),
          "",
          `Parameters are optional unless the model requires them (an absent one disables its filter).${plan.search ? ` \`${plan.search.ir.param}\` is the search text (${plan.search.mode}; blank = no search).` : ""} \`cursor\` is the \`next_cursor\` of the previous page, \`limit\` the page size (default ${q.page.size}, at most ${q.page.maxSize}).`,
        ].join("\n"),
      );
      c.line();
      c.lines_(fieldLines(L, queryParamsOwner(q.name), q.params, imp));
      imp.from("pydantic", "Field");
      if (plan.search) c.line(`${plan.search.ir.param}: str | None = Field(default=None, max_length=${SEARCH_MAX})`);
      c.line("cursor: str | None = Field(default=None, max_length=4096)");
      c.line("limit: int | None = Field(default=None, ge=1)");
    });
    // Item.
    c.line().line();
    c.line(`class ${itemName(plan)}(DomainModel):`);
    c.indent(() => {
      c.docstring(`One result of ${q.name}: ${plan.returns.length === L.fieldTypes(ag.name).size ? `the fields of ${ag.name}` : `${plan.returns.join(", ")} of ${ag.name}`} (validated when read).`);
      c.line();
      c.lines_(fieldLines(L, ag.name, ag.fields.filter((f) => plan.returns.includes(f.name)), imp));
    });
    // Spec.
    c.line().line();
    c.line(`# What ${q.name} filters, searches and orders by (columns of ${plan.table.schema}.${plan.table.name}).`);
    c.line(`${specName(plan)}: Final = QuerySpec(`);
    c.indent(() => {
      c.line(`name=${pyString(q.name)},`);
      if (plan.filters.length) imp.from(L.persistenceRuntime, "FilterSpec");
      tupleLines(
        c,
        "filters=",
        plan.filters.map(({ filter, column }) => {
          const target =
            filter.param !== undefined ? `param=${pyString(filter.param)}` : filter.principal !== undefined ? `principal=${pyString(filter.principal)}` : `value=${literal(L, filter.value, column, imp)}`;
          return `FilterSpec(column=${pyString(column.name)}, kind=${pyString(valueKind(column))}, op=${pyString(filter.op)}, ${target})`;
        }),
      );
      if (!plan.search) c.line("search=None,");
      else {
        imp.from(L.persistenceRuntime, "SearchSpec");
        const s = plan.search;
        const cols = s.columns.map((x) => pyString(x.name));
        c.line("search=SearchSpec(");
        c.indent(() => {
          c.line(`param=${pyString(s.ir.param)},`);
          c.line(`columns=(${cols.join(", ")}${cols.length === 1 ? "," : ""}),`);
          c.line(`mode=${pyString(s.mode)},`);
          c.line(`min_similarity=${s.minSimilarity},`);
        });
        c.line("),");
      }
      tupleLines(
        c,
        "keys=",
        plan.keys.map((k) => (k.relevance ? 'KeySpec(column=None, kind="score", direction="desc")' : `KeySpec(column=${pyString(k.column!.name)}, kind=${pyString(valueKind(k.column!))}, direction=${pyString(k.direction)})`)),
      );
      c.line(`size=${q.page.size},`);
      c.line(`max_size=${q.page.maxSize},`);
    });
    c.line(")");
    // Reader port.
    c.line().line();
    c.line(`class ${readerName(plan)}(Protocol):`);
    c.indent(() => {
      c.docstring(`Reads ${q.name}: one page after \`request.after\`, plus the keys of its last item when more follow.`);
      c.line();
      c.line(`def read(self, request: QueryRequest) -> QueryResult[${itemName(plan)}]: ...`);
    });
    // Query service.
    const secured = protectedQuery(L, plan);
    const scope = scopeMembers(L, plan);
    const required = secured || plan.params.some((p) => p.type.k !== "optional");
    const auth = q.authorize;
    c.line().line();
    c.line(`class ${queryClass(plan)}:`);
    c.indent(() => {
      c.docstring(
        [
          ...(q.description ? [q.description, ""] : []),
          `Query ${q.name} (reads ${ag.name}).`,
          ...(secured
            ? [
                "",
                `Authorize: ${rolesText(auth!.roles)}. \`principal\` is checked first, before anything is read: Unauthenticated without one${[...(auth!.roles.length ? ["without a required role"] : []), ...scope.filter((m) => m.optional).map((m) => `without principal.${m.member}`)].map((x, i) => `${i ? " or " : ", NotAuthorized "}${x}`).join("")}.${scope.length ? ` The rows are scoped to the caller (${scope.map((m) => `principal.${m.member}`).join(", ")}), in SQL like every filter.` : ""} Cursors are bound to the principal.`,
              ]
            : L.model.security && auth?.kind === "public"
              ? ["", "Authorize: public (no principal needed)."]
              : []),
          "",
          `Validates the input (ConstraintViolation), clamps \`limit\` to ${q.page.maxSize}, checks the cursor (InvalidCursor: tampered, expired, or made for other parameters${secured ? " or another principal" : ""}) and returns a page whose \`next_cursor\` is None at the end.`,
        ].join("\n"),
      );
      c.line();
      c.line(`def __init__(self, *, reader: ${readerName(plan)}, cursors: CursorCodec) -> None:`);
      c.indent(() => {
        c.line("self._reader = reader");
        c.line("self._cursors = cursors");
      });
      c.line();
      const sig = `def execute(self, params: ${inputName(plan)}${required ? "" : " | None = None"}${secured ? ", principal: Principal | None" : ""}) -> Page[${itemName(plan)}]:`;
      if (secured) imp.from(securityModule(L.model), "Principal");
      if (4 + sig.length <= 100) c.line(sig);
      else {
        c.line("def execute(");
        c.indent(() => {
          c.line("self,");
          c.line(`params: ${inputName(plan)}${required ? "" : " | None = None"},`);
          if (secured) c.line("principal: Principal | None,");
        });
        c.line(`) -> Page[${itemName(plan)}]:`);
      }
      c.indent(() => {
        if (secured) {
          imp.from(securityModule(L.model), "authorize");
          c.line(`principal = authorize(principal, ${pyString(q.name)}, ${rolesTuple(auth!.roles)})`);
          for (const m of scope.filter((x) => x.optional)) {
            imp.from(securityModule(L.model), "NotAuthorized");
            c.line(`${m.member} = principal.${m.member}`);
            c.line(`if ${m.member} is None:`);
            c.indent(() => c.line(`raise NotAuthorized(action=${pyString(q.name)}, missing_claim=${pyString(m.member)})`));
          }
        }
        c.line(required ? "query = params" : `query = params if params is not None else ${inputName(plan)}()`);
        c.line("return run_query(");
        c.indent(() => {
          c.line(`${specName(plan)},`);
          c.line("self._cursors,");
          c.line(`{${plan.params.map((p) => `${pyString(p.field.name)}: query.${p.field.name}`).join(", ")}},`);
          c.line(`search=${plan.search ? `query.${plan.search.ir.param}` : "None"},`);
          c.line("cursor=query.cursor,");
          c.line("limit=query.limit,");
          c.line("read=self._reader.read,");
          if (secured) {
            imp.from(L.persistenceRuntime, "QueryScope");
            const values = scope.map((m) => `${pyString(m.member)}: ${m.optional ? m.member : `principal.${m.member}`}`);
            const one = `scope=QueryScope(principal=str(principal.id), values={${values.join(", ")}}),`;
            if (12 + one.length <= 100) c.line(one);
            else {
              c.line("scope=QueryScope(");
              c.indent(() => {
                c.line("principal=str(principal.id),");
                c.line(`values={${values.join(", ")}},`);
              });
              c.line("),");
            }
          }
        });
        c.line(")");
      });
    });
  }
  return { path: L.path(mod), content: assemble(L.model, `Queries (read side) of the ${L.ca.ir.name} context: inputs, items, reader ports and query services.`, imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// persistence/rows.py
// ---------------------------------------------------------------------------

function pathAccess(self: string, c: ColumnIR): string {
  return `${self}.${c.path.join(".")}`;
}

function columnValue(t: TableIR, c: ColumnIR): string {
  const access = pathAccess("aggregate", c);
  const wrap = (v: string) => (c.nullable ? `None if ${access} is None else ${v}` : v);
  if (c.sql === "jsonb") return wrap(`${adapterName(t.aggregate, c)}.dump_json(${access}).decode()`);
  if (c.type.k === "enum") return wrap(`${access}.value`);
  return access;
}

function decode(c: ColumnIR): string {
  return c.sql === "jsonb" ? `sql_json(row[${pyString(c.name)}])` : `row[${pyString(c.name)}]`;
}

/** `{"field": <decoded>, …}` lines for the top-level `fields` (value objects rebuilt from their columns). */
function rowDict(table: TableIR, fields: string[]): string[] {
  const build = (prefix: string[], indent: string, only?: string[]): string[] => {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const c of table.columns) {
      if (!(c.path.length > prefix.length && prefix.every((p, i) => c.path[i] === p))) continue;
      const name = c.path[prefix.length]!;
      if (seen.has(name) || (only && !only.includes(name))) continue;
      seen.add(name);
      if (c.path.length === prefix.length + 1) lines.push(`${indent}${pyString(name)}: ${decode(c)},`);
      else lines.push(`${indent}${pyString(name)}: {`, ...build([...prefix, name], `${indent}    `), `${indent}},`);
    }
    return lines;
  };
  return build([], "", fields);
}

export function pyRowsFile(L: Layout): PyFile {
  const mod = L.rows;
  const imp = new ModuleImports(mod);
  const c = new Code();
  imp.from("typing", "Any", "Final");
  imp.from("collections.abc", "Mapping");
  for (const t of tables(L)) {
    const ag = t.aggregate;
    imp.from(L.mod("aggregates"), ag);
    c.line().line();
    const json = t.columns.filter((x) => x.sql === "jsonb");
    for (const col of json) {
      imp.from("pydantic", "TypeAdapter");
      c.line(`${adapterName(ag, col)}: Final = TypeAdapter(${pyType(col.type, imp, L.typeModule, { field: true })})`);
    }
    if (json.length) imp.from(L.persistenceRuntime, "sql_json");
    c.line(`# Columns of ${t.schema}.${t.name} in the order the INSERT / UPDATE statements bind them.`);
    c.line(`${columnsName(ag)}: Final = (`);
    c.indent(() => t.columns.forEach((x) => c.line(`${pyString(x.name)},`)));
    c.line(")");
    c.line().line();
    c.line(`def ${toRowName(ag)}(aggregate: ${ag}) -> dict[str, object]:`);
    c.indent(() => {
      c.docstring(`A ${ag} as a row: what the repository binds and the in-memory readers filter and order on. Value objects are flattened; lists, entities and optional value objects are JSON (model field names).`);
      c.line("return {");
      c.indent(() => t.columns.forEach((col) => c.line(`${pyString(col.name)}: ${columnValue(t, col)},`)));
      c.line("}");
    });
    c.line().line();
    c.line(`def ${toValuesName(ag)}(aggregate: ${ag}) -> list[object]:`);
    c.indent(() => {
      c.line(`row = ${toRowName(ag)}(aggregate)`);
      c.line(`return [row[column] for column in ${columnsName(ag)}]`);
    });
    c.line().line();
    c.line(`def ${fromRowName(ag)}(row: Mapping[str, Any]) -> ${ag}:`);
    c.indent(() => {
      c.docstring(`The ${ag} of a row, validated like any new instance (constraints, normalization, invariants).`);
      c.line(`return ${ag}.model_validate(`);
      c.indent(() => {
        c.line("{");
        c.indent(() => c.lines_(rowDict(t, [...L.fieldTypes(ag).keys()])));
        c.line("}");
      });
      c.line(")");
    });
  }
  for (const plan of pyContextPlans(L)) {
    imp.from(L.queries, itemName(plan));
    if (plan.table.columns.some((x) => x.sql === "jsonb" && plan.returns.includes(x.path[0]!))) imp.from(L.persistenceRuntime, "sql_json");
    c.line().line();
    c.line(`def ${itemFromRow(plan)}(row: Mapping[str, Any]) -> ${itemName(plan)}:`);
    c.indent(() => {
      c.docstring(`One ${plan.query.name} item from a row (the reader's SELECT, or a row of the in-memory reader).`);
      c.line(`return ${itemName(plan)}.model_validate(`);
      c.indent(() => {
        c.line("{");
        c.indent(() => c.lines_(rowDict(plan.table, plan.returns)));
        c.line("}");
      });
      c.line(")");
    });
  }
  return { path: L.path(mod), content: assemble(L.model, `Rows of the ${L.ca.ir.name} tables: aggregates ↔ rows (validated on load) and query items.`, imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// persistence/postgres.py
// ---------------------------------------------------------------------------

function sqlLiteral(text: string): string {
  if (/"""|\\/.test(text)) throw new Error("unexpected character in generated SQL");
  return `"""${psycopgText(text)}"""`;
}

/** `head"""first` … `last"""tail` with the continuation lines of the string at column 0. */
function rawString(c: Code, head: string, text: string, tail: string): void {
  const lines = sqlLiteral(text).split("\n");
  if (lines.length === 1) {
    c.line(`${head}${lines[0]}${tail}`);
    return;
  }
  c.line(`${head}${lines[0]}`);
  lines.slice(1).forEach((l, i, a) => c.raw(i === a.length - 1 ? `${l}${tail}` : l));
}

function argLiteral(L: Layout, a: SqlArg, imp: Imports): string {
  switch (a.kind) {
    case "param":
      return `("param", ${pyString(a.name)})`;
    case "value":
      return `("value", ${literal(L, a.value, a.column, imp)})`;
    case "principal":
      return `("principal", ${pyString(a.name)})`;
    case "search":
      return '("search", None)';
    case "key":
      return `("key", ${a.index})`;
    case "limit":
      return '("limit", None)';
    default:
      throw new Error(`unexpected query argument ${a.kind}`);
  }
}

export function pyPostgresFile(L: Layout): PyFile {
  const mod = L.postgres;
  const imp = new ModuleImports(mod);
  const c = new Code();
  imp.from("typing", "Final");
  imp.from(L.persistenceRuntime, "SqlConnection");
  for (const t of tables(L)) {
    const ag = t.aggregate;
    const agIr = L.ca.ir.aggregates.find((a) => a.name === ag)!;
    const idType = pyType(L.fieldTypes(ag).get(agIr.identity)!, imp, L.typeModule, { field: false });
    const sql = repositorySql(t);
    imp.from(L.persistenceRuntime, "PostgresStore", "TableMapping");
    imp.from(L.mod("aggregates"), ag);
    imp.from(L.rows, toValuesName(ag), fromRowName(ag));
    c.line().line();
    c.line(`# How ${ag} maps to ${t.schema}.${t.name} (see sql/${t.schema}.sql).`);
    c.line(`${tableName(ag)}: Final[TableMapping[${ag}, ${idType}]] = TableMapping(`);
    c.indent(() => {
      c.line(`aggregate=${pyString(ag)},`);
      rawString(c, "select=", sql.select.text, ",");
      rawString(c, "insert=", sql.insert.text, ",");
      rawString(c, "update=", sql.update.text, ",");
      c.line(`identity=lambda aggregate: aggregate.${agIr.identity},`);
      c.line(`to_values=${toValuesName(ag)},`);
      c.line(`from_row=${fromRowName(ag)},`);
    });
    c.line(")");
    c.line().line();
    c.line(`class Postgres${ag}Repository:`);
    c.indent(() => {
      c.docstring(
        `${ag}Repository on PostgreSQL with optimistic locking: \`save\` inserts what it did not load and updates what it loaded only if the row still has the loaded version (else ConcurrencyConflict). Use one instance per unit of work (it remembers the versions it read).`,
      );
      c.line();
      c.line("def __init__(self, connection: SqlConnection) -> None:");
      c.indent(() => c.line(`self._store = PostgresStore(connection, ${tableName(ag)})`));
      c.line();
      c.line(`def get(self, ${agIr.identity}: ${idType}) -> ${ag} | None:`);
      c.indent(() => c.line(`return self._store.get(${agIr.identity})`));
      c.line();
      c.line(`def save(self, aggregate: ${ag}) -> None:`);
      c.indent(() => c.line("self._store.save(aggregate)"));
    });
  }
  const KEYS: Record<string, string> = { first: "first", next: "next", searchFirst: "search_first", searchNext: "search_next" };
  for (const plan of pyContextPlans(L)) {
    imp.from(L.persistenceRuntime, "QueryRequest", "QueryResult", "QueryStatements", "SqlStatement", "read_sql");
    imp.from(L.queries, specName(plan), itemName(plan));
    imp.from(L.rows, itemFromRow(plan));
    c.line().line();
    c.line(`# Statements of ${plan.query.name}: keyset pagination (no OFFSET), first and next page${plan.search ? ", with and without the search" : ""}.`);
    c.line(`${sqlName(plan)}: Final = QueryStatements(`);
    c.indent(() => {
      for (const [key, s] of Object.entries(queryStatements(plan))) {
        c.line(`${KEYS[key]}=SqlStatement(`);
        c.indent(() => {
          rawString(c, "text=", s.text, ",");
          tupleLines(c, "args=", s.args.map((a) => argLiteral(L, a, imp)), ",", 2);
        });
        c.line("),");
      }
    });
    c.line(")");
    c.line().line();
    c.line(`class Postgres${readerName(plan)}:`);
    c.indent(() => {
      c.docstring(`${readerName(plan)} on PostgreSQL.`);
      c.line();
      c.line("def __init__(self, connection: SqlConnection) -> None:");
      c.indent(() => c.line("self._connection = connection"));
      c.line();
      c.line(`def read(self, request: QueryRequest) -> QueryResult[${itemName(plan)}]:`);
      c.indent(() => c.line(`return read_sql(self._connection, ${specName(plan)}, ${sqlName(plan)}, request, ${itemFromRow(plan)})`));
    });
  }
  return { path: L.path(mod), content: assemble(L.model, `PostgreSQL adapters of the ${L.ca.ir.name} context: repositories (optimistic locking) and query readers over a psycopg 3 compatible connection.`, imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// testing.py: in-memory readers
// ---------------------------------------------------------------------------

export function pyInMemoryReaders(L: Layout, c: Code, imp: Imports): void {
  for (const plan of pyContextPlans(L)) {
    const ag = plan.aggregate.name;
    imp.from(L.persistenceRuntime, "QueryRequest", "QueryResult", "read_rows");
    imp.from(L.queries, specName(plan), itemName(plan));
    imp.from(L.rows, toRowName(ag), itemFromRow(plan));
    c.line().line();
    c.line(`class InMemory${readerName(plan)}:`);
    c.indent(() => {
      c.docstring(`In-memory ${readerName(plan)} over a repository's committed aggregates, with the semantics of the generated SQL.`);
      c.line();
      c.line(`def __init__(self, source: InMemory${ag}Repository) -> None:`);
      c.indent(() => c.line("self._source = source"));
      c.line();
      c.line(`def read(self, request: QueryRequest) -> QueryResult[${itemName(plan)}]:`);
      c.indent(() => {
        c.line(`rows = [${toRowName(ag)}(aggregate) for aggregate in self._source.all()]`);
        c.line(`return read_rows(${specName(plan)}, request, rows, ${itemFromRow(plan)})`);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function construct(L: Layout, name: string, rec: Record<string, unknown>, imp: Imports): string {
  const args = [...L.fieldTypes(name).entries()].filter(([k]) => k in rec).map(([k, t]) => `${k}=${pyValue(rec[k], t, vctxOf(L, imp))}`);
  return `${name}(${args.join(", ")})`;
}

class Givens {
  readonly consts = new Map<string, string>();
  name(rows: QueryScenarioIR["given"]["aggregates"]): string {
    const key = JSON.stringify(rows.map((r) => r.fields));
    let n = this.consts.get(key);
    if (!n) {
      n = `GIVEN_${this.consts.size + 1}`;
      this.consts.set(key, n);
    }
    return n;
  }
}

/** `SearchMembersInput(status=MemberStatus.ACTIVE, q="x", limit=1)`. */
function inputCall(L: Layout, plan: QueryPlan, params: Record<string, unknown>, imp: Imports, extra: string[] = []): string {
  const parts: string[] = [];
  for (const p of plan.params) if (p.field.name in params) parts.push(`${p.field.name}=${pyValue(params[p.field.name], p.type, vctxOf(L, imp))}`);
  if (plan.search && plan.search.ir.param in params) parts.push(`${plan.search.ir.param}=${pyString(String(params[plan.search.ir.param]))}`);
  parts.push(...extra);
  return `${inputName(plan)}(${parts.join(", ")})`;
}

function otherValue(L: Layout, t: Type, avoid: unknown, imp: Imports): string {
  const b = t.k === "optional" ? t.inner : t;
  const v = vctxOf(L, imp);
  if (b.k === "enum") {
    const values = L.ca.ir.enums.find((e) => e.name === b.name)!.values;
    return pyValue(values.find((x) => x !== avoid) ?? values[0], b, v);
  }
  if (b.k === "ref") return pyValue("00000000-0000-0000-0000-00000000ffff", b, v);
  if (b.k === "primitive") {
    switch (b.name) {
      case "Integer":
        return String(typeof avoid === "number" ? avoid + 1 : 1);
      case "Decimal":
        return pyValue(avoid === "1" ? "2" : "1", b, v);
      case "Boolean":
        return avoid === true ? "False" : "True";
      case "UUID":
        return pyValue("00000000-0000-0000-0000-00000000ffff", b, v);
      case "DateTime":
        return pyValue("2000-01-01T00:00:00+00:00", b, v);
      case "Date":
        return pyValue("2000-01-01", b, v);
      default:
        return pyString(`${typeof avoid === "string" ? avoid : ""}~other`);
    }
  }
  return "None";
}

export function pyQueryTestFile(L: Layout, plan: QueryPlan): PyFile {
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.from("collections.abc", "Sequence");
  const c = new Code();
  const body = new Code();
  const q = plan.query;
  const ag = plan.aggregate;
  const givens = new Givens();
  const idProjected = plan.returns.includes(ag.identity);
  const idType = L.fieldTypes(ag.name).get(ag.identity)!;
  imp.from(L.persistenceRuntime, "HmacCursorCodec", "Page");
  imp.from(L.queries, queryClass(plan), inputName(plan), itemName(plan));
  imp.from(L.testing, `InMemory${ag.name}Repository`, `InMemory${readerName(plan)}`);
  imp.from(L.mod("aggregates"), ag.name);
  const sec = L.model.security;
  const secured = protectedQuery(L, plan);
  /** `query.execute(params)`, plus the test's principal for a protected query. */
  const exec = (query: string, input: string) => `${query}.execute(${input}${secured ? ", principal" : ""})`;
  /** Declares `principal` (the caller of a scenario) for a protected query. */
  const caller = (sc: QueryScenarioIR | undefined) => {
    if (secured) body.line(`principal = ${principalPy(L, scenarioPrincipal(sec!, q, sc ?? { given: {} }), imp)}`);
  };
  for (const sc of q.scenarios) {
    const data = givens.name(sc.given.aggregates);
    body.line().line();
    body.line(`def test_${sc.name}() -> None:`);
    body.indent(() => {
      const then: string[] = [];
      if (sc.then.items) then.push(`items ${spaced(sc.then.items)}`);
      if (sc.then.nextCursor) then.push(`next_cursor ${sc.then.nextCursor}`);
      body.docstring([sc.description ?? "Scenario generated from the model.", "", `Given: ${sc.given.aggregates.length} ${ag.name}`, `When: ${spaced(sc.when.params)}${sc.when.limit ? `, limit ${sc.when.limit}` : ""}, ${sc.when.pages} page(s)`, `Then: ${then.join("; ")}`].join("\n"));
      const extra = sc.when.limit !== undefined ? [`limit=${sc.when.limit}`] : [];
      caller(sc);
      body.line(`pages = _fetch_pages(_setup(${data}), ${inputCall(L, plan, sc.when.params, imp, extra)}, ${sc.when.pages}${secured ? ", principal" : ""})`);
      body.line("items = [item for page in pages for item in page.items]");
      const items = sc.then.items;
      if (items) {
        if (items.every((it) => typeof it !== "object" || it === null) && idProjected) {
          body.line(`assert [item.${ag.identity} for item in items] == [${items.map((it) => pyValue(it, idType, vctxOf(L, imp))).join(", ")}]`);
        } else {
          body.line(`assert len(items) == ${items.length}`);
          items.forEach((it, j) => {
            if (it !== null && typeof it === "object") {
              for (const [k, v] of Object.entries(it as Record<string, unknown>)) body.line(assertEquals(`items[${j}].${k}`, pyValue(v, L.fieldTypes(ag.name).get(k)!, vctxOf(L, imp))));
            } else body.line(assertEquals(`items[${j}].${ag.identity}`, pyValue(it, idType, vctxOf(L, imp))));
          });
        }
      }
      if (sc.then.nextCursor === "absent") body.line("assert pages[-1].next_cursor is None");
      if (sc.then.nextCursor === "present") body.line("assert pages[-1].next_cursor is not None");
    });
  }
  const sample = q.scenarios.find((sc) => (sc.then.items?.length ?? 0) >= 2);
  const params = sample?.when.params ?? q.scenarios[0]?.when.params ?? {};
  const clampData = givens.name(sample?.given.aggregates ?? q.scenarios[0]?.given.aggregates ?? []);
  imp.import("pytest");
  imp.from(L.runtime, "ConstraintViolation");
  body.line().line();
  body.line("def test_limit_is_clamped_to_the_maximum_page_size() -> None:");
  body.indent(() => {
    body.docstring(`\`limit\` above the maximum page size (${q.page.maxSize}) is clamped, not rejected; below 1 it is a ConstraintViolation.`);
    caller(sample ?? q.scenarios[0]);
    body.line(`page = ${exec(`_setup(${clampData})`, inputCall(L, plan, params, imp, [`limit=${q.page.maxSize + 1}`]))}`);
    body.line(`assert len(page.items) <= ${q.page.maxSize}`);
    body.line("with pytest.raises(ConstraintViolation):");
    body.indent(() => body.line(`${inputCall(L, plan, params, imp, ["limit=0"])}`));
  });
  if (secured && (q.scenarios[0] || !plan.params.some((p) => p.type.k !== "optional"))) {
    const auth = q.authorize!;
    const base = scenarioPrincipal(sec!, q, q.scenarios[0] ?? { given: {} });
    const lacking = auth.roles.length ? otherRoles(sec!, auth) : undefined;
    const missing = scopeMembers(L, plan).filter((m) => m.optional);
    const secMod = securityModule(L.model);
    imp.from(secMod, "Unauthenticated");
    if (lacking || missing.length) imp.from(secMod, "NotAuthorized");
    body.line().line();
    body.line("def test_authorization_is_refused_before_anything_is_read() -> None:");
    body.indent(() => {
      body.docstring(
        [
          `${q.name} checks the caller first: without a principal Unauthenticated${lacking ? `, without ${auth.roles.join(" / ")} NotAuthorized` : ""}${missing.length ? `, without ${missing.map((m) => `principal.${m.member}`).join(" / ")} (the rows are scoped by it) NotAuthorized` : ""}.`,
          "",
          "Nothing is read before: the reader fails the test when called.",
        ].join("\n"),
      );
      body.line(`query = ${queryClass(plan)}(reader=_UnreadableReader(), cursors=CURSORS)`);
      body.line(`params = ${inputCall(L, plan, q.scenarios[0]?.when.params ?? {}, imp)}`);
      body.line("with pytest.raises(Unauthenticated) as anonymous:");
      body.indent(() => body.line("query.execute(params, None)"));
      body.line(`assert anonymous.value.details == {"action": ${pyString(q.name)}}`);
      if (lacking) {
        body.line(`lacking = ${principalPy(L, makePrincipal(sec!, { id: base.id, roles: lacking, claims: base.claims }), imp)}`);
        body.line("with pytest.raises(NotAuthorized) as refused:");
        body.indent(() => body.line("query.execute(params, lacking)"));
        body.line(`assert refused.value.details == {`);
        body.indent(() => {
          body.line(`"action": ${pyString(q.name)},`);
          body.line(`"required_roles": [${auth.roles.map(pyString).join(", ")}],`);
        });
        body.line("}");
      }
      missing.forEach((m) => {
        const p = makePrincipal(sec!, { id: base.id, roles: base.roles, claims: { ...base.claims, [m.member]: null } });
        body.line(`unscoped = ${principalPy(L, p, imp)}`);
        body.line("with pytest.raises(NotAuthorized) as missing:");
        body.indent(() => body.line("query.execute(params, unscoped)"));
        body.line(`assert missing.value.details == {"action": ${pyString(q.name)}, "missing_claim": ${pyString(m.member)}}`);
      });
    });
  }
  if (sample) {
    const data = givens.name(sample.given.aggregates);
    imp.from(L.persistenceRuntime, "InvalidCursor");
    body.line().line();
    body.line("def test_pages_of_one_item_cover_the_whole_result_in_order() -> None:");
    body.indent(() => {
      body.docstring(`Paging through ${sample.name}'s data one item at a time gives exactly the single-page result: same items, same order, nothing twice, nothing missing.`);
      body.line(`query = _setup(${data})`);
      caller(sample);
      body.line(`whole = ${exec("query", inputCall(L, plan, params, imp, [`limit=${q.page.maxSize}`]))}`);
      body.line("assert whole.next_cursor is None");
      body.line(`pages = _fetch_pages(query, ${inputCall(L, plan, params, imp, ["limit=1"])}, len(whole.items) + 1${secured ? ", principal" : ""})`);
      body.line("assert all(len(page.items) == 1 for page in pages)");
      body.line("assert pages[-1].next_cursor is None");
      body.line("paged = [item for page in pages for item in page.items]");
      body.line("assert [item.model_dump() for item in paged] == [item.model_dump() for item in whole.items]");
      if (idProjected) body.line(`assert len({item.${ag.identity} for item in paged}) == len(paged)`);
    });
    body.line().line();
    body.line("def test_a_tampered_cursor_is_rejected() -> None:");
    body.indent(() => {
      body.docstring("A cursor whose payload or signature was changed is rejected (it is signed with HMAC-SHA256).");
      body.line(`query = _setup(${data})`);
      caller(sample);
      body.line(`cursor = ${exec("query", inputCall(L, plan, params, imp, ["limit=1"]))}.next_cursor`);
      body.line("assert cursor is not None");
      body.line('tampered = ("f" if cursor.startswith("e") else "e") + cursor[1:]');
      body.line('resigned = cursor[:-2] + ("BB" if cursor.endswith("AA") else "AA")');
      body.line('for bad in (tampered, resigned, "not-a-cursor"):');
      body.indent(() => {
        body.line("with pytest.raises(InvalidCursor):");
        body.indent(() => body.line(exec("query", inputCall(L, plan, params, imp, ["cursor=bad"]))));
      });
    });
    let changed: string | undefined;
    if (plan.search) changed = inputCall(L, plan, { ...params, [plan.search.ir.param]: `${typeof params[plan.search.ir.param] === "string" ? String(params[plan.search.ir.param]) : ""}zz` }, imp, ["cursor=cursor"]);
    else if (plan.params[0]) {
      const p = plan.params[0];
      const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== p.field.name));
      changed = inputCall(L, plan, rest, imp, [`${p.field.name}=${otherValue(L, p.type, params[p.field.name], imp)}`, "cursor=cursor"]);
    }
    if (changed) {
      body.line().line();
      body.line("def test_a_cursor_reused_with_other_parameters_is_rejected() -> None:");
      body.indent(() => {
        body.docstring("A cursor only continues the query it was made for: with other parameters (or search text) it is rejected instead of returning a wrong page.");
        body.line(`query = _setup(${data})`);
        caller(sample);
        body.line(`cursor = ${exec("query", inputCall(L, plan, params, imp, ["limit=1"]))}.next_cursor`);
        body.line("assert cursor is not None");
        body.line("with pytest.raises(InvalidCursor):");
        body.indent(() => body.line(exec("query", changed!)));
        body.line(`assert len(${exec("query", inputCall(L, plan, params, imp, ["cursor=cursor", "limit=1"]))}.items) == 1`);
      });
    }
    if (secured) {
      const p = scenarioPrincipal(sec!, q, sample);
      const other = makePrincipal(sec!, { id: otherPrincipalId(L, p.id), roles: p.roles, claims: p.claims });
      body.line().line();
      body.line("def test_a_cursor_is_bound_to_the_principal_it_was_issued_to() -> None:");
      body.indent(() => {
        body.docstring("Another caller (same roles and claims, another id) gets InvalidCursor: a leaked cursor cannot page through someone else's result.");
        body.line(`query = _setup(${data})`);
        caller(sample);
        body.line(`cursor = ${exec("query", inputCall(L, plan, params, imp, ["limit=1"]))}.next_cursor`);
        body.line("assert cursor is not None");
        body.line(`other = ${principalPy(L, other, imp)}`);
        body.line("with pytest.raises(InvalidCursor):");
        body.indent(() => body.line(`query.execute(${inputCall(L, plan, params, imp, ["cursor=cursor"])}, other)`));
        body.line(`assert len(${exec("query", inputCall(L, plan, params, imp, ["cursor=cursor", "limit=1"]))}.items) == 1`);
      });
    }
  }
  // Module-level helpers.
  c.line();
  c.line(`CURSORS = HmacCursorCodec([${pyString(PY_TEST_SECRET)}])`);
  for (const [key, n] of givens.consts) {
    const rows = JSON.parse(key) as Record<string, unknown>[];
    c.line();
    c.line(`${n}: tuple[${ag.name}, ...] = (`);
    c.indent(() => rows.forEach((r) => c.line(`${construct(L, ag.name, r, imp)},`)));
    c.line(")");
  }
  c.line().line();
  c.line(`def _setup(aggregates: Sequence[${ag.name}]) -> ${queryClass(plan)}:`);
  c.indent(() => {
    c.line(`repository = InMemory${ag.name}Repository()`);
    c.line("repository.seed(*aggregates)");
    c.line(`return ${queryClass(plan)}(reader=InMemory${readerName(plan)}(repository), cursors=CURSORS)`);
  });
  if (secured) {
    imp.from(L.persistenceRuntime, "QueryRequest", "QueryResult");
    c.line().line();
    c.line("class _UnreadableReader:");
    c.indent(() => {
      c.docstring("A reader that fails the test when read: authorization must come first.");
      c.line();
      c.line(`def read(self, request: QueryRequest) -> QueryResult[${itemName(plan)}]:`);
      c.indent(() => c.line('raise AssertionError("read before authorization")'));
    });
  }
  c.line().line();
  if (secured) {
    imp.from(securityModule(L.model), "Principal");
    c.line("def _fetch_pages(");
    c.indent(() => {
      c.line(`query: ${queryClass(plan)},`);
      c.line(`params: ${inputName(plan)},`);
      c.line("count: int,");
      c.line("principal: Principal | None,");
    });
    c.line(`) -> list[Page[${itemName(plan)}]]:`);
  } else c.line(`def _fetch_pages(query: ${queryClass(plan)}, params: ${inputName(plan)}, count: int) -> list[Page[${itemName(plan)}]]:`);
  c.indent(() => {
    c.docstring("Up to `count` pages from the first one, following `next_cursor`.");
    c.line(`pages: list[Page[${itemName(plan)}]] = []`);
    c.line("cursor: str | None = None");
    c.line("for _ in range(count):");
    c.indent(() => {
      c.line(`page = query.execute(params.model_copy(update={"cursor": cursor})${secured ? ", principal" : ""})`);
      c.line("pages.append(page)");
      c.line("cursor = page.next_cursor");
      c.line("if cursor is None:");
      c.indent(() => c.line("break"));
    });
    c.line("return pages");
  });
  c.lines_(body.toString().split("\n"));
  return { path: L.testPath(q.name), content: assemble(L.model, `Query ${q.name} (${L.ca.ir.name}): scenarios and keyset paging over the in-memory reader.`, imp, c.toString(), { exports: false }) };
}

/** Field values of every aggregate the context's scenarios mention (for the row mapping tests). */
function samples(L: Layout): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const q of L.ca.ir.queries ?? []) for (const sc of q.scenarios) for (const a of sc.given.aggregates) if (!out.has(q.from)) out.set(q.from, a.fields);
  for (const uc of L.ca.ir.useCases) for (const sc of uc.scenarios) for (const a of sc.given.aggregates) if (!out.has(a.type)) out.set(a.type, a.fields);
  for (const ag of L.ca.ir.aggregates) for (const sc of ag.scenarios) if (sc.given && !out.has(ag.name)) out.set(ag.name, sc.given.aggregate);
  return out;
}

/** `show_trgm('staff@example.com')` on PostgreSQL 18 (pg_trgm), sorted. */
const PG_TRGM_STAFF = ["  c", "  e", "  s", " co", " ex", " st", "aff", "amp", "com", "exa", "ff ", "le ", "mpl", "om ", "ple", "sta", "taf", "xam"];

export function pyPersistenceTestFile(L: Layout): PyFile {
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.from("collections.abc", "Mapping", "Sequence");
  imp.from("typing", "Any");
  imp.import("pytest");
  imp.from(L.persistenceRuntime, "ConcurrencyConflict", "HmacCursorCodec", "InvalidCursor", "similarity", "trigrams");
  const c = new Code();
  const data = samples(L);
  c.line().line();
  c.line("class _Cursor:");
  c.indent(() => {
    c.line("def __init__(self, rows: list[dict[str, Any]]) -> None:");
    c.indent(() => c.line("self._rows = rows"));
    c.line();
    c.line("@property");
    c.line("def description(self) -> Sequence[Any] | None:");
    c.indent(() => c.line("return None"));
    c.line();
    c.line("def fetchall(self) -> Sequence[Any]:");
    c.indent(() => c.line("return self._rows"));
  });
  c.line().line();
  c.line("class _ScriptedConnection:");
  c.indent(() => {
    c.docstring("A SqlConnection that records the statements and answers each with the next scripted rows.");
    c.line();
    c.line("def __init__(self, *answers: list[dict[str, Any]]) -> None:");
    c.indent(() => {
      c.line("self._answers = list(answers)");
      c.line("self.queries: list[str] = []");
      c.line("self.params: list[Mapping[str, Any]] = []");
    });
    c.line();
    c.line("def execute(self, query: str, params: Mapping[str, Any]) -> _Cursor:");
    c.indent(() => {
      c.line("self.queries.append(query)");
      c.line("self.params.append(params)");
      c.line("return _Cursor(self._answers.pop(0) if self._answers else [])");
    });
  });
  imp.from("datetime", "UTC", "date", "datetime");
  imp.from("decimal", "Decimal");
  imp.from("uuid", "UUID");
  c.line().line();
  c.line("def _database_row(row: Mapping[str, object]) -> dict[str, Any]:");
  c.indent(() => {
    c.docstring("A row as the generated SELECT returns it: instants and dates as ISO text, numerics and uuids as text.");
    c.line("out: dict[str, Any] = {}");
    c.line("for name, value in row.items():");
    c.indent(() => {
      c.line("if isinstance(value, datetime):");
      c.indent(() => c.line('out[name] = value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")'));
      c.line("elif isinstance(value, (date, Decimal, UUID)):");
      c.indent(() => c.line("out[name] = str(value)"));
      c.line("else:");
      c.indent(() => c.line("out[name] = value"));
    });
    c.line("return out");
  });
  for (const t of tables(L)) {
    const ag = t.aggregate;
    const rec = data.get(ag);
    if (!rec) continue;
    const agIr = L.ca.ir.aggregates.find((a) => a.name === ag)!;
    imp.from(L.mod("aggregates"), ag);
    imp.from(L.rows, toRowName(ag), fromRowName(ag));
    imp.from(L.postgres, `Postgres${ag}Repository`, tableName(ag));
    imp.from(L.ports, `${ag}Repository`);
    const s = snake(ag);
    c.line().line();
    c.line(`def test_${s}_row_round_trip() -> None:`);
    c.indent(() => {
      c.docstring(`A ${ag} written as a row and read back (also in the SELECT's text form) is the same aggregate.`);
      c.line(`aggregate = ${construct(L, ag, rec, imp)}`);
      c.line(`assert ${fromRowName(ag)}(${toRowName(ag)}(aggregate)).same_state_as(aggregate)`);
      c.line(`assert ${fromRowName(ag)}(_database_row(${toRowName(ag)}(aggregate))).same_state_as(aggregate)`);
    });
    const versionParam = `p${t.columns.length + 1}`;
    c.line().line();
    c.line(`def test_${s}_insert_update_at_the_loaded_version_and_conflicts() -> None:`);
    c.indent(() => {
      c.docstring("Optimistic locking: what the repository did not load is inserted (version 1); what it loaded is updated only at the loaded version. No row back (a lost race) is a ConcurrencyConflict.");
      c.line(`aggregate = ${construct(L, ag, rec, imp)}`);
      c.line('connection = _ScriptedConnection([{"version": 1}], [{"version": 2}], [])');
      c.line(`repository: ${ag}Repository = Postgres${ag}Repository(connection)`);
      c.line("repository.save(aggregate)");
      c.line("repository.save(aggregate)");
      c.line("with pytest.raises(ConcurrencyConflict):");
      c.indent(() => c.line("repository.save(aggregate)"));
      c.line(`assert connection.queries == [${tableName(ag)}.insert, ${tableName(ag)}.update, ${tableName(ag)}.update]`);
      c.line(`assert [params.get(${pyString(versionParam)}) for params in connection.params] == [None, 1, 2]`);
      c.line(`loaded = _ScriptedConnection([{**_database_row(${toRowName(ag)}(aggregate)), "version": 7}], [])`);
      c.line(`other = Postgres${ag}Repository(loaded)`);
      c.line(`found = other.get(aggregate.${agIr.identity})`);
      c.line("assert found is not None");
      c.line("assert found.same_state_as(aggregate)");
      c.line("with pytest.raises(ConcurrencyConflict):");
      c.indent(() => c.line("other.save(aggregate)"));
      c.line(`assert loaded.params[1][${pyString(versionParam)}] == 7`);
    });
  }
  const NEW = "new-secret-0123456789-0123456789-0123";
  const OLD = "old-secret-0123456789-0123456789-0123";
  c.line().line();
  c.line("def test_cursor_codec_signature_fingerprint_rotation_and_expiry() -> None:");
  c.indent(() => {
    c.docstring("Cursors are signed: another secret, another fingerprint or an expired token is rejected; rotation accepts the old secret.");
    c.line(`old = HmacCursorCodec([${pyString(OLD)}])`);
    c.line('token = old.encode(["a", 1, True], "fingerprint")');
    c.line(`rotated = HmacCursorCodec([${pyString(NEW)}, ${pyString(OLD)}])`);
    c.line('assert rotated.decode(token, "fingerprint") == ("a", 1, True)');
    c.line("with pytest.raises(InvalidCursor) as signature:");
    c.indent(() => c.line(`HmacCursorCodec([${pyString(NEW)}]).decode(token, "fingerprint")`));
    c.line('assert signature.value.details["reason"] == "signature"');
    c.line("with pytest.raises(InvalidCursor) as mismatch:");
    c.indent(() => c.line('rotated.decode(token, "other")'));
    c.line('assert mismatch.value.details["reason"] == "mismatch"');
    c.line("clock = [1000.0]");
    c.line(`expiring = HmacCursorCodec([${pyString(NEW)}], ttl_seconds=60, now=lambda: clock[0])`);
    c.line('short = expiring.encode(["x"], "fingerprint")');
    c.line('assert expiring.decode(short, "fingerprint") == ("x",)');
    c.line("clock[0] += 60");
    c.line("with pytest.raises(InvalidCursor) as expired:");
    c.indent(() => c.line('expiring.decode(short, "fingerprint")'));
    c.line('assert expired.value.details["reason"] == "expired"');
    c.line('with pytest.raises(ValueError, match="32 characters"):');
    c.indent(() => c.line('HmacCursorCodec(["short"])'));
  });
  c.line().line();
  c.line("def test_trigram_similarity_follows_pg_trgm() -> None:");
  c.indent(() => {
    c.docstring("The in-memory trigram similarity is pg_trgm's (expected values from PostgreSQL's show_trgm / similarity).");
    c.line('assert sorted(trigrams("staff@example.com")) == [');
    c.indent(() => PG_TRGM_STAFF.forEach((t) => c.line(`${pyString(t)},`)));
    c.line("]");
    c.line('assert sorted(trigrams("ab-cd")) == ["  a", "  c", " ab", " cd", "ab ", "cd "]');
    c.line(`assert similarity("staff@example.com", "staf") == ${String(Math.fround(4 / 19))}`);
    c.line(`assert similarity("abc", "abd") == ${String(Math.fround(2 / 6))}`);
    c.line('assert similarity("", "abc") == 0.0');
  });
  return { path: L.testPath("persistence"), content: assemble(L.model, `PostgreSQL mapping, optimistic locking, cursor codec and trigram similarity of the ${L.ca.ir.name} context (no database needed).`, imp, c.toString(), { exports: false }) };
}

/** JSON with a space after each separator, so long doc lines can wrap at spaces. */
function spaced(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spaced).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spaced(x)}`).join(", ")}}`;
  return JSON.stringify(v ?? null);
}
