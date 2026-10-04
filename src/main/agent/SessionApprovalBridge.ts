import type { AgentUiPatch, PermissionMode } from "../../shared/agent-ipc";
import type { ExternalWriteApprovalRequest, ExternalWriteDecision } from "../../shared/external-write";
import { AppDatabase } from "../db/AppDatabase";
import { TaskFileAccessPolicy } from "../security/TaskFileAccessPolicy";
import type { PendingActionRegistry } from "./PendingActionRegistry";
import type { SessionRegistry } from "./SessionRegistry";

export interface ApprovalLifecycleEvent {
  kind: "action_required";
  taskId: string;
  assistantMessageId: string;
  toolCallId: string;
  summary: string;
  detail?: string;
}

export interface SessionToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  summary: string;
  detail?: string;
  dangerous: boolean;
}

export interface SessionApprovalBinding {
  sessionPolicy: TaskFileAccessPolicy;
  getPermissionMode: () => PermissionMode;
  requestExternalWriteApproval: (request: ExternalWriteApprovalRequest) => Promise<ExternalWriteDecision>;
  requestApproval: (request: SessionToolApprovalRequest) => Promise<boolean>;
}

export interface SessionApprovalBridgeDependencies {
  db: AppDatabase;
  registry: SessionRegistry;
  pendingActions: PendingActionRegistry;
  emitPatch: (patch: AgentUiPatch) => void;
  emitLifecycle: (event: ApprovalLifecycleEvent) => void;
}

/**
 * Owns the live approval bridge used by main Agent sessions.
 * It keeps TaskFileAccessPolicy instances synchronized with persistent grants and centralizes
 * tool/external-write approval emission without owning the UI or Session lifecycle itself.
 */
export class SessionApprovalBridge {
  private readonly livePolicies = new Map<string, Set<TaskFileAccessPolicy>>();

  constructor(private readonly deps: SessionApprovalBridgeDependencies) {}

  create(taskId: string, taskRoot: string, fallbackPermission: PermissionMode, isolatedSourceRoots: string[] = []): SessionApprovalBinding {
    const sessionPolicy = new TaskFileAccessPolicy({
      taskId,
      taskRoot,
      isolatedSourceRoots,
      writeGrants: this.deps.db.listTaskWriteGrants(taskId).map((grant) => ({
        path: grant.path,
        source: "user-approval",
        createdAt: grant.createdAt,
      })),
    });
    let policies = this.livePolicies.get(taskId);
    if (!policies) {
      policies = new Set();
      this.livePolicies.set(taskId, policies);
    }
    policies.add(sessionPolicy);

    const getPermissionMode = (): PermissionMode =>
      this.deps.registry.get(taskId)?.permissionMode ?? fallbackPermission;

    const requestExternalWriteApproval = async (
      request: ExternalWriteApprovalRequest,
    ): Promise<ExternalWriteDecision> => {
      const entry = this.deps.registry.get(taskId);
      const messageId = entry?.assistantMessageId;
      if (!entry || !messageId) return { kind: "deny" };
      if (entry.permissionMode === "auto") return { kind: "allow-once" };
      if (entry.permissionMode === "readonly") return { kind: "deny" };

      this.deps.emitPatch({
        type: "tool_start",
        taskId,
        messageId,
        toolCallId: request.toolCallId,
        tool: request.toolName,
        summary: request.summary,
        detail: request.detail,
        dangerous: true,
        status: "pending_approval",
        approvalKind: "external-write",
        targetPath: request.targetPath,
        taskRoot: request.taskRoot,
        canonicalDir: request.canonicalDir,
      });
      this.deps.emitLifecycle({
        kind: "action_required",
        taskId,
        assistantMessageId: messageId,
        toolCallId: request.toolCallId,
        summary: request.summary,
        detail: request.detail ?? request.targetPath,
      });
      this.deps.pendingActions.register({
        taskId,
        assistantMessageId: messageId,
        toolCallId: request.toolCallId,
        tool: request.toolName,
        summary: request.summary,
        detail: request.detail,
        dangerous: true,
        approvalKind: "external-write",
        createdAt: Date.now(),
        externalWrite: {
          targetPath: request.targetPath,
          taskRoot: request.taskRoot,
          canonicalDir: request.canonicalDir,
        },
      });
      return await new Promise<ExternalWriteDecision>((resolve) => {
        entry.pendingExternalWrites.set(request.toolCallId, resolve);
      });
    };

    const requestApproval = async (request: SessionToolApprovalRequest): Promise<boolean> => {
      const entry = this.deps.registry.get(taskId);
      const messageId = entry?.assistantMessageId;
      if (!entry || !messageId) return false;
      if (entry.permissionMode === "auto") return true;
      if (entry.grantedExternalWriteToolCalls.has(request.toolCallId)) return true;

      this.deps.emitPatch({
        type: "tool_start",
        taskId,
        messageId,
        toolCallId: request.toolCallId,
        tool: request.toolName,
        summary: request.summary,
        detail: request.detail,
        dangerous: request.dangerous,
        status: "pending_approval",
      });
      this.deps.emitLifecycle({
        kind: "action_required",
        taskId,
        assistantMessageId: messageId,
        toolCallId: request.toolCallId,
        summary: request.summary,
        detail: request.detail,
      });
      this.deps.pendingActions.register({
        taskId,
        assistantMessageId: messageId,
        toolCallId: request.toolCallId,
        tool: request.toolName,
        summary: request.summary,
        detail: request.detail,
        dangerous: request.dangerous,
        approvalKind: "tool",
        createdAt: Date.now(),
      });
      return await new Promise<boolean>((resolve) => {
        entry.pendingApprovals.set(request.toolCallId, resolve);
      });
    };

    return {
      sessionPolicy,
      getPermissionMode,
      requestExternalWriteApproval,
      requestApproval,
    };
  }

  addWriteGrant(taskId: string, path: string): void {
    for (const policy of this.livePolicies.get(taskId) ?? []) {
      policy.addWriteGrant({ path, source: "user-approval" });
    }
  }

  removeWriteGrant(taskId: string, path: string): void {
    for (const policy of this.livePolicies.get(taskId) ?? []) policy.removeWriteGrant(path);
  }

  release(taskId: string): void {
    this.livePolicies.delete(taskId);
  }
}