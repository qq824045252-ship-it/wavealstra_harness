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
 * Compatibility binding for existing sessions; never creates pending tool approvals.
 * Historical grant metadata is retained without controlling execution.
 */
export class SessionApprovalBridge {
  private readonly livePolicies = new Map<string, Set<TaskFileAccessPolicy>>();

  constructor(private readonly deps: SessionApprovalBridgeDependencies) {}

  create(taskId: string, taskRoot: string, _fallbackPermission: PermissionMode, isolatedSourceRoots: string[] = []): SessionApprovalBinding {
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

    // Old persisted permission modes and grant rows are historical data only.
    const getPermissionMode = (): PermissionMode => "auto";
    const requestExternalWriteApproval = async (_request: ExternalWriteApprovalRequest): Promise<ExternalWriteDecision> => ({ kind: "allow-once" });
    const requestApproval = async (_request: SessionToolApprovalRequest): Promise<boolean> => true;

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