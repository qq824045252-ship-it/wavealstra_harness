import type Database from "better-sqlite3";
import { botExecutionDiagnosticsRequestSchema, type BotExecutionDiagnosticsDto } from "../../../shared/bot-execution-diagnostics";
import type { TaskDiagnosticsRepository } from "../TaskDiagnosticsRepository";
import type { WorkService } from "./WorkService";
import type { BotRegistry } from "./BotRegistry";

/** Read only. Scope comes from persisted ownership, never a renderer-supplied task ID. */
export function botExecutionDiagnostics(db: Database.Database, userId: string, request: unknown,
  diagnostics: TaskDiagnosticsRepository, works: WorkService, bots: BotRegistry): BotExecutionDiagnosticsDto {
  const input = botExecutionDiagnosticsRequestSchema.parse(request);
  const note = "复用普通任务诊断。仅显示实际采集的调用；历史缺失不补零、不重跑。每个对话/执行分别查看，缓存率来自供应商原始字段。";
  if (input.kind === "work") {
    const work = works.getWork(input.workId);
    if (!work || work.userId !== userId) throw new Error("事项不存在或不属于当前用户");
    // A resumed binding may reuse its native task: show that trace once, not as duplicated executions.
    const bindings = works.repo.listBindings(work.workId);
    const tasks = [...new Map(bindings.map(binding => [binding.taskId, binding])).values()];
    return { conversations: [], note, groups: tasks.map((binding, index) => ({
      id: binding.taskId, label: `${bots.getBot(binding.botId)?.displayName ?? "成员"} · 执行任务 ${index + 1} · ${binding.status}`,
      value: diagnostics.list(binding.taskId),
    })) };
  }
  const bot = bots.getBot(input.botId);
  if (!bot || bot.userId !== userId) throw new Error("Bot 不属于当前用户");
  const rows = db.prepare(`SELECT conversation_id,created_at,archived_at,
    (SELECT substr(text,1,60) FROM bot_messages m WHERE m.conversation_id=c.conversation_id AND m.role='user' ORDER BY m.created_at LIMIT 1) AS title
    FROM bot_conversations c WHERE user_id=? AND ${input.teamId ? "team_id=?" : "bot_id=? AND team_id IS NULL"}
    AND conversation_id NOT LIKE 'bot-inbox-%' ORDER BY created_at DESC`).all(userId, input.teamId ?? input.botId) as Array<{conversation_id:string;created_at:number;archived_at:number|null;title:string|null}>;
  const selected = input.conversationId ? rows.find(row => row.conversation_id === input.conversationId) : rows[0];
  if (input.conversationId && !selected) throw new Error("对话不属于当前 Bot 或团队");
  const conversations = rows.map(row => ({id:row.conversation_id,label:`${row.title || "新对话"}${row.archived_at ? " · 历史" : ""}`}));
  if (!selected) return { conversations, groups: [], note };
  const scopes = (db.prepare("SELECT message_id FROM bot_messages WHERE conversation_id=? AND role='assistant'").all(selected.conversation_id) as Array<{message_id:string}>).map(row => `bot-foreground:${row.message_id}`);
  return { conversations, conversationId:selected.conversation_id, note, groups:[{id:selected.conversation_id,label:"前台对话",value:diagnostics.listScopes(selected.conversation_id,scopes)}] };
}
