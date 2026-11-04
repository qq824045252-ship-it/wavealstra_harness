import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryContentDto, LibraryItemDto } from "@shared/library-ipc";
import { libraryOwnerKey, type LibraryUnsavedGuard } from "@/lib/scopedLibrary";
import { clearLibraryDraft, libraryDraftKey, readLibraryDraft, syncLibraryDraft } from "@/lib/libraryDraft";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";

interface Options {
  itemId: string;
  access: ScopedLibraryOperations;
  onSaved: (item: LibraryItemDto) => void;
  onRegisterUnsaved?: (guard: LibraryUnsavedGuard | null) => void;
}

export function useLibraryDocumentEditor({ itemId, access, onSaved, onRegisterUnsaved }: Options) {
  const [payload, setPayload] = useState<LibraryContentDto | null>(null);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const epoch = useRef(0);
  const savingPromise = useRef<Promise<void> | null>(null);
  const draftKey = libraryDraftKey(libraryOwnerKey(access.scope), itemId);
  const dirty = !access.readOnly && Boolean(payload && (title !== payload.item.title || draft !== payload.content));
  const state = useRef({ payload, title, draft, dirty });
  state.current = { payload, title, draft, dirty };
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    const ticket = ++epoch.current;
    setPayload(null); setLoadError(null); setNotice(null);
    void access.read(itemId).then((next) => {
      if (ticket !== epoch.current) return;
      const restored = access.readOnly ? null : readLibraryDraft(window.sessionStorage, draftKey);
      setPayload(next);
      setTitle(restored?.title ?? next.item.title);
      setDraft(restored?.content ?? next.content);
      if (restored) setNotice(restored.baseUpdatedAt === next.item.updatedAt
        ? "已恢复未保存的草稿" : "已恢复未保存的草稿；原资料已有更新，请核对后再保存。");
    }, (error: unknown) => {
      if (ticket === epoch.current) setLoadError(error instanceof Error ? error.message : "无法读取文档");
    });
    return () => { epoch.current += 1; };
  }, [access, draftKey, itemId]);

  useEffect(() => {
    if (!payload || access.readOnly) return;
    const retained = syncLibraryDraft(window.sessionStorage, draftKey, dirty ? { title, content: draft, baseUpdatedAt: payload.item.updatedAt } : null);
    setDraftSaved(dirty && retained);
    if (dirty && !retained) {
      setNotice("草稿暂时无法保留，请先保存再离开。");
    }
  }, [draftKey, payload, title, draft, dirty, access.readOnly]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const discard = useCallback(() => {
    const current = state.current.payload;
    clearLibraryDraft(window.sessionStorage, draftKey);
    if (current) { setTitle(current.item.title); setDraft(current.content); }
    setNotice(null);
  }, [draftKey]);

  const save = useCallback(async (): Promise<void> => {
    if (savingPromise.current) return savingPromise.current;
    const current = state.current;
    if (!current.payload || !current.dirty) return;
    if (access.readOnly) throw new Error("当前资料只读");
    if (!current.title.trim()) throw new Error("请输入资料标题");
    const ticket = epoch.current;
    const work = (async () => {
      setSaving(true); setNotice(null);
      let next = current.payload!;
      try {
        if (current.title.trim() !== next.item.title) {
          const item = await access.renameItem(itemId, current.title.trim());
          next = { ...next, item };
          if (ticket === epoch.current) setPayload(next);
        }
        if (!next.requiresFileAccess && ["markdown", "html", "csv"].includes(next.item.kind)
          && current.draft !== next.content) {
          const item = await access.writeContent(itemId, current.draft);
          next = { ...next, item, content: current.draft };
        }
        clearLibraryDraft(window.sessionStorage, draftKey);
        if (ticket === epoch.current) {
          setPayload(next); setTitle(next.item.title); setDraft(next.content);
          setNotice("已保存"); onSavedRef.current(next.item);
        }
      } catch (error) {
        if (ticket === epoch.current) setNotice(error instanceof Error ? error.message : "保存失败");
        throw error;
      } finally { if (ticket === epoch.current) setSaving(false); }
    })();
    savingPromise.current = work;
    try { await work; } finally { savingPromise.current = null; }
  }, [access, draftKey, itemId]);

  useEffect(() => {
    onRegisterUnsaved?.({ dirty, save, discard });
    return () => onRegisterUnsaved?.(null);
  }, [dirty, save, discard, onRegisterUnsaved]);

  useEffect(() => {
    if (access.readOnly) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (state.current.dirty) void save().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [access.readOnly, save]);

  return { payload, title, setTitle, draft, setDraft, dirty, draftSaved, saving, save, discard, loadError, notice };
}
