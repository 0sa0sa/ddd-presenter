import { describe, expect, test } from "bun:test";
import { clearDraft, readDraft, writeDraft } from "../src/lib/drafts.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe("model drafts", () => {
  test("a draft is kept per project until cleared", () => {
    const s = memory();
    writeDraft("p1", { yaml: "a: 1", baseVersion: 3, savedAt: "2026-10-03T00:00:00Z" }, s);
    expect(readDraft("p1", s)).toEqual({ yaml: "a: 1", baseVersion: 3, savedAt: "2026-10-03T00:00:00Z" });
    expect(readDraft("p2", s)).toBeUndefined();
    clearDraft("p1", s);
    expect(readDraft("p1", s)).toBeUndefined();
  });

  test("broken or blocked storage never throws", () => {
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readDraft("p", broken)).toBeUndefined();
    expect(() => writeDraft("p", { yaml: "", baseVersion: 1, savedAt: "" }, broken)).not.toThrow();
    expect(() => clearDraft("p", broken)).not.toThrow();
  });
});
