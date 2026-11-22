import type { ReviewDraft } from "./ReviewDraft";

const STORAGE_PREFIX = "mybuddy.code-review-draft.v1:";
const volatileDrafts = new Map<string, ReviewDraft>();

export function readReviewDraft(scope: string): { draft: ReviewDraft; storageError: boolean } {
  const volatile = volatileDrafts.get(scope);
  if (volatile) return { draft: volatile, storageError: true };
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + scope);
    if (raw) {
      const draft = JSON.parse(raw) as Partial<ReviewDraft>;
      if (typeof draft.summary === "string" && Array.isArray(draft.comments)) {
        return { draft: { summary: draft.summary, comments: draft.comments }, storageError: false };
      }
    }
  } catch {
    // The in-memory copy remains available when local storage cannot be read.
  }
  return { draft: { summary: "", comments: [] }, storageError: false };
}

export function saveReviewDraft(scope: string, draft: ReviewDraft): boolean {
  try {
    const key = STORAGE_PREFIX + scope;
    if (draft.summary || draft.comments.length) window.localStorage.setItem(key, JSON.stringify(draft));
    else window.localStorage.removeItem(key);
    volatileDrafts.delete(scope);
    return true;
  } catch {
    volatileDrafts.set(scope, draft);
    return false;
  }
}
