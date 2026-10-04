/**
 * Hostile-input limits (docs/09 §11): inputs that used to crash or stall the parser, the board assistant,
 * the draw.io reader and completion must give a normal result quickly.
 */
import { describe, expect, test } from "bun:test";
import { strToU8, deflateSync } from "fflate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardGhosts, complete, compressDrawioPage, isSafeRelativeDir, MAX_EXPR_NESTING, parseDrawio, parseExpr, validateModelText, type Board, type BoardItem } from "../src/index.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../examples/cleaning-platform/model.ddd.yaml"), "utf8");

const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};

describe("expression limits", () => {
  test("deeply nested parentheses are a diagnostic, not a stack overflow", () => {
    const deep = `${"(".repeat(300_000)}status == pending${")".repeat(300_000)}`;
    const text = SAMPLE.replace("expression: status == pending\n", `expression: "${deep}"\n`);
    const [r, ms] = timed(() => validateModelText(text));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.severity === "error" && /too long|nested too deeply/.test(d.message))).toBe(true);
    expect(ms).toBeLessThan(3000);
  });

  test("nesting beyond the limit is rejected; up to the limit parses", () => {
    expect(() => parseExpr(`${"(".repeat(MAX_EXPR_NESTING)}a${")".repeat(MAX_EXPR_NESTING)}`)).not.toThrow();
    expect(() => parseExpr(`${"(".repeat(MAX_EXPR_NESTING + 1)}a${")".repeat(MAX_EXPR_NESTING + 1)}`)).toThrow(/nested too deeply/);
    expect(() => parseExpr(`${"not ".repeat(MAX_EXPR_NESTING + 1)}a`)).toThrow(/nested too deeply/);
    expect(() => parseExpr(`f(${"g(".repeat(MAX_EXPR_NESTING)}a${")".repeat(MAX_EXPR_NESTING)})`)).toThrow(/nested too deeply/);
  });

  test("very long flat expressions are rejected before they build a deep tree", () => {
    expect(() => parseExpr(Array(5000).fill("a").join(" and "))).toThrow(/too long/);
    expect(() => parseExpr(Array(100).fill("a").join(" and "))).not.toThrow();
  });
});

describe("generation paths", () => {
  test("only plain relative segments are accepted", () => {
    for (const ok of ["src", "src/app", "tests", "a.b/c-d_e", ".", "src/"]) expect(isSafeRelativeDir(ok)).toBe(true);
    for (const bad of ["/abs", "C:/x", "C:", "c:\\x", "~", "~/x", "", "a//b", "../x", "a/../b", "a/./b", "a\u0000b", "a\\b", "a b"]) expect(isSafeRelativeDir(bad)).toBe(false);
  });

  test("the validator reports unsafe src_dir / tests_dir", () => {
    for (const dir of ["/etc", "C:/x", '"~"', "a/../../b", '""']) {
      const r = validateModelText(SAMPLE.replace("src_dir: src", `src_dir: ${dir}`));
      expect(r.diagnostics.some((d) => d.code === "invalid-path")).toBe(true);
    }
    expect(validateModelText(SAMPLE.replace("src_dir: src", "src_dir: src/app")).diagnostics.some((d) => d.code === "invalid-path")).toBe(false);
  });
});

describe("board ghosts", () => {
  const item = (id: string, kind: BoardItem["kind"], x: number, y: number, text = "注文を確定する"): BoardItem => ({ id, kind, text, x, y, w: 160, h: 100 });

  /** The previous step-by-step search, kept as the reference for positions. */
  function reference(board: Board) {
    const byId = new Map(board.items.map((i) => [i.id, i]));
    const occupied = (x: number, y: number) => board.items.some((i) => Math.abs(i.x - x) < 120 && Math.abs(i.y - y) < 70);
    const out: { id: string; x: number; y: number }[] = [];
    for (const c of board.items.filter((i) => i.kind === "command" && i.text.trim())) {
      if (board.connectors.some((k) => k.from === c.id && byId.get(k.to)?.kind === "event")) continue;
      let x = c.x + c.w + 40;
      while (occupied(x, c.y)) x += 40;
      out.push({ id: `ghost-evt-${c.id}`, x, y: c.y });
    }
    for (const e of board.items.filter((i) => i.kind === "event" && i.text.trim())) {
      if (board.connectors.some((k) => k.to === e.id && ["command", "policy", "external_system", "aggregate"].includes(byId.get(k.from)?.kind ?? ""))) continue;
      let x = e.x - 200;
      while (occupied(x, e.y)) x -= 40;
      out.push({ id: `ghost-cmd-${e.id}`, x, y: e.y });
    }
    return out.slice(0, 12);
  }

  test("positions match the step-by-step search on random boards", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 200; n++) {
      const items: BoardItem[] = [];
      const count = 1 + Math.floor(rnd() * 25);
      for (let i = 0; i < count; i++) items.push(item(`i${i}`, rnd() < 0.5 ? "command" : rnd() < 0.7 ? "event" : "policy", Math.round(rnd() * 1500 - 300), Math.round(rnd() * 3) * 60 + Math.round(rnd() * 30), rnd() < 0.5 ? "注文を確定する" : "注文が確定された"));
      const connectors = items.flatMap((a, i) => (rnd() < 0.2 && items[i + 1] ? [{ id: `k${i}`, from: a.id, to: items[i + 1]!.id }] : []));
      const board: Board = { version: 1, frames: [], connectors, items };
      const got = boardGhosts(board).filter((g) => g.kind !== "aggregate").map((g) => ({ id: g.id, x: g.x, y: g.y }));
      expect(got).toEqual(reference(board).slice(0, got.length));
    }
  });

  test("3000 stickies in one row take well under 100 ms", () => {
    const items = Array.from({ length: 3000 }, (_, i) => item(`c${i}`, "command", i * 200, 0));
    const board: Board = { version: 1, frames: [], connectors: [], items };
    boardGhosts(board); // warm up
    // Fastest of several runs: guards against the old quadratic search (> 10 s) without failing on a busy machine.
    const runs = Array.from({ length: 5 }, () => timed(() => boardGhosts(board)));
    const [ghosts] = runs[0]!;
    expect(ghosts).toHaveLength(12);
    expect(ghosts[0]!.x).toBe(2999 * 200 + 120); // just past the last sticky of the row
    expect(Math.min(...runs.map(([, ms]) => ms))).toBeLessThan(100);
  });

  test("a fully connected row (no ghosts, aggregate grouping only) stays fast", () => {
    const items: BoardItem[] = [];
    const connectors: Board["connectors"] = [];
    for (let i = 0; i < 1500; i++) {
      items.push(item(`c${i}`, "command", i * 400, 0), item(`e${i}`, "event", i * 400 + 200, 0, "注文が確定された"));
      connectors.push({ id: `k${i}`, from: `c${i}`, to: `e${i}` });
    }
    const [, ms] = timed(() => boardGhosts({ version: 1, frames: [], connectors, items }));
    expect(ms).toBeLessThan(500);
  });
});

describe("draw.io reader limits", () => {
  const LONG = 160_000;
  for (const [name, open] of [
    ["comment", "<!--"],
    ["processing instruction", "<?pi"],
    ["CDATA section", "<![CDATA["],
    ["tag", '<mxCell value="'],
  ] as const) {
    test(`an unclosed ${name} is read in linear time`, () => {
      const [r, ms] = timed(() => parseDrawio(`<mxfile>${open}${"<a ".repeat(LONG / 3)}`));
      expect(r.ok).toBe(false);
      expect(ms).toBeLessThan(500);
    });
  }

  test("long runs of stray characters inside tags and labels stay linear", () => {
    const [, ms1] = timed(() => parseDrawio(`<mxfile><diagram ${"a".repeat(LONG)}></diagram></mxfile>`));
    const [, ms2] = timed(() => parseDrawio(`<mxfile><diagram><mxGraphModel><root><mxCell id="2" vertex="1" style="html=1" value="${"&lt;".repeat(LONG / 4)}"><mxGeometry width="10" height="10"/></mxCell></root></mxGraphModel></diagram></mxfile>`));
    const [, ms3] = timed(() => parseDrawio(`<svg${' content="'.repeat(LONG / 10)}`));
    expect(Math.max(ms1, ms2, ms3)).toBeLessThan(500);
  });

  test("deep nesting does not overflow the stack", () => {
    const r = parseDrawio(`<mxfile>${"<a>".repeat(200_000)}</mxfile>`);
    expect(r.ok).toBe(false);
  });

  test("a decompression bomb is skipped; other pages still import", () => {
    const bomb = compressDrawioPage("a".repeat(25_000_000));
    const good = compressDrawioPage('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="注文が確定された" style="fillColor=#ffa500;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>');
    expect(bomb.length).toBeLessThan(200_000);
    const r = parseDrawio(`<mxfile><diagram name="bomb">${bomb}</diagram><diagram name="ok">${good}</diagram></mxfile>`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages.map((p) => p.name)).toEqual(["ok"]);
  });

  test("oversized input is refused up front", () => {
    const r = parseDrawio(" ".repeat(20_000_001));
    expect(r.ok).toBe(false);
  });

  test("raw deflate data that is not a page is skipped", () => {
    const junk = btoa(String.fromCharCode(...deflateSync(strToU8("not xml"))));
    expect(parseDrawio(`<mxfile><diagram>${junk}</diagram></mxfile>`).ok).toBe(false);
  });
});

describe("completion on long values", () => {
  test("a 40 KB expression completes quickly", () => {
    const marker = "expression: status == pending\n";
    const long = `status == pending and ${"a".repeat(40_000)}`;
    const text = SAMPLE.replace(marker, `expression: ${long}\n`);
    const offset = text.indexOf(long) + long.length;
    const [, ms] = timed(() => complete(text, offset));
    expect(ms).toBeLessThan(300);
    // A member access at the end of a long value still completes members.
    const dotted = SAMPLE.replace(marker, `expression: ${"a".repeat(40_000)} or status.\n`);
    expect(() => complete(dotted, dotted.indexOf(" or status.") + " or status.".length)).not.toThrow();
  });
});
