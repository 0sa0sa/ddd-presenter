import type { Path, RuleUsage } from "@ddd/core";

export function RulesView({ rules, onGoto, onSelect }: { rules: RuleUsage[]; onGoto: (p: Path) => void; onSelect: (id: string) => void }) {
  const untested = rules.filter((r) => r.scenarios.length === 0).length;
  const unused = rules.filter((r) => r.kind === "state_guard" && r.appliedBy.length === 0).length;
  return (
    <div className="view">
      <p className="muted">
        名前付きルールの一覧です。それぞれ、どこで評価されるか、違反時にどのエラーになるか、どのシナリオで確かめているかを表示します。
      </p>
      <p>
        {rules.length} 件のルール
        {untested > 0 && <span className="sev sev-warning"> ・▲ シナリオのないルール {untested} 件</span>}
        {unused > 0 && <span className="sev sev-warning"> ・▲ どこからも使われないガード {unused} 件</span>}
      </p>
      <div className="panel">
        {rules.map((r) => (
          <div className="rule-row" key={`${r.context}/${r.owner}/${r.rule}`}>
            <div className="stack" style={{ gap: 4 }}>
              <button className={`linklike kind kind-${r.kind === "invariant" ? "invariant" : "guard"}`} style={{ justifySelf: "start", fontWeight: 700 }} onClick={() => onSelect(`${r.context}/${r.owner}/${r.kind === "invariant" ? "invariant" : "guard"}/${r.rule}`)}>
                {r.kind === "invariant" ? "§" : "⊘"} {r.rule}
              </button>
              <span className="small muted">
                {r.kind === "invariant" ? "Invariant" : "State guard"}・{r.owner}
              </span>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <div className="expr">{r.expression}</div>
              <dl className="facts small">
                <dt>違反時</dt>
                <dd className="kind kind-error">{r.error}</dd>
                <dt>適用</dt>
                <dd>
                  {r.appliedBy.map((a, i) => (
                    <span key={i}>
                      {i > 0 && "、"}
                      <button className="linklike" onClick={() => onGoto(a.path)}>
                        {a.name}
                      </button>
                      <span className="muted">（{a.how}）</span>
                    </span>
                  ))}
                  {r.appliedBy.length === 0 && <span className="sev-warning">▲ なし</span>}
                </dd>
                <dt>テスト</dt>
                <dd>
                  {r.tests.length ? <span className="mono">{r.tests.join(", ")}</span> : <span className="sev-warning">▲ 違反を確かめるシナリオがありません</span>}
                </dd>
              </dl>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
