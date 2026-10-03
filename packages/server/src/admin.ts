/**
 * Account administration on the server machine (no HTTP):
 *   bun run admin set-password <username>   create the account if needed and set its password (read from stdin)
 *   bun run admin logout-all <username>     end every session of the account
 * Uses DDD_DB like the server. For closed registration (DDD_REGISTRATION=closed) and forgotten passwords.
 */
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { newId, now, openDatabase } from "./db.ts";

export async function runAdmin(args: string[], input: () => Promise<string>, dbPath: string): Promise<{ code: number; message: string }> {
  const [command, username] = args;
  if (!command || !username || !["set-password", "logout-all"].includes(command)) {
    return { code: 2, message: "usage: bun run admin set-password <username> | logout-all <username>" };
  }
  if (!/^[A-Za-z0-9_.@+-]{1,100}$/.test(username)) return { code: 2, message: "invalid username" };
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    let user = db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: string } | null;
    if (command === "logout-all") {
      if (!user) return { code: 1, message: `no such user: ${username}` };
      const n = db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
      return { code: 0, message: `ended ${n} session(s) of ${username}` };
    }
    const password = (await input()).replace(/\r?\n$/, "");
    if (password.length < 8 || password.length > 200) return { code: 1, message: "the password must be 8 to 200 characters" };
    const hash = await Bun.password.hash(password);
    if (!user) {
      user = { id: newId() };
      const ws = newId();
      const at = now();
      db.transaction(() => {
        db.query("INSERT INTO users (id, username, created_at, password_hash) VALUES (?, ?, ?, ?)").run(user!.id, username, at, hash);
        db.query("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(ws, `${username}'s workspace`, at);
        db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(ws, user!.id);
      })();
      return { code: 0, message: `created ${username} with a password` };
    }
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    return { code: 0, message: `password of ${username} changed; their sessions ended` };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dbPath = process.env.DDD_DB ?? join(import.meta.dir, "../data/ddd.sqlite");
  if (process.argv[2] === "set-password" && process.stdin.isTTY) process.stderr.write("New password (input is visible; pipe it in to avoid that): ");
  const r = await runAdmin(process.argv.slice(2), () => Bun.stdin.text(), dbPath);
  (r.code === 0 ? console.log : console.error)(r.message);
  process.exit(r.code);
}
