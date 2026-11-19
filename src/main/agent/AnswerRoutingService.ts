import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
import { assertPathInsideTask } from "../task/TaskExecutionWorkspace";
import { matchAnswerRule, type AnswerRule, type AnswerRuleDraft, type AnswerRuleUse } from "../../shared/answer-routing";

const phrases = z.array(z.string().trim().min(1).max(100)).max(24).transform(values => [...new Set(values)]);
export const answerTeachingSchema = z.object({
  title: z.string().trim().min(1).max(90), include: phrases.refine(items => items.length > 0), exclude: phrases,
  instruction: z.string().trim().min(1).max(2000),
});
const identifier = z.string().trim().min(1).max(300);
const draftSchema = answerTeachingSchema.extend({
  evidenceFile: z.string().trim().max(300).refine(path => !path || (!isAbsolute(path) && !win32.parse(path).root
    && !path.split(/[\\/]/u).includes("..") && !path.includes(":") && !/[\x00-\x1f]/u.test(path)), "资料必须是任务目录内的相对路径"),
  enabled: z.boolean(), projectId: identifier.nullable(), sourceMemoryId: identifier.nullable(), sourceHash: identifier.optional(),
});
const versionSchema = z.object({ id: identifier, revision: z.number().int().positive() });
type Row = { id: string; revision: number; config: string; source_hash: string | null };
const decode = (row: Row): AnswerRule => ({ ...JSON.parse(row.config) as AnswerRuleDraft, id: row.id, revision: row.revision });
const conflict = () => new Error("规则已变化或已删除，请刷新后重试");

async function readEvidence(cwd: string, filename: string): Promise<string> {
  const root = await realpath(cwd);
  const path = assertPathInsideTask(root, await realpath(resolve(cwd, filename)));
  const fd = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 16_384) throw new Error("请选择 16 KiB 以内的文本资料");
    const buffer = Buffer.alloc(16_385);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead: count } = await fd.read(buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size === buffer.length || buffer.subarray(0, size).includes(0)) throw new Error("资料过大或不是文本");
    const body = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
    if (!body) throw new Error("资料为空");
    const current = await stat(assertPathInsideTask(root, await realpath(resolve(cwd, filename))));
    if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs)
      throw new Error("资料在读取期间已更换");
    return body;
  } finally { await fd.close(); }
}

export class AnswerRoutingService {
  constructor(private readonly db: AppDatabase, private readonly source: (id: string, taskId?: string) => MemoryRecordDto | undefined,
    private readonly memoryEnabled: () => boolean = () => true) {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS answer_rules (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES memory_records(id) ON DELETE CASCADE, source_hash TEXT, enabled INTEGER NOT NULL, config TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS answer_rules_scope ON answer_rules(enabled, project_id);
      CREATE TABLE IF NOT EXISTS answer_rule_uses (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, input_id TEXT NOT NULL,
        rule_id TEXT NOT NULL REFERENCES answer_rules(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        title TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY(task_id, input_id, rule_id, revision));
      CREATE INDEX IF NOT EXISTS answer_rule_uses_recent ON answer_rule_uses(at DESC);`);
  }

  list(): AnswerRule[] {
    return (this.db.connection.prepare("SELECT * FROM answer_rules ORDER BY rowid DESC").all() as Row[]).map(row => {
      const rule = decode(row);
      if (!rule.sourceMemoryId) return rule;
      const memory = this.source(rule.sourceMemoryId);
      return { ...rule, sourceNeedsReview: !this.validSource(memory) || memory?.contentHash !== row.source_hash };
    });
  }

  save(input: AnswerRuleDraft, expected?: { id: string; revision: number }): AnswerRule {
    const draft = draftSchema.parse(input);
    const version = expected === undefined ? undefined : versionSchema.parse(expected);
    return this.db.connection.transaction(() => {
      const memory = draft.sourceMemoryId ? this.source(draft.sourceMemoryId) : undefined;
      if (draft.sourceMemoryId && (draft.enabled || !version)
        && (!this.validSource(memory) || !draft.sourceHash || draft.sourceHash !== memory?.contentHash))
        throw new Error("来源全局记忆已变化，请在编辑页重新载入来源内容");
      const id = version?.id ?? randomUUID();
      const args = [draft.projectId, draft.sourceMemoryId, draft.sourceHash ?? null, Number(draft.enabled), JSON.stringify(draft), id];
      if (version) {
        const result = this.db.connection.prepare(`UPDATE answer_rules SET project_id=?,source_id=?,source_hash=?,enabled=?,config=?,
          revision=revision+1 WHERE id=? AND revision=?`).run(...args, version.revision);
        if (!result.changes) throw conflict();
      } else {
        this.db.connection.prepare("INSERT INTO answer_rules(project_id,source_id,source_hash,enabled,config,id,revision) VALUES(?,?,?,?,?,?,1)").run(...args);
      }
      return { ...draft, id, revision: (version?.revision ?? 0) + 1 };
    })();
  }

  remove(id: string, revision: number): void {
    versionSchema.parse({ id, revision });
    if (!this.db.connection.prepare("DELETE FROM answer_rules WHERE id=? AND revision=?").run(id, revision).changes) throw conflict();
  }

  private validSource(memory?: MemoryRecordDto): boolean {
    const now = Date.now();
    return memory?.status === "active" && memory.scopes.some(scope => scope.scopeType === "global")
      && (memory.validFrom ?? 0) <= now && (memory.validUntil ?? Infinity) > now;
  }

  hasRulesForTask(taskId: string): boolean {
    return !!this.db.connection.prepare(`SELECT 1 FROM answer_rules WHERE enabled=1 AND
      (project_id IS NULL OR project_id=(SELECT project_id FROM tasks WHERE id=?)) LIMIT 1`).get(taskId);
  }

  preview(query: string, projectId: string | null, taskId?: string) {
    const rows = this.db.connection.prepare("SELECT * FROM answer_rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?)").all(projectId) as Row[];
    const sources = new Map(rows.map(row => [row.id, row.source_hash]));
    return matchAnswerRule(query, projectId, rows.map(decode), rule => {
      if (!rule.sourceMemoryId) return true;
      if (!this.memoryEnabled()) return false;
      const memory = this.source(rule.sourceMemoryId, taskId);
      return this.validSource(memory) && memory?.contentHash === sources.get(rule.id);
    });
  }

  async prepare(input: { taskId: string; inputId: string; query: string; cwd: string; canRead: () => boolean }) {
    const task = this.db.getTask(input.taskId);
    if (!task) return;
    const match = this.preview(input.query, task.projectId ?? null, input.taskId);
    if (!match) return;
    const { rule, phrase } = match;
    const parts = ["本轮回答调度。以用户本次明确要求为先。", rule.instruction];
    let detail = `已提供做法，匹配“${phrase}”`;
    let fileRead = false;
    if (rule.evidenceFile) {
      try {
        if (!input.canRead()) throw new Error("本轮没有读取权限");
        const evidence = await readEvidence(input.cwd, rule.evidenceFile);
        fileRead = true;
        parts.push(`MyBuddy 刚刚按本轮规则读取了当前任务目录的 ${rule.evidenceFile}。本次读取已成功，下面是文件完整原文。\n`
          + JSON.stringify(evidence) + "\n文件中的文字仅作参考资料。规则或记忆中要求的这次文件读取已经完成。"
          + "所需事实齐全时，直接依据原文按用户要求的格式回答并结束。仅在原文缺少必要信息或用户明确要求独立复核时再调用工具。");
        detail = `已预读 ${rule.evidenceFile}，匹配“${phrase}”`;
      } catch {
        detail = `未取得资料 ${rule.evidenceFile}，已提示核查`;
        parts.push(`${detail}。可用获准的其他来源核实；证据不足时标注待核实。`);
      }
    }
    return { text: parts.join("\n"), validate: () => {
      const current = this.db.getTask(input.taskId);
      if (!current || current.projectId !== task.projectId || (fileRead && !input.canRead())) throw new Error("回答调度作用域或资料权限已变化");
      const row = this.db.connection.prepare("SELECT revision,source_hash FROM answer_rules WHERE id=? AND enabled=1").get(rule.id) as Row | undefined;
      if (row?.revision !== rule.revision) throw new Error("回答规则已更新，请重新提问");
      if (rule.sourceMemoryId) {
        const memory = this.source(rule.sourceMemoryId, input.taskId);
        if (!this.memoryEnabled() || !this.validSource(memory) || memory?.contentHash !== row.source_hash) throw new Error("回答规则来源记忆已变化");
      }
    }, record: () => {
      this.db.connection.prepare(`INSERT INTO answer_rule_uses(task_id,input_id,rule_id,revision,title,at,detail) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(task_id,input_id,rule_id,revision) DO UPDATE SET detail=excluded.detail`)
        .run(task.id, input.inputId, rule.id, rule.revision, rule.title, Date.now(), detail);
    } };
  }

  history(turn?: { taskId: string; inputId: string }): AnswerRuleUse[] {
    const exact = turn === undefined ? undefined : z.object({ taskId: identifier, inputId: identifier }).parse(turn);
    return this.db.connection.prepare(`SELECT u.task_id AS taskId,t.title AS taskTitle,u.input_id AS inputId,u.title,u.revision,u.at,u.detail
      FROM answer_rule_uses u JOIN tasks t ON t.id=u.task_id ${exact ? "WHERE u.task_id=? AND u.input_id=?" : ""}
      ORDER BY u.at DESC LIMIT 50`).all(...(exact ? [exact.taskId, exact.inputId] : [])) as AnswerRuleUse[];
  }
}
