import { useEffect, useState } from "react";
import type { LibraryOwnerScope } from "@shared/library-ipc";
import { libraryOwnerOf } from "@/lib/scopedLibrary";
import { useAppStore } from "@/store/appStore";
import ScopedLibraryManager from "./ScopedLibraryManager";
import "@/styles/library.css";

interface Destination {
  key: string;
  scope: LibraryOwnerScope;
  name: string;
  readOnly: boolean;
  spaceId?: string;
  collectionId?: string | null;
  itemId?: string;
}

/** Legacy deep links land in their owner's manager. There is no cross-owner overview here. */
export default function LibraryPage(): React.JSX.Element {
  const nav = useAppStore((state) => state.libraryNav);
  const key = JSON.stringify(nav);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!window.api?.library) throw new Error("资料服务不可用");
        if (!nav || (nav.view !== "item" && nav.view !== "space")) throw new Error("长期资料请从项目或工作空间的「资料」页打开");
        const snapshot = await window.api.library.snapshot();
        const item = nav?.view === "item" ? snapshot.items.find((entry) => entry.id === nav.itemId) : undefined;
        if (nav?.view === "item" && !item) throw new Error("这份资料已不存在");
        const spaceId = nav?.view === "space" ? nav.spaceId : item?.spaceId;
        const space = snapshot.spaces.find((entry) => entry.id === spaceId);
        if (spaceId && !space) throw new Error("资料位置已不存在");
        const scope = space ? libraryOwnerOf(space) : { type: "personal" as const };
        // 兼容旧个人资料深链，但不恢复单独的个人资料管理入口与写入能力。
        let name = "历史资料（只读）";
        let readOnly = scope.type === "personal";
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
        if (!cancelled) {
          setDestination({ key, scope, name, readOnly, spaceId,
            collectionId: nav?.view === "space" ? nav.folderId : item?.collectionId, itemId: item?.id });
          setError(null);
        }
      } catch (cause) { if (!cancelled) setError({ key, text: cause instanceof Error ? cause.message : "资料加载失败" }); }
    })();
    return () => { cancelled = true; };
  }, [key]);
  if (error?.key === key) return <div className="library-empty" role="alert">{error.text}</div>;
  if (!destination || destination.key !== key) return <div className="library-empty">正在打开所属资料…</div>;
  return <div className="library-page library-page--scoped"><ScopedLibraryManager key={key} scope={destination.scope} name={destination.name}
    readOnly={destination.readOnly} initialSpaceId={destination.spaceId} initialCollectionId={destination.collectionId} initialItemId={destination.itemId} /></div>;
}
