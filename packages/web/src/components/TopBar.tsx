import type { ReactNode } from "react";
import type { Me } from "../api.ts";

export function TopBar({ me, crumbs, children, onLogout }: { me: Me; crumbs?: ReactNode; children?: ReactNode; onLogout: () => void }) {
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
      <span className="muted small">{me.user.username}</span>
      <button className="quiet" onClick={onLogout}>
        ログアウト
      </button>
    </header>
  );
}
