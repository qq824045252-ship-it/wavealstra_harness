import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectContextResolver } from "../src/main/project/ProjectContextResolver";
import { LibraryWorkspaceContextService } from "../src/main/agent/LibraryWorkspaceContextService";
import { ProjectNotesService } from "../src/main/project/ProjectNotesService";
import { WorkspaceNotesService } from "../src/main/workspace/WorkspaceNotesService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
import { emptyModePolicy, type ModeProfileDto } from "../src/shared/mode-profile";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-workspace-context-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const repository = new ProjectRepository(db.connection);
const projects = new ProjectService(repository, memory);
const resolver = new ProjectContextResolver(db, repository, memory);
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
let memoryEnabled = true;

const context = new LibraryWorkspaceContextService(
  db,
  memory,
  resolver,
  () => memoryEnabled,
  { createLibraryService: () => library },
);

const profile: ModeProfileDto = {
  id: "working",
  labelZh: "工作",
  icon: "briefcase",
  description: "",
  blocks: [],
  policy: emptyModePolicy(),
  hasUserOverride: false,
};

function insertProject(id: string, name: string): void {
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, name, 1, 1);
}

try {
  db.createSpace({ id: "workspace-parent", name: "Parent" });
  db.createSpace({ id: "workspace-context", name: "Context", parentId: "workspace-parent" });
  db.createSpace({ id: "workspace-sibling", name: "Sibling", parentId: "workspace-parent" });
  new WorkspaceNotesService(db).save({ workspaceId: "workspace-context", content: "# Manual workspace note", expectedRevision: 0 });
  insertProject("proj-a", "Project A");
  insertProject("proj-b", "Project B");
  projects.update({ id: "proj-a", goal: "A goal should disappear after rebind", currentStage: "A stage" });
  projects.update({ id: "proj-b", goal: "B goal is current", currentStage: "B stage" });

  const spaceA = library.createSpace({ name: "A library", projectId: "proj-a" });
  const spaceB = library.createSpace({ name: "B library", projectId: "proj-b" });
  const attached = library.createItem({ spaceId: spaceA.id, kind: "markdown", title: "Attached A document" });
  const pinnedOnly = library.createItem({ spaceId: spaceA.id, kind: "markdown", title: "Pinned A baseline" });
  const bDoc = library.createItem({ spaceId: spaceB.id, kind: "markdown", title: "B current catalog document" });
  library.writeContent({ id: attached.id, content: "attached evidence" });
  library.writeContent({ id: pinnedOnly.id, content: "pinned evidence" });
  library.writeContent({ id: bDoc.id, content: "current B evidence" });
  projects.pinProjectItem({ projectId: "proj-a", itemId: attached.id });
  projects.pinProjectItem({ projectId: "proj-a", itemId: pinnedOnly.id });

  db.upsertTask({
    id: "task-context",
    title: "Context task",
    updatedAt: 1,
    projectId: "proj-a",
    spaceId: "workspace-context",
    welcomeMode: "working",
  });
  library.attachToTask({ itemId: attached.id, taskId: "task-context" });
  const ownSpace = library.ensureOwnedSpace({ type: "workspace", workspaceId: "workspace-context" });
  const parentSpace = library.ensureOwnedSpace({ type: "workspace", workspaceId: "workspace-parent" });
  const siblingSpace = library.ensureOwnedSpace({ type: "workspace", workspaceId: "workspace-sibling" });
  const ownDoc = library.createItem({ spaceId: ownSpace.id, kind: "markdown", title: "Current workspace document" });
  const inheritedDoc = library.createItem({ spaceId: parentSpace.id, kind: "markdown", title: "Inherited parent document" });
  const siblingDoc = library.createItem({ spaceId: siblingSpace.id, kind: "markdown", title: "Hidden sibling document" });
  const unrelatedPersonal = library.createItem({ spaceId: "personal", kind: "markdown", title: "Unreferenced personal document" });
  const personalAttached = library.createItem({ spaceId: "personal", kind: "markdown", title: "Explicit personal attachment" });
  library.attachToTask({ itemId: personalAttached.id, taskId: "task-context" });
  assert(context.projectionSources("task-context").some(source => source.id === "workspace-note:workspace-context" && source.text.includes("Manual workspace note")), "saved notes enter actual task evidence projection");

  new ProjectNotesService(db).save({ projectId: "proj-a", content: "# Shared project note", expectedRevision: 0 });
  assert(context.projectionSources("task-context").some(source => source.id === "project-note:proj-a" && source.text.includes("Shared project note")));

  const first = context.resolveTask("task-context", true);
  assert.equal(context.library(), library, "extensions and context assembly must share one LibraryService truth source");
  assert.equal(first.projectId, "proj-a");
  assert(first.projectContext?.sharedContext?.goal?.includes("A goal"));
  assert(first.libraryCatalog?.includes("Attached A document"));
  assert(first.libraryAttachments?.includes("Attached A document"));
  assert(first.libraryAttachedItemIds.has(attached.id));
  assert(first.libraryCatalog?.includes(ownDoc.title) && first.libraryCatalog.includes(inheritedDoc.title), "catalog includes current and inherited workspace materials");
  assert(first.libraryCatalog?.includes(personalAttached.title), "catalog includes an explicit personal reference");
  assert(!first.libraryCatalog?.includes(siblingDoc.title) && !first.libraryCatalog?.includes(unrelatedPersonal.title), "catalog does not broaden references into sibling or personal libraries");
  const projectedIds = new Set(context.projectionSources("task-context").map((source) => source.id));
  assert(projectedIds.has(`library:${ownDoc.id}`) && projectedIds.has(`library:${inheritedDoc.id}`) && projectedIds.has(`library:${personalAttached.id}`));
  assert(!projectedIds.has(`library:${siblingDoc.id}`) && !projectedIds.has(`library:${unrelatedPersonal.id}`), "evidence projection uses the same scope as catalog/tools");
  const referenceFolder = library.createCollection({ spaceId: "personal", name: "Temporary reference" });
  const referenceDoc = library.createItem({ spaceId: "personal", collectionId: referenceFolder.id, kind: "markdown", title: "Revocable reference" });
  const bindings = new WorkspaceLibraryBindingService(db);
  bindings.bindCollection("workspace-context", "personal", referenceFolder.id);
  const source = context.projectionSources("task-context").find((entry) => entry.id === `library:${referenceDoc.id}`);
  assert(source, "bound folder contributes scoped evidence");
  source.validate();
  bindings.unbindCollection("workspace-context", referenceFolder.id);
  assert.throws(() => source.validate(), /不可见/, "pending evidence is revoked when its folder reference is removed");
  assert.throws(() => context.validateEvidenceAccess("task-context", source.access), /不可见/, "restored evidence revalidates the same live scope");

  const trace = assemblePrompt({
    welcomeMode: "working",
    profile,
    soul: { name: "Buddy", alias: "Buddy", persona: "" },
    projectContext: first.projectContext,
    permissionMode: "default",
    platform: process.platform,
    memoryEnabled: true,
    libraryCatalog: first.libraryCatalog,
    libraryAttachments: first.libraryAttachments,
    libraryAttachedItemIds: first.libraryAttachedItemIds,
  });
  const pinnedSegment = trace.segments.find((segment) => segment.id === "projectPinnedRefs");
  assert(pinnedSegment?.content.includes("Pinned A baseline"), "non-attached pinned reference remains in project context");
  assert(!pinnedSegment?.content.includes("Attached A document"), "task attachment is deduplicated from pinned references");
  assert(trace.segments.some((segment) => segment.id === "libraryAttachments" && segment.content.includes("Attached A document")));

  memory.create({
    kind: "fact",
    title: "Workspace context baseline",
    content: "workspace-context-marker",
    scopeType: "workspace",
    scopeId: "workspace-context",
    sourceType: "manual",
    explicit: true,
    confidence: 1,
    importance: 1,
  });
  // Memory 注入已收敛到 PromptAssembly 的 memoryRules 段（LibraryWorkspaceContextService 不再暴露
  // memoryDigest）。断言真实 seam：master switch 决定是否注入长期记忆规则段。
  const memoryOn = assemblePrompt({
    welcomeMode: "working",
    profile,
    soul: { name: "Buddy", alias: "Buddy", persona: "" },
    projectContext: first.projectContext,
    permissionMode: "default",
    platform: process.platform,
    memoryEnabled: true,
    libraryCatalog: first.libraryCatalog,
    libraryAttachments: first.libraryAttachments,
    libraryAttachedItemIds: first.libraryAttachedItemIds,
  });
  const memoryOnRules = memoryOn.segments.find((segment) => segment.id === "memoryRules");
  assert(memoryOnRules, "memoryEnabled=true 时注入 memoryRules 段");
  assert(memoryOnRules!.content.includes("内置长期记忆"), "启用记忆时注入长期记忆规则");

  const memoryOff = assemblePrompt({
    welcomeMode: "working",
    profile,
    soul: { name: "Buddy", alias: "Buddy", persona: "" },
    projectContext: first.projectContext,
    permissionMode: "default",
    platform: process.platform,
    memoryEnabled: false,
    libraryCatalog: first.libraryCatalog,
    libraryAttachments: first.libraryAttachments,
    libraryAttachedItemIds: first.libraryAttachedItemIds,
  });
  const memoryOffRules = memoryOff.segments.find((segment) => segment.id === "memoryRules");
  assert(memoryOffRules, "memoryEnabled=false 时仍注入 memoryRules 段（用于显式禁止）");
  assert(memoryOffRules!.content.includes("长期记忆已关闭"), "记忆 master switch 关闭时明确禁止加载长期记忆");
  memoryEnabled = true;

  const oldSegments = [
    { id: "projectSharedContext", content: "STALE A SHARED" },
    { id: "projectPinnedRefs", content: "STALE A PINNED" },
    { id: "library", content: "STALE A CATALOG" },
    { id: "libraryAttachments", content: "STALE A ATTACHMENT" },
    { id: "workspace", content: "STALE WORKSPACE" },
    { id: "expert", content: "Keep expert role" },
  ];
  library.detachFromTask({ itemId: attached.id, taskId: "task-context" });
  db.upsertTask({
    id: "task-context",
    title: "Context task",
    updatedAt: 2,
    projectId: "proj-b",
    spaceId: "workspace-context",
    welcomeMode: "working",
  });
  const btw = context.renderBtwProjectContextSegments(oldSegments, "task-context");
  // 契约（现行）：evidence 段（projectSharedContext/projectPinnedRefs/projectResources/projectPlan/
  // library/libraryAttachments，见 EvidenceBudget.EVIDENCE_SEGMENTS）不再由 BTW 重渲染——它们由瞬态会话
  // 自己的请求投影提供（AgentService 将其转为 supplementalEvidence）。此处只保留并重算非 evidence 段，
  // 同时必须确保陈旧 evidence 不被残留。
  assert(!btw.some((part) => part.includes("STALE A") || part.includes("STALE WORKSPACE")), "BTW rebuild drops stale project/library/workspace evidence");
  assert(!btw.some((part) => part.includes("B goal is current")), "BTW 不重渲染 evidence（改由瞬态会话请求投影提供）");
  assert(!btw.some((part) => part.includes("B current catalog document")), "BTW 不重算 Library catalog（evidence 由请求投影提供）");
  assert(btw.some((part) => part.includes("Keep expert role")), "BTW rebuild preserves non-project context segments");

  const second = context.resolveTask("task-context", false);
  assert.equal(second.projectId, "proj-b");
  assert(second.libraryCatalog?.includes("B current catalog document"));
  assert(!second.libraryCatalog?.includes("library_search"), "toolsAvailable=false catalog never advertises unavailable Library tools");
  assert(!second.libraryAttachments?.includes(attached.title) && !second.libraryAttachedItemIds.has(attached.id), "project rebind does not leak stale attachment titles, paths or ids");
  assert(second.libraryAttachments?.includes(personalAttached.title), "explicit personal reference survives project rebind without copying");
  assert(!context.resolveTask("unknown-task").libraryCatalog?.includes(ownDoc.title), "unknown tasks do not gain fallback materials");

  console.log("library workspace context: PASS");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
