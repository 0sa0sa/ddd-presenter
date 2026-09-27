import type { ModelIR, Path } from "@ddd/core";
import { scenarioCards, type ScenarioCard } from "../lib/outline.ts";

export function ScenarioCardView({ card, compact, onGoto }: { card: ScenarioCard; compact?: boolean; onGoto?: (p: Path) => void }) {
  return (
    <article className="scenario" aria-label={`シナリオ ${card.name}`}>
      {!compact && (
        <header className="scenario-head">
          <h3>{card.description ?? card.name}</h3>
          <span className="muted small mono">test_{card.name}</span>
          <div className="spacer" />
          {onGoto && (
            <button className="linklike small" onClick={() => onGoto(card.path)}>
              YAMLで開く
            </button>
          )}
        </header>
      )}
      <span className="gwt-label">Given</span>
      <div className="gwt-body">{card.given.length ? <ul>{card.given.map((g, i) => <li key={i}>{g}</li>)}</ul> : <span className="muted">前提なし</span>}</div>
      <span className="gwt-label">When</span>
      <div className="gwt-body">{card.when}</div>
      <span className="gwt-label">Then</span>
      <div className="gwt-body">
        <ul>
          {card.then.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function ScenariosView({ model, onGoto }: { model: ModelIR; onGoto: (p: Path) => void }) {
  const cards = scenarioCards(model);
  const owners = [...new Set(cards.map((c) => c.owner))];
  return (
    <div className="view">
      <p className="muted">
        シナリオはそのまま pytest のテストになります。ドメインエキスパートと一緒に、前提・操作・期待する結果が業務の理解と合っているかを確認してください。
      </p>
      {cards.length === 0 && <p>シナリオがありません。Aggregateか Use case の scenarios に Given / When / Then を書くと、ここに表示されテストが生成されます。</p>}
      {owners.map((o) => (
        <section key={o} className="stack">
          <h2 className={`kind kind-${cards.find((c) => c.owner === o)!.ownerKind}`}>
            <span className="glyph">{cards.find((c) => c.owner === o)!.ownerKind === "useCase" ? "▶" : "◆"}</span> {o}
          </h2>
          {cards
            .filter((c) => c.owner === o)
            .map((c) => (
              <ScenarioCardView key={c.name} card={c} onGoto={onGoto} />
            ))}
        </section>
      ))}
    </div>
  );
}
