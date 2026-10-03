import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type AuthConfig } from "../api.ts";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [config, setConfig] = useState<AuthConfig>();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [devName, setDevName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.authConfig().then(setConfig, (e) => setError(describeError(e)));
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await action();
      onLogin();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name || !password) return;
    void run(() => (mode === "register" ? api.register(name, password) : api.login(name, password)));
  };

  const devLogin = (name: string) => void run(() => api.login(name));

  return (
    <main className="login">
      <section className="login-model" aria-label="DDD Presenter について">
        <h1>業務ルールに名前を付けて、一度だけ書く。</h1>
        <p>
          Entity、Value Object、Aggregate、不変条件と状態ガード、ユースケースの手順と期待結果をひとつのモデルにまとめます。モデルを検証し、Python または TypeScript のドメインコードとテストを生成します。生成物はあなたのリポジトリのものです。
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
        <h2>{mode === "register" ? "アカウントを作る" : "ログイン"}</h2>
        <p className="muted small">
          {mode === "register"
            ? "ユーザー名とパスワード（8文字以上）を決めてください。個人ワークスペースを作ります。"
            : "ユーザー名とパスワードでログインします。ログイン後、右上の「使い方」から DDD の説明とチュートリアルを開けます。"}
        </p>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            ユーザー名
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" pattern="[A-Za-z0-9_.\-]+" maxLength={40} required />
          </label>
          <label className="field">
            パスワード
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 8 : undefined} maxLength={200} required />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {mode === "register" ? "アカウントを作ってログイン" : "ログイン"}
          </button>
        </form>
        {config?.registration && (
          <p className="small">
            {mode === "register" ? "アカウントをお持ちの方は " : "初めての方は "}
            <button className="linklike" type="button" onClick={() => (setMode(mode === "register" ? "signin" : "register"), setError(undefined))}>
              {mode === "register" ? "ログイン" : "アカウントを作る"}
            </button>
          </p>
        )}
        {config && !config.registration && <p className="small muted">新しいアカウントは管理者に作ってもらってください。</p>}
        {config?.dev_login && (
          <div className="stack">
            <h3 className="small">開発用の簡易ログイン</h3>
            <p className="small muted">
              このサーバーはこのマシンからだけ接続でき、パスワードを持つアカウントがまだないため、ユーザー名だけで入れます。だれかがパスワード付きのアカウントを作ると使えなくなります（入ったあと右上のメニューからパスワードを設定できます）。
            </p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (devName.trim()) devLogin(devName.trim());
              }}
            >
              <input aria-label="ユーザー名（簡易ログイン）" value={devName} onChange={(e) => setDevName(e.target.value)} pattern="[A-Za-z0-9_.\-]+" maxLength={40} placeholder="ユーザー名" />
              <button type="submit" disabled={busy}>
                名前だけで入る
              </button>
            </form>
            {config.users && config.users.length > 0 && (
              <div className="stack">
                <span className="small muted">既存のユーザーで入る</span>
                <div className="user-list">
                  {config.users.map((u) => (
                    <button key={u} onClick={() => devLogin(u)} disabled={busy}>
                      {u}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
