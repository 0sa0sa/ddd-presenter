/** The レビュー tab's state: the stored answers against the current questions (docs/11 §11). */
import { reviewFindings, type ReviewFinding, type ReviewQuestion, type ReviewVerdict } from "@ddd/core";

export interface StoredAnswer {
  answer: ReviewVerdict | null;
  note: string;
  /** The question as it read when answered. */
  text: string;
  by: string | null;
  at: string;
}

export type ReviewFilter = "all" | "open" | "findings";

export interface ReviewState {
  answered: number;
  findings: ReviewFinding[];
  /** Ids of the findings, for marking their rows. */
  findingIds: Set<string>;
  /** Answers to questions the model no longer asks (an element was renamed or removed). */
  stale: { id: string; stored: StoredAnswer }[];
}

export function answersOf(stored: Readonly<Record<string, StoredAnswer>>): Record<string, ReviewVerdict> {
  const out: Record<string, ReviewVerdict> = {};
  for (const [id, s] of Object.entries(stored)) if (s.answer === "yes" || s.answer === "no") out[id] = s.answer;
  return out;
}

export function reviewState(questions: readonly ReviewQuestion[], stored: Readonly<Record<string, StoredAnswer>>): ReviewState {
  const answers = answersOf(stored);
  const ids = new Set(questions.map((q) => q.id));
  const findings = reviewFindings(questions, answers);
  return {
    answered: questions.filter((q) => answers[q.id]).length,
    findings,
    findingIds: new Set(findings.map((f) => f.question.id)),
    stale: Object.entries(stored)
      .filter(([id, s]) => !ids.has(id) && s.answer)
      .map(([id, s]) => ({ id, stored: s })),
  };
}

export function filterQuestions(questions: readonly ReviewQuestion[], stored: Readonly<Record<string, StoredAnswer>>, filter: ReviewFilter, findingIds: Set<string>): ReviewQuestion[] {
  if (filter === "open") return questions.filter((q) => !stored[q.id]?.answer);
  if (filter === "findings") return questions.filter((q) => findingIds.has(q.id));
  return [...questions];
}
