import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { CronService } from "../cron/CronService";
import type { TaskTerminalService } from "../terminal/TaskTerminalService";

export interface LocalWorkflowBridge {
  cron: CronService;
  terminal: TaskTerminalService;
  getPermissionMode?(): PermissionMode;
}

async function result(run: () => unknown | Promise<unknown>) {
  try {
    const details = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], isError: true, details: { error: message } };
  }
}


export function registerLocalWorkflowTools(pi: Pick<ExtensionAPI, "registerTool">, context: {
  currentTaskOnly?: boolean; sourceOperation?: () => string | undefined;
  sourceOrigin?: () => import("../../shared/dots").DotsReplyOrigin | undefined;
  scheduleScope?: (source: string, taskId?: string, spaceId?: string) => { taskId?: string; spaceId?: string } | undefined;
  canChangeSchedules?: (action: "create" | "update" | "resume") => boolean;
  taskId: string; taskRoot: string; services: LocalWorkflowBridge; terminalEnabled: boolean;
}): void {
  const { taskId, taskRoot, services } = context;
  const scheduleActions = ["create", "update", "list", "get", "runs", "pause", "resume", "cancel"] as const;
  const allowed = (action: typeof scheduleActions[number]) =>
    (action !== "create" && action !== "update" && action !== "resume") || context.canChangeSchedules?.(action) !== false;
  pi.registerTool({
    name: "automation_exec",
    label: "Task automation",
    description: (context.currentTaskOnly ? "Dots 定时跟进回到此对话。missed_runs=coalesce 会在宿主恢复后合并漏跑、补办一次，忙时排队。需要过期跳过的检查设 skip，受截止时间约束。仅按用户的定时意图创建。支持查询、修改、暂停、恢复和取消。" : "当前任务专属本地调度。create 支持 at/every/cron，可继续当前对话或新建任务。update 必须给已有 id，仅修改传入字段，保留任务 ID、执行历史和启用/暂停状态；修改已有任务必须用 update，不要取消后重建。可更新 name/prompt/调度/时区/max_runs/deadline/restart_policy；max_runs 是累计运行上限，不重置次数。修改不会中断已开始的回合，新配置用于后续触发。every 为真实持续间隔，例如 90s。应用关闭或休眠时不执行，resume 重启只恢复未来触发、不补跑；pause 重启停用。忙碌任务跳过、不排队。get 按 id 查看计划、当前与最近运行；runs 传 id 可用 cursor 按页查单条计划。cancel 停止未来触发，保留计划和历史，不中断已开始的用户回合；取消后不能 resume。可 list/runs/update/pause/resume/cancel；Automation 页面也可管理。必须有用户的定时意图，不用长时间 bash sleep 替代。"),
    promptSnippet: "automation_exec(action, name?, prompt?, schedule_type?, schedule_expr?, target?, max_runs?, deadline?, restart_policy?, id?, cursor?)",
    parameters: Type.Object({
      action: Type.Union(scheduleActions.filter(allowed).map(value => Type.Literal(value))),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
      schedule_type: Type.Optional(Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")])),
      schedule_expr: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      target: Type.Optional(Type.Union([Type.Literal("current-task"), Type.Literal("new-task")])),
      owner_task_id: Type.Optional(Type.String({ minLength: 1, description: "Dots 跟进已有事项时填写普通任务 ID，随事项暂停和停止" })),
      owner_space_id: Type.Optional(Type.String({ minLength: 1, description: "Dots 跟进特定空间时填写空间 ID，随空间控制" })),
      max_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
      deadline: Type.Optional(Type.String({ description: "ISO timestamp, including timezone" })),
      missed_runs: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("coalesce")])),
      restart_policy: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("pause")])),
      id: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }, { additionalProperties: false }),
    execute: async (_id, input, signal) => result(async () => {
      signal?.throwIfAborted();
      const source = context.sourceOperation?.();
      if (context.currentTaskOnly && source && /^cron-[0-9a-f-]{36}-input$/i.test(source))
        services.cron.assertDotsInputCurrent(source);
      if ((input.owner_task_id || input.owner_space_id) && (!context.currentTaskOnly || input.action !== "create"))
        throw new Error("只有 Dots 新建跟进计划时可以指定归属");
      if (!allowed(input.action)) throw new Error("Dots 设置已关闭「定时计划和文件订阅」");
      const visible = (id: string) => !context.currentTaskOnly || services.cron.dotsScheduleVisible(id);
      if (input.id && !visible(input.id) && input.action !== "pause" && input.action !== "cancel")
        throw new Error("计划不在 Dots 已授权的空间内");
      if (input.action === "list") {
        const jobs = (await services.cron.readJobs()).filter(job => job.sourceTaskId === taskId && visible(job.id));
        return { jobs, localOnly: true, missedRuns: context.currentTaskOnly ? "per-job" : "skip" };
      }
      if (input.action === "get") {
        if (!input.id) throw new Error("get requires id");
        return services.cron.getForTask(taskId, input.id);
      }
      if (input.action === "runs") {
        if (input.id) return services.cron.runPageForTask(taskId, input.id, input.limit, input.cursor, visible);
        if (input.cursor !== undefined) throw new Error("runs pagination requires id");
        return services.cron.runsForTask(taskId, input.limit, visible);
      }
      if (context.sourceOperation && (!source || source.startsWith("cron-") || source.startsWith("goal-continuation:")))
        throw new Error("需要用户明确交代才能修改 Dots 跟进计划");
      if (input.action === "create") {
        if (!input.name?.trim() || !input.prompt?.trim() || !input.schedule_type || !input.schedule_expr) throw new Error("create requires name, prompt, schedule_type and schedule_expr");
        const effectiveTo = input.deadline ? Date.parse(input.deadline) : undefined;
        if (effectiveTo != null && (!Number.isFinite(effectiveTo) || effectiveTo <= Date.now())) throw new Error("deadline must be a future ISO timestamp");
        if (context.currentTaskOnly && input.target === "new-task") throw new Error("Dots 的定时跟进只能返回当前对话");
        const ownerTask = typeof input.owner_task_id === "string" ? input.owner_task_id : undefined;
        const ownerSpace = typeof input.owner_space_id === "string" ? input.owner_space_id : undefined;
        if ((ownerTask || ownerSpace) && (!source || !context.sourceOrigin?.() || !context.scheduleScope))
          throw new Error("找不到定时跟进对应的原始 Dots 消息");
        const owner = source ? context.scheduleScope?.(source, ownerTask, ownerSpace) : undefined;
        const operation = source ? createHash("sha256").update(JSON.stringify([taskId, source, input.name, input.prompt,
          input.schedule_type, input.schedule_expr, input.timezone, input.max_runs, effectiveTo, input.restart_policy,
          ...(input.missed_runs ? [input.missed_runs] : []), ...(input.owner_task_id || input.owner_space_id ? [input.owner_task_id,input.owner_space_id] : [])])).digest("hex") : undefined;
        const origin = context.sourceOrigin?.();
        return services.cron.createForTask(taskId, taskRoot, {
          name: input.name, prompt: input.prompt, scheduleType: input.schedule_type,
          scheduleExpr: input.schedule_expr, timezone: input.timezone ?? "UTC",
          target: input.target ?? "current-task", maxRuns: input.max_runs,
          effectiveTo, restartPolicy: input.restart_policy ?? "resume",
          missedRuns: input.missed_runs ?? (context.currentTaskOnly && input.schedule_type === "at" ? "coalesce" : undefined),
        }, operation, source && origin ? { source, origin, owner } : undefined);
      }
      if (!input.id) throw new Error("This action requires id");
      if (input.action === "update") {
        if (input.target !== undefined) throw new Error("update cannot change target");
        const effectiveTo = input.deadline === undefined ? undefined : Date.parse(input.deadline);
        if (effectiveTo !== undefined && (!Number.isFinite(effectiveTo) || effectiveTo <= Date.now())) throw new Error("deadline must be a future ISO timestamp");
        return services.cron.updateForTask(taskId, input.id, {
          name: input.name, prompt: input.prompt, scheduleType: input.schedule_type,
          scheduleExpr: input.schedule_expr, timezone: input.timezone,
          maxRuns: input.max_runs, effectiveTo, restartPolicy: input.restart_policy, missedRuns: input.missed_runs,
        });
      }
      services.cron.changeForTask(taskId, input.id, input.action);
      return { id: input.id, action: input.action, jobs: visibleJobs() };
    }),
  });
  if (!context.terminalEnabled) return;
  pi.registerTool({
    name: "terminal_exec",
    label: "Task terminal",
    description: "模型独占持久 PTY/TUI。先核对目标 CLI 自己的非交互参数：npx 的 -y 不替代目标 CLI 的 --yes，不得为跳过提示擅自改为全局安装或扩大 agent/skill 范围。确需交互输入的安装向导、需要 TTY 的 CLI、密码提示和 TUI 才使用本工具，而不是非交互 bash/powershell。普通 shell 报 stdin is not a TTY 不代表本机没有终端；先检查已有操作效果再决定是否重试，不能盲目重跑安装或其他写操作。open 分配独立 terminal_id 和 session_id，cwd 固定当前任务，不接管用户终端。read 返回解析 ANSI 后的当前屏幕、光标和退出状态，不是输出尾部；wait_for 为字面文本，结果明确 matched/timeout/exited。input 原样发送 text，Enter 用 \\r，Ctrl-C 用 \\u0003。输入不自动重试。resize、close 均要求该任务原会话 ID。每任务最多四个终端，完成操作后 close；用户停止任务时只清理模型终端。",
    promptSnippet: "terminal_exec(action, terminal_id?, session_id?, text?, cols?, rows?, wait_for?, timeout_ms?)",
    parameters: Type.Object({
      action: Type.Union((["open", "list", "read", "input", "resize", "close"] as const).map(value => Type.Literal(value))),
      terminal_id: Type.Optional(Type.String({ minLength: 1 })),
      session_id: Type.Optional(Type.String({ minLength: 1 })),
      text: Type.Optional(Type.String({ maxLength: 100000 })),
      cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 300 })),
      rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 150 })),
      wait_for: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
    }, { additionalProperties: false }),
    execute: async (_id, input, signal) => result(async () => {
      signal?.throwIfAborted();
      if (input.action === "list") return services.terminal.list(taskId);
      if (input.action === "open") return services.terminal.open(taskId, input.cols, input.rows);
      if (!input.terminal_id || !input.session_id) throw new Error("This action requires terminal_id and session_id");
      const args = [taskId, input.terminal_id, input.session_id] as const;
      switch (input.action) {
        case "read": return services.terminal.read(...args, { waitFor: input.wait_for, timeoutMs: input.timeout_ms, signal });
        case "input":
          if (input.text === undefined) throw new Error("input requires text");
          return services.terminal.input(...args, input.text);
        case "resize":
          if (input.cols === undefined || input.rows === undefined) throw new Error("resize requires cols and rows");
          return services.terminal.resize(...args, input.cols, input.rows);
        case "close": services.terminal.close(...args); return { closed: true, terminalId: input.terminal_id };
      }
    }),
  });
}
