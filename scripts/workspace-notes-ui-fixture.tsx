/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import WorkspaceNotesSection from "../src/renderer/src/components/workspace/WorkspaceNotesSection";
import WorkspaceLibraryBindingsSection from "../src/renderer/src/components/workspace/WorkspaceLibraryBindingsSection";
import "../src/renderer/src/styles/global.css";
let note = { workspaceId: "vps", content: "", revision: 0, updatedAt: 0 };
const view: any = { workspaceId: "vps", workspaceName: "VPS管理", direct: [], inherited: [],
  addable: [{ targetType: "space", librarySpaceId: "personal", name: "我的文档", path: "资料库 / 我的文档", kind: "personal" }],
  destinations: [{ id: "personal", name: "我的文档" }], libraryStoragePath: "C:/Users/test/.mybuddy/library" };
const test: any = { note: () => note, failSave: false, navigation: null, bound: null };
(window as any).noteTest = test;
(window as any).api = { workspace: {
  notes: { read: async () => ({ ...note }), save: async (req: any) => {
    if (test.failSave) { test.failSave = false; throw new Error("模拟保存失败"); }
    note = { workspaceId: req.workspaceId, content: req.content, revision: note.revision + 1, updatedAt: Date.now() }; return { ...note };
  } },
  libraryBindings: { list: async () => structuredClone(view), bind: async (req: any) => { test.bound = req; view.direct = [view.addable[0]]; view.addable = []; return { ok: true }; },
    unbind: async () => { view.addable = view.direct; view.direct = []; return { ok: true }; },
    createFolder: async (req: any) => { test.created = req; view.direct.push({ targetType: "collection", librarySpaceId: req.librarySpaceId, collectionId: "folder", name: req.name, path: `资料库 / 我的文档 / ${req.name}`, kind: "personal" }); return { ok: true }; },
  },
} };
function Fixture() {
  const [tab, setTab] = useState("notes");
  return <div style={{ maxWidth: 1020, margin: "32px auto" }}><h1>VPS管理</h1><nav><button className="btn" onClick={() => setTab("notes")}>便签</button><button className="btn" onClick={() => setTab("library")}>资料库</button></nav>
    {tab === "notes" ? <WorkspaceNotesSection workspaceId="vps" /> : <WorkspaceLibraryBindingsSection currentSpaceId="vps" />}</div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
