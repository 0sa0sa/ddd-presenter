import { Database } from "bun:sqlite";

export type Role = "owner" | "editor" | "viewer";
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );
   CREATE TABLE workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE memberships (
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
     PRIMARY KEY (workspace_id, user_id)
   );
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );
   CREATE INDEX projects_by_workspace ON projects(workspace_id);
   CREATE TABLE model_versions (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     yaml TEXT NOT NULL,
     message TEXT NOT NULL DEFAULT '',
     author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, version)
   );
   -- Diagram layout is stored apart from the semantic model (positions never change meaning).
   CREATE TABLE layouts (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     workspace_id TEXT NOT NULL,
     actor_id TEXT,
     action TEXT NOT NULL,
     target TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '{}',
     at TEXT NOT NULL
   );
   CREATE INDEX audit_by_workspace ON audit_log(workspace_id, id);`,
  // Discovery board (EventStorming). Stored apart from the model; optimistic concurrency via version.
  `CREATE TABLE boards (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     json TEXT NOT NULL,
     updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
     updated_at TEXT NOT NULL
   );`,
  // AI assistance is off until a workspace owner turns it on (FR-035: tenants can disable AI entirely).
  `ALTER TABLE workspaces ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;`,
];

export function openDatabase(path = ":memory:"): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const done = new Set((db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(i + 1);
    })();
  });
  return db;
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
