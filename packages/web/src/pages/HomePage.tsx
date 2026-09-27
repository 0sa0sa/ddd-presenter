import { useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";
import { href, navigate } from "../App.tsx";
import { TopBar } from "../components/TopBar.tsx";

export function HomePage({ me, onLogout, onChanged }: { me: Me; onLogout: () => void; onChanged: () => void }) {
  const [name, setName] = useState("");

  // A single workspace is the common case: on a fresh visit (no route in the URL) go straight to it.
  useEffect(() => {
    const fresh = window.location.hash === "" || window.location.hash === "#";
    if (fresh && me.workspaces.length === 1) navigate({ page: "workspace", ws: me.workspaces[0]!.id });
  }, [me]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const { id } = await api.createWorkspace(name.trim());
    setName("");
    onChanged();
    navigate({ page: "workspace", ws: id });
  };

  return (
    <>
      <TopBar me={me} onLogout={onLogout} />
      <main className="page">
        <h1>ワークスペース</h1>
        <div className="panel">
          <ul className="list">
            {me.workspaces.map((w) => (
              <li key={w.id}>
                <a className="project-link" href={href({ page: "workspace", ws: w.id })}>
                  {w.name}
                </a>
                <span className="role">{w.role}</span>
              </li>
            ))}
          </ul>
        </div>
        <form className="row" onSubmit={create}>
          <input aria-label="新しいワークスペース名" placeholder="新しいワークスペース名" value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit">ワークスペースを作る</button>
        </form>
      </main>
    </>
  );
}
