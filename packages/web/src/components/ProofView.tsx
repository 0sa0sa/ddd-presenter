import {
  applyEdits,
  exampleText,
  formatPath,
  proofScenario,
  proofSourceText,
  proofsMarkdown,
  validateModelText,
  type ModelIR,
  type Path,
  type ProofReport,
  type ProofResult,
  type ReviewQuestion,
  type ReviewVerdict,
} from "@ddd/core";
import { useMemo, useState } from "react";
import { downloadBlob, safeFileName } from "../lib/download.ts";
import type { StoredAnswer } from "../lib/review.ts";

const OUTCOME = { proven: "証明", counterexample: "反例", unknown: "不明" } as const;

/**
 * The proofs of the saved model (docs/11 §13): for every factory and operation, whether each check that can reject it
 * can fail once its guards hold. A counterexample comes with the values, the steps that reach it (when found), the
 * question "is it right to refuse here?", and a button that adds it to the model as a scenario.
 */
export function ProofView({
  projectName,
  savedVersion,
  proofs,
  questions,
  stored,
  canEdit,
  dirty,
  text,
  model,
  onAnswer,
  onApply,
  onGoto,
}: {
  projectName: string;
  savedVersion: number;
  proofs: { loading: boolean; report?: ProofReport | null; reason?: string; error?: string };
  questions: ReviewQuestion[];
  stored: Record<string, StoredAnswer>;
  canEdit: boolean;
  dirty: boolean;
  text: string;
  model?: ModelIR;
  onAnswer: (q: ReviewQuestion, answer: ReviewVerdict | null, note: string) => void;
  onApply: (yaml: string, message: string) => void;
  onGoto: (p: Path) => void;
}) {
  const [filter, setFilter] = useState<"counterexample" | "all">("counterexample");
  const [message, setMessage] = useState<string>();
  const report = proofs.report ?? undefined;
  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const groups = useMemo(() => {
    const out = new Map<string, ProofResult[]>();
    for (const r of report?.results ?? []) {
      if (filter === "counterexample" && r.outcome === "proven") continue;
      const key = `${r.context} › ${r.aggregate}`;
      out.set(key, [...(out.get(key) ?? []), r]);
    }
    return out;
  }, [report, filter]);

  const addScenario = (r: ProofResult) => {
    if (!model) return;
    const sc = proofScenario(model, r);
    if (!sc) return;
    const res = applyEdits(text, [{ op: "add", path: sc.path, value: sc.value }]);
    if (!res.ok) {
      setMessage(`シナリオを足せませんでした: ${res.error}`);
      return;
    }
    const errors = (t: string) => validateModelText(t).diagnostics.filter((d) => d.severity === "error").length;
    if (errors(res.text) > errors(text)) {
      setMessage("シナリオを足すとモデルにエラーが出るため、足しませんでした（例の値がフィールドの形式に合わない可能性があります）。");
      return;
    }
    setMessage(`シナリオ ${String(sc.value.name)} を ${r.aggregate} に足しました（未保存）。生成するテストが、この場合に ${r.source.error} になることを確かめます。`);
    onApply(res.text, `シナリオ ${String(sc.value.name)} を足しました（Z3 の反例から・未保存）`);
  };

  const download = () => {
    if (!report) return;
    downloadBlob(new Blob([proofsMarkdown(projectName, report)], { type: "text/markdown" }), `${safeFileName(projectName)}-proofs-v${savedVersion}.md`);
  };

  const count = (o: ProofResult["outcome"]) => report?.results.filter((r) => r.outcome === o).length ?? 0;
  const never = report?.runs.filter((r) => r.canSucceed === false) ?? [];

  return (
    <>
      <div className="flow-bar">
        <p className="muted small flow-intro">
          Factory と Operation ごとに、ガード（require）を満たしたあとで Invariant や制約に断られることがあるかを Z3 で調べました。「証明」はどんな値でも断られないこと、「反例」は断られる具体的な値です。反例ごとに、その場合に断るのが業務として正しいか答えてください。
        </p>
        <div className="spacer" />
        <button className="small-button" onClick={download} disabled={!report} title="結果と前提を Markdown で">
          証明（Markdown）
        </button>
      </div>
      {dirty && <p className="small sev-warning">▲ 保存していない変更があります。証明は保存されたモデル（v{savedVersion}）のものです。</p>}
      {proofs.loading && <p className="muted">Z3 で証明しています…（初めての版は数秒かかります）</p>}
      {proofs.error && (
        <p className="error-banner" role="alert">
          証明を取得できませんでした: {proofs.error}
        </p>
      )}
      {!proofs.loading && !proofs.error && proofs.report === null && (
        <p className="error-banner">{proofs.reason === "invalid" ? `保存されたモデル（v${savedVersion}）にエラーがあるため、証明できません。` : proofs.reason === "off" ? "このサーバーでは証明が無効です（DDD_PROOFS=off）。" : "証明に失敗しました。"}</p>
      )}
      {message && (
        <p className="small review-finding" role="status">
          {message}
        </p>
      )}
      {report && (
        <>
          <div className="review-bar">
            <span>
              {report.solver}・証明 <strong>{count("proven")}</strong>・反例 <strong>{count("counterexample")}</strong>・不明 {count("unknown")}（v{savedVersion}、{(report.elapsedMs / 1000).toFixed(1)} 秒）
            </span>
            <div className="spacer" />
            <div className="segmented" role="group" aria-label="表示する結果">
              {(
                [
                  ["counterexample", "反例と不明"],
                  ["all", "すべて"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className="small-button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {never.length > 0 && (
            <div className="error-banner" role="alert">
              成功しない操作があります（どんな状態・引数でも、ガードかチェックに断られます）:
              <ul>
                {never.map((r) => (
                  <li key={`${r.aggregate}.${r.name}`}>
                    <button className="linklike" onClick={() => onGoto(r.path)}>
                      {r.aggregate}.{r.name}
                    </button>
                    {r.bound ? `（リスト ${r.bound} 個まで）` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className="small proof-assumptions">
            <summary>前提（証明はこの前提の中で成り立ちます）</summary>
            <ul>
              {report.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
          {groups.size === 0 && <p className="muted">{filter === "counterexample" ? "反例はありません。すべてのチェックが証明されました。" : "調べるものがありません（Invariant・制約のある Aggregate がありません）。"}</p>}
          {[...groups].map(([name, rs]) => (
            <section key={name} className="proof-group">
              <h2 className="review-cat">{name}</h2>
              <ol className="proof-list">
                {rs.map((r) => {
                  const q = byId.get(r.id);
                  const s = stored[r.id];
                  const scenario = model && canEdit ? proofScenario(model, r) : undefined;
                  return (
                    <li key={r.id} className="proof-item" data-outcome={r.outcome}>
                      <div className="proof-head">
                        <span className={`proof-badge proof-${r.outcome}`}>{OUTCOME[r.outcome]}</span>
                        <span>
                          <strong>
                            {r.kind === "factory" ? "Factory " : ""}
                            {r.name}
                          </strong>{" "}
                          と {proofSourceText(r.source)}（{r.source.error}）
                        </span>
                      </div>
                      <p className="small muted proof-detail">
                        {r.outcome === "proven"
                          ? `どんな値でも断られない${r.bound ? `（リストは ${r.bound} 個まで調べた）` : ""}。`
                          : r.outcome === "unknown"
                            ? (r.note ?? "決められなかった。")
                            : `例: ${exampleText(r.example)}`}
                        {r.outcome === "proven" && r.note ? ` ${r.note}` : ""}
                        {r.lean?.status === "proven" ? " Lean でも証明（リストの長さに上限なし）。" : ""}
                      </p>
                      {r.outcome === "counterexample" && (
                        <>
                          <p className="small proof-detail">
                            {r.trace?.length ? (
                              <>
                                手順: <span className="proof-trace">{r.trace.join(" → ")}</span>
                              </>
                            ) : r.kind === "operation" ? (
                              <span className="muted">この前の状態に Factory から数手でたどり着く手順は見つかりませんでした（業務で起きない状態なら、Invariant が足りません）。</span>
                            ) : null}
                          </p>
                          <div className="proof-actions">
                            {q && (
                              <>
                                <span className="small">この場合に断るのは正しい？</span>
                                <div className="segmented" role="group" aria-label={`回答: ${q.text}`}>
                                  {(["yes", "no"] as const).map((v) => (
                                    <button key={v} className="small-button" aria-pressed={s?.answer === v} disabled={!canEdit} onClick={() => onAnswer(q, s?.answer === v ? null : v, s?.note ?? "")}>
                                      {v === "yes" ? "はい" : "いいえ"}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                            <button className="linklike small" onClick={() => onGoto(r.path)} title={formatPath(r.path)}>
                              モデルで見る
                            </button>
                            {scenario && (
                              <button className="small-button" onClick={() => addScenario(r)} title="この反例を Aggregate のシナリオ（テスト）として足す">
                                シナリオとして足す
                              </button>
                            )}
                          </div>
                          {s?.answer === "no" && q && <p className="small review-finding">直し方: {q.ifDifferent}</p>}
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </>
      )}
    </>
  );
}
