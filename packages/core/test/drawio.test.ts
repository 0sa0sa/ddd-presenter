import { describe, expect, test } from "bun:test";
import { boardToDrawio, compressDrawioPage, drawioToBoard, emptyBoard, frameOf, parseDrawio, sampleBoard, type DrawioPage } from "../src/index.ts";

const page = (text: string): DrawioPage => {
  const r = parseDrawio(text);
  if (!r.ok) throw new Error(r.error);
  return r.pages[0]!;
};

/** An EventStorming diagram drawn by hand in draw.io (its default colours, HTML labels, a container, an actor figure). */
const MODEL = `<mxGraphModel dx="1000" dy="600" grid="1"><root>
  <mxCell id="0" /><mxCell id="1" parent="0" />
  <mxCell id="ctx" value="採用" style="swimlane;whiteSpace=wrap;html=1;startSize=30;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="800" height="400" as="geometry" /></mxCell>
  <mxCell id="cmd" value="招待を&lt;br&gt;送る" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="ctx"><mxGeometry x="40" y="60" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="evt" value="&lt;div&gt;招待が&lt;/div&gt;&lt;div&gt;送られた&lt;/div&gt;" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;" vertex="1" parent="ctx"><mxGeometry x="220" y="60" width="120" height="60" as="geometry" /></mxCell>
  <UserObject label="招待" id="agg"><mxCell style="rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="ctx"><mxGeometry x="130" y="200" width="200" height="120" as="geometry" /></mxCell></UserObject>
  <mxCell id="who" value="管理者" style="shape=umlActor;verticalLabelPosition=bottom;html=1;" vertex="1" parent="1"><mxGeometry x="20" y="160" width="30" height="60" as="geometry" /></mxCell>
  <mxCell id="hot" value="再送できる？" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1"><mxGeometry x="1000" y="100" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="logo" value="" style="shape=image;image=data:image/png,abc;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="40" height="40" as="geometry" /></mxCell>
  <mxCell id="e1" value="" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="cmd" target="evt"><mxGeometry relative="1" as="geometry" /></mxCell>
  <mxCell id="e1l" value="成功したら" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e1"><mxGeometry x="-0.2" relative="1" as="geometry" /></mxCell>
  <mxCell id="e2" style="html=1;" edge="1" parent="1" source="who" target="cmd"><mxGeometry relative="1" as="geometry" /></mxCell>
  <mxCell id="e3" style="html=1;" edge="1" parent="1" source="cmd" target="agg"><mxGeometry relative="1" as="geometry" /></mxCell>
  <mxCell id="e4" style="html=1;" edge="1" parent="1" source="cmd"><mxGeometry relative="1" as="geometry"><mxPoint x="500" y="500" as="targetPoint" /></mxGeometry></mxCell>
</root></mxGraphModel>`;

describe("reading draw.io", () => {
  test("a hand-drawn EventStorming page becomes stickies, a context frame and arrows", () => {
    const p = page(`<mxfile host="app.diagrams.net"><diagram id="a" name="招待の流れ">${MODEL}</diagram></mxfile>`);
    expect(p.name).toBe("招待の流れ");
    const r = drawioToBoard(p, emptyBoard(), {}, { x: 0, y: 0 });
    const by = (text: string) => r.board.items.find((i) => i.text === text)!;
    expect(by("招待を\n送る").kind).toBe("command");
    expect(by("招待が\n送られた").kind).toBe("event");
    expect(by("招待").kind).toBe("aggregate"); // large yellow; the label came from the UserObject
    expect(by("管理者").kind).toBe("actor"); // the stick figure, whatever its colour
    expect(by("再送できる？").kind).toBe("hotspot");
    expect(r.board.frames.map((f) => f.title)).toEqual(["採用"]);
    // Children of the container were positioned relative to it, so they sit inside the frame.
    expect(frameOf(r.board, by("招待が\n送られた"))?.title).toBe("採用");
    expect(r.board.connectors).toHaveLength(3); // the dangling edge is left out
    expect(r.board.connectors.find((c) => c.label)?.label).toBe("成功したら");
    expect(r.counts).toMatchObject({ command: 1, event: 1, aggregate: 1, actor: 1, hotspot: 1, frame: 1 });
    expect(r.ignored).toBe(1); // the image
  });

  test("compressed pages (draw.io's default for older files) and several pages are read", () => {
    const xml = `<mxfile><diagram name="A">${compressDrawioPage(MODEL)}</diagram><diagram name="B">${MODEL}</diagram></mxfile>`;
    const r = parseDrawio(xml);
    expect(r.ok && r.pages.map((p) => [p.name, p.shapes.length])).toEqual([
      ["A", 7],
      ["B", 7],
    ]);
  });

  test("a .drawio.svg carries the diagram in its content attribute", () => {
    const file = `<mxfile><diagram name="P">${MODEL}</diagram></mxfile>`;
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="${file.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"><rect/></svg>`;
    expect(page(svg).shapes).toHaveLength(7);
    expect(parseDrawio(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`)).toMatchObject({ ok: false });
    expect(parseDrawio("hello")).toMatchObject({ ok: false });
  });

  test("colours can be remapped before importing, and a colour can be left out", () => {
    const p = page(`<mxfile><diagram name="P">${MODEL}</diagram></mxfile>`);
    expect(p.colors.map((c) => [c.fill, c.suggested])).toEqual(expect.arrayContaining([["#ffe6cc", "event"], ["#dae8fc", "command"], ["#f8cecc", "hotspot"]]));
    const r = drawioToBoard(p, emptyBoard(), { "#ffe6cc": "policy", "#f8cecc": "ignore" });
    expect(r.board.items.find((i) => i.text.startsWith("招待が"))!.kind).toBe("policy");
    expect(r.board.items.some((i) => i.text === "再送できる？")).toBe(false);
  });

  test("on a plain white diagram the wording decides: past tense = event, dictionary form = command", () => {
    const cell = (id: string, text: string, x: number) => `<mxCell id="${id}" value="${text}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="0" width="120" height="60" as="geometry" /></mxCell>`;
    const events = page(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cell("a", "注文された", 0)}${cell("b", "支払われた", 200)}${cell("c", "発送された", 400)}</root></mxGraphModel>`);
    expect(events.colors).toEqual([expect.objectContaining({ fill: "#ffffff", suggested: "event", count: 3 })]);
  });

  test("importing next to existing stickies keeps both and never reuses ids", () => {
    const p = page(`<mxfile><diagram name="P">${MODEL}</diagram></mxfile>`);
    const first = drawioToBoard(p, sampleBoard());
    const twice = drawioToBoard(p, first.board);
    const ids = twice.board.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rightOfSample = Math.max(...sampleBoard().items.map((i) => i.x + i.w), ...sampleBoard().frames.map((f) => f.x + f.w));
    const imported = first.board.items.filter((i) => !sampleBoard().items.some((s) => s.id === i.id));
    expect(Math.min(...imported.map((i) => i.x))).toBeGreaterThan(rightOfSample);
  });
});

describe("writing draw.io", () => {
  test("a board exported to draw.io imports back with the same stickies, frames and arrows", () => {
    const board = sampleBoard();
    const xml = boardToDrawio(board, "サンプル");
    expect(xml).toContain('<diagram id="ddd-board" name="サンプル">');
    const p = page(xml);
    const back = drawioToBoard(p, emptyBoard(), {}, { x: Math.min(...[...board.items, ...board.frames].map((b) => b.x)), y: Math.min(...[...board.items, ...board.frames].map((b) => b.y)) }).board;
    const sig = (b: typeof board) => b.items.map((i) => `${i.kind}:${i.text}:${i.x},${i.y}`).sort();
    expect(sig(back)).toEqual(sig(board));
    expect(back.frames.map((f) => f.title).sort()).toEqual(board.frames.map((f) => f.title).sort());
    expect(back.connectors).toHaveLength(board.connectors.length);
  });
});
