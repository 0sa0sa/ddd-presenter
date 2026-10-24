/**
 * Proofs about the model (docs/09 §29): for every factory and operation of an aggregate, whether each check that can
 * reject it (an invariant, a value object's invariant, a field constraint) can fail once its `require` guards hold.
 * The solver (packages/verify, Z3) produces a `ProofReport`; this module only describes it: the result types, the
 * review questions, the warnings and the Markdown. It never runs a solver, so the web and the CLI can show a report
 * computed elsewhere.
 */
import { formatPath, type Diagnostic, type Path } from "./diagnostics.ts";
import type { AggregateIR, ContextIR } from "./ir.ts";
import type { Analysis } from "./validate.ts";

/** What can reject a factory or an operation. */
export type ProofSourceKind =
  /** An invariant of the aggregate root. */
  | "invariant"
  /** An invariant of an internal entity built or copied by the change (`OrderLine(...)`, `with(item, ...)`). */
  | "entity-invariant"
  /** An invariant of a value object built by the change (`Money(amount=..., ...)`). */
  | "vo-invariant"
  /** A field constraint (`min`, `max`, `max_length`, `max_items`, …) of the new state or a built object. */
  | "constraint"
  /** A transition-only invariant that a factory may leave false (it is checked only after the next operation). */
  | "initial";

export interface ProofSource {
  kind: ProofSourceKind;
  /** The aggregate, entity or value object the check belongs to. */
  owner: string;
  /** Invariant name, or the constrained field. */
  name: string;
  /** Error raised when the check fails (`ConstraintViolation` for constraints). */
  error: string;
  description?: string;
  /** The invariant's expression, or the constraint (`max: 100`). */
  expression: string;
  /** YAML path of the invariant or the field. */
  path: Path;
}

export type ProofOutcome =
  /** The check never fails (for lists of at most `bound` elements when `bound` is set). */
  | "proven"
  /** An example where the guards hold and the check fails. */
  | "counterexample"
  /** The solver gave up (time limit) or the expressions use something the encoding does not cover. */
  | "unknown";

/** Concrete values of a counterexample or witness, as scenario data (decimals and instants are strings). */
export interface ProofExample {
  /** The aggregate before the operation (absent for a factory). */
  state?: Record<string, unknown>;
  args: Record<string, unknown>;
  /** The candidate state the failing check saw. */
  after?: Record<string, unknown>;
  /** State fields that matter (read by the check, the guards or the changes); the text shows only these. */
  focus?: string[];
}

export interface ProofResult {
  /** `proof:<Context>.<Aggregate>.<factory|operation>.<source>:<fingerprint>`; changes when what is proven changes. */
  id: string;
  context: string;
  aggregate: string;
  kind: "factory" | "operation";
  /** The factory or operation. */
  name: string;
  source: ProofSource;
  outcome: ProofOutcome;
  /** Lists were checked with at most this many elements (absent: no list is involved, the proof is complete). */
  bound?: number;
  /** Why the outcome is unknown, or a remark on a bounded proof. */
  note?: string;
  example?: ProofExample;
  /**
   * For a counterexample: steps from a factory that reach it (`open`, `add_line`, `remove_line`), when one was found
   * within the search depth. Absent: the starting state was not shown to be reachable (an invariant may be missing).
   */
  trace?: string[];
  /** YAML path of the factory or operation. */
  path: Path;
  /**
   * A Lean 4 proof of the same statement for lists of any length (`ddd verify --lean … --prove`): written by a prover
   * (Claude), checked by Lean, resting only on Lean's standard axioms.
   */
  lean?: { status: "proven" | "failed"; attempts: number; error?: string };
}

/** Whether an operation (or factory) can succeed at all. */
export interface ProofRun {
  context: string;
  aggregate: string;
  kind: "factory" | "operation";
  name: string;
  /** false: no state and arguments get through every guard and check; undefined: not decided. */
  canSucceed: boolean | undefined;
  bound?: number;
  note?: string;
  /** A successful call (when `canSucceed`). */
  witness?: ProofExample;
  path: Path;
}

export interface ProofReport {
  results: ProofResult[];
  runs: ProofRun[];
  /** What the proofs assume (shown with them: "verified" is only as good as these). */
  assumptions: string[];
  solver: string;
  elapsedMs: number;
}

/** The proof assumptions, in Japanese (the CLI, the web and the docs show the same list). */
export const PROOF_ASSUMPTIONS = [
  "操作の前の Aggregate は、すべての Invariant とフィールドの制約を満たし、状態のフィールドはたどり着ける値のどれかである（どの手順でそこに来たかは問わない）。",
  "引数の値オブジェクト・エンティティは、それ自身の Invariant と制約を満たす。",
  "Decimal は有理数として、Integer は上限のない整数として扱う（decimal_places は守る）。日時は時刻の数値として扱う。",
  "文字列は「同じか違うか」と長さだけを見る（pattern・前後の空白の除去・大文字小文字の変換の中身は見ない）。",
  "リストを含む性質は、要素の数に上限を置いて調べる（上限は結果ごとに示す）。上限のない証明ではない。",
  "Use case（読み込み・保存・ほかの Aggregate）・Extension point・時計は対象外。Aggregate の Factory と Operation だけを調べる。",
];

/** FNV-1a (32-bit) of `text`, 8 hex digits. */
export function proofFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The id of a result: element names plus a fingerprint of everything the proof depends on (the guards, the changes,
 * the checked expression), so an answer stays with the statement it was given for.
 */
export function proofId(context: string, aggregate: string, kind: "factory" | "operation", name: string, source: ProofSource, depends: string): string {
  const src = `${source.kind}.${source.owner}.${source.name}`;
  return `proof:${context}.${aggregate}.${name}.${src}:${proofFingerprint(`${kind}\u0000${source.expression}\u0000${depends}`)}`;
}

const SOURCE_JA: Record<ProofSourceKind, string> = {
  invariant: "Invariant",
  "entity-invariant": "エンティティの Invariant",
  "vo-invariant": "値オブジェクトの Invariant",
  constraint: "フィールドの制約",
  initial: "操作のあとに確かめる Invariant",
};

/** `「description」（name）` or `name`. */
const called = (x: { name: string; description?: string }) => {
  const d = x.description?.trim().split("\n")[0]?.replace(/[。.]$/, "");
  return d ? `「${d}」（${x.name}）` : x.name;
};

/** The rule a source stands for, in words. */
export function proofSourceText(s: ProofSource): string {
  if (s.kind === "constraint") return `${s.owner}.${s.name} の制約（${s.expression}）`;
  const d = s.description?.trim().split("\n")[0]?.replace(/[。.]$/, "");
  return d ? `「${d}」（${s.owner}.${s.name}）` : `「${s.expression}」（${s.owner}.${s.name}）`;
}

function element(analysis: Analysis, r: { context: string; aggregate: string; name: string; kind: "factory" | "operation" }): { ctx?: ContextIR; ag?: AggregateIR; op?: { name: string; description?: string } } {
  const ctx = analysis.model.contexts.find((c) => c.name === r.context);
  const ag = ctx?.aggregates.find((a) => a.name === r.aggregate);
  const op = r.kind === "factory" ? ag?.factories.find((f) => f.name === r.name) : ag?.operations.find((o) => o.name === r.name);
  return { ctx, ag, op };
}

/** One line of example values: `status=open, discount=5.00 / 引数 line_id=1`. */
export function exampleText(x: ProofExample | undefined): string {
  if (!x) return "";
  const show = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "string") return v === "" ? '""' : v;
    if (Array.isArray(v)) return v.length > 3 ? `[${v.slice(0, 2).map(show).join(", ")}, …（全 ${v.length} 件）]` : `[${v.map(show).join(", ")}]`;
    if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, w]) => `${k}: ${show(w)}`).join(", ")}}`;
    return String(v);
  };
  const part = (r: Record<string, unknown> | undefined) => (r ? Object.entries(r).map(([k, v]) => `${k}=${show(v)}`).join(", ") : "");
  const focus = x.focus && x.state ? Object.fromEntries(Object.entries(x.state).filter(([k]) => x.focus!.includes(k))) : x.state;
  const state = part(focus);
  const args = part(x.args);
  return [state && `前の状態 ${state}`, args && `引数 ${args}`].filter(Boolean).join(" / ");
}

/**
 * Questions for the review (category `proofs`): one per counterexample ("this operation can be refused because of
 * this rule; is that intended?") and one per operation that can never succeed. Proven results are not asked: the
 * rule itself is already a question ("いつでも … が成り立つ"), and the proof shows the model keeps it.
 */
export function proofQuestions(analysis: Analysis, report: ProofReport): { id: string; text: string; modelAnswer: "yes" | "no"; basis: string; ifDifferent: string; element: string; path: Path }[] {
  const out: ReturnType<typeof proofQuestions> = [];
  for (const r of report.results) {
    if (r.outcome !== "counterexample") continue;
    const { op } = element(analysis, r);
    const what = op ? called(op) : r.name;
    const when = r.kind === "factory" ? "作るとき" : "するとき";
    const reached = r.trace?.length ? `手順 ${r.trace.join(" → ")} でたどり着く。` : "この前の状態にたどり着けるかは確かめていない（たどり着けないなら Invariant が足りない）。";
    const text =
      r.source.kind === "initial"
        ? `${what}で作った直後は、${proofSourceText(r.source)}が成り立たないことがある（次の操作で ${r.source.error} になる）。`
        : `${what}を${when}、${proofSourceText(r.source)}を守れなくなることがあり、そのときは ${r.source.error} で断られる。`;
    out.push({
      id: r.id,
      text,
      modelAnswer: "yes",
      basis: `反例（Z3）: ${exampleText(r.example)}。${r.kind === "operation" ? reached : ""}${r.bound ? `リストは ${r.bound} 個までで調べた。` : ""}`,
      ifDifferent:
        r.source.kind === "initial"
          ? `Factory の fields を直すか、${r.source.name} の check_on に construct を足す。`
          : `断られてはいけないなら、${r.name} の changes を直すか、require にガードを足して先に理由を示す。この前の状態が業務で起きないなら、それを Invariant として足す（反例が消える）。`,
      element: `${r.context} › ${r.aggregate} › ${r.name}`,
      path: r.path,
    });
  }
  for (const run of report.runs) {
    if (run.canSucceed !== false) continue;
    const { op } = element(analysis, run);
    out.push({
      id: `proof:never:${run.context}.${run.aggregate}.${run.name}:${proofFingerprint(formatPath(run.path))}`,
      text: `${op ? called(op) : run.name}は、どんな状態・引数でも成功しない。`,
      modelAnswer: "yes",
      basis: `ガードとチェックを全部満たす状態と引数がない（Z3${run.bound ? `、リストは ${run.bound} 個まで` : ""}）。`,
      ifDifferent: `${run.name} の require・changes か、それが破る Invariant を直す。`,
      element: `${run.context} › ${run.aggregate} › ${run.name}`,
      path: run.path,
    });
  }
  return out;
}

/** Warnings: an operation or factory that can never succeed (`never-succeeds`). */
export function proofDiagnostics(report: ProofReport): Diagnostic[] {
  return report.runs
    .filter((r) => r.canSucceed === false)
    .map((r) => ({
      severity: "warning" as const,
      code: "never-succeeds",
      message: `${r.kind === "factory" ? "Factory" : "Operation"} ${r.name} can never succeed: no state and arguments pass every guard and check${r.bound ? ` (lists of at most ${r.bound} elements)` : ""}`,
      path: r.path,
      element: `${r.context} › ${r.aggregate} › ${r.name}`,
      hint: "Check its require guards and changes against the invariants they must keep",
    }));
}

const OUTCOME_JA: Record<ProofOutcome, string> = { proven: "証明", counterexample: "反例", unknown: "不明" };

/** The report as Markdown (`ddd verify`). */
export function proofsMarkdown(project: string, report: ProofReport): string {
  const lines: string[] = [`# ${project}: モデルの証明`, ""];
  const n = (o: ProofOutcome) => report.results.filter((r) => r.outcome === o).length;
  lines.push(`${report.solver}。証明 ${n("proven")}・反例 ${n("counterexample")}・不明 ${n("unknown")}（${(report.elapsedMs / 1000).toFixed(1)} 秒）。`, "");
  lines.push("## 前提", "", ...report.assumptions.map((a) => `- ${a}`), "");
  const never = report.runs.filter((r) => r.canSucceed === false);
  if (never.length) {
    lines.push("## 成功しない操作", "");
    for (const r of never) lines.push(`- ${r.context}.${r.aggregate}.${r.name}${r.bound ? `（リスト ${r.bound} 個まで）` : ""}`);
    lines.push("");
  }
  const groups = new Map<string, ProofResult[]>();
  for (const r of report.results) groups.set(`${r.context}.${r.aggregate}`, [...(groups.get(`${r.context}.${r.aggregate}`) ?? []), r]);
  for (const [name, rs] of groups) {
    lines.push(`## ${name}`, "");
    lines.push("| 操作 | チェック | 結果 | 補足 |", "|---|---|---|---|");
    for (const r of rs) {
      const note = [
        r.lean?.status === "proven" ? "Lean で証明（リストの長さに上限なし）" : r.lean ? "Lean の証明は未完了" : "",
        r.outcome === "counterexample" ? exampleText(r.example) : "",
        r.trace?.length ? `手順: ${r.trace.join(" → ")}` : "",
        r.bound ? `リスト ${r.bound} 個まで` : "",
        r.note ?? "",
      ]
        .filter(Boolean)
        .join("。")
        .replace(/\|/g, "\\|");
      lines.push(`| ${r.kind === "factory" ? "Factory " : ""}${r.name} | ${SOURCE_JA[r.source.kind]} ${r.source.owner}.${r.source.name}（${r.source.error}） | ${OUTCOME_JA[r.outcome]} | ${note} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** A scenario name made of `parts` (snake_case, at most 60 characters) that is not in `taken`. */
function scenarioName(parts: string[], taken: Set<string>): string {
  const base = parts
    .join("_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase()
    .slice(0, 60)
    .replace(/_$/, "");
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** Scenario data without absent (null) optional values. */
function present(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
}

/**
 * The counterexample as an aggregate scenario (`given` the state, `when` the call, `then` raises the error), to add
 * under the aggregate's `scenarios`: the generated tests then check the generated code rejects exactly this case.
 * Undefined for constraint checks (they raise ConstraintViolation, which a scenario cannot name) and initial-state
 * results (nothing is rejected).
 */
export function proofScenario(model: { contexts: ContextIR[] }, r: ProofResult): { path: Path; value: Record<string, unknown> } | undefined {
  if (r.outcome !== "counterexample" || !r.example || r.source.kind === "constraint" || r.source.kind === "initial") return undefined;
  const ctx = model.contexts.find((c) => c.name === r.context);
  const ag = ctx?.aggregates.find((a) => a.name === r.aggregate);
  if (!ag) return undefined;
  const taken = new Set(ag.scenarios.map((s) => s.name));
  const name = scenarioName([r.name, "rejects", r.source.name], taken);
  const description = `Z3 の反例: ${r.name} が ${r.source.owner}.${r.source.name} を守れない場合は ${r.source.error} で断る。`;
  const value: Record<string, unknown> =
    r.kind === "operation"
      ? { name, description, given: { aggregate: present(r.example.state ?? {}) }, when: { operation: r.name, args: present(r.example.args) }, then: { raises: r.source.error } }
      : { name, description, when: { factory: r.name, args: present(r.example.args) }, then: { raises: r.source.error } };
  return { path: [...ag.path, "scenarios"], value };
}
