import { formatPath, templates, type Analysis, type Diagnostic, type EditOp, type ModelIR, type Path, type RuleUsage } from "@ddd/core";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { describeSteps, KIND_GLYPH, KIND_LABEL, scenarioCards, type OutlineNode } from "../lib/outline.ts";
import { ScenarioCardView } from "./ScenariosView.tsx";

interface Props {
  node?: OutlineNode;
  model?: ModelIR;
  analysis?: Analysis;
  rules: RuleUsage[];
  diagnostics: Diagnostic[];
  canEdit: boolean;
  onEdit: (ops: EditOp[]) => string | undefined;
  onGoto: (path: Path) => void;
  onSelectId: (id: string) => void;
}

const TYPE_KINDS = new Set(["aggregate", "entity", "valueObject", "enum", "error", "event"]);

export function Inspector(props: Props) {
  const { node, model } = props;
  if (!node || !model) {
    return (
      <aside className="inspector" aria-label="詳細">
        <p className="muted">左の一覧か図から要素を選ぶと、ここに詳細と編集フォームが出ます。</p>
        <Help />
      </aside>
    );
  }
  const ctx = model.contexts.find((c) => c.name === node.context);
  const nodeDiags = props.diagnostics.filter((d) => {
    const p = formatPath(d.path);
    const n = formatPath(node.path);
    return p === n || p.startsWith(n + ".") || p.startsWith(n + "[");
  });

  return (
    <aside className="inspector" aria-label="詳細">
      <header className="stack" style={{ gap: 4 }}>
        <span className={`kind-chip kind kind-${node.kind}`}>
          <span aria-hidden>{KIND_GLYPH[node.kind]}</span>
          {KIND_LABEL[node.kind]}
          {node.owner && <span className="muted">・{node.owner}</span>}
        </span>
        <h2>{node.name}</h2>
        <div className="row">
          <button className="linklike small" onClick={() => props.onGoto(node.path)}>
            YAMLで開く
          </button>
        </div>
      </header>
      {nodeDiags.length > 0 && (
        <section aria-label="この要素の診断">
          {nodeDiags.map((d, i) => (
            <div key={i} className="small">
              <span className={`sev sev-${d.severity}`}>
                {d.severity === "error" ? "✕ エラー" : d.severity === "warning" ? "▲ 警告" : "ⓘ 情報"}
              </span>{" "}
              {d.message}
              {d.hint && <div className="diag-hint">{d.hint}</div>}
            </div>
          ))}
        </section>
      )}
      {ctx && <Details {...props} node={node} />}
      {props.canEdit && <Rename {...props} node={node} />}
      {props.canEdit && node.kind !== "context" && (
        <section>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`${KIND_LABEL[node.kind]}「${node.name}」をモデルから削除します。参照している箇所はエラーとして表示されます。`)) props.onEdit([{ op: "remove", path: node.path }]);
            }}
          >
            この{KIND_LABEL[node.kind]}を削除
          </button>
        </section>
      )}
    </aside>
  );
}

function Details(props: Props & { node: OutlineNode }) {
  const { node, model, rules, canEdit, onEdit } = props;
  const ctx = model!.contexts.find((c) => c.name === node.context)!;
  const agg = ctx.aggregates.find((a) => a.name === (node.owner ?? node.name));

  switch (node.kind) {
    case "context":
      return (
        <>
          {ctx.description && <p>{ctx.description}</p>}
          <dl className="facts">
            <dt>Aggregate</dt>
            <dd>{ctx.aggregates.length}</dd>
            <dt>Value object</dt>
            <dd>{ctx.valueObjects.length}</dd>
            <dt>Use case</dt>
            <dd>{ctx.useCases.length}</dd>
            <dt>名前付きルール</dt>
            <dd>{rules.filter((r) => r.context === ctx.name).length}</dd>
          </dl>
          {ctx.glossary.length > 0 && (
            <section>
              <h3>用語</h3>
              <dl className="facts">
                {ctx.glossary.map((g) => (
                  <FactRow key={g.term} term={g.term}>
                    {g.definition}
                  </FactRow>
                ))}
              </dl>
            </section>
          )}
          {canEdit && <AddToContext ctxIndex={model!.contexts.indexOf(ctx)} onEdit={onEdit} />}
        </>
      );
    case "aggregate":
    case "entity":
    case "valueObject": {
      const el = node.kind === "valueObject" ? ctx.valueObjects.find((v) => v.name === node.name) : node.kind === "entity" ? agg?.entities.find((e) => e.name === node.name) : agg;
      if (!el) return null;
      return (
        <>
          <Description path={node.path} value={el.description} {...props} />
          <section>
            <h3>フィールド</h3>
            <table className="table small">
              <tbody>
                {el.fields.map((f, i) => (
                  <tr key={f.name}>
                    <td className="mono">
                      {f.name}
                      {"identity" in el && el.identity === f.name && <span className="muted"> （識別子）</span>}
                    </td>
                    <td className="mono">
                      {f.type}
                      {f.required ? "" : "?"}
                    </td>
                    {canEdit && (
                      <td>
                        <button className="quiet small" aria-label={`${f.name}を削除`} onClick={() => onEdit([{ op: "remove", path: [...node.path, "fields", i] }])}>
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && <AddField path={[...node.path, "fields"]} onEdit={onEdit} />}
          </section>
          {node.kind === "aggregate" && agg && (
            <section>
              <h3>振る舞い</h3>
              <dl className="facts small">
                <dt>Invariant</dt>
                <dd>{agg.invariants.map((x) => x.name).join(", ") || "—"}</dd>
                <dt>State guard</dt>
                <dd>{agg.stateGuards.map((x) => x.name).join(", ") || "—"}</dd>
                <dt>Operation</dt>
                <dd>{agg.operations.map((x) => x.name).join(", ") || "—"}</dd>
              </dl>
              {canEdit && <AddToAggregate path={node.path} errors={ctx.errors.map((e) => e.name)} onEdit={onEdit} />}
            </section>
          )}
        </>
      );
    }
    case "invariant":
    case "guard": {
      const usage = rules.find((r) => r.context === ctx.name && r.owner === node.owner && r.rule === node.name);
      const def =
        node.kind === "guard"
          ? agg?.stateGuards.find((g) => g.name === node.name)
          : [...ctx.aggregates.flatMap((a) => [a, ...a.entities]), ...ctx.valueObjects].find((o) => o.name === node.owner)?.invariants.find((i) => i.name === node.name);
      if (!def) return null;
      return (
        <>
          <Description path={node.path} value={def.description} {...props} />
          <section>
            <h3>{node.kind === "guard" ? "確認する条件" : "常に成り立つ条件"}</h3>
            {canEdit ? <ExpressionEditor path={[...node.path, "expression"]} value={def.expression} onEdit={onEdit} /> : <div className="expr">{def.expression}</div>}
            {"parameters" in def && def.parameters.length > 0 && (
              <p className="small muted">引数: {def.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}</p>
            )}
          </section>
          <section>
            <h3>違反したとき</h3>
            {canEdit ? (
              <select aria-label="違反時のエラー" value={def.error} onChange={(e) => onEdit([{ op: "set", path: [...node.path, "error"], value: e.target.value }])}>
                {!ctx.errors.some((e) => e.name === def.error) && <option value={def.error}>{def.error}（未定義）</option>}
                {ctx.errors.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="kind kind-error">{def.error}</span>
            )}
            {"checkOn" in def && <p className="small muted">評価タイミング: {def.checkOn.map((t) => (t === "construct" ? "構築時" : "状態遷移後")).join("・")}</p>}
          </section>
          {usage && (
            <section>
              <h3>適用されている場所</h3>
              {usage.appliedBy.length === 0 ? (
                <p className="small sev-warning">▲ どの操作からも使われていません</p>
              ) : (
                <ul className="small" style={{ margin: 0, paddingLeft: "1.1em" }}>
                  {usage.appliedBy.map((a, i) => (
                    <li key={i}>
                      <button className="linklike" onClick={() => props.onGoto(a.path)}>
                        {a.name}
                      </button>{" "}
                      <span className="muted">{a.how}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>テストしているシナリオ</h3>
              {usage.scenarios.length === 0 ? (
                <p className="small sev-warning">▲ このルールのエラーを確かめるシナリオがありません</p>
              ) : (
                <ul className="small" style={{ margin: 0, paddingLeft: "1.1em" }}>
                  {usage.scenarios.map((s) => (
                    <li key={s.owner + s.name}>
                      <button className="linklike" onClick={() => props.onGoto(s.path)}>
                        {s.name}
                      </button>{" "}
                      <span className="muted mono">test_{s.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      );
    }
    case "operation":
    case "factory": {
      const m = node.kind === "operation" ? agg?.operations.find((o) => o.name === node.name) : agg?.factories.find((f) => f.name === node.name);
      if (!m) return null;
      return (
        <>
          <Description path={node.path} value={m.description} {...props} />
          <dl className="facts small">
            <dt>引数</dt>
            <dd className="mono">{m.parameters.map((p) => `${p.name}: ${p.type}`).join(", ") || "—"}</dd>
            <dt>前提（自動確認）</dt>
            <dd className="mono">{m.require.join(", ") || "—"}</dd>
            <dt>{node.kind === "operation" ? "状態変更" : "初期値"}</dt>
            <dd className="mono">
              {Object.entries("changes" in m ? m.changes : m.fields)
                .map(([k, v]) => `${k} ← ${v}`)
                .join("\n") || "—"}
            </dd>
            <dt>発生イベント</dt>
            <dd>
              {m.emits.map((e) => (
                <span key={e.name} className="kind kind-event">
                  ⚑ {e.name}{" "}
                </span>
              ))}
              {m.emits.length === 0 && "—"}
            </dd>
          </dl>
          <p className="small muted">前提のガードを確認してから候補状態を作り、Invariantをすべて通った場合だけ新しい状態を返します。</p>
        </>
      );
    }
    case "useCase": {
      const uc = ctx.useCases.find((u) => u.name === node.name);
      if (!uc) return null;
      const info = props.analysis?.contexts.get(ctx.name)?.useCases.get(uc.name);
      return (
        <>
          <Description path={node.path} value={uc.description} {...props} />
          <dl className="facts small">
            <dt>Actor</dt>
            <dd>{uc.actor ?? "—"}</dd>
            <dt>Command</dt>
            <dd className="mono">{uc.command}</dd>
            <dt>入力</dt>
            <dd className="mono">{uc.input.map((f) => `${f.name}: ${f.type}`).join(", ") || "—"}</dd>
            <dt>トランザクション</dt>
            <dd>{uc.transaction === "required" ? "あり（イベントはコミット後に公開）" : "なし"}</dd>
            {info && (
              <>
                <dt>使うPort</dt>
                <dd className="small">
                  {[...info.repositories.map((r) => `${r}Repository`), info.usesClock && "Clock", info.usesIds && "IdGenerator", info.extensions.length && "Extensions", info.publishes.length && "EventPublisher"]
                    .filter(Boolean)
                    .join(", ")}
                </dd>
              </>
            )}
          </dl>
          <section>
            <h3>手順</h3>
            <pre className="expr" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {describeSteps(uc.steps).join("\n") || "手順がありません"}
            </pre>
          </section>
          <section>
            <h3>シナリオ</h3>
            {uc.scenarios.map((s) => (
              <button key={s.name} className="linklike small" style={{ justifySelf: "start" }} onClick={() => props.onSelectId(`${ctx.name}/${uc.name}/scenario/${s.name}`)}>
                {s.name}
              </button>
            ))}
            {uc.scenarios.length === 0 && <p className="small sev-warning">▲ シナリオがありません。期待する結果を書くとテストが生成されます。</p>}
          </section>
        </>
      );
    }
    case "scenario": {
      const card = scenarioCards(model!).find((c) => c.owner === node.owner && c.name === node.name);
      return card ? <ScenarioCardView card={card} compact /> : null;
    }
    case "error": {
      const e = ctx.errors.find((x) => x.name === node.name);
      if (!e) return null;
      const raisedBy = rules.filter((r) => r.context === ctx.name && r.error === e.name);
      return (
        <>
          <dl className="facts small">
            <dt>コード</dt>
            <dd className="mono">{e.code}</dd>
            <dt>表示メッセージ</dt>
            <dd>{e.message}</dd>
            <dt>送出するルール</dt>
            <dd>{raisedBy.map((r) => r.rule).join(", ") || "—"}</dd>
          </dl>
          {canEdit && (
            <label className="field">
              表示メッセージ
              <CommitInput value={e.message} onCommit={(v) => onEdit([{ op: "set", path: [...node.path, "message"], value: v }])} />
            </label>
          )}
        </>
      );
    }
    case "enum": {
      const en = ctx.enums.find((x) => x.name === node.name);
      return en ? (
        <section>
          <h3>値</h3>
          {canEdit ? (
            <CommitInput
              value={en.values.join(", ")}
              label="値（カンマ区切り）"
              onCommit={(v) =>
                onEdit([
                  {
                    op: "set",
                    path: [...node.path, "values"],
                    value: v
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                ])
              }
            />
          ) : (
            <p className="mono">{en.values.join(", ")}</p>
          )}
        </section>
      ) : null;
    }
    case "event": {
      const info = props.analysis?.contexts.get(ctx.name)?.events.get(node.name);
      return info ? (
        <dl className="facts small">
          <dt>発生元</dt>
          <dd>{info.sources.map((s) => `${s.aggregate}.${s.member}`).join(", ")}</dd>
          <dt>内容</dt>
          <dd className="mono">{info.fields.map((f) => f.name).join(", ") || "—"}</dd>
        </dl>
      ) : null;
    }
    case "extension": {
      const x = ctx.extensionPoints.find((e) => e.name === node.name);
      return x ? (
        <>
          <p>{x.description}</p>
          <dl className="facts small">
            <dt>シグネチャ</dt>
            <dd className="mono">
              {x.name}({x.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → {x.returns}
            </dd>
            <dt>テスト時の既定値</dt>
            <dd className="mono">{x.testDefault === undefined ? "なし（シナリオで指定）" : JSON.stringify(x.testDefault)}</dd>
          </dl>
          <p className="small muted">顧客が extensions パッケージで実装するコードです。生成器は上書きしません。</p>
        </>
      ) : null;
    }
  }
}

function FactRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Description({ path, value, canEdit, onEdit }: Props & { path: Path; value?: string }) {
  if (!canEdit) return value ? <p>{value}</p> : null;
  return (
    <label className="field">
      説明
      <CommitInput value={value ?? ""} placeholder="業務上の意味を一文で" onCommit={(v) => onEdit(v ? [{ op: "set", path: [...path, "description"], value: v }] : [])} />
    </label>
  );
}

/** Text input that applies on Enter / blur, so every keystroke is not a model edit. */
function CommitInput({ value, onCommit, placeholder, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; label?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

function ExpressionEditor({ path, value, onEdit }: { path: Path; value: string; onEdit: Props["onEdit"] }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <textarea aria-label="条件式" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="row">
        <button disabled={draft === value} onClick={() => onEdit([{ op: "set", path, value: draft }])}>
          条件式を反映
        </button>
        <span className="small muted">使える要素: フィールド、引数、==, !=, &lt;, and, or, not, is_empty, contains, length</span>
      </div>
    </div>
  );
}

function Rename(props: Props & { node: OutlineNode }) {
  const { node, onEdit } = props;
  const [name, setName] = useState(node.name);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setName(node.name);
    setError(undefined);
  }, [node.id, node.name]);
  let op: EditOp | undefined;
  if (TYPE_KINDS.has(node.kind)) op = { op: "renameType", context: node.context, from: node.name, to: name };
  else if (node.kind === "guard") op = { op: "renameGuard", context: node.context, aggregate: node.owner!, from: node.name, to: name };
  else if (node.kind === "invariant" || node.kind === "scenario") op = { op: "set", path: [...node.path, "name"], value: name };
  if (!op) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name === node.name) return;
    const err = onEdit([op!]);
    setError(err);
    if (!err) props.onSelectId(node.id.replace(new RegExp(`${node.name}$`), name));
  };
  return (
    <section>
      <h3>名前を変更</h3>
      <form className="row" onSubmit={submit}>
        <input aria-label="新しい名前" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={name === node.name}>
          変更
        </button>
      </form>
      {TYPE_KINDS.has(node.kind) || node.kind === "guard" ? <p className="small muted">参照している箇所もまとめて書き換えます。</p> : null}
      {error && <p className="small sev-error">{error}</p>}
    </section>
  );
}

function AddField({ path, onEdit }: { path: Path; onEdit: Props["onEdit"] }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("String");
  const [required, setRequired] = useState(true);
  return (
    <form
      className="row"
      style={{ flexWrap: "wrap" }}
      onSubmit={(e) => {
        e.preventDefault();
        const value: Record<string, unknown> = { name: name.trim(), type: type.trim() };
        if (!required) value.required = false;
        if (!onEdit([{ op: "add", path, value }])) setName("");
      }}
    >
      <input aria-label="フィールド名" placeholder="field_name" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 110 }} />
      <input aria-label="型" placeholder="String" value={type} onChange={(e) => setType(e.target.value)} required style={{ width: 110 }} list="ddd-types" />
      <label className="small row" style={{ gap: 4 }}>
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        必須
      </label>
      <button type="submit">追加</button>
      <datalist id="ddd-types">
        {["String", "Integer", "Decimal", "Boolean", "UUID", "DateTime", "Date"].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </form>
  );
}

function AddToAggregate({ path, errors, onEdit }: { path: Path; errors: string[]; onEdit: Props["onEdit"] }) {
  const [kind, setKind] = useState<"invariants" | "state_guards" | "operations">("invariants");
  const [name, setName] = useState("");
  const firstError = errors[0] ?? "DomainRuleViolated";
  return (
    <form
      className="row"
      style={{ flexWrap: "wrap" }}
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        const value = kind === "invariants" ? templates.invariant(n, firstError) : kind === "state_guards" ? templates.stateGuard(n, firstError) : templates.operation(n);
        if (!onEdit([{ op: "add", path: [...path, kind], value }])) setName("");
      }}
    >
      <select aria-label="追加する種類" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="invariants">Invariant</option>
        <option value="state_guards">State guard</option>
        <option value="operations">Operation</option>
      </select>
      <input aria-label="名前" placeholder="snake_case_name" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 150 }} />
      <button type="submit">追加</button>
    </form>
  );
}

function AddToContext({ ctxIndex, onEdit }: { ctxIndex: number; onEdit: Props["onEdit"] }) {
  const [kind, setKind] = useState<"aggregates" | "value_objects" | "enums" | "errors" | "use_cases">("aggregates");
  const [name, setName] = useState("");
  const make = (n: string) =>
    kind === "aggregates"
      ? templates.aggregate(n)
      : kind === "value_objects"
        ? templates.valueObject(n)
        : kind === "enums"
          ? templates.enum(n)
          : kind === "errors"
            ? templates.error(n)
            : templates.useCase(n);
  return (
    <section>
      <h3>要素を追加</h3>
      <form
        className="row"
        style={{ flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!onEdit([{ op: "add", path: ["contexts", ctxIndex, kind], value: make(name.trim()) }])) setName("");
        }}
      >
        <select aria-label="追加する種類" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="aggregates">Aggregate</option>
          <option value="value_objects">Value object</option>
          <option value="enums">Enum</option>
          <option value="errors">Domain error</option>
          <option value="use_cases">Use case</option>
        </select>
        <input aria-label="名前" placeholder={kind === "use_cases" ? "snake_case_name" : "PascalCaseName"} value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 150 }} />
        <button type="submit">追加</button>
      </form>
    </section>
  );
}

export function Help() {
  return (
    <section className="help" aria-label="DDDの用語">
      <h3>用語のちがい</h3>
      <dl>
        <dt>Entity と Value Object</dt>
        <dd>Entityは識別子で同じものかを判断します（招待ID が同じなら同じ招待）。Value Objectは値そのもので判断し、変更されません（同じ文字列のメールアドレスは同じ）。</dd>
        <dt>Invariant と State guard</dt>
        <dd>Invariantはいつでも成り立つ条件で、作るときと状態が変わるたびに自動で確認されます。State guardは「受諾するときは期限前であること」のように、特定の操作の時点でだけ確認する条件です。</dd>
        <dt>Aggregate</dt>
        <dd>一緒に一貫性を保つまとまり。保存・読み込みはAggregate単位で、他のAggregateはIDで参照します。</dd>
        <dt>Use case</dt>
        <dd>アクターの操作に対応する手順。読み込み、ドメイン操作、保存、イベント公開の順序とトランザクション境界を表します。</dd>
      </dl>
    </section>
  );
}
