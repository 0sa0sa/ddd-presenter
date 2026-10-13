import { phaseOf, STICKY_KINDS, WORKSHOP_PHASES, type Board, type BoardGhost, type FacilitatorMessage } from "@ddd/core";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api.ts";
import { acceptGhosts, newId, onBoard } from "../../lib/boardOps.ts";
import { facilitatorStorageKey, ghostsToAdd, historyFor, loadConversation, saveConversation } from "../../lib/facilitator.ts";

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The AI facilitator of the workshop (docs/11 §4): a chat that leads the group through the steps, asks about what
 * the board is missing, and proposes stickies and the next step. Nothing changes on the board until someone adds
 * a sticky or moves to the next step.
 */
export function FacilitatorPanel({
  projectId,
  boardId,
  board,
  user,
  canEdit,
  aiActive,
  onChange,
  onFocus,
  onShowGhosts,
}: {
  projectId: string;
  boardId: string;
  board: Board;
  user: string;
  canEdit: boolean;
  aiActive: boolean;
  onChange: (b: Board) => void;
  onFocus: (ids: string[]) => void;
  onShowGhosts: (ghosts: BoardGhost[]) => void;
}) {
  const key = facilitatorStorageKey(projectId, boardId);
  // The conversation belongs to its storage key: another board never sees (or overwrites) this one.
  const [conversation, setConversation] = useState(() => ({ key, messages: loadConversation(storage(), key) }));
  if (conversation.key !== key) setConversation({ key, messages: loadConversation(storage(), key) });
  const messages = conversation.key === key ? conversation.messages : [];
  const update = (forKey: string, f: (prev: FacilitatorMessage[]) => FacilitatorMessage[]) => setConversation((c) => (c.key === forKey ? { key: forKey, messages: f(c.messages) } : c));
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<AbortController>();
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string>();
  const boardRef = useRef(board);
  boardRef.current = board;
  const listRef = useRef<HTMLOListElement>(null);
  const phase = phaseOf(board);

  useEffect(() => saveConversation(storage(), conversation.key, conversation.messages), [conversation]);
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [messages.length, pending]);
  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [pending]);
  // Leaving the board stops a turn in progress (the server stops a local CLI too).
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current?.abort(), []);

  // Set synchronously: a double click must not send twice before `pending` is rendered.
  const sending = useRef(false);
  const send = async (text?: string) => {
    if (sending.current || pending || !canEdit) return;
    sending.current = true;
    const message = text?.trim();
    const before = messages;
    const mine: FacilitatorMessage[] = message ? [{ id: newId("m"), role: "user", text: message, author: user, at: new Date().toISOString() }] : [];
    const forKey = key;
    update(forKey, () => [...before, ...mine]);
    setDraft("");
    setError(undefined);
    const ctrl = new AbortController();
    setPending(ctrl);
    try {
      const r = await api.facilitate(projectId, { board: boardRef.current, history: historyFor(before), ...(message ? { message } : {}) }, ctrl.signal);
      if (!r.turn) {
        setError(r.message ?? "AI が返答しませんでした");
        return;
      }
      const t = r.turn;
      update(forKey, (prev) => [
        ...prev,
        {
          id: newId("m"),
          role: "assistant",
          text: t.reply,
          at: new Date().toISOString(),
          ...(t.ghosts.length ? { ghosts: t.ghosts } : {}),
          ...(t.nextPhase ? { nextPhase: t.nextPhase } : {}),
          ...(t.focus.length ? { focus: t.focus } : {}),
          ...(t.options.length ? { options: t.options } : {}),
        },
      ]);
      if (t.ghosts.length) onShowGhosts(t.ghosts);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(describeError(e));
    } finally {
      sending.current = false;
      setPending(undefined);
    }
  };

  const restart = () => {
    if (messages.length && !window.confirm("会話を消して、最初から進行してもらいますか？（ボードの付箋は消えません）")) return;
    pending?.abort();
    update(key, () => []);
    setError(undefined);
  };

  const moveTo = (id: string) => {
    const b = boardRef.current;
    onChange({ ...b, workshop: { ...(b.workshop?.votesPerPerson ? { votesPerPerson: b.workshop.votesPerPerson } : {}), phase: id } });
  };

  const addAll = (ghosts: BoardGhost[]) => {
    const r = acceptGhosts(boardRef.current, ghostsToAdd(boardRef.current, ghosts));
    onChange(r.board);
    onShowGhosts([]);
    onFocus(r.ids);
  };

  if (!aiActive) {
    return (
      <div className="facilitator stack" style={{ gap: 8 }}>
        <p className="small">AI が進行役になり、チャットで問いかけながらワークショップを進めます。付箋の案と次の段階を提案し、採用するかは皆さんが決めます。</p>
        <p className="small muted">このワークスペースでは AI がオフです。ワークスペースの「設定」タブで、使う AI を選んで有効にしてください（オーナーのみ）。</p>
      </div>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return (
    <div className="facilitator">
      <div className="facilitator-head">
        <span className="small">
          いまの段階: <strong>{WORKSHOP_PHASES.indexOf(phase) + 1}. {phase.title}</strong>
        </span>
        {messages.length > 0 && (
          <button className="quiet small-button" onClick={restart} disabled={!canEdit}>
            最初から
          </button>
        )}
      </div>

      {messages.length === 0 && !pending && (
        <div className="facilitator-intro stack" style={{ gap: 8 }}>
          <p className="small">
            AI が進行役になり、いまの段階（{phase.title}）の目的に沿って問いかけます。答えた内容は付箋の案になり、ボードに半透明で表示されます。全員が見ている画面で使うと、ワークショップの進行役の代わりになります。
          </p>
          <p className="small muted">会話はこのブラウザにボードごとに保存されます。段階とタイマーはボードに保存され、全員に共有されます。</p>
          {canEdit ? (
            <button className="primary small-button" onClick={() => void send()}>
              進行を始める
            </button>
          ) : (
            <p className="small muted">閲覧者は進行役を使えません。編集者か所有者が使えます。</p>
          )}
        </div>
      )}

      <ol className="facilitator-log" ref={listRef} aria-live="polite">
        {messages.map((m) => (
          <li key={m.id} className={`chat-msg chat-${m.role}`}>
            <span className="chat-who small">{m.role === "assistant" ? "進行役（AI）" : m.author}</span>
            <p className="chat-text">{m.text}</p>
            {m.role === "assistant" && <Actions message={m} board={board} canEdit={canEdit} onAdd={addAll} onShow={onShowGhosts} onFocus={onFocus} onMove={moveTo} />}
          </li>
        ))}
        {pending && (
          <li className="chat-msg chat-assistant chat-pending">
            <span className="chat-who small">進行役（AI）</span>
            <p className="chat-text muted">
              考えています… {elapsed} 秒
              <button className="quiet small-button" onClick={() => pending.abort()}>
                止める
              </button>
            </p>
          </li>
        )}
      </ol>

      {error && (
        <p className="error-banner small" role="alert">
          {error}
          <button className="quiet small-button" onClick={() => void send()} disabled={!!pending}>
            もう一度
          </button>
        </p>
      )}

      {canEdit && lastAssistant?.options && !pending && messages[messages.length - 1] === lastAssistant && (
        <div className="chat-options" aria-label="返答の候補">
          {lastAssistant.options.map((o) => (
            <button key={o} className="small-button" onClick={() => void send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}

      {canEdit && (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void send(draft);
          }}
        >
          <textarea
            value={draft}
            rows={2}
            maxLength={2000}
            placeholder={messages.length ? "答える・質問する（⌘/Ctrl+Enter で送信）" : "作りたいもの・業務を書いて始めることもできます"}
            aria-label="進行役へのメッセージ"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (draft.trim()) void send(draft);
              }
            }}
          />
          <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
            {messages.length > 0 && (
              <button type="button" className="quiet small-button" disabled={!!pending} onClick={() => void send()} title="メッセージなしで、ボードのいまの状態から次の問いかけをもらいます">
                続けて
              </button>
            )}
            <button type="submit" className="primary small-button" disabled={!!pending || !draft.trim()}>
              送信
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Actions({
  message,
  board,
  canEdit,
  onAdd,
  onShow,
  onFocus,
  onMove,
}: {
  message: FacilitatorMessage;
  board: Board;
  canEdit: boolean;
  onAdd: (ghosts: BoardGhost[]) => void;
  onShow: (ghosts: BoardGhost[]) => void;
  onFocus: (ids: string[]) => void;
  onMove: (phase: string) => void;
}) {
  const ghosts = message.ghosts ?? [];
  const missing = ghosts.filter((g) => !onBoard(board, g));
  const focus = (message.focus ?? []).filter((id) => board.items.some((i) => i.id === id) || board.frames.some((f) => f.id === id));
  const next = WORKSHOP_PHASES.find((p) => p.id === message.nextPhase);
  if (!ghosts.length && !focus.length && !next) return null;
  return (
    <div className="chat-actions">
      {ghosts.length > 0 && (
        <>
          <ul className="chat-stickies">
            {ghosts.map((g) => (
              <li key={g.id} title={g.reason}>
                <span className={`sticky-dot sticky-${g.kind}`} aria-hidden />
                <span className="small">
                  {g.text}
                  <span className="muted">
                    {" "}
                    {STICKY_KINDS[g.kind].label}
                    {onBoard(board, g) ? "・追加済み" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {canEdit && missing.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <button className="small-button" onClick={() => onAdd(ghosts)}>
                {missing.length === 1 ? "ボードに追加" : `${missing.length} 枚をボードに追加`}
              </button>
              <button className="quiet small-button" onClick={() => onShow(missing)} title="半透明の付箋としてボードに出します。1枚ずつクリックで追加、× で消せます">
                ボードで選ぶ
              </button>
            </div>
          )}
        </>
      )}
      {(focus.length > 0 || next) && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {focus.length > 0 && (
            <button className="quiet small-button" onClick={() => onFocus(focus)}>
              話題の付箋を表示
            </button>
          )}
          {next && canEdit && phaseOf(board).id !== next.id && (
            <button className="small-button" onClick={() => onMove(next.id)}>
              「{next.title}」へ進む
            </button>
          )}
        </div>
      )}
    </div>
  );
}
