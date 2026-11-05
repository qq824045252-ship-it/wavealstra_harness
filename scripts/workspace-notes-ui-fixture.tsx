/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import ProjectNotes from "../src/renderer/src/components/pages/project/ProjectNotes";
import WorkspaceNotesSection from "../src/renderer/src/components/workspace/WorkspaceNotesSection";
import WorkspaceLibraryBindingsSection from "../src/renderer/src/components/workspace/WorkspaceLibraryBindingsSection";
import { state } from "./workspace-notes-ui-store";
import "../src/renderer/src/styles/global.css";
let note = { workspaceId: "vps", content: "", revision: 0, updatedAt: 0 };
const ownSpace = { id: "vps-materials", name: "VPS管理资料", kind: "team", workspaceId: "vps", createdAt: 1, updatedAt: 1 };
const otherSpace = { id: "other-materials", name: "隔离空间资料", kind: "team", workspaceId: "other", createdAt: 1, updatedAt: 1 };
const personalSpace = { id: "personal", name: "个人资料", kind: "personal", createdAt: 1, updatedAt: 1 };
const personalItem = { id: "shared-guide", spaceId: "personal", collectionId: null, kind: "markdown", title: "公共维护说明", filename: "公共维护说明.md", mimeType: "text/markdown", sizeBytes: 20, owner: "测试用户", favorite: false, createdAt: 1, updatedAt: 1, lastVisitedAt: null };
const library: any = { spaces: [personalSpace, ownSpace, otherSpace], collections: [], items: [personalItem], recent: [], artifacts: [], storage: { usedBytes: 20 }, ownerName: "测试用户" };
const legacyReference = { targetType: "space", librarySpaceId: "personal", name: "个人资料", path: "个人资料", kind: "personal" };
const view: any = { workspaceId: "vps", workspaceName: "VPS管理", owned: [{ targetType: "space", librarySpaceId: ownSpace.id, name: ownSpace.name, kind: "team", workspaceId: "vps" }], ownedItemCount: 0, direct: [legacyReference], inherited: [],
  addable: [legacyReference],
  destinations: [{ id: ownSpace.id, name: ownSpace.name }] };
const views: any = { vps: view, other: { workspaceId: "other", workspaceName: "隔离空间", owned: [{ targetType: "space", librarySpaceId: otherSpace.id, name: otherSpace.name, kind: "team", workspaceId: "other" }], ownedItemCount: 0, direct: [], inherited: [], addable: [], destinations: [{ id: otherSpace.id, name: otherSpace.name }] } };
const test: any = { note: () => note, failSave: false, navigation: null, bound: null, changeEvents: [], views };
let deferredBind: Promise<void> | null = null;
test.deferNextBind = () => {
  test.bindPending = false; test.bindCompleted = false;
  deferredBind = new Promise<void>((resolve) => { test.finishBind = resolve; });
};
(window as any).noteTest = test;
(window as any).api = { workspace: {
  notes: { read: async () => ({ ...note }), save: async (req: any) => {
    if (test.failSave) { test.failSave = false; throw new Error("模拟保存失败"); }
    note = { workspaceId: req.workspaceId, content: req.content, revision: note.revision + 1, updatedAt: Date.now() }; return { ...note };
  } },
  libraryBindings: { list: async (workspaceId: string) => structuredClone(views[workspaceId]), bind: async (req: any) => {
    test.bound = req;
    const waiting = deferredBind; deferredBind = null;
    if (waiting) { test.bindPending = true; await waiting; }
    const source = views[req.workspaceId]; source.direct = [source.addable[0]]; source.addable = [];
    test.bindPending = false; test.bindCompleted = true;
    return { ok: true };
  },
    unbind: async (req: any) => { const source = views[req.workspaceId]; source.addable = source.direct; source.direct = []; return { ok: true }; },
    createFolder: async (req: any) => { test.created = req; view.direct.push({ targetType: "collection", librarySpaceId: req.librarySpaceId, collectionId: "folder", name: req.name, path: `资料库 / 我的文档 / ${req.name}`, kind: "personal" }); return { ok: true }; },
  },
} };
test.library = library;
(window as any).api.db = { listTasks: async () => [], listSpaces: async () => structuredClone(state.spaces) };
(window as any).api.library = {
  snapshot: async () => structuredClone(library),
  ensureOwnedSpace: async (owner: any) => ({ ok: true, value: owner.workspaceId === "other" ? otherSpace : ownSpace }),
  getItem: async (id: string) => library.items.find((item: any) => item.id === id) ?? null,
  readContent: async (id: string) => ({ ok: true, value: { item: library.items.find((item: any) => item.id === id), content: "# 公共维护说明\n\n引用保留原文，只在此阅读。" } }),
  markVisited: async (id: string) => ({ ok: true, value: library.items.find((item: any) => item.id === id) }),
  search: async () => [],
  createCollection: async (req: any) => {
    test.created = req;
    const folder = { id: "owned-folder", spaceId: req.spaceId, parentId: req.parentId ?? null, name: req.name, owner: "测试用户", createdAt: 1, updatedAt: 1 };
    library.collections.push(folder);
    return { ok: true, value: folder };
  },
  listTaskReferences: async () => ({ ok: true, value: { taskId: "", items: [] } }),
};
const projectNotes: Record<string, { projectId: string; content: string; revision: number; updatedAt: number }> = {};
test.projectNotes = projectNotes;
(window as any).api.projectNotes = {
  read: async (projectId: string) => ({ ...(projectNotes[projectId] ?? { projectId, content: "", revision: 0, updatedAt: 0 }) }),
  save: async (req: any) => {
    if (req.expectedRevision !== (projectNotes[req.projectId]?.revision ?? 0)) throw new Error("便签已被任务更新，请重新读取后合并草稿");
    return projectNotes[req.projectId] = { projectId: req.projectId, content: req.content, revision: req.expectedRevision + 1, updatedAt: Date.now() };
  },
};
function Fixture() {
  const [tab, setTab] = useState("notes");
  const [archived, setArchived] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("vps");
  test.switchWorkspace = setWorkspaceId;
  return <div style={{ maxWidth: 1020, margin: "32px auto" }}><h1>VPS管理</h1><nav><button className="btn" onClick={() => setTab("notes")}>便签</button><button className="btn" onClick={() => setTab("library")}>资料</button><button className="btn" onClick={() => setTab("project-a")}>项目 A</button><button className="btn" onClick={() => setTab("project-b")}>项目 B</button><button className="btn" onClick={() => setArchived(!archived)}>切换归档</button></nav>
    {tab.startsWith("project-") ? <ProjectNotes key={tab} projectId={tab} archived={archived} /> : tab === "notes" ? <WorkspaceNotesSection workspaceId="vps" /> : <WorkspaceLibraryBindingsSection currentSpaceId={workspaceId} onChanged={() => test.changeEvents.push(workspaceId)} />}</div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
