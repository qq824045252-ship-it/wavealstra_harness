import { DotsFollowup, followupInstructions } from "./DotsFollowup";
import { nativeResultHits, type NativeResultHit } from "./DotsNativeResults";
import { resolvedPathKey } from "../platform/paths";
import { DotsFileWatches } from "./DotsFileWatches";
import { readDotsLibrary } from "./DotsLibrary";
import { DotsIntentChanged } from "./DotsNativeIntent";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import { TaskBoardRepository } from "../task/TaskBoardRepository";
import type { GoalContinuationOrigin } from "../../shared/conversation-goal";
import type { ConversationInteractionDto } from "../../shared/conversation-interaction";
import type { BoardQuery } from "../../shared/task-board";
import type { AgentService } from "../agent/AgentService";
import type { AgentPromptRequest, SpaceDto, TaskDto } from "../../shared/agent-ipc";
import { DOTS_TASK_ID, isDotsAutomaticInput, type DotsDelegation, type DotsReplyOrigin } from "../../shared/dots";
import { gatewayChannelForSpace, isGatewayConversation } from "../../shared/gateway-task";
import { assertSafeEntryName, listWorkspaceFiles, readWorkspaceFile } from "../workspace/WorkspaceService";

type Agent = Pick<AgentService, "dotsLibrary" | "isTaskBusy" | "findSubmission" | "prompt" | "stopDotsTarget" | "loadTaskHistory" | "isDotsOrdinaryTask" | "dotsSubmission" | "getConversationRuntimeSnapshot" | "respondConversationInteraction" | "dotsMemoryReferenceCurrent" | "dotsInputVersion" | "dotsScheduleIds" | "controlDotsSchedule" | "getConversationGoals">;
export interface DotsActionHooks {
  rememberOrigin?(sourceId:string, origin:DotsReplyOrigin):void;
  link(targetTaskId: string, operationId: string, sourceMessageId: string, supersedes: boolean, request: AgentPromptRequest): void;
  list?(): DotsDelegation[];
  changed?(): void;
  failed?(targetTaskId: string, operationId: string, reason: string): void;
}
export interface DotsActionInput {
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
function taskLink(task: Pick<TaskDto, "id" | "title">) {
  return "[" + task.title.replace(/[\\[\]]/g, "\\$&") + "](mybuddy://task/" + encodeURIComponent(task.id) + ")";
}

function spaceLink(space: SpaceDto) {
  return { ...space, link: "[" + space.name.replace(/[\\\[\]]/g, "\\$&") + "](mybuddy://space/" + encodeURIComponent(space.id) + ")" };
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
  return question.kind === "multi_select" ? answer.split(/[,，、\n]/).map(value => select(value.trim())) : select(answer);
}

export class DotsActions {
  private readonly followups: DotsFollowup;
  private readonly watches: DotsFileWatches;
  private controlRecovery?: Promise<void>;

  constructor(private readonly db: AppDatabase, private readonly agent: Agent, private readonly hooks: DotsActionHooks,
    private readonly board = new TaskBoardRepository(db.connection)) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS dots_control_batches(id TEXT PRIMARY KEY, selection TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_proactive_pauses(scope TEXT PRIMARY KEY,timer_ids TEXT NOT NULL)`);
    this.followups = new DotsFollowup(db.connection, {
      allowed: taskId => {
        try {
          this.task(taskId);
          return !this.control(taskId);
        } catch { return false; }
      },
      proactive: taskId => !db.connection.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?) LIMIT 1")
        .get(db.getTask(taskId)?.spaceId ?? ""),
      link: (request, source) => {
        this.hooks.link(request.taskId, request.userMessageId, source, false, request);
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
        this.hooks.link(request.taskId, request.userMessageId, source, false, request);
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
        this.hooks.link(request.taskId, request.userMessageId, source, false, request);
        return agent.prompt(request, { durableAdmissionOnly: true });
      },
      proactivePaused: spaceId => Boolean(this.db.connection.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?) LIMIT 1").get(spaceId)),
      failed: (...args) => this.hooks.failed?.(...args), changed: () => this.hooks.changed?.(),
    });
  }

  startFileWatches() {
    this.watches.start();
    const rows = this.db.connection.prepare("SELECT task_id,operation_id FROM dots_target_controls WHERE operation_id LIKE 'dots-input-%'").all() as
      Array<{task_id:string;operation_id:string}>;
    this.controlRecovery = Promise.all([this.followups.recoverGoals(),...rows.map(async row => {
      try {
        const receipt = (await this.agent.findSubmission(row.task_id, row.operation_id))?.receipt;
        if (receipt) await this.accepted({ taskId:row.task_id, userMessageId:row.operation_id }, receipt.submissionId);
      } catch (error) { console.warn("[Dots] 恢复暂停控制回执失败", row.task_id, error); }
    })]).then(() => {});
  }

  async closeFileWatches() { await Promise.all([this.watches.close(), this.controlRecovery]); }

  private space(id?: string) {
    const space = this.db.getSpace(required(id, "工作空间 ID"));
    if (!space || space.effectiveArchived || !this.isLocalSpace(space)) throw new Error("工作空间不存在或不可用");
    return space;
  }

  private isLocalSpace(space: SpaceDto) {
    const seen = new Set<string>();
    let current: SpaceDto | undefined = space;
    while (current) {
      if (seen.has(current.id) || current.id.startsWith("sp-gw-") || /^bot-(space-|team-space-|workspace-group-)/.test(current.id)) return false;
      seen.add(current.id);
      current = current.parentId ? this.db.getSpace(current.parentId) : undefined;
    }
    return true;
  }

  private ordinary(task: TaskDto) {
    return task.id !== DOTS_TASK_ID && !task.id.startsWith("gw-") && !isGatewayConversation(task.id)
      && !task.externalAgentPin && !task.gatewaySidebarChannelId && !gatewayChannelForSpace(task.spaceId ?? "") && this.agent.isDotsOrdinaryTask(task.id)
      && (!task.spaceId || this.isLocalSpace(this.db.getSpace(task.spaceId) ?? {id: task.spaceId, name: ""}));
  }

  private task(id?: string, spaceId?: string) {
    const task = this.db.getTask(required(id, "原任务 ID"));
    if (!task || !this.ordinary(task) || this.db.isTaskEffectiveArchived(task.id)
      || this.db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed") throw new Error("普通任务不存在或不可用");
    if (spaceId && task.spaceId !== spaceId) throw new Error("原任务属于另一个空间");
    return task;
  }

  private control(taskId: string) {
    return this.db.connection.prepare("SELECT state,operation_id FROM dots_target_controls WHERE task_id=?").get(taskId) as
      { state: "paused" | "stopped"; operation_id: string } | undefined;
  }

  assertAdmission(request: AgentPromptRequest) {
    if (!request.userMessageId.startsWith("dots-input-")) return;
    this.task(request.taskId, request.spaceId);
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
  }

  async accepted(request: Pick<AgentPromptRequest,"taskId"|"userMessageId">, submissionId: number) {
    if (!request.userMessageId.startsWith("dots-input-")) return;
    const control = this.control(request.taskId);
    if (!control || control.operation_id !== request.userMessageId) return;
    const version = await this.agent.dotsInputVersion(request.taskId);
    this.db.connection.transaction(() => {
      const changed = this.db.connection.prepare("DELETE FROM dots_target_controls WHERE task_id=? AND operation_id=?").run(request.taskId, request.userMessageId);
      if (changed.changes && control.state === "paused") {
        if (JSON.parse(version)[1] === submissionId) this.watches.resumeTarget(request.taskId, version);
        else this.watches.controlTarget(request.taskId, "stop");
      }
    })();
  }

  private deliveries(task: TaskDto) {
    return (this.hooks.list?.() ?? []).filter(item => item.taskId === task.id).sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 5)
      .map(item => ({ operationId: item.id, goalId: item.goalId, status: item.status, interactionId: item.interactionId, text: item.text.slice(0, 900), artifacts: item.artifacts.slice(0, 10), updatedAt: item.updatedAt }));
  }

  private summary(task: TaskDto) {
    return { id: task.id, title: task.title, link: taskLink(task), spaceId: task.spaceId, status: task.status, dotsState: this.control(task.id)?.state,
      running: this.agent.isTaskBusy(task.id), updatedAt: task.updatedAt };
  }

  goalAccepted(request: AgentPromptRequest, origin: GoalContinuationOrigin) {
    return this.followups.goalAccepted(request, origin);
  }

  followup(row: DotsDelegation, original?: AgentPromptRequest) {
    return this.followups.handle(row, original);
  }

  async execute(caller: string, source: string | undefined, input: DotsActionInput, originalText?: string, origin?:DotsReplyOrigin) {
    if (caller !== DOTS_TASK_ID) throw new Error("只有 Dots 原生会话可以执行此操作");
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
          itemId: input.action === "read_material" ? required(input.itemId, "资料 ID") : undefined });
      }
      case "file_watches": return this.watches.list(input.targetTaskId).filter(row => {
        const task = this.db.getTask(row.taskId);
        return task && this.ordinary(task) && !this.db.isTaskEffectiveArchived(task.id) && task.spaceId === row.spaceId &&
          (!input.spaceId || row.spaceId === input.spaceId) && this.db.getTaskExecutionWorkspaceState(task.id)?.state !== "trashed";
      });
      case "deliveries": {
        const query = input.query?.trim().toLowerCase() ?? "";
        const links = this.hooks.list?.() ?? [];
        const matches = (input.cursor ? [] : links).filter(item =>
          (!input.targetTaskId || item.taskId === input.targetTaskId) &&
          [item.title, item.text, ...item.artifacts.map(file => file.name)].some(value => value.toLowerCase().includes(query)));
        const hits: Array<NativeResultHit | Pick<DotsDelegation, "status" | "title" | "text" | "artifacts" | "taskId" | "goalId"> & {
          operationId: string; link: string }> = [];
        for (const item of matches.reverse()) {
          const task = this.db.getTask(item.taskId);
          if (!task || !this.ordinary(task) || this.db.isTaskEffectiveArchived(task.id) ||
            this.db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed" || (input.spaceId && task.spaceId !== input.spaceId)) continue;
          hits.push({ operationId: item.id, taskId: task.id, goalId: item.goalId, link: taskLink(task), status: item.status, title: item.title,
            text: item.text.slice(0, 1200), artifacts: item.artifacts.slice(0, 10) });
          if (hits.length === offset + 21) break;
        }
        const page = this.board.page({view:"all", scope:input.spaceId, cursor:input.cursor}, Date.now(), {taskId:input.targetTaskId});
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
        const nextOffset = hits.length > offset + 20 ? offset + 20 : undefined;
        return { results: hits.slice(offset, offset + 20), more: Boolean(nextOffset || next),
          nextOffset, next: nextOffset ? undefined : next };
      }
      case "board": {
        const page = this.board.page({ view: input.view ?? "all", scope: input.spaceId, search: input.query,
          dateKind: input.dateKind, from: input.from, until: input.until, cursor: input.cursor }, Date.now(), {});
        return { tasks: page.rows.map(row => ({ ...row, link: taskLink(row) })), next: page.next };
      }
      case "task": {
        const task = this.task(input.targetTaskId, input.spaceId);
        const progress = this.board.page({ view: "all" }, Date.now(), { taskId: task.id }).rows[0];
        const history = await this.agent.loadTaskHistory(task.id, undefined, "current");
        const goals = this.agent.getConversationGoals().listByTask(task.id).map(({ id, title, description, status, criteria }) => ({
          id, title, description, status, criteria,
        }));
        return { ...this.summary(task), progress, goals, deliveries: this.deliveries(task), messages: history.messages.slice(-5).map(m => ({ role: m.role, text: m.text.slice(-2400), artifacts: m.artifacts })),
          artifacts: history.artifacts, historyError: history.historyError };
      }
      case "spaces": return this.db.listSpaces().filter(s => !s.effectiveArchived && this.isLocalSpace(s)).map(spaceLink);
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
        };
        if (input.action === "files") {
          const entries = await listWorkspaceFiles(selected, 0);
          checkBinding();
          return { files: entries.slice(offset, offset + 100).map(({name,kind}) => ({name,kind,path:relative(root,resolve(selected,name))})),
            nextOffset: entries.length > offset + 100 ? offset + 100 : undefined };
        }
        const data = await readWorkspaceFile(root, local, true);
        checkBinding();
        return { path: local, content: data.content.slice(offset, offset + 12000), more: offset + 12000 < data.content.length, truncated: data.truncated };
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
      const ids: string[] = saved ? JSON.parse(saved.timer_ids) : (pause && !scope ? this.agent.dotsScheduleIds(true) : []);
      const schedules = this.db.connection.transaction(() => {
        if (pause) this.db.connection.prepare("INSERT OR IGNORE INTO dots_proactive_pauses VALUES(?,?)").run(scope,JSON.stringify(ids));
        else this.db.connection.prepare("DELETE FROM dots_proactive_pauses WHERE scope=?").run(scope);
        const existing = new Set(this.agent.dotsScheduleIds());
        const rows = ids.filter(id => existing.has(id)).map(id => ({ id, state: this.agent.controlDotsSchedule(id, pause ? "pause" : "resume") }));
        const receipt = {scope:scope || "all",proactive:pause ? "paused" : "enabled", schedules:rows};
        this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,?)").run(key,DOTS_TASK_ID,JSON.stringify(receipt));
        return rows;
      })();
      if (!pause) this.watches.refresh();
      return { scope:scope || "all", proactive:pause ? "paused" : "enabled", schedules };
    }
    if (input.action === "stop_all" || input.action === "pause_all") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("批量控制需要用户明确交代");
      return this.controlBatch(sourceId, input.action === "pause_all" ? "pause" : "stop", input.spaceId);
    }
    if (input.action === "watch_file" || input.action === "cancel_watch") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("需要用户明确交代文件订阅");
      const task = this.task(input.targetTaskId, input.spaceId);
      if (input.action === "cancel_watch") return this.watches.cancel(required(input.watchId, "订阅 ID"), task.id);
      const space = this.space(required(task.spaceId ?? undefined, "原任务工作空间"));
      return this.watches.create({ taskId: task.id, spaceId: space.id, file: required(input.path, "订阅文件相对路径"),
        instruction: required(input.text, "文件变化后的任务要求"), source: sourceId });
    }
    const digest = (value: string) => createHash("sha256").update(JSON.stringify([sourceId, value])).digest("hex");
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
        try { await mkdir(folder); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!(await lstat(folder)).isDirectory() || resolvedPathKey(await realpath(folder)) !== resolvedPathKey(folder))
        throw new Error("同名路径必须是父空间内的实际目录");
      this.space(parent.id);
      if (this.db.resolveWorkspaceExecutionPath(parent.id, { requireExisting: true }) !== root)
        throw new Error("创建期间父空间的绑定已更改");
      const current = existing();
      const child = current ? checkSpace(current) : this.db.createSpace({ id, name, path: folder, parentId: parent.id });
      this.hooks.changed?.();
      return spaceLink(child);
    }
    if (input.action === "bind") {
      const requested = required(input.path, "指定文件夹");
      if (!isAbsolute(requested)) throw new Error("请提供指定文件夹的绝对路径");
      const path = await realpath(requested);
      if (!(await stat(path)).isDirectory()) throw new Error("指定路径不是文件夹");
      let space = input.spaceId ? this.space(input.spaceId) : undefined;
      if (!space) {
        const name = required(input.name, "空间名称");
        space = this.db.findRootSpaceByName(name);
        if (space) space = this.space(space.id);
        else space = this.db.createSpace({ id: "sp-dots-" + digest(name), name, path });
      }
      if (space.path !== path) this.db.upsertSpace({ ...space, path });
      this.hooks.changed?.();
      return spaceLink(this.space(space.id));
    }
    if (input.action === "rename") {
      const space = this.space(input.spaceId);
      this.db.renameSpace(space.id, required(input.name, "新名称"));
      this.hooks.changed?.();
      return spaceLink(this.space(space.id));
    }
    if (input.action === "answer") {
      if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("此问题需要用户直接回答");
      const task = this.task(input.targetTaskId, input.spaceId);
      const operationId = required(input.operationId, "委派操作 ID");
      const interactionId = required(input.interactionId, "原问题 ID");
      if (!(this.hooks.list?.() ?? []).some(item => item.id === operationId && item.taskId === task.id))
        throw new Error("原问题不属于此 Dots 委派");
      const answerKey = digest(JSON.stringify(["answer", task.id, operationId, interactionId]));
      if (this.db.connection.prepare("SELECT 1 FROM dots_control_receipts WHERE operation_id=? AND outcome='answered'").get(answerKey))
        return { ...this.summary(task), interactionId, answered: true };
      const active = await this.agent.dotsSubmission(task.id, operationId);
      if (!active || !("interactionId" in active) || active.interactionId !== interactionId)
        throw new Error("原委派当前未等待此问题");
      const question = this.agent.getConversationRuntimeSnapshot(task.id).interactions.find(row => row.id === interactionId && row.status === "pending");
      if (!question || this.control(task.id)) throw new Error("原任务已暂停或问题已经结束");
      this.db.connection.transaction(() => {
        const reply = this.agent.respondConversationInteraction(question.id, userAnswer(question, required(originalText, "用户原话")));
        if (!reply.ok) throw new Error(reply.message);
        this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,'answered')").run(answerKey,task.id);
      })();
      this.hooks.changed?.();
      return { ...this.summary(task), interactionId, answered: true };
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
    const identity = digest(JSON.stringify([...(acceptanceQuote ? [acceptanceQuote] : []),...(deliveryInstruction ? [deliveryInstruction] : []),...(steps.length?[steps]:[]),...(input.memoryRefs?.length ? [input.memoryRefs] : []), input.action, input.spaceId, input.targetTaskId, input.goalId, input.action === "delegate" && !input.targetTaskId ? input.name : undefined, text]));
    let task: TaskDto;
    if (input.goalId && !input.targetTaskId) throw new Error("请指定该 Goal 的原任务");
    if (input.action === "delegate" && !input.targetTaskId) {
      const space = this.space(input.spaceId);
      const title = input.name?.trim() || required(text, "任务要求").slice(0, 80);
      const id = "dots-job-" + identity;
      required(text, "任务要求");
      if (!this.db.getTask(id)) this.db.upsertTask({ id, spaceId: space.id, title, updatedAt: Date.now() });
      task = this.task(id, space.id);
    } else task = this.task(input.targetTaskId, input.spaceId);
    if (input.action === "stop" || input.action === "pause") return this.controlTask(task, input.action, identity);
    const goals = this.agent.getConversationGoals();
    const priorGoal = input.action === "steer" || input.action === "resume" ? this.db.connection.prepare(
      "SELECT goal_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1",
    ).get(task.id) as { goal_id: string | null } | undefined : undefined;
    const requestedGoalId = input.goalId ?? priorGoal?.goal_id;
    const goal = requestedGoalId ? goals.getLive(task.id, requestedGoalId) : undefined;
    if (input.goalId && !goal) throw new Error("该 Goal 不属于原任务");
    const message = required(text, "任务要求");
    const operationId = "dots-input-" + identity;
    const previous = await this.agent.findSubmission(task.id, operationId);
    if (!previous && input.action === "steer" && !this.agent.isTaskBusy(task.id)) throw new Error("原任务已空闲，请读取最新进度后接续原任务");
    if (!previous && input.action === "resume" && this.agent.isTaskBusy(task.id)) throw new Error("原任务仍在运行");
    const instructions = [message];
    if (deliveryInstruction) instructions.push("用户对此任务的最终交付要求（以下原文优先于任务转述中的交付表述）：" + deliveryInstruction);
    instructions.push("给原用户的最终回复只交付用户所求的内容并遵守约定格式。中间结果、执行经过、证据及内部结项状态仅在用户要求时写入。");
    if (steps.length) instructions.push("本次依次完成："+JSON.stringify(steps)+"。本轮只做第一步："+steps[0]);
    if (input.memoryRefs?.length) instructions.push("以下是本轮引用的记忆版本，仅使用宿主本轮提供的可见证据："+JSON.stringify(input.memoryRefs));
    const goalWork = goal ? goals.workService.getWork(goal.id) : undefined;
    if (goal) instructions.push("本次工作关联原任务 Goal："+goal.title+"（"+goal.id+"）。达到条件后通过 conversation_goal_propose_complete 提交实际成果和逐项依据。deliveryText 原样回给用户，严格使用用户约定的格式。");
    instructions.push("交付最终文件时请用 register_artifact 登记本次产生的文件，文字成果直接回复。", followupInstructions);
    const request: AgentPromptRequest = {
      taskId: task.id, spaceId: task.spaceId ?? undefined,
      userMessageId: operationId, assistantMessageId: "dots-reply-" + identity,
      dotsMemoryRefs: input.memoryRefs, dotsGoalId: goal?.id,
      dotsGoalIntentRevision: goalWork?.intentRevision, dotsGoalUserAcceptance: acceptanceQuote,
      text: instructions.join("\n\n"), displayText: message,
      streamingBehavior: input.action === "steer" ? "steer" : "followUp",
      ...(input.action === "steer" ? { requireActiveRun: true, dotsSteerInputVersion: await this.agent.dotsInputVersion(task.id) } : {}),
    };
    this.db.connection.transaction(() => {
      if (!previous && input.action === "resume") {
        if (sourceId.startsWith("cron-") || sourceId.startsWith("goal-continuation:")) throw new Error("暂停后的恢复需要用户明确交代");
        this.db.connection.prepare("UPDATE dots_target_controls SET operation_id=? WHERE task_id=?").run(operationId, task.id);
      }
      if (!previous) this.assertAdmission(request);
      this.followups.remember(request,sourceId,[message, deliveryInstruction].filter(Boolean).join("\n"),steps);
      this.hooks.link(task.id, operationId, sourceId, input.action === "steer" || input.action === "resume", request);
    })();
    const result = previous ?? await this.agent.prompt(request, { durableAdmissionOnly: true });
    if (result.error || result.cancelled) {
      const reason = result.error?.message ?? "执行已取消";
      this.hooks.failed?.(task.id, operationId, reason);
      throw new Error(reason);
    }
    this.hooks.changed?.();
    return { ...this.summary(task), goalId: goal?.id, queued: result.queued, receipt: result.receipt };
  }

  private async controlTask(task: TaskDto, action: "pause" | "stop", identity: string, expected?: string | null) {
      const existing = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=?").get(identity) as { outcome: string } | undefined;
      if (existing) return { ...this.summary(task), control: existing.outcome };
      this.db.connection.transaction(() => {
        this.watches.controlTarget(task.id, action);
        this.db.connection.prepare("INSERT INTO dots_control_receipts(operation_id,target_task_id,outcome) VALUES(?,?,?)").run(identity, task.id, "stop_outcome_unknown");
        this.db.connection.prepare(`INSERT INTO dots_target_controls(task_id,state,operation_id) VALUES(?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id`).run(task.id, action === "pause" ? "paused" : "stopped", identity);
      })();
      const control = expected === null ? "future_work_only" : await this.agent.stopDotsTarget(task.id, expected);
      this.db.connection.prepare("UPDATE dots_control_receipts SET outcome=? WHERE operation_id=?").run(control, identity);
      this.hooks.changed?.();
      return { ...this.summary(task), control, resumedBy: "resume" };
  }

  private async controlBatch(source: string, action: "pause" | "stop", spaceId?: string) {
    if (spaceId) this.space(spaceId);
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
      const targets = new Set([...linked.keys(), ...subscriptions.map(row => row.taskId), ...paused.map(row => row.task_id)]);
      const tasks: Selection["tasks"] = [];
      for (const taskId of targets) {
        const task = this.db.getTask(taskId);
        if (!task || !this.ordinary(task) || task.externalAgentPin || (spaceId && task.spaceId !== spaceId) ||
          this.db.isTaskEffectiveArchived(taskId) || this.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") continue;
        const link = linked.get(taskId);
        let expected: string | null = null;
        if (link) {
          const accepted = await this.agent.findSubmission(taskId, link);
          if (accepted?.receipt && (["placed","queued"].includes(accepted.receipt.status) || unsettled.has(link))) {
            const version = await this.agent.dotsInputVersion(taskId);
            if (JSON.parse(version)[1] === accepted.receipt.submissionId) expected = version;
            else if (!subscriptions.some(row=>row.taskId===taskId)) continue;
          } else if (accepted?.receipt && !subscriptions.some(row => row.taskId === taskId)) continue;
        }
        tasks.push({taskId, expected});
      }
      selection = { tasks, schedules: spaceId ? [] : this.agent.dotsScheduleIds() };
      this.db.connection.prepare("INSERT OR IGNORE INTO dots_control_batches VALUES(?,?)").run(id, JSON.stringify(selection));
      selection = JSON.parse((this.db.connection.prepare("SELECT selection FROM dots_control_batches WHERE id=?").get(id) as {selection:string}).selection);
    }
    const schedules = selection.schedules.map(scheduleId => {
      try {
        const status = this.db.connection.transaction(() => {
          const key = JSON.stringify([id,"schedule",scheduleId]);
          const prior = this.db.connection.prepare("SELECT outcome FROM dots_control_receipts WHERE operation_id=?").get(key) as {outcome:string} | undefined;
          if (prior) return prior.outcome;
          const result = this.agent.controlDotsSchedule(scheduleId,action);
          this.db.connection.prepare("INSERT INTO dots_control_receipts VALUES(?,?,?)").run(key,DOTS_TASK_ID,result);
          return result;
        })();
        return {id:scheduleId, status};
      }
      catch (error) { return {id:scheduleId,error:String(error)}; }
    });
    const tasks = await Promise.all(selection.tasks.map(async ({taskId,expected}) => {
      try { return await this.controlTask(this.task(taskId,spaceId),action,JSON.stringify([id,taskId]),expected); }
      catch (error) { return { id: taskId, error: String(error) }; }
    }));
    return { tasks, schedules };
  }
}
