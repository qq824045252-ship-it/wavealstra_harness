import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { z } from "zod";
import { startAnswerRoutingTiming } from "./AnswerRoutingTimings";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryService } from "../library/LibraryService";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
import { assertPathInsideTask, TaskPathBoundaryError } from "../task/TaskExecutionWorkspace";
import { eligibleAnswerEvidenceItem, matchAnswerRule, maxAnswerEvidenceBytes, newAnswerRule, type AnswerRoutingHistoryQuery, type AnswerRule,
  type AnswerRuleDraft, type AnswerRuleEvidence, type AnswerRuleUse } from "../../shared/answer-routing";

const phrases = z.array(z.string().trim().min(1).max(100)).max(24).transform(values => [...new Set(values)]);
export const answerTeachingSchema = z.object({
  title: z.string().trim().min(1).max(90), include: phrases.refine(items => items.length > 0), exclude: phrases,
  instruction: z.string().trim().min(1).max(2000),
});
const identifier = z.string().trim().min(1).max(300);
const draftSchema = answerTeachingSchema.extend({
  evidenceFile: z.string().trim().max(300).refine(path => !path || (!isAbsolute(path) && !win32.parse(path).root
    && !path.split(/[\\/]/u).includes("..") && !path.includes(":") && !/[\x00-\x1f]/u.test(path)), "资料必须是任务目录内的相对路径"),
  evidenceLibraryItemId: identifier.nullable().optional(), evidenceFailure: z.enum(["verify", "mark-unverified"]).optional(),
  enabled: z.boolean(), projectId: identifier.nullable(), sourceMemoryId: identifier.nullable(), sourceHash: identifier.optional(),
  sourcePrefixLength: z.number().int().positive().max(1999).optional(),
}).refine(draft => !(draft.evidenceFile && draft.evidenceLibraryItemId), "每条规则只能选择一种资料来源");
const versionSchema = z.object({ id: identifier, revision: z.number().int().positive() });
const chatChanges = answerTeachingSchema.partial().extend({
  enabled: z.boolean().optional(), evidenceFile: z.string().optional(),
  evidenceLibraryItemId: identifier.nullable().optional(),
  evidenceFailure: z.enum(["verify", "mark-unverified"]).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "请提供需要修改的字段");
const historyQuerySchema = z.union([
  z.object({ taskId: identifier, inputId: identifier }).strict(),
  z.object({ taskId: identifier, inputIds: z.array(identifier).max(200) }).strict(),
]);
type Row = { id: string; revision: number; config: string; source_hash: string | null };
const decode = (row: Row): AnswerRule => ({ ...JSON.parse(row.config) as AnswerRuleDraft, id: row.id, revision: row.revision });
const conflict = () => new Error("规则已变化或已删除，请刷新后重试");

class EvidenceFailure extends Error {
  constructor(readonly status: "denied" | "not-found" | "failed", message: string) { super(message); }
}
const skipReadInChinese = /(?:^|[。！？!?,，；;\s])(?:本轮|本次|这次|今天)?\s*请?\s*(?:不要|不用|无需|不必|不|别|禁止|跳过)\s*(?:再)?\s*(?:自动)?\s*(?:预读|读取|阅读|打开|查阅|查看|查|读)\s*(?:资料|文件|文档|来源|材料|记录|报告|项目|任务|参考|任何|所有|[\w`"“《]|[。！？!?,，；;]|$)/u;
const skipReadInEnglish = /\b(?:do not|don['’]t|skip|no need to)\s+(?:auto(?:matic)?[- ]?)?(?:pre[- ]?read|read|open|consult)(?:ing)?\s+(?:the\s+|any\s+)?(?:files?|documents?|evidence|sources?|materials?)\b/iu;

function skipRead(query: string): boolean {
  const normalized = query.normalize("NFKC");
  return skipReadInChinese.test(normalized) || skipReadInEnglish.test(normalized);
}

function evidenceFailure(error: unknown): EvidenceFailure {
  if (error instanceof EvidenceFailure) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new EvidenceFailure("not-found", "找不到资料");
  if (code === "EACCES" || code === "EPERM" || error instanceof TaskPathBoundaryError)
    return new EvidenceFailure("denied", "本轮没有读取该资料的权限");
  return new EvidenceFailure("failed", "读取失败，资料可能正在变更或无法解码");
}

function readEvidence(cwd: string, filename: string, inputId: string) {
  const finish = startAnswerRoutingTiming("readEvidence");
  const read = readEvidenceFile(cwd, filename);
  if (!finish) return read;
  return read.then(result => {
    finish(() => ({ inputId, outcome: "read" }));
    return result;
  }, error => {
    finish(() => ({ inputId, outcome: evidenceFailure(error).status }));
    throw error;
  });
}

async function readEvidenceFile(cwd: string, filename: string) {
  const root = await realpath(cwd);
  const requestedPath = resolve(cwd, filename);
  const path = assertPathInsideTask(root, await realpath(requestedPath));
  const fd = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxAnswerEvidenceBytes) throw new EvidenceFailure("failed", "资料必须是 16 KiB 以内的文本文件");
    const buffer = Buffer.alloc(maxAnswerEvidenceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead: count } = await fd.read(buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    if (size === buffer.length || bytes.includes(0)) throw new EvidenceFailure("failed", "资料过大或不是文本");
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!body.trim()) throw new EvidenceFailure("failed", "资料为空");
    const currentPath = assertPathInsideTask(root, await realpath(requestedPath));
    const current = await stat(currentPath);
    if (currentPath !== path || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs)
      throw new EvidenceFailure("failed", "资料在读取期间已更换");
    return { body, path, contentHash: createHash("sha256").update(bytes).digest("hex"), readAt: Date.now(),
      available: () => {
        if (realpathSync(requestedPath) !== path) return false;
        accessSync(path, constants.R_OK);
        return true;
      } };
  } finally { await fd.close(); }
}

type Turn = { taskId: string; inputId: string; query: string; cwd: string; canRead: () => boolean; canReadLibrary?: () => boolean };
type PreparedRoute = {
  text: string;
  render: (instruction: string) => string;
  rule: AnswerRule;
  validate: () => void;
  record: () => void;
};

export class AnswerRoutingService {
  private readonly turns = new Map<string, Map<string, Promise<PreparedRoute | undefined>>>();

  constructor(private readonly db: AppDatabase, private readonly source: (id: string, taskId?: string) => MemoryRecordDto | undefined,
    private readonly memoryEnabled: () => boolean = () => true,
    private readonly library?: () => LibraryService) {
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
      CREATE INDEX IF NOT EXISTS answer_rule_uses_recent ON answer_rule_uses(at DESC);
      CREATE TABLE IF NOT EXISTS answer_rule_turns (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, input_id TEXT NOT NULL,
        rule_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL,
        detail TEXT NOT NULL, phrase TEXT NOT NULL, evidence TEXT, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'applied',
        PRIMARY KEY(task_id, input_id));
      CREATE INDEX IF NOT EXISTS answer_rule_turns_recent ON answer_rule_turns(at DESC);
      CREATE INDEX IF NOT EXISTS answer_rule_turns_source_history ON answer_rule_turns(task_id,rule_id,at DESC);`);
    db.connection.transaction(() => {
      const columns = db.connection.pragma("table_info(answer_rule_turns)") as Array<{ name: string }>;
      if (columns.some(column => column.name === "status")) return;
      db.connection.exec(`
        ALTER TABLE answer_rule_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
        UPDATE answer_rule_turns SET status='revoked'
          WHERE detail LIKE '本轮回答调度已撤销：%'
             OR CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.status') END = 'revoked';`);
    }).immediate();
  }

  list(): AnswerRule[] {
    return (this.db.connection.prepare("SELECT * FROM answer_rules ORDER BY rowid DESC").all() as Row[]).map(row => {
      const rule = decode(row);
      if (!rule.sourceMemoryId) return rule;
      const memory = this.source(rule.sourceMemoryId);
      return { ...rule, sourceNeedsReview: !this.validSource(memory) || memory?.contentHash !== row.source_hash };
    });
  }

  taskScope(taskId: string): string | null {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("当前对话已不存在");
    return task.projectId ?? null;
  }

  rulesForTask(taskId: string): AnswerRule[] {
    const rows = this.db.connection.prepare("SELECT * FROM answer_rules WHERE project_id IS NULL OR project_id=? ORDER BY project_id IS NULL, rowid DESC")
      .all(this.taskScope(taskId)) as Row[];
    return rows.map(decode).filter(rule => {
      if (!rule.sourceMemoryId) return true;
      const memory = this.memoryEnabled() ? this.source(rule.sourceMemoryId, taskId) : undefined;
      return this.validSource(memory) && memory?.contentHash === rule.sourceHash;
    });
  }

  saveForTask(taskId: string, input: unknown): AnswerRule {
    const { changes, version, scope, independent } = z.object({
      changes: chatChanges, version: versionSchema.strict().optional(), scope: z.enum(["project", "global"]).optional(),
      independent: z.literal(true).optional(),
    }).strict().parse(input);
    return this.db.connection.transaction(() => {
      const project = this.taskScope(taskId);
      if (scope === "project" && !project) throw new Error("当前对话没有所属项目");
      const projectId = scope === "global" ? null : project;
      const rules = this.rulesForTask(taskId);
      const current = version && rules.find(rule => rule.id === version.id);
      if (version && (!current || current.revision !== version.revision)) throw conflict();
      if (current?.projectId && projectId !== current.projectId) throw new Error("项目规则不能直接改为全局，请另建全局规则。");
      const updating = current && current.projectId === projectId;
      if (current && !updating && changes.enabled === false) throw new Error("这是全局规则。若要在所有对话停用，请明确选择 global。");
      const draft = { ...(current ?? newAnswerRule()), ...changes, projectId };
      if (independent) { draft.sourceMemoryId = null; delete draft.sourceHash; delete draft.sourcePrefixLength; }
      if (draft.sourcePrefixLength && current && !draft.instruction.startsWith(current.instruction.slice(0, draft.sourcePrefixLength) + "\n")) {
        delete draft.sourcePrefixLength;
      }
      if (changes.evidenceFile && changes.evidenceLibraryItemId === undefined) draft.evidenceLibraryItemId = null;
      if (changes.evidenceLibraryItemId) {
        if (!eligibleAnswerEvidenceItem(this.readableLibraryItem(taskId, changes.evidenceLibraryItemId))) throw new Error("请选择可预读的文本资料");
        if (changes.evidenceFile === undefined) draft.evidenceFile = "";
      }
      if (!updating && rules.some(rule => rule.projectId === projectId && rule.title === draft.title.trim())) {
        throw new Error("已有同名规则，请读取该规则的 ID 和版本后修改。");
      }
      return this.save(draft, updating ? version : undefined);
    }).immediate();
  }

  save(input: AnswerRuleDraft, expected?: { id: string; revision: number }): AnswerRule {
    const draft = draftSchema.parse(input);
    const version = expected === undefined ? undefined : versionSchema.parse(expected);
    return this.db.connection.transaction(() => {
      const memory = draft.sourceMemoryId ? this.source(draft.sourceMemoryId) : undefined;
      if (draft.sourceMemoryId && (draft.enabled || !version)
        && (!this.validSource(memory) || !draft.sourceHash || draft.sourceHash !== memory?.contentHash))
        throw new Error("来源全局记忆已变化，请在编辑页重新载入来源内容");
      if (draft.sourcePrefixLength !== undefined && (draft.enabled || !version) &&
          (!memory || draft.sourcePrefixLength !== memory.content.length || !draft.instruction.startsWith(memory.content + "\n"))) {
        throw new Error("已引用的记忆原文与回答做法不一致，请重新比对。");
      }
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
    return this.turns.has(taskId) || !!this.db.connection.prepare(`SELECT 1 FROM answer_rules WHERE enabled=1 AND
      (project_id IS NULL OR project_id=(SELECT project_id FROM tasks WHERE id=?))
      UNION ALL SELECT 1 FROM answer_rule_turns WHERE task_id=? LIMIT 1`).get(taskId, taskId);
  }

  preview(query: string, projectId: string | null, taskId?: string) {
    const rows = this.db.connection.prepare("SELECT * FROM answer_rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?)").all(projectId) as Row[];
    const sources = new Map(rows.map(row => [row.id, row.source_hash]));
    return matchAnswerRule(query, projectId, rows.map(decode), rule => {
      if (!rule.sourceMemoryId) return true;
      if (!this.memoryEnabled()) return false;
      const memory = this.source(rule.sourceMemoryId, taskId);
      return this.validSource(memory) && memory?.contentHash === sources.get(rule.id);
    }, !taskId);
  }

  prepare(input: Turn): Promise<PreparedRoute | undefined> {
    let taskTurns = this.turns.get(input.taskId);
    if (!taskTurns) {
      taskTurns = new Map();
      this.turns.set(input.taskId, taskTurns);
    }
    const previous = taskTurns.get(input.inputId);
    if (previous) return previous;
    const prepared = this.prepareFirstRequest(input);
    taskTurns.set(input.inputId, prepared);
    return prepared;
  }

  clearPreparedTurns(taskId: string, observedInputId?: string): void {
    if (!observedInputId) {
      this.turns.delete(taskId);
      return;
    }
    const turns = this.turns.get(taskId);
    if (!turns?.has(observedInputId)) return;
    for (const id of turns.keys()) {
      turns.delete(id);
      if (id === observedInputId) break;
    }
    if (!turns.size) this.turns.delete(taskId);
  }

  private async prepareFirstRequest(input: Turn): Promise<PreparedRoute | undefined> {
    const task = this.db.getTask(input.taskId);
    if (!task) return;
    const prior = this.db.connection.prepare(`SELECT rule_id,revision,at,detail,phrase,evidence,scope,status FROM answer_rule_turns
      WHERE task_id=? AND input_id=?`).get(input.taskId, input.inputId) as
      { rule_id: string; revision: number; at: number; detail: string; phrase: string; evidence: string | null; scope: string;
        status: AnswerRuleUse["routeStatus"] } | undefined;
    const scope = JSON.stringify({ projectId: task.projectId ?? null, cwd: input.cwd });
    const cannotRestore = () => new Error("无法恢复这轮回答的原始调度快照，请重新提问");
    const priorRule = prior ? this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=? AND revision=? AND enabled=1")
      .get(prior.rule_id, prior.revision) as Row | undefined : undefined;
    if (prior && (!priorRule || prior.scope !== scope || prior.status === "revoked")) throw cannotRestore();
    const finishMatch = startAnswerRoutingTiming("ruleMatch");
    const match = prior && priorRule ? { rule: decode(priorRule), phrase: prior.phrase }
      : this.preview(input.query, task.projectId ?? null, input.taskId);
    finishMatch?.(() => ({ inputId: input.inputId, method: prior && priorRule ? "restore" : "match", matched: !!match, ruleId: match?.rule.id }));
    if (!match) return;
    const { rule, phrase } = match;
    const memory = rule.sourceMemoryId ? this.source(rule.sourceMemoryId, input.taskId) : undefined;
    if (prior && rule.sourceMemoryId && (!this.memoryEnabled() || !this.validSource(memory)
      || memory?.contentHash !== rule.sourceHash || priorRule?.source_hash !== rule.sourceHash)) throw cannotRestore();
    const introduction = "本轮回答调度。以用户本次明确要求为先。";
    const evidenceParts: string[] = [];
    let detail = prior?.detail ?? `已提供做法，匹配“${phrase}”`;
    const priorEvidence = prior?.evidence ? JSON.parse(prior.evidence) as AnswerRuleEvidence : undefined;
    let evidence = priorEvidence;
    let available: (() => boolean) | undefined;
    let revocationReason: string | undefined;
    const reference = rule.evidenceLibraryItemId || rule.evidenceFile;
    const isLibrary = !!rule.evidenceLibraryItemId;
    const canRead = isLibrary ? () => input.canReadLibrary?.() === true : input.canRead;
    const addFailure = () => evidenceParts.push(`${detail}。以往对话里引用的版本只说明当时的情况，本轮尚未核实。` + (rule.evidenceFailure === "mark-unverified"
      ? "请直接标注待核实，勿发起替代资料读取。"
      : "可用获准的其他来源核实，证据不足时标注待核实。"));
    if (priorEvidence?.status === "revoked" || (rule.projectId && rule.projectId !== task.projectId)) throw cannotRestore();
    if (reference && !evidence) {
      evidence = { kind: isLibrary ? "project-material" : "task-file", reference, status: "skipped" };
    }
    if (priorEvidence?.status === "skipped" || (!priorEvidence && skipRead(input.query))) {
      if (evidence) evidence.reason = "用户本轮明确要求跳过读取";
      detail = `已按用户要求跳过读取${reference ? " " + reference : ""}，匹配“${phrase}”`;
      evidenceParts.push("用户本轮要求跳过资料读取。不要执行规则中的读取、重试或替代核查步骤。");
    } else if (priorEvidence && priorEvidence.status !== "read") {
      addFailure();
    } else if (evidence) {
      try {
        if (!canRead()) throw new EvidenceFailure("denied", "本轮没有读取该资料的权限");
        const item = isLibrary ? this.readableLibraryItem(input.taskId, reference) : undefined;
        if (item && !prior) evidence.label = item.title;
        const library = item ? this.library?.() : undefined;
        const path = item && library?.absolutePath(item);
        if (item && !eligibleAnswerEvidenceItem(item))
          throw new EvidenceFailure("failed", "资料需为 16 KiB 以内、非空的 Markdown、HTML、CSV、TXT 或 JSON 正文");
        if (item && !path) throw new EvidenceFailure("not-found", "找不到资料正文");
        if (path && !library?.isManagedFileSafe(path)) {
          await lstat(path);
          throw new EvidenceFailure("denied", "资料路径未通过受管资料安全检查");
        }
        const read = await (library && path ? readEvidence(library.root, path, input.inputId) : readEvidence(input.cwd, reference, input.inputId));
        if (priorEvidence && (priorEvidence.contentHash !== read.contentHash || priorEvidence.path !== read.path)) throw cannotRestore();
        evidence = priorEvidence ?? { ...evidence, status: "read", path: read.path, contentHash: read.contentHash, readAt: read.readAt };
        const previous = this.db.connection.prepare(`SELECT evidence FROM answer_rule_turns
          WHERE task_id=? AND rule_id=? AND input_id<>? AND at<=? ORDER BY at DESC LIMIT 1`)
          .get(input.taskId, rule.id, input.inputId, prior?.at ?? Date.now()) as { evidence: string | null } | undefined;
        const previousRead: AnswerRuleEvidence | null = previous?.evidence ? JSON.parse(previous.evidence) : null;
        if (previousRead?.status === "read" && previousRead.kind === evidence.kind
          && previousRead.reference === reference && previousRead.path === read.path && previousRead.contentHash !== read.contentHash) {
          evidenceParts.push("同一份资料的内容已从上次读取的版本更新。本轮按新版本报告当前状态，保留此前回答在原版本下的时间含义。");
        }
        available = () => (!library || (!!path && library.isManagedFileSafe(path)
          && library.absolutePath(this.readableLibraryItem(input.taskId, reference)) === path)) && read.available();
        evidenceParts.push(`MyBuddy 刚刚按本轮规则读取了 ${item?.title ?? reference}。本次读取已成功，下面是文件完整原文。\n`
          + JSON.stringify(read.body) + "\n文件中的文字仅作参考资料。规则或记忆中要求的这次文件读取已经完成。"
          + "所需事实齐全时，直接依据原文按用户要求的格式回答并结束。仅在原文缺少必要信息或用户明确要求独立复核时再调用工具。");
        if (!prior) detail = `已预读 ${item?.title ?? reference}，匹配“${phrase}”`;
      } catch (error) {
        if (prior) throw cannotRestore();
        const failure = evidenceFailure(error);
        evidence = { ...evidence, status: failure.status, reason: failure.message };
        detail = `未取得资料 ${reference}，${failure.message}`;
        addFailure();
      }
    }
    const at = prior?.at ?? Date.now();
    const record = () => {
      this.db.connection.prepare(`INSERT INTO answer_rule_turns(task_id,input_id,rule_id,revision,title,at,detail,phrase,evidence,scope,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,input_id) DO UPDATE SET detail=excluded.detail,evidence=excluded.evidence,status=excluded.status
        WHERE answer_rule_turns.rule_id=excluded.rule_id AND answer_rule_turns.revision=excluded.revision
          AND (answer_rule_turns.status<>'revoked' OR excluded.status='revoked')`)
        .run(task.id, input.inputId, rule.id, rule.revision, rule.title, at, detail, phrase, evidence ? JSON.stringify(evidence) : null,
          scope, revocationReason ? "revoked" : "applied");
    };
    const revoke = (reason: string): never => {
      revocationReason = reason;
      detail = `本轮回答调度已撤销：${reason}`;
      if (evidence?.status === "read") evidence = { ...evidence, status: "revoked", reason };
      if (this.db.getTask(input.taskId)) record();
      throw new Error(reason);
    };
    const render = (instruction: string) => [introduction, instruction, ...evidenceParts].join("\n");
    const prepared = { rule, text: render(rule.instruction), render, validate: () => {
      const current = this.db.getTask(input.taskId);
      if (revocationReason) throw new Error(revocationReason);
      if (!current || current.projectId !== task.projectId || (!isLibrary && reference && current.cwd !== task.cwd))
        revoke("回答调度作用域已变化");
      if (available) {
        let accessible = false;
        try { accessible = canRead() && available(); } catch { /* Source was removed or access was revoked. */ }
        if (!accessible) revoke("资料权限或来源已撤销");
      }
      const row = this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=? AND enabled=1").get(rule.id) as Row | undefined;
      if (!row) return revoke("回答规则已停用或删除");
      const currentRule = decode(row);
      if (currentRule.projectId !== rule.projectId || currentRule.sourceMemoryId !== rule.sourceMemoryId)
        revoke("回答规则的适用范围或来源记忆已变化");
      if (rule.sourceMemoryId) {
        const memory = this.source(rule.sourceMemoryId, input.taskId);
        if (!this.memoryEnabled() || !this.validSource(memory) || memory?.contentHash !== rule.sourceHash || row.source_hash !== rule.sourceHash)
          revoke("回答规则来源记忆已变化");
      }
    }, record };
    prepared.validate();
    prepared.record();
    return prepared;
  }

  private readableLibraryItem(taskId: string, id: string) {
    const library = this.library?.();
    if (!library) throw new EvidenceFailure("denied", "本轮没有资料库读取权限");
    const item = library.getItem(id);
    if (!item) throw new EvidenceFailure("not-found", "找不到资料");
    if (!library.isItemVisibleInScope(item, library.resolveTaskScope(taskId)))
      throw new EvidenceFailure("denied", "资料超出当前任务可见范围");
    return item;
  }

  history(turn?: AnswerRoutingHistoryQuery): AnswerRuleUse[] {
    const exact = turn === undefined ? undefined : historyQuerySchema.parse(turn);
    const ids = exact ? ("inputId" in exact ? [exact.inputId] : [...new Set(exact.inputIds)]) : [];
    if (exact && !ids.length) return [];
    const filter = exact ? `WHERE u.task_id=? AND u.input_id IN (${ids.map(() => "?").join(",")})` : "";
    const rows = this.db.connection.prepare(`WITH uses AS (
      SELECT task_id,input_id,rule_id,title,revision,at,detail,phrase,evidence,status FROM answer_rule_turns
      UNION ALL
      SELECT task_id,input_id,rule_id,title,revision,at,detail,NULL,NULL,NULL FROM answer_rule_uses old
      WHERE NOT EXISTS (SELECT 1 FROM answer_rule_turns turn WHERE turn.task_id=old.task_id AND turn.input_id=old.input_id)
    ) SELECT u.task_id AS taskId,t.title AS taskTitle,u.input_id AS inputId,u.rule_id AS ruleId,u.title,u.revision,u.at,u.detail,
        u.phrase,u.evidence,u.status AS routeStatus
      FROM uses u JOIN tasks t ON t.id=u.task_id ${filter}
      ORDER BY u.at DESC ${exact ? "" : "LIMIT 50"}`).all(...(exact ? [exact.taskId, ...ids] : [])) as
      (Omit<AnswerRuleUse, "evidence" | "phrase"> & { evidence: string | null; phrase: string | null })[];
    return rows.map(({ evidence, phrase, routeStatus, ...row }) => ({ ...row, phrase: phrase ?? undefined,
      routeStatus: routeStatus ?? undefined,
      evidence: evidence ? JSON.parse(evidence) as AnswerRuleEvidence : undefined }));
  }
}
