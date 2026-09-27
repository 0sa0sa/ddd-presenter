import { unifiedDiff, type Proposal } from "@ddd/core";
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../api.ts";
import { DiffView } from "./DiffView.tsx";

export type ProposeKind = "next-operation" | "guards" | "scenarios" | "events" | "custom";

export const PROPOSE_KINDS: { kind: ProposeKind; label: string; help: string }[] = [
  { kind: "next-operation", label: "次の操作", help: "状態の流れで足りない操作（ガード・変更・イベントつき）" },
  { kind: "guards", label: "ルール", help: "状態ガードとエラー" },
  { kind: "scenarios", label: "シナリオ", help: "成功と、ルールに違反する失敗のテスト" },
  { kind: "events", label: "イベントの内容", help: "イベントが運ぶフィールド" },
];

/** Asks for a proposal (local rules, or Claude when AI is on) and shows it as a diff; nothing changes until applied. */
export function ProposeDialog({
  projectId,
  text,
  context,
  aggregate,
  initialKind,
  aiActive,
  onApply,
  onClose,
}: {
  projectId: string;
  text: string;
  context: string;
  aggregate: string;
  initialKind: ProposeKind;
  aiActive: boolean;
  onApply: (yaml: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ProposeKind>(initialKind);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [proposal, setProposal] = useState<Proposal>();
  const [errors, setErrors] = useState<string[]>([]);

  const run = async (k: ProposeKind, instr?: string) => {
    setBusy(true);
    setError(undefined);
    setProposal(undefined);
    try {
      const r = await api.propose(projectId, { yaml: text, context, aggregate, kind: k, instruction: instr || undefined });
      if (!r.proposal) setError(r.message ?? "提案を作れませんでした。");
      else setProposal(r.proposal);
      setErrors((r.diagnostics ?? []).filter((d) => d.severity === "error").map((d) => d.message));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialKind !== "custom") void run(initialKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const diff = useMemo(() => (proposal && proposal.yaml !== text ? unifiedDiff("model.ddd.yaml", text, proposal.yaml) : ""), [proposal, text]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="propose-title">
      <div className="modal reflect">
        <h2 id="propose-title">
          {aggregate} への提案 <span className={`small ${aiActive ? "ai-on" : "muted"}`}>{aiActive ? "AI（Claude）" : "ローカルのルールで提案"}</span>
        </h2>
        <div className="row" role="tablist" style={{ flexWrap: "wrap" }}>
          {PROPOSE_KINDS.map((k) => (
            <button
              key={k.kind}
              role="tab"
              aria-selected={kind === k.kind}
              className={kind === k.kind ? "primary" : "quiet"}
              title={k.help}
              disabled={busy}
              onClick={() => {
                setKind(k.kind);
                void run(k.kind, instruction);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        {aiActive ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              setKind("custom");
              void run("custom", instruction);
            }}
          >
            <input
              style={{ flex: 1 }}
              value={instruction}
              placeholder="AI への指示（例: 招待の再送を追加して。再送は3回まで）"
              aria-label="AI への指示"
              onChange={(e) => setInstruction(e.target.value)}
            />
            <button type="submit" disabled={busy || !instruction.trim()}>
              指示して提案
            </button>
          </form>
        ) : (
          <p className="small muted">自由な指示で提案させるには、ワークスペースの「設定」で AI の提案を有効にしてください。</p>
        )}

        {busy && <p className="small muted">{aiActive ? "Claude が考えています…" : "提案を作っています…"}</p>}
        {error && <p className="error-banner">{error}</p>}

        {proposal && (
          <>
            {proposal.summary.length > 0 && (
              <section>
                <h3>追加・変更される内容</h3>
                <ul className="small">
                  {proposal.summary.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </section>
            )}
            <div className="propose-notes">
              <NoteList title="モデルからわかっていること" items={proposal.facts} />
              <NoteList title="推測（チームで確認）" items={proposal.assumptions} tone="warn" />
              <NoteList title="ドメインエキスパートへの質問" items={proposal.questions} tone="ask" />
            </div>
            {errors.length > 0 && (
              <div className="error-banner small">
                <div>適用すると検証エラーが残ります。YAML で直してから保存してください。</div>
                {errors.slice(0, 5).map((m, i) => (
                  <div key={i}>✕ {m}</div>
                ))}
              </div>
            )}
            {diff ? (
              <div className="panel" style={{ maxHeight: 320, overflow: "auto" }}>
                <DiffView diff={diff} />
              </div>
            ) : (
              <p className="small muted">追加するものはありません。</p>
            )}
          </>
        )}

        <div className="row modal-actions">
          <button className="primary" disabled={!proposal || !diff} onClick={() => proposal && onApply(proposal.yaml)}>
            モデルに適用（未保存の変更として）
          </button>
          <button className="quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" | "ask" }) {
  if (!items.length) return null;
  return (
    <section className={`propose-note${tone ? ` propose-note-${tone}` : ""}`}>
      <h4>{title}</h4>
      <ul className="small">
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </section>
  );
}
