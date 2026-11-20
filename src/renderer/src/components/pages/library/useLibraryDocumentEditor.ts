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
  autoSave?: boolean;
}

export function useLibraryDocumentEditor({ itemId, access, onSaved, onRegisterUnsaved, autoSave = false }: Options) {
  const [payload, setPayload] = useState<LibraryContentDto | null>(null);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [savePaused, setSavePaused] = useState(false);
  const epoch = useRef(0);
  const savingPromise = useRef<{ epoch: number; promise: Promise<void> } | null>(null);
  const loadedSource = useRef<{ access: ScopedLibraryOperations; itemId: string } | null>(null);
  const draftBase = useRef<number | undefined>(undefined);
  const currentPayload = loadedSource.current?.access === access && loadedSource.current.itemId === itemId ? payload : null;
  const draftKey = libraryDraftKey(libraryOwnerKey(access.scope), itemId);
  const storage = autoSave ? window.localStorage : window.sessionStorage;
  const dirty = !access.readOnly && Boolean(currentPayload && (title !== currentPayload.item.title || draft !== currentPayload.content));
  const state = useRef({ payload: currentPayload, title, draft, dirty });
  state.current = { payload: currentPayload, title, draft, dirty };
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    const ticket = ++epoch.current;
    loadedSource.current = null;
    setPayload(null); setLoadError(null); setNotice(null); setSaving(false); setDraftSaved(false); setSavePaused(false);
    void access.read(itemId).then((next) => {
      if (ticket !== epoch.current) return;
      if (next.contentTooLarge || next.contentTruncated) {
        setLoadError("请通过资料的「打开位置」访问原文件");
        return;
      }
      const restored = access.readOnly ? null : readLibraryDraft(storage, draftKey)
        ?? (autoSave ? readLibraryDraft(window.sessionStorage, draftKey) : null);
      loadedSource.current = { access, itemId };
      setPayload(next);
      setTitle(restored?.title ?? next.item.title);
      setDraft(restored?.content ?? next.content);
      draftBase.current = restored?.baseUpdatedAt ?? next.item.updatedAt;
      if (autoSave && restored && restored.baseUpdatedAt !== next.item.updatedAt) setSavePaused(true);
      if (restored) setNotice(restored.baseUpdatedAt === next.item.updatedAt
        ? "已恢复未保存的草稿" : "已恢复未保存的草稿；原资料已有更新，请核对后再保存。");
    }, (error: unknown) => {
      if (ticket === epoch.current) setLoadError(error instanceof Error ? error.message : "无法读取文档");
    });
    return () => { epoch.current += 1; };
  }, [access, autoSave, draftKey, itemId, storage]);

  useEffect(() => {
    if (!currentPayload || access.readOnly) return;
    const retained = syncLibraryDraft(storage, draftKey, dirty ? { title, content: draft,
      baseUpdatedAt: autoSave ? draftBase.current ?? currentPayload.item.updatedAt : currentPayload.item.updatedAt } : null);
    setDraftSaved(dirty && retained);
    if (dirty && !retained) {
      setNotice("草稿暂时无法保留，请先保存再离开。");
    }
  }, [draftKey, currentPayload, title, draft, dirty, access.readOnly, storage, autoSave]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const discard = useCallback(() => {
    const current = state.current.payload;
    clearLibraryDraft(storage, draftKey);
    if (autoSave) clearLibraryDraft(window.sessionStorage, draftKey);
    draftBase.current = current?.item.updatedAt;
    if (current) { setTitle(current.item.title); setDraft(current.content); }
    setNotice(null); setSavePaused(false);
  }, [autoSave, draftKey, storage]);

  const save = useCallback(async (): Promise<void> => {
    if (savingPromise.current?.epoch === epoch.current) return savingPromise.current.promise;
    const current = state.current;
    if (!current.payload || !current.dirty) return;
    if (access.readOnly) throw new Error("当前资料只读");
    if (!current.title.trim()) throw new Error("请输入资料标题");
    const ticket = epoch.current;
    const work = (async () => {
      setSaving(true); setNotice(null);
      let next = current.payload!;
      try {
        if (autoSave && !next.requiresFileAccess && ["markdown", "html", "csv"].includes(next.item.kind)) {
          const item = await access.saveNote(next, current.title.trim(), current.draft);
          next = { ...next, item, content: current.draft };
        } else if (current.title.trim() !== next.item.title) {
          const item = await access.renameItem(itemId, current.title.trim());
          next = { ...next, item };
          if (ticket === epoch.current) setPayload(next);
        }
        if (!autoSave && !next.requiresFileAccess && ["markdown", "html", "csv"].includes(next.item.kind)
          && current.draft !== next.content) {
          const item = await access.writeContent(itemId, current.draft);
          next = { ...next, item, content: current.draft };
        }
        if (ticket === epoch.current) {
          const latest = state.current;
          const changedSinceSave = autoSave && (current.title !== latest.title || current.draft !== latest.draft);
          const pending = changedSinceSave && (latest.title !== next.item.title || latest.draft !== next.content);
          draftBase.current = next.item.updatedAt;
          state.current = { payload: next, title: pending ? latest.title : next.item.title,
            draft: pending ? latest.draft : next.content, dirty: pending };
          if (!pending) {
            clearLibraryDraft(storage, draftKey);
            if (autoSave) clearLibraryDraft(window.sessionStorage, draftKey);
            setTitle(next.item.title); setDraft(next.content);
          }
          setPayload(next); setSavePaused(false);
          setNotice("已保存"); onSavedRef.current(next.item);
        }
      } catch (error) {
        if (ticket === epoch.current) {
          if (autoSave) setSavePaused(true);
          setNotice(error instanceof Error ? error.message : "保存失败");
        }
        throw error;
      } finally { if (ticket === epoch.current) setSaving(false); }
    })();
    savingPromise.current = { epoch: ticket, promise: work };
    try { await work; } finally { if (savingPromise.current?.promise === work) savingPromise.current = null; }
  }, [access, autoSave, draftKey, itemId, storage]);

  useEffect(() => {
    if (!autoSave || !dirty || saving || savePaused || !title.trim()) return;
    const timer = window.setTimeout(() => void save().catch(() => {}), 650);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, draft, save, savePaused, saving, title]);

  const flush = useCallback(async () => {
    if (!autoSave) return save();
    while (state.current.dirty) await save();
  }, [autoSave, save]);

  useEffect(() => {
    onRegisterUnsaved?.({ dirty, save: flush, discard });
    return () => onRegisterUnsaved?.(null);
  }, [dirty, flush, discard, onRegisterUnsaved]);

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

  const changeTitle = (value: string): void => {
    if (autoSave) updateLocalDraft(value, state.current.draft);
    setTitle(value);
  };
  const changeDraft = (value: string): void => {
    if (autoSave) updateLocalDraft(state.current.title, value);
    setDraft(value);
  };
  function updateLocalDraft(nextTitle: string, nextContent: string): void {
    const base = state.current.payload;
    if (!base || access.readOnly) return;
    const dirty = nextTitle !== base.item.title || nextContent !== base.content;
    state.current = { payload: base, title: nextTitle, draft: nextContent, dirty };
    setDraftSaved(syncLibraryDraft(storage, draftKey, dirty ? { title: nextTitle, content: nextContent,
      baseUpdatedAt: draftBase.current ?? base.item.updatedAt } : null));
  }

  return { payload: currentPayload, title, setTitle: autoSave ? changeTitle : setTitle, draft, setDraft: autoSave ? changeDraft : setDraft,
    dirty, draftSaved, saving, save: flush, discard, loadError, notice, savePaused };
}
