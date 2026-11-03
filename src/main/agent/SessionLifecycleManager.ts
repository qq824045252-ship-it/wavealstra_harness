import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { McpRuntimeService } from "../mcp/McpRuntimeService";
import type { UsageStatsService } from "../usage/UsageStatsService";
import type { PendingActionRegistry } from "./PendingActionRegistry";
import type { SessionApprovalBridge } from "./SessionApprovalBridge";
import type { SessionEntry, SessionRegistry } from "./SessionRegistry";

type McpExtensionsResult = Parameters<McpRuntimeService["attachSession"]>[1];

export interface SessionLifecycleManagerDependencies {
  registry: SessionRegistry;
  mcpRuntime: McpRuntimeService;
  pendingActions: PendingActionRegistry;
  approvals: SessionApprovalBridge;
  usageStats: UsageStatsService;
  userTurnCounters: Map<string, number>;
  clearPendingMemoryTurns: (taskId: string) => void;
  endComputerUse?: (taskId: string, executionId?: string) => void;
}

/**
 * Owns main-session lifecycle side effects around SessionRegistry.
 * Prompt routing still decides when a rebuild is needed; this manager guarantees detach/dispose/
 * approval cleanup/usage backfill happen together whenever a session is released or creation fails.
 */
export class SessionLifecycleManager {
  constructor(private readonly deps: SessionLifecycleManagerDependencies) {}

  release(taskId: string): void {
    this.deps.clearPendingMemoryTurns(taskId);
    const entry = this.deps.registry.get(taskId);
    this.deps.endComputerUse?.(taskId, entry?.executionId);
    const sessionFile = entry?.session.sessionFile ?? null;
    this.deps.mcpRuntime.detachSession(taskId);
    this.deps.registry.delete(taskId);
    this.deps.pendingActions.removeTask(taskId);
    if (sessionFile) this.deps.userTurnCounters.delete(sessionFile);
    else this.deps.userTurnCounters.delete(taskId);
    this.deps.approvals.release(taskId);
    if (sessionFile) {
      try {
        this.deps.usageStats.backfillSession(sessionFile);
      } catch (error) {
        console.warn(
          `[usage] backfillSession failed ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  releaseIfIdle(taskId: string): "missing" | "dirty" | "released" {
    const entry = this.deps.registry.get(taskId);
    if (!entry) return "missing";
    if (entry.session.isStreaming || entry.session.isIdle === false || entry.pendingAssistantTurns.length > 0) {
      entry.assemblyDirty = true;
      return "dirty";
    }
    this.release(taskId);
    return "released";
  }

  invalidateAll(): { dirty: string[]; released: string[] } {
    const dirty: string[] = [];
    const released: string[] = [];
    for (const entry of this.deps.registry.values()) {
      if (entry.session.isStreaming || entry.pendingAssistantTurns.length > 0) {
        entry.assemblyDirty = true;
        dirty.push(entry.taskId);
      } else {
        this.release(entry.taskId);
        released.push(entry.taskId);
      }
    }
    return { dirty, released };
  }

  attachExtensions(taskId: string, extensionsResult: McpExtensionsResult, enabledServers: string[] = [], codeMode?: Parameters<McpRuntimeService["attachSession"]>[3]): void {
    this.deps.mcpRuntime.attachSession(taskId, extensionsResult, enabledServers, codeMode);
  }

  cleanupFailedCreate(taskId: string, session?: Pick<AgentSession, "dispose"> | null): void {
    this.deps.mcpRuntime.detachSession(taskId);
    try {
      session?.dispose();
    } catch {
      // best effort: failed create must not mask the original error
    }
    this.deps.approvals.release(taskId);
  }

  commit(entry: SessionEntry): void {
    this.deps.registry.set(entry);
  }

  disposeAll(): void {
    for (const entry of this.deps.registry.values()) {
      this.deps.endComputerUse?.(entry.taskId, entry.executionId);
      this.deps.mcpRuntime.detachSession(entry.taskId);
      this.deps.pendingActions.removeTask(entry.taskId);
      this.deps.approvals.release(entry.taskId);
    }
    this.deps.registry.disposeAll();
  }
}