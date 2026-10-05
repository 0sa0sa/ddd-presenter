/**
 * Language service for *.ddd.yaml: completion, hover, go-to-definition and rename.
 * Pure and browser-safe; used by the Web editor and by the Language Server (VS Code).
 */
import { applyEdits, type EditResult } from "./edit.ts";
import { RELATIONSHIP_PATTERNS, type AggregateIR, type ContextIR, type EntityIR, type FactoryIR, type ModelIR, type OperationIR, type PolicyIR, type StateGuardIR, type StepIR, type UseCaseIR, type ValueObjectIR } from "./ir.ts";
import { parseModel, type ParseResult } from "./parse.ts";
import { PRIMITIVES, resolveType, typeToString, type Type } from "./types.ts";
import { analyzeModel, parseEventRef, type Analysis } from "./validate.ts";
import { formatPath, type Path } from "./diagnostics.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CompletionKind =
  | "key"
  | "type"
  | "error"
  | "aggregate"
  | "event"
  | "field"
  | "parameter"
  | "enumValue"
  | "function"
  | "guard"
  | "variable"
  | "port"
  | "extension"
  | "operation"
  | "factory"
  | "keyword"
  | "value"
  | "context"
  | "useCase";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  /** Text inserted instead of the label (may contain a trailing "(" etc.). */
  insertText?: string;
  /** Lower sorts first. */
  sortRank?: number;
}

export interface CompletionResult {
  /** Replacement range [from, to) in the document. */
  from: number;
  to: number;
  items: CompletionItem[];
}

export interface HoverResult {
  from: number;
  to: number;
  markdown: string;
}

export interface DefinitionResult {
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// Keys and their meaning (completion + hover on keys)
// ---------------------------------------------------------------------------

type Container =
  | "root"
  | "generation"
  | "generation:typescript"
  | "generation:typescript:api"
  | "security"
  | "security:principal"
  | "principalClaim"
  | "security:authentication"
  | "security:rateLimits"
  | "rateLimit"
  | "authorize"
  | "given:principal"
  | "context"
  | "glossary"
  | "error"
  | "enum"
  | "valueObject"
  | "normalize"
  | "field"
  | "constraints"
  | "aggregate"
  | "entity"
  | "invariant"
  | "guard"
  | "parameter"
  | "factory"
  | "operation"
  | "emission"
  | "eventField"
  | "require"
  | "exprMap:changes"
  | "exprMap:factoryFields"
  | "exprMap:args"
  | "extension"
  | "useCase"
  | "policy"
  | "exprMap:policyArgs"
  | "relationship"
  | "step"
  | "step:load"
  | "step:create"
  | "step:invoke"
  | "step:if"
  | "step:let"
  | "scenario:aggregate"
  | "given:aggregate"
  | "when:aggregate"
  | "then:aggregate"
  | "scenario:useCase"
  | "given:useCase"
  | "givenAggregate"
  | "when:useCase"
  | "then:useCase"
  | "expectedState"
  | "expectedEvent"
  | "ids"
  | "data:aggregate"
  | "data:args"
  | "data:givenAggregate"
  | "data:input"
  | "data:expectedState"
  | "data:event"
  | "data:extensions"
  | "data:nested"
  | "unknown";

const TRANSITIONS: Partial<Record<Container, Record<string, Container>>> = {
  root: { generation: "generation", security: "security", contexts: "context", relationships: "relationship" },
  generation: { typescript: "generation:typescript" },
  security: { principal: "security:principal", authentication: "security:authentication", rate_limits: "security:rateLimits" },
  "security:principal": { claims: "principalClaim" },
  "security:rateLimits": { default: "rateLimit" },
  "generation:typescript": { api: "generation:typescript:api" },
  context: {
    glossary: "glossary",
    errors: "error",
    enums: "enum",
    value_objects: "valueObject",
    aggregates: "aggregate",
    extension_points: "extension",
    use_cases: "useCase",
    policies: "policy",
  },
  error: { details: "field" },
  valueObject: { fields: "field", invariants: "invariant", normalize: "normalize" },
  field: { constraints: "constraints" },
  aggregate: {
    fields: "field",
    invariants: "invariant",
    entities: "entity",
    state_guards: "guard",
    factories: "factory",
    operations: "operation",
    scenarios: "scenario:aggregate",
    authorize: "authorize",
    rate_limit: "rateLimit",
  },
  entity: { fields: "field", invariants: "invariant" },
  guard: { parameters: "parameter" },
  factory: { parameters: "parameter", fields: "exprMap:factoryFields", emits: "emission", require: "require" },
  operation: { parameters: "parameter", changes: "exprMap:changes", emits: "emission", require: "require" },
  emission: { fields: "eventField" },
  extension: { parameters: "parameter" },
  useCase: { input: "field", steps: "step", scenarios: "scenario:useCase", authorize: "authorize", rate_limit: "rateLimit" },
  policy: { args: "exprMap:policyArgs" },
  step: { load: "step:load", create: "step:create", invoke: "step:invoke", if: "step:if", let: "step:let" },
  "step:create": { args: "exprMap:args" },
  "step:invoke": { args: "exprMap:args" },
  "step:if": { then: "step", else: "step" },
  "scenario:aggregate": { given: "given:aggregate", when: "when:aggregate", then: "then:aggregate" },
  "given:aggregate": { aggregate: "data:aggregate" },
  "when:aggregate": { construct: "data:aggregate", args: "data:args" },
  "then:aggregate": { state: "data:aggregate", emits: "expectedEvent" },
  "scenario:useCase": { given: "given:useCase", when: "when:useCase", then: "then:useCase" },
  "given:useCase": { aggregates: "givenAggregate", extensions: "data:extensions", ids: "ids", principal: "given:principal" },
  "given:principal": { claims: "data:nested" },
  givenAggregate: { fields: "data:givenAggregate" },
  "when:useCase": { input: "data:input" },
  "then:useCase": { state: "expectedState", emits: "expectedEvent" },
  expectedState: { fields: "data:expectedState" },
  expectedEvent: { fields: "data:event" },
};

function containerOf(chain: string[]): Container {
  let c: Container = "root";
  for (const k of chain) {
    if (c.startsWith("data:")) {
      c = "data:nested";
      continue;
    }
    c = TRANSITIONS[c]?.[k] ?? "unknown";
  }
  return c;
}

const K = (key: string, doc: string) => ({ key, doc });

/** Allowed keys per container, with a one-line meaning shown in completion and hover. */
const KEYS: Partial<Record<Container, { key: string; doc: string }[]>> = {
  root: [
    K("schema_version", "モデル形式の版。現在は 1"),
    K("project", "プロジェクトID（生成物のマニフェストに記録）"),
    K("description", "説明"),
    K("generation", "生成設定（パッケージ名・出力先）"),
    K("security", "認証・認可・レート制限（roles・principal・authentication・rate_limits）。宣言すると全 Use case / Aggregate に authorize が必要"),
    K("contexts", "Bounded context の一覧"),
    K("relationships", "コンテキストマップ（コンテキスト間の関係とイベント契約）"),
  ],
  generation: [
    K("package", "生成するパッケージ名（snake_case。TypeScript では src の下のディレクトリ名）"),
    K("src_dir", "ソースの出力先（既定 src）"),
    K("tests_dir", "テストの出力先（既定 tests）"),
    K("target", "生成する言語: python（既定, Pydantic v2）/ typescript（Zod v4）"),
    K("typescript", "TypeScript の生成設定（test_runner・api）"),
  ],
  "generation:typescript": [
    K("test_runner", "生成テストのランナー: vitest（既定）/ bun"),
    K("api", "HTTP API を生成する（オプトイン）: 契約・サーバーのハンドラ（Web 標準の Request → Response）・TanStack Query のクライアント"),
  ],
  "generation:typescript:api": [
    K("base_path", "全エンドポイントのパスの接頭辞（既定 /api。/ で始め、末尾に / を付けない。なしは \"\"）"),
    K("client", "クライアントのライブラリ: tanstack-query（既定・唯一。@tanstack/react-query v5）"),
  ],
  security: [
    K("roles", "宣言するロール（snake_case）。authorize.roles と has_role(principal, ロール) で使う"),
    K("principal", "呼び出し元の型: id（String / UUID）と claims（allow_if で principal.<名前> として読める）"),
    K("authentication", "認証の方式: scheme（bearer_jwt / custom）・issuer・audience・algorithms・roles_claim・clock_tolerance"),
    K("rate_limits", "レート制限の既定: default: { requests, per, by }"),
  ],
  "security:principal": [K("id", "principal.id の型: String（既定。JWT の sub）/ UUID"), K("claims", "allow_if で読めるクレーム: { name, type, required, claim }")],
  principalClaim: [
    K("name", "principal.<名前> として読む名前（snake_case。id と roles は組み込み）"),
    K("type", "型: String / UUID / Integer / Boolean / List[String]"),
    K("required", "false で省略可能（既定 true。必須のクレームがないトークンは無効）"),
    K("claim", "JWT のクレーム名（既定は name。例: https://example.com/company_id）"),
    K("description", "説明"),
  ],
  "security:authentication": [
    K("scheme", "bearer_jwt（既定。JWT を検証する認証器を生成）/ custom（Authenticator を自分で実装）"),
    K("issuer", "期待する iss（実行時に上書きできる）"),
    K("audience", "期待する aud（実行時に上書きできる）"),
    K("algorithms", "受け付ける署名アルゴリズム（既定 [RS256]。none は不可。HS* と公開鍵方式は混ぜない）"),
    K("roles_claim", "ロールを読むクレーム（既定 roles。リストか空白区切りの文字列）"),
    K("clock_tolerance", "exp / nbf の許容する時計のずれ（秒。既定 30、最大 300）"),
  ],
  "security:rateLimits": [K("default", "rate_limit を書かないエンドポイントの制限: { requests, per, by }")],
  rateLimit: [
    K("requests", "窓あたりのリクエスト数（トークンバケットの容量）"),
    K("per", "窓: second / minute / hour / day"),
    K("by", "数える単位: principal（既定）/ ip / global"),
  ],
  authorize: [
    K("roles", "いずれかを持てば実行できるロール（省略で認証済みなら誰でも）"),
    K("allow_if", "読み込み後に確認する条件式（principal.*・has_role(principal, ロール)・入力・先頭の load の変数）"),
  ],
  "given:principal": [K("id", "principal.id（省略で既定の ID）"), K("roles", "持っているロール"), K("claims", "クレームの値")],
  context: [
    K("name", "コンテキスト名（PascalCase）"),
    K("description", "責務の説明"),
    K("subdomain", "サブドメインの分類: core（競争力の源）/ supporting（支援）/ generic（汎用・既製品で済む）"),
    K("glossary", "ユビキタス言語の用語集"),
    K("errors", "業務上の失敗（Domain Error）"),
    K("enums", "列挙型"),
    K("value_objects", "値で等価性を判断する不変の型"),
    K("aggregates", "一貫性の境界。Rootを通して変更する"),
    K("extension_points", "顧客コードで実装する拡張点"),
    K("use_cases", "アクターの操作に対応する手順"),
    K("policies", "イベントが起きたら Use case を実行する自動の反応"),
  ],
  glossary: [K("term", "用語"), K("definition", "定義")],
  error: [K("name", "例外クラス名（PascalCase）"), K("code", "機械可読コード（snake_case, 一意）"), K("message", "利用者に見せるメッセージ"), K("description", "説明"), K("details", "内部診断用の追加情報")],
  enum: [K("name", "列挙型名"), K("description", "説明"), K("values", "値（snake_case）の一覧")],
  valueObject: [K("name", "Value Object名"), K("description", "説明"), K("fields", "フィールド"), K("normalize", "制約の前に適用する正規化（strip/lower/upper）"), K("invariants", "構築時に確認する不変条件")],
  field: [K("name", "フィールド名（snake_case）"), K("type", "型（String, UUID, List[X], Ref[Aggregate] …）"), K("required", "false で省略可能（既定 true）"), K("description", "説明"), K("constraints", "長さ・範囲・パターンなどの制約")],
  constraints: [
    K("min_length", "最小文字数"),
    K("max_length", "最大文字数"),
    K("pattern", "正規表現"),
    K("min", "最小値"),
    K("max", "最大値"),
    K("max_digits", "Decimalの最大桁数"),
    K("decimal_places", "Decimalの小数桁数"),
    K("min_items", "Listの最小要素数"),
    K("max_items", "Listの最大要素数"),
  ],
  aggregate: [
    K("name", "Aggregate名（PascalCase）"),
    K("description", "説明"),
    K("identity", "識別子フィールド"),
    K("fields", "フィールド"),
    K("entities", "Aggregate内部のEntity"),
    K("invariants", "常に成り立つ条件（構築時・状態遷移後に自動確認）"),
    K("state_guards", "特定の操作時点で確認する条件（checks / assert_holds）"),
    K("factories", "新しいAggregateを作る操作"),
    K("operations", "状態を変える名前付き操作"),
    K("scenarios", "Aggregate単体のGiven-When-Then（テストになる）"),
    K("authorize", "識別子で読む（生成される読み取りと GET）ことを許す相手: public / authenticated / { roles, allow_if }（security を宣言したら必須）"),
    K("rate_limit", "GET のレート制限: { requests, per, by } / none"),
  ],
  entity: [K("name", "Entity名"), K("description", "説明"), K("identity", "識別子フィールド"), K("fields", "フィールド"), K("invariants", "不変条件")],
  invariant: [
    K("name", "ルール名（snake_case）"),
    K("description", "業務上の意味"),
    K("expression", "常に成り立つ条件式"),
    K("error", "違反時に送出するDomain Error"),
    K("check_on", "評価タイミング: construct / transition"),
  ],
  guard: [K("name", "ガード名（snake_case）"), K("description", "業務上の意味"), K("parameters", "評価に必要な引数（時刻など）"), K("expression", "確認する条件式"), K("error", "assert_holds() が送出するDomain Error")],
  parameter: [K("name", "引数名"), K("type", "型"), K("required", "false で省略可能"), K("description", "説明")],
  factory: [K("name", "ファクトリ名"), K("description", "説明"), K("parameters", "引数"), K("fields", "各フィールドの初期値（式）"), K("emits", "発生させるイベント")],
  operation: [
    K("name", "操作名"),
    K("description", "説明"),
    K("parameters", "引数"),
    K("require", "操作前に自動で確認するState guard"),
    K("changes", "フィールドの新しい値（変更前の状態で評価）"),
    K("emits", "発生させるイベント"),
  ],
  emission: [K("name", "イベント名（PascalCase）"), K("fields", "ペイロード（引数名・変更後のフィールド名、または {name, value}）"), K("when", "発生させる条件（式）")],
  extension: [K("name", "拡張点名"), K("description", "説明"), K("parameters", "引数"), K("returns", "戻り値の型"), K("test_default", "生成テストのスタブが返す既定値")],
  useCase: [
    K("name", "Use case名（snake_case）"),
    K("description", "説明"),
    K("actor", "操作する人・システム"),
    K("command", "入力（Command）のクラス名"),
    K("input", "入力フィールド"),
    K("transaction", "required（既定）/ none"),
    K("idempotency_key", "冪等性キーにする入力フィールド"),
    K("retry", "再試行されうる処理か"),
    K("authorize", "実行を許す相手: public / internal（ポリシーなど内部だけ。HTTP に出さない）/ authenticated / { roles, allow_if }（security を宣言したら必須）"),
    K("rate_limit", "エンドポイントのレート制限: { requests, per, by } / none（既定を使わない）"),
    K("steps", "手順（load / create / invoke / save / publish / if / let / fail / return）"),
    K("scenarios", "Given-When-Then（テストになる）"),
  ],
  policy: [
    K("name", "ポリシー名（snake_case）"),
    K("description", "業務上の意味（〜されたら〜する）"),
    K("when", "きっかけのイベント: 同じコンテキストなら Event、別のコンテキストなら Context.Event"),
    K("run", "実行するこのコンテキストの Use case"),
    K("args", "Use case の入力: event.<フィールド>・clock.now・ids.new・値"),
  ],
  relationship: [
    K("upstream", "上流（イベントを公開する側）のコンテキスト"),
    K("downstream", "下流（イベントを受けて反応する側）のコンテキスト"),
    K("pattern", "関係の種類（customer_supplier / conformist / anticorruption_layer など。既定 customer_supplier）"),
    K("events", "イベント契約: 下流が受け取ってよい上流のイベント"),
    K("description", "説明"),
  ],
  step: [
    K("load", "Repositoryから読み込む: { aggregate, by, as, not_found }"),
    K("create", "ファクトリで作る: { aggregate, factory, as, args }"),
    K("invoke", "操作を呼ぶ: { target, operation, args }"),
    K("save", "保存する変数名"),
    K("publish", "イベントをすぐに公開する"),
    K("publish_after_commit", "コミット成功後にイベントを公開する"),
    K("if", "条件分岐: { condition, then, else }"),
    K("let", "計算した値に名前を付ける: { name, value }（後の手順で使える。if の中で付けた名前はその枝の中だけ）"),
    K("fail", "Domain Errorで失敗する"),
    K("return", "戻り値（式）"),
  ],
  "step:load": [K("aggregate", "読み込むAggregate"), K("by", "識別子の式（入力フィールドなど）"), K("as", "変数名"), K("not_found", "見つからないときのDomain Error")],
  "step:create": [K("aggregate", "作るAggregate"), K("factory", "使うファクトリ"), K("as", "変数名"), K("args", "ファクトリの引数（式）")],
  "step:invoke": [K("target", "操作するAggregateの変数"), K("operation", "呼ぶ操作"), K("args", "操作の引数（式）")],
  "step:if": [K("condition", "条件式（ガード・拡張点を使える）"), K("then", "成り立つときの手順"), K("else", "成り立たないときの手順")],
  "step:let": [K("name", "名前（snake_case。Use case の中で一意）"), K("value", "値の式（例: sum(order.lines, item.quantity)）")],
  "scenario:aggregate": [K("name", "シナリオ名（テスト関数名になる）"), K("description", "説明"), K("given", "前提の状態"), K("when", "construct / operation / factory"), K("then", "期待する結果")],
  "given:aggregate": [K("aggregate", "前提となるAggregateのフィールド値")],
  "when:aggregate": [K("construct", "このフィールド値で直接作る"), K("operation", "実行する操作"), K("factory", "使うファクトリ"), K("args", "引数")],
  "then:aggregate": [K("raises", "送出されるDomain Error"), K("state", "結果の状態（一部のフィールド）"), K("emits", "発生するイベント（順番通り）")],
  "scenario:useCase": [K("name", "シナリオ名（テスト関数名になる）"), K("description", "説明"), K("given", "前提（時刻・ID・保存済みAggregate・拡張点の値）"), K("when", "入力"), K("then", "期待する結果")],
  "given:useCase": [
    K("clock", "現在時刻（タイムゾーン付き）"),
    K("ids", "ids.new が返すID"),
    K("aggregates", "保存済みのAggregate"),
    K("extensions", "拡張点のスタブ値"),
    K("principal", "実行する principal: { id, roles, claims }、null で未認証（省略で authorize.roles を持つ既定の principal）"),
  ],
  givenAggregate: [K("type", "Aggregate名"), K("fields", "フィールド値（必須フィールドはすべて）")],
  "when:useCase": [K("input", "Commandの入力値")],
  "then:useCase": [K("raises", "送出されるDomain Error"), K("returns", "戻り値"), K("state", "保存後の状態"), K("emits", "公開されるイベント（順番通り）")],
  expectedState: [K("aggregate", "Aggregate名"), K("id", "識別子"), K("fields", "期待するフィールド値")],
  expectedEvent: [K("event", "イベント名"), K("fields", "期待するペイロード")],
};

/** Keys whose values are rule expressions. */
const EXPRESSION_KEYS = new Set(["expression", "condition", "when", "return", "by", "allow_if"]);

// ---------------------------------------------------------------------------
// Document snapshot and scope
// ---------------------------------------------------------------------------

interface Snapshot {
  text: string;
  offset: number;
  lines: string[];
  lineIdx: number;
  col: number;
  lineStart: number;
  parsed: ParseResult;
  model?: ModelIR;
  analysis?: Analysis;
}

function takeSnapshot(text: string, offset: number): Snapshot {
  const before = text.slice(0, offset);
  const lineIdx = before.split("\n").length - 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lines = text.split("\n");
  const lineEnd = text.indexOf("\n", offset) === -1 ? text.length : text.indexOf("\n", offset);
  const ok = (p: ParseResult) => !!p.model && !p.diagnostics.some((d) => d.code === "yaml-syntax");
  // While typing, the line under the cursor is often incomplete. Offsets before the cursor are kept identical
  // in every repaired variant, so ranges and scope still line up with the original text.
  const prefix = text.slice(lineStart, offset);
  const rest = text.slice(offset, lineEnd);
  let source = text;
  if (/:\s*$/.test(prefix) && rest.trim() === "") {
    // `key: ` with nothing yet: a null value would drop the element (e.g. a guard without expression).
    source = text.slice(0, offset) + PLACEHOLDER + text.slice(offset);
  }
  let parsed = parseModel(source);
  if (!ok(parsed)) {
    const open = openBracketsIn(text.slice(lineStart, lineEnd));
    if (open.length) {
      const closed = text.slice(0, lineEnd) + open.reverse().map((c) => (c === "{" ? "}" : "]")).join("") + text.slice(lineEnd);
      const withValue = /:\s*$/.test(prefix) ? closed.slice(0, offset) + PLACEHOLDER + closed.slice(offset) : closed;
      const retry = parseModel(withValue);
      if (ok(retry)) parsed = retry;
    }
  }
  if (!ok(parsed)) {
    const blanked = text.slice(0, lineStart) + " ".repeat(lineEnd - lineStart) + text.slice(lineEnd);
    const retry = parseModel(blanked);
    if (retry.model) parsed = retry;
  }
  let analysis: Analysis | undefined;
  if (parsed.model) {
    try {
      analysis = analyzeModel(parsed.model);
    } catch {
      analysis = undefined;
    }
  }
  return { text, offset, lines, lineIdx, col: offset - lineStart, lineStart, parsed, model: parsed.model, analysis };
}

/** Temporary value inserted at the cursor so an empty `key:` still parses as a string. */
const PLACEHOLDER = "ddd_cursor";

function openBracketsIn(line: string): string[] {
  const stack: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  return stack;
}

interface Scope {
  context?: ContextIR;
  aggregate?: AggregateIR;
  entity?: EntityIR;
  valueObject?: ValueObjectIR;
  guard?: StateGuardIR;
  operation?: OperationIR;
  factory?: FactoryIR;
  useCase?: UseCaseIR;
  policy?: PolicyIR;
}

const indentOf = (line: string) => /^ */.exec(line)![0].length;

/** Range of the element at `path`, extended over following blank / more-indented lines (where the user may be typing). */
function extendedRange(s: Snapshot, path: Path): [number, number] | undefined {
  const r = s.parsed.rangeOf(path);
  if (!r) return undefined;
  const text = s.text;
  const startLineStart = text.lastIndexOf("\n", r[0] - 1) + 1;
  const col = r[0] - startLineStart;
  let end = r[1];
  let pos = text.indexOf("\n", Math.max(r[1] - 1, 0));
  while (pos !== -1 && pos < text.length) {
    const next = text.indexOf("\n", pos + 1);
    const line = text.slice(pos + 1, next === -1 ? text.length : next);
    if (line.trim() === "" || line.trimStart().startsWith("#") || indentOf(line) >= col) {
      end = next === -1 ? text.length : next;
      pos = next;
    } else break;
  }
  return [r[0], Math.max(end, r[1])];
}

function inside(s: Snapshot, path: Path): boolean {
  const r = extendedRange(s, path);
  return !!r && s.offset >= r[0] && s.offset <= r[1];
}

function resolveScope(s: Snapshot): Scope {
  const scope: Scope = {};
  for (const ctx of s.model?.contexts ?? []) {
    if (!inside(s, ctx.path)) continue;
    scope.context = ctx;
    for (const vo of ctx.valueObjects) if (inside(s, vo.path)) scope.valueObject = vo;
    for (const ag of ctx.aggregates) {
      if (!inside(s, ag.path)) continue;
      scope.aggregate = ag;
      for (const en of ag.entities) if (inside(s, en.path)) scope.entity = en;
      for (const g of ag.stateGuards) if (inside(s, g.path)) scope.guard = g;
      for (const o of ag.operations) if (inside(s, o.path)) scope.operation = o;
      for (const f of ag.factories) if (inside(s, f.path)) scope.factory = f;
    }
    for (const uc of ctx.useCases) if (inside(s, uc.path)) scope.useCase = uc;
    for (const p of ctx.policies) if (inside(s, p.path)) scope.policy = p;
  }
  return scope;
}

/** Keys of the block mappings enclosing a position with the given indentation (root first). */
function ancestorKeys(lines: string[], lineIdx: number, indent: number): string[] {
  const chain: string[] = [];
  let cur = indent;
  for (let i = lineIdx - 1; i >= 0 && cur > 0; i--) {
    const l = lines[i]!;
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    const m = /^(\s*)(-\s+)?(?:([A-Za-z_]\w*)\s*:(.*))?/.exec(l)!;
    const base = m[1]!.length;
    const keyIndent = base + (m[2]?.length ?? 0);
    if (!m[3]) {
      if (m[2] && base < cur) cur = base;
      continue;
    }
    if (keyIndent < cur) {
      const rest = m[4]!.trim();
      if (rest === "" || rest.startsWith("#")) chain.unshift(m[3]);
      cur = m[2] ? base : keyIndent;
    }
  }
  return chain;
}

type Position =
  | { kind: "key"; container: Container; chain: string[]; partial: string; from: number; flow: boolean }
  | { kind: "value"; container: Container; chain: string[]; key: string; partial: string; from: number; valueStart: number; flow: boolean; listItem: boolean }
  | { kind: "none" };

/** Finds the last unmatched opening bracket in `s` (ignoring quoted text). */
function openBracket(s: string): { index: number; ch: "{" | "[" } | undefined {
  const stack: { index: number; ch: "{" | "[" }[] = [];
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") stack.push({ index: i, ch: c });
    else if (c === "}" || c === "]") stack.pop();
  }
  return stack[stack.length - 1];
}

function wordStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]!)) i--;
  return i;
}

function classify(s: Snapshot): Position {
  const line = s.lines[s.lineIdx] ?? "";
  const prefix = line.slice(0, s.col);
  if (/(^|\s)#/.test(prefix.replace(/"[^"]*"|'[^']*'/g, ""))) return { kind: "none" };
  const from = s.lineStart + (wordStart(prefix, prefix.length));
  const partial = prefix.slice(from - s.lineStart);

  const lineMatch = /^(\s*)(-\s+)?(?:([A-Za-z_]\w*)\s*:\s*)?/.exec(prefix)!;
  const base = lineMatch[1]!.length;
  const dash = lineMatch[2]?.length ?? 0;
  const lineKey = lineMatch[3];

  const bracket = openBracket(prefix);
  if (bracket) {
    const inner = prefix.slice(bracket.index + 1);
    const parts = inner.split(",");
    const last = parts[parts.length - 1]!;
    // Chain of the collection that owns this flow node.
    const ownerChain = lineKey && prefix.slice(0, bracket.index).trimEnd().endsWith(":")
      ? [...ancestorKeys(s.lines, s.lineIdx, base + dash), lineKey]
      : ancestorKeys(s.lines, s.lineIdx, base + 1);
    if (bracket.ch === "[") {
      // `- { key: [item` — a list inside a single flow mapping (e.g. a relationship's events).
      const keyBefore = /([A-Za-z_]\w*)\s*:\s*$/.exec(prefix.slice(0, bracket.index));
      const outer = openBracket(prefix.slice(0, bracket.index));
      if (keyBefore && outer?.ch === "{" && !openBracket(prefix.slice(0, outer.index))) {
        const mapChain = lineKey && prefix.slice(0, outer.index).trimEnd().endsWith(":") ? [...ancestorKeys(s.lines, s.lineIdx, base + dash), lineKey] : ancestorKeys(s.lines, s.lineIdx, base + 1);
        return { kind: "value", container: containerOf(mapChain), chain: mapChain, key: keyBefore[1]!, partial, from, valueStart: s.lineStart + bracket.index + 1 + inner.length - last.length, flow: true, listItem: true };
      }
      const key = ownerChain[ownerChain.length - 1] ?? "";
      const chain = ownerChain.slice(0, -1);
      return { kind: "value", container: containerOf(chain), chain, key, partial, from, valueStart: s.lineStart + bracket.index + 1 + inner.length - last.length, flow: true, listItem: true };
    }
    const kv = /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(last);
    if (kv) {
      return {
        kind: "value",
        container: containerOf(ownerChain),
        chain: ownerChain,
        key: kv[1]!,
        partial,
        from,
        valueStart: s.lineStart + prefix.length - kv[2]!.length,
        flow: true,
        listItem: false,
      };
    }
    return { kind: "key", container: containerOf(ownerChain), chain: ownerChain, partial, from, flow: true };
  }

  if (lineKey !== undefined) {
    const chain = ancestorKeys(s.lines, s.lineIdx, base + dash);
    const valueStart = s.lineStart + lineMatch[0].length;
    return { kind: "value", container: containerOf(chain), chain, key: lineKey, partial, from, valueStart, flow: false, listItem: false };
  }
  if (/^\s*(-\s+)?[A-Za-z_]*$/.test(prefix)) {
    if (dash && /^\s*-\s+[A-Za-z_]*$/.test(prefix)) {
      // `- xyz` can be a new mapping item (key) or a scalar list item (value); decide by the owning collection.
      const ownerChain = ancestorKeys(s.lines, s.lineIdx, base + 1);
      const owner = containerOf(ownerChain);
      if (owner === "unknown" || owner === "require" || owner === "eventField" || owner === "ids") {
        const key = ownerChain[ownerChain.length - 1] ?? "";
        const chain = ownerChain.slice(0, -1);
        return { kind: "value", container: containerOf(chain), chain, key, partial, from, valueStart: s.lineStart + base + dash, flow: false, listItem: true };
      }
      return { kind: "key", container: owner, chain: ownerChain, partial, from, flow: false };
    }
    const chain = ancestorKeys(s.lines, s.lineIdx, base + dash);
    return { kind: "key", container: containerOf(chain), chain, partial, from, flow: false };
  }
  if (dash) {
    const ownerChain = ancestorKeys(s.lines, s.lineIdx, base + 1);
    const key = ownerChain[ownerChain.length - 1] ?? "";
    const chain = ownerChain.slice(0, -1);
    return { kind: "value", container: containerOf(chain), chain, key, partial, from, valueStart: s.lineStart + base + dash, flow: false, listItem: true };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Symbol tables
// ---------------------------------------------------------------------------

interface ExprEnvInfo {
  fields: Map<string, Type>;
  params: Map<string, Type>;
  locals: Map<string, Type>;
  inputs: Set<string>;
  useCase: boolean;
  guardsBare: boolean;
  /** Element type of the innermost collection function around the cursor (`item`). */
  item?: Type;
}

function fieldTypesOf(s: Snapshot, owner: string | undefined): Map<string, Type> {
  if (!owner || !s.analysis) return new Map();
  for (const ca of s.analysis.contexts.values()) {
    const m = ca.fieldTypes.get(owner);
    if (m) return m;
  }
  return new Map();
}

function paramMap(ctx: ContextIR, params: { name: string; type: string; required: boolean }[], aggregate?: string): Map<string, Type> {
  const m = new Map<string, Type>();
  for (const p of params) {
    const r = resolveType(p.type, { context: ctx, aggregate });
    if (r.ok) m.set(p.name, p.required ? r.type : { k: "optional", inner: r.type });
  }
  return m;
}

function bindingsBefore(steps: StepIR[], s: Snapshot, out = new Map<string, string>()): Map<string, string> {
  for (const st of steps) {
    const r = s.parsed.rangeOf(st.path);
    if (r && r[0] > s.offset) break;
    if (st.kind === "load" || st.kind === "create") out.set(st.as, st.aggregate);
    if (st.kind === "if") {
      bindingsBefore(st.then, s, out);
      bindingsBefore(st.else, s, out);
    }
  }
  return out;
}

/** `let` values named before the cursor, with their types from the last analysis. */
function letsBefore(steps: StepIR[], s: Snapshot, ctx: ContextIR, out = new Map<string, Type>()): Map<string, Type> {
  for (const st of steps) {
    const r = s.parsed.rangeOf(st.path);
    if (r && r[0] > s.offset) break;
    if (st.kind === "let" && !(r && r[1] >= s.offset)) {
      const t = s.analysis?.contexts.get(ctx.name)?.exprs.get(formatPath([...st.path, "value"]))?.type;
      if (t) out.set(st.name, t);
    }
    if (st.kind === "if") {
      letsBefore(st.then, s, ctx, out);
      letsBefore(st.else, s, ctx, out);
    }
  }
  return out;
}

/** Functions whose later arguments see the element as `item`. */
const ITEM_CALL = /\b(?:count|sum|any|all|remove_where|replace_where)\(\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*,/g;

/** Element type of the innermost still-open collection function call in `before`. */
function itemTypeIn(s: Snapshot, ctx: ContextIR, env: ExprEnvInfo, before: string): Type | undefined {
  let found: Type | undefined;
  for (const m of before.matchAll(ITEM_CALL)) {
    const rest = before.slice(m.index! + m[0].length);
    let depth = 1;
    for (const ch of rest) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    if (depth <= 0) continue;
    const t = typeOfPath(s, ctx, env, m[1]!);
    const b = t && unwrap(t);
    if (b?.k === "list") found = b.item;
  }
  return found;
}

function exprEnv(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "value" }>): ExprEnvInfo {
  const ctx = scope.context;
  const env: ExprEnvInfo = { fields: new Map(), params: new Map(), locals: new Map(), inputs: new Set(), useCase: false, guardsBare: false };
  if (!ctx) return env;
  if (scope.useCase && !scope.aggregate) {
    env.useCase = true;
    const uc = scope.useCase;
    const inputTypes = fieldTypesOf(s, uc.command);
    for (const [k, t] of inputTypes) {
      env.locals.set(k, t);
      env.inputs.add(k);
    }
    for (const [v, ag] of bindingsBefore(uc.steps, s)) env.locals.set(v, { k: "aggregate", name: ag });
    for (const [v, t] of letsBefore(uc.steps, s, ctx)) env.locals.set(v, t);
    return env;
  }
  const owner = scope.entity ?? scope.aggregate ?? scope.valueObject;
  if (pos.container !== "exprMap:factoryFields") env.fields = fieldTypesOf(s, owner?.name);
  const member = scope.guard ?? scope.operation ?? scope.factory;
  if (member) env.params = paramMap(ctx, member.parameters, scope.aggregate?.name);
  env.guardsBare = pos.container === "require" || pos.key === "require";
  return env;
}

function unwrap(t: Type): Type {
  return t.k === "optional" ? t.inner : t;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

const fn = (label: string, detail: string, documentation: string): CompletionItem => ({ label, kind: "function", insertText: `${label}(`, detail, documentation });
const FUNCTIONS: CompletionItem[] = [
  fn("is_empty", "is_empty(x: String | List) → Boolean", "空の文字列・リストなら true"),
  fn("length", "length(x: String | List) → Integer", "文字数・要素数"),
  fn("contains", "contains(collection, item) → Boolean", "リストが要素を含む／文字列が部分文字列を含む"),
  fn("days", "days(n: Integer) → Duration", "n日間。DateTime・Date に足し引きできる（Date には days だけ）"),
  fn("hours", "hours(n: Integer) → Duration", "n時間。例: `at < placed_at + hours(24)`"),
  fn("minutes", "minutes(n: Integer) → Duration", "n分間"),
  fn("round", "round(x: Integer | Decimal, 桁数) → Decimal", "小数点以下を指定の桁に四捨五入（ROUND_HALF_UP）。桁数は整数のリテラル"),
  fn("min", "min(a, b) → 小さい方", "数値どうし、または DateTime・Date・Duration どうし"),
  fn("max", "max(a, b) → 大きい方", "数値どうし、または DateTime・Date・Duration どうし"),
  fn("count", "count(list[, 条件]) → Integer", "要素数。条件を付けると成り立つ要素の数（条件の中では `item` が要素）"),
  fn("sum", "sum(list[, 要素の数値]) → Integer | Decimal", "合計。例: `sum(lines, item.unit_price.amount * item.quantity)`"),
  fn("any", "any(list, 条件) → Boolean", "条件が成り立つ要素が1つでもあれば true。例: `any(lines, item.line_id == line_id)`"),
  fn("all", "all(list, 条件) → Boolean", "すべての要素で条件が成り立てば true（空なら true）"),
  fn("append", "append(list, 要素) → List", "末尾に要素を足した新しいリスト"),
  fn("remove", "remove(list, 要素) → List", "等しい要素（Entity は識別子が同じ要素）を除いた新しいリスト"),
  fn("remove_where", "remove_where(list, 条件) → List", "条件が成り立つ要素を除いた新しいリスト。例: `remove_where(lines, item.line_id == line_id)`"),
  fn("replace_where", "replace_where(list, 条件, 新しい要素) → List", "条件が成り立つ要素を置き換えた新しいリスト。例: `replace_where(lines, item.line_id == id, with(item, quantity=q))`"),
  fn("with", "with(entity, field=値, ...) → Entity", "一部のフィールドを変えた Entity のコピー（不変条件を検査する。識別子は変えられない）"),
];
const FUNCTION_NAMES = new Set(FUNCTIONS.map((f) => f.label));
const KEYWORDS: CompletionItem[] = ["and", "or", "not", "null", "true", "false"].map((k) => ({ label: k, kind: "keyword" as const, sortRank: 9 }));

function typeCompletions(ctx: ContextIR | undefined, scope: Scope): CompletionItem[] {
  const items: CompletionItem[] = PRIMITIVES.map((p) => ({ label: p, kind: "type" as const, detail: "組み込み型", sortRank: 2 }));
  items.push({ label: "List[", kind: "type", detail: "List[T] — 不変のリスト", sortRank: 3 }, { label: "Ref[", kind: "type", detail: "Ref[Aggregate] — 別Aggregateの識別子", sortRank: 3 });
  for (const e of ctx?.enums ?? []) items.push({ label: e.name, kind: "type", detail: `Enum: ${e.values.join(", ")}`, sortRank: 1 });
  for (const v of ctx?.valueObjects ?? []) items.push({ label: v.name, kind: "type", detail: "Value object", sortRank: 1 });
  for (const en of scope.aggregate?.entities ?? []) items.push({ label: en.name, kind: "type", detail: `Entity（${scope.aggregate!.name} 内）`, sortRank: 1 });
  return items;
}

function valueCompletions(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  const ctx = scope.context;
  const key = pos.key;
  const c = pos.container;
  const errors = (): CompletionItem[] => (ctx?.errors ?? []).map((e) => ({ label: e.name, kind: "error" as const, detail: e.code, documentation: e.message }));
  const aggregates = (): CompletionItem[] => (ctx?.aggregates ?? []).map((a) => ({ label: a.name, kind: "aggregate" as const, detail: "Aggregate", documentation: a.description }));
  const events = (): CompletionItem[] => {
    const info = s.analysis?.contexts.get(ctx?.name ?? "")?.events;
    return [...(info?.values() ?? [])].map((e) => ({ label: e.name, kind: "event" as const, detail: `(${e.fields.map((f) => f.name).join(", ")})`, documentation: `発生元: ${e.sources.map((x) => `${x.aggregate}.${x.member}`).join(", ")}` }));
  };
  const vars = (): CompletionItem[] =>
    scope.useCase ? [...bindingsBefore(scope.useCase.steps, s)].map(([v, a]) => ({ label: v, kind: "variable" as const, detail: a })) : [];

  if (c === "relationship") return relationshipCompletions(s, pos);
  if (c === "generation" && key === "target")
    return [
      { label: "python", kind: "value" as const, detail: "既定。Python 3.11+ / Pydantic v2 / pytest", sortRank: 0 },
      { label: "typescript", kind: "value" as const, detail: "TypeScript / Zod v4 / vitest または bun test", sortRank: 1 },
    ];
  if (c === "generation:typescript" && key === "test_runner")
    return [
      { label: "vitest", kind: "value" as const, detail: "既定。生成テストは vitest から import する", sortRank: 0 },
      { label: "bun", kind: "value" as const, detail: "生成テストは bun:test から import する", sortRank: 1 },
    ];
  if (c === "generation:typescript:api" && key === "client")
    return [{ label: "tanstack-query", kind: "value" as const, detail: "既定。@tanstack/react-query v5 の queryOptions / mutationOptions とフック", sortRank: 0 }];
  if (c === "security:authentication" && key === "scheme")
    return [
      { label: "bearer_jwt", kind: "value" as const, detail: "既定。Authorization: Bearer の JWT を検証する認証器を生成（TS: jose / Python: PyJWT）", sortRank: 0 },
      { label: "custom", kind: "value" as const, detail: "認証器を自分で実装する（Authenticator のポート）", sortRank: 1 },
    ];
  if (c === "security:authentication" && key === "algorithms")
    return ["RS256", "ES256", "PS256", "EdDSA", "HS256"].map((a, i) => ({ label: a, kind: "value" as const, sortRank: i }));
  if (c === "rateLimit" && key === "per") return ["second", "minute", "hour", "day"].map((v, i) => ({ label: v, kind: "value" as const, sortRank: i }));
  if (c === "rateLimit" && key === "by")
    return [
      { label: "principal", kind: "value" as const, detail: "既定。認証済みの principal ごと（公開エンドポイントでは IP ごと）", sortRank: 0 },
      { label: "ip", kind: "value" as const, detail: "クライアントの IP ごと（clientIp で取り出す）", sortRank: 1 },
      { label: "global", kind: "value" as const, detail: "全員で 1 つ", sortRank: 2 },
    ];
  if ((c === "useCase" || c === "aggregate") && key === "authorize")
    return [
      { label: "public", kind: "value" as const, detail: "誰でも（principal なし）", sortRank: 0 },
      ...(c === "useCase" ? [{ label: "internal", kind: "value" as const, detail: "ポリシーなど内部だけ。HTTP に出さない", sortRank: 1 }] : []),
      { label: "authenticated", kind: "value" as const, detail: "認証済みなら誰でも", sortRank: 2 },
    ];
  if ((c === "useCase" || c === "aggregate") && key === "rate_limit") return [{ label: "none", kind: "value" as const, detail: "既定の制限を使わない" }];
  if ((c === "authorize" && key === "roles") || (c === "given:principal" && key === "roles"))
    return (s.model?.security?.roles ?? []).map((r) => ({ label: r, kind: "value" as const, detail: "ロール" }));
  if (c === "authorize" && key === "allow_if" && s.model?.security) {
    const sec = s.model.security;
    const principal: CompletionItem[] = [
      { label: "principal.id", kind: "variable", detail: sec.principal.idType, sortRank: 0 },
      { label: "principal.roles", kind: "variable", detail: "List[String]", sortRank: 0 },
      ...sec.principal.claims.map((cl) => ({ label: `principal.${cl.name}`, kind: "variable" as const, detail: cl.required ? cl.type : `Optional[${cl.type}]`, sortRank: 0 })),
      ...sec.roles.map((r) => ({ label: `has_role(principal, ${r})`, kind: "function" as const, detail: "Boolean", sortRank: 1 })),
    ];
    return [...principal, ...expressionCompletions(s, scope, pos)];
  }
  if (key === "raises" && c === "then:useCase" && s.model?.security)
    return [
      ...errors(),
      { label: "ConstraintViolation", kind: "error", detail: "組み込み: フィールド制約の違反" },
      { label: "AggregateNotFound", kind: "error", detail: "組み込み: load で見つからない" },
      { label: "NotAuthorized", kind: "error", detail: "組み込み: ロールがない・allow_if が成り立たない（403）" },
      { label: "Unauthenticated", kind: "error", detail: "組み込み: principal がない（401。given.principal: null）" },
    ];
  if (c === "context" && key === "subdomain")
    return [
      { label: "core", kind: "value" as const, detail: "コア: 競争力の源。いちばん力を入れて作り込む", sortRank: 0 },
      { label: "supporting", kind: "value" as const, detail: "支援: 業務に必要だが差別化にはならない", sortRank: 1 },
      { label: "generic", kind: "value" as const, detail: "汎用: どこでも同じ。既製品や外部サービスを使う", sortRank: 2 },
    ];
  if (c === "policy" && key === "when" && ctx) return policyEventCompletions(s, ctx, pos);
  if (c === "policy" && key === "run") return (ctx?.useCases ?? []).map((u) => ({ label: u.name, kind: "useCase" as const, detail: u.command, documentation: u.description }));
  if (c === "exprMap:policyArgs") return policyArgCompletions(s, scope, pos);
  if (c.startsWith("data:")) return dataCompletions(s, scope, pos);
  if (key === "type" && c === "givenAggregate") return aggregates();
  if (key === "type" || key === "returns") return typeCompletions(ctx, scope);
  if (key === "error" || key === "not_found" || key === "fail") return errors();
  if (key === "raises")
    return [
      ...errors(),
      { label: "ConstraintViolation", kind: "error", detail: "組み込み: フィールド制約の違反" },
      { label: "AggregateNotFound", kind: "error", detail: "組み込み: load で見つからない" },
    ];
  if (key === "aggregate") return aggregates();
  if (key === "publish" || key === "publish_after_commit" || key === "event" || (key === "emits" && pos.listItem)) return events();
  if (key === "save" || key === "target") return vars();
  if (key === "check_on") return ["construct", "transition"].map((v) => ({ label: v, kind: "value" as const, detail: v === "construct" ? "構築時（遷移候補を含む）" : "状態遷移後" }));
  if (key === "transaction") return [{ label: "required", kind: "value", detail: "既定。イベントはコミット後に公開できる" }, { label: "none", kind: "value", detail: "トランザクションなし" }];
  if (["required", "retry"].includes(key)) return [{ label: "true", kind: "value" }, { label: "false", kind: "value" }];
  if (c === "normalize") return ["strip", "lower", "upper"].map((v) => ({ label: v, kind: "value" as const }));
  if (key === "identity") {
    const owner = scope.entity ?? scope.aggregate;
    return (owner?.fields ?? []).map((f) => ({ label: f.name, kind: "field" as const, detail: f.type }));
  }
  if (key === "operation") {
    let ag = scope.aggregate;
    if (scope.useCase && !scope.aggregate) {
      const target = siblingValue(s, "target");
      const agName = target ? bindingsBefore(scope.useCase.steps, s).get(target) : undefined;
      ag = ctx?.aggregates.find((a) => a.name === agName);
    }
    return (ag?.operations ?? []).map((o) => ({ label: o.name, kind: "operation" as const, detail: `(${o.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")})`, documentation: o.description }));
  }
  if (key === "factory") {
    const agName = siblingValue(s, "aggregate");
    const ag = scope.aggregate ?? ctx?.aggregates.find((a) => a.name === agName);
    return (ag?.factories ?? []).map((f) => ({ label: f.name, kind: "factory" as const, detail: `(${f.parameters.map((p) => p.name).join(", ")})` }));
  }
  if (key === "idempotency_key") return (scope.useCase?.input ?? []).map((f) => ({ label: f.name, kind: "field" as const, detail: f.type }));
  const isExpr =
    EXPRESSION_KEYS.has(key) ||
    c === "exprMap:changes" ||
    c === "exprMap:factoryFields" ||
    c === "exprMap:args" ||
    key === "require" ||
    c === "require" ||
    ((c === "eventField" || c === "step:let") && key === "value");
  if (isExpr) return expressionCompletions(s, scope, pos);
  if (c === "emission" && key === "fields") {
    const member = scope.operation ?? scope.factory;
    const params = member?.parameters.map((p) => p.name) ?? [];
    const fields = scope.aggregate?.fields.map((f) => f.name) ?? [];
    return [...new Set([...params, ...fields])].map((n) => ({ label: n, kind: params.includes(n) ? ("parameter" as const) : ("field" as const) }));
  }
  return [];
}

const PATTERN_DOCS: Record<string, string> = {
  customer_supplier: "上流（供給側）が下流（顧客）の要望を聞いてイベント契約を提供する",
  conformist: "下流が上流のモデルを翻訳せずにそのまま受け入れる",
  anticorruption_layer: "下流が翻訳層を置き、上流のモデルが入り込むのを防ぐ（生成物: extensions の translators.py）",
  open_host_service: "上流が誰でも使える公開の連携口を提供する",
  published_language: "文書化された共有の形（イベントの形）で連携する",
  shared_kernel: "2つのコンテキストがモデルの一部を共有し、合意して変更する",
  partnership: "2つのチームが協調して一緒に変更・リリースする",
  separate_ways: "連携しない（イベント契約は持てない）",
};

function contextByName(s: Snapshot, name: string | undefined): ContextIR | undefined {
  return s.model?.contexts.find((c) => c.name === name);
}

/** Upstream of the relationship under the cursor (flow map on the line, or the nearest `upstream:` above). */
function relationshipUpstream(s: Snapshot): string | undefined {
  const line = s.lines[s.lineIdx] ?? "";
  return /[{,]\s*upstream\s*:\s*([A-Za-z_]\w*)/.exec(line)?.[1] ?? siblingValueAbove(s, "upstream");
}

function eventItems(s: Snapshot, ctx: ContextIR, qualify: boolean, rank: number, detailSuffix = ""): CompletionItem[] {
  const info = s.analysis?.contexts.get(ctx.name)?.events;
  return [...(info?.values() ?? [])].map((e) => ({
    label: qualify ? `${ctx.name}.${e.name}` : e.name,
    kind: "event" as const,
    detail: `(${e.fields.map((f) => f.name).join(", ")})${detailSuffix}`,
    documentation: `発生元: ${ctx.name} › ${e.sources.map((x) => `${x.aggregate}.${x.member}`).join(", ")}`,
    sortRank: rank,
  }));
}

function relationshipCompletions(s: Snapshot, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  const contexts = s.model?.contexts ?? [];
  if (pos.key === "upstream" || pos.key === "downstream") return contexts.map((c) => ({ label: c.name, kind: "context" as const, detail: "Bounded context", documentation: c.description }));
  if (pos.key === "pattern") return RELATIONSHIP_PATTERNS.map((p, i) => ({ label: p, kind: "value" as const, detail: PATTERN_DOCS[p], sortRank: i }));
  if (pos.key === "events") {
    const up = contextByName(s, relationshipUpstream(s));
    return up ? eventItems(s, up, false, 1) : [];
  }
  return [];
}

/** `when:` of a policy: this context's events, then other contexts' events as Context.Event (contract events first). */
function policyEventCompletions(s: Snapshot, ctx: ContextIR, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  const before = valueBefore(s.text, pos.valueStart, pos.from);
  const qualified = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before);
  if (qualified) {
    const other = contextByName(s, qualified[1]);
    return other ? eventItems(s, other, false, 1) : [];
  }
  const items = eventItems(s, ctx, false, 0);
  for (const other of s.model?.contexts ?? []) {
    if (other === ctx) continue;
    const rel = s.model!.relationships.find((r) => r.upstream === other.name && r.downstream === ctx.name);
    for (const item of eventItems(s, other, true, 2)) {
      const name = item.label.slice(other.name.length + 1);
      const inContract = !!rel?.events.includes(name);
      items.push({ ...item, sortRank: inContract ? 1 : 2, detail: `${item.detail} — ${inContract ? `契約: ${rel!.pattern}` : "関係（relationships）への追加が必要"}` });
    }
  }
  return items;
}

/** The event a policy consumes, with the context that defines its payload types. */
function policyEvent(s: Snapshot, ctx: ContextIR | undefined, policy: PolicyIR | undefined) {
  if (!ctx || !policy) return undefined;
  const ref = parseEventRef(policy.when);
  const evCtx = ref && contextByName(s, ref.context ?? ctx.name);
  const info = evCtx && s.analysis?.contexts.get(evCtx.name)?.events.get(ref!.name);
  return info && evCtx ? { ctx: evCtx, info } : undefined;
}

/** Type of `event.a.b` inside a policy's args. */
function eventPathType(s: Snapshot, ev: NonNullable<ReturnType<typeof policyEvent>>, segs: string[]): { owner: string; fields: Map<string, Type> } | undefined {
  let fields = new Map(ev.info.fields.map((f) => [f.name, f.type]));
  let owner = ev.info.name;
  for (const seg of segs) {
    const t = fields.get(seg);
    const b = t && unwrap(t);
    if (!b || (b.k !== "vo" && b.k !== "entity")) return undefined;
    owner = b.name;
    fields = s.analysis?.contexts.get(ev.ctx.name)?.fieldTypes.get(b.name) ?? new Map();
  }
  return { owner, fields };
}

function policyArgCompletions(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  const ctx = scope.context;
  const ev = policyEvent(s, ctx, scope.policy);
  const before = valueBefore(s.text, pos.valueStart, pos.from);
  if (/\bclock\s*\.\s*$/.test(before)) return [{ label: "now", kind: "port", detail: "DateTime — 現在時刻" }];
  if (/\bids\s*\.\s*$/.test(before)) return [{ label: "new", kind: "port", detail: "UUID — 新しいID" }];
  const path = /\bevent((?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$/.exec(before);
  if (path) {
    if (!ev) return [];
    const target = eventPathType(s, ev, path[1]!.split(".").map((x) => x.trim()).filter(Boolean));
    return [...(target?.fields ?? [])].map(([n, t]) => ({ label: n, kind: "field" as const, detail: `${typeToString(t)} — ${target!.owner}` }));
  }
  const items: CompletionItem[] = [];
  const uc = ctx?.useCases.find((u) => u.name === scope.policy?.run);
  const input = uc && fieldTypesOf(s, uc.command).get(pos.key);
  const b = input && unwrap(input);
  if (b?.k === "enum") for (const v of ctx?.enums.find((e) => e.name === b.name)?.values ?? []) items.push({ label: v, kind: "enumValue", detail: b.name, sortRank: 0 });
  if (ev) items.push({ label: "event", kind: "variable", detail: `${ev.ctx.name}.${ev.info.name}`, insertText: "event.", sortRank: 1 });
  items.push({ label: "clock", kind: "port", detail: "clock.now → DateTime", insertText: "clock.now", sortRank: 3 }, { label: "ids", kind: "port", detail: "ids.new → UUID", insertText: "ids.new", sortRank: 3 });
  items.push(...KEYWORDS.filter((k) => ["null", "true", "false"].includes(k.label)));
  return items;
}

/** Value of a sibling key in the same mapping (flow map on the line, or nearby block lines). */
function siblingValue(s: Snapshot, key: string): string | undefined {
  const line = s.lines[s.lineIdx] ?? "";
  const flow = new RegExp(`[{,]\\s*${key}\\s*:\\s*([A-Za-z_][\\w]*)`).exec(line);
  if (flow) return flow[1];
  const indent = indentOf(line.replace(/^(\s*)-\s+/, "$1  "));
  for (const dir of [-1, 1]) {
    for (let i = s.lineIdx + dir; i >= 0 && i < s.lines.length; i += dir) {
      const l = s.lines[i]!;
      if (l.trim() === "") continue;
      const li = indentOf(l.replace(/^(\s*)-\s+/, "$1  "));
      if (li < indent) break;
      const m = new RegExp(`^\\s*(?:-\\s+)?${key}\\s*:\\s*([A-Za-z_][\\w]*)`).exec(l);
      if (m && li === indent) return m[1];
      if (/^\s*-\s/.test(l) && li <= indent && dir === -1) break;
    }
  }
  return undefined;
}

/**
 * The end of a value before the cursor, for the end-anchored patterns that find what is being completed
 * (`name.`, `event.a.b.`, `x ==`). Unanchored at the start, those patterns retry from every position,
 * which is quadratic in a long value; a bounded tail keeps each completion constant-time.
 */
const VALUE_TAIL = 256;
function valueBefore(text: string, valueStart: number, cursor: number): string {
  return text.slice(Math.max(valueStart, cursor - VALUE_TAIL), cursor);
}

function expressionCompletions(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  const ctx = scope.context;
  if (!ctx) return [];
  const env = exprEnv(s, scope, pos);
  const before = valueBefore(s.text, pos.valueStart, pos.from);
  env.item = itemTypeIn(s, ctx, env, s.text.slice(pos.valueStart, pos.from));

  // Member access: `something.` → members of that value.
  const dot = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.$/.exec(before);
  if (dot) return memberCompletions(s, ctx, env, dot[1]!);

  const items: CompletionItem[] = [];
  // Enum values first when comparing with / assigning to an enum-typed value.
  const expectedEnum = expectedEnumType(s, ctx, env, pos, before);
  if (expectedEnum) {
    const en = ctx.enums.find((e) => e.name === expectedEnum);
    for (const v of en?.values ?? []) items.push({ label: v, kind: "enumValue", detail: `${expectedEnum}.${v}`, sortRank: 0 });
  }
  if (env.guardsBare && scope.aggregate) {
    for (const g of scope.aggregate.stateGuards) {
      items.push({
        label: g.name,
        kind: "guard",
        insertText: g.parameters.length ? `${g.name}(` : g.name,
        detail: `(${g.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → ${g.error}`,
        documentation: g.expression,
        sortRank: 0,
      });
    }
  }
  for (const [n, t] of env.params) items.push({ label: n, kind: "parameter", detail: typeToString(t), sortRank: 1 });
  for (const [n, t] of env.fields) items.push({ label: n, kind: "field", detail: typeToString(t), sortRank: 1 });
  for (const [n, t] of env.locals) items.push({ label: n, kind: env.inputs.has(n) ? "field" : "variable", detail: env.inputs.has(n) ? `入力: ${typeToString(t)}` : typeToString(t), sortRank: 1 });
  if (env.item) items.push({ label: "item", kind: "variable", detail: `${typeToString(env.item)} — 今の要素`, sortRank: 0 });
  for (const v of ctx.valueObjects) items.push({ label: v.name, kind: "type", insertText: `${v.name}(`, detail: `Value object: ${v.name}(${v.fields.map((f) => `${f.name}=`).join(", ")})`, sortRank: 5 });
  if (scope.aggregate) {
    for (const en of scope.aggregate.entities) items.push({ label: en.name, kind: "type", insertText: `${en.name}(`, detail: `Entity: ${en.name}(${en.fields.map((f) => `${f.name}=`).join(", ")})`, sortRank: 5 });
  }
  if (env.useCase) {
    items.push({ label: "clock", kind: "port", detail: "clock.now → DateTime", insertText: "clock.now", sortRank: 3 }, { label: "ids", kind: "port", detail: "ids.new → UUID", insertText: "ids.new", sortRank: 3 });
    for (const x of ctx.extensionPoints) {
      items.push({ label: x.name, kind: "extension", insertText: `${x.name}(`, detail: `(${x.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → ${x.returns}`, documentation: x.description, sortRank: 2 });
    }
  }
  for (const e of ctx.enums) items.push({ label: e.name, kind: "type", detail: "Enum", sortRank: 5 });
  items.push(...FUNCTIONS.map((f) => ({ ...f, sortRank: 4 })), ...KEYWORDS);
  return items;
}

function typeOfPath(s: Snapshot, ctx: ContextIR, env: ExprEnvInfo, path: string): Type | undefined {
  const [head, ...rest] = path.split(".");
  let t: Type | undefined = head === "item" && env.item ? env.item : (env.params.get(head!) ?? env.locals.get(head!) ?? env.fields.get(head!));
  for (const seg of rest) {
    if (!t) return undefined;
    const b = unwrap(t);
    const owner = b.k === "vo" || b.k === "entity" || b.k === "aggregate" ? b.name : undefined;
    t = fieldTypesOf(s, owner).get(seg);
  }
  return t;
}

function expectedEnumType(s: Snapshot, ctx: ContextIR, env: ExprEnvInfo, pos: Extract<Position, { kind: "value" }>, before: string): string | undefined {
  const cmp = /([A-Za-z_][\w.]*)\s*(==|!=)\s*$/.exec(before);
  if (cmp) {
    const t = typeOfPath(s, ctx, env, cmp[1]!);
    const b = t && unwrap(t);
    if (b?.k === "enum") return b.name;
  }
  if (pos.container === "exprMap:changes" || pos.container === "exprMap:factoryFields") {
    const t = fieldTypesOf(s, resolveScopeOwner(s)).get(pos.key);
    const b = t && unwrap(t);
    if (b?.k === "enum") return b.name;
  }
  return undefined;
}

function resolveScopeOwner(s: Snapshot): string | undefined {
  const sc = resolveScope(s);
  return (sc.entity ?? sc.aggregate)?.name;
}

function memberCompletions(s: Snapshot, ctx: ContextIR, env: ExprEnvInfo, path: string): CompletionItem[] {
  if (path === "clock" && env.useCase) return [{ label: "now", kind: "port", detail: "DateTime — 現在時刻" }];
  if (path === "ids" && env.useCase) return [{ label: "new", kind: "port", detail: "UUID — 新しいID" }];
  const en = ctx.enums.find((e) => e.name === path);
  if (en && !env.fields.has(path) && !env.locals.has(path)) return en.values.map((v) => ({ label: v, kind: "enumValue" as const, detail: en.name }));
  const t = typeOfPath(s, ctx, env, path);
  if (!t) return [];
  const b = unwrap(t);
  const items: CompletionItem[] = [];
  if (b.k === "vo" || b.k === "entity" || b.k === "aggregate") {
    for (const [n, ft] of fieldTypesOf(s, b.name)) items.push({ label: n, kind: "field", detail: typeToString(ft) });
  }
  if (b.k === "aggregate" && env.useCase) {
    const ag = ctx.aggregates.find((a) => a.name === b.name);
    for (const g of ag?.stateGuards ?? []) {
      items.push({ label: g.name, kind: "guard", insertText: g.parameters.length ? `${g.name}(` : g.name, detail: `(${g.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → Boolean`, documentation: g.expression, sortRank: 0 });
    }
  }
  return items;
}

function dataCompletions(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "value" }>): CompletionItem[] {
  // Values inside scenario data: suggest enum values for enum-typed fields.
  const ctx = scope.context;
  if (!ctx) return [];
  const owner = dataOwner(s, scope, pos.container);
  const t = fieldTypesOf(s, owner).get(pos.key);
  const b = t && unwrap(t);
  if (b?.k === "enum") return (ctx.enums.find((e) => e.name === b.name)?.values ?? []).map((v) => ({ label: v, kind: "enumValue" as const, detail: b.name }));
  if (b?.k === "primitive" && b.name === "Boolean") return [{ label: "true", kind: "value" }, { label: "false", kind: "value" }];
  return [];
}

function dataOwner(s: Snapshot, scope: Scope, container: Container): string | undefined {
  switch (container) {
    case "data:aggregate":
      return scope.aggregate?.name;
    case "data:input":
      return scope.useCase?.command;
    case "data:givenAggregate":
      return siblingValueAbove(s, "type");
    case "data:expectedState":
      return siblingValueAbove(s, "aggregate");
    case "data:event":
      return undefined;
    default:
      return undefined;
  }
}

function siblingValueAbove(s: Snapshot, key: string): string | undefined {
  for (let i = s.lineIdx; i >= 0 && i > s.lineIdx - 40; i--) {
    const m = new RegExp(`^\\s*(?:-\\s+)?${key}\\s*:\\s*([A-Za-z_]\\w*)`).exec(s.lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}

function dataKeyCompletions(s: Snapshot, scope: Scope, container: Container): CompletionItem[] {
  const owner = dataOwner(s, scope, container);
  return [...fieldTypesOf(s, owner)].map(([n, t]) => ({ label: n, kind: "field" as const, detail: typeToString(t) }));
}

function keyCompletions(s: Snapshot, scope: Scope, pos: Extract<Position, { kind: "key" }>): CompletionItem[] {
  if (pos.container.startsWith("data:")) return dataKeyCompletions(s, scope, pos.container);
  if (pos.container === "exprMap:changes" || pos.container === "exprMap:factoryFields") {
    const owner = scope.aggregate;
    return (owner?.fields ?? []).filter((f) => f.name !== owner?.identity || pos.container === "exprMap:factoryFields").map((f) => ({ label: f.name, kind: "field" as const, detail: f.type }));
  }
  if (pos.container === "exprMap:args") {
    const target = siblingValue(s, "target");
    const ctx = scope.context;
    let params: { name: string; type: string }[] = [];
    if (scope.useCase && ctx) {
      const vars = bindingsBefore(scope.useCase.steps, s);
      const invokeOp = siblingValue(s, "operation");
      const ag = ctx.aggregates.find((a) => a.name === (target ? vars.get(target) : siblingValue(s, "aggregate")));
      const member = ag?.operations.find((o) => o.name === invokeOp) ?? ag?.factories.find((f) => f.name === siblingValue(s, "factory"));
      params = member?.parameters ?? [];
    }
    return params.map((p) => ({ label: p.name, kind: "parameter" as const, detail: p.type }));
  }
  if (pos.container === "exprMap:policyArgs") {
    const uc = scope.context?.useCases.find((u) => u.name === scope.policy?.run);
    const present = new Set(siblingKeys(s, pos));
    return (uc?.input ?? []).filter((f) => !present.has(f.name)).map((f, i) => ({ label: f.name, kind: "field" as const, detail: `${f.type}${f.required ? "" : "（省略可）"}`, insertText: `${f.name}: `, sortRank: i }));
  }
  // authorize / rate_limit / given.principal only mean something once the model declares security.
  const securityKeys = new Set(s.model?.security ? [] : ["authorize", "rate_limit", "principal"]);
  const keys = (KEYS[pos.container] ?? []).filter((k) => !(securityKeys.has(k.key) && ["aggregate", "useCase", "given:useCase"].includes(pos.container)));
  // Hide keys already present in the same mapping.
  const present = new Set(siblingKeys(s, pos));
  return keys.filter((k) => !present.has(k.key)).map((k, i) => ({ label: k.key, kind: "key" as const, detail: k.doc, insertText: `${k.key}: `, sortRank: i }));
}

function siblingKeys(s: Snapshot, pos: Extract<Position, { kind: "key" }>): string[] {
  const line = s.lines[s.lineIdx] ?? "";
  if (pos.flow) return [...line.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]!);
  const indent = indentOf(line.replace(/^(\s*)-\s+/, "$1  "));
  const startsItem = /^\s*-\s/.test(line);
  const out: string[] = [];
  for (const dir of [-1, 1]) {
    if (dir === -1 && startsItem) continue; // a new list item has no keys above it
    for (let i = s.lineIdx + dir; i >= 0 && i < s.lines.length; i += dir) {
      const l = s.lines[i]!;
      if (l.trim() === "") continue;
      const li = indentOf(l.replace(/^(\s*)-\s+/, "$1  "));
      if (li < indent) break;
      const m = /^\s*(-\s+)?([A-Za-z_]\w*)\s*:/.exec(l);
      if (m && li === indent) {
        if (m[1] && dir === 1) break; // next list item
        out.push(m[2]!);
        if (m[1] && dir === -1) break; // start of this list item
      }
    }
  }
  return out;
}

export function complete(text: string, offset: number): CompletionResult {
  const s = takeSnapshot(text, offset);
  const pos = classify(s);
  if (pos.kind === "none") return { from: offset, to: offset, items: [] };
  const scope = resolveScope(s);
  const items = pos.kind === "key" ? keyCompletions(s, scope, pos) : valueCompletions(s, scope, pos);
  const partial = pos.partial.toLowerCase();
  const filtered = items
    .filter((i) => !partial || i.label.toLowerCase().startsWith(partial))
    .sort((a, b) => (a.sortRank ?? 5) - (b.sortRank ?? 5));
  const seen = new Set<string>();
  const unique = filtered.filter((i) => (seen.has(i.label + i.kind) ? false : (seen.add(i.label + i.kind), true)));
  return { from: pos.from, to: offset, items: unique };
}

// ---------------------------------------------------------------------------
// Symbols: hover, definition, rename
// ---------------------------------------------------------------------------

type SymbolRef =
  | { kind: "key"; key: string; doc: string }
  | { kind: "type"; ctx: ContextIR; name: string }
  | { kind: "guard"; ctx: ContextIR; aggregate: AggregateIR; guard: StateGuardIR }
  | { kind: "field"; ctx: ContextIR; owner: string; name: string; type?: Type }
  | { kind: "parameter"; name: string; type?: Type; path: Path }
  | { kind: "variable"; name: string; aggregate: string; path: Path }
  | { kind: "enumValue"; ctx: ContextIR; enumName: string; value: string }
  | { kind: "operation"; ctx: ContextIR; aggregate: AggregateIR; op: OperationIR | FactoryIR }
  | { kind: "extension"; ctx: ContextIR; name: string }
  | { kind: "function"; name: string }
  | { kind: "port"; name: string }
  | { kind: "context"; ctx: ContextIR }
  | { kind: "useCase"; ctx: ContextIR; useCase: UseCaseIR }
  | { kind: "pattern"; name: string };

function wordAt(text: string, offset: number): { from: number; to: number; word: string } | undefined {
  let from = offset;
  let to = offset;
  while (from > 0 && /[A-Za-z0-9_]/.test(text[from - 1]!)) from--;
  while (to < text.length && /[A-Za-z0-9_]/.test(text[to]!)) to++;
  if (from === to) return undefined;
  return { from, to, word: text.slice(from, to) };
}

function symbolAt(text: string, offset: number): { ref: SymbolRef; from: number; to: number } | undefined {
  const w = wordAt(text, offset);
  if (!w) return undefined;
  const s = takeSnapshot(text, w.to);
  const pos = classify({ ...s, offset: w.to, col: w.to - s.lineStart });
  const scope = resolveScope(s);
  const ctx = scope.context;
  if (pos.kind === "key") {
    const doc = (KEYS[pos.container] ?? []).find((k) => k.key === w.word)?.doc;
    // A key being hovered: `from` sits inside the key itself.
    if (doc) return { ref: { kind: "key", key: w.word, doc }, ...w };
    return undefined;
  }
  if (pos.kind === "value" && pos.valueStart > w.from) {
    // Cursor is on the key part of `key: value`.
    const container = pos.container;
    const doc = (KEYS[container] ?? []).find((k) => k.key === w.word)?.doc;
    if (doc) return { ref: { kind: "key", key: w.word, doc }, ...w };
    return undefined;
  }
  if (pos.kind === "value" && pos.container === "relationship") {
    if (pos.key === "upstream" || pos.key === "downstream") {
      const c = contextByName(s, w.word);
      return c ? { ref: { kind: "context", ctx: c }, ...w } : undefined;
    }
    if (pos.key === "pattern" && PATTERN_DOCS[w.word]) return { ref: { kind: "pattern", name: w.word }, ...w };
    if (pos.key === "events") {
      const up = contextByName(s, relationshipUpstream(s));
      if (up && s.analysis?.contexts.get(up.name)?.events.has(w.word)) return { ref: { kind: "type", ctx: up, name: w.word }, ...w };
    }
    return undefined;
  }
  if (pos.kind !== "value" || !ctx) return undefined;
  const name = w.word;
  if (pos.container === "policy" && pos.key === "when") {
    const scalar = text.slice(pos.valueStart, text.indexOf("\n", pos.valueStart) === -1 ? text.length : text.indexOf("\n", pos.valueStart)).replace(/\s#.*$/, "");
    const ref = parseEventRef(scalar);
    if (!ref) return undefined;
    const isContextPart = !!ref.context && text.slice(w.to).trimStart().startsWith(".");
    if (isContextPart) {
      const c = contextByName(s, name);
      return c ? { ref: { kind: "context", ctx: c }, ...w } : undefined;
    }
    const evCtx = contextByName(s, ref.context ?? ctx.name);
    if (evCtx && s.analysis?.contexts.get(evCtx.name)?.events.has(name)) return { ref: { kind: "type", ctx: evCtx, name }, ...w };
    return undefined;
  }
  if (pos.container === "policy" && pos.key === "run") {
    const uc = ctx.useCases.find((u) => u.name === name);
    return uc ? { ref: { kind: "useCase", ctx, useCase: uc }, ...w } : undefined;
  }
  if (pos.container === "exprMap:policyArgs") {
    const before = valueBefore(text, pos.valueStart, w.from);
    if (name === "clock" || name === "ids") return { ref: { kind: "port", name }, ...w };
    if (/\b(clock|ids)\s*\.\s*$/.test(before)) return { ref: { kind: "port", name: `${/\b(clock|ids)\s*\.\s*$/.exec(before)![1]}.${name}` }, ...w };
    const ev = policyEvent(s, ctx, scope.policy);
    if (!ev) return undefined;
    if (name === "event" && !/\.\s*$/.test(before)) return { ref: { kind: "type", ctx: ev.ctx, name: ev.info.name }, ...w };
    const path = /\bevent((?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$/.exec(before);
    if (path) {
      const target = eventPathType(s, ev, path[1]!.split(".").map((x) => x.trim()).filter(Boolean));
      const t = target?.fields.get(name);
      if (target && t) return { ref: { kind: "field", ctx: ev.ctx, owner: target.owner, name, type: t }, ...w };
    }
    for (const en of ctx.enums) if (en.values.includes(name)) return { ref: { kind: "enumValue", ctx, enumName: en.name, value: name }, ...w };
    return undefined;
  }
  const isType = (n: string) =>
    ctx.errors.some((e) => e.name === n) ||
    ctx.enums.some((e) => e.name === n) ||
    ctx.valueObjects.some((v) => v.name === n) ||
    ctx.aggregates.some((a) => a.name === n || a.entities.some((e) => e.name === n)) ||
    !!s.analysis?.contexts.get(ctx.name)?.events.has(n);

  const isExpr =
    EXPRESSION_KEYS.has(pos.key) ||
    pos.container === "exprMap:changes" ||
    pos.container === "exprMap:factoryFields" ||
    pos.container === "exprMap:args" ||
    pos.key === "require" ||
    pos.container === "require" ||
    ((pos.container === "eventField" || pos.container === "step:let") && pos.key === "value");

  if (isExpr) {
    const env = exprEnv(s, scope, pos);
    const before = valueBefore(text, pos.valueStart, w.from);
    env.item = itemTypeIn(s, ctx, env, text.slice(pos.valueStart, w.from));
    if (name === "item" && env.item && !before.endsWith(".")) return { ref: { kind: "variable", name, aggregate: `${typeToString(env.item)}（コレクション関数の今の要素）`, path: [] }, ...w };
    const dot = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.$/.exec(before);
    if (dot) {
      const base = dot[1]!;
      const en = ctx.enums.find((e) => e.name === base);
      if (en) return { ref: { kind: "enumValue", ctx, enumName: en.name, value: name }, ...w };
      if (base === "clock" || base === "ids") return { ref: { kind: "port", name: `${base}.${name}` }, ...w };
      const t = typeOfPath(s, ctx, env, base);
      const b = t && unwrap(t);
      if (b && (b.k === "vo" || b.k === "entity" || b.k === "aggregate")) {
        if (b.k === "aggregate") {
          const ag = ctx.aggregates.find((a) => a.name === b.name);
          const g = ag?.stateGuards.find((x) => x.name === name);
          if (ag && g) return { ref: { kind: "guard", ctx, aggregate: ag, guard: g }, ...w };
        }
        return { ref: { kind: "field", ctx, owner: b.name, name, type: fieldTypesOf(s, b.name).get(name) }, ...w };
      }
      return undefined;
    }
    if (env.params.has(name)) {
      const member = scope.guard ?? scope.operation ?? scope.factory;
      const p = member?.parameters.find((x) => x.name === name);
      return { ref: { kind: "parameter", name, type: env.params.get(name), path: p?.path ?? [] }, ...w };
    }
    if (env.locals.has(name)) {
      if (env.inputs.has(name)) return { ref: { kind: "field", ctx, owner: scope.useCase!.command, name, type: env.locals.get(name) }, ...w };
      const t = env.locals.get(name)!;
      const step = findBinding(scope.useCase!.steps, name);
      return { ref: { kind: "variable", name, aggregate: t.k === "aggregate" ? t.name : typeToString(t), path: step ? [...step.path, step.kind === "let" ? "name" : "as"] : [] }, ...w };
    }
    if (env.fields.has(name)) {
      const owner = scope.entity ?? scope.aggregate ?? scope.valueObject;
      return { ref: { kind: "field", ctx, owner: owner!.name, name, type: env.fields.get(name) }, ...w };
    }
    if (scope.aggregate) {
      const g = scope.aggregate.stateGuards.find((x) => x.name === name);
      if (g) return { ref: { kind: "guard", ctx, aggregate: scope.aggregate, guard: g }, ...w };
    }
    if (ctx.extensionPoints.some((x) => x.name === name)) return { ref: { kind: "extension", ctx, name }, ...w };
    if (FUNCTION_NAMES.has(name)) return { ref: { kind: "function", name }, ...w };
    if (name === "clock" || name === "ids") return { ref: { kind: "port", name }, ...w };
    for (const en of ctx.enums) if (en.values.includes(name)) return { ref: { kind: "enumValue", ctx, enumName: en.name, value: name }, ...w };
    if (isType(name)) return { ref: { kind: "type", ctx, name }, ...w };
    return undefined;
  }

  if (pos.key === "operation" || pos.key === "factory") {
    let ag = scope.aggregate;
    if (scope.useCase && !ag) {
      const target = siblingValue(s, "target");
      const agName = target ? bindingsBefore(scope.useCase.steps, s).get(target) : siblingValue(s, "aggregate");
      ag = ctx.aggregates.find((a) => a.name === agName);
    }
    const op = pos.key === "operation" ? ag?.operations.find((o) => o.name === name) : ag?.factories.find((f) => f.name === name);
    if (ag && op) return { ref: { kind: "operation", ctx, aggregate: ag, op }, ...w };
  }
  if ((pos.key === "save" || pos.key === "target") && scope.useCase) {
    const step = findBinding(scope.useCase.steps, name);
    if (step && (step.kind === "load" || step.kind === "create")) return { ref: { kind: "variable", name, aggregate: step.aggregate, path: [...step.path, "as"] }, ...w };
  }
  if (pos.key === "identity") {
    const owner = scope.entity ?? scope.aggregate;
    if (owner?.fields.some((f) => f.name === name)) return { ref: { kind: "field", ctx, owner: owner.name, name }, ...w };
  }
  if (pos.container.startsWith("data:")) {
    const owner = dataOwner(s, scope, pos.container);
    const t = fieldTypesOf(s, owner).get(pos.key);
    const b = t && unwrap(t);
    if (b?.k === "enum" && ctx.enums.find((e) => e.name === b.name)?.values.includes(name)) return { ref: { kind: "enumValue", ctx, enumName: b.name, value: name }, ...w };
  }
  if (isType(name)) return { ref: { kind: "type", ctx, name }, ...w };
  if (ctx.useCases.some((u) => u.command === name)) return { ref: { kind: "type", ctx, name }, ...w };
  return undefined;
}

function findBinding(steps: StepIR[], name: string): StepIR | undefined {
  for (const st of steps) {
    if ((st.kind === "load" || st.kind === "create") && st.as === name) return st;
    if (st.kind === "let" && st.name === name) return st;
    if (st.kind === "if") {
      const r = findBinding(st.then, name) ?? findBinding(st.else, name);
      if (r) return r;
    }
  }
  return undefined;
}

function describeType(ctx: ContextIR, name: string, analysis?: Analysis): { markdown: string; path?: Path } {
  const err = ctx.errors.find((e) => e.name === name);
  if (err) return { markdown: `**${name}** — Domain error\n\n- code: \`${err.code}\`\n- message: ${err.message}`, path: [...err.path, "name"] };
  const en = ctx.enums.find((e) => e.name === name);
  if (en) return { markdown: `**${name}** — Enum\n\n値: ${en.values.map((v) => `\`${v}\``).join(", ")}`, path: [...en.path, "name"] };
  const vo = ctx.valueObjects.find((v) => v.name === name);
  if (vo) return { markdown: `**${name}** — Value object${vo.description ? `\n\n${vo.description}` : ""}\n\n${vo.fields.map((f) => `- \`${f.name}\`: ${f.type}`).join("\n")}`, path: [...vo.path, "name"] };
  for (const a of ctx.aggregates) {
    if (a.name === name) {
      return {
        markdown: `**${name}** — Aggregate${a.description ? `\n\n${a.description}` : ""}\n\n${a.fields.map((f) => `- \`${f.name}\`: ${f.type}${f.required ? "" : "?"}`).join("\n")}\n\n操作: ${a.operations.map((o) => `\`${o.name}\``).join(", ") || "—"}`,
        path: [...a.path, "name"],
      };
    }
    const en2 = a.entities.find((e) => e.name === name);
    if (en2) return { markdown: `**${name}** — Entity（${a.name} 内）\n\n${en2.fields.map((f) => `- \`${f.name}\`: ${f.type}`).join("\n")}`, path: [...en2.path, "name"] };
  }
  const ev = analysis?.contexts.get(ctx.name)?.events.get(name);
  if (ev) {
    const src = ev.sources[0]!;
    const ag = ctx.aggregates.find((a) => a.name === src.aggregate);
    const member = ag && [...ag.factories, ...ag.operations].find((m) => m.name === src.member);
    const em = member?.emits.find((e) => e.name === name);
    return {
      markdown: `**${name}** — Domain event\n\nペイロード: ${ev.fields.map((f) => `\`${f.name}\`: ${typeToString(f.type)}`).join(", ") || "なし"}\n\n発生元: ${ev.sources.map((x) => `${x.aggregate}.${x.member}`).join(", ")}`,
      path: em ? [...em.path, "name"] : undefined,
    };
  }
  const uc = ctx.useCases.find((u) => u.command === name);
  if (uc) return { markdown: `**${name}** — Command（${uc.name} の入力）\n\n${uc.input.map((f) => `- \`${f.name}\`: ${f.type}`).join("\n")}`, path: [...uc.path, "command"] };
  return { markdown: `**${name}**` };
}

function describe(ref: SymbolRef, s: { analysis?: Analysis; model?: ModelIR }): { markdown: string; path?: Path } {
  switch (ref.kind) {
    case "key":
      return { markdown: `\`${ref.key}\` — ${ref.doc}` };
    case "type":
      return describeType(ref.ctx, ref.name, s.analysis);
    case "guard": {
      const g = ref.guard;
      const users = ref.aggregate.operations.filter((o) => o.require.some((r) => r.startsWith(g.name))).map((o) => o.name);
      return {
        markdown: `**${g.name}**(${g.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) — State guard\n\n\`${g.expression}\`\n\n違反時: ${g.error}${users.length ? `\n\n自動確認する操作: ${users.join(", ")}` : ""}${g.description ? `\n\n${g.description}` : ""}`,
        path: [...g.path, "name"],
      };
    }
    case "field": {
      const agOrVo =
        ref.ctx.aggregates.flatMap((a) => [a, ...a.entities]).find((x) => x.name === ref.owner) ??
        ref.ctx.valueObjects.find((v) => v.name === ref.owner);
      const uc = ref.ctx.useCases.find((u) => u.command === ref.owner);
      const f = (agOrVo?.fields ?? uc?.input ?? []).find((x) => x.name === ref.name);
      return {
        markdown: `\`${ref.name}\`: ${ref.type ? typeToString(ref.type) : f?.type ?? "?"} — ${ref.owner} のフィールド${f?.description ? `\n\n${f.description}` : ""}`,
        path: f ? [...f.path, "name"] : undefined,
      };
    }
    case "parameter":
      return { markdown: `\`${ref.name}\`: ${ref.type ? typeToString(ref.type) : "?"} — 引数`, path: ref.path.length ? [...ref.path, "name"] : undefined };
    case "variable":
      return { markdown: `\`${ref.name}\`: ${ref.aggregate}${ref.path.length === 0 ? "" : ref.path[ref.path.length - 1] === "name" ? " — let で名付けた値" : " — 手順で読み込んだ／作った変数"}`, path: ref.path.length ? ref.path : undefined };
    case "enumValue": {
      const en = ref.ctx.enums.find((e) => e.name === ref.enumName)!;
      return { markdown: `\`${ref.value}\` — ${ref.enumName} の値（Python: \`${ref.enumName}.${ref.value.toUpperCase()}\`）`, path: [...en.path, "values", en.values.indexOf(ref.value)] };
    }
    case "operation": {
      const o = ref.op;
      const isOp = "changes" in o;
      return {
        markdown: `**${o.name}**(${o.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) — ${isOp ? "Operation" : "Factory"} of ${ref.aggregate.name}${o.description ? `\n\n${o.description}` : ""}${o.require.length ? `\n\n前提: ${o.require.join(", ")}` : ""}${o.emits.length ? `\n\n発生: ${o.emits.map((e) => e.name).join(", ")}` : ""}`,
        path: [...o.path, "name"],
      };
    }
    case "extension": {
      const x = ref.ctx.extensionPoints.find((e) => e.name === ref.name)!;
      return { markdown: `**${x.name}**(${x.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → ${x.returns} — Extension point（顧客コード）${x.description ? `\n\n${x.description}` : ""}`, path: [...x.path, "name"] };
    }
    case "function":
      return { markdown: FUNCTIONS.find((f) => f.label === ref.name)!.detail + "\n\n" + FUNCTIONS.find((f) => f.label === ref.name)!.documentation };
    case "port":
      return { markdown: ref.name.startsWith("clock") ? "`clock.now` — 現在時刻（Use case の手順とポリシーの args で使える）" : "`ids.new` — 新しいID（Use case の手順とポリシーの args で使える）" };
    case "context": {
      const c = ref.ctx;
      const rels = (s.model?.relationships ?? []).filter((r) => r.upstream === c.name || r.downstream === c.name);
      return {
        markdown: `**${c.name}** — Bounded context${c.description ? `\n\n${c.description}` : ""}\n\n集約: ${c.aggregates.map((a) => `\`${a.name}\``).join(", ") || "—"}\n\nポリシー: ${c.policies.map((p) => `\`${p.name}\``).join(", ") || "—"}${rels.length ? `\n\n関係: ${rels.map((r) => `${r.upstream} → ${r.downstream}（${r.pattern}）`).join(", ")}` : ""}`,
        path: [...c.path, "name"],
      };
    }
    case "useCase": {
      const u = ref.useCase;
      return {
        markdown: `**${u.name}** — Use case（${ref.ctx.name}）${u.description ? `\n\n${u.description}` : ""}\n\n入力（${u.command}）: ${u.input.map((f) => `\`${f.name}\`: ${f.type}${f.required ? "" : "?"}`).join(", ") || "なし"}`,
        path: [...u.path, "name"],
      };
    }
    case "pattern":
      return { markdown: `\`${ref.name}\` — ${PATTERN_DOCS[ref.name]}` };
  }
}

export function hover(text: string, offset: number): HoverResult | undefined {
  const sym = symbolAt(text, offset);
  if (!sym) return undefined;
  const s = takeSnapshot(text, offset);
  return { from: sym.from, to: sym.to, markdown: describe(sym.ref, s).markdown };
}

export function definition(text: string, offset: number): DefinitionResult | undefined {
  const sym = symbolAt(text, offset);
  if (!sym) return undefined;
  const s = takeSnapshot(text, offset);
  const { path } = describe(sym.ref, s);
  if (!path) return undefined;
  const r = s.parsed.rangeOf(path);
  return r ? { from: r[0], to: r[1] } : undefined;
}

export type RenameCheck = { ok: true; from: number; to: number; name: string } | { ok: false; error: string };

/** Whether the symbol at `offset` can be renamed (types and state guards update every reference). */
export function prepareRename(text: string, offset: number): RenameCheck {
  const sym = symbolAt(text, offset);
  if (!sym) return { ok: false, error: "名前を変更できる要素がありません" };
  if (sym.ref.kind === "type" || sym.ref.kind === "guard") return { ok: true, from: sym.from, to: sym.to, name: text.slice(sym.from, sym.to) };
  return { ok: false, error: "名前の一括変更に対応しているのは型（Aggregate / Entity / Value object / Enum / Error / Event）と State guard です" };
}

export function rename(text: string, offset: number, newName: string): EditResult {
  const sym = symbolAt(text, offset);
  if (!sym) return { ok: false, error: "名前を変更できる要素がありません" };
  if (sym.ref.kind === "type") return applyEdits(text, [{ op: "renameType", context: sym.ref.ctx.name, from: sym.ref.name, to: newName }]);
  if (sym.ref.kind === "guard") return applyEdits(text, [{ op: "renameGuard", context: sym.ref.ctx.name, aggregate: sym.ref.aggregate.name, from: sym.ref.guard.name, to: newName }]);
  return { ok: false, error: prepareRename(text, offset).ok ? "" : "この要素の名前は一括変更できません" };
}
