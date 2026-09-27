import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, describeError, type AuditEntry, type Me, type Member, type ProjectSummary, type Role } from "../api.ts";
import { href, navigate } from "../App.tsx";
import { TopBar } from "../components/TopBar.tsx";

const ROLE_HELP: Record<Role, string> = {
  owner: "メンバー管理・削除・監査ログの閲覧",
  editor: "モデルと図の編集",
  viewer: "閲覧のみ",
};

const ACTION_LABEL: Record<string, string> = {
  "workspace.create": "ワークスペースを作成",
  "member.add": "メンバーを追加",
  "member.role": "権限を変更",
  "member.remove": "メンバーを削除",
  "project.create": "プロジェクトを作成",
  "project.import": "モデルをインポート",
  "project.export": "モデルをエクスポート",
  "project.delete": "プロジェクトを削除",
};

export function WorkspacePage({ me, ws, onLogout, onChanged }: { me: Me; ws: string; onLogout: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"projects" | "members" | "audit">("projects");
  const [name, setName] = useState<string>();
  const [role, setRole] = useState<Role>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.workspace(ws).then(
      (r) => {
        setName(r.workspace.name);
        setRole(r.role);
      },
      (e) => setError(e instanceof ApiError && e.status === 404 ? "このワークスペースは存在しないか、参加していません。" : describeError(e)),
    );
  }, [ws]);

  return (
    <>
      <TopBar
        me={me}
        onLogout={onLogout}
        crumbs={
          <>
            <a href="#/">ワークスペース</a>
            <span aria-hidden>/</span>
            <span>{name ?? "…"}</span>
          </>
        }
      />
      <main className="page">
        {error && <p className="error-banner">{error}</p>}
        {role && (
          <>
            <div className="row">
              <h1>{name}</h1>
              <span className="role" title={ROLE_HELP[role]}>
                {role}
              </span>
            </div>
            <div className="tabs" role="tablist" style={{ background: "transparent", padding: 0 }}>
              <button className="tab" role="tab" aria-selected={tab === "projects"} onClick={() => setTab("projects")}>
                プロジェクト
              </button>
              <button className="tab" role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")}>
                メンバー
              </button>
              {role === "owner" && (
                <button className="tab" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>
                  監査ログ
                </button>
              )}
            </div>
            {tab === "projects" && <Projects ws={ws} role={role} />}
            {tab === "members" && <Members ws={ws} role={role} me={me} onChanged={onChanged} />}
            {tab === "audit" && <Audit ws={ws} />}
          </>
        )}
      </main>
    </>
  );
}

function Projects({ ws, role }: { ws: string; role: Role }) {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<"sample" | "empty">("sample");
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.projects(ws).then((r) => setProjects(r.projects), (e) => setError(describeError(e))), [ws]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const { id } = await api.createProject(ws, { name: name.trim(), template });
      navigate({ page: "project", id });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const importFile = async (file: File) => {
    setError(undefined);
    try {
      const yaml = await file.text();
      const { id } = await api.createProject(ws, { name: file.name.replace(/\.(ddd\.)?ya?ml$/, ""), yaml });
      navigate({ page: "project", id });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`「${p.name}」を削除します。モデルの全バージョンと図の配置も消え、元に戻せません。先にエクスポートしておくことをおすすめします。`)) return;
    try {
      await api.deleteProject(p.id);
    } catch (e) {
      setError(describeError(e));
    }
    void load();
  };

  return (
    <div className="stack">
      {error && <p className="error-banner">{error}</p>}
      <div className="panel">
        {projects && projects.length === 0 && (
          <div className="panel-body muted">まだプロジェクトがありません。サンプルモデルから始めると、生成されるコードとテストをすぐに確認できます。</div>
        )}
        <ul className="list">
          {projects?.map((p) => (
            <li key={p.id}>
              <div className="stack" style={{ gap: 2 }}>
                <a className="project-link" href={href({ page: "project", id: p.id })}>
                  {p.name}
                </a>
                <span className="small muted">
                  v{p.version}・更新 {new Date(p.updated_at).toLocaleString()}
                </span>
              </div>
              <div className="spacer" />
              <a className="small" href={`/api/projects/${p.id}/export`} download>
                YAMLをエクスポート
              </a>
              {role === "owner" && (
                <button className="quiet danger" onClick={() => void remove(p)}>
                  削除
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {role !== "viewer" && (
        <div className="panel">
          <div className="panel-head">
            <h2>新しいプロジェクト</h2>
          </div>
          <form className="panel-body row" style={{ flexWrap: "wrap" }} onSubmit={create}>
            <label className="field" style={{ flex: "1 1 220px" }}>
              プロジェクト名
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              開始モデル
              <select value={template} onChange={(e) => setTemplate(e.target.value as "sample" | "empty")}>
                <option value="sample">サンプル（清掃スタッフの招待）</option>
                <option value="empty">空のモデル</option>
              </select>
            </label>
            <button className="primary" type="submit" style={{ alignSelf: "end" }}>
              作成
            </button>
            <label className="field" style={{ alignSelf: "end" }}>
              <span className="visually-hidden">YAMLモデルをインポート</span>
              <input
                type="file"
                accept=".yaml,.yml"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                }}
              />
            </label>
          </form>
        </div>
      )}
    </div>
  );
}

function Members({ ws, role, me, onChanged }: { ws: string; role: Role; me: Me; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [username, setUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("editor");
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.members(ws).then((r) => setMembers(r.members), (e) => setError(describeError(e))), [ws]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="stack">
      {error && <p className="error-banner">{error}</p>}
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th>権限</th>
              {role === "owner" && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.username}
                  {m.id === me.user.id && <span className="muted small">（あなた）</span>}
                </td>
                <td>
                  {role === "owner" ? (
                    <select aria-label={`${m.username}の権限`} value={m.role} onChange={(e) => void run(() => api.setRole(ws, m.id, e.target.value as Role))}>
                      <option value="owner">owner</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    <span className="role">{m.role}</span>
                  )}
                  <span className="small muted"> {ROLE_HELP[m.role]}</span>
                </td>
                {role === "owner" && (
                  <td>
                    <button className="quiet danger" onClick={() => void run(() => api.removeMember(ws, m.id))}>
                      外す
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {role === "owner" && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.addMember(ws, username.trim(), newRole);
              setUsername("");
            });
          }}
        >
          <input aria-label="追加するユーザー名" placeholder="ユーザー名（一度ログイン済みの人）" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <select aria-label="付与する権限" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
            <option value="owner">owner</option>
          </select>
          <button type="submit">メンバーを追加</button>
        </form>
      )}
    </div>
  );
}

function Audit({ ws }: { ws: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.audit(ws).then((r) => setEntries(r.entries), (e) => setError(describeError(e)));
  }, [ws]);
  if (error) return <p className="error-banner" role="alert">{error}</p>;
  return (
    <div className="panel">
      <table className="table">
        <thead>
          <tr>
            <th>日時</th>
            <th>操作者</th>
            <th>操作</th>
            <th>対象</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="small">{new Date(e.at).toLocaleString()}</td>
              <td>{e.actor ?? "—"}</td>
              <td>{ACTION_LABEL[e.action] ?? e.action}</td>
              <td>
                {e.target}
                {e.action === "member.role" && (
                  <span className="muted small">
                    {" "}
                    {String(e.detail.from)} から {String(e.detail.to)} へ
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
