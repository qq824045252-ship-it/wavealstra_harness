import type { ResolvedProjectContext } from "../../shared/project-domain";
import { AppDatabase } from "../db/AppDatabase";
import { LibraryService } from "../library/LibraryService";
import { MemoryService } from "../memory/MemoryService";
import { ProjectContextResolver } from "../project/ProjectContextResolver";
import { WorkspaceResourceLocator } from "../workspace/WorkspaceResourceLocator";
import { WorkspaceSharedContextService } from "../workspace/WorkspaceSharedContextService";
import { WorkspaceNotesService } from "../workspace/WorkspaceNotesService";
import { assembleProjectContextSegments, mapBtwProjectContextSegments } from "./PromptAssembly";
import { isEvidenceSegment, type SupplementalEvidence } from "./EvidenceBudget";

export interface TaskLibraryWorkspaceContext {
  projectId: string | null;
  projectContext: ResolvedProjectContext | null;
  libraryCatalog: string | null;
  libraryAttachments: string | null;
  libraryAttachedItemIds: ReadonlySet<string>;
}

/**
 * Owns Library + Workspace context assembly for Agent sessions.
 * Search/read tools remain separate from injection: this service only builds bounded context capsules
 * and hands out the shared LibraryService to extensions that need the same source of truth.
 */
export interface LibraryWorkspaceContextDependencies {
  createLibraryService?: (db: AppDatabase) => LibraryService;
  workspaceSharedContext?: WorkspaceSharedContextService;
}

export class LibraryWorkspaceContextService {
  private libraryInst: LibraryService | null = null;
  private readonly createLibraryService: (db: AppDatabase) => LibraryService;
  private readonly workspaceSharedContext: WorkspaceSharedContextService;

  constructor(
    private readonly db: AppDatabase,
    _memory: MemoryService,
    private readonly projectContext: ProjectContextResolver,
    _memoryEnabled: () => boolean,
    dependencies: LibraryWorkspaceContextDependencies = {},
  ) {
    this.createLibraryService = dependencies.createLibraryService ?? ((sourceDb) => new LibraryService(sourceDb));
    this.workspaceSharedContext = dependencies.workspaceSharedContext ?? new WorkspaceSharedContextService(db);
  }

  library(): LibraryService {
    return (this.libraryInst ??= this.createLibraryService(this.db));
  }

  catalog(projectId?: string | null, toolsAvailable = true): string | null {
    try {
      return this.library().formatCatalog(36, { projectId: projectId ?? null, toolsAvailable });
    } catch {
      return null;
    }
  }

  attachments(taskId: string): string | null {
    try {
      return this.library().formatTaskAttachments(taskId);
    } catch {
      return null;
    }
  }

  attachedItemIds(taskId: string): ReadonlySet<string> {
    try {
      return new Set(this.library().listTaskReferences(taskId).items.map((item) => item.id));
    } catch {
      return new Set();
    }
  }

  resolveTask(
    taskId: string,
    toolsAvailable = true,
    projectContextOverride?: ResolvedProjectContext | null,
  ): TaskLibraryWorkspaceContext {
    const task = this.db.getTask(taskId);
    const projectId = task?.projectId ?? null;
    return {
      projectId,
      projectContext: projectContextOverride === undefined
        ? this.projectContext.resolveTask(taskId)
        : projectContextOverride,
      libraryCatalog: this.catalog(projectId, toolsAvailable),
      libraryAttachments: this.attachments(taskId),
      libraryAttachedItemIds: this.attachedItemIds(taskId),
    };
  }

  /** Fresh source facts; selection and all quotas are owned by Context Projection. */
  projectionSources(taskId: string, readOnly = false): SupplementalEvidence[] {
    const task = this.db.getTask(taskId);
    const projectId = task?.projectId ?? null;
    const project = this.projectContext.resolveTask(taskId);
    const library = this.library();
    const output: SupplementalEvidence[] = new WorkspaceNotesService(this.db).sources(taskId);
    const selectedItems = new Set<string>();
    const addItem = (itemId: string, origin: "attached" | "pinned" | "catalog") => {
      if (selectedItems.has(itemId)) return;
      const item = library.getItem(itemId);
      if (!item || !library.isItemVisibleToTask(item, projectId)) return;
      selectedItems.add(itemId);
      output.push({
        id: `library:${item.id}`, kind: "library", revision: String(item.updatedAt),
        text: `[${origin}] [${item.kind}] ${item.title} · id=${item.id}\n${readOnly
          ? "此条目是资料引用；本只读会话不提供资料库工具，需要正文时请告知用户或由主任务读取。"
          : "此条目是资料引用；需要正文时通过 library_read 读取。"}`,
        validate: () => {
          const current = library.getItem(item.id);
          if (!current || !library.isItemVisibleToTask(current, this.db.getTask(taskId)?.projectId)) throw new Error("本轮引用的资料已删除或不可见");
          if (origin === "attached" && !library.listTaskReferences(taskId).items.some((ref) => ref.id === item.id)) throw new Error("本轮引用的任务资料已取消附加");
          if (origin === "pinned" && projectId) this.projectContext.assertEvidenceAvailable(projectId, [], [item.id]);
        },
      });
    };
    for (const item of library.listTaskReferences(taskId).items) addItem(item.id, "attached");
    for (const pin of project?.sharedContext?.pinned ?? []) addItem(pin.itemId, "pinned");
    for (const segment of assembleProjectContextSegments(project, { excludePinnedItemIds: selectedItems, planReadOnly: readOnly, libraryReadable: !readOnly })) {
      if (!project || !isEvidenceSegment(segment.id) || segment.id === "projectPinnedRefs") continue;
      const resourceIds = segment.id === "projectResources" ? project.resources.map((resource) => resource.id) : [];
      output.push({
        id: `project:${project.project.id}:${segment.id}`, kind: "project", revision: project.version,
        text: segment.content,
        validate: () => this.projectContext.assertEvidenceAvailable(project.project.id, resourceIds),
      });
    }
    for (const item of library.listAllItems().filter((item) => item.kind !== "url" && library.isItemVisibleToTask(item, projectId)).slice(0, 36)) {
      addItem(item.id, "catalog");
    }
    return output;
  }

  promoteSharedContextItem(
    itemId: string,
    fromSpaceId: string,
  ): { ok: true; targetParentId: string; alreadyExisted: boolean } | { ok: false; error: string } {
    const result = this.workspaceSharedContext.promote(itemId, fromSpaceId);
    if (!result.ok) return result;
    return {
      ok: true,
      targetParentId: result.targetParentId,
      alreadyExisted: result.alreadyExisted,
    };
  }

  renderBtwProjectContextSegments(
    segments: ReadonlyArray<{ id: string; content: string }>,
    parentTaskId: string,
  ): string[] {
    const context = this.projectContext.resolveTask(parentTaskId);
    const projectId = this.db.getTask(parentTaskId)?.projectId ?? null;
    const catalog = projectId ? this.catalog(projectId, false) : null;
    const attachments = this.attachments(parentTaskId);
    // Evidence is supplied by the transient session's own request projection.
    return mapBtwProjectContextSegments(segments.filter((segment) => !isEvidenceSegment(segment.id)), context, { catalog, attachments });
  }

  resourceLocator(): WorkspaceResourceLocator {
    return new WorkspaceResourceLocator(this.db, this.library());
  }
}
