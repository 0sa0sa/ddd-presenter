import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.users().then((r) => setUsers(r.users.map((u) => u.username)), () => setUsers([]));
  }, []);

  const login = async (name: string) => {
    setError(undefined);
    try {
      await api.login(name);
      onLogin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "サーバーに接続できません。`bun run dev:server` が起動しているか確認してください。");
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim()) void login(username.trim());
  };

  return (
    <main className="login">
      <section className="login-model" aria-label="DDD Presenter について">
        <h1>業務ルールに名前を付けて、一度だけ書く。</h1>
        <p>
          Entity、Value Object、Aggregate、不変条件と状態ガード、ユースケースの手順と期待結果をひとつのモデルにまとめます。モデルを検証し、Pythonのドメインコードとテストを生成します。生成物はあなたのリポジトリのものです。
        </p>
        <div className="rule-sample" aria-label="ルールの例">
          <span>
            <span className="glyph kind-guard">⊘</span> <strong>pending_until_expiry</strong>(at)
          </span>
          <span className="muted">status == pending and at &lt; expires_at</span>
          <span>
            違反時 <span className="kind kind-error">InvitationNotDeliverable</span> ・ accept が自動で確認
          </span>
        </div>
      </section>
      <section className="login-form">
        <h2>ログイン</h2>
        <p className="muted small">開発用の簡易ログインです。ユーザー名だけで入れます。初めての名前ならアカウントと個人ワークスペースを作ります。</p>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            ユーザー名
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" pattern="[A-Za-z0-9_.\-]+" required />
          </label>
          <button className="primary" type="submit">
            ログイン
          </button>
        </form>
        {users.length > 0 && (
          <div className="stack">
            <span className="small muted">既存のユーザーで入る</span>
            <div className="user-list">
              {users.map((u) => (
                <button key={u} onClick={() => void login(u)}>
                  {u}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
