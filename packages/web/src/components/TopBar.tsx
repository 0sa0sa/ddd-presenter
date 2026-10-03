import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError, type Me } from "../api.ts";

export function TopBar({ me, crumbs, children, onLogout }: { me: Me; crumbs?: ReactNode; children?: ReactNode; onLogout: () => void }) {
  const [menu, setMenu] = useState(false);
  const [passwordDialog, setPasswordDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const logoutEverywhere = async () => {
    setMenu(false);
    if (!window.confirm("すべてのブラウザと端末からログアウトします。よろしいですか？")) return;
    try {
      await api.logoutEverywhere();
    } catch {
      // The local sign-out below still happens.
    }
    onLogout();
  };

  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="brand-mark" aria-hidden>
          ◆
        </span>
        DDD Presenter
      </a>
      {crumbs && <nav className="crumbs" aria-label="現在地">{crumbs}</nav>}
      <div className="spacer" />
      {children}
      <a className="small" href="#/tutorial">
        使い方
      </a>
      <div className="account-menu" ref={menuRef}>
        <button className="quiet small" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          {me.user.username} ▾
        </button>
        {menu && (
          <div className="account-menu-list" role="menu">
            <button role="menuitem" className="quiet" onClick={() => (setMenu(false), setPasswordDialog(true))}>
              {me.user.has_password ? "パスワードを変更" : "パスワードを設定"}
            </button>
            {!me.proxy_auth && (
              <button role="menuitem" className="quiet" onClick={() => void logoutEverywhere()}>
                すべての端末からログアウト
              </button>
            )}
          </div>
        )}
      </div>
      {!me.proxy_auth && (
        <button className="quiet" onClick={onLogout}>
          ログアウト
        </button>
      )}
      {passwordDialog && <PasswordDialog hasPassword={!!me.user.has_password} onClose={() => setPasswordDialog(false)} />}
    </header>
  );
}

function PasswordDialog({ hasPassword, onClose }: { hasPassword: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (next !== confirm) {
      setError("新しいパスワードが一致しません");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(next, hasPassword ? current : undefined);
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="password-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <form className="modal password-dialog" onSubmit={(e) => void submit(e)}>
        <h2 id="password-title">{hasPassword ? "パスワードを変更" : "パスワードを設定"}</h2>
        {done ? (
          <p>パスワードを保存しました。ほかの端末のログインは終了しました。{!hasPassword && "次回からはユーザー名とパスワードでログインします。"}</p>
        ) : (
          <>
            {!hasPassword && <p className="small muted">このアカウントにはまだパスワードがありません。設定すると、ほかの人がこのユーザー名で入れなくなります。</p>}
            {hasPassword && (
              <label className="field">
                今のパスワード
                <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
              </label>
            )}
            <label className="field">
              新しいパスワード（8文字以上）
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required autoFocus={!hasPassword} />
            </label>
            <label className="field">
              新しいパスワード（確認）
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {done ? "閉じる" : "キャンセル"}
          </button>
          {!done && (
            <button className="primary" type="submit" disabled={busy}>
              保存
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
