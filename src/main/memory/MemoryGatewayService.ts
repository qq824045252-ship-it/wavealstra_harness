import type { AppDatabase } from "../db/AppDatabase";
import {
  MEMORY_KINDS,
  MEMORY_SCOPE_TYPES,
  MEMORY_STATUSES,
  type MemoryCreateRequest,
  type MemoryKind,
  type MemoryRecordDto,
  type MemoryScopeType,
  type MemorySearchHit,
  type MemoryStatus,
} from "../../shared/memory-kernel";
import type { MemoryService } from "./MemoryService";
import type { MemoryGatewayAccessPrincipal } from "./MemoryGatewayAccessControl";

export interface MemoryGatewayContextInput {
  taskId?: string;
  projectId?: string;
  workspaceId?: string;
  includeInherited?: boolean;
}

export interface MemoryGatewaySearchInput extends MemoryGatewayContextInput {
  query?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  scopeTypes?: MemoryScopeType[];
  limit?: number;
}

export interface MemoryGatewayContextRequest extends MemoryGatewaySearchInput {
  budgetChars?: number;
}

export interface MemoryGatewayCreateInput extends MemoryGatewayContextInput {
  kind: MemoryKind;
  title: string;
  content?: string;
  importance?: number;
  confidence?: number;
  scopeType?: MemoryScopeType;
  scopeId?: string;
  metadata?: Record<string, unknown>;
  sourceRef?: string;
  sourceTitle?: string;
  sourceExcerpt?: string;
}

export interface MemoryGatewayUpdateInput extends MemoryGatewayContextInput {
  id: string;
  kind?: MemoryKind;
  title?: string;
  content?: string;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  validFrom?: number | null;
  validUntil?: number | null;
  metadata?: Record<string, unknown>;
  changeReason?: string;
}

export interface MemoryGatewayIdInput extends MemoryGatewayContextInput {
  id: string;
}

export interface MemoryGatewayPromoteInput extends MemoryGatewayIdInput {
  targetScopeType: MemoryScopeType;
  targetScopeId?: string;
}

export interface MemoryGatewayResolvedContext {
  taskId?: string;
  projectId?: string;
  workspaceId?: string;
  includeInherited: boolean;
}

export class MemoryGatewayError extends Error {
  constructor(
    public readonly code: "invalid_request" | "invalid_context" | "not_found" | "forbidden_scope" | "access_denied" | "memory_disabled" | "write_disabled",
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "MemoryGatewayError";
  }
}

const GLOBAL_DIRECT_WRITE_KINDS = new Set<MemoryKind>(["identity", "preference", "constraint", "procedure"]);

function cleanId(value: string | null | undefined, max = 200): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (id.length > max) throw new MemoryGatewayError("invalid_request", `identifier exceeds ${max} characters`, 400);
  return id;
}

function assertKnownKind(kind: MemoryKind): void {
  if (!MEMORY_KINDS.includes(kind)) throw new MemoryGatewayError("invalid_request", `unknown memory kind: ${String(kind)}`, 400);
}

function assertKnownScope(scope: MemoryScopeType): void {
  if (!MEMORY_SCOPE_TYPES.includes(scope)) throw new MemoryGatewayError("invalid_request", `unknown memory scope: ${String(scope)}`, 400);
}

function assertKnownStatus(status: MemoryStatus): void {
  if (!MEMORY_STATUSES.includes(status)) throw new MemoryGatewayError("invalid_request", `unknown memory status: ${String(status)}`, 400);
}

/**
 * Stable external-memory boundary shared by HTTP and MCP.
 *
 * Invariants:
 * - MemoryService / L1 MemoryRecord remains the only durable truth.
 * - taskId is authoritative; callers cannot override its Project/Workspace.
 * - all guessed-id reads/writes are visibility checked before touching the record.
 * - writes are globally gated and attributed to sourceType=tool/sourceId=memory-gateway.
 */
export class MemoryGatewayService {
  constructor(
    private readonly db: AppDatabase,
    private readonly memory: MemoryService,
    private readonly options: { writeEnabled?: boolean; isWriteEnabled?: () => boolean; isMemoryEnabled?: () => boolean; accessPrincipal?: MemoryGatewayAccessPrincipal } = {},
  ) {}

  get writeEnabled(): boolean {
    const masterWrite = this.options.isWriteEnabled ? this.options.isWriteEnabled() : this.options.writeEnabled === true;
    if (!masterWrite) return false;
    const principal = this.options.accessPrincipal;
    return !principal || principal.kind === "owner" || principal.mode === "read-write";
  }

  get isOwnerAccess(): boolean {
    const principal = this.options.accessPrincipal;
    return !principal || principal.kind === "owner";
  }

  get hasFullDataAccess(): boolean {
    const principal = this.options.accessPrincipal;
    return !principal || principal.kind === "owner" || principal.scopeType === "all";
  }

  withAccess(accessPrincipal: MemoryGatewayAccessPrincipal): MemoryGatewayService {
    return new MemoryGatewayService(this.db, this.memory, { ...this.options, accessPrincipal });
  }

  get memoryEnabled(): boolean {
    return this.options.isMemoryEnabled?.() !== false;
  }

  resolveContext(input: MemoryGatewayContextInput = {}): MemoryGatewayResolvedContext {
    this.requireMemoryEnabled();
    const taskId = cleanId(input.taskId);
    const suppliedProjectId = cleanId(input.projectId);
    const suppliedWorkspaceId = cleanId(input.workspaceId);

    if (taskId) {
      const task = this.db.getTask(taskId);
      if (!task) throw new MemoryGatewayError("not_found", `task not found: ${taskId}`, 404);
      const projectId = task.projectId ?? undefined;
      const workspaceId = task.spaceId ?? undefined;
      if (suppliedProjectId && suppliedProjectId !== projectId) {
        throw new MemoryGatewayError("invalid_context", "projectId does not match authoritative task context", 400);
      }
      if (suppliedWorkspaceId && suppliedWorkspaceId !== workspaceId) {
        throw new MemoryGatewayError("invalid_context", "workspaceId does not match authoritative task context", 400);
      }
      const resolved = { taskId, projectId, workspaceId, includeInherited: input.includeInherited !== false };
      this.assertAccessContext(resolved);
      return resolved;
    }

    if (suppliedProjectId) {
      const exists = this.db.connection.prepare("SELECT 1 FROM projects WHERE id=?").get(suppliedProjectId);
      if (!exists) throw new MemoryGatewayError("not_found", `project not found: ${suppliedProjectId}`, 404);
    }
    if (suppliedWorkspaceId && !this.db.getSpace(suppliedWorkspaceId)) {
      throw new MemoryGatewayError("not_found", `workspace not found: ${suppliedWorkspaceId}`, 404);
    }
    const resolved = {
      projectId: suppliedProjectId,
      workspaceId: suppliedWorkspaceId,
      includeInherited: input.includeInherited !== false,
    };
    this.assertAccessContext(resolved);
    return resolved;
  }

  async search(input: MemoryGatewaySearchInput): Promise<MemorySearchHit[]> {
    const context = this.resolveContext(input);
    for (const kind of input.kinds ?? []) assertKnownKind(kind);
    for (const status of input.statuses ?? []) assertKnownStatus(status);
    for (const scope of input.scopeTypes ?? []) assertKnownScope(scope);
    const requestedLimit = Math.max(1, Math.min(100, input.limit ?? 20));
    const scopeTypes = this.restrictReadScopeTypes(input.scopeTypes);
    const hits = await this.memory.searchHybrid({
      ...context,
      query: input.query?.trim(),
      kinds: input.kinds,
      statuses: input.statuses?.length ? input.statuses : ["active"],
      scopeTypes,
      limit: this.hasFullDataAccess ? requestedLimit : 100,
    });
    return hits
      .filter((hit) => this.memoryReadableByPrincipal(hit.memory))
      .slice(0, requestedLimit)
      .map((hit) => ({ ...hit, memory: this.externalizeMemory(hit.memory) }));
  }

  resolveMemoryContext(input: MemoryGatewayContextRequest) {
    const context = this.resolveContext(input);
    for (const kind of input.kinds ?? []) assertKnownKind(kind);
    for (const status of input.statuses ?? []) assertKnownStatus(status);
    for (const scope of input.scopeTypes ?? []) assertKnownScope(scope);
    const scopeTypes = this.restrictReadScopeTypes(input.scopeTypes);
    if (this.hasFullDataAccess) {
      return this.memory.resolveContext({
        ...context,
        query: input.query?.trim(),
        kinds: input.kinds,
        statuses: input.statuses?.length ? input.statuses : ["active"],
        scopeTypes,
        limit: Math.max(1, Math.min(100, input.limit ?? 20)),
        budgetChars: input.budgetChars,
        trackRecall: false,
      });
    }
    const budget = Math.max(800, Math.min(9000, input.budgetChars ?? 5000));
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const hits = this.memory.search({
      ...context,
      query: input.query?.trim(),
      kinds: input.kinds,
      statuses: input.statuses?.length ? input.statuses : ["active"],
      scopeTypes,
      limit: 100,
    }).filter((hit) => this.memoryReadableByPrincipal(hit.memory));
    const items: Array<{ id: string; kind: MemoryKind; title: string; content: string; scopeType: MemoryScopeType; scopeId?: string; importance: number; confidence: number; score: number; reasons: string[] }> = [];
    let chars = 0;
    let trimmed = false;
    for (const hit of hits.slice(0, limit)) {
      const scope = hit.memory.scopes.find((candidate) => this.scopeReadableByPrincipal(candidate.scopeType, candidate.scopeId));
      if (!scope) continue;
      const line = `- [${hit.memory.kind}][${scope.scopeType}] ${hit.memory.title}${hit.memory.content ? ` — ${hit.memory.content.slice(0, 700)}` : ""}`;
      if (chars + line.length > budget) { trimmed = true; continue; }
      chars += line.length + 1;
      items.push({ id: hit.memory.id, kind: hit.memory.kind, title: hit.memory.title, content: hit.memory.content, scopeType: scope.scopeType, scopeId: scope.scopeId, importance: hit.memory.importance, confidence: hit.memory.confidence, score: hit.score, reasons: hit.reasons });
    }
    return {
      items,
      text: items.length ? ["## Relevant Memory", "Delegated external access exposes only L1 atoms inside this grant's durable scope.", ...items.map((item) => `- [${item.kind}][${item.scopeType}] ${item.title}${item.content ? ` — ${item.content.slice(0, 700)}` : ""}`)].join("\n") : "",
      query: input.query?.trim() ?? "",
      budgetChars: budget,
      includedChars: chars,
      trimmed,
      scenarioIds: [],
      profileIds: [],
    };
  }

  get(input: MemoryGatewayIdInput): MemoryRecordDto {
    const context = this.resolveContext(input);
    return this.externalizeMemory(this.requireVisible(cleanId(input.id, 120) ?? "", context));
  }

  history(input: MemoryGatewayIdInput) {
    const context = this.resolveContext(input);
    const memory = this.requireVisible(cleanId(input.id, 120) ?? "", context);
    const revisions = this.memory.history(memory.id);
    if (this.isOwnerAccess) return revisions;
    const readableScopes = memory.scopes.filter((scope) => this.scopeReadableByPrincipal(scope.scopeType, scope.scopeId));
    const accessSince = this.options.accessPrincipal?.accessSince;
    if (!Number.isFinite(accessSince) || readableScopes.length === 0) return [];
    const visibleSince = Math.min(...readableScopes.map((scope) => (
      scope.binding === "promoted" ? Math.max(accessSince!, scope.createdAt) : accessSince!
    )));
    // Neither grant creation nor promotion synthesizes a revision. Strictly-after prevents a
    // same-millisecond pre-access revision from leaking through delegated history.
    return revisions.filter((revision) => revision.createdAt > visibleSince);
  }

  stats() {
    this.requireMemoryEnabled();
    if (!this.isOwnerAccess) throw new MemoryGatewayError("access_denied", "delegated grants cannot read owner-level Memory statistics", 403);
    return this.memory.stats();
  }

  create(input: MemoryGatewayCreateInput): MemoryRecordDto {
    this.requireMemoryEnabled();
    this.requireWrite();
    assertKnownKind(input.kind);
    const context = this.resolveContext(input);
    const scope = this.resolveCreateScope(input, context);
    const sourceRef = cleanId(input.sourceRef, 500) ?? "memory-gateway";
    const request: MemoryCreateRequest = {
      kind: input.kind,
      title: input.title,
      content: input.content,
      importance: input.importance,
      confidence: input.confidence,
      explicit: false,
      sourceType: "tool",
      sourceId: this.externalSourceId(),
      sourceTaskId: context.taskId,
      metadata: {
        ...(input.metadata ?? {}),
        memoryGatewayVersion: 1,
        externalAccessId: this.options.accessPrincipal?.id ?? "owner",
        externalAccessName: this.options.accessPrincipal?.name ?? "owner",
      },
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      evidence: [{
        evidenceKind: "external",
        refId: sourceRef,
        refTitle: input.sourceTitle,
        excerpt: input.sourceExcerpt,
      }],
    };
    return this.externalizeMemory(this.memory.create(request));
  }

  update(input: MemoryGatewayUpdateInput): MemoryRecordDto {
    this.requireMemoryEnabled();
    this.requireWrite();
    const context = this.resolveContext(input);
    const id = cleanId(input.id, 120) ?? "";
    const current = this.requireVisible(id, context);
    this.assertWritableMemory(current);
    if (input.kind !== undefined) assertKnownKind(input.kind);
    if (input.status !== undefined) assertKnownStatus(input.status);
    const principal = this.options.accessPrincipal;
    const actorId = principal?.id ?? "owner";
    const actorName = principal?.name ?? "owner";
    const metadata = {
      ...current.metadata,
      ...(input.metadata ?? {}),
      memoryGatewayVersion: 1,
      externalAccessId: current.metadata.externalAccessId,
      externalAccessName: current.metadata.externalAccessName,
      externalLastAccessId: actorId,
      externalLastAccessName: actorName,
    };
    const requestedReason = input.changeReason?.trim();
    return this.externalizeMemory(this.memory.update({
      id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      status: input.status,
      importance: input.importance,
      confidence: input.confidence,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      metadata,
      changedBy: "tool",
      changeReason: `${this.externalSourceId()}: ${requestedReason || "external update"}`,
    }));
  }

  forget(input: MemoryGatewayIdInput): { id: string; forgotten: true } {
    this.requireMemoryEnabled();
    this.requireWrite();
    const context = this.resolveContext(input);
    const id = cleanId(input.id, 120) ?? "";
    const current = this.requireVisible(id, context);
    this.assertWritableMemory(current);
    this.memory.forget(id);
    return { id, forgotten: true };
  }

  promote(input: MemoryGatewayPromoteInput): MemoryRecordDto {
    this.requireMemoryEnabled();
    this.requireWrite();
    const context = this.resolveContext(input);
    if (!context.taskId) {
      throw new MemoryGatewayError("forbidden_scope", "memory promotion requires an authoritative taskId context", 403);
    }
    const id = cleanId(input.id, 120) ?? "";
    const memory = this.requireVisible(id, context);
    this.assertWritableMemory(memory);
    assertKnownScope(input.targetScopeType);
    const targetScopeId = cleanId(input.targetScopeId);
    this.assertWritableScope(input.targetScopeType, targetScopeId);
    if (!this.memory.canPromoteFromTask(context.taskId, input.targetScopeType, targetScopeId)) {
      throw new MemoryGatewayError("forbidden_scope", "target scope is outside the authoritative task context", 403);
    }
    if (input.targetScopeType === "global" && !GLOBAL_DIRECT_WRITE_KINDS.has(memory.kind)) {
      throw new MemoryGatewayError("forbidden_scope", `${memory.kind} memories cannot be promoted to global`, 403);
    }
    return this.externalizeMemory(this.memory.promote(id, input.targetScopeType, targetScopeId));
  }

  private resolveCreateScope(
    input: MemoryGatewayCreateInput,
    context: MemoryGatewayResolvedContext,
  ): { scopeType: MemoryScopeType; scopeId?: string } {
    if (context.taskId) {
      const principal = this.options.accessPrincipal;
      const inferred = principal?.kind === "grant" && principal.scopeType !== "all"
        ? (principal.scopeType === "project"
            ? { scopeType: "project" as const, scopeId: context.projectId }
            : principal.scopeType === "workspace"
              ? { scopeType: "workspace" as const, scopeId: context.workspaceId }
              : principal.scopeType === "task"
                ? { scopeType: "task" as const, scopeId: context.taskId }
                : this.memory.inferAgentScope(context.taskId))
        : this.memory.inferAgentScope(context.taskId);
      if (!input.scopeType) {
        this.assertWritableScope(inferred.scopeType, inferred.scopeId);
        return inferred;
      }
      assertKnownScope(input.scopeType);
      const suppliedScopeId = cleanId(input.scopeId);
      const targetId = input.scopeType === "global" ? undefined : suppliedScopeId ?? (
        input.scopeType === "project" ? context.projectId :
        input.scopeType === "workspace" ? context.workspaceId : context.taskId
      );
      if (inferred.scopeType !== input.scopeType || inferred.scopeId !== targetId) {
        throw new MemoryGatewayError("forbidden_scope", "cross-scope create is not allowed; create in the authorized default scope then promote explicitly", 403);
      }
      this.assertWritableScope(input.scopeType, targetId);
      return { scopeType: input.scopeType, scopeId: targetId };
    }

    if (!input.scopeType) {
      throw new MemoryGatewayError("invalid_request", "scopeType is required when taskId is not provided", 400);
    }
    assertKnownScope(input.scopeType);
    const suppliedScopeId = cleanId(input.scopeId);

    if (input.scopeType === "global") {
      if (suppliedScopeId) throw new MemoryGatewayError("invalid_request", "global scope cannot include scopeId", 400);
      if (!GLOBAL_DIRECT_WRITE_KINDS.has(input.kind)) {
        throw new MemoryGatewayError("forbidden_scope", `${input.kind} memories cannot be created directly in global scope`, 403);
      }
      this.assertWritableScope("global", undefined);
      return { scopeType: "global" };
    }

    if (input.scopeType === "task") {
      throw new MemoryGatewayError("forbidden_scope", "task-scoped writes require taskId context", 403);
    }
    if (input.scopeType === "project") {
      const target = suppliedScopeId ?? context.projectId;
      if (!target || target !== context.projectId) {
        throw new MemoryGatewayError("forbidden_scope", "project-scoped write must match projectId context", 403);
      }
      this.assertWritableScope("project", target);
      return { scopeType: "project", scopeId: target };
    }
    const target = suppliedScopeId ?? context.workspaceId;
    if (!target || target !== context.workspaceId) {
      throw new MemoryGatewayError("forbidden_scope", "workspace-scoped write must match workspaceId context", 403);
    }
    this.assertWritableScope("workspace", target);
    return { scopeType: "workspace", scopeId: target };
  }

  private scopeWritableByPrincipal(scopeType: MemoryScopeType, scopeId?: string): boolean {
    const principal = this.options.accessPrincipal;
    if (!principal || principal.kind === "owner" || principal.scopeType === "all") return true;
    if (principal.scopeType === "global") return scopeType === "global";
    if (principal.scopeType === "project") return scopeType === "project" && scopeId === principal.scopeId;
    if (principal.scopeType === "task") return scopeType === "task" && scopeId === principal.scopeId;
    if (scopeType !== "workspace" || !scopeId || !principal.scopeId) return false;
    if (scopeId === principal.scopeId) return true;
    return this.db.getSpaceAncestors(scopeId).some((space) => space.id === principal.scopeId && !space.effectiveArchived);
  }

  private assertWritableScope(scopeType: MemoryScopeType, scopeId?: string): void {
    if (!this.scopeWritableByPrincipal(scopeType, scopeId)) {
      throw new MemoryGatewayError("access_denied", "external Memory grant cannot write outside its delegated scope", 403);
    }
  }

  private assertWritableMemory(memory: MemoryRecordDto): void {
    if (!memory.scopes.length || memory.scopes.some((scope) => !this.scopeWritableByPrincipal(scope.scopeType, scope.scopeId))) {
      throw new MemoryGatewayError("access_denied", "MemoryRecord is visible through inheritance but is not writable by this delegated grant", 403);
    }
  }

  private assertAccessContext(context: MemoryGatewayResolvedContext): void {
    const principal = this.options.accessPrincipal;
    if (!principal || principal.kind === "owner" || principal.scopeType === "all") return;
    const deny = () => { throw new MemoryGatewayError("access_denied", "external Memory grant does not allow the requested context", 403); };
    if (principal.scopeType === "global") {
      if (context.taskId || context.projectId || context.workspaceId) deny();
      return;
    }
    if (principal.scopeType === "task") {
      if (!context.taskId || context.taskId !== principal.scopeId) deny();
      return;
    }
    if (principal.scopeType === "project") {
      if (context.projectId !== principal.scopeId) deny();
      if (!context.taskId && context.workspaceId) deny();
      return;
    }
    if (!context.taskId && context.projectId) deny();
    const workspaceId = context.workspaceId;
    const grantWorkspaceId = principal.scopeId;
    if (!workspaceId || !grantWorkspaceId) return deny();
    if (workspaceId === grantWorkspaceId) return;
    const inherited = this.db.getSpaceAncestors(workspaceId).some((space) => space.id === grantWorkspaceId && !space.effectiveArchived);
    if (!inherited) deny();
  }

  private externalSourceId(): string {
    const principal = this.options.accessPrincipal;
    return principal ? `memory-gateway:${principal.id}` : "memory-gateway:owner";
  }

  private requireVisible(id: string, context: MemoryGatewayResolvedContext): MemoryRecordDto {
    if (!id || !this.memory.canAccess(id, context)) {
      // Deliberately collapse missing and out-of-scope ids to avoid existence probing.
      throw new MemoryGatewayError("not_found", "memory not found in the requested context", 404);
    }
    const memory = this.memory.getForRecall(id, context);
    if (!memory || !this.memoryReadableByPrincipal(memory)) {
      throw new MemoryGatewayError("not_found", "memory not found in the requested context", 404);
    }
    return memory;
  }

  private restrictReadScopeTypes(requested?: MemoryScopeType[]): MemoryScopeType[] | undefined {
    const principal = this.options.accessPrincipal;
    if (!principal || principal.kind === "owner" || principal.scopeType === "all") return requested;
    const allowed: MemoryScopeType = principal.scopeType === "global" ? "global" : principal.scopeType;
    if (requested?.some((scope) => scope !== allowed)) {
      throw new MemoryGatewayError("access_denied", "requested Memory scope type exceeds the delegated grant", 403);
    }
    return [allowed];
  }

  private scopeReadableByPrincipal(scopeType: MemoryScopeType, scopeId?: string): boolean {
    const principal = this.options.accessPrincipal;
    if (!principal || principal.kind === "owner" || principal.scopeType === "all") return true;
    if (principal.scopeType === "global") return scopeType === "global";
    if (principal.scopeType === "project") return scopeType === "project" && scopeId === principal.scopeId;
    if (principal.scopeType === "task") return scopeType === "task" && scopeId === principal.scopeId;
    if (scopeType !== "workspace" || !scopeId || !principal.scopeId) return false;
    if (scopeId === principal.scopeId) return true;
    return this.db.getSpaceAncestors(scopeId).some((space) => space.id === principal.scopeId && !space.effectiveArchived);
  }

  private memoryReadableByPrincipal(memory: MemoryRecordDto): boolean {
    return memory.scopes.some((scope) => this.scopeReadableByPrincipal(scope.scopeType, scope.scopeId));
  }

  private externalizeMemory(memory: MemoryRecordDto): MemoryRecordDto {
    if (this.hasFullDataAccess) return memory;
    return {
      ...memory,
      // Provenance may originate in a context that predates or lies outside the delegated scope.
      // The L1 body is intentionally shared; its original evidence graph is not implicitly shared with it.
      sourceId: undefined,
      sourceTaskId: undefined,
      metadata: {},
      scopes: memory.scopes.filter((scope) => this.scopeReadableByPrincipal(scope.scopeType, scope.scopeId)),
      evidence: [],
      relations: [],
    };
  }

  private requireMemoryEnabled(): void {
    if (!this.memoryEnabled) {
      throw new MemoryGatewayError("memory_disabled", "MyBuddy Memory is disabled in application settings", 403);
    }
  }

  private requireWrite(): void {
    if (!this.writeEnabled) throw new MemoryGatewayError("write_disabled", "Memory Gateway is read-only; external writes are disabled", 403);
  }
}
