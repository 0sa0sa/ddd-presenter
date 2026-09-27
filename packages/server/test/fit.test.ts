import { describe, expect, test } from "bun:test";
import { fitToCursor } from "../src/fit.ts";

describe("fitting an AI continuation to the cursor", () => {
  const doc = "        scenarios:\n          - \n    use_cases:\n";
  const offset = doc.indexOf("- ") + 2;

  test("a repeated dash and absolute indentation are removed", () => {
    expect(fitToCursor(doc, offset, "          - name: a\n            given: {}")).toBe("name: a\n            given: {}");
  });

  test("text indented for column 0 is moved under the item", () => {
    expect(fitToCursor(doc, offset, "- name: a\n  given:\n    aggregate: {}")).toBe("name: a\n            given:\n              aggregate: {}");
  });

  test("on a blank line, a new item keeps its dash and its keys line up after it", () => {
    const blank = "        scenarios:\n          \n";
    expect(fitToCursor(blank, blank.indexOf("\n          ") + 11, "- name: a\n  when: {}")).toBe("- name: a\n            when: {}");
  });

  test("text that starts on the next line, or a cursor at column 0, is left alone", () => {
    const doc2 = "            then: {}\n\n    use_cases:\n";
    const at = doc2.indexOf("\n    use_cases:");
    expect(fitToCursor(doc2, at, "\n          - name: x\n            when: {}")).toBe("\n          - name: x\n            when: {}");
    const indented = "        scenarios:\n          \n";
    expect(fitToCursor(indented, indented.indexOf("\n          ") + 11, "\n  - name: x")).toBe("\n  - name: x");
  });

  test("mid-line continuations are left alone", () => {
    const emits = "            emits:\n";
    expect(fitToCursor(emits, emits.indexOf(":") + 1, "\n              - name: E")).toBe("\n              - name: E");
  });
});
