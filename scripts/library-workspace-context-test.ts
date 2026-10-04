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
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
import { emptyModePolicy, type ModeProfileDto } from "../src/shared/mode-profile";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-workspace-context-"));
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

  const first = context.resolveTask("task-context", true);
  assert.equal(context.library(), library, "extensions and context assembly must share one LibraryService truth source");
  assert.equal(first.projectId, "proj-a");
  assert(first.projectContext?.sharedContext?.goal?.includes("A goal"));
  assert(first.libraryCatalog?.includes("Attached A document"));
  assert(first.libraryAttachments?.includes("Attached A document"));
  assert(first.libraryAttachedItemIds.has(attached.id));

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
  const digest = context.memoryDigest("workspace-context", "task-context", "workspace context baseline");
  assert(digest?.includes("Workspace context baseline") || digest?.includes("workspace-context-marker"), "enabled memory resolves query-aware workspace capsule");
  memoryEnabled = false;
  assert.equal(context.memoryDigest("workspace-context", "task-context", "workspace context baseline"), null, "memory master switch prevents workspace memory injection");
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
  assert(!btw.some((part) => part.includes("STALE A") || part.includes("STALE WORKSPACE")), "BTW rebuild removes stale project/library/workspace assembly");
  assert(btw.some((part) => part.includes("B goal is current")), "BTW rebuild follows current project binding");
  assert(btw.some((part) => part.includes("B current catalog document")), "BTW rebuild recalculates current project Library catalog");
  assert(btw.some((part) => part.includes("Keep expert role")), "BTW rebuild preserves non-project context segments");

  const second = context.resolveTask("task-context", false);
  assert.equal(second.projectId, "proj-b");
  assert(second.libraryCatalog?.includes("B current catalog document"));
  assert(!second.libraryCatalog?.includes("library_search"), "toolsAvailable=false catalog never advertises unavailable Library tools");

  console.log("library workspace context: PASS");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}