import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolves a project-relative path and refuses anything that escapes the root. */
export function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  if (r.startsWith("..") || r.split(sep).includes("..") || resolve(r) === r) {
    throw new Error(`Refusing to write outside the project root: ${rel}`);
  }
  return abs;
}

export interface WriteOp {
  path: string;
  content?: string;
  /** Delete instead of write. */
  remove?: boolean;
}

/**
 * Applies all writes or none: content is staged in a temp directory first, existing
 * files are moved to a backup directory, and everything is restored on failure.
 */
export function atomicApply(root: string, ops: WriteOp[]): void {
  if (ops.length === 0) return;
  const stamp = `${process.pid}-${Date.now()}`;
  const stage = join(root, `.ddd-stage-${stamp}`);
  const backup = join(root, `.ddd-backup-${stamp}`);
  const done: { target: string; backedUp: boolean }[] = [];
  try {
    ops.forEach((op, i) => {
      if (op.remove) return;
      const staged = join(stage, String(i));
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, op.content ?? "");
    });
    ops.forEach((op, i) => {
      const target = safeJoin(root, op.path);
      let backedUp = false;
      if (existsSync(target)) {
        const b = join(backup, op.path);
        mkdirSync(dirname(b), { recursive: true });
        renameSync(target, b);
        backedUp = true;
      }
      done.push({ target, backedUp });
      if (!op.remove) {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(stage, String(i)), target);
      }
    });
  } catch (err) {
    for (const d of done.reverse()) {
      rmSync(d.target, { force: true });
      if (d.backedUp) {
        const rel = relative(root, d.target);
        renameSync(join(backup, rel), d.target);
      }
    }
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
}
