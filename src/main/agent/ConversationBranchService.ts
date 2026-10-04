/**
 * ConversationBranchService — 对话分支主进程编排（实施规划 §6/§10）。
 *
 * 责任：校验（§6.2 顺序）→ 工作区准备（§8）→ session 物化（§7）→
 * DB 单事务 commit（§10.1）→ usage 水位（§7.4）→ 轻量继承 → 返回 DTO。
 * 领域定位/物化逻辑在 session-branch.ts；目录快照在 TaskWorkspaceBrancher。
 *
 * 不变量：
 * - Renderer 不能指定 session 路径、cwd、Project policy 或 leaf entry id（§14.2）；
 * - requestId 幂等：相同 requestId 返回同一个 child（§5.4）；
 * - commit 前任何失败都只清理本 requestId 的临时产物（§10.2）；
 * - 创建分支不调用模型，无模型费用（§7.4）。
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppDatabase } from "../db/AppDatabase";
import type { TaskDto } from "../../shared/agent-ipc";
import type { ArtifactService } from "../artifact/ArtifactService";
import {
  ConversationBranchDomainError,
  createConversationBranchSession,
  resolveConversationBranchLeaf,
  writeConversationBranchUsageWatermark,
} from "./session-branch";
import { TaskWorkspaceBrancher } from "../task/TaskWorkspaceBrancher";
import type {
  ConversationBranchCreateOutcome,
  ConversationBranchErrorCode,
  ConversationBranchInfoDto,
  ConversationBranchPreviewDto,
  CreateConversationBranchRequest,
} from "../../shared/conversation-branch";

/** 主进程判定"任务空闲"，由 AgentService 窄接口提供（§11.2） */
export interface ConversationBranchAgentPort {
  isTaskBusy(taskId: string): boolean;
  resolveTaskExecutionWorkspaceCwd(taskId: string): string;
  getAppSettings(): { conversationBranchEnabled?: boolean; taskConnectorIds?: Record<string, string[]> };
  setTaskConnectorIds(taskId: string, connectorIds: string[]): void;
}

export interface ConversationBranchServiceDeps {
  db: AppDatabase;
  agent: ConversationBranchAgentPort;
  brancher: TaskWorkspaceBrancher;
  /** Required runtime dependency; initialized before the branch service. */
  artifactService: ArtifactService;
}

const SPECIAL_TASK_PREFIXES = ["gw-", "cron-", "btw-"];

export class ConversationBranchService {
  private readonly deps: ConversationBranchServiceDeps;

  constructor(deps: ConversationBranchServiceDeps) {
    if (!deps.artifactService) throw new Error("ConversationBranchService requires the initialized ArtifactService");
    this.deps = deps;
  }

  /** §15.1 回滚门：关闭后隐藏入口（create 也拒绝） */
  private featureEnabled(): boolean {
    return this.deps.agent.getAppSettings().conversationBranchEnabled === true;
  }

  /** 预检（§8.3 大目录策略选择）：无副作用 */
  preview(req: CreateConversationBranchRequest): ConversationBranchPreviewDto {
    const failure = (
      code: ConversationBranchErrorCode,
      message: string,
    ): ConversationBranchPreviewDto => ({ ok: false, code, message, strategy: "conversation_only" });
    if (!this.featureEnabled()) {
      return failure("INVALID_REQUEST", "对话分支功能未开启。");
    }
    const task = this.deps.db.getTask(req.sourceTaskId);
    if (!task) return failure("TASK_NOT_FOUND", "找不到源任务。");
    if (this.isTrashed(task.id)) return failure("TASK_TRASHED", "任务已进入回收区，无法创建分支。");
    if (SPECIAL_TASK_PREFIXES.some((p) => task.id.startsWith(p))) {
      return failure("TASK_SPECIAL", "网关/定时/临时会话不支持创建分支。");
    }
    if (this.deps.agent.isTaskBusy(task.id)) {
      return failure("TASK_BUSY", "当前任务仍在运行，请先停止生成后再创建分支。");
    }
    if (!task.sessionFile || !existsSync(task.sessionFile)) {
      return failure("SESSION_MISSING", "源会话文件不存在，无法创建分支。");
    }
    const sourceCwd = this.deps.agent.resolveTaskExecutionWorkspaceCwd(task.id);
    const strategy = this.resolveStrategy(task, req.workspaceStrategy);
    const preview: ConversationBranchPreviewDto = { ok: true, strategy };
    if (strategy === "current_snapshot") {
      const snapshot = this.deps.brancher.preflight(sourceCwd);
      preview.snapshot = {
        fileCount: snapshot.fileCount,
        totalBytes: snapshot.totalBytes,
        overLimit: snapshot.overLimit,
      };
      if (snapshot.overLimit) {
        preview.ok = false;
        preview.code = "WORKSPACE_LIMIT_EXCEEDED";
        preview.message =
          "独立文件目录超过复制限制（10 万个文件或 2 GiB），请选择「仅分支对话」或先保存到工作空间。";
        return preview;
      }
    }
    try {
      const resolved = resolveConversationBranchLeaf(task.sessionFile, sourceCwd, {
        entryId: req.entryId,
        userMessageIndex: req.userMessageIndex,
        position: req.position,
      });
      preview.sourceUserMessageIndex = resolved.resolvedUserMessageIndex;
      preview.sourcePosition = req.position;
    } catch (err) {
      const e = err as ConversationBranchDomainError;
      return failure(e.code ?? "ANCHOR_NOT_FOUND", e.message);
    }
    return preview;
  }

  async create(req: CreateConversationBranchRequest): Promise<ConversationBranchCreateOutcome> {
    const fail = (
      code: ConversationBranchErrorCode,
      message: string,
    ): ConversationBranchCreateOutcome => ({ ok: false, code, message });
    if (!this.featureEnabled()) {
      return fail("INVALID_REQUEST", "对话分支功能未开启。");
    }
    if (!req.requestId || typeof req.requestId !== "string") {
      return fail("INVALID_REQUEST", "缺少幂等请求键，请重试。");
    }
    if (req.position !== "after_user" && req.position !== "after_reply") {
      return fail("INVALID_REQUEST", "分支位置无效。");
    }

    // §5.4 幂等：相同 requestId 返回同一个 child
    const existing = this.deps.db.findConversationBranchByRequestId(req.requestId);
    if (existing) {
      if (existing.parentTaskId !== req.sourceTaskId || existing.sourcePosition !== req.position) {
        return fail("INVALID_REQUEST", "请求键已被另一个分支请求使用。");
      }
      const task = this.deps.db.getTask(existing.childTaskId);
      if (task) {
        return {
          ok: true,
          result: {
            task,
            branch: existing,
            warnings: ["重复请求，已返回既有分支"],
            inheritedArtifactCount: 0,
            skippedArtifactCount: 0,
          },
        };
      }
    }

    // ---- §6.2 校验顺序 ----
    const task = this.deps.db.getTask(req.sourceTaskId);
    if (!task) return fail("TASK_NOT_FOUND", "找不到源任务。");
    if (this.isTrashed(task.id)) {
      return fail("TASK_TRASHED", "任务已进入回收区，无法创建分支。");
    }
    if (SPECIAL_TASK_PREFIXES.some((p) => task.id.startsWith(p))) {
      return fail("TASK_SPECIAL", "网关/定时/临时会话不支持创建分支。");
    }
    if (this.deps.agent.isTaskBusy(task.id)) {
      return fail("TASK_BUSY", "当前任务仍在运行，请先停止生成后再创建分支。");
    }
    if (!task.sessionFile || !existsSync(task.sessionFile)) {
      return fail("SESSION_MISSING", "源会话文件不存在，无法创建分支。");
    }

    const sourceCwd = this.deps.agent.resolveTaskExecutionWorkspaceCwd(task.id);
    let resolved;
    try {
      resolved = resolveConversationBranchLeaf(task.sessionFile, sourceCwd, {
        entryId: req.entryId,
        userMessageIndex: req.userMessageIndex,
        position: req.position,
      });
    } catch (err) {
      const e = err as ConversationBranchDomainError;
      return fail(e.code ?? "ANCHOR_NOT_FOUND", e.message);
    }

    const childTaskId = `task-${randomUUID()}`;
    const strategy = this.resolveStrategy(task, req.workspaceStrategy);
    if (strategy === "current_snapshot") {
      const snapshot = this.deps.brancher.preflight(sourceCwd);
      if (snapshot.overLimit && req.workspaceStrategy === undefined) {
        return fail(
          "WORKSPACE_LIMIT_EXCEEDED",
          "独立文件目录超过复制限制（10 万个文件或 2 GiB），请选择「仅分支对话」或先保存到工作空间。",
        );
      }
    }
    return this.createWithStrategy(req, task, childTaskId, resolved, sourceCwd, strategy);
  }

  /** §7.4 + §10.1 + §3.4：给定策略完成工作区 → session → DB commit → 继承 */
  private async createWithStrategy(
    req: CreateConversationBranchRequest,
    task: TaskDto,
    childTaskId: string,
    resolved: ReturnType<typeof resolveConversationBranchLeaf>,
    sourceCwd: string,
    strategy: "shared_space" | "current_snapshot" | "conversation_only",
  ): Promise<ConversationBranchCreateOutcome> {
    const fail = (
      code: ConversationBranchErrorCode,
      message: string,
    ): ConversationBranchCreateOutcome => ({ ok: false, code, message });

    // ---- §8 工作区准备（commit 前；失败只清理本 requestId 产物） ----
    let childCwd: string;
    try {
      if (strategy === "shared_space") {
        // Space.path 已解析；child 与 parent 共用同一真实目录（§8.2）
        childCwd = sourceCwd;
      } else if (strategy === "conversation_only") {
        childCwd = this.deps.brancher.prepareEmptyWorkspace(childTaskId);
      } else {
        const copy = this.deps.brancher.copySnapshotToPending(sourceCwd, childTaskId, req.requestId);
        childCwd = this.deps.brancher.commitPending(childTaskId, req.requestId, copy.pendingDir);
      }
    } catch (err) {
      this.deps.brancher.cleanupPending(childTaskId, req.requestId);
      return fail(
        "WORKSPACE_LIMIT_EXCEEDED",
        `独立工作区准备失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ---- §7.2 session 物化（独立 SessionManager；不触碰 live 会话） ----
    let materialized;
    try {
      materialized = createConversationBranchSession(
        task.sessionFile!,
        childCwd,
        resolved.leafEntryId,
      );
    } catch (err) {
      this.deps.brancher.cleanupPending(childTaskId, req.requestId);
      const e = err as ConversationBranchDomainError;
      return fail(e.code ?? "BRANCH_SESSION_FAILED", e.message);
    }

    // ---- §10.1 DB 单事务 commit point ----
    const parentBranch = this.deps.db.getConversationBranchInfo(task.id);
    const rootTaskId = parentBranch?.rootTaskId ?? task.id;
    const childTask: TaskDto = {
      id: childTaskId,
      title: this.deriveBranchTitle(task.title),
      spaceId: task.spaceId ?? undefined,
      projectId: task.projectId ?? undefined,
      // §3.4 派生状态：结束于助手消息 → completed；结束于用户消息 → pending
      status: req.position === "after_reply" && resolved.leafEntryId !== resolved.userEntryId ? "completed" : "pending",
      updatedAt: Date.now(),
      sessionFile: materialized.sessionFile,
      cwd: childCwd,
      welcomeMode: task.welcomeMode,
      modelId: task.modelId,
      permissionMode: task.permissionMode,
      expertId: task.expertId,
      modePresetId: task.modePresetId,
    };
    try {
      this.deps.db.connection.transaction(() => {
      this.deps.db.createConversationBranchTask({
        childTaskId,
        parentTaskId: task.id,
        rootTaskId,
        parentTitleSnapshot: task.title,
        sourceSessionFile: task.sessionFile!,
        sourceLeafEntryId: resolved.leafEntryId,
        sourceUserMessageIndex: resolved.resolvedUserMessageIndex,
        requestId: req.requestId,
        position: req.position,
        workspaceStrategy: strategy,
        createdAt: Date.now(),
        task: childTask,
      });
      // The inherited-usage watermark is part of the same commit: a failure must
      // not leave a successful child that charges inherited history again.
      writeConversationBranchUsageWatermark(this.deps.db.connection, materialized.sessionFile, materialized.inheritedLastEntryId);
      })();
    } catch (err) {
      // commit 失败：会话文件已物化但 Task 未创建 → 清理本 requestId 工作区产物；
      // 物化的 session 文件保留（Pi 懒写/孤儿诊断可审计，不扩大删除范围）
      this.deps.brancher.cleanupPending(childTaskId, req.requestId);
      return fail(
        "TASK_CREATE_FAILED",
        `任务创建失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ---- §3.4 轻量继承：任务级 Active 连接器（不复制运行态/授权） ----
    const inheritedConnectors = this.deps.agent.getAppSettings().taskConnectorIds?.[task.id] ?? [];
    if (inheritedConnectors.length > 0) {
      try {
        this.deps.agent.setTaskConnectorIds(childTaskId, [...inheritedConnectors]);
      } catch {
        /* 连接器继承失败不阻断分支创建 */
      }
    }

    const branch = this.deps.db.getConversationBranchInfo(childTaskId)!;
    // §13.1 采样确认：真实 TaskDto 从 DB 读回（拿 DB committed 行，避免内存构造漂移）
    const committedTask = this.deps.db.getTask(childTaskId) ?? childTask;

    // ---- Phase 4：克隆「分支点之前」的产物（§9.2；失败不阻断创建） ----
    let inheritedArtifactCount = 0;
    let skippedArtifactCount = 0;
    const warnings = [strategyNotice(strategy)];
    if (this.deps.artifactService) {
      try {
        const inheritedToolCallIds = new Set(resolved.inheritedToolCallIds);
        const cloneResult = await this.deps.artifactService.cloneForConversationBranch({
          parentTaskId: task.id,
          childTaskId,
          inheritedToolCallIds,
          strategy,
          targetRoot: childCwd,
        });
        inheritedArtifactCount = cloneResult.inheritedCount;
        skippedArtifactCount = cloneResult.skippedCount;
        warnings.push(...cloneResult.warnings);
      } catch (err) {
        warnings.push(`产物继承失败：${err instanceof Error ? err.message : String(err)}`);
        // 克隆整体失败不删除已提交的对话分支（§10.1）；保留诊断
        console.warn(
          `[ConversationBranchService] artifact clone failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      ok: true,
      result: {
        task: committedTask,
        branch,
        warnings,
        inheritedArtifactCount,
        skippedArtifactCount,
      },
    };
  }

  getInfo(taskId: string): ConversationBranchInfoDto | undefined {
    return this.deps.db.getConversationBranchInfo(taskId);
  }

  listChildren(taskId: string): ConversationBranchInfoDto[] {
    return this.deps.db.listConversationBranchChildren(taskId);
  }

  /** Space 绑定 → shared_space（强制）；否则请求策略或默认 current_snapshot（§8.2/§8.3） */
  private resolveStrategy(
    task: TaskDto,
    requested?: "shared_space" | "current_snapshot" | "conversation_only",
  ): "shared_space" | "current_snapshot" | "conversation_only" {
    const spacePath = this.deps.db.resolveWorkspaceExecutionPath(task.spaceId ?? null, { requireExisting: true });
    if (spacePath) return "shared_space";
    if (requested === "conversation_only" || requested === "current_snapshot") {
      return requested;
    }
    return "current_snapshot";
  }

  private isTrashed(taskId: string): boolean {
    return this.deps.db
      .listTaskExecutionWorkspaceStates({ state: "trashed" })
      .some((s) => s.taskId === taskId);
  }

  /** §4.3 标题防重：{原标题}（分支）/（分支 2）/（分支 3）… */
  private deriveBranchTitle(sourceTitle: string): string {
    const base = sourceTitle || "新任务";
    const prefix = `${base}（分支`;
    const siblingTitles = new Set(
      this.deps.db.listTasks().map((t) => t.title),
    );
    if (!siblingTitles.has(`${base}（分支）`)) return `${base}（分支）`;
    let n = 2;
    while (siblingTitles.has(`${prefix} ${n}）`)) n++;
    return `${prefix} ${n}）`;
  }
}

function strategyNotice(strategy: "shared_space" | "current_snapshot" | "conversation_only"): string {
  switch (strategy) {
    case "shared_space":
      return "已创建对话分支；文件继续使用同一工作空间。";
    case "conversation_only":
      return "已创建对话分支；仅分支对话，未复制文件。";
    default:
      return "已创建对话分支；独立文件目录复制自当前状态。";
  }
}
