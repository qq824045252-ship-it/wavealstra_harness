import { DotsForegroundReads, DotsForegroundUnavailable, type ForegroundInput } from "./DotsForegroundReads";
import type { ToolDiagnosticEvent } from "../../shared/task-diagnostics";
import { DotsFollowup, dotsDeliveryInstruction, followupInstructions } from "./DotsFollowup";
import { readDotsWorkerOutcome } from "./DotsWorkerOutcome";
import { dotsGoalConclusion } from "./DotsGoalConclusion";
import { dotsCalendarContext } from "./DotsCalendar";
import { nativeResultHits, type NativeResultHit } from "./DotsNativeResults";
import { resolvedPathKey } from "../platform/paths";
import { limitTaskTitle } from "../../shared/task-title";
import { DotsFileWatches } from "./DotsFileWatches";
import { readDotsLibrary } from "./DotsLibrary";
import { DotsIntentChanged } from "./DotsNativeIntent";
import { dotsDelegationScopeMatches } from "./DotsDelegations";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import { TaskBoardRepository } from "../task/TaskBoardRepository";
import type { GoalContinuationOrigin } from "../../shared/conversation-goal";
import type { ConversationInteractionDto } from "../../shared/conversation-interaction";
import type { BoardQuery } from "../../shared/task-board";
import type { AgentService } from "../agent/AgentService";
import type { AgentPromptRequest, SpaceDto, TaskDto } from "../../shared/agent-ipc";
import { dotsOperationEnabled } from "../../shared/dots-settings";
import { DOTS_TASK_ID, dotsLocalSpacePath, isDotsAutomaticInput, type DotsDelegation, type DotsReplyOrigin } from "../../shared/dots";
import { gatewayChannelForSpace, isGatewayConversation } from "../../shared/gateway-task";
import { assertSafeEntryName, listWorkspaceFiles, readWorkspaceFile } from "../workspace/WorkspaceService";

type Agent = Pick<AgentService, "dotsLibrary" | "dotsAnswerEvidenceAllowed" | "isTaskBusy" | "findSubmission" | "prompt" | "assertDelegationAdmissible" | "stopDotsTarget" | "loadTaskHistory" | "isDotsOrdinaryTask" | "dotsSubmission" | "getConversationRuntimeSnapshot" | "respondConversationInteraction" | "dotsMemoryReferenceCurrent" | "dotsInputVersion" | "getAppSettings" | "dotsScheduleIds" | "dotsScheduleOwnerTask" | "controlDotsSchedule" | "holdDotsSchedule" | "assertDotsScheduleInput" | "getConversationGoals" | "resolveTaskExecutionWorkspaceCwd" | "matchesDotsInitialPrivateWorkspace">;
export interface DotsActionHooks {
  observeProgress?(taskId: string, operationId: string, identity: string, at: number): void;
  observeTool?(event: ToolDiagnosticEvent): void;
  preferences?: () => { followupMode: "continue" | "notify" | "paused"; spaceIds: readonly string[] | null };
  fileNotice?: (event: { id: string; revision: string; taskId: string; file: string }) => void;
  progressNotice?: (event: { operationId: string; taskId: string; text: string }) => void;
  failedTask?: (event: { taskId: string; title: string; reason: string }) => void;
  rememberOrigin?(sourceId:string, origin:DotsReplyOrigin):void;
  link(targetTaskId: string, operationId: string, sourceMessageId: string, supersedes: boolean, request: AgentPromptRequest): void;
  list?(): DotsDelegation[];
  changed?(): void;
  failed?(targetTaskId: string, operationId: string, reason: string): void;
}
export interface DotsActionInput {
  assignmentQuote?: string;
  allowHandoff?: boolean;
  handoffOperationId?: string;
  previousAssignmentQuote?: string;
  steps?: string[];
  itemId?: string;
  version?: number;
action: "materials" | "read_material" | "board" | "task" | "spaces" | "files" | "read_file" | "bind" | "create_space" | "rename" | "delegate" | "steer" | "pause" | "stop" | "resume" | "answer" | "deliveries" | "watch_file" | "file_watches" | "cancel_watch" | "pause_all" | "stop_all" | "pause_proactive" | "resume_proactive";
  memoryRefs?: AgentPromptRequest["dotsMemoryRefs"];
  goalId?: string;
  goalUserAcceptanceQuote?: string;
  deliveryInstruction?: string;
  watchId?: string;
  operationId?: string;
  interactionId?: string;
  targetTaskId?: string;
  spaceId?: string;
  name?: string;
  path?: string;
  text?: string;
  query?: string;
  view?: Exclude<BoardQuery["view"], "automation">;
  from?: number;
  until?: number;
  dateKind?: BoardQuery["dateKind"];
  cursor?: BoardQuery["cursor"];
  offset?: number;
}
function required(value: string | undefined, field: string) {
  if (!value?.trim()) throw new Error("缺少" + field);
  return value.trim();
}
function dotsRequestDigest(sourceId: string, value: string) {
  return createHash("sha256").update(JSON.stringify([sourceId, value])).digest("hex");
}

function taskLink(task: Pick<TaskDto, "id" | "title">) {
  return "[" + task.title.replace(/[\\[\]]/g, "\\$&") + "](mybuddy://task/" + encodeURIComponent(task.id) + ")";
}

function spaceLink(space: SpaceDto) {
  return { ...space, link: "[" + space.name.replace(/[\\\[\]]/g, "\\$&") + "](mybuddy://space/" + encodeURIComponent(space.id) + ")" };
}

function singleChoice(question: ConversationInteractionDto, userText: string): string | undefined {
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
  const reply = normalized(userText);
  const choices = [...reply.matchAll(/(?=(?:选择|采用|选|用)([^。！？；，,!?.;]+))/gu)];
  const options = question.options.filter(option => !option.disabled);
  const labels = (option: ConversationInteractionDto["options"][number]) => {
    const label = normalized(option.label);
    return [normalized(option.id), label, label.replace(/\([^()]+\)$/u, "")];
  };
  const exact = options.filter(option => labels(option).includes(reply));
  if (exact.length === 1) return exact[0].id;
  if (/(?:如果|若是|假如|是否|要不要)|(?:不是|不要|不能|别|避免|不)(?:选择|采用|选|用|继续)/u.test(reply)) return;
  const mentioned = options.filter(option => choices.some(([, value]) => labels(option).includes(value)));
  return mentioned.length === 1 ? mentioned[0].id : undefined;
}


function userAnswer(question: ConversationInteractionDto, userText: string) {
  const answer = required(userText, "用户原话");
  if (question.kind === "short_text" || question.kind === "long_text") return userText;
  if (question.kind === "confirm") {
    const reply = answer.normalize("NFKC").replace(/[。!.]+$/u, "").trim();
    if (/^(是|确认|同意|可以|yes|true)$/i.test(reply)) return true;
    if (/^(否|不确认|不同意|取消|no|false)$/i.test(reply)) return false;
    throw new Error("请用户直接回答确认或取消");
  }
  const select = (value: string) => {
    const matching = question.options.filter(option => !option.disabled && (option.label === value || option.id === value));
    if (matching.length === 1) return matching[0]!.id;
    if (!matching.length && question.allowCustom) return value;
    throw new Error("请用户给出题目中的明确选项");
  };
  return question.kind === "multi_select" ? answer.split(/[,，、\n]/).map(value => select(value.trim())) : singleChoice(question, answer) ?? select(answer);
}

export class DotsActions {
  private readonly foreground: DotsForegroundReads;
  private readonly foregroundReaders = new Map<string, Promise<void>>();
  private readonly handoffs = new Map<string, Promise<unknown>>();
  private readonly followups: DotsFollowup;
  private readonly watches: DotsFileWatches;
  private controlRecovery?: Promise<void>;

  constructor(private readonly db: AppDatabase, private readonly agent: Agent, private readonly hooks: DotsActionHooks,
    private readonly board = new TaskBoardRepository(db.connection)) {
    this.foreground = new DotsForegroundReads(db.connection);
    db.connection.exec(`CREATE TABLE IF NOT EXISTS dots_control_batches(id TEXT PRIMARY KEY, selection TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_proactive_pauses(scope TEXT PRIMARY KEY,timer_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_continuation_targets(source TEXT NOT NULL,task_id TEXT NOT NULL,
        prior_operation_id TEXT,assignment_quote TEXT,PRIMARY KEY(source,task_id))`);
    this.followups = new DotsFollowup(db.connection, {
      allowed: taskId => {
        try {
          this.task(taskId);
          return !this.control(taskId);
        } catch { return false; }
      },
      proactive: taskId => this.autonomousForTask(taskId),
      link: (request, source) => {
        this.link(request, source);
        this.hooks.changed?.();
      },
      goal: (taskId, goalId) => {
        const goals = agent.getConversationGoals();
        if (!goals.workService.repo.listConversationIds(goalId).includes(taskId)) return;
        const work = goals.workService.getWork(goalId);
        return work ? goals.toGoal(work, taskId) : undefined;
      },
      version: taskId => agent.dotsInputVersion(taskId),
      receipt: async (taskId, operationId) => (await agent.findSubmission(taskId, operationId))?.receipt?.submissionId,
      send: async (request, source) => {
        this.assertAdmission(request);
        this.link(request, source);
        const result = await agent.prompt(request, { durableAdmissionOnly: true });
        if (result.error || result.cancelled) {
          this.hooks.failed?.(request.taskId, request.userMessageId, result.error?.message ?? "执行已取消");
          return false;
        }
        this.hooks.changed?.();
        return Boolean(result.receipt);
      },
    });
    agent.getConversationGoals().bindDotsCompletion(
      (taskId, operationId, workId, revision) => this.followups.goalCompletion(taskId, operationId, workId, revision),
      (taskId, operationId, workId, revision) => this.followups.recoverGoalCompletionLink(taskId, operationId, workId, revision),
    );
    this.watches = new DotsFileWatches(db, {
      root: (taskId, spaceId) => {
        const task = this.db.getTask(taskId);
        if (!task || !this.ordinary(task) || task.spaceId !== spaceId || this.db.isTaskEffectiveArchived(taskId) ||
          this.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") throw new DotsIntentChanged("原任务或工作空间已变化");
        if (task.externalAgentPin || this.control(taskId)) throw new DotsIntentChanged("原任务已暂停、停止或切换执行器");
        this.space(spaceId);
        const root = this.db.resolveWorkspaceExecutionPath(spaceId, { requireExisting: true });
        if (!root || (task.cwd && resolvedPathKey(task.cwd) !== resolvedPathKey(root))) throw new DotsIntentChanged("任务的执行目录与订阅空间不一致");
        return root;
      },
      inputVersion: id => agent.dotsInputVersion(id), find: (id, operation) => agent.findSubmission(id, operation),
      send: (request, source) => {
        this.assertAdmission(request);
        this.followups.remember(request,source,request.displayText??request.text);
        this.link(request, source);
        return agent.prompt(request, { durableAdmissionOnly: true });
      },
      proactivePaused: spaceId => !this.autonomousIn(spaceId),
      pathAllowed: path => agent.dotsAnswerEvidenceAllowed({kind:"file",path}),
      mayNotify: spaceId => this.preferences.followupMode === "notify" && this.allowsSpace(spaceId) && !this.manuallyHeld(spaceId),
      notify: this.hooks.fileNotice,
      failed: (...args) => this.hooks.failed?.(...args), changed: () => this.hooks.changed?.(),
    });
  }

  startFileWatches() {
    this.watches.start();
    const rows = this.db.connection.prepare("SELECT task_id,operation_id FROM dots_target_controls WHERE operation_id LIKE 'dots-input-%'").all() as
      Array<{task_id:string;operation_id:string}>;
    this.controlRecovery = Promise.all([this.followups.recoverGoals(), this.recoverForegroundHandoffs(),...rows.map(async row => {
      try {
        const receipt = (await this.agent.findSubmission(row.task_id, row.operation_id))?.receipt;
        if (receipt) await this.accepted({ taskId:row.task_id, userMessageId:row.operation_id }, receipt.submissionId);
      } catch (error) { console.warn("[Dots] 恢复暂停控制回执失败", row.task_id, error); }
    })]).then(() => {});
  }

  async closeFileWatches() { await Promise.all([this.watches.close(), this.controlRecovery]); }

  private get preferences() {
    return this.hooks.preferences?.() ?? { followupMode: "continue" as const, spaceIds: null };
  }

  allowsSpace(id?: string | null) {
    const { spaceIds } = this.preferences;
    return spaceIds === null || Boolean(id && spaceIds.includes(id));
  }

  allowsResult(taskId: string) {
    const task = this.db.getTask(taskId);
    return Boolean(task && this.allowsSpace(task.spaceId));
  }

  observeProgress(taskId: string, operationId: string, identity: string, at: number) {
    this.hooks.observeProgress?.(taskId, operationId, identity, at);
  }

  observeTool(event: ToolDiagnosticEvent) { this.hooks.observeTool?.(event); }

  allowsReply(kind: import("../../shared/dots").DotsAssistantReply["kind"]) {
    return kind !== "progress" || this.preferences.followupMode !== "paused";
  }

  autonomousForTask(taskId: string) {
    const task = this.db.getTask(taskId);
    return Boolean(task && this.autonomousIn(task.spaceId));
  }

  canAdvanceGoal(taskId: string, goalId: string) {
    if (this.control(taskId)) return false;
    const latest = this.db.connection.prepare("SELECT goal_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1")
      .pluck().get(taskId);
    return latest !== goalId || this.autonomousForTask(taskId);
  }

  mayRecover(request: AgentPromptRequest, source: string) {
    if (!this.allowsResult(request.taskId)) return false;
    if (request.dotsFileWatch || request.userMessageId.startsWith("dots-input-auto-") || source.startsWith("cron-") && isDotsAutomaticInput(source))
      return this.autonomousForTask(request.taskId);
    return true;
  }

  private autonomousIn(spaceId?: string | null) {
    return this.preferences.followupMode === "continue" && this.allowsSpace(spaceId) && !this.manuallyHeld(spaceId);
  }

  private manuallyHeld(spaceId?: string | null) {
    return Boolean(this.db.connection.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?) LIMIT 1").get(spaceId ?? ""));
  }

  preferencesChanged() {
    this.watches.refresh();
    void this.followups.recoverGoals().catch(error => console.warn("[Dots] 恢复目标交付失败", error));
    this.hooks.changed?.();
  }

  private space(id?: string, controlOnly = false) {
    const space = this.db.getSpace(required(id, "工作空间 ID"));
    if (!space || space.effectiveArchived || !this.isLocalSpace(space) || !controlOnly && !this.allowsSpace(space.id))
      throw new Error("工作空间不存在或未授权给 Dots");
    return space;
  }

  private isLocalSpace(space: SpaceDto) {
    return Boolean(dotsLocalSpacePath(space, id => this.db.getSpace(id)));
  }

  private ordinary(task: TaskDto) {
    return task.id !== DOTS_TASK_ID && !task.id.startsWith("gw-") && !isGatewayConversation(task.id)
      && !task.externalAgentPin && !task.gatewaySidebarChannelId && !gatewayChannelForSpace(task.spaceId ?? "") && this.agent.isDotsOrdinaryTask(task.id)
      && (!task.spaceId || this.isLocalSpace(this.db.getSpace(task.spaceId) ?? {id: task.spaceId, name: ""}));
  }

  private task(id?: string, spaceId?: string, controlOnly = false) {
    const task = this.db.getTask(required(id, "原任务 ID"));
    if (!task || !this.ordinary(task) || this.db.isTaskEffectiveArchived(task.id)
      || this.db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed" || !controlOnly && !this.allowsSpace(task.spaceId))
      throw new Error("普通任务不存在或未授权给 Dots");
    if (spaceId && task.spaceId !== spaceId) throw new Error("原任务属于另一个空间");
    return task;
  }

  private control(taskId: string) {
    return this.db.connection.prepare("SELECT state,operation_id FROM dots_target_controls WHERE task_id=?").get(taskId) as
      { state: "paused" | "stopped"; operation_id: string } | undefined;
  }

  scheduleScope(source: string, taskId?: string, spaceId?: string) {
    if (!taskId && !spaceId) {
      const links = this.db.connection.prepare("SELECT DISTINCT task_id FROM dots_delegations WHERE source_message_id=? LIMIT 2")
        .pluck().all(source) as string[];
      if (links.length > 1) throw new Error("这条交办包含多个任务，请指定定时跟进的任务或空间");
      taskId = links[0];
    }
    if (taskId) {
      const task = this.task(taskId, spaceId);
      if (this.control(taskId)) throw new Error("事项已暂停或停止");
      return { taskId, spaceId: task.spaceId ?? undefined };
    }
    return spaceId ? { spaceId: this.space(spaceId).id } : undefined;
  }

  private assertScheduleSource(source?: string) {
    if (!source || !source.startsWith("cron-") || !isDotsAutomaticInput(source)) return;
    this.agent.assertDotsScheduleInput(source);
  }

  private link(request: AgentPromptRequest, source: string, supersedes = false) {
    // Snapshot the execution directory after its first resolution, before submitting to Durable.
    const task = this.db.getTask(request.taskId);
    if (task && !task.cwd) this.agent.resolveTaskExecutionWorkspaceCwd(request.taskId);
    this.hooks.link(request.taskId, request.userMessageId, source, supersedes, request);
  }

  assertAdmission(request: AgentPromptRequest) {
    if (!request.userMessageId.startsWith("dots-input-")) return;
    const delegation = this.db.connection.prepare(`SELECT d.source_message_id, (${dotsDelegationScopeMatches}) AS same_scope,
      (d.status='pending' AND d.cwd IS NULL AND d.space_path IS NULL AND s.path IS NULL AND t.space_id IS d.space_id) AS first_workspace
      FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
      WHERE d.operation_id=? AND d.task_id=?`).get(request.userMessageId, request.taskId) as
      { source_message_id: string; same_scope: number; first_workspace: number } | undefined;
    this.assertScheduleSource(delegation?.source_message_id);
    for (const inputId of request.dotsForegroundInputs ?? []) this.foreground.state(inputId);
    if (request.dotsForegroundInputs && !dotsOperationEnabled(this.agent.getAppSettings().dotsSettings, "delegate"))
      throw new DotsIntentChanged("自动移交授权已撤销");
    const task = this.task(request.taskId, request.spaceId);
    const initialCwd = delegation?.same_scope === 0 && delegation.first_workspace && task.cwd &&
      this.agent.matchesDotsInitialPrivateWorkspace(task.id, task.cwd) ? task.cwd : undefined;
    if (delegation?.same_scope === 0 && !initialCwd) throw new DotsIntentChanged("原任务或工作空间已变化，请核对后重新交办");
    if (this.agent.getConversationRuntimeSnapshot(request.taskId).interactions.some(row => row.status === "pending"))
      throw new DotsIntentChanged("原任务正在等待答复，请通过原问题继续");
    this.watches.validate(request);
    this.followups.validate(request);
    for (const ref of request.dotsMemoryRefs ?? []) {
      if (!this.agent.dotsMemoryReferenceCurrent(request.taskId, ref.id, ref.revision)) throw new DotsIntentChanged("记忆引用已更新、已停用或超出共享范围");
    }
    if (request.dotsGoalId) {
      const goals = this.agent.getConversationGoals();
      const goal = goals.getLive(request.taskId, request.dotsGoalId);
      const work = goal && goals.workService.getWork(goal.id);
      if (!work || (request.dotsGoalIntentRevision !== undefined && work.intentRevision !== request.dotsGoalIntentRevision))
        throw new DotsIntentChanged("原任务已不再关联指定 Goal，或原 Goal 要求已更新");
    }
    const control = this.control(request.taskId);
    if (control && control.operation_id !== request.userMessageId) throw new DotsIntentChanged("Dots 已暂停或停止此事项，请明确恢复后再派发");
    if (initialCwd) this.db.connection.prepare("UPDATE dots_delegations SET cwd=? WHERE operation_id=? AND task_id=? AND status='pending' AND cwd IS NULL")
      .run(initialCwd, request.userMessageId, request.taskId);
  }

  async accepted(request: Pick<AgentPromptRequest,"taskId"|"userMessageId">, submissionId: number) {
    if (!request.userMessageId.startsWith("dots-input-")) return;
    const control = this.control(request.taskId);
    if (!control || control.operation_id !== request.userMessageId) return;
    const version = await this.agent.dotsInputVersion(request.taskId);
    this.db.connection.transaction(() => {
      const changed = this.db.connection.prepare("DELETE FROM dots_target_controls WHERE task_id=? AND operation_id=?").run(request.taskId, request.userMessageId);
      if (changed.changes && control.state === "paused") {
        if (JSON.parse(version)[1] === submissionId) this.releaseTaskHolds(request.taskId, version);
        else this.watches.controlTarget(request.taskId, "stop");
      }
    })();
  }

  private releaseTaskHolds(taskId: string, version: string) {
    this.watches.resumeTarget(taskId, version);
    for (const id of this.agent.dotsScheduleIds(false, { taskId }))
      this.agent.holdDotsSchedule(id, "task:" + taskId, false);
  }

  private async resumeFinishedTurn(task: TaskDto, resumeId: string, previousId?: string) {
    const saved = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=? AND target_task_id=?")
      .pluck().get(resumeId, task.id) as string | undefined;
    if (saved) previousId = saved;
    if (!previousId) return;
    const control = this.control(task.id);
    if (!saved && control?.state !== "paused") return;
    const receipt = (await this.agent.findSubmission(task.id, previousId))?.receipt;
    if (saved) return { ...this.summary(task), resumed: true, receipt };
    const result = await this.agent.dotsSubmission(task.id, previousId);
    if (!receipt || result?.status !== "completed" || !readDotsWorkerOutcome(result.text)) return;
    const version = await this.agent.dotsInputVersion(task.id);
    if (JSON.parse(version)[1] !== receipt.submissionId)
      throw new DotsIntentChanged("原普通任务已收到更新的要求，不能重新派发先前已完成的交办");
    this.db.connection.transaction(() => {
      if (this.db.connection.prepare("SELECT 1 FROM dots_control_receipts WHERE operation_id=? AND target_task_id=? AND outcome=?").get(resumeId, task.id, previousId)) return;
      if (this.followups.latestPlan(task.id)?.request.userMessageId !== previousId || this.control(task.id)?.operation_id !== control?.operation_id)
        throw new DotsIntentChanged("恢复期间事项已变化，请查询原任务");
      this.db.connection.prepare("DELETE FROM dots_target_controls WHERE task_id=?").run(task.id);
      this.releaseTaskHolds(task.id, version);
      this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,?)").run(resumeId, task.id, previousId);
    })();
    // The original completion event can now continue or deliver against its original plan.
    this.hooks.changed?.();
    return { ...this.summary(task), resumed: true, receipt };
  }

  private latestOperation(taskId: string): string | null {
    return (this.db.connection.prepare("SELECT operation_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1")
      .pluck().get(taskId) as string | undefined) ?? null;
  }

  private continuationTarget(source: string, taskId: string, originalText?: string, quote?: string) {
    if (!this.db.connection.prepare("SELECT 1 FROM dots_continuation_targets WHERE source=? AND task_id=?").get(source, taskId))
      this.assertSeparateContinuation(source, originalText, quote, taskId);
    this.db.connection.prepare(`INSERT INTO dots_continuation_targets VALUES(?,?,?,?)
      ON CONFLICT(source,task_id) DO UPDATE SET assignment_quote=COALESCE(assignment_quote,excluded.assignment_quote)`)
      .run(source, taskId, this.latestOperation(taskId), quote ?? null);
    return this.db.connection.prepare("SELECT prior_operation_id FROM dots_continuation_targets WHERE source=? AND task_id=?")
      .pluck().get(source, taskId) as string | null;
  }

  private assertSeparateContinuation(source: string, originalText?: string, assignment?: string, targetTaskId?: string) {
    const selected = this.db.connection.prepare("SELECT assignment_quote FROM dots_continuation_targets WHERE source=? AND task_id IS NOT ?")
      .pluck().all(source, targetTaskId ?? null) as (string | null)[];
    if (selected.some(quote => !quote || !assignment || !originalText || !this.separateAssignments(originalText, quote, assignment)))
      throw new DotsIntentChanged("本轮已经选定原任务。另行交办时，需要引用本条消息里独立事项的原话");
  }

  private assertContinuationScope(task: TaskDto, operationId: string) {
    const scope = this.db.connection.prepare(`SELECT (${dotsDelegationScopeMatches}) AS matches,
      (t.space_id IS d.space_id AND d.cwd IS NULL AND d.space_path IS NULL AND s.path IS NULL) AS private_workspace
      FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
      WHERE d.operation_id=? AND d.task_id=?`).get(operationId, task.id) as {matches: number; private_workspace: number} | undefined;
    if (scope?.matches || (scope?.private_workspace && task.cwd && this.agent.matchesDotsInitialPrivateWorkspace(task.id, task.cwd))) return;
    throw new DotsIntentChanged("原交办的工作空间已变化，请核对执行目录后重新交办");
  }

  private delegationAdmission(task: TaskDto, operationId: string, result?: Awaited<ReturnType<Agent["prompt"]>>, goalId?: string) {
    if (result?.error || result?.cancelled) {
      const reason = result.error?.message ?? "执行已取消";
      this.hooks.failed?.(task.id, operationId, reason);
      throw new Error(reason);
    }
    this.hooks.changed?.();
    if (!result?.receipt) return { operationId, taskId: task.id, admission: "pending" as const,
      message: "普通任务的持久受理尚未确认。继续核对同一操作后才能报告交办成功。" };
    return { ...this.summary(task), goalId, queued: result.queued, receipt: result.receipt };
  }

  private delegationResult(row: DotsDelegation) {
    const outcome = readDotsWorkerOutcome(row.text);
    const terminal = row.status === "completed" || row.status === "failed";
    const kind = terminal ? this.db.connection.prepare(`SELECT json_extract(snapshot,'$.delivered') FROM dots_reply_events
      WHERE operation_id=? AND task_id=? AND status=? AND settled=1 AND json_valid(snapshot)
      ORDER BY rowid DESC LIMIT 1`).pluck().get(row.id, row.taskId, row.status) : undefined;
    if (kind === "conclusion") {
      const accepted = row.goalId ? dotsGoalConclusion(this.db.connection, row.taskId, row.id) : undefined;
      if (accepted || !row.goalId && row.status === "completed")
        return { status: "completed" as const, text: accepted?.text ?? outcome?.result ?? row.text,
          artifacts: accepted?.completion?.artifacts };
    }
    if (row.status !== "completed") return { status: row.status, text: outcome?.result ?? row.text };
    if (kind === "question") return { status: "blocked" as const, text: outcome?.result ?? row.text };
    return { status: outcome?.dotsState === "progress" ? "progress" as const : "awaiting_outcome" as const, text: outcome?.result ?? row.text };
  }

  private deliveries(task: TaskDto) {
    return (this.hooks.list?.() ?? []).filter(item => item.taskId === task.id).sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 5)
      .map(item => {
        const result = this.delegationResult(item);
        return { operationId: item.id, goalId: item.goalId, status: result.status, interactionId: item.interactionId,
          text: result.text.slice(0, 900), artifacts: (result.artifacts ?? item.artifacts).slice(0, 10),
          updatedAt: item.updatedAt, activity: item.activity };
      });
  }

  private summary(task: TaskDto) {
    const status = this.db.connection.prepare("SELECT status FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1")
      .pluck().get(task.id) === "blocked" ? "waiting_input" : task.status;
    return { id: task.id, title: task.title, link: taskLink(task), spaceId: task.spaceId, status, dotsState: this.control(task.id)?.state,
      running: this.agent.isTaskBusy(task.id), updatedAt: task.updatedAt };
  }

  private recordAnswer(task: TaskDto, sourceId: string, operationId: string, question: ConversationInteractionDto,
    answer: ReturnType<typeof userAnswer>) {
    const key = dotsRequestDigest(sourceId, JSON.stringify(["answer", task.id, operationId, question.id]));
    const inputKey = dotsRequestDigest(sourceId, JSON.stringify(["dots-answer-input", task.id, sourceId]));
    this.db.connection.transaction(() => {
      if (this.control(task.id)) throw new Error("原任务已暂停或问题已经结束");
      if (!this.db.connection.prepare("SELECT 1 FROM dots_control_receipts WHERE operation_id=? AND outcome='answered'").get(key)) {
        const reply = this.agent.respondConversationInteraction(question.id, answer);
        if (!reply.ok) throw new Error(reply.message);
        this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,'answered')").run(key, task.id);
      }
      this.db.connection.prepare("INSERT OR IGNORE INTO dots_control_receipts VALUES(?,?,'answered')").run(inputKey, task.id);
    })();
    this.hooks.changed?.();
    return { ...this.summary(task), operationId, interactionId: question.id, answered: true };
  }

  goalAccepted(request: AgentPromptRequest, origin: GoalContinuationOrigin) {
    return this.followups.goalAccepted(request, origin);
  }

  requestedFilename(taskId: string, operationId: string) {
    return this.followups.requestedFilename(taskId, operationId);
  }

  async followup(row: DotsDelegation, original?: AgentPromptRequest) {
    if (!this.allowsResult(row.taskId)) return {kind:"deferred"} as const;
    const decision = await this.followups.handle(row, original);
    if (!this.allowsResult(row.taskId)) return {kind:"deferred"} as const;
    if (decision.kind === "deferred" && decision.text && this.preferences.followupMode === "notify")
      this.hooks.progressNotice?.({operationId:row.id,taskId:row.taskId,text:decision.text});
    if (decision.kind === "progress" && !this.allowsReply("progress")) return {kind:"quiet"} as const;
    return decision;
  }

  private async inForegroundReadOrder<T>(inputId: string, read: () => Promise<T>) {
    const predecessor = this.foregroundReaders.get(inputId);
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    this.foregroundReaders.set(inputId, pending);
    try {
      await predecessor;
      return await read();
    } finally {
      release();
      if (this.foregroundReaders.get(inputId) === pending) this.foregroundReaders.delete(inputId);
    }
  }

  private waitingForSuppliedFile(input: DotsActionInput, latest: ForegroundInput, conversation: number) {
    const { spaceId, path } = input;
    if (input.action !== "read_file" || input.allowHandoff !== true || !spaceId || !path ||
        isDotsAutomaticInput(latest.id) || !latest.text.includes(path) ||
        !latest.text.includes(this.space(spaceId).name) ||
        !/(?:已(?:经)?|刚(?:刚)?|重新)\s*(?:补[齐上到好传交]|上传|放[进到入好])|(?:补[齐上好]|上传|放好)了/u.test(latest.text) ||
        !/(?:接着|继续|接续|续办)/u.test(latest.text) ||
        /(?:不要|别|不必|无需)(?:再)?(?:委派|继续|接着|续办)|(?:只|仅)(?:在|用)(?:这个|当前|本)对话/u.test(latest.text)) return;
    const matches = this.db.connection.prepare(
      "SELECT d.task_id AS taskId,d.operation_id AS operationId FROM dots_delegations d " +
      "JOIN dots_reply_origins o ON o.source=d.source_message_id WHERE o.conversation=? AND o.entry<? " +
      "AND d.space_id=? AND d.status='blocked' AND d.interaction_id IS NULL AND instr(d.text,?)>0 " +
      "AND NOT EXISTS(SELECT 1 FROM dots_delegations n WHERE n.task_id=d.task_id AND n.seq>d.seq) " +
      "AND NOT EXISTS(SELECT 1 FROM dots_target_controls c WHERE c.task_id=d.task_id) LIMIT 2",
    ).all(conversation, latest.entryId, spaceId, path) as { taskId: string; operationId: string }[];
    if (matches.length === 1) return matches[0];
  }

  async executeForegroundRead(input: DotsActionInput, inputs: readonly ForegroundInput[], originConversation: number,
    call: string, mayDelegate: () => boolean, mayRead: () => boolean, fresh: () => Promise<void>) {
    const root = inputs[0];
    const latest = inputs.at(-1);
    if (!root || !latest) throw new DotsForegroundUnavailable("无法确认本轮原生输入，前台读取已停止");
    const current = () => {
      this.foreground.state(root.id);
      if (latest.id !== root.id) this.foreground.state(latest.id);
      if (!mayRead()) throw new DotsForegroundUnavailable("本轮读取授权已撤销");
    };
    const origin = { conversationId: originConversation, entryId: root.entryId };
    const { result, reached } = await this.inForegroundReadOrder(root.id, async () => {
      await fresh();
      current();
      const state = this.foreground.freeze(root.id);
      let result: unknown;
      let reached = state.exhausted;
      if (!reached) {
        result = await this.execute(DOTS_TASK_ID, root.id, input, root.text, origin, root.createdAt, { read: true });
        await fresh();
        current();
        const response = result as { content?: string; text?: string; path?: string; truncated?: boolean; canonicalFile?: string };
        if (response.canonicalFile && !this.agent.dotsAnswerEvidenceAllowed({ kind: "file", path: response.canonicalFile }))
          throw new DotsForegroundUnavailable("读取授权在交付之前已撤销");
        const source = input.action === "read_file" ? "file:" + resolvedPathKey(response.canonicalFile!)
          : input.action === "read_material" ? "material:" + input.itemId
          : JSON.stringify([input.action, input.spaceId, input.targetTaskId, input.path]);
        const body = response.content ?? response.text ?? JSON.stringify(result);
        const charge = this.foreground.charge(root.id, call, source,
          JSON.stringify({ action: input.action, spaceId: input.spaceId, path: response.path ?? input.path,
            itemId: input.itemId, version: input.version, offset: input.offset, contentHash: (result as {contentHash?: string}).contentHash }), body);
        reached = charge.exhausted;
        if (input.action === "read_file") {
          const { canonicalFile: _file, ...visible } = response;
          result = { ...visible, content: charge.text, truncated: response.truncated || charge.text.length < body.length };
        } else if (response.text !== undefined) {
          result = { ...response, text: charge.text, truncated: response.truncated || charge.text.length < body.length };
        } else if (charge.text.length < body.length) result = { excerpt: charge.text, truncated: true };
      }
      return { result, reached };
    });
    if (result !== undefined && mayRead() && dotsOperationEnabled(this.agent.getAppSettings().dotsSettings, "answer")) {
      const target = this.waitingForSuppliedFile(input, latest, originConversation);
      if (target) {
        await fresh();
        current();
        if (!dotsOperationEnabled(this.agent.getAppSettings().dotsSettings, "answer"))
          throw new DotsForegroundUnavailable("补充资料的答复授权已撤回");
        const handoff = await this.execute(DOTS_TASK_ID, latest.id, { action: "answer", targetTaskId: target.taskId, operationId: target.operationId },
          latest.text, { conversationId: originConversation, entryId: latest.entryId }, latest.createdAt) as { receipt?: unknown };
        return handoff.receipt ? { details: { foreground: "delegated", handoff }, terminate: true }
          : { details: { foreground: "blocked", message: "补充资料已关联原交办，正在确认原任务受理。" }, terminate: true };
      }
    }
    if (!reached) return { details: result, terminate: false };
    const blocked = (message: string) => ({ details: { foreground: "limit", evidence: result, message }, terminate: true });
    if (input.allowHandoff !== true || !mayDelegate() || isDotsAutomaticInput(root.id))
      return blocked("这次留在当前对话处理。已取得的资料不足以完成请求。");
    const spaceId = input.spaceId ?? (input.targetTaskId ? this.task(input.targetTaskId).spaceId : undefined);
    if (!spaceId) return blocked("还需要核对更多资料。可以在哪个工作空间继续？");
    this.space(spaceId);
    await fresh();
    current();
    if (!mayDelegate()) return blocked("后台任务的授权已撤回，暂时无法继续。");
    if (input.handoffOperationId && !input.targetTaskId)
      return blocked("续办需要同时指定原任务和原交办操作。");
    const prior = this.handoffs.get(root.id);
    const flight = prior ?? this.admitForegroundHandoff(root, inputs, origin, spaceId, input.handoffOperationId ? input.targetTaskId : undefined, input.handoffOperationId);
    if (!prior) this.handoffs.set(root.id, flight);
    try {
      const handoff = await flight as { receipt?: {taskId: string; operationId: string; submissionId: number}; link?: string };
      if (!handoff.receipt) return blocked("暂时无法确认后台任务是否已接手。");
      return { details: { foreground: "delegated", evidence: result, handoff }, terminate: true };
    } finally {
      if (this.handoffs.get(root.id) === flight) this.handoffs.delete(root.id);
    }
  }

  async recoverForegroundHandoffs() {
    for (const saved of this.foreground.unlinked()) {
      const last = saved.inputs.at(-1);
      if (!last || !dotsOperationEnabled(this.agent.getAppSettings().dotsSettings, "delegate")) continue;
      try {
        const receipt = (await this.agent.findSubmission(DOTS_TASK_ID, last.id))?.receipt;
        const [conversation, current] = JSON.parse(await this.agent.dotsInputVersion(DOTS_TASK_ID)) as [number, number];
        if (receipt?.status !== "placed" || receipt.submissionId !== current || conversation !== saved.origin.conversationId) continue;
        for (const input of saved.inputs) this.foreground.state(input.id);
        await this.sendForegroundHandoff(saved);
      } catch (error) { console.warn("[Dots] 恢复前台移交失败", error); }
    }
  }

  private async admitForegroundHandoff(root: ForegroundInput, inputs: readonly ForegroundInput[], origin: DotsReplyOrigin, spaceId: string, targetTaskId?: string, priorOperationId?: string) {
    const reads = this.foreground.state(root.id).reads;
    const request = this.foreground.handoff(root.id, { spaceId, inputs, origin, targetTaskId, priorOperationId,
      text: ["前台达到读取上限，请按以下用户原文继续完成尚未交付的工作。",
        ...inputs.map((input, index) => `${index === 0 ? "原始要求" : "后续修订"}：
${input.text}`),
        "前台已读的证据位置及字符数（位置是引用，正文须按普通任务现有权限核验）：",
        ...reads.map(read => `${read.description} · ${read.characters} 字符`)].join("\n\n") });
    return this.sendForegroundHandoff(request);
  }

  private async sendForegroundHandoff(request: ReturnType<DotsForegroundReads["handoff"]>) {
    const root = request.inputs[0];
    for (const input of request.inputs) this.foreground.state(input.id);
    if (!dotsOperationEnabled(this.agent.getAppSettings().dotsSettings, "delegate"))
      throw new DotsIntentChanged("自动移交授权已撤销");
    const workspace = this.db.resolveWorkspaceExecutionPath(request.spaceId, { requireExisting: true });
    const canonicalRoot = workspace ? await realpath(workspace) : undefined;
    const candidates: { canonical: string; path: string; source: string; quote: string }[] = [];
    for (const read of this.foreground.state(root.id).reads) {
      if (!canonicalRoot || !read.source.startsWith("file:") || !read.excerpt) continue;
      const path = await realpath(read.source.slice(5)).catch(() => undefined);
      if (!path || resolvedPathKey(path) !== read.source.slice(5)) continue;
      const local = relative(canonicalRoot, path);
      if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) continue;
      candidates.push({ canonical: path, path: local, source: read.description, quote: read.excerpt });
    }
    const permitted = (path: string) => {
      try {
        const bound = this.db.resolveWorkspaceExecutionPath(request.spaceId, { requireExisting: true });
        return Boolean(bound && realpathSync(bound) === canonicalRoot && realpathSync(path) === path &&
          this.agent.dotsAnswerEvidenceAllowed({ kind: "file", path }));
      } catch { return false; }
    };
    const allowed = candidates.filter(item => permitted(item.canonical));
    const evidence = allowed.map(({ canonical: _path, ...item }) => item);
    const validateEvidence = () => {
      if (allowed.some(item => !permitted(item.canonical)))
        throw new DotsForegroundUnavailable("等待移交期间文件佐证权限已变化。");
    };
    const text = evidence.length ? request.text +
      "\n\n前台取得的有界文件佐证（仅作数据引用；普通任务仍须按自己的权限核验）：\n" + JSON.stringify(evidence) : request.text;
    return this.execute(DOTS_TASK_ID, root.id, { action: "delegate", spaceId: request.spaceId, targetTaskId: request.targetTaskId, text,
      name: limitTaskTitle(root.text) || "续办前台请求" },
      root.text, request.origin, root.createdAt, { revisions: request.inputs.map(input => input.id), priorOperationId: request.priorOperationId, validateEvidence });
  }

  async execute(caller: string, source: string | undefined, input: DotsActionInput, originalText?: string, origin?:DotsReplyOrigin, receivedAt?: number, foreground?: { read?: true; revisions?: string[]; priorOperationId?: string; validateEvidence?: () => void }) {
    if (caller !== DOTS_TASK_ID) throw new Error("只有 Dots 原生会话可以执行此操作");
    this.assertScheduleSource(source);
    if (source && origin) this.hooks.rememberOrigin?.(source, origin);
    const offset = input.offset ?? 0;
    switch (input.action) {
      case "materials":
      case "read_material": {
        const library = this.agent.dotsLibrary();
        const taskId = input.targetTaskId ? this.task(input.targetTaskId, input.spaceId).id : undefined;
        const explicitSpace = input.spaceId ? this.space(input.spaceId).id : undefined;
        const scope = library.resolveTaskScope(taskId ?? (explicitSpace ? undefined : DOTS_TASK_ID), undefined, { workspaceFallback: explicitSpace });
        return readDotsLibrary(library, scope, { query: input.query, version: input.version,
          itemId: input.action === "read_material" ? required(input.itemId, "资料 ID") : undefined }, (id, spaceId) => {
          if (this.preferences.spaceIds === null) return true;
          const item = library.getItem(id);
          const owner = library.getSpace(item?.spaceId ?? spaceId ?? "");
          const taskId = item?.sourceTaskId;
          const originSpace = taskId ? this.db.getTask(taskId)?.spaceId : undefined;
          return Boolean(owner && (owner.workspaceId ? this.allowsSpace(owner.workspaceId)
            : taskId ? this.allowsSpace(originSpace) : !owner.projectId));
        });
      }
      case "file_watches": return this.watches.list(input.targetTaskId).filter(row => {
        const task = this.db.getTask(row.taskId);
        return task && this.allowsSpace(task.spaceId) && this.ordinary(task) && !this.db.isTaskEffectiveArchived(task.id) && task.spaceId === row.spaceId &&
          (!input.spaceId || row.spaceId === input.spaceId) && this.db.getTaskExecutionWorkspaceState(task.id)?.state !== "trashed";
      });
      case "deliveries": {
        const query = input.query?.trim().toLowerCase() ?? "";
        const links = this.hooks.list?.() ?? [];
        const candidates = (input.cursor ? [] : links).filter(item => !input.targetTaskId || item.taskId === input.targetTaskId);
        const hits: Array<NativeResultHit | Pick<DotsDelegation, "title" | "text" | "artifacts" | "taskId" | "goalId"> & {
          status: ReturnType<DotsActions["delegationResult"]>["status"];
          operationId: string; link: string }> = [];
        for (const item of candidates.reverse()) {
          const task = this.db.getTask(item.taskId);
          if (!task || !this.allowsSpace(task.spaceId) || !this.ordinary(task) || this.db.isTaskEffectiveArchived(task.id) ||
            this.db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed" || (input.spaceId && task.spaceId !== input.spaceId)) continue;
          const result = this.delegationResult(item);
          if (query && ![item.title, result.text, ...item.artifacts.map(file => file.name)]
            .some(value => value.toLowerCase().includes(query))) continue;
          hits.push({ operationId: item.id, taskId: task.id, goalId: item.goalId, link: taskLink(task), status: result.status, title: item.title,
            text: result.text.slice(0, 1200), artifacts: item.artifacts.slice(0, 10) });
          if (hits.length === offset + 21) break;
        }
        const page = this.board.page({view:"all", scope:input.spaceId, cursor:input.cursor}, Date.now(),
          {taskId:input.targetTaskId,spaceIds:this.preferences.spaceIds});
        const delegated = new Set(links.map(item => item.id));
        const batch = page.rows.slice(0,4);
        const last = batch.at(-1);
        const next = last && page.rows.length > batch.length ? {rank:last.rank, at:last.at, id:last.id} : page.next;
        for (const row of batch) {
          if (hits.length >= offset + 21) break;
          const task = this.db.getTask(row.id);
          if (!task || !this.ordinary(task)) continue;
          const binding = this.db.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").get(task.id) as {directory:string} | undefined;
          if (!binding) continue;
          const found = await nativeResultHits({...task, link:taskLink(task)}, binding.directory, query, delegated, offset + 21 - hits.length, this.db.connection);
          this.task(task.id, input.spaceId);
          hits.push(...found);
        }
        const visible = hits.filter(hit => this.allowsResult(hit.taskId));
        const nextOffset = visible.length > offset + 20 ? offset + 20 : undefined;
        return { results: visible.slice(offset, offset + 20), more: Boolean(nextOffset || next),
          nextOffset, next: nextOffset ? undefined : next };
      }
      case "board": {
        const page = this.board.page({ view: input.view ?? "all", scope: input.spaceId, search: input.query,
          dateKind: input.dateKind, from: input.from, until: input.until, cursor: input.cursor }, Date.now(), {spaceIds:this.preferences.spaceIds});
        return { tasks: page.rows.map(row => ({ ...row, link: taskLink(row) })), next: page.next };
      }
      case "task": {
        const task = this.task(input.targetTaskId, input.spaceId);
        const progress = this.board.page({ view: "all" }, Date.now(), { taskId: task.id }).rows[0];
        const history = await this.agent.loadTaskHistory(task.id, undefined, "current");
        this.task(task.id, input.spaceId);
        const goals = this.agent.getConversationGoals().listByTask(task.id).map(({ id, title, description, status, criteria }) => ({
          id, title, description, status, criteria,
        }));
        const summary = this.summary(task);
        return { ...summary, progress: summary.status === "waiting_input" && progress
          ? { ...progress, status: summary.status, unread: false, wait: progress.wait ?? { kind: "input" } } : progress,
          goals, deliveries: this.deliveries(task), messages: history.messages.slice(-5).map(m => ({ role: m.role, text: m.text.slice(-2400), artifacts: m.artifacts })),
          artifacts: history.artifacts, historyError: history.historyError };
      }
      case "spaces": return this.db.listSpaces().filter(s => this.allowsSpace(s.id) && !s.effectiveArchived && this.isLocalSpace(s)).map(spaceLink);
      case "files":
      case "read_file": {
        const space = this.space(input.spaceId);
        const binding = () => required(this.db.resolveWorkspaceExecutionPath(this.space(space.id).id, { requireExisting: true }) ?? undefined, "已绑定的空间目录");
        const path = binding();
        const root = await realpath(path);
        const name = input.action === "files" ? (input.path?.trim() || ".") : required(input.path, "相对文件路径");
        if (isAbsolute(name)) throw new Error("请输入空间内的相对路径");
        const selected = await realpath(resolve(root, name));
        const local = relative(root, selected);
        if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) throw new Error("文件超出绑定目录");
        const checkBinding = () => {
          if (resolvedPathKey(binding()) !== resolvedPathKey(path)) throw new Error("读取期间空间已改绑");
          if (!this.agent.dotsAnswerEvidenceAllowed({kind:"file",path:selected})) throw new Error("文件属于未授权给 Dots 的空间");
        };
        checkBinding();
        if (input.action === "files") {
          const entries = await listWorkspaceFiles(selected, 0);
          checkBinding();
          const visible = this.preferences.spaceIds === null ? entries
            : entries.filter(({name}) => this.agent.dotsAnswerEvidenceAllowed({kind:"file",path:resolve(selected,name)}));
          return { files: visible.slice(offset, offset + 100).map(({name,kind}) => ({name,kind,path:relative(root,resolve(selected,name))})),
            nextOffset: visible.length > offset + 100 ? offset + 100 : undefined };
        }
        const data = await readWorkspaceFile(root, local, true);
        checkBinding();
        return { ...(foreground?.read ? { canonicalFile: selected } : {}), path: local, content: data.content.slice(offset, offset + 12000), more: offset + 12000 < data.content.length, truncated: data.truncated };
      }
    }
    const sourceId = required(source, "唯一的原始 Dots 消息");
    if (input.action === "pause_proactive" || input.action === "resume_proactive") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("主动跟进策略需要用户明确交代");
      if (input.spaceId) this.space(input.spaceId);
      const scope = input.spaceId ?? "";
      const pause = input.action === "pause_proactive";
      const key = JSON.stringify([sourceId,input.action,scope]);
      const prior = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=?").get(key) as {outcome:string} | undefined;
      if (prior) return JSON.parse(prior.outcome) as {scope:string;proactive:string;schedules:Array<{id:string;state:string}>};
      const saved = this.db.connection.prepare("SELECT timer_ids FROM dots_proactive_pauses WHERE scope=?").get(scope) as {timer_ids:string} | undefined;
      const ids: string[] = saved ? JSON.parse(saved.timer_ids) : pause ? this.agent.dotsScheduleIds(false, scope ? { spaceId: scope } : undefined) : [];
      const schedules = this.db.connection.transaction(() => {
        if (pause) this.db.connection.prepare("INSERT OR IGNORE INTO dots_proactive_pauses VALUES(?,?)").run(scope,JSON.stringify(ids));
        else this.db.connection.prepare("DELETE FROM dots_proactive_pauses WHERE scope=?").run(scope);
        const existing = new Set(this.agent.dotsScheduleIds());
        const rows = ids.filter(id => existing.has(id)).map(id => ({ id, state: this.agent.holdDotsSchedule(id, "proactive:" + scope, pause) }));
        const receipt = {scope:scope || "all",proactive:pause ? "paused" : "enabled", schedules:rows};
        this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,?)").run(key,DOTS_TASK_ID,JSON.stringify(receipt));
        return rows;
      })();
      if (!pause) this.watches.refresh();
      this.hooks.changed?.();
      return { scope:scope || "all", proactive:pause ? "paused" : "enabled", schedules };
    }
    if (input.action === "stop_all" || input.action === "pause_all") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("批量控制需要用户明确交代");
      return this.controlBatch(sourceId, input.action === "pause_all" ? "pause" : "stop", input.spaceId);
    }
    if (input.action === "watch_file" || input.action === "cancel_watch") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("需要用户明确交代文件订阅");
      const task = this.task(input.targetTaskId, input.spaceId, input.action === "cancel_watch");
      if (input.action === "cancel_watch") {
        const result = this.watches.cancel(required(input.watchId, "订阅 ID"), task.id);
        return this.allowsSpace(task.spaceId) ? result : { state: "cancelled" };
      }
      const space = this.space(required(task.spaceId ?? undefined, "原任务工作空间"));
      return this.watches.create({ taskId: task.id, spaceId: space.id, file: required(input.path, "订阅文件相对路径"),
        instruction: required(input.text, "文件变化后的任务要求"), source: sourceId });
    }
    const digest = (value: string) => dotsRequestDigest(sourceId, value);
    if (input.action === "create_space") {
      const parent = this.space(input.spaceId);
      const name = assertSafeEntryName(required(input.name, "新空间名称"));
      const root = this.db.resolveWorkspaceExecutionPath(parent.id, { requireExisting: true });
      if (!root) throw new Error("请指定已经绑定目录的父空间");
      const canonicalRoot = await realpath(root);
      const folder = resolve(canonicalRoot, name);
      if (resolvedPathKey(dirname(folder)) !== resolvedPathKey(canonicalRoot)) throw new Error("新文件夹必须直接位于父空间内");
      const id = "sp-dots-" + digest(JSON.stringify(["create_space", parent.id, name]));
      const existing = () => this.db.getSpace(id) ?? this.db.findChildSpaceByName(parent.id, name);
      const checkSpace = (space: SpaceDto) => {
        if (space.parentId !== parent.id || !space.path || resolvedPathKey(space.path) !== resolvedPathKey(folder))
          throw new Error("同名空间已绑定其他目录");
        return this.space(space.id);
      };
      const prior = existing();
      if (prior) checkSpace(prior);
      else {
        if (!this.agent.dotsAnswerEvidenceAllowed({kind:"file",path:folder}))
          throw new Error("新文件夹属于未授权给 Dots 的空间");
        try { await mkdir(folder); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const canonicalFolder = await realpath(folder);
      if (!(await lstat(folder)).isDirectory() || resolvedPathKey(canonicalFolder) !== resolvedPathKey(folder))
        throw new Error("同名路径必须是父空间内的实际目录");
      this.space(parent.id);
      if (this.db.resolveWorkspaceExecutionPath(parent.id, { requireExisting: true }) !== root)
        throw new Error("创建期间父空间的绑定已更改");
      const current = existing();
      if (!this.agent.dotsAnswerEvidenceAllowed({kind:"file",path:canonicalFolder}))
        throw new Error("新文件夹属于未授权给 Dots 的空间");
      const child = current ? checkSpace(current) : this.db.createSpace({ id, name, path: folder, parentId: parent.id });
      this.hooks.changed?.();
      return spaceLink(child);
    }
    if (input.action === "bind") {
      if (this.preferences.spaceIds !== null) this.space(input.spaceId);
      const requested = required(input.path, "指定文件夹");
      if (!isAbsolute(requested)) throw new Error("请提供指定文件夹的绝对路径");
      const operation = digest(JSON.stringify(["bind", input.spaceId ?? input.name, resolve(requested)]));
      const previous = this.spaceReceipt(operation);
      if (previous) return previous;
      const path = await realpath(requested);
      if (!(await stat(path)).isDirectory()) throw new Error("指定路径不是文件夹");
      return this.changeSpaceOnce(operation, () => {
        if (!this.agent.dotsAnswerEvidenceAllowed({kind:"file",path}))
          throw new Error("目标目录属于未授权给 Dots 的空间");
        let space = input.spaceId ? this.space(input.spaceId) : undefined;
        if (!space) {
          const name = required(input.name, "空间名称");
          space = this.db.findRootSpaceByName(name);
          if (space) space = this.space(space.id);
          else space = this.db.createSpace({ id: "sp-dots-" + digest(name), name, path });
        }
        if (space.path !== path) this.db.upsertSpace({ ...space, path });
        return space.id;
      });
    }
    if (input.action === "rename") {
      const name = required(input.name, "新名称");
      return this.changeSpaceOnce(digest(JSON.stringify(["rename", input.spaceId, name])), () => {
        const space = this.space(input.spaceId);
        this.db.renameSpace(space.id, name);
        return space.id;
      });
    }
    const continuingTask = !foreground && !isDotsAutomaticInput(sourceId) && input.targetTaskId
      && (input.action === "resume" || input.action === "delegate") ? this.task(input.targetTaskId) : undefined;
    // Retries of one user input read the first staged request, independent of the model's wording or tool alias.
    const continuationIdentity = continuingTask ? digest(JSON.stringify(["continue-task", continuingTask.id])) : undefined;
    let continuationBase: string | null | undefined;
    if (continuingTask && continuationIdentity) {
      const quote = input.assignmentQuote?.trim();
      continuationBase = this.continuationTarget(sourceId, continuingTask.id, originalText, quote && originalText?.includes(quote) ? quote : undefined);
      const operationId = "dots-input-" + continuationIdentity;
      const replay = this.db.connection.prepare("SELECT status,request_json,text,goal_id FROM dots_delegations WHERE operation_id=? AND task_id=?")
        .get(operationId, continuingTask.id) as {status: DotsDelegation["status"]; request_json: string | null; text: string; goal_id: string | null} | undefined;
      if (replay) {
        const accepted = await this.agent.findSubmission(continuingTask.id, operationId);
        if (accepted?.receipt) return this.delegationAdmission(continuingTask, operationId, accepted, replay.goal_id ?? undefined);
        if (replay.status === "failed") throw new Error(replay.text || "原任务未接收本次重跑，请在确认后发送新的重跑请求");
        const result = replay.status === "pending" && replay.request_json
          ? await this.agent.prompt(JSON.parse(replay.request_json) as AgentPromptRequest, { durableAdmissionOnly: true }) : undefined;
        return this.delegationAdmission(continuingTask, operationId, result, replay.goal_id ?? undefined);
      }
      const restored = await this.resumeFinishedTurn(continuingTask, operationId);
      if (restored) return restored;
      if ((input.operationId && input.operationId !== continuationBase) || this.latestOperation(continuingTask.id) !== continuationBase)
        throw new DotsIntentChanged("原任务的交办已变化，请核对当前进度后重跑");
    }
    let unblocked: { id: string; source: string } | undefined;
    if (input.action === "answer" || input.targetTaskId && ["steer", "delegate", "resume"].includes(input.action)) {
      const target = this.task(input.targetTaskId, input.spaceId);
      const latest = this.db.connection.prepare(`SELECT operation_id AS id, source_message_id AS source, status
        FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1`).get(target.id) as
        { id: string; source: string; status: DotsDelegation["status"] } | undefined;
      const explicitAnswer = input.action === "answer";
      const answerOp = explicitAnswer ? required(input.operationId, "委派操作 ID") : latest?.id;
      const priorAnswer = digest(JSON.stringify(["dots-answer-input", target.id, sourceId]));
      if (this.db.connection.prepare("SELECT 1 FROM dots_control_receipts WHERE operation_id=? AND outcome='answered'").get(priorAnswer))
        return { ...this.summary(target), operationId: answerOp, interactionId: input.interactionId, answered: true };
      const priorBlocked = explicitAnswer ? answerOp : this.followups.latestPlan(target.id)?.parent;
      if (priorBlocked) {
        const continuation = "dots-input-" + digest(JSON.stringify(["answer-blocked", priorBlocked, sourceId]));
        if (this.db.connection.prepare("SELECT 1 FROM dots_delegations WHERE operation_id=? AND task_id=? AND status NOT IN ('failed','superseded')")
          .get(continuation, target.id)) {
          const admission = await this.agent.findSubmission(target.id, continuation);
          return admission?.receipt ? { ...this.summary(target), receipt: admission.receipt, queued: admission.queued }
            : { operationId: continuation, taskId: target.id, admission: "pending", message: "补充资料已关联原交办，正在确认原任务受理。" };
        }
      }
      if (explicitAnswer && latest?.id !== answerOp) throw new Error("原问题不属于当前 Dots 委派");
      const pending = () => this.agent.getConversationRuntimeSnapshot(target.id).interactions.filter(row => row.status === "pending");
      if (latest && (explicitAnswer || latest.status === "blocked" || pending().length)) {
        const active = await this.agent.dotsSubmission(target.id, latest.id);
        const interactionId = active?.interactionId;
        if (interactionId) {
          if (isDotsAutomaticInput(sourceId)) throw new Error("此问题需要用户直接回答");
          if (explicitAnswer && input.interactionId !== interactionId) throw new Error("原委派当前未等待此问题");
          const question = pending().find(row => row.id === interactionId);
          if (!question) throw new Error("原问题已经变化，请读取原任务的当前状态");
          const answer = explicitAnswer ? userAnswer(question, required(originalText, "用户原话"))
            : question.kind === "single_select" && originalText ? singleChoice(question, originalText) : undefined;
          if (answer !== undefined) return this.recordAnswer(target, sourceId, latest.id, question, answer);
          return { ...this.summary(target), operationId: latest.id, interactionId, answered: false, question,
            message: "原任务在等这个问题。若用户正在回答，请使用 answer 和原问题 ID，不能改向或重开。" };
        }
        if (active?.status === "blocked" && !pending().length && !isDotsAutomaticInput(sourceId)
          && (explicitAnswer || input.action === "resume" || input.action === "steer")) {
          unblocked = latest;
          input = { ...input, action: "resume", text: required(originalText, "用户补充的原话") };
        } else if (active?.status === "blocked") {
          return { ...this.summary(target), operationId: latest.id, answered: false,
            message: "原任务正在等补充资料。用户已补齐时，请对这个操作调用 answer 接续原交办。" };
        } else if (explicitAnswer || pending().length) throw new Error("原任务仍有未确认的等待状态，请读取当前问题");
      } else if (explicitAnswer) throw new Error("原委派当前未等待问题");
    }
    const text = input.action === "resume" ? input.text?.trim() || "继续之前暂停的任务。" : input.text?.trim();
    const steps=input.steps?.map(value=>required(value,"续办步骤"))??[];
    if(steps.length && (input.goalId||input.action!=="delegate"||steps.length<2||steps.length>8))throw new Error("单次委派可固定 2 至 8 个步骤，已有 Goal 由原任务推进");
    if(steps.length && (!originalText || steps.some(step=>!originalText.includes(step))))throw new Error("各步骤需引用本次用户交办中的原文");
    const acceptanceQuote = input.goalUserAcceptanceQuote?.trim();
    if (acceptanceQuote && (!input.goalId || !originalText?.includes(acceptanceQuote) || isDotsAutomaticInput(sourceId)))
      throw new Error("需引用本轮用户明确约定由自己验收的原文");
    const deliveryInstruction = input.deliveryInstruction?.trim();
    if (deliveryInstruction && (!originalText?.includes(deliveryInstruction) || isDotsAutomaticInput(sourceId)))
      throw new Error("请从用户本轮原话引用适用于该任务的交付要求");
    const creating = input.action === "delegate" && !input.targetTaskId;
    const requestedQuote = creating ? input.assignmentQuote?.trim() : undefined;
    const assignment = requestedQuote ?? (creating && text && originalText?.includes(text) ? text : undefined);
    if (assignment && !originalText?.includes(assignment)) throw new Error("分别派工时请引用原消息中该事项的原文");
    const firstQuote = creating ? input.previousAssignmentQuote?.trim() : undefined;
    if (firstQuote && (!assignment || !originalText?.includes(firstQuote))) throw new Error("请同时引用本条消息中两个事项的原话");
    if (creating) this.assertSeparateContinuation(sourceId, originalText, assignment);
    // The source is already part of digest(). A rephrased plan is the same assignment.
    let identity = continuationIdentity ?? (foreground?.priorOperationId ? digest(JSON.stringify(["foreground-continue", input.targetTaskId, foreground.priorOperationId])) : creating
      ? digest(JSON.stringify(["delegate", input.spaceId, assignment ?? ""]))
      : digest(JSON.stringify([...(acceptanceQuote ? [acceptanceQuote] : []),...(deliveryInstruction ? [deliveryInstruction] : []),...(steps.length?[steps]:[]),...(input.memoryRefs?.length ? [input.memoryRefs] : []), input.action, input.spaceId, input.targetTaskId, input.goalId, undefined, text])));
    let task: TaskDto;
    let newTask = false;
    if (input.goalId && !input.targetTaskId) throw new Error("请指定该 Goal 的原任务");
    if (input.action === "delegate" && !input.targetTaskId) {
      const space = this.space(input.spaceId);
      const prior = this.db.connection.prepare(`SELECT d.operation_id, json_extract(p.plan,'$.assignment') AS assignment,
        json_extract(p.plan,'$.assignmentQuote') AS quote
        FROM dots_delegations d LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id
        WHERE d.source_message_id=? AND d.space_id=? AND d.task_id='dots-job-' || substr(d.operation_id,12) ORDER BY d.seq`)
        .all(sourceId, space.id) as Array<{operation_id: string; assignment?: string; quote?: string}>;
      const defaultOperation = "dots-input-" + digest(JSON.stringify(["delegate", space.id, ""]));
      const fallback = prior.find(row => row.operation_id === defaultOperation);
      let priorOperation: string | undefined;
      if (assignment) {
        const existing = prior.find(row => row.quote === assignment || row.operation_id === "dots-input-" + identity);
        if (existing) priorOperation = existing.operation_id;
        else if (fallback && !fallback.quote) {
          if (fallback.assignment === assignment || fallback.assignment === text || originalText?.trim() === assignment) {
            this.followups.anchorAssignment(defaultOperation, assignment);
            priorOperation = defaultOperation;
          } else if (firstQuote && originalText && this.separateAssignments(originalText, firstQuote, assignment)) {
            this.followups.anchorAssignment(defaultOperation, firstQuote);
          } else {
            throw new Error("同一条消息已有委派「" + fallback.assignment + "」。若为重试，请沿用原任务；若要分别派工，请同时给出 previousAssignmentQuote（已有事项原文）和 assignmentQuote（另一事项原文）。");
          }
        } else if (originalText && prior.some(row => row.quote && !this.separateAssignments(originalText, row.quote, assignment))) {
          throw new Error("事项原文重叠或出现多次，请使用原任务或引用可唯一定位的独立事项");
        }
      } else {
        const exact = prior.filter(row => row.assignment === text);
        if (prior.length > 1 && exact.length !== 1) throw new Error("这条交办已有多个普通任务，请引用对应事项的原话");
        priorOperation = (exact[0] ?? prior[0])?.operation_id;
      }
      if (priorOperation) identity = priorOperation.slice("dots-input-".length);
      const title = limitTaskTitle(input.name?.trim() || required(text, "任务要求"));
      const id = "dots-job-" + identity;
      required(text, "任务要求");
      if (!this.db.getTask(id)) {
        if (this.db.connection.prepare("SELECT 1 FROM dots_delegations WHERE task_id=?").get(id))
          throw new Error("原任务已删除");
        // 可预期的失败（默认模型在该工作空间不可用等）必须在建任务之前抛出：
        // 先建记录再校验会让异常路径把一条 pending 空壳永久留在看板「排队中」。
        await this.agent.assertDelegationAdmissible(space.id);
        this.db.upsertTask({ id, spaceId: space.id, title, updatedAt: Date.now() });
        newTask = true;
      }
      task = this.task(id, space.id);
    } else task = this.task(input.targetTaskId, input.spaceId, input.action === "stop" || input.action === "pause");
    if (input.action === "stop" || input.action === "pause") return this.controlTask(task, input.action, identity);
    const goals = this.agent.getConversationGoals();
    const continuePlan = input.action === "resume" || Boolean(continuingTask && !steps.length && !input.goalId && !this.agent.isTaskBusy(task.id));
    if (continuePlan && continuationBase) this.assertContinuationScope(task, continuationBase);
    const priorGoal = input.action === "steer" || continuePlan ? this.db.connection.prepare(
      "SELECT goal_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1",
    ).get(task.id) as { goal_id: string | null } | undefined : undefined;
    const requestedGoalId = input.goalId ?? priorGoal?.goal_id;
    const goal = requestedGoalId ? goals.getLive(task.id, requestedGoalId) : undefined;
    if (input.goalId && !goal) throw new Error("该 Goal 不属于原任务");
    const message = required(text, "任务要求");
    const priorPlan = continuePlan || input.action === "steer" ? this.followups.latestPlan(task.id) : undefined;
    const resumed = continuePlan ? priorPlan : undefined;
    const currentDeliveryInstruction = deliveryInstruction ?? priorPlan?.deliveryInstruction;
    if (unblocked && !continuationIdentity) identity = digest(JSON.stringify(["answer-blocked", unblocked.id, sourceId]));
    const operationId = "dots-input-" + identity;
    const deliverySource = unblocked?.source ?? sourceId;
    if (input.action === "resume" && isDotsAutomaticInput(sourceId)) throw new Error("暂停后的恢复需要用户明确交代");
    if (input.action === "resume" && !input.text?.trim() && !input.goalId && !deliveryInstruction && !input.memoryRefs?.length) {
      const restored = await this.resumeFinishedTurn(task, operationId, resumed?.request.userMessageId);
      if (restored) return restored;
    }
    const previous = newTask ? undefined : await this.agent.findSubmission(task.id, operationId);
    if ((creating || foreground?.revisions || continuationIdentity) && previous) {
      if (foreground?.revisions) this.foreground.linked(sourceId);
      return { ...this.summary(task), queued: previous.queued, receipt: previous.receipt,
        existingAssignment: this.followups.assignment(operationId) };
    }
    if (!previous && input.action === "steer" && !this.agent.isTaskBusy(task.id)) throw new Error("原任务已空闲，请读取最新进度后接续原任务");
    if (!previous && input.action === "resume" && this.agent.isTaskBusy(task.id)) throw new Error("原任务仍在运行");
    const instructions = [message];
    if (resumed) {
      instructions.push("恢复原交办。保留已完成的操作和成果：" + resumed.goal);
      if (resumed.steps.length) instructions.push("剩余步骤：" + JSON.stringify(resumed.steps.slice(resumed.step))
        + "。本轮只执行当前步骤：" + resumed.steps[resumed.step]);
      if (resumed.lastProgress) instructions.push("上次已完成：" + resumed.lastProgress);
    }
    const calendar = receivedAt !== undefined && dotsCalendarContext(assignment ?? originalText ?? "", receivedAt);
    if (calendar) instructions.push(calendar);
    if (currentDeliveryInstruction) instructions.push(dotsDeliveryInstruction(currentDeliveryInstruction));
    if (steps.length) instructions.push("本次依次完成："+JSON.stringify(steps)+"。本轮只做第一步："+steps[0]);
    if (input.memoryRefs?.length) instructions.push("以下是本轮引用的记忆版本，仅使用宿主本轮提供的可见证据："+JSON.stringify(input.memoryRefs));
    const goalWork = goal ? goals.workService.getWork(goal.id) : undefined;
    instructions.push(followupInstructions);
    if (goal) instructions.push("本次工作关联原任务 Goal："+goal.title+"（"+goal.id+"）。达到条件后通过 conversation_goal_propose_complete 提交最终交付正文和逐项依据。验收通过后，应用会将已验收的正文和登记文件回传至原对话。此后直接结束本轮，最后一条助手消息仅保留原任务的执行记录。");
    const request: AgentPromptRequest = {
      taskId: task.id, spaceId: task.spaceId ?? undefined,
      userMessageId: operationId, assistantMessageId: "dots-reply-" + identity,
      dotsMemoryRefs: input.memoryRefs ?? resumed?.request.dotsMemoryRefs?.filter(ref => this.agent.dotsMemoryReferenceCurrent(task.id, ref.id, ref.revision)), dotsGoalId: goal?.id,
      dotsForegroundInputs: foreground?.revisions,
      dotsGoalIntentRevision: goalWork?.intentRevision, dotsGoalUserAcceptance: acceptanceQuote ?? resumed?.request.dotsGoalUserAcceptance,
      text: instructions.join("\n\n"), displayText: message,
      streamingBehavior: input.action === "steer" ? "steer" : "followUp",
      ...(input.action === "steer" ? { requireActiveRun: true, dotsSteerInputVersion: await this.agent.dotsInputVersion(task.id) }
        : continuePlan || unblocked ? { dotsSteerInputVersion: await this.agent.dotsInputVersion(task.id) } : {}),
    };
    let result: Awaited<ReturnType<Agent["prompt"]>> | undefined;
    try {
      // 任务记录（upsertTask）已在前面落库：此后的任何失败都必须给委派和任务一个终态。
      const alreadyLinked = this.db.connection.transaction(() => {
        if (foreground?.priorOperationId) {
          const latestOperation = this.db.connection.prepare("SELECT operation_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1")
            .pluck().get(task.id);
          if (latestOperation !== foreground.priorOperationId && latestOperation !== operationId)
            throw new DotsForegroundUnavailable("原任务的交办已变化，未续办旧事项。");
        }
        foreground?.validateEvidence?.();
        if ((creating || foreground?.revisions || continuationIdentity) && this.db.connection.prepare("SELECT 1 FROM dots_delegations WHERE operation_id=?").get(operationId)) {
          if (foreground?.revisions) this.foreground.linked(sourceId);
          return true;
        }
        if (continuationIdentity && this.latestOperation(task.id) !== continuationBase)
          throw new DotsIntentChanged("接续期间原任务已有更新，请读取当前进度");
        if (continuePlan && continuationBase) this.assertContinuationScope(this.task(task.id, task.spaceId ?? undefined), continuationBase);
        if (!previous && input.action === "resume") {
          if (this.followups.latestPlan(task.id)?.request.userMessageId !== resumed?.request.userMessageId)
            throw new DotsIntentChanged("接续期间原任务已有更新，请读取当前进度");
          if (unblocked && resumed?.request.userMessageId !== unblocked.id)
            throw new DotsIntentChanged("待补资料的原交办已变化，请读取当前问题");
          if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("暂停后的恢复需要用户明确交代");
          this.db.connection.prepare("UPDATE dots_target_controls SET operation_id=? WHERE task_id=?").run(operationId, task.id);
        }
        if (!previous) {
          this.assertScheduleSource(sourceId);
          this.assertAdmission(request);
        }
        if (resumed) this.followups.rememberResume(request, deliverySource, resumed,
          [input.text?.trim(), calendar].filter(Boolean).join("\n"), currentDeliveryInstruction, Boolean(unblocked));
        else this.followups.remember(request, sourceId, [message, calendar].filter(Boolean).join("\n"), steps, currentDeliveryInstruction);
        if (creating && assignment) this.followups.anchorAssignment(operationId, assignment);
        this.link(request, deliverySource, input.action === "steer" || continuePlan || Boolean(foreground?.priorOperationId));
        if (foreground?.revisions) this.foreground.linked(sourceId);
        return false;
      })();
      const persisted = alreadyLinked && (foreground?.revisions || continuationIdentity) ? this.db.connection.prepare(
        "SELECT request_json FROM dots_delegations WHERE operation_id=? AND status='pending'"
      ).pluck().get(operationId) as string | undefined : undefined;
      result = previous ?? await (alreadyLinked
        ? (async () => await this.agent.findSubmission(task.id, operationId) ??
            (persisted ? this.agent.prompt(JSON.parse(persisted) as AgentPromptRequest, { durableAdmissionOnly: true }) : undefined))()
        : this.agent.prompt(request, { durableAdmissionOnly: true }));
    } catch (error) {
      this.abandonDelegation(task.id, operationId, error, newTask);
      throw error;
    }
    return this.delegationAdmission(task, operationId, result, goal?.id);
  }

  /**
   * 建任务之后才发生的失败（模型解析、运行时缺失、执行目录不可用等）：
   * 给这条委派写下失败原因，并把「本次刚建、从未开始执行」的空壳任务移出排队。
   * 已有内容的原任务只记本次失败，不改它自己的状态。
   */
  private abandonDelegation(taskId: string, operationId: string, error: unknown, createdTask: boolean): void {
    const reason = (error instanceof Error ? error.message : String(error ?? "")).trim() || "委派未受理";
    this.hooks.failed?.(taskId, operationId, reason);
    if (createdTask) this.failUndelegatedTask(taskId, reason);
    this.hooks.changed?.();
  }

  /** 从未开始执行的任务直接进终态：看板离开 pending，失败原因随卡片与通知可见；重跑时仍可复用同一任务。 */
  private failUndelegatedTask(taskId: string, reason: string): void {
    const task = this.db.getTask(taskId);
    if (!task) return;
    const updated = this.db.connection.prepare("UPDATE tasks SET status='failed',updated_at=? WHERE id=? AND (status IS NULL OR status IN ('planning','pending'))")
      .run(Date.now(), taskId);
    if (!updated.changes) return;
    this.hooks.failedTask?.({ taskId, title: task.title, reason });
  }

  private separateAssignments(source: string, first: string, second: string) {
    const a = source.indexOf(first);
    const b = source.indexOf(second);
    return a >= 0 && b >= 0 && a === source.lastIndexOf(first) && b === source.lastIndexOf(second)
      && (a + first.length <= b || b + second.length <= a);
  }

  private spaceReceipt(operation: string) {
    const id = this.db.connection.prepare("SELECT target_task_id FROM dots_control_receipts WHERE operation_id=? AND outcome='space_changed'").pluck().get(operation) as string | undefined;
    return id ? spaceLink(this.space(id)) : undefined;
  }

  private changeSpaceOnce(operation: string, mutate: () => string) {
    const space = this.db.connection.transaction(() => {
      const saved = this.spaceReceipt(operation);
      if (saved) return saved;
      const id = mutate();
      this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,'space_changed')").run(operation, id);
      return spaceLink(this.space(id));
    })();
    this.hooks.changed?.();
    return space;
  }

  private async controlTask(task: TaskDto, action: "pause" | "stop", identity: string, expected?: string | null) {
      const outcome = (control: string) => this.allowsResult(task.id)
        ? { ...this.summary(task), control, resumedBy: "resume" }
        : { id: task.id, control };
      const existing = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=?").get(identity) as { outcome: string } | undefined;
      if (existing) return outcome(existing.outcome);
      if (!this.allowsResult(task.id) && expected === undefined) {
        const last = (this.hooks.list?.() ?? []).filter(row => row.taskId === task.id).at(-1);
        const hasFollowups = this.watches.list(task.id).length || this.agent.dotsScheduleIds(false,{taskId:task.id}).length;
        if (!last && !hasFollowups) throw new Error("没有可控制的既有 Dots 事项");
        expected = null;
        if (last && ["pending","running","blocked"].includes(last.status)) {
          const receipt = (await this.agent.findSubmission(task.id,last.id))?.receipt;
          const version = await this.agent.dotsInputVersion(task.id);
          if (receipt && JSON.parse(version)[1] === receipt.submissionId) expected = version;
        }
      }
      this.db.connection.transaction(() => {
        this.watches.controlTarget(task.id, action);
        for (const id of this.agent.dotsScheduleIds(false, {taskId: task.id})) {
          if (action === "stop") this.agent.controlDotsSchedule(id, "stop");
          else this.agent.holdDotsSchedule(id, "task:" + task.id, true);
        }
        this.db.connection.prepare("INSERT INTO dots_control_receipts(operation_id,target_task_id,outcome) VALUES(?,?,?)").run(identity, task.id, "stop_outcome_unknown");
        this.db.connection.prepare(`INSERT INTO dots_target_controls(task_id,state,operation_id) VALUES(?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id`).run(task.id, action === "pause" ? "paused" : "stopped", identity);
      })();
      const control = expected === null ? "future_work_only" : await this.agent.stopDotsTarget(task.id, expected);
      this.db.connection.prepare("UPDATE dots_control_receipts SET outcome=? WHERE operation_id=?").run(control, identity);
      this.hooks.changed?.();
      return outcome(control);
  }

  private async controlBatch(source: string, action: "pause" | "stop", spaceId?: string) {
    if (spaceId) this.space(spaceId, true);
    const id = JSON.stringify([source, action, spaceId]);
    type Selection = { tasks: Array<{ taskId: string; expected: string | null }>; schedules: string[] };
    const saved = this.db.connection.prepare("SELECT selection FROM dots_control_batches WHERE id=?").get(id) as {selection:string} | undefined;
    let selection: Selection;
    if (saved) selection = JSON.parse(saved.selection);
    else {
      const unsettled = new Set(this.db.connection.prepare("SELECT DISTINCT operation_id FROM dots_reply_events WHERE settled=0")
        .pluck().all() as string[]);
      const linked = new Map((this.hooks.list?.() ?? []).filter(row =>
        ["pending","running","blocked"].includes(row.status) || unsettled.has(row.id)).map(row => [row.taskId,row.id]));
      const subscriptions = this.watches.list().filter(row => ["watching","sending","paused"].includes(row.state));
      const paused = this.db.connection.prepare("SELECT task_id FROM dots_target_controls WHERE state='paused'").all() as {task_id:string}[];
      const schedules = this.agent.dotsScheduleIds(false, spaceId ? { spaceId } : undefined);
      const scheduleOwners = new Set(schedules.map(schedule => this.agent.dotsScheduleOwnerTask(schedule)).filter(id => id !== undefined));
      const targets = new Set([...linked.keys(), ...subscriptions.map(row => row.taskId), ...paused.map(row => row.task_id), ...scheduleOwners]);
      const tasks: Selection["tasks"] = [];
      for (const taskId of targets) {
        const task = this.db.getTask(taskId);
        if (!task || !this.ordinary(task) || task.externalAgentPin || (spaceId && task.spaceId !== spaceId) ||
          this.db.isTaskEffectiveArchived(taskId) || this.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") continue;
        const link = linked.get(taskId);
        const hasFollowups = scheduleOwners.has(taskId) || subscriptions.some(row => row.taskId === taskId);
        let expected: string | null = null;
        if (link) {
          const accepted = await this.agent.findSubmission(taskId, link);
          if (accepted?.receipt && (["placed","queued"].includes(accepted.receipt.status) || unsettled.has(link))) {
            const version = await this.agent.dotsInputVersion(taskId);
            if (JSON.parse(version)[1] === accepted.receipt.submissionId) expected = version;
            else if (!hasFollowups) continue;
          } else if (accepted?.receipt && !hasFollowups) continue;
        }
        tasks.push({taskId, expected});
      }
      selection = { tasks, schedules };
      this.db.connection.prepare("INSERT OR IGNORE INTO dots_control_batches VALUES(?,?)").run(id, JSON.stringify(selection));
      selection = JSON.parse((this.db.connection.prepare("SELECT selection FROM dots_control_batches WHERE id=?").get(id) as {selection:string}).selection);
    }
    const schedules = selection.schedules.map(scheduleId => {
      try {
        const status = this.db.connection.transaction(() => {
          const key = JSON.stringify([id,"schedule",scheduleId]);
          const prior = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=?").get(key) as {outcome:string} | undefined;
          if (prior) return prior.outcome;
          const owner = action === "pause" && this.agent.dotsScheduleOwnerTask(scheduleId);
          const target = owner && selection.tasks.find(t => t.taskId === owner);
          const result = target ? this.agent.holdDotsSchedule(scheduleId, "task:" + target.taskId, true) : this.agent.controlDotsSchedule(scheduleId,action);
          this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,?)").run(key,DOTS_TASK_ID,result);
          return result;
        })();
        return {id:scheduleId, status};
      }
      catch (error) { return {id:scheduleId,error:String(error)}; }
    });
    const tasks = await Promise.all(selection.tasks.map(async ({taskId,expected}) => {
      try { return await this.controlTask(this.task(taskId,spaceId,true),action,JSON.stringify([id,taskId]),expected); }
      catch (error) { return { id: taskId, error: String(error) }; }
    }));
    return { tasks, schedules };
  }
}
