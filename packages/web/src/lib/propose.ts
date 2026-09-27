/** Kinds of aggregate proposals offered in the inspector and the proposal dialog. */
export type ProposeKind = "next-operation" | "guards" | "scenarios" | "events" | "custom";

export const PROPOSE_KINDS: { kind: ProposeKind; label: string; help: string }[] = [
  { kind: "next-operation", label: "次の操作", help: "状態の流れで足りない操作（ガード・変更・イベントつき）" },
  { kind: "guards", label: "ルール", help: "状態ガードとエラー" },
  { kind: "scenarios", label: "シナリオ", help: "成功と、ルールに違反する失敗のテスト" },
  { kind: "events", label: "イベントの内容", help: "イベントが運ぶフィールド" },
];
