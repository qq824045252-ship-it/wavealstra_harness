import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import type { CronJobDto } from "../../../shared/agent-ipc";
import type { BotForegroundToolOptions } from "./BotForegroundTools";
import { botForegroundRequest } from "./BotForegroundIdentity";

const text = z.string().trim().min(1).max(2000);
const schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("after"), seconds: z.number().int().min(1).max(315360000) }).strict(),
  z.object({ kind: z.literal("at"), iso: z.string().datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("every"), seconds: z.number().int().min(1).max(315360000) }).strict(),
  z.object({ kind: z.literal("cron"), expression: text }).strict(),
]);
const request = z.object({ action: z.enum(["list", "create", "update", "pause", "resume", "cancel", "snooze"]),
  reminderId: text.optional(), title: text.optional(), content: text.optional(), schedule: schedule.optional(),
  timezone: z.string().min(1).optional(), snoozeSeconds: z.number().int().min(1).max(315360000).optional() }).strict();

export function reminderSchedule(input: z.infer<typeof schedule>, receivedAt: number): Pick<CronJobDto, "scheduleType" | "scheduleExpr"> {
  if (input.kind === "after") return { scheduleType: "at", scheduleExpr: new Date(receivedAt + input.seconds * 1000).toISOString() };
  if (input.kind === "at") return { scheduleType: "at", scheduleExpr: input.iso };
  if (input.kind === "every") return { scheduleType: "every", scheduleExpr: `${input.seconds}s` };
  return { scheduleType: "cron", scheduleExpr: input.expression };
}

export function botReminderTool(options: BotForegroundToolOptions) {
  return defineTool({ name: "reminder_manage",
    description: "纯提醒专用：例如2分钟后提醒喝水、每天9点提醒。到时直接发已保存的内容，不调用模型、不创建Work。create必须给title/content/schedule；相对时间传after.seconds由宿主按本次用户消息时间计算，绝对时间用带时区ISO，重复用every.seconds或cron.expression+IANA timezone。不要心算Unix时间。list查询当前Bot或团队所有对话的提醒；update改期/内容，pause/resume/cancel管理，snooze将同一提醒稍后再发（需要snoozeSeconds，仅调整下一次提醒，重复周期保留）。已有同一提醒改期不要新建；同名歧义先list并明确目标。仅替用户提醒，不把发出当用户已完成；到时需要做研究/执行的不是纯提醒，应交Work。只有返回成功才能承诺，说明具体下次时间；本机离线无法准时弹出，恢复后合并补发。",
    parameters: Type.Unsafe<z.input<typeof request>>(z.toJSONSchema(request, { target: "draft-7", io: "input" })), replay: "safe",
    execute: async (args, api, context) => {
      const input = request.parse(args);
      const cron = options.reminders?.();
      if (!cron) throw new Error("提醒服务尚未初始化");
      const bot = options.bots.getBot(options.botId);
      if (!bot || bot.userId !== options.userId || bot.status !== "active" || !options.isAuthority()) throw new Error("当前Bot不可安排提醒");
      const scoped = () => cron.list().filter(job => job.reminder?.userId === options.userId
        && (options.teamId ? job.reminder.teamId === options.teamId : job.reminder.botId === options.botId && !job.reminder.teamId));
      const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
      const summarize = (job: CronJobDto) => ({ reminderId: job.id, title: job.name, content: job.prompt,
        enabled: job.enabled, state: job.reminder?.state ?? (job.enabled ? "scheduled" : "paused"), scheduleType: job.scheduleType, scheduleExpr: job.scheduleExpr, timezone: job.timezone,
        nextReminderAt: job.nextRunAt === undefined ? null : new Date(job.nextRunAt).toISOString(),
        nextReminderLocal: job.nextRunAt === undefined ? null : new Intl.DateTimeFormat("zh-CN", { timeZone: job.timezone, dateStyle: "full", timeStyle: "long" }).format(job.nextRunAt),
        deliveredCount: job.runCount ?? 0, conversationId: job.reminder!.conversationId, delivery: "local-app; offline reminders are delivered late after reopening" });
      if (input.action === "list") return output({ reminders: scoped().map(summarize) });
      const requestId = await botForegroundRequest(api, api.callId, context);
      const receipt = options.messages.receipt(options.userId, options.botId, requestId);
      const source = receipt && options.messages.message(receipt.user_message_id);
      const assistant = receipt && options.messages.message(receipt.assistant_message_id);
      if (!source || !assistant || receipt!.conversation_id !== options.conversationId
        || !["running", "queued", "unknown"].includes(assistant.status)) throw new Error("缺少当前用户请求");
      const operationId = `reminder:${options.userId}:${options.botId}:${options.conversationId}:${requestId}:${api.taskId}`;
      const result = options.db.transaction(() => {
        const prior = options.db.prepare("SELECT result_json FROM cron_reminder_operations WHERE operation_id=?").get(operationId) as { result_json: string } | undefined;
        if (prior) return JSON.parse(prior.result_json) as unknown;
        let job = input.reminderId ? scoped().find(job => job.id === input.reminderId) : undefined;
        if (input.action !== "create" && !job) throw new Error("请先list并选择属于当前Bot/团队的reminderId，不能操作其他提醒");
        if (input.action === "create" || input.action === "update" || input.action === "snooze") {
          if (input.action === "create" && (!input.title || !input.content || !input.schedule)) throw new Error("创建提醒需要title/content/schedule");
          if (input.action === "snooze" && !input.snoozeSeconds) throw new Error("稍后提醒需要snoozeSeconds");
          const nextSchedule = input.action === "snooze" ? reminderSchedule({ kind: "after", seconds: input.snoozeSeconds! }, source.createdAt)
            : input.schedule ? reminderSchedule(input.schedule, source.createdAt) : { scheduleType: job!.scheduleType, scheduleExpr: job!.scheduleExpr };
          if (nextSchedule.scheduleType === "at" && Date.parse(nextSchedule.scheduleExpr) < source.createdAt) throw new Error("提醒时间早于本次请求，请根据当前时间修正，不要建立过去的提醒");
          const timezone = input.timezone ?? job?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
          const now = Date.now();
          if (input.action === "snooze" && job!.scheduleType !== "at") job = cron.snoozeReminder(job!.id, source.createdAt + input.snoozeSeconds! * 1000);
          else job = cron.upsert({ ...job, id: job?.id ?? `reminder-${createHash("sha256").update(operationId).digest("hex")}`,
            name: input.title ?? job!.name, prompt: input.content ?? job!.prompt, ...nextSchedule, timezone,
            enabled: true, createdAt: job?.createdAt ?? now, updatedAt: now, restartPolicy: "resume",
            reminder: job?.reminder ? { ...job.reminder, state: "scheduled" } : { state: "scheduled", kind: "bot-reminder", userId: options.userId, botId: options.botId,
              conversationId: options.conversationId, ...(options.teamId ? { teamId: options.teamId } : {}) } });
        } else {
          cron.setEnabled(job!.id, input.action === "resume", input.action === "cancel" ? "cancelled" : undefined);
          job = cron.list().find(value => value.id === job!.id)!;
        }
        const result = { ok: true, action: input.action, reminder: summarize(job!) };
        options.db.prepare("INSERT INTO cron_reminder_operations VALUES (?,?)").run(operationId, JSON.stringify(result));
        return result;
      }).immediate();
      return output(result);
    },
  });
}
