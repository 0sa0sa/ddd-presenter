/** Line-based unified diff (pure; shared by the CLI, the server and the browser). */

export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  const ops = diffLines(a, b);
  const header = [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`];
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.t === "=") i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    // extend hunk while changes are within 2*context of each other
    for (;;) {
      while (end < ops.length && ops[end]!.t !== "=") end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === "=") next++;
      if (next < ops.length && next - end <= context * 2) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const slice = ops.slice(start, stop);
    const aStart = slice[0]!.ai;
    const bStart = slice[0]!.bi;
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) hunks.push(`${o.t === "=" ? " " : o.t}${o.line}`);
    i = stop;
    start = stop;
  }
  if (!hunks.length) return "";
  return [...header, ...hunks].join("\n") + "\n";
}

type Op = { t: "=" | "-" | "+"; line: string; ai: number; bi: number };

function diffLines(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix, then LCS on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: "=", line: a[k]!, ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ t: "=", line: A[i]!, ai: pre + i, bi: pre + j });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ t: "-", line: A[i]!, ai: pre + i, bi: pre + j });
      i++;
    } else {
      ops.push({ t: "+", line: B[j]!, ai: pre + i, bi: pre + j });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: "=", line: a[a.length - suf + k]!, ai: a.length - suf + k, bi: b.length - suf + k });
  return ops;
}

/** Spacing inside flow collections that YAML serializers do not preserve. */
function layoutKey(line: string): string {
  return line
    .replace(/\s+$/, "")
    .replace(/([{[])\s+/g, "$1")
    .replace(/\s+([}\]])/g, "$1")
    .replace(/,\s*/g, ", ");
}

/**
 * Puts the author's original lines back wherever a re-serialized document differs only in layout
 * (e.g. `{ name: x }` vs `{name: x}`), so a structural edit shows up as a minimal diff.
 * `sameData` confirms the result still means the same as `after`; otherwise `after` is returned.
 */
export function keepLayout(before: string, after: string, sameData: (a: string, b: string) => boolean): string {
  if (before === after) return after;
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a.map(layoutKey), b.map(layoutKey));
  const out: string[] = [];
  for (const o of ops) {
    if (o.t === "=") out.push(a[o.ai]!);
    else if (o.t === "+") out.push(b[o.bi]!);
  }
  const merged = out.join("\n");
  return merged !== after && sameData(merged, after) ? merged : after;
}
