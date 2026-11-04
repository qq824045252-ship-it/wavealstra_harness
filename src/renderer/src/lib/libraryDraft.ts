export interface LibraryDraft {
  title: string;
  content: string;
  baseUpdatedAt: number;
}

export function libraryDraftKey(ownerKey: string, itemId: string): string {
  return `library-draft:v1:${ownerKey}:${itemId}`;
}

export function readLibraryDraft(storage: Pick<Storage, "getItem">, key: string): LibraryDraft | null {
  try {
    const data = JSON.parse(storage.getItem(key) ?? "null") as Partial<LibraryDraft> | null;
    return data && typeof data.title === "string" && typeof data.content === "string"
      && typeof data.baseUpdatedAt === "number" ? data as LibraryDraft : null;
  } catch { return null; }
}

export function writeLibraryDraft(storage: Pick<Storage, "setItem">, key: string, draft: LibraryDraft): boolean {
  try { storage.setItem(key, JSON.stringify(draft)); return true; }
  catch { return false; }
}

export function clearLibraryDraft(storage: Pick<Storage, "removeItem">, key: string): void {
  try { storage.removeItem(key); } catch {}
}

/** Returning to the saved value is an explicit withdrawal of the previous draft. */
export function syncLibraryDraft(storage: Pick<Storage, "setItem" | "removeItem">, key: string, draft: LibraryDraft | null): boolean {
  if (draft) return writeLibraryDraft(storage, key, draft);
  try { storage.removeItem(key); return true; } catch { return false; }
}
