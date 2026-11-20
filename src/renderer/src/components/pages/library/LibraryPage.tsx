import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { LibraryOwnerScope } from "@shared/library-ipc";
import { DesktopSectionSidebar, useDesktopNavigate, useDesktopSectionState, useDesktopShell } from "@/components/desktop/DesktopSection";
import { libraryOwnerKey, libraryOwnerOf, type LibraryUnsavedGuard } from "@/lib/scopedLibrary";
import { useAppStore } from "@/store/appStore";
import ScopedLibraryManager from "./ScopedLibraryManager";
import "@/styles/library.css";

const LibraryWorkbench = lazy(() => import("./LibraryWorkbench"));
const personal: LibraryOwnerScope = { type: "personal" };

interface Destination {
  key: string;
  scope: LibraryOwnerScope;
  name: string;
  readOnly: boolean;
  spaceId?: string;
  collectionId?: string | null;
  itemId?: string;
}

export default function LibraryPage(): React.JSX.Element {
  const desktop = useDesktopShell();
  const navigate = useDesktopNavigate();
  const nav = useAppStore((state) => state.libraryNav);
  const projects = useAppStore((state) => state.projects);
  const spaces = useAppStore((state) => state.spaces);
  const [preferredOwner, setPreferredOwner] = useDesktopSectionState<LibraryOwnerScope>("notes.owner", personal);
  const [requestedOwner, requestOwner] = useState(desktop ? preferredOwner : personal);
  const requestedOwnerKey = libraryOwnerKey(requestedOwner);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [error, setError] = useState("");
  const current = useRef<Destination | null>(null);
  const editor = useRef<LibraryUnsavedGuard | null>(null);
  const nextKey = useRef(0);
  const registerEditor = useCallback((guard: LibraryUnsavedGuard | null) => { editor.current = guard; }, []);

  useEffect(() => {
    if (!nav && current.current && libraryOwnerKey(current.current.scope) === requestedOwnerKey) {
      setError("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (!window.api?.library) throw new Error("资料服务不可用");
        let scope = requestedOwner;
        let spaceId: string | undefined;
        let collectionId: string | null | undefined;
        let itemId: string | undefined;
        if (nav) {
          const snapshot = await window.api.library.snapshot();
          const item = nav.view === "item" ? snapshot.items.find((entry) => entry.id === nav.itemId) : undefined;
          if (nav.view === "item" && !item) throw new Error("这份资料已不存在");
          spaceId = nav.view === "space" ? nav.spaceId : item?.spaceId;
          const space = snapshot.spaces.find((entry) => entry.id === spaceId);
          if (!space) throw new Error("资料位置已不存在");
          scope = libraryOwnerOf(space);
          collectionId = nav.view === "space" ? nav.folderId : item?.collectionId;
          itemId = item?.id;
        }
        let name = "我的笔记";
        let readOnly = false;
        if (scope.type === "project") {
          const project = await window.api.db.getProject(scope.projectId);
          if (!project) throw new Error("资料所属项目已不存在");
          name = `${project.name} · 项目资料`; readOnly = Boolean(project.archived);
        } else if (scope.type === "workspace") {
          const workspaces = await window.api.db.listSpaces();
          const workspace = workspaces.find((entry) => entry.id === scope.workspaceId);
          if (!workspace) throw new Error("资料所属工作区已不存在");
          name = `${workspace.name} · 工作区资料`; readOnly = Boolean(workspace.archived || workspace.effectiveArchived);
        }
        if (cancelled) return;
        if (editor.current?.dirty) await editor.current.save();
        if (cancelled) return;
        const next = { key: String(++nextKey.current), scope, name, readOnly, spaceId, collectionId, itemId };
        current.current = next;
        setDestination(next);
        setError("");
        if (desktop) {
          setPreferredOwner(scope);
          if (nav) {
            requestOwner(scope);
            useAppStore.setState((state) => state.libraryNav === nav ? { libraryNav: null } : state);
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "资料加载失败");
      }
    })();
    return () => { cancelled = true; };
  }, [desktop, nav, requestedOwner, requestedOwnerKey, setPreferredOwner]);

  const activeKey = libraryOwnerKey(destination?.scope ?? requestedOwner);
  const choices = [
    ...projects.map((project) => ({ scope: { type: "project" as const, projectId: project.id }, label: project.name })),
    ...spaces.map((space) => ({ scope: { type: "workspace" as const, workspaceId: space.id }, label: space.name })),
  ];
  const scopePicker = <label className="notes-desktop-scope">
    <span>笔记范围</span>
    <select aria-label="笔记范围" value={activeKey} onChange={(event) => {
      const key = event.target.value;
      const next = key === "personal" ? personal : choices.find((choice) => libraryOwnerKey(choice.scope) === key)?.scope;
      if (!next) return;
      const apply = (): void => {
        if (nav) useAppStore.setState((state) => state.libraryNav === nav ? { libraryNav: null } : state);
        requestOwner(next);
      };
      if (navigate) void navigate(apply);
      else apply();
    }}>
      <option value="personal">我的笔记</option>
      {activeKey !== "personal" && !choices.some((choice) => libraryOwnerKey(choice.scope) === activeKey)
        && <option value={activeKey}>{destination?.name ?? "上次使用的笔记范围"}</option>}
      {(["project", "workspace"] as const).map((type) => {
        const items = choices.filter((choice) => choice.scope.type === type);
        return items.length > 0 && <optgroup key={type} label={type === "project" ? "项目" : "工作空间"}>
          {items.map((choice) => <option key={libraryOwnerKey(choice.scope)} value={libraryOwnerKey(choice.scope)}>{choice.label}</option>)}
        </optgroup>;
      })}
    </select>
  </label>;
  const opening = <>
    {desktop && <DesktopSectionSidebar title="笔记">{scopePicker}</DesktopSectionSidebar>}
    {!error && <div className="library-empty" role="status">正在打开笔记…</div>}
  </>;
  const Manager = desktop ? LibraryWorkbench : ScopedLibraryManager;

  return <div className="library-page library-page--scoped library-page--notes">
    {error && <div className="note-status" role="alert">{error}</div>}
    {destination ? <Suspense fallback={opening}>
      <Manager key={destination.key} scope={destination.scope} name={destination.name} readOnly={destination.readOnly}
        initialSpaceId={destination.spaceId} initialCollectionId={destination.collectionId} initialItemId={destination.itemId}
        onRegisterUnsaved={registerEditor} desktop={desktop ? { scopePicker } : undefined} />
    </Suspense> : opening}
  </div>;
}
