import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowRight, ArrowUp, File, Folder, FolderPlus, Search, X } from "lucide-react";
import type { FileDialogApi, FileDialogDirectory, FileDialogEntry, FileDialogSelection, FileDialogState } from "@shared/file-dialog";
import "../styles/global.css";
import "./file-dialog.css";

declare global {
  interface Window {
    fileDialog: FileDialogApi;
  }
}

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT|ENOTDIR/.test(message)) return "找不到这个位置，请检查路径。";
  if (/EACCES|EPERM/.test(message)) return "没有权限访问这个位置。";
  if (/EEXIST/.test(message)) return "同名文件夹已存在。";
  return message.replace(/^.*?Error invoking remote method '[^']+': Error:\s*/, "");
}

type Travel = "new" | "back" | "forward";

function Picker({ initial }: { initial: FileDialogState }): React.JSX.Element {
  const [view, setView] = useState(initial.directory);
  const [address, setAddress] = useState(view.path);
  const [search, setSearch] = useState("");
  const [name, setName] = useState(initial.initialName);
  const [selection, setSelection] = useState<string[]>(() => initial.directory.entries
    .filter((entry) => initial.mode === "open-file" && entry.name === initial.initialName && entry.kind === "file")
    .map((entry) => entry.path));
  const [filter, setFilter] = useState(0);
  const [hidden, setHidden] = useState(initial.showHidden);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [replacement, setReplacement] = useState("");
  const [folderName, setFolderName] = useState<string>();
  const [history, setHistory] = useState({ paths: [view.path], position: 0 });
  const selectionAnchor = useRef<string | undefined>(undefined);
  const listRoot = useRef<HTMLUListElement>(null);
  const locked = useRef(false);

  const isSave = initial.mode === "save";
  const isFolder = initial.mode === "open-directory";
  const extensionFilter = initial.filters[filter]?.extensions ?? [];
  const query = search.trim().toLocaleLowerCase();
  const entries = view.entries.filter((entry) => {
    if (!hidden && entry.hidden) return false;
    const lower = entry.name.toLocaleLowerCase();
    if (query && !lower.includes(query)) return false;
    if (entry.kind === "directory") return true;
    return !isFolder && (!extensionFilter.length || extensionFilter.includes("*")
      || extensionFilter.some((extension) => lower.endsWith("." + extension.toLocaleLowerCase())));
  });
  const visibleSelection = entries.filter((entry) => selection.includes(entry.path)).map((entry) => entry.path);
  const hasChoice = isSave ? Boolean(name.trim()) : isFolder || visibleSelection.length > 0;

  async function run(operation: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setWorking(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      locked.current = false;
      setWorking(false);
    }
  }

  function showDirectory(next: FileDialogDirectory, travel: Travel): void {
    setView(next);
    setAddress(next.path);
    setSearch("");
    setSelection([]);
    selectionAnchor.current = undefined;
    setReplacement("");
    setFolderName(undefined);
    if (listRoot.current) listRoot.current.scrollTop = 0;
    setHistory((previous) => {
      if (travel === "back") return { ...previous, position: previous.position - 1 };
      if (travel === "forward") return { ...previous, position: previous.position + 1 };
      if (previous.paths[previous.position] === next.path) return previous;
      const paths = [...previous.paths.slice(0, previous.position + 1), next.path];
      return { paths, position: paths.length - 1 };
    });
  }

  function navigate(path: string, travel: Travel = "new"): void {
    void run(async () => showDirectory(await window.fileDialog.list(path.trim()), travel));
  }

  function selectEntry(entry: FileDialogEntry, range: boolean): void {
    setReplacement("");
    if (entry.kind === "directory") {
      if (isFolder) setSelection([entry.path]);
      return;
    }
    if (isSave) {
      setName(entry.name);
      setSelection([entry.path]);
      return;
    }

    if (initial.multiple) {
      const from = entries.findIndex((item) => item.path === selectionAnchor.current);
      const to = entries.findIndex((item) => item.path === entry.path);
      if (range && from >= 0 && to >= 0) {
        setSelection((previous) => [...new Set([...previous, ...entries.slice(Math.min(from, to), Math.max(from, to) + 1)
          .filter((item) => item.kind === "file").map((item) => item.path)])]);
        return;
      }
      setSelection((previous) => previous.includes(entry.path) ? previous.filter((path) => path !== entry.path) : [...previous, entry.path]);
    } else {
      setSelection([entry.path]);
    }
    selectionAnchor.current = entry.path;
  }

  function confirm(overwrite = false, singlePath?: string): void {
    const choice: FileDialogSelection = isSave
      ? { kind: "save", directory: view.path, name, filter, overwrite }
      : { kind: "entries", paths: singlePath ? [singlePath] : visibleSelection.length ? visibleSelection : isFolder ? [view.path] : [] };
    void run(async () => {
      const result = await window.fileDialog.submit(choice);
      if (result.state === "overwrite") setReplacement(result.name);
    });
  }

  function activateEntry(entry: FileDialogEntry): void {
    if (entry.kind === "directory") {
      navigate(entry.path);
    } else if (!isSave && !initial.multiple) {
      confirm(false, entry.path);
    }
  }

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (replacement) setReplacement("");
      else if (folderName !== undefined) setFolderName(undefined);
      else window.fileDialog.cancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [folderName, replacement]);

  return <div className="file-dialog">
    <header className="file-dialog-header">
      <span className="file-dialog-icon" aria-hidden="true"><Folder size={19} /></span>
      <h1>{initial.title}</h1>
      <button type="button" className="icon-btn" title="关闭" aria-label="关闭" onClick={() => window.fileDialog.cancel()}><X size={18} /></button>
    </header>

    <div className="file-dialog-body">
      <nav className="file-dialog-places" aria-label="常用位置">
        {initial.places.map((place) => <button type="button" key={place.path} title={place.path}
          aria-current={view.path === place.path ? "location" : undefined} disabled={working}
          onClick={() => navigate(place.path)}><Folder size={16} /><span>{place.label}</span></button>)}
      </nav>

      <section className="file-dialog-browser" aria-label="文件与文件夹">
        <form className="file-dialog-toolbar" onSubmit={(event) => { event.preventDefault(); navigate(address); }}>
          <div className="file-dialog-travel" aria-label="目录导航">
            <button className="icon-btn" type="button" title="返回" aria-label="返回" disabled={working || history.position < 1}
              onClick={() => navigate(history.paths[history.position - 1], "back")}><ArrowLeft size={16} /></button>
            <button className="icon-btn" type="button" title="前进" aria-label="前进" disabled={working || history.position === history.paths.length - 1}
              onClick={() => navigate(history.paths[history.position + 1], "forward")}><ArrowRight size={16} /></button>
            <button className="icon-btn" type="button" title="上一级" aria-label="上一级" disabled={working || !view.parent}
              onClick={() => { if (view.parent) navigate(view.parent); }}><ArrowUp size={16} /></button>
          </div>
          <label className="file-dialog-address">
            <Folder size={15} aria-hidden="true" />
            <input aria-label="文件夹路径" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={working || !address.trim()}>前往</button>
        </form>

        <div className="file-dialog-list-tools">
          <label className="file-dialog-search">
            <Search size={16} aria-hidden="true" />
            <input aria-label="按名称筛选" placeholder="按名称筛选" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label className="file-dialog-check"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />显示隐藏项目</label>
          <button className="btn" type="button" disabled={working} onClick={() => setFolderName("")}><FolderPlus size={15} />新建文件夹</button>
        </div>

        {folderName !== undefined && <form className="file-dialog-create" onSubmit={(event) => {
          event.preventDefault();
          void run(async () => showDirectory(await window.fileDialog.createFolder(view.path, folderName), "new"));
        }}>
          <input aria-label="新文件夹名称" placeholder="文件夹名称" autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} />
          <button className="btn" type="button" onClick={() => setFolderName(undefined)}>取消</button>
          <button className="btn primary" type="submit" disabled={working || !folderName.trim()}>创建</button>
        </form>}

        <ul className="file-dialog-list" aria-label="当前文件夹" aria-busy={working} ref={listRoot}>
          {entries.map((entry) => <li key={entry.path}>
            <button className="file-dialog-entry" type="button" title={entry.name}
              aria-pressed={selection.includes(entry.path)} disabled={working}
              onClick={(event) => selectEntry(entry, event.shiftKey)}
              onDoubleClick={() => activateEntry(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (entry.kind === "directory" || (!isSave && !initial.multiple))) {
                  event.preventDefault();
                  activateEntry(entry);
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const item = event.currentTarget.parentElement;
                  const sibling = event.key === "ArrowDown" ? item?.nextElementSibling : item?.previousElementSibling;
                  sibling?.querySelector("button")?.focus();
                }
              }}>
              {entry.kind === "directory" ? <Folder size={17} /> : <File size={17} />}
              <span>{entry.name}</span>
            </button>
          </li>)}
          {!entries.length && <li className="file-dialog-empty">{search || view.entries.length ? "没有符合条件的项目" : "这个文件夹是空的"}</li>}
        </ul>
      </section>
    </div>

    {message && <div className="file-dialog-message" role="alert">{message}</div>}
    {replacement && <section className="file-dialog-overwrite" aria-label="确认替换">
      <p role="alert">「{replacement}」已存在。要替换它吗？</p>
      <button type="button" className="btn" onClick={() => setReplacement("")}>返回</button>
      <button type="button" className="btn primary" disabled={working} onClick={() => confirm(true)}>替换</button>
    </section>}

    <form className="file-dialog-footer" onSubmit={(event) => { event.preventDefault(); confirm(); }}>
      <div className="file-dialog-fields">
        {isSave && <label className="file-dialog-name">文件名<input aria-label="文件名" autoFocus value={name}
          onChange={(event) => { setName(event.target.value); setReplacement(""); }} /></label>}
        {initial.filters.length > 0 && <label className="file-dialog-filter">文件类型
          <select aria-label="文件类型" value={filter} onChange={(event) => {
            setFilter(Number(event.target.value)); setSelection([]); setReplacement("");
          }}>
            {initial.filters.map((item, index) => <option key={index} value={index}>{item.name}</option>)}
          </select>
        </label>}
        {initial.multiple && <span className="file-dialog-count" role="status">已选 {visibleSelection.length} 项</span>}
      </div>
      <div className="file-dialog-actions">
        <button type="button" className="btn" onClick={() => window.fileDialog.cancel()}>取消</button>
        <button type="submit" className="btn primary" disabled={working || !hasChoice || Boolean(replacement)}>{initial.confirmLabel}</button>
      </div>
    </form>
  </div>;
}

function App(): React.JSX.Element {
  const [state, setState] = useState<FileDialogState>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void window.fileDialog.start().then((initial) => {
      if (!active) return;
      document.documentElement.dataset.theme = initial.theme;
      setState(initial);
    }).catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, []);
  if (state) return <Picker initial={state} />;
  return <div className="file-dialog-start" role={error ? "alert" : "status"}>
    <p>{error || "正在打开文件对话框…"}</p>
    <button type="button" className="btn" onClick={() => window.fileDialog.cancel()}>取消</button>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
