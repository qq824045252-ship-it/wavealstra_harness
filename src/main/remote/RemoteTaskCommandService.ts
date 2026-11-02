import { resolveWelcomeMode } from "../../shared/mode-profile";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type {
  RemoteAcpCreateRequest,
  RemoteAcpCreateResponse,
  RemoteAcpPromptRequest,
  RemoteAcpPromptResponse,
  RemoteApprovalRequest,
  RemoteAttachmentInput,
  RemoteConversationInteractionAnswer,
  RemoteConversationInteractionMutationResult,
  RemotePromptRequest,
  RemotePromptResponse,
} from "../../../shared/src/remote-contract";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { AgentService } from "../agent/AgentService";
import type { AppDatabase } from "../db/AppDatabase";
import type { ExternalAgentRuntime } from "../external-agent/ExternalAgentRuntime";
import type { ExternalAgentRunDto } from "../../shared/external-agent";
import { getMyBuddyDir } from "../paths";
import { mapRemoteAcpRun, mapRemoteTask } from "./RemoteDtoMapper";

interface ProjectLookup { get(id: string): unknown | undefined }

/** 远程上传附件的原始字节上限（与 zod 的 base64 长度上限对齐） */
const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const MODEL_CACHE_TTL_MS = 30_000;

function titleFromText(text: string, maxLength = 24): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length <= maxLength ? plain : `${plain.slice(0, maxLength - 1)}…`;
}

/** 纯附件消息的标题兜底：取首个附件名，避免全部落成“新任务” */
function titleFromPrompt(text: string, attachments?: RemoteAttachmentInput[]): string {
  const fromText = titleFromText(text);
  if (fromText) return fromText;
  if (attachments?.length) return titleFromText(`附件：${attachments[0].name}`) || "新任务";
  return "新任务";
}

/** 去掉路径分隔符与 Windows 非法字符，防止附件名注入路径 */
function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (clean || "attachment").slice(0, 120);
}

export class RemoteConflictError extends Error {}
export class RemoteNotFoundError extends Error {}
export class RemoteValidationError extends Error {}

/** 远程删除需要的最小生命周期能力：与桌面端 DbIpc.deleteTask 同一条安全回收链路。 */
export interface RemoteTrashLifecycle {
  trash(taskId: string): Promise<unknown>;
}
/** 远程删除后清理工作图节点；失败只告警，与桌面端一致不阻断删除。 */
export interface RemoteWorkGraphCleanup {
  cleanupByNode(kind: "task", id: string): unknown;
}

/** 任务永久删除（purge）时清理其远程附件目录；失败只告警，不阻断删除流程 */
export async function cleanupRemoteUploads(taskId: string, uploadsRoot = join(getMyBuddyDir(), "remote-uploads")): Promise<void> {
  const dir = join(uploadsRoot, taskId);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
}

export class RemoteTaskCommandService {
  private modelIdsCache: { at: number; ids: Set<string> } | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: AgentService,
    private readonly settings: AppSettingsStore,
    private readonly projects: ProjectLookup,
    /** 测试注入用；生产走 userData/remote-uploads */
    private readonly uploadsRoot = join(getMyBuddyDir(), "remote-uploads"),
    /** 删除复用桌面端 taskLifecycle.trash（安全回收，可恢复）；缺省时退化为仅标记 trashed */
    private readonly lifecycle?: RemoteTrashLifecycle,
    private readonly workGraph?: RemoteWorkGraphCleanup,
    /** ACP 外部 Agent：手机端把一轮委托交给电脑端真实 ACP 进程 */
    private readonly externalAgent?: ExternalAgentRuntime,
  ) {}

  invalidateModelCache(): void { this.modelIdsCache = null; }

  async createAndPrompt(request: RemotePromptRequest): Promise<RemotePromptResponse> {
    const text = request.text.trim();
    // P1 修复：纯附件消息合法（schema 已保证 text/attachments 至少其一）
    if (!text && !request.attachments?.length) throw new RemoteValidationError("消息不能为空");
    const space = request.spaceId ? this.db.getSpace(request.spaceId) : undefined;
    if (request.spaceId && (!space || space.effectiveArchived)) throw new RemoteValidationError("Workspace 不存在或不可用");
    if (request.projectId && !this.projects.get(request.projectId)) throw new RemoteValidationError("Project 不存在");
    // Validate new-task configuration only; never gate tools or alter existing tasks.
    const welcomeMode = resolveWelcomeMode(request.welcomeMode);
    if (request.modePresetId && !this.agent.getModeProfile(welcomeMode).policy.presets?.some(tag => tag.id === request.modePresetId)) {
      throw new RemoteValidationError("所选 Tag 不属于当前模式或已被删除，请刷新后重新选择");
    }

    const taskId = `remote-${randomUUID()}`;
    const now = Date.now();
    const settings = this.settings.read();
    const modelId = (request.welcomeMode === "bot" ? request.modelId : await this.resolveModelId(request.modelId)) ?? (settings.defaultModelId || undefined);
    const permissionMode = request.permissionMode ?? settings.permissionMode;
    this.db.upsertTask({
      id: taskId,
      title: titleFromPrompt(text, request.attachments),
      spaceId: request.spaceId,
      projectId: request.projectId,
      updatedAt: now,
      welcomeMode: resolveWelcomeMode(request.welcomeMode),
      modelId,
      permissionMode,
      modePresetId: request.modePresetId ?? null,
    });
    const userMessageId = `remote-user-${randomUUID()}`;
    const assistantMessageId = `remote-assistant-${randomUUID()}`;
    try {
      const attachments = await this.persistAttachments(taskId, request.attachments);
      const prompt = this.agent.prompt({
        taskId,
        text,
        displayText: text,
        spaceId: request.spaceId,
        welcomeMode: resolveWelcomeMode(request.welcomeMode),
        modelId,
        permissionMode,
        modePresetId: request.modePresetId ?? null,
        connectorIds: this.settings.getTaskConnectorIds(taskId),
        attachments,
        userMessageId,
        assistantMessageId,
      }, { durableAdmissionOnly: true });
      if (request.welcomeMode === "bot") await prompt;
      void prompt.catch((error) => {
        const task = this.db.getTask(taskId);
        // P1/P2 修复：HTTP 已 201 返回后 agent 异步失败（preflight/runtime 拒绝）也必须清理，
        // 否则 remote-uploads/<taskId> 成为孤儿目录
        if (task && task.welcomeMode !== "bot" && !task.sessionFile) {
          this.db.deleteTask(taskId);
          void cleanupRemoteUploads(taskId, this.uploadsRoot).catch(() => undefined);
        }
        console.warn(`[RemoteTaskCommandService] new task failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      const task = this.requireTask(taskId);
      return {
        task: mapRemoteTask(task, { busy: this.agent.isTaskBusy(taskId), pendingActionCount: this.agent.listPendingActions(taskId).length }),
        userMessageId,
        assistantMessageId,
        queued: true,
      };
    } catch (error) {
      const task = this.db.getTask(taskId);
      if (task && task.welcomeMode !== "bot" && !task.sessionFile) this.db.deleteTask(taskId);
      // P2 修复：新建失败回滚时同步清掉已落盘的附件目录，避免孤儿文件
      if (task?.welcomeMode !== "bot") await cleanupRemoteUploads(taskId, this.uploadsRoot).catch(() => undefined);
      throw error;
    }
  }

  async promptExisting(taskId: string, request: RemotePromptRequest): Promise<RemotePromptResponse> {
    const task = this.requireTask(taskId);
    if (this.db.isTaskEffectiveArchived(taskId)) throw new RemoteConflictError("任务已归档或回收，不能继续执行");
    const text = request.text.trim();
    // P1 修复：纯附件消息合法（schema 已保证 text/attachments 至少其一）
    if (!text && !request.attachments?.length) throw new RemoteValidationError("消息不能为空");
    const requestedModelId = task.welcomeMode === "bot" ? request.modelId : await this.resolveModelId(request.modelId);
    const modelId = requestedModelId ?? task.modelId;
    const permissionMode = request.permissionMode ?? task.permissionMode;
    // 先写附件再改任务：附件落盘失败（超限/写错误）时抛错返回，任务的模型/权限保持原值，不产生半提交
    const attachments = await this.persistAttachments(taskId, request.attachments);
    if ((requestedModelId && requestedModelId !== task.modelId) || (request.permissionMode && request.permissionMode !== task.permissionMode)) {
      this.db.upsertTask({ ...task, modelId, permissionMode });
    }
    const userMessageId = `remote-user-${randomUUID()}`;
    const assistantMessageId = `remote-assistant-${randomUUID()}`;
    const prompt = this.agent.prompt({
      taskId,
      text,
      displayText: text,
      spaceId: task.spaceId ?? undefined,
      welcomeMode: task.welcomeMode,
      modelId,
      permissionMode,
      modePresetId: task.welcomeMode === "bot" ? request.modePresetId ?? task.modePresetId : task.modePresetId,
      expertId: task.expertId,
      sessionFile: task.sessionFile,
      connectorIds: this.settings.getTaskConnectorIds(taskId),
      attachments,
      userMessageId,
      assistantMessageId,
      streamingBehavior: this.agent.isTaskBusy(taskId) ? "followUp" : undefined,
    }, { durableAdmissionOnly: true });
    if (task.welcomeMode === "bot") await prompt;
    void prompt.then((result) => {
      if (result.error) console.warn(`[RemoteTaskCommandService] prompt rejected: ${result.error.message}`);
    }).catch((error) => {
      const current = this.db.getTask(taskId);
      if (current && current.welcomeMode !== "bot") this.db.upsertTask({ ...current, status: "failed", updatedAt: Date.now() });
      console.warn(`[RemoteTaskCommandService] prompt failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const current = this.requireTask(taskId);
    return {
      task: mapRemoteTask(current, { busy: this.agent.isTaskBusy(taskId), pendingActionCount: this.agent.listPendingActions(taskId).length }),
      userMessageId,
      assistantMessageId,
      queued: true,
    };
  }

  /** 校验远程指定的 modelId 确实在服务端可用目录内；缺省返回 undefined（跟随任务/默认） */
  private async resolveModelId(modelId?: string): Promise<string | undefined> {
    if (!modelId?.trim()) return undefined;
    const now = Date.now();
    if (!this.modelIdsCache || now - this.modelIdsCache.at >= MODEL_CACHE_TTL_MS) {
      const models = await this.agent.listModels();
      // available !== false：目录里声明但 Provider 未认证（无法执行）的模型不进入可执行白名单
      this.modelIdsCache = { at: now, ids: new Set(models.filter((m) => m.enabled !== false && m.kind !== "image-generation" && m.available !== false).map((m) => m.id)) };
    }
    if (!this.modelIdsCache.ids.has(modelId)) throw new RemoteValidationError("所选模型当前不可用");
    return modelId;
  }

  /**
   * 远程附件落盘（uploadsRoot/<taskId>/），以 { name, path } 形式交给 agent。
   * P2 修复：异步 IO（避免十几 MB 的同步写卡 Electron 主进程）；部分写入失败时回滚整个任务附件目录。
   */
  private async persistAttachments(taskId: string, inputs?: RemoteAttachmentInput[]): Promise<Array<{ name: string; path: string }> | undefined> {
    if (!inputs?.length) return undefined;
    const dir = join(this.uploadsRoot, taskId);
    await mkdir(dir, { recursive: true });
    const files: Array<{ name: string; path: string }> = [];
    try {
      for (const input of inputs) {
        const data = Buffer.from(input.data, "base64");
        if (data.length === 0) throw new RemoteValidationError(`附件 ${input.name} 内容无效`);
        if (data.length > ATTACHMENT_MAX_BYTES) throw new RemoteValidationError(`附件 ${input.name} 超过 4MB 上限`);
        const path = join(dir, `${randomUUID()}-${sanitizeFileName(input.name)}`);
        await writeFile(path, data);
        files.push({ name: input.name.trim().slice(0, 200), path });
      }
    } catch (error) {
      // 只回滚本次已写入的文件（已有任务的目录里可能还有历史消息的附件）；空目录由任务 purge 时的 cleanup 兜底
      for (const file of files) await rm(file.path, { force: true }).catch(() => undefined);
      throw error;
    }
    return files;
  }

  async abort(taskId: string): Promise<void> {
    this.requireTask(taskId);
    // ACP 外部 Agent 与内置 Pi 是两条执行链：手机端点「停止」必须两条都停，
    // 否则 ACP 进程会继续在电脑端跑完（用户以为已中断）。
    if (this.externalAgent?.active(taskId).length) this.externalAgent.cancel(undefined, taskId);
    await this.agent.abort(taskId);
  }

  /**
   * 手机端发起一轮 ACP 委托（当前任务）：
   * 1) 校验 Agent 在电脑端 ACP 目录里可用且已启用；
   * 2) 写入本轮用户/助手消息 id，交给 ExternalAgentRuntime.prompt（真实 ACP 进程在电脑端跑）；
   * 3) 返回手机端投影（run 信息），UI 通过 SSE agent.patch 收到流式输出。
   */
  acpPromptExisting(taskId: string, agentId: string, request: RemoteAcpPromptRequest): RemoteAcpPromptResponse {
    this.requireTask(taskId);
    if (this.db.isTaskEffectiveArchived(taskId)) throw new RemoteConflictError("任务已归档或回收，不能继续执行");
    const runtime = this.requireAcpRuntime();
    this.requireAvailableAgent(agentId, runtime);
    const text = request.text.trim();
    if (!text && !request.attachments?.length) throw new RemoteValidationError("消息不能为空");
    // ACP 是长时子进程：同一任务只允许一轮在跑，避免两个 Agent 同时改同一个工作目录。
    if (this.externalAgent!.active(taskId).length) {
      throw new RemoteConflictError("该任务已有 ACP Agent 正在执行，请先停止或等待完成");
    }
    const continuation = this.resolveAcpContinuation(taskId, agentId, request.continueFromRunId, request.newSession);
    const userMessageId = `remote-acp-user-${randomUUID()}`;
    const assistantMessageId = `remote-acp-assistant-${randomUUID()}`;
    let runId: string;
    try {
      runId = runtime.prompt({
        taskId,
        agentId: agentId as Parameters<typeof runtime.prompt>[0]["agentId"],
        text,
        displayText: text,
        userMessageId,
        assistantMessageId,
        ...(continuation ? { continueFromRunId: continuation } : {}),
      }).runId;
    } catch (error) {
      throw new RemoteValidationError(error instanceof Error ? error.message : String(error));
    }
    const run = runtime.history(taskId).runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new RemoteConflictError("ACP Run 未能建立，请稍后重试");
    return { run: mapRemoteAcpRun(run), userMessageId, assistantMessageId };
  }

  private requireAcpRuntime(): ExternalAgentRuntime {
    if (!this.externalAgent) throw new RemoteConflictError("当前电脑端未初始化 ACP Runtime，请更新电脑端");
    return this.externalAgent;
  }

  /**
   * 新建任务并直接委托给 ACP 外部 Agent（首页选好 Agent 时的第一轮）。
   * 与 createAndPrompt 同一套校验/回滚语义，只是执行侧换成 ExternalAgentRuntime：
   * 任务行先落库（ACP 需要 taskId 解析 cwd），失败则连同附件目录一起回滚。
   */
  async createWithAcp(request: RemoteAcpCreateRequest): Promise<RemoteAcpCreateResponse> {
    const text = request.text.trim();
    if (!text && !request.attachments?.length) throw new RemoteValidationError("消息不能为空");
    const space = request.spaceId ? this.db.getSpace(request.spaceId) : undefined;
    if (request.spaceId && (!space || space.effectiveArchived)) throw new RemoteValidationError("Workspace 不存在或不可用");
    if (request.projectId && !this.projects.get(request.projectId)) throw new RemoteValidationError("Project 不存在");
    const welcomeMode = resolveWelcomeMode(request.welcomeMode);
    if (request.modePresetId && !this.agent.getModeProfile(welcomeMode).policy.presets?.some(tag => tag.id === request.modePresetId)) {
      throw new RemoteValidationError("所选 Tag 不属于当前模式或已被删除，请刷新后重新选择");
    }
    const runtime = this.requireAcpRuntime();
    this.requireAvailableAgent(request.agentId, runtime);

    const taskId = `remote-${randomUUID()}`;
    const now = Date.now();
    this.db.upsertTask({
      id: taskId,
      title: titleFromPrompt(text, request.attachments),
      spaceId: request.spaceId,
      projectId: request.projectId,
      updatedAt: now,
      welcomeMode,
      modePresetId: request.modePresetId ?? null,
    });
    const userMessageId = `remote-acp-user-${randomUUID()}`;
    const assistantMessageId = `remote-acp-assistant-${randomUUID()}`;
    try {
      const attachments = await this.persistAttachments(taskId, request.attachments);
      const runId = runtime.prompt({
        taskId,
        agentId: request.agentId as Parameters<typeof runtime.prompt>[0]["agentId"],
        text,
        displayText: text,
        userMessageId,
        assistantMessageId,
        ...(attachments?.length ? { attachments } : {}),
      }).runId;
      const run = runtime.history(taskId).runs.find((candidate) => candidate.runId === runId);
      if (!run) throw new RemoteConflictError("ACP Run 未能建立，请稍后重试");
      const created = this.requireTask(taskId);
      return {
        task: mapRemoteTask(created, {
          busy: true,
          pendingActionCount: 0,
        }),
        run: mapRemoteAcpRun(run),
        userMessageId,
        assistantMessageId,
      };
    } catch (error) {
      this.db.deleteTask(taskId);
      await cleanupRemoteUploads(taskId, this.uploadsRoot).catch(() => undefined);
      throw error;
    }
  }

  /** Agent 必须在电脑端目录里存在、已启用且可用（CLI/adapter 已安装） */
  private requireAvailableAgent(agentId: string, runtime: ExternalAgentRuntime): void {
    const descriptor = runtime.listAgents().find((item) => item.id === agentId);
    if (!descriptor) throw new RemoteValidationError("电脑端没有这个 ACP Agent");
    if (!descriptor.enabled) throw new RemoteValidationError(`${descriptor.name} 已在电脑端「ACP 管理」中停用`);
    if (!descriptor.available) throw new RemoteValidationError(descriptor.detail || `${descriptor.name} ACP Runtime 不可用`);
  }

  /**
   * 续聊解析（决定「这轮是接着聊还是开新会话」）：
   *  - newSession=true           → 强制新会话；
   *  - continueFromRunId 显式给 → 只接受同 Agent 的 run，找不到就降级（不报错）；
   *  - 都没给                     → 自动续接同任务同 Agent 最近一次「已建 session + 可恢复 + cwd 未变」的 run。
   *
   * 注意：ACP 子进程每轮都会重新启动（一次性进程），这里续接的是 **session**，
   * 也就是对话上下文，而不是复用进程。
   */
  private resolveAcpContinuation(
    taskId: string,
    agentId: string,
    continueFromRunId?: string,
    newSession?: boolean,
  ): string | undefined {
    if (newSession) return undefined;
    const runs = this.externalAgent!.history(taskId).runs;
    const requested = continueFromRunId?.trim();
    if (requested) {
      const run = runs.find((candidate) => candidate.runId === requested);
      if (!run) return undefined;
      if (run.agentId !== agentId) throw new RemoteValidationError("续聊必须使用同一个 ACP Agent");
      return this.isResumableInTask(run, taskId) ? run.runId : undefined;
    }
    const latest = [...runs].reverse().find((run) => run.agentId === agentId && this.isResumableInTask(run, taskId));
    return latest?.runId;
  }

  /** 可恢复 = 建过 session + Agent 声明支持 resume + 工作目录仍是本任务当前的权威 root */
  private isResumableInTask(run: ExternalAgentRunDto, taskId: string): boolean {
    if (!run.sessionId || !run.capabilities.resumeSupported) return false;
    try {
      const current = this.agent.resolveTaskExecutionWorkspaceCwd(taskId);
      const normalize = (value: string): string => resolvePath(value);
      return normalize(run.cwd) === normalize(current);
    } catch {
      return false;
    }
  }

  respondToInteraction(
    taskId: string,
    interactionId: string,
    answer: RemoteConversationInteractionAnswer,
  ): RemoteConversationInteractionMutationResult {
    this.requireTask(taskId);
    const interaction = this.agent.getConversationRuntimeSnapshot(taskId).interactions.find((candidate) => candidate.id === interactionId);
    if (!interaction) throw new RemoteConflictError("回答请求已失效，请刷新任务状态");
    const result = this.agent.respondConversationInteraction(interactionId, answer);
    if (result.ok) return result;
    if (result.code === "invalid_answer") throw new RemoteValidationError(result.message);
    throw new RemoteConflictError(result.message);
  }

  cancelInteraction(taskId: string, interactionId: string): RemoteConversationInteractionMutationResult {
    this.requireTask(taskId);
    const interaction = this.agent.getConversationRuntimeSnapshot(taskId).interactions.find((candidate) => candidate.id === interactionId);
    if (!interaction) throw new RemoteConflictError("回答请求已失效，请刷新任务状态");
    const result = this.agent.cancelConversationInteraction(interactionId);
    if (result.ok) return result;
    throw new RemoteConflictError(result.message);
  }

  /**
   * 「已结束」绿点确认（手机端打开任务时调用）：写 tasks.done_acked_at，与桌面端同一条链路。
   * 只写该列、不碰 updated_at —— 读事件不得改变任务时间戳/排序。
   */
  ackTaskDone(taskId: string): void {
    this.requireTask(taskId);
    this.db.ackTaskDone(taskId, Date.now());
  }

  /**
   * 手机端删除任务：与桌面端 DbIpc.deleteTask 同一条链路 —— 走 taskLifecycle.trash
   * 进入安全回收（archived=1 + ws state=trashed，可恢复、不 rm -rf、不立即删 Artifact），
   * 再清理 work graph。正在执行的任务拒绝删除，避免删除后仍有补丁回写。
   */
  async deleteTask(taskId: string): Promise<void> {
    this.requireTask(taskId);
    if (this.db.isTaskEffectiveArchived(taskId)) throw new RemoteConflictError("任务已在回收区或已归档");
    // ACP 子进程同样算「任务正在执行」：删除前必须没有活着的 run，
    // 否则进程会在任务被回收后继续写工作目录。
    if (this.agent.isTaskBusy(taskId) || this.externalAgent?.active(taskId).length) {
      throw new RemoteConflictError("任务正在执行，请先停止再删除");
    }
    if (this.lifecycle) await this.lifecycle.trash(taskId);
    // 无生命周期实现时（仅测试/降级）退化为落库标记，保证远端语义一致。
    else this.db.connection.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(taskId);
    try { this.workGraph?.cleanupByNode("task", taskId); } catch { /* 与桌面端一致：清理失败不阻断删除 */ }
    // 附件目录保留到最后 purge：回收区内的任务仍可从桌面端恢复。
  }

  respondToAction(taskId: string, toolCallId: string, request: RemoteApprovalRequest): void {
    // ACP 权限请求走 ExternalAgentRuntime 的 Promise，不在内置审批注册表里：
    // 必须用 Agent 声明的 optionId 回传，不能用 allow-once/deny 之类的布尔语义。
    const acpRun = this.externalAgent?.active(taskId).find((run) =>
      run.pendingPermissions.some((permission) => permission.toolCallId === toolCallId));
    if (acpRun) {
      const permission = acpRun.pendingPermissions.find((item) => item.toolCallId === toolCallId)!;
      const optionId = request.optionId?.trim()
        || (request.decision === "deny"
          ? permission.options.find((option) => option.kind.startsWith("reject"))?.optionId
          : permission.options.find((option) => option.kind === "allow_once")?.optionId);
      if (!optionId) throw new RemoteValidationError("缺少 ACP 授权选项，请刷新任务状态");
      if (!permission.options.some((option) => option.optionId === optionId)) {
        throw new RemoteValidationError("无效的 ACP 授权选项");
      }
      const resolved = this.externalAgent!.resolvePermission({ runId: acpRun.runId, toolCallId, optionId });
      if (!resolved.ok) throw new RemoteConflictError(resolved.message);
      return;
    }
    const action = this.agent.listPendingActions(taskId).find((candidate) => candidate.toolCallId === toolCallId);
    if (!action) throw new RemoteConflictError("审批已失效，请刷新任务状态");
    if (request.decision === "allow-task-dir" && action.approvalKind !== "external-write") {
      throw new RemoteValidationError("普通工具审批不支持目录级授权");
    }
    const approved = request.decision !== "deny";
    const resolved = this.agent.approveTool({
      taskId,
      toolCallId,
      approved,
      externalWrite: action.approvalKind === "external-write" && request.decision === "allow-task-dir"
        ? { scope: "task-dir", path: action.externalWrite?.canonicalDir ?? action.externalWrite?.targetPath ?? "" }
        : undefined,
    });
    if (!resolved) throw new RemoteConflictError("审批已失效，请刷新任务状态");
  }

  private requireTask(taskId: string) {
    const task = this.db.getTask(taskId);
    if (!task) throw new RemoteNotFoundError("任务不存在");
    return task;
  }
}
