import TaskRecoveryNotice from "../src/renderer/src/components/chat/TaskRecoveryNotice";
import React from "react";
import { state } from "./project-materials-store-stub";
state.spaces = [{ id: "folder-a", name: "研发文件", path: "C:/projects/a" }];
state.tasks = [{ id: "task-a", title: "编写说明", projectId: "a" }, { id: "task-empty", title: "尚未执行", projectId: "a" }, { id: "task-b", title: "其他项目任务", projectId: "b" }];
import { createRoot } from "react-dom/client";
import NewProjectTaskModal from "../src/renderer/src/components/pages/project/NewProjectTaskModal";
import ProjectMaterials from "../src/renderer/src/components/pages/project/ProjectMaterials";
import "../src/renderer/src/styles/global.css";

const now = Date.now();
const projects: any = {
  a: { id: "a", name: "产品研发", updatedAt: now, resourceBudgetChars: 12000, resources: [{ id: "r1", projectId: "a", kind: "text", title: "写作规范", value: "文档使用中文，说明验证范围。", enabled: true, sortOrder: 0, updatedAt: now }] },
  b: { id: "b", name: "设备维护", updatedAt: now, resourceBudgetChars: 12000, resources: [] },
};
const snap: any = { spaces: [{ id: "b-space", projectId: "b", kind: "team", name: "设备资料" }, { id: "personal", kind: "personal", name: "个人" }],
  collections: [], items: [{ id: "b-item", spaceId: "b-space", title: "设备检查单", kind: "markdown", filename: "check.md", sizeBytes: 20, updatedAt: now },
    { id: "personal-item", spaceId: "personal", title: "个人私有资料", kind: "markdown", filename: "private.md", sizeBytes: 20, updatedAt: now }],
  recent: [], artifacts: [
    { id: "artifact-a", taskId: "task-a", title: "项目阶段报告", kind: "markdown", owner: "我", location: "task-a", updatedAt: now },
    { id: "artifact-b", taskId: "task-b", title: "其他项目秘密成果", kind: "markdown", owner: "我", location: "task-b", updatedAt: now },
  ], storage: { usedBytes: 0 }, ownerName: "我" };
const documentBody = "# 项目说明\n\n这是当前项目的长期文档。\n\n- 文件按项目归属\n- 检索按实际需要使用";
const bodies = new Map<string, string>();
const calls: any[] = [];
const pins: any[] = [];
let delayed: Promise<any> | undefined;
let release: (() => void) | undefined;
let failImport = false;
let failSave = false;
let failRelocation = false;
let failPin = false;
let failDocumentSave = false;
(window as any).api = {
  agent: { listRuntimeContextSnapshots: async (taskId: string) => taskId !== "task-a" ? [] : [{ taskId, projectId: "a", executionId: "run-a", startedAt: now, status: "completed", workingDirectory: "C:/actual/run-a", materialUsage: { omitted: 1, items: [
    { toolCallId: "read-file", toolName: "read", at: now, kind: "file-content", title: "requirements.md", target: "requirements.md", returnedChars: 120, images: 0, partial: true, offset: 2, limit: 5, outputHash: "f".repeat(64) },
    { toolCallId: "search", toolName: "project_knowledge_search", at: now, kind: "search-snippet", title: "技术规范", target: "doc-1", returnedChars: 30, images: 0, partial: true, outputHash: "a".repeat(64) },
    { toolCallId: "metadata", toolName: "project_knowledge_read", at: now, kind: "metadata", title: "设计图.pdf", target: "doc-2", returnedChars: 80, images: 0, partial: true, outputHash: "b".repeat(64) }
  ] }, warnings: ["附件因预算限制未注入"], resolvedInstructions: [{ id: "projectResources", source: "project", title: "补充参考正文", chars: 12, content: "实际注入的写作规范", storage: "full" }] }, { taskId, projectId: "b", executionId: "wrong", startedAt: now, status: "completed", resolvedInstructions: [] }] },
  pickLocalFolder: async () => ({ path: "C:/moved/a", name: "a" }),
  db: {
    listTasks: async () => structuredClone(state.tasks),
    previewProjectFolder: async (projectId: string, path: string) => { calls.push(["previewFolder", projectId]); return { token: "preview-token", projectId, spaceId: "folder-a", oldPath: "C:/projects/a", newPath: path, affectedProjects: [{ id: projectId, name: "产品研发", updatedAt: 1, archived: false }, { id: "shared", name: "共享设计", updatedAt: 1, archived: false }], folders: [{ id: "folder-a", name: "研发文件", oldPath: "C:/projects/a", newPath: path, identity: "1:1" }, { id: "nested", name: "子目录", oldPath: "C:/projects/a/nested", newPath: `${path}/nested`, identity: "1:2" }], artifacts: [{ id: "result", title: "项目报告", rootDir: path, fileCount: 2, missingOriginal: true }], tasks: [{ id: "task-a", title: "编写说明" }], references: [] }; },
    commitProjectFolder: async (token: string) => { if (failRelocation) { failRelocation = false; throw new Error("模拟目录提交失败，绑定未修改"); } calls.push(["commitFolder", token]); state.spaces[0].path = "C:/moved/a"; return { ok: true }; },
    listProjectPins: async (projectId: string) => structuredClone(pins.filter(p => p.projectId === projectId)),
    pinProjectItem: async (request: any) => { if (failPin) { failPin = false; throw new Error("模拟常用资料保存失败"); } calls.push(["pin", request]); const item = snap.items.find((i: any) => i.id === request.itemId); const pin = { id: `pin-${item.id}`, projectId: request.projectId, itemId: item.id, itemTitle: item.title }; pins.push(pin); return pin; },
    unpinProjectItem: async (request: any) => { if (failPin) { failPin = false; throw new Error("模拟常用资料保存失败"); } calls.push(["unpin", request]); const index = pins.findIndex(p => p.projectId === request.projectId && p.itemId === request.itemId); if (index >= 0) pins.splice(index, 1); return { ok: true }; },
    updateProject: async (request: any) => { if (failSave) { failSave = false; return { ok: false, error: "模拟项目说明保存失败" }; } calls.push(["updateProject", request]); if ("defaultSpaceId" in request) projects[request.id].defaultSpaceId = request.defaultSpaceId ?? undefined;
    for (const key of ["goal", "currentStage", "instructions"]) if (key in request) projects[request.id][key] = request[key] ?? undefined; return { ok: true, project: projects[request.id] }; }, inspectProjectResources: async (id: string) => ({ projectId: id, items: projects[id].resources.map((r: any) => ({ resourceId: r.id, status: r.kind === "folder" ? "ready" : (r.enabled ? "ready" : "disabled"), included: r.kind !== "folder" && r.enabled, chars: r.kind !== "folder" && r.enabled ? r.value.length : 0, bytes: 38 })), includedChars: projects[id].resources.filter((r: any) => r.kind !== "folder" && r.enabled).reduce((sum: number, r: any) => sum + r.value.length, 0), budgetChars: projects[id].resourceBudgetChars, checkedAt: now }) },
  library: {
    snapshot: async () => { const waiting = delayed; delayed = undefined; return waiting ?? structuredClone(snap); },
    ensureOwnedSpace: async (owner: any) => {
      calls.push(["ensure", owner]);
      const existing = snap.spaces.find((space: any) => owner.type === "project" && space.projectId === owner.projectId);
      if (existing) return { ok: true, value: existing };
      const space = { id: `${owner.projectId}-space`, projectId: owner.projectId, kind: "team", name: projects[owner.projectId].name };
      calls.push(["create", { projectId: owner.projectId, name: space.name }]); snap.spaces.push(space); return { ok: true, value: space };
    },
    pickAndImport: async (request: any) => {
      calls.push(["import", request]);
      if (failImport) { failImport = false; return { ok: false, error: "模拟导入失败" }; }
      const item = { id: `imported-${snap.items.length}`, spaceId: request.spaceId, collectionId: request.collectionId ?? null, title: "项目说明", kind: "markdown", filename: "readme.md", sizeBytes: 120, updatedAt: now };
      snap.items.push(item); return { ok: true, value: [item] };
    },
    createItem: async (request: any) => { calls.push(["createItem", request]); const item = { ...request, id: `created-${snap.items.length}`, collectionId: request.collectionId ?? null, filename: `${request.title}.md`, sizeBytes: 20, updatedAt: now, owner: "我", favorite: false }; snap.items.push(item); bodies.set(item.id, request.kind === "markdown" ? `# ${item.title}` : ""); return { ok: true, value: item }; },
    createCollection: async (request: any) => { const folder = { id: `collection-${snap.collections.length}`, spaceId: request.spaceId, parentId: request.parentId ?? null, name: request.name, owner: "我", updatedAt: now }; calls.push(["createCollection", request]); snap.collections.push(folder); return { ok: true, value: folder }; },
    renameCollection: async (request: any) => { calls.push(["renameCollection", request]); const folder = snap.collections.find((entry: any) => entry.id === request.id); folder.name = request.name; return { ok: true, value: folder }; },
    moveCollection: async (request: any) => { calls.push(["moveCollection", request]); const folder = snap.collections.find((entry: any) => entry.id === request.id); folder.parentId = request.parentId; return { ok: true, value: folder }; },
    deleteCollection: async (id: string) => { calls.push(["deleteCollection", id]); const ids = new Set([id]); for (let size = -1; size !== ids.size;) { size = ids.size; for (const folder of snap.collections) if (ids.has(folder.parentId)) ids.add(folder.id); } snap.collections = snap.collections.filter((entry: any) => !ids.has(entry.id)); snap.items = snap.items.filter((entry: any) => !ids.has(entry.collectionId)); return { ok: true }; },
    updateItem: async (request: any) => { calls.push(["updateItem", request]); const item = snap.items.find((entry: any) => entry.id === request.id); Object.assign(item, request, { updatedAt: Date.now() }); return { ok: true, value: structuredClone(item) }; },
    writeContent: async (request: any) => { if (failDocumentSave) { failDocumentSave = false; return { ok: false, error: "模拟正文保存失败" }; } calls.push(["writeContent", request]); bodies.set(request.id, request.content); const item = snap.items.find((entry: any) => entry.id === request.id); item.updatedAt = Date.now(); return { ok: true, value: structuredClone(item) }; },
    deleteItem: async (id: string) => { calls.push(["deleteItem", id]); snap.items = snap.items.filter((entry: any) => entry.id !== id); const index = pins.findIndex((pin: any) => pin.itemId === id); if (index >= 0) pins.splice(index, 1); return { ok: true }; },
    favorite: async (request: any) => { const item = snap.items.find((entry: any) => entry.id === request.id); item.favorite = request.favorite; return { ok: true, value: structuredClone(item) }; },
    saveArtifact: async (request: any) => { calls.push(["saveArtifact", request]); const artifact = snap.artifacts.find((entry: any) => entry.id === request.artifactId); const item = { id: `saved-${artifact.id}`, spaceId: request.spaceId, collectionId: request.collectionId ?? null, title: artifact.title, kind: "markdown", filename: `${artifact.title}.md`, sizeBytes: 30, updatedAt: now }; snap.items.push(item); return { ok: true, value: item }; },
    search: async (request: any) => { calls.push(["search", request]); return snap.items.filter((item: any) => item.title.includes(request.query)).map((item: any) => ({ ...item, source: "library", location: "资料" })); },
    markVisited: async (id: string) => ({ ok: true, value: snap.items.find((entry: any) => entry.id === id) }),
    readContent: async (id: string) => { calls.push(["read", id]); return { ok: true, value: { item: structuredClone(snap.items.find((i: any) => i.id === id)), content: bodies.get(id) ?? documentBody } }; },
    showInFolder: async () => ({ ok: true }),
  },
};
const root = createRoot(document.getElementById("root")!);
function render(id: string) {
  root.render(<div className="project-desk"><div className="project-desk-main" style={{ width: "100%", padding: 24 }}>
    <header className="project-desk-crumb">项目 / {projects[id].name} / 资料</header>
    <ProjectMaterials key={id} project={projects[id]} onRegisterUnsaved={(guard) => { (window as any).materialTest.guard = guard; }} onRefresh={async () => { render(id); }} />
  </div></div>);
}
(window as any).materialTest = { calls, switchProject: render,
  showRecovery(taskId: string, resolved = false) {
    (window as any).api.db.listExecutionFailures = async () => [{ id: "failure-1", taskId, message: "工作文件夹不可用：C:/old", nextAction: "重新关联后重试", causeCode: "workspace-path-missing", recovery: "requires-user-action", sideEffects: "none", phase: "prepare", createdAt: 1, resolvedAt: resolved ? 2 : undefined }];
    root.render(<TaskRecoveryNotice key={taskId} taskId={taskId} projectId="a" refreshKey={String(resolved)} />);
  },
  showTaskModal() { root.render(<NewProjectTaskModal key={Math.random()} open project={projects.a} onClose={() => {}} />); },
  deferNextSnapshot() { const captured = structuredClone(snap); delayed = new Promise((accept) => { release = () => accept(captured); }); },
  releaseSnapshot() { release?.(); },
  failNextRelocation() { failRelocation = true; },
  failNextSave() { failSave = true; },
  failNextPin() { failPin = true; },
  failNextDocumentSave() { failDocumentSave = true; },
  failImport() { failImport = true; },
  addPersonalPin() { pins.push({ id: "personal-pin", projectId: "a", itemId: "personal-item", itemTitle: "个人私有资料" }); },
  archiveProject(value: boolean) { projects.a.archived = value; render("a"); },
  documentBody,
  artifacts: snap.artifacts,
  addSecondSpace() { snap.spaces.push({ id: "a-second", kind: "team", projectId: "a", name: "历史资料" }); },
};
render("a");
