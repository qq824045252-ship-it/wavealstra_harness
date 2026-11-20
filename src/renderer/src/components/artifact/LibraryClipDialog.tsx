import { useEffect, useRef, useState } from "react";
import type { LibraryNoteOperationResults, LibraryOwnerScope, LibrarySnapshotDto } from "@shared/library-ipc";
import { libraryOwnerOf } from "@/lib/scopedLibrary";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useAppStore } from "@/store/appStore";
import "./LibraryClipDialog.css";

export default function LibraryClipDialog({ tabId, onClose }: { tabId: string; onClose: () => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LibrarySnapshotDto | null>(null);
  const [personalRoot, setPersonalRoot] = useState("");
  const [target, setTarget] = useState("");
  const [tags, setTags] = useState("");
  const [selection, setSelection] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LibraryNoteOperationResults["clip"]>();
  const dialog = useRef<HTMLDialogElement>(null);
  useBlockNativeSurfaces(true);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void window.api?.library.snapshot().then((data) => {
      if (!active) return;
      setSnapshot(data);
      setPersonalRoot(data.spaces.find((space) => space.id === "personal")?.id ?? "");
    }, (cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);

  async function saveClip(): Promise<void> {
    const library = window.api?.library;
    if (!library || busy || !snapshot) return;
    setBusy(true); setError("");
    try {
      const [kind, id] = target.split(":");
      const folder = kind === "folder" ? snapshot.collections.find((item) => item.id === id) : undefined;
      const space = snapshot.spaces.find((item) => item.id === (folder?.spaceId ?? (kind === "space" ? id : personalRoot)));
      const owner: LibraryOwnerScope = space ? libraryOwnerOf(space) : { type: "personal" };
      let spaceId = space?.id;
      if (!spaceId) {
        const ensured = await library.ensureOwnedSpace(owner);
        if (!ensured.ok) throw new Error(ensured.error);
        spaceId = ensured.value.id;
      }
      const clipped = await library.note({ type: "clip", tabId, selection, owner, spaceId, collectionId: folder?.id ?? null,
        tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) });
      if (!clipped.ok) throw new Error(clipped.error);
      setResult(clipped.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const folderLabel = (folder: LibrarySnapshotDto["collections"][number]): string => {
    const parts = [folder.name];
    for (let parentId = folder.parentId; parentId && parts.length < 10;) {
      const parent = snapshot?.collections.find((item) => item.id === parentId);
      if (!parent) break;
      parts.unshift(parent.name); parentId = parent.parentId;
    }
    return parts.join(" / ");
  };

  return <dialog ref={dialog} className="library-clip-dialog" aria-label="网页剪藏"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void saveClip(); }}>
      <h3>保存到笔记</h3>
      {result ? <>
        <p role="status">已保存「{result.item.title}」{result.failedImages.length > 0
          ? "，" + result.failedImages.length + " 张图片未保存到本地。" : "。"}</p>
        {result.failedImages.length > 0 && <details><summary>查看图片地址</summary>
          <ul>{result.failedImages.map((src) => <li key={src}>{src}</li>)}</ul></details>}
        <footer><button type="button" onClick={onClose}>完成</button>
          <button type="button" onClick={() => {
            useAppStore.getState().requestLibraryNav({ view: "item", itemId: result.item.id });
            onClose();
          }}>打开笔记</button></footer>
      </> : <>
        <label>剪藏内容<select value={selection ? "selection" : "article"} disabled={busy}
          onChange={(event) => setSelection(event.target.value === "selection")}>
          <option value="article">文章正文</option><option value="selection">当前选区</option>
        </select></label>
        <label>目标文件夹<select aria-label="剪藏目标" value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
          <option value="">我的笔记</option>
          {snapshot?.spaces.map((space) => <optgroup label={space.projectName ?? space.workspaceName ?? space.name} key={space.id}>
            {space.id !== personalRoot && <option value={"space:" + space.id}>{space.name}</option>}
            {snapshot.collections.filter((folder) => folder.spaceId === space.id).map((folder) =>
              <option key={folder.id} value={"folder:" + folder.id}>{folderLabel(folder)}</option>)}
          </optgroup>)}
        </select></label>
        <label>标签<input value={tags} disabled={busy} placeholder="用逗号分隔" onChange={(event) => setTags(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" disabled={!snapshot || busy}>{busy ? "正在剪藏…" : "保存"}</button></footer>
      </>}
    </form>
  </dialog>;
}
