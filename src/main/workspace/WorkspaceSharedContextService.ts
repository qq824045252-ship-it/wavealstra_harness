/**
 * Workspace Shared Context Runtime Integration.
 *
 * Runtime truth is the unified Memory Kernel: memory_records + memory_scopes.
 * Workspace promotion binds the SAME L1 MemoryRecord to the immediate parent with
 * binding=promoted; it never clones the memory body into a second persistence model.
 * Shared pure helpers support in-memory fixtures; runtime reads and writes go through MemoryService.
 */

import type { AppDatabase } from "../db/AppDatabase";
import { MemoryService } from "../memory/MemoryService";
import type { SpaceDto } from "../../shared/agent-ipc";
import {
  assembleWorkspaceSharedContext,
  buildChildManifests,
  buildWorkspaceSharedContextView,
  formatRelevantChildSection,
  formatWorkspaceSharedContextForPrompt,
  isWorkspaceContextSpaceValid,
  selectRelevantChildManifests,
  type WorkspaceChildManifest,
  type WorkspaceSharedContextItem,
  type AssembleWorkspaceSharedContextResult,
  type WorkspaceRelevantChildOptions,
  type WorkspaceSharedContextView,
} from "../../shared/workspace-shared-context";
import { buildSpaceEffectiveMap } from "../../shared/workspace-tree";

export interface WorkspaceAssembleInput {
  currentSpaceId: string | null;
  taskItems?: WorkspaceSharedContextItem[];
  taskId?: string;
  includeArchived?: boolean;
  excludeCurrentSpace?: boolean;
  /** Phase 5: query for query-aware child relevance (empty => no child). */
  query?: string;
  includeRelevantChildren?: boolean;
  relevantChildOptions?: import("../../shared/workspace-shared-context").WorkspaceRelevantChildOptions;
  budget?: { targetChars?: number; hardMaxChars?: number };
  /** Optional pre-fetched; if omitted, loads from DB */
  spaces?: SpaceDto[];
  itemsBySpace?: Map<string, WorkspaceSharedContextItem[]>;
}

export type WorkspacePromoteResult =
  | { ok: true; targetParentId: string; promotedItem: WorkspaceSharedContextItem; alreadyExisted: boolean }
  | { ok: false; error: string };

export class WorkspaceSharedContextService {
  private readonly memory: MemoryService;
  constructor(private readonly db: AppDatabase) {
    this.memory = new MemoryService(db);
  }

  /** Load all SpaceDto via DB (single source; effectiveArchived already computed on read) */
  listSpaces(): SpaceDto[] {
    return this.db.listSpaces();
  }

  /**
   * Load itemsBySpace from DB memories → WorkspaceSharedContextItem.
   * Uses deterministic ws-promoted id to restore promotedFrom provenance.
   * If spaces not provided, fetches via listSpaces().
   */
  loadItemsBySpace(spaces?: SpaceDto[]): Map<string, WorkspaceSharedContextItem[]> {
    const list = spaces ?? this.db.listSpaces();
    const map = new Map<string, WorkspaceSharedContextItem[]>();
    for (const space of list) {
      const records = this.memory.listExactScope("workspace", space.id, ["active"], 500);
      map.set(space.id, records.map((memory) => {
        const binding = memory.scopes.find((scope) => scope.scopeType === "workspace" && scope.scopeId === space.id);
        const origin = memory.scopes.find((scope) => scope.scopeType === "workspace" && scope.binding === "owned");
        return {
          id: memory.id, spaceId: space.id,
          content: memory.content ? `${memory.title} — ${memory.content}` : memory.title,
          createdAt: memory.createdAt, updatedAt: memory.updatedAt, kind: memory.kind,
          source: binding?.binding === "promoted" ? "promoted" : (memory.sourceType === "agent" ? "automatic" : "manual"),
          sourceTaskId: memory.sourceTaskId,
          promotedFrom: binding?.binding === "promoted" && origin?.scopeId ? { spaceId: origin.scopeId, itemId: memory.id } : undefined,
        } satisfies WorkspaceSharedContextItem;
      }));
    }
    return map;
  }

  /**
   * Load single space items (adapter for persistence verification)
   */
  listItemsForSpace(spaceId: string): WorkspaceSharedContextItem[] {
    return this.loadItemsBySpace([this.db.getSpace(spaceId)].filter((x): x is SpaceDto => Boolean(x))).get(spaceId) ?? [];
  }

  /**
   * Deterministic assembly reusing shared pure helper (no forked hierarchy).
   * Priority: Task(-1) > Current(0) > Parent(1) > Grandparent(2) > Root...
   * archived/effectiveArchived excluded unless includeArchived; cycle/missing safe.
   */
  assemble(input: WorkspaceAssembleInput): AssembleWorkspaceSharedContextResult {
    const spaces = input.spaces ?? this.db.listSpaces();
    const itemsBySpace = input.itemsBySpace ?? this.loadItemsBySpace(spaces);
    return assembleWorkspaceSharedContext({
      spaces,
      currentSpaceId: input.currentSpaceId,
      itemsBySpace,
      taskItems: input.taskItems ?? [],
      taskId: input.taskId,
      includeArchived: input.includeArchived ?? false,
      excludeCurrentSpace: input.excludeCurrentSpace ?? false,
      query: input.query,
      includeRelevantChildren: input.includeRelevantChildren,
      relevantChildOptions: input.relevantChildOptions,
      budget: input.budget,
    });
  }

  /** Digest for prompt injection (null if no blocks). Caller can inject as assembly segment. */
  getDigest(input: WorkspaceAssembleInput): string | null {
    const result = this.assemble(input);
    return formatWorkspaceSharedContextForPrompt(result);
  }

  /** Digest excluding current-space blocks (for Agent chain dedup with spaceMemory). */
  getDigestExcludingCurrent(input: Omit<WorkspaceAssembleInput, "excludeCurrentSpace">): string | null {
    return this.getDigest({ ...input, excludeCurrentSpace: true });
  }

  /**
   * Backward-compatible helper mirroring AgentService prior usage:
   * get digest for a given spaceId (currentSpace) with empty taskItems.
   * Keeps call sites minimal.
   */
  getDigestForSpace(currentSpaceId: string | null, taskItems?: WorkspaceSharedContextItem[]): string | null {
    return this.getDigest({ currentSpaceId, taskItems });
  }

  getDigestForSpaceExcludingCurrent(currentSpaceId: string | null, taskItems?: WorkspaceSharedContextItem[]): string | null {
    return this.getDigest({ currentSpaceId, taskItems, excludeCurrentSpace: true });
  }

  /**
   * Task-level context bridge backed by Memory Kernel task scope.
   * No second task-memory store: task items are first-class memory_records + memory_scopes.
   */
  loadTaskItems(taskId: string | null | undefined): WorkspaceSharedContextItem[] {
    if (!taskId) return [];
    const task = this.db.getTask(taskId);
    const records = this.memory.listExactScope("task", taskId, ["active"], 200);
    return records.map((memory) => ({
      id: memory.id, spaceId: task?.spaceId ?? `task:${taskId}`,
      content: memory.content ? `${memory.title} — ${memory.content}` : memory.title,
      createdAt: memory.createdAt, updatedAt: memory.updatedAt, kind: memory.kind,
      source: memory.sourceType === "agent" ? "automatic" : "manual", sourceTaskId: memory.sourceTaskId,
    }));
  }

  /**
   * Convenience: assemble for a task's resolved space with empty taskItems seam.
   * Resolves spaceId via db.getTask(taskId)?.spaceId when currentSpaceId not provided.
   */
  assembleForTask(taskId: string | null, explicitSpaceId?: string | null, taskItems?: WorkspaceSharedContextItem[], opts?: { excludeCurrentSpace?: boolean }): AssembleWorkspaceSharedContextResult {
    let spaceId: string | null = explicitSpaceId ?? null;
    if (spaceId == null && taskId) {
      try {
        const task = this.db.getTask(taskId) as { spaceId?: string | null } | undefined;
        spaceId = (task?.spaceId ?? null) as string | null;
      } catch {
        spaceId = null;
      }
    }
    return this.assemble({
      currentSpaceId: spaceId,
      taskItems: taskItems ?? this.loadTaskItems(taskId),
      taskId: taskId ?? undefined,
      excludeCurrentSpace: opts?.excludeCurrentSpace ?? false,
    });
  }

  getDigestForTask(taskId: string | null, explicitSpaceId?: string | null, taskItems?: WorkspaceSharedContextItem[]): string | null {
    const result = this.assembleForTask(taskId, explicitSpaceId, taskItems);
    return formatWorkspaceSharedContextForPrompt(result);
  }

  getDigestForTaskExcludingCurrent(taskId: string | null, explicitSpaceId?: string | null, taskItems?: WorkspaceSharedContextItem[]): string | null {
    const result = this.assembleForTask(taskId, explicitSpaceId, taskItems, { excludeCurrentSpace: true });
    return formatWorkspaceSharedContextForPrompt(result);
  }

  /**
   * Explicit promote: child item -> immediate parent (idempotent, no auto, no cross-level).
   * Validates immediate parent / archived / cycle / missing deterministically via pure helper.
   * Persists by adding a promoted MemoryScope to the SAME L1 MemoryRecord.
   * Only an owned local binding may be promoted; a promoted binding cannot be chained upward.
   * Repeated promote yields alreadyExisted=true and does not duplicate MemoryRecord or scope.
   */
  promote(itemId: string, fromSpaceId: string, opts?: { now?: number; includeArchived?: boolean }): WorkspacePromoteResult {
    const record = this.memory.get(itemId);
    if (!record) return { ok: false, error: `来源条目不存在：${itemId}` };
    const sourceBinding = record.scopes.find((scope) => scope.scopeType === "workspace" && scope.scopeId === fromSpaceId);
    if (!sourceBinding) return { ok: false, error: `记忆不属于来源空间：${fromSpaceId}` };
    if (sourceBinding.binding !== "owned") return { ok: false, error: "仅来源空间拥有的本地记忆可提升；已提升记忆不能继续逐级提升" };
    const can = this.canPromote(fromSpaceId, { includeArchived: opts?.includeArchived });
    if (!can.ok) return can;
    const alreadyExisted = record.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === can.parentId);
    if (!alreadyExisted) this.memory.promote(itemId, "workspace", can.parentId);
    const updated = this.memory.get(itemId)!;
    const origin = updated.scopes.find((scope) => scope.scopeType === "workspace" && scope.binding === "owned");
    const promotedItem: WorkspaceSharedContextItem = {
      id: updated.id, spaceId: can.parentId,
      content: updated.content ? `${updated.title} — ${updated.content}` : updated.title,
      createdAt: updated.createdAt, updatedAt: updated.updatedAt, kind: updated.kind, source: "promoted",
      sourceTaskId: updated.sourceTaskId,
      promotedFrom: origin?.scopeId ? { spaceId: origin.scopeId, itemId: updated.id } : { spaceId: fromSpaceId, itemId: updated.id },
    };
    return { ok: true, targetParentId: can.parentId, promotedItem, alreadyExisted };
  }

  /**
   * Structured view for renderer (no forked hierarchy, no raw DB upsert).
   * Main produces blocks/metadata; renderer only displays.
   */
  getView(input: { currentSpaceId: string | null; taskId?: string | null; memoryEnabled: boolean }): WorkspaceSharedContextView {
    const spaces = this.db.listSpaces();
    const itemsBySpace = this.loadItemsBySpace(spaces);
    // Resolve currentSpaceId via taskId when not provided (artifact→task→space authentic chain)
    let resolvedSpaceId = input.currentSpaceId;
    if (resolvedSpaceId == null && input.taskId) {
      try {
        const t = this.db.getTask(input.taskId) as { spaceId?: string | null } | undefined;
        resolvedSpaceId = (t?.spaceId ?? null) as string | null;
      } catch {
        resolvedSpaceId = null;
      }
    }
    const taskItems = this.loadTaskItems(input.taskId ?? null);
    const result = this.assemble({
      currentSpaceId: resolvedSpaceId,
      taskItems,
      taskId: input.taskId ?? undefined,
      spaces,
      itemsBySpace,
    });
    return buildWorkspaceSharedContextView({
      spaces,
      currentSpaceId: resolvedSpaceId,
      memoryEnabled: input.memoryEnabled,
      result,
      itemsBySpace,
    });
  }

  /** Phase 5: Build direct-child manifests (lightweight, direct children only). */
  getChildManifests(currentSpaceId: string | null, opts?: { includeArchived?: boolean }): WorkspaceChildManifest[] {
    if (currentSpaceId == null) return [];
    const spaces = this.db.listSpaces();
    const itemsBySpace = this.loadItemsBySpace(spaces);
    return buildChildManifests(currentSpaceId, spaces, itemsBySpace, { includeArchived: opts?.includeArchived ?? false });
  }

  /** Phase 5: Query-aware relevant child section (deterministic, empty query => null). */
  getRelevantChildSection(
    currentSpaceId: string | null,
    query: string | null | undefined,
    opts?: WorkspaceRelevantChildOptions & { includeArchived?: boolean },
  ): string | null {
    const q = (query ?? "").trim();
    if (!q || currentSpaceId == null) return null;
    const spaces = this.db.listSpaces();
    const itemsBySpace = this.loadItemsBySpace(spaces);
    const manifests = buildChildManifests(currentSpaceId, spaces, itemsBySpace, { includeArchived: opts?.includeArchived ?? false });
    const relevant = selectRelevantChildManifests(q, manifests, opts);
    if (relevant.length === 0) return null;
    return formatRelevantChildSection(relevant, itemsBySpace, { maxCharsPerChild: opts?.maxCharsPerChild });
  }

  /**
   * Advisory check without DB write: whether promotion would succeed.
   * Uses single source effective map (no forked hierarchy).
   */
  canPromote(fromSpaceId: string, opts?: { includeArchived?: boolean }): { ok: true; parentId: string } | { ok: false; error: string } {
    const spaces = this.db.listSpaces();
    const byId = new Map(spaces.map((s) => [s.id, s]));
    const origin = byId.get(fromSpaceId);
    if (!origin) return { ok: false, error: `来源空间不存在：${fromSpaceId}` };
    const parentId = origin.parentId ?? null;
    if (parentId == null) return { ok: false, error: `无父级` };
    if (!byId.has(parentId)) return { ok: false, error: `父级不存在：${parentId}` };
    const includeArchived = opts?.includeArchived ?? false;
    if (!includeArchived) {
      const effective = buildSpaceEffectiveMap(spaces);
      if (effective.get(fromSpaceId) ?? false) return { ok: false, error: `来源已归档：${fromSpaceId}` };
      if (effective.get(parentId) ?? false) return { ok: false, error: `父级已归档：${parentId}` };
    }
    // Additional guard via shared helper (effective filtered + missing)
    if (!isWorkspaceContextSpaceValid(parentId, spaces, { includeArchived })) {
      return { ok: false, error: `父级不可用：${parentId}` };
    }
    return { ok: true, parentId };
  }
}
