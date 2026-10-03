/** Unsaved model edits kept in this browser, so leaving the page or the project never loses them. */
export interface ModelDraft {
  yaml: string;
  /** Model version the draft was based on (a newer saved version means someone changed it meanwhile). */
  baseVersion: number;
  savedAt: string;
}

const key = (projectId: string) => `ddd.draft.${projectId}`;

export function readDraft(projectId: string, storage: Pick<Storage, "getItem"> = localStorage): ModelDraft | undefined {
  try {
    const raw = storage.getItem(key(projectId));
    if (!raw) return undefined;
    const d = JSON.parse(raw) as ModelDraft;
    return typeof d.yaml === "string" && typeof d.baseVersion === "number" ? d : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraft(projectId: string, draft: ModelDraft, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(key(projectId), JSON.stringify(draft));
  } catch {
    // Storage full or blocked (private mode): the in-page draft still exists until the page is left.
  }
}

export function clearDraft(projectId: string, storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(key(projectId));
  } catch {
    // Nothing to clear.
  }
}
