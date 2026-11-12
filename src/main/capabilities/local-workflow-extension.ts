import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { CronService } from "../cron/CronService";
import type { TaskTerminalService } from "../terminal/TaskTerminalService";

export interface LocalWorkflowBridge {
  cron: CronService;
  terminal: TaskTerminalService;
  getPermissionMode(): PermissionMode;
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
  taskId: string; taskRoot: string; services: LocalWorkflowBridge; terminalEnabled: boolean;
}): void {
  const { taskId, taskRoot, services } = context;
  pi.registerTool({
    name: "automation_exec",
    label: "Task automation",
    description: "当前任务专属本地调度。create 支持 at/every/cron，可继续当前对话或新建任务。every 为真实持续间隔，例如 90s。应用关闭或休眠时不执行，resume 重启只恢复未来触发、不补跑；pause 重启停用。忙碌任务跳过、不排队；cancel 只阻止未来启动，不中断已开始的用户回合。可 list/runs/pause/resume/cancel；Automation 页面也可管理。必须有用户的定时意图，不用长时间 bash sleep 替代。",
    promptSnippet: "automation_exec(action, name?, prompt?, schedule_type?, schedule_expr?, target?, max_runs?, deadline?, restart_policy?, id?)",
    parameters: Type.Object({
      action: Type.Union((["create", "list", "runs", "pause", "resume", "cancel"] as const).map(value => Type.Literal(value))),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
      schedule_type: Type.Optional(Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")])),
      schedule_expr: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      target: Type.Optional(Type.Union([Type.Literal("current-task"), Type.Literal("new-task")])),
      max_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
      deadline: Type.Optional(Type.String({ description: "ISO timestamp, including timezone" })),
      restart_policy: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("pause")])),
      id: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }, { additionalProperties: false }),
    execute: async (_id, input, signal) => result(() => {
      signal?.throwIfAborted();
      if (input.action === "list") return { jobs: services.cron.listForTask(taskId), localOnly: true, missedRuns: "skip" };
      if (input.action === "runs") return services.cron.runsForTask(taskId, input.limit);
      if (input.action === "create") {
        if (!input.name?.trim() || !input.prompt?.trim() || !input.schedule_type || !input.schedule_expr) throw new Error("create requires name, prompt, schedule_type and schedule_expr");
        const effectiveTo = input.deadline ? Date.parse(input.deadline) : undefined;
        if (effectiveTo != null && (!Number.isFinite(effectiveTo) || effectiveTo <= Date.now())) throw new Error("deadline must be a future ISO timestamp");
        return services.cron.createForTask(taskId, taskRoot, {
          name: input.name, prompt: input.prompt, scheduleType: input.schedule_type,
          scheduleExpr: input.schedule_expr, timezone: input.timezone ?? "UTC",
          target: input.target ?? "current-task", maxRuns: input.max_runs,
          effectiveTo, restartPolicy: input.restart_policy ?? "resume",
        });
      }
      if (!input.id) throw new Error("This action requires id");
      services.cron.changeForTask(taskId, input.id, input.action);
      return { id: input.id, action: input.action, jobs: services.cron.listForTask(taskId) };
    }),
  });
  if (!context.terminalEnabled) return;
  pi.registerTool({
    name: "terminal_exec",
    label: "Task terminal",
    description: "模型独占持久 PTY/TUI。交互安装向导、需要 TTY 的 CLI、密码提示和 TUI 应使用本工具，而不是非交互 bash/powershell。普通 shell 报 stdin is not a TTY 不代表本机没有终端；先检查已有操作效果再决定是否重试，不能盲目重跑安装或其他写操作。open 分配独立 terminal_id 和 session_id，cwd 固定当前任务，不接管用户终端。read 返回解析 ANSI 后的当前屏幕、光标和退出状态，不是输出尾部；wait_for 为字面文本，结果明确 matched/timeout/exited。input 原样发送 text，Enter 用 \\r，Ctrl-C 用 \\u0003。输入不自动重试。resize、close 均要求该任务原会话 ID。每任务最多四个终端，完成操作后 close；用户停止任务时只清理模型终端。",
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
