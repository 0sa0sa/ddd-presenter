import { useState, type ReactNode } from "react";
import { api, describeError, type Me } from "../api.ts";
import { navigate } from "../App.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { TUTORIAL_STEPS, tutorialStore } from "../lib/tutorial.ts";

interface Quiz {
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
}

interface Lesson {
  id: string;
  title: string;
  body: ReactNode;
  example?: ReactNode;
  quiz: Quiz;
}

const Sticky = ({ kind, children }: { kind: string; children: ReactNode }) => <span className={`tut-sticky sticky-${kind}`}>{children}</span>;
const Arrow = () => <span className="tut-arrow" aria-label="から">→</span>;

const LESSONS: Lesson[] = [
  {
    id: "language",
    title: "ドメインとユビキタス言語",
    body: (
      <>
        <p>
          <strong>ドメイン</strong>は、ソフトウェアが扱う業務の領域です。この講座では「清掃会社がスタッフ候補を招待し、候補が受諾する」業務を例にします。
        </p>
        <p>
          DDD（ドメイン駆動設計）の出発点は、業務の専門家（ドメインエキスパート）と開発者が<strong>同じ言葉</strong>で話すことです。会議の言葉、図の言葉、コードの名前をそろえた言葉を<strong>ユビキタス言語</strong>と呼びます。「招待」を会議では「オファー」、コードでは <code>Request</code> と呼ぶと、ずれが生まれます。
        </p>
      </>
    ),
    example: (
      <p className="small">
        このツールでは、付箋のラベル（日本語）とコードの名前（<code>Invitation</code>）の対応が、モデルの用語集に残ります。
      </p>
    ),
    quiz: {
      question: "ユビキタス言語について正しいものは？",
      choices: ["開発者だけが使う専門用語のこと", "業務の専門家と開発者が、会話・図・コードで同じ意味で使う言葉のこと", "英語で書かれた用語集のこと"],
      answer: 1,
      explanation: "業務の人と開発者が同じ言葉を同じ意味で使うことが目的です。言語（日本語か英語か）は問いません。",
    },
  },
  {
    id: "events",
    title: "ドメインイベント・コマンド・アクター",
    body: (
      <>
        <p>
          業務を理解するいちばんの近道は、<strong>起きる出来事</strong>から考えることです。これを<strong>ドメインイベント</strong>と呼び、過去形で書きます。
        </p>
        <p>
          出来事を起こす操作が<strong>コマンド</strong>、コマンドを実行する人が<strong>アクター</strong>です。付箋を壁に貼りながらこれらを並べていく手法を <strong>EventStorming</strong> と呼び、このツールの「ディスカバリー」タブはその道具です。
        </p>
      </>
    ),
    example: (
      <div className="tut-flow">
        <Sticky kind="actor">スタッフ候補</Sticky>
        <Arrow />
        <Sticky kind="command">招待を受諾する</Sticky>
        <Arrow />
        <Sticky kind="event">招待が受諾された</Sticky>
      </div>
    ),
    quiz: {
      question: "ドメインイベントの書き方として適切なのは？",
      choices: ["招待を受諾する", "招待受諾ボタン", "招待が受諾された"],
      answer: 2,
      explanation: "イベントは「起きた事実」なので過去形で書きます。「招待を受諾する」はコマンド、「ボタン」は画面の話です。",
    },
  },
  {
    id: "entity-vo",
    title: "Entity と Value Object",
    body: (
      <>
        <p>
          <strong>Entity</strong> は、識別子で「同じもの」かを判断するものです。招待は、内容が変わっても招待IDが同じなら同じ招待です。状態は時間とともに変わります（保留中 → 受諾済み）。
        </p>
        <p>
          <strong>Value Object</strong> は、値そのもので判断するものです。メールアドレス <code>staff@example.com</code> は、どこに現れても同じ値です。変更せず、別の値に置き換えます。「形式が正しいメールアドレスしか存在しない」のように、値のルールを型に閉じ込められます。
        </p>
      </>
    ),
    example: (
      <pre className="tut-code">{`value_objects:
  - name: EmailAddress
    fields:
      - name: value
        type: String
        constraints: { pattern: "^[^@\\s]+@[^@\\s]+$" }
    normalize: { value: [strip, lower] }`}</pre>
    ),
    quiz: {
      question: "Value Object にするのが自然なものは？",
      choices: ["注文（注文番号で区別し、状態が変わる）", "金額（1,000円は どこでも1,000円）", "会員（会員IDで区別する）"],
      answer: 1,
      explanation: "金額は値そのものが意味を持ち、同じ値なら区別しません。注文や会員は識別子で区別し状態が変わるので Entity です。",
    },
  },
  {
    id: "aggregate",
    title: "集約（Aggregate）と整合性の境界",
    body: (
      <>
        <p>
          <strong>集約</strong>は、コマンドを受けて<strong>一度の変更で必ず守るべきルール</strong>を守るまとまりです。外からは集約の入口（Aggregate Root）を通してだけ変更し、保存も集約の単位で行います。
        </p>
        <p>集約を決めるときの問い:</p>
        <ul>
          <li>一度の操作で、必ず同時に正しくなければならないものは何か</li>
          <li>それ以外は、イベントで少し遅れて伝われば十分ではないか</li>
          <li>集約は小さく保ち、他の集約はIDで参照しているか</li>
        </ul>
      </>
    ),
    example: (
      <div className="tut-flow">
        <Sticky kind="command">招待を受諾する</Sticky>
        <Arrow />
        <Sticky kind="aggregate">招待</Sticky>
        <Sticky kind="rule">期限切れの招待は受諾できない</Sticky>
      </div>
    ),
    quiz: {
      question: "「受諾されたら歓迎メールを送る」を、招待の集約の中で同時に行うべき？",
      choices: ["はい。同じ操作なので同じ集約で同時に行う", "いいえ。招待の受諾だけを確定し、歓迎メールは「招待が受諾された」イベントを受けて別に行う"],
      answer: 1,
      explanation: "メール送信が失敗しても受諾は有効にしたいはずです。集約をまたぐ処理はイベントでつなぎ、それぞれの整合性を小さく保ちます。",
    },
  },
  {
    id: "rules",
    title: "Invariant と State guard",
    body: (
      <>
        <p>
          <strong>Invariant（不変条件）</strong>は、いつでも成り立つ条件です。「有効期限は作成日時より後」は、招待を作るときも、状態が変わるときも、常に正しくなければなりません。このツールは生成コードで自動的に確かめます。
        </p>
        <p>
          <strong>State guard（状態ガード）</strong>は、特定の操作の時点で確かめる条件です。「受諾するときは、保留中かつ期限前であること」は受諾の時だけの条件で、取り消しには関係しません。生成コードでは <code>checks()</code>（真偽を返す）と <code>assert_holds()</code>（違反ならエラー）になります。
        </p>
      </>
    ),
    example: (
      <pre className="tut-code">{`invariants:
  - name: expiry_after_creation
    expression: expires_at > created_at
    error: InvalidInvitationWindow
state_guards:
  - name: pending_until_expiry
    parameters: [{ name: at, type: DateTime }]
    expression: status == pending and at < expires_at
    error: InvitationNotDeliverable
operations:
  - name: accept
    require: [pending_until_expiry(at)]`}</pre>
    ),
    quiz: {
      question: "「受諾済みの招待は受諾日時を持つ」はどちら？",
      choices: ["Invariant（いつでも成り立つ）", "State guard（受諾の時点だけ確かめる）"],
      answer: 0,
      explanation: "受諾済みなのに受諾日時がない状態は、いつであっても不正です。常に成り立つべきなので Invariant です。",
    },
  },
  {
    id: "context",
    title: "Bounded context（境界づけられたコンテキスト）",
    body: (
      <>
        <p>
          大きな業務では、同じ言葉が場所によって違う意味になります。「スタッフ」は採用では「候補者」、シフト管理では「勤務者」かもしれません。<strong>Bounded context</strong> は、言葉が一つの意味で通じる範囲です。
        </p>
        <p>境界の目安は、言葉の意味が変わる所、担当チームが変わる所、ポリシー（「〜されたら〜する」）でつながる所です。コンテキスト同士はイベントで連携します。</p>
      </>
    ),
    example: (
      <div className="tut-flow">
        <span className="tut-frame">スタッフ招待</span>
        <Sticky kind="event">招待が受諾された</Sticky>
        <Arrow />
        <Sticky kind="policy">受諾されたら歓迎メールを送る</Sticky>
        <Arrow />
        <span className="tut-frame">通知</span>
      </div>
    ),
    quiz: {
      question: "コンテキストを分ける手がかりとして弱いものは？",
      choices: ["同じ言葉の意味が違う", "担当するチームが違う", "画面が別々のページに分かれている"],
      answer: 2,
      explanation: "画面の分け方は見せ方の都合です。言葉の意味や担当の違いが、モデルの境界の手がかりになります。",
    },
  },
  {
    id: "usecase",
    title: "Use case とシナリオ",
    body: (
      <>
        <p>
          <strong>Use case</strong> は、アクターの操作に対応する手順です。「招待を読み込む → 受諾する → 保存する → コミット後にイベントを公開する」のように、順序とトランザクションの境界を表します。
        </p>
        <p>
          <strong>シナリオ</strong>は Given（前提）/ When（操作）/ Then（期待する結果）で書く具体例です。このツールではシナリオがそのまま pytest のテストになるので、ドメインエキスパートと合意した例がそのまま動く確認になります。
        </p>
      </>
    ),
    example: (
      <div className="tut-gwt">
        <strong>Given</strong> 現在時刻は期限の日時で、招待は保留中
        <br />
        <strong>When</strong> スタッフ候補が招待を受諾する
        <br />
        <strong>Then</strong> InvitationNotDeliverable で失敗し、イベントは発生しない
      </div>
    ),
    quiz: {
      question: "シナリオの Then に書くべきでないものは？",
      choices: ["どのエラーで失敗するか", "結果の状態やイベント", "「うまく動くこと」"],
      answer: 2,
      explanation: "「うまく動く」では何を確かめるか決まりません。このツールは期待結果があいまいなシナリオをエラーにします。",
    },
  },
];

function QuizView({ quiz }: { quiz: Quiz }) {
  const [picked, setPicked] = useState<number>();
  return (
    <div className="tut-quiz" role="group" aria-label="確認クイズ">
      <p className="tut-quiz-q">確認: {quiz.question}</p>
      <div className="stack" style={{ gap: 6 }}>
        {quiz.choices.map((c, i) => (
          <button
            key={i}
            className={`tut-choice${picked === undefined ? "" : i === quiz.answer ? " is-correct" : picked === i ? " is-wrong" : ""}`}
            onClick={() => setPicked(i)}
            aria-pressed={picked === i}
          >
            {picked !== undefined && i === quiz.answer ? "✓ " : picked === i ? "✕ " : ""}
            {c}
          </button>
        ))}
      </div>
      {picked !== undefined && (
        <p className={`small ${picked === quiz.answer ? "tut-ok" : "sev-warning"}`} role="status">
          {picked === quiz.answer ? "正解です。" : "もう一度考えてみましょう。"} {quiz.explanation}
        </p>
      )}
    </div>
  );
}

export function TutorialPage({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const writable = me.workspaces.find((w) => w.role !== "viewer");

  const start = async () => {
    if (!writable) return;
    setStarting(true);
    setError(undefined);
    try {
      const { id } = await api.createProject(writable.id, { name: "チュートリアル：清掃スタッフの招待", template: "empty", description: "チュートリアル用のプロジェクト" });
      tutorialStore.startWith(id);
      navigate({ page: "project", id, tab: "discovery" });
    } catch (e) {
      setError(describeError(e));
      setStarting(false);
    }
  };

  return (
    <>
      <TopBar me={me} onLogout={onLogout} crumbs={<span>チュートリアル</span>} />
      <main className="page tut">
        <header className="stack" style={{ gap: 10 }}>
          <h1>チュートリアル：DDD とこのツールの使い方</h1>
          <p className="tut-lead">
            清掃会社がスタッフ候補を招待し、候補が受諾する——この小さな業務を題材に、DDD の考え方を短く学び、実際にこのツールでモデルを作ってコードとテストを生成するまでを体験します。
          </p>
          <nav className="tut-toc" aria-label="目次">
            {/* The URL hash is used for routing, so jump with scrollIntoView instead of #anchors. */}
            {[
              ["part1", "第1部 DDD の基本（約15分・クイズつき）"],
              ["part2", "第2部 手を動かして作る（約30分）"],
              ["part3", "早見表"],
            ].map(([id, label]) => (
              <button key={id} className="linklike" onClick={() => document.getElementById(id!)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                {label}
              </button>
            ))}
          </nav>
        </header>

        <section id="part1" className="stack" style={{ gap: 20 }}>
          <h2>第1部 DDD の基本</h2>
          {LESSONS.map((l, i) => (
            <article key={l.id} className="tut-lesson" aria-labelledby={`lesson-${l.id}`}>
              <h3 id={`lesson-${l.id}`}>
                <span className="tut-num">{i + 1}</span>
                {l.title}
              </h3>
              <div className="tut-body">{l.body}</div>
              {l.example && (
                <div className="tut-example">
                  <span className="small muted">例</span>
                  {l.example}
                </div>
              )}
              <QuizView quiz={l.quiz} />
            </article>
          ))}
        </section>

        <section id="part2" className="stack" style={{ gap: 14 }}>
          <h2>第2部 手を動かして作る</h2>
          <p>
            チュートリアル用のプロジェクトを作り、画面の右下に出る<strong>ガイド</strong>に沿って進めます。ガイドは、ボードやモデルの状態を見て、できた手順に自動で ✓ を付けます。
          </p>
          <ol className="tut-steps">
            {TUTORIAL_STEPS.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong>
                <span className="small muted"> — {s.why}</span>
              </li>
            ))}
          </ol>
          {error && <p className="error-banner">{error}</p>}
          {writable ? (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="primary" onClick={() => void start()} disabled={starting}>
                チュートリアル用のプロジェクトを作って始める
              </button>
              <span className="small muted">「{writable.name}」に空のプロジェクトを作ります。あとで削除できます。</span>
            </div>
          ) : (
            <p className="small sev-warning">編集できるワークスペースがありません。ワークスペースを作るか、editor 以上の権限をもらってください。</p>
          )}
          <p className="small muted">CLI（コマンドライン）での進め方は、リポジトリの docs/12-tutorial.md にもまとめています。</p>
        </section>

        <section id="part3" className="stack" style={{ gap: 10 }}>
          <h2>早見表</h2>
          <table className="table tut-table">
            <thead>
              <tr>
                <th>用語</th>
                <th>ひとことで</th>
                <th>このツールでは</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["ドメインイベント", "業務で起きた事実（過去形）", "ボードのオレンジの付箋／モデルの emits"],
                ["コマンド", "誰かの意図・操作", "ボードの青い付箋／モデルの operation と Use case"],
                ["集約（Aggregate）", "一度の変更で守るルールを持つまとまり", "ボードの淡い黄色の付箋／モデルの aggregates"],
                ["Entity", "識別子で区別し、状態が変わるもの", "集約の identity、entities"],
                ["Value Object", "値そのもので区別する不変の型", "value_objects"],
                ["Invariant", "いつでも成り立つ条件", "invariants（構築時と状態遷移後に自動確認）"],
                ["State guard", "操作の時点で確かめる条件", "state_guards と operation の require"],
                ["Bounded context", "言葉が一つの意味で通じる範囲", "ボードのフレーム／モデルの contexts"],
                ["ポリシー", "「〜されたら〜する」自動の反応", "ボードの紫の付箋（コンテキスト間の連携）"],
                ["シナリオ", "Given / When / Then の具体例", "scenarios（そのまま pytest になる）"],
              ].map(([a, b, c]) => (
                <tr key={a}>
                  <td>
                    <strong>{a}</strong>
                  </td>
                  <td>{b}</td>
                  <td className="small">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
