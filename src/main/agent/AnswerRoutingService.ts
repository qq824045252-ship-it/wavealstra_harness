import { resolvedPathKey } from "../platform/paths";
import { DotsForegroundReads } from "../dots/DotsForegroundReads";
import { DOTS_TASK_ID } from "../../shared/dots";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { z } from "zod";
import { startAnswerRoutingTiming } from "./AnswerRoutingTimings";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryService } from "../library/LibraryService";
import type { LibraryItemDto } from "../../shared/library-ipc";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
import { assertPathInsideTask, TaskPathBoundaryError } from "../task/TaskExecutionWorkspace";
import { answerRoutingInput, answerRuleInScope, defaultAnswerRuleId, defaultDotsSchedulingPolicy, eligibleAnswerEvidenceItem, matchAnswerRule, maxAnswerEvidenceBytes, newAnswerRule, type AnswerRoutingHistoryQuery, type AnswerRule,
  type AnswerRuleDraft, type AnswerRuleEvidence, type AnswerRuleMatch, type AnswerRuleUse, type AnswerRuleDiff, type AnswerRuleDiffEntry,
  maxAnswerRuleVersions, type AnswerRuleVersion, type AnswerRuleVersionSource } from "../../shared/answer-routing";
import { evaluateAnswerFlow, routingFlowLimits } from "../../shared/answer-routing-flow";

const phrases = z.array(z.string().trim().min(1).max(100)).max(24).transform(values => [...new Set(values)]);
export const answerTeachingSchema = z.object({
  title: z.string().trim().min(1).max(90), include: phrases.refine(items => items.length > 0), exclude: phrases,
  instruction: z.string().trim().min(1).max(2000),
});
const identifier = z.string().trim().min(1).max(300);
const routeModeSchema = z.enum(["direct", "delegate", "auto"]);
const uniqueIds = (items: readonly { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const flowCheckSchema = z.object({
  id: identifier,
  operator: z.enum(["all", "any", "none"]),
  phrases: z.array(z.string().trim().min(1).max(routingFlowLimits.phraseLength)).min(1, "请填写判断短语").max(routingFlowLimits.phrases),
}).strict();
const flowBranchSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1, "请填写分支名").max(routingFlowLimits.titleLength),
  checks: z.array(flowCheckSchema).min(1, "请添加判断节点").max(routingFlowLimits.checks).refine(uniqueIds, "判断节点重复"),
  ruleId: identifier.refine(id => id !== defaultAnswerRuleId, "请选择自定义回答规则").nullable(),
  routeMode: routeModeSchema.nullable(),
}).strict().refine(branch => branch.ruleId !== null || branch.routeMode !== null, "请为分支选择回答规则或处理方式");
const flowSchema = z.object({
  enabled: z.boolean(),
  branches: z.array(flowBranchSchema).max(routingFlowLimits.branches).refine(uniqueIds, "分支重复"),
}).strict().refine(flow => !flow.enabled || flow.branches.length > 0, "请添加分支后启用流程");
const policySchema = z.object({
  version: z.literal(1),
  routeMode: routeModeSchema,
  flow: flowSchema.optional(),
  foregroundReadLimits: z.object({
    characters: z.number().int().min(1).max(1_000_000),
    sources: z.number().int().min(1).max(100),
    calls: z.number().int().min(1).max(100),
  }).strict(),
  trackingPolicy: z.object({
    milestones: z.boolean(),
    heartbeatMs: z.number().int().min(5_000).max(86_400_000).nullable(),
    silenceMs: z.number().int().min(5_000).max(86_400_000),
  }).strict(),
}).strict();
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
type StoredRow = Row & { enabled: number; project_id: string | null; source_id: string | null };
type RuleRow = Pick<Row, "id" | "revision" | "config">;
type VersionRow = { revision: number; at: number; source: AnswerRuleVersionSource; title: string; note: string | null; config: string; uses: number };
type UseRow = Omit<AnswerRuleUse, "evidence" | "phrase" | "routeStatus" | "policy"> & {
  evidence: string | null; phrase: string | null; routeStatus: AnswerRuleUse["routeStatus"] | null; snapshot: string | null;
};
type HistoryRequest = { kind: "history"; taskId?: string; inputIds: string[] };
export type RuntimeAnswerRoutingRequest =
  | { kind: "list" }
  | { kind: "preview"; projectId: string | null }
  | { kind: "versions"; id: string }
  | HistoryRequest
  | { kind: "save"; draft: {
      id: string; expectedRevision?: number; projectId: string | null; sourceId?: string | null; title: string;
      enabled: boolean; config: string; at: number; maxVersions: number; source: "save" | "restore";
    } }
  | { kind: "remove"; id: string; revision: number }
  | { kind: "annotate"; id: string; revision: number; note: string }
  | { kind: "recordTurn"; taskId: string; inputId: string; ruleId: string; revision: number;
      title: string; at: number; detail: string; phrase: string; evidence: string | null;
      scope: string; status: string; snapshot: string };
export type RuntimeAnswerRoutingReply =
  | { status: "rules"; rows: RuleRow[] }
  | { status: "versions"; rows: VersionRow[] }
  | { status: "history"; rows: UseRow[] }
  | { status: "saved"; revision: number }
  | { status: "removed" | "conflict" | "needsHost" }
  | { status: "rejected"; message: string };
const routeModeLabels: Record<string, string> = { auto: "自动", direct: "优先直答", delegate: "优先委派" };
const readLimitText = (limits: { characters: number; sources: number; calls: number }) =>
  `${limits.characters} 字/${limits.sources} 来源/${limits.calls} 次`;
const intervalText = (ms: number | null) => ms ? `${Math.round(ms / 1000)} 秒` : "关闭";

/** 一版设置的可读摘要，用于版本列表。 */
function ruleSummary(config: AnswerRuleDraft, isDefault: boolean): string {
  if (isDefault && config.policy) {
    const policy = config.policy;
    return [routeModeLabels[policy.routeMode], policy.flow?.enabled ? `流程 ${policy.flow.branches.length} 个分支` : "无流程",
      `读取上限 ${readLimitText(policy.foregroundReadLimits)}`, `状态回报间隔 ${intervalText(policy.trackingPolicy.heartbeatMs)}`].join(" · ");
  }
  const evidence = config.evidenceLibraryItemId ? "预读资料库条目" : config.evidenceFile ? `预读 ${config.evidenceFile}` : "不预读";
  return [`${config.include.length} 个触发短语`, evidence, config.enabled ? "已启用" : "已停用"].join(" · ");
}

/** 相对上一版的改动；没有可识别的改动时明确说明，不装作有变化。 */
function ruleChanges(previous: AnswerRuleDraft | undefined, next: AnswerRuleDraft, isDefault: boolean): string[] {
  if (!previous) return ["开始记录这一版"];
  if (isDefault) {
    if (!previous.policy || !next.policy) return ["策略内容已更新"];
    const before = previous.policy, after = next.policy, changes: string[] = [];
    if (before.routeMode !== after.routeMode)
      changes.push(`处理方式 ${routeModeLabels[before.routeMode]} → ${routeModeLabels[after.routeMode]}`);
    const beforeFlow = before.flow?.enabled ? `${before.flow.branches.length} 个分支` : "未启用";
    const afterFlow = after.flow?.enabled ? `${after.flow.branches.length} 个分支` : "未启用";
    if (beforeFlow !== afterFlow) changes.push(`流程 ${beforeFlow} → ${afterFlow}`);
    if (JSON.stringify(before.foregroundReadLimits) !== JSON.stringify(after.foregroundReadLimits))
      changes.push(`读取上限 ${readLimitText(before.foregroundReadLimits)} → ${readLimitText(after.foregroundReadLimits)}`);
    if (before.trackingPolicy.milestones !== after.trackingPolicy.milestones)
      changes.push(`阶段成果回报 ${before.trackingPolicy.milestones ? "开启" : "关闭"} → ${after.trackingPolicy.milestones ? "开启" : "关闭"}`);
    if (before.trackingPolicy.heartbeatMs !== after.trackingPolicy.heartbeatMs)
      changes.push(`状态回报间隔 ${intervalText(before.trackingPolicy.heartbeatMs)} → ${intervalText(after.trackingPolicy.heartbeatMs)}`);
    if (before.trackingPolicy.silenceMs !== after.trackingPolicy.silenceMs)
      changes.push(`无活动阈值 ${Math.round(before.trackingPolicy.silenceMs / 1000)} 秒 → ${Math.round(after.trackingPolicy.silenceMs / 1000)} 秒`);
    return changes.length ? changes : ["设置未变化"];
  }
  const changes: string[] = [];
  if (previous.enabled !== next.enabled) changes.push(next.enabled ? "已启用" : "已停用");
  if (previous.title !== next.title) changes.push(`名称 ${previous.title || "空"} → ${next.title || "空"}`);
  if (previous.include.join("\n") !== next.include.join("\n"))
    changes.push(`触发短语 ${previous.include.length} 条 → ${next.include.length} 条`);
  if (previous.exclude.join("\n") !== next.exclude.join("\n"))
    changes.push(`例外 ${previous.exclude.length} 条 → ${next.exclude.length} 条`);
  if (previous.instruction !== next.instruction) changes.push("回答做法已修改");
  const beforeEvidence = previous.evidenceLibraryItemId || previous.evidenceFile || "无";
  const afterEvidence = next.evidenceLibraryItemId || next.evidenceFile || "无";
  if (beforeEvidence !== afterEvidence) changes.push(`预读资料 ${beforeEvidence} → ${afterEvidence}`);
  if ((previous.evidenceFailure ?? "") !== (next.evidenceFailure ?? "")) changes.push("读不到资料时的处理已修改");
  if ((previous.projectId ?? "") !== (next.projectId ?? "")) changes.push("适用范围已修改");
  return changes.length ? changes : ["设置未变化"];
}
const decode = (row: RuleRow): AnswerRule => {
  const { policy, ...draft } = JSON.parse(row.config) as AnswerRuleDraft;
  return { ...draft, id: row.id, revision: row.revision, ...(row.id === defaultAnswerRuleId && { policy }) };
};
const conflict = () => new Error("规则已变化或已删除，请刷新后重试");
const hasLoneSurrogate = (text: string | null) => text !== null && /[\uD800-\uDFFF]/u.test(text);

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

function readEvidence(cwd: string, filename: string, inputId: string, canReadPath?: (path: string) => boolean) {
  const finish = startAnswerRoutingTiming("readEvidence");
  const read = readEvidenceFile(cwd, filename, canReadPath);
  if (!finish) return read;
  return read.then(result => {
    finish(() => ({ inputId, outcome: "read" }));
    return result;
  }, error => {
    finish(() => ({ inputId, outcome: evidenceFailure(error).status }));
    throw error;
  });
}

async function readEvidenceFile(cwd: string, filename: string, canReadPath?: (path: string) => boolean) {
  const root = await realpath(cwd);
  const requestedPath = resolve(cwd, filename);
  const path = assertPathInsideTask(root, await realpath(requestedPath));
  if (canReadPath && !canReadPath(path)) throw new EvidenceFailure("denied", "资料超出 Dots 获准的工作空间");
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
        if (canReadPath && !canReadPath(path)) return false;
        if (realpathSync(requestedPath) !== path) return false;
        accessSync(path, constants.R_OK);
        return true;
      } };
  } finally { await fd.close(); }
}

type Turn = { taskId: string; inputId: string; query: string; cwd: string; appended?: boolean; canRead: () => boolean; canReadLibrary?: () => boolean };
export type AnswerEvidenceScope = { kind: "file"; path: string } | { kind: "library"; item: LibraryItemDto };
type PreparedRoute = {
  text: string;
  render: (instruction: string) => string;
  rule: AnswerRule;
  validate: () => void;
  record: () => void;
};

export class AnswerRoutingService {
  private readonly foreground: DotsForegroundReads;
  private readonly turns = new Map<string, Map<string, Promise<PreparedRoute | undefined>>>();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: AppDatabase, private readonly source: (id: string, taskId?: string) => MemoryRecordDto | undefined,
    private readonly memoryEnabled: () => boolean = () => true,
    private readonly library?: () => LibraryService,
    private readonly canAccessEvidence?: (taskId: string, evidence: AnswerEvidenceScope) => boolean) {
    const fixture = db.fixtureConnection;
    this.foreground = new DotsForegroundReads(fixture, db.coreIdentity ? db.runtimeAuditReader : undefined);
    if (!fixture || fixture.readonly) return;
    fixture.exec(`
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
        detail TEXT NOT NULL, phrase TEXT NOT NULL, evidence TEXT, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'applied', snapshot TEXT,
        PRIMARY KEY(task_id, input_id));
      CREATE INDEX IF NOT EXISTS answer_rule_turns_recent ON answer_rule_turns(at DESC);
      CREATE INDEX IF NOT EXISTS answer_rule_turns_source_history ON answer_rule_turns(task_id,rule_id,at DESC);
      CREATE TABLE IF NOT EXISTS answer_rule_versions (
        rule_id TEXT NOT NULL REFERENCES answer_rules(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        at INTEGER NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', config TEXT NOT NULL,
        PRIMARY KEY(rule_id, revision));
      CREATE INDEX IF NOT EXISTS answer_rule_versions_recent ON answer_rule_versions(rule_id, revision DESC);`);
    db.connection.transaction(() => {
      const copies = db.connection.prepare("SELECT * FROM answer_rules WHERE source_id IS NOT NULL AND source_hash IS NOT NULL").all() as Row[];
      const clean = db.connection.prepare("UPDATE answer_rules SET config=?,source_hash=NULL WHERE id=?");
      for (const row of copies) {
        const rule = JSON.parse(row.config) as AnswerRuleDraft;
        const extra = rule.sourcePrefixLength ? rule.instruction.slice(rule.sourcePrefixLength).trimStart() : "";
        clean.run(JSON.stringify({ ...rule, instruction: extra, sourcePrefixLength: undefined, sourceHash: undefined }), row.id);
      }
      const columns = db.connection.pragma("table_info(answer_rule_turns)") as Array<{ name: string }>;
      if (!columns.some(column => column.name === "snapshot"))
        db.connection.exec("ALTER TABLE answer_rule_turns ADD COLUMN snapshot TEXT");
      const fallback = { ...newAnswerRule(), title: "默认调度策略", instruction: "按本轮请求和已知任务状态选择直答或委派。",
        policy: defaultDotsSchedulingPolicy() };
      db.connection.prepare(`INSERT OR IGNORE INTO answer_rules(id,revision,enabled,config) VALUES(?,1,1,?)`)
        .run(defaultAnswerRuleId, JSON.stringify(fallback));
      const versionColumns = db.connection.pragma("table_info(answer_rule_versions)") as Array<{ name: string }>;
      if (!versionColumns.some(column => column.name === "note"))
        db.connection.exec("ALTER TABLE answer_rule_versions ADD COLUMN note TEXT NOT NULL DEFAULT ''");
      // 首次升级时只记录当前这一版的起点；更早的历史不可重建，不伪造。
      const unversioned = db.connection.prepare(`SELECT id,revision,config FROM answer_rules r
        WHERE NOT EXISTS (SELECT 1 FROM answer_rule_versions v WHERE v.rule_id=r.id)`).all() as Array<Pick<Row, "id" | "revision" | "config">>;
      const seedVersion = db.connection.prepare(`INSERT OR IGNORE INTO answer_rule_versions(rule_id,revision,at,source,title,config)
        VALUES(?,?,?,'baseline',?,?)`);
      for (const row of unversioned) {
        const config = JSON.parse(row.config) as AnswerRuleDraft;
        seedVersion.run(row.id, row.revision, Date.now(), config.title ?? "", row.config);
      }
      if (columns.some(column => column.name === "status")) return;
      db.connection.exec(`
        ALTER TABLE answer_rule_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
        UPDATE answer_rule_turns SET status='revoked'
          WHERE detail LIKE '本轮回答调度已撤销：%'
             OR CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.status') END = 'revoked';`);
    }).immediate();
  }

  private currentRule(row: RuleRow, taskId?: string): AnswerRule {
    const rule = decode(row);
    if (!rule.sourceMemoryId) return rule;
    const memory = this.memoryEnabled() ? this.source(rule.sourceMemoryId, taskId) : undefined;
    const extra = rule.instruction;
    if (!memory || !this.validSource(memory)) return { ...rule, instruction: extra, sourceUnavailable: true };
    return { ...rule, instruction: extra ? memory.content + "\n" + extra : memory.content,
      sourceHash: memory.contentHash, sourcePrefixLength: extra ? memory.content.length : undefined, sourceUnavailable: false };
  }

  list(): AnswerRule[] {
    return (this.db.connection.prepare("SELECT id,revision,config FROM answer_rules ORDER BY rowid DESC").all() as RuleRow[])
      .map(row => this.currentRule(row));
  }

  async readList(): Promise<AnswerRule[]> {
    const result = await this.db.runtimeAuditReader?.answerRoutingData({ kind: "list" });
    if (result?.status === "rules") return result.rows.map(row => this.currentRule(row));
    if (this.db.coreIdentity) throw new Error("回答调度规则读取未获 Rust Core 确认");
    return this.list();
  }

  taskScope(taskId: string): string | null {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("当前对话已不存在");
    return task.projectId ?? null;
  }

  rulesForTask(taskId: string): AnswerRule[] {
    const rows = this.db.connection.prepare("SELECT * FROM answer_rules WHERE project_id IS NULL OR project_id=? ORDER BY project_id IS NULL, rowid DESC")
      .all(this.taskScope(taskId)) as Row[];
    return rows.map(row => this.currentRule(row, taskId)).filter(rule => !rule.sourceUnavailable);
  }

  flush(): Promise<void> {
    return this.writeTail.then(() => undefined, () => undefined);
  }

  private get rustRequired(): boolean {
    return Boolean(this.db.connection.readonly || this.db.runtimeAuditReader?.supervised);
  }

  private resolveSaveForTaskDraft(taskId: string, input: unknown): { draft: AnswerRuleDraft; updating: { id: string; revision: number } | undefined } {
    const { changes, version, scope } = z.object({
      changes: chatChanges, version: versionSchema.strict().optional(), scope: z.enum(["project", "global"]).optional(),
    }).strict().parse(input);
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
    return { draft, updating: updating ? version : undefined };
  }

  saveForTask(taskId: string, input: unknown): AnswerRule {
    if (this.db.connection.readonly) throw new Error("只读数据库模式下请使用 saveForTaskAsync");
    return this.db.connection.transaction(() => {
      const { draft, updating } = this.resolveSaveForTaskDraft(taskId, input);
      return this.save(draft, updating);
    }).immediate();
  }

  async saveForTaskAsync(taskId: string, input: unknown): Promise<AnswerRule> {
    if (!this.db.runtimeAuditReader) return this.saveForTask(taskId, input);
    const { draft, updating } = this.resolveSaveForTaskDraft(taskId, input);
    return this.persistSettings(draft, updating, "save");
  }

  private parseDraft(input: AnswerRuleDraft, expected?: { id: string; revision: number }): AnswerRuleDraft {
    return expected?.id === defaultAnswerRuleId
      ? { ...newAnswerRule(), title: "默认调度策略", instruction: "按本轮请求和已知任务状态选择直答或委派。",
        policy: policySchema.parse(input.policy) }
      : draftSchema.parse(input);
  }

  saveSettings(input: AnswerRuleDraft, expected?: { id: string; revision: number }): Promise<AnswerRule> {
    return this.persistSettings(input, expected, "save");
  }

  private prepareStoredDraft(draft: AnswerRuleDraft): { stored: AnswerRuleDraft } {
    if (!draft.sourceMemoryId) return { stored: draft };
    const memory = this.source(draft.sourceMemoryId);
    if (!memory || !this.validSource(memory) || !this.memoryEnabled() || memory.contentHash !== draft.sourceHash)
      throw new Error("来源记忆已变化，请刷新后再编辑");
    const extra = draft.instruction === memory.content ? "" : draft.instruction.startsWith(memory.content + "\n")
      ? draft.instruction.slice(memory.content.length + 1) : undefined;
    if (extra === undefined) throw new Error("请在记忆中修改来源内容");
    return { stored: { ...draft, instruction: extra, sourceHash: undefined, sourcePrefixLength: undefined } };
  }

  private async persistSettings(input: AnswerRuleDraft, expected: { id: string; revision: number } | undefined,
    source: "save" | "restore"): Promise<AnswerRule> {
    const rust = this.db.runtimeAuditReader;
    const rustRequired = this.rustRequired;
    if (!rust || this.db.connection.inTransaction) {
      if (rustRequired) throw new Error("只读数据库模式下无法通过宿主机保存回答规则");
      return this.save(input, expected, source);
    }
    const draft = this.parseDraft(input, expected);
    const version = expected === undefined ? undefined : versionSchema.parse(expected);
    const id = version?.id ?? randomUUID();
    if ((version && !Number.isSafeInteger(version.revision)) || [id, draft.projectId, draft.title].some(hasLoneSurrogate)) {
      if (rustRequired) throw new Error("回答规则包含无效字段");
      return this.save(input, expected, source);
    }
    const { stored } = this.prepareStoredDraft(draft);
    const result = await rust.answerRoutingData({ kind: "save", draft: {
      id, expectedRevision: version?.revision, projectId: stored.projectId, sourceId: stored.sourceMemoryId,
      title: stored.title, enabled: stored.enabled, config: JSON.stringify(stored), at: Date.now(), maxVersions: maxAnswerRuleVersions, source,
    } });
    if (result?.status === "saved") return { ...draft, id, revision: result.revision };
    if (result?.status === "needsHost" && !rustRequired) return this.save(input, expected, source);
    if (result?.status === "conflict") throw conflict();
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("未能确认规则是否已保存，请刷新后重试");
  }

  save(input: AnswerRuleDraft, expected?: { id: string; revision: number }, source: "save" | "restore" = "save"): AnswerRule {
    const draft = this.parseDraft(input, expected);
    const version = expected === undefined ? undefined : versionSchema.parse(expected);
    return this.db.connection.transaction(() => {
      const memory = draft.sourceMemoryId ? this.source(draft.sourceMemoryId) : undefined;
      let stored = draft;
      if (draft.sourceMemoryId) {
        if (!memory || !this.validSource(memory) || !this.memoryEnabled() || memory.contentHash !== draft.sourceHash)
          throw new Error("来源记忆已变化，请刷新后再编辑");
        const extra = draft.instruction === memory.content ? "" : draft.instruction.startsWith(memory.content + "\n")
          ? draft.instruction.slice(memory.content.length + 1) : undefined;
        if (extra === undefined) throw new Error("请在记忆中修改来源内容");
        stored = { ...draft, instruction: extra, sourceHash: undefined, sourcePrefixLength: undefined };
      }
      const id = version?.id ?? randomUUID();
      const config = JSON.stringify(stored);
      const existing = version ? this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=?").get(id) as StoredRow | undefined : undefined;
      if (version && (!existing || existing.revision !== version.revision)) throw conflict();
      // 内容完全相同的保存不产生新版本：版本列表里的每一版都对应一次真实改动。
      if (existing && existing.config === config && existing.project_id === draft.projectId
        && existing.source_id === draft.sourceMemoryId && Number(existing.enabled) === Number(draft.enabled))
        return this.currentRule(existing);
      const args = [draft.projectId, draft.sourceMemoryId, null, Number(draft.enabled), config, id];
      let revision: number;
      if (version) {
        const result = this.db.connection.prepare(`UPDATE answer_rules SET project_id=?,source_id=?,source_hash=?,enabled=?,config=?,
          revision=revision+1 WHERE id=? AND revision=?`).run(...args, version.revision);
        if (!result.changes) throw conflict();
        revision = version.revision + 1;
        if (!draft.enabled) this.db.connection.prepare(
          "UPDATE answer_rule_turns SET status='revoked' WHERE rule_id=? AND status='applied'").run(id);
      } else {
        this.db.connection.prepare("INSERT INTO answer_rules(project_id,source_id,source_hash,enabled,config,id,revision) VALUES(?,?,?,?,?,?,1)").run(...args);
        revision = 1;
      }
      this.recordVersion(id, revision, source, config);
      return { ...draft, id, revision };
    })();
  }

  private recordVersion(id: string, revision: number, source: "save" | "restore", config: string): void {
    const title = (JSON.parse(config) as AnswerRuleDraft).title ?? "";
    this.db.connection.prepare(`INSERT OR REPLACE INTO answer_rule_versions(rule_id,revision,at,source,title,config)
      VALUES(?,?,?,?,?,?)`).run(id, revision, Date.now(), source, title, config);
    this.db.connection.prepare(`DELETE FROM answer_rule_versions WHERE rule_id=? AND revision NOT IN (
      SELECT revision FROM answer_rule_versions WHERE rule_id=? ORDER BY revision DESC LIMIT ?)`)
      .run(id, id, maxAnswerRuleVersions);
  }

  /** 从新到旧的保存历史。第一条对应当前版本。 */
  versions(id: string): AnswerRuleVersion[] {
    const ruleId = identifier.parse(id);
    const rows = this.db.connection.prepare(`SELECT v.revision,v.at,v.source,v.title,v.note,v.config,
        (SELECT COUNT(*) FROM answer_rule_turns t WHERE t.rule_id=v.rule_id AND t.revision=v.revision AND t.status='applied') AS uses
      FROM answer_rule_versions v WHERE v.rule_id=? ORDER BY v.revision DESC LIMIT 200`).all(ruleId) as
      VersionRow[];
    return this.formatVersions(ruleId, rows);
  }

  async readVersions(id: string): Promise<AnswerRuleVersion[]> {
    const ruleId = identifier.parse(id);
    const result = await this.db.runtimeAuditReader?.answerRoutingData({ kind: "versions", id: ruleId });
    return result?.status === "versions" ? this.formatVersions(ruleId, result.rows) : this.versions(ruleId);
  }

  private formatVersions(ruleId: string, rows: VersionRow[]): AnswerRuleVersion[] {
    const isDefault = ruleId === defaultAnswerRuleId;
    const versions: AnswerRuleVersion[] = [];
    let previous: AnswerRuleDraft | undefined;
    for (const row of [...rows].reverse()) {
      const config = JSON.parse(row.config) as AnswerRuleDraft;
      versions.push({ ruleId, revision: row.revision, at: row.at, source: row.source, title: row.title,
        note: row.note ?? "", uses: row.uses,
        changes: ruleChanges(previous, config, isDefault), summary: ruleSummary(config, isDefault) });
      previous = config;
    }
    return versions.reverse();
  }

  /** 把旧版写成一个新版本。当前版与历史都不改写，所以恢复本身也可再恢复。 */
  restore(id: string, revision: number): AnswerRule {
    const { config, expected } = this.restoration(id, revision);
    return this.save(config, expected, "restore");
  }

  async restoreSettings(id: string, revision: number): Promise<AnswerRule> {
    const { config, expected } = this.restoration(id, revision);
    return this.persistSettings(config, expected, "restore");
  }

  private restoration(id: string, revision: number) {
    const target = versionSchema.parse({ id, revision });
    const current = this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=?").get(target.id) as StoredRow | undefined;
    if (!current) throw new Error("规则已删除，请刷新后重试");
    if (target.revision === current.revision) throw new Error("这已经是当前版本");
    const version = this.readVersionConfig(target.id, target.revision);
    const config = version.config;
    // 跟随记忆的规则内容由记忆派生，单独回退会与来源脱节。
    if (config.sourceMemoryId) throw new Error("这条规则跟随记忆来源，请在记忆中修改");
    if (target.id === defaultAnswerRuleId && !config.policy) throw new Error("这一版没有可恢复的调度策略");
    return { config, expected: { id: target.id, revision: current.revision } };
  }

  /** 给某一版写备注，备注只属于那一版，不随恢复复制。 */
  annotate(id: string, revision: number, note: string): void {
    const target = versionSchema.parse({ id, revision });
    const text = z.string().trim().max(120, "备注最多 120 字").parse(note);
    const result = this.db.connection.prepare("UPDATE answer_rule_versions SET note=? WHERE rule_id=? AND revision=?")
      .run(text, target.id, target.revision);
    if (!result.changes) throw new Error("找不到这个版本");
  }

  async annotateSettings(id: string, revision: number, note: string): Promise<void> {
    const target = versionSchema.parse({ id, revision });
    const text = z.string().trim().max(120, "备注最多 120 字").parse(note);
    const rust = this.db.runtimeAuditReader;
    const rustRequired = this.rustRequired;
    if (!rust || this.db.connection.inTransaction) {
      if (rustRequired) throw new Error("只读数据库模式下无法备注规则版本");
      return this.annotate(id, revision, note);
    }
    const result = await rust.answerRoutingData({ kind: "annotate", id: target.id, revision: target.revision, note: text });
    if (result?.status === "saved") return;
    if (result?.status === "needsHost" && !rustRequired) return this.annotate(id, revision, note);
    throw new Error(result?.status === "rejected" ? result.message : "找不到这个版本");
  }

  /** 两版设置的逐项对比，只返回有差异的项。 */
  compare(id: string, from: number, to: number): AnswerRuleDiff {
    const ruleId = identifier.parse(id);
    const fromRevision = versionSchema.shape.revision.parse(from);
    const toRevision = versionSchema.shape.revision.parse(to);
    const isDefault = ruleId === defaultAnswerRuleId;
    const before = this.ruleFields(this.readVersionConfig(ruleId, fromRevision).config, isDefault);
    const after = this.ruleFields(this.readVersionConfig(ruleId, toRevision).config, isDefault);
    const entries: AnswerRuleDiffEntry[] = [];
    before.forEach((field, index) => {
      const other = after[index];
      if (other && other.value !== field.value) entries.push({ label: field.label, before: field.value, after: other.value });
    });
    return { ruleId, from: fromRevision, to: toRevision, entries };
  }

  private readVersionConfig(id: string, revision: number): { config: AnswerRuleDraft } {
    const row = this.db.connection.prepare("SELECT config FROM answer_rule_versions WHERE rule_id=? AND revision=?")
      .get(id, revision) as { config: string } | undefined;
    if (!row) throw new Error(`找不到第 ${revision} 版`);
    return { config: JSON.parse(row.config) as AnswerRuleDraft };
  }

  private ruleFields(config: AnswerRuleDraft, isDefault: boolean): Array<{ label: string; value: string }> {
    if (isDefault && config.policy) {
      const policy = config.policy;
      return [
        { label: "处理方式", value: routeModeLabels[policy.routeMode] },
        { label: "流程", value: policy.flow?.enabled
          ? `${policy.flow.branches.length} 个分支：${policy.flow.branches.map(branch => branch.title).join("、")}` : "未启用" },
        { label: "前台读取上限", value: readLimitText(policy.foregroundReadLimits) },
        { label: "阶段成果回报", value: policy.trackingPolicy.milestones ? "开启" : "关闭" },
        { label: "状态回报间隔", value: intervalText(policy.trackingPolicy.heartbeatMs) },
        { label: "无活动阈值", value: `${Math.round(policy.trackingPolicy.silenceMs / 1000)} 秒` },
      ];
    }
    return [
      { label: "名称", value: config.title || "空" },
      { label: "状态", value: config.enabled ? "已启用" : "已停用" },
      { label: "触发短语", value: config.include.join("、") || "无" },
      { label: "例外", value: config.exclude.join("、") || "无" },
      { label: "回答做法", value: config.instruction || "空" },
      { label: "预读资料", value: this.evidenceLabel(config) },
      { label: "读不到资料时", value: config.evidenceFailure === "mark-unverified" ? "直接标注待核实"
        : config.evidenceFailure === "verify" ? "用其他获准来源核实" : "未指定" },
      { label: "适用范围", value: this.projectLabel(config.projectId) },
    ];
  }

  private evidenceLabel(config: AnswerRuleDraft): string {
    if (!config.evidenceLibraryItemId) return config.evidenceFile || "无";
    try {
      return this.library?.()?.getItem(config.evidenceLibraryItemId)?.title ?? `资料库条目 ${config.evidenceLibraryItemId}`;
    } catch {
      return `资料库条目 ${config.evidenceLibraryItemId}`;
    }
  }

  private projectLabel(projectId: string | null): string {
    if (!projectId) return "Dots（全局）";
    const row = this.db.connection.prepare("SELECT name FROM projects WHERE id=?").get(projectId) as { name: string } | undefined;
    return row?.name ? `项目 ${row.name}` : `项目 ${projectId}`;
  }

  remove(id: string, revision: number): void {
    versionSchema.parse({ id, revision });
    if (id === defaultAnswerRuleId) throw new Error("默认调度策略不可删除");
    if (!this.db.connection.prepare("DELETE FROM answer_rules WHERE id=? AND revision=?").run(id, revision).changes) throw conflict();
  }

  async removeSettings(id: string, revision: number): Promise<void> {
    versionSchema.parse({ id, revision });
    if (id === defaultAnswerRuleId) throw new Error("默认调度策略不可删除");
    const rust = this.db.runtimeAuditReader;
    const rustRequired = this.rustRequired;
    if (!rust || this.db.connection.inTransaction || !Number.isSafeInteger(revision) || hasLoneSurrogate(id)) {
      if (rustRequired) throw new Error("只读数据库模式下无法删除回答规则");
      return this.remove(id, revision);
    }
    const result = await rust.answerRoutingData({ kind: "remove", id, revision });
    if (result?.status === "removed") return;
    if (result?.status === "needsHost" && !rustRequired) return this.remove(id, revision);
    if (result?.status === "conflict") throw conflict();
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("未能确认规则是否已删除，请刷新后重试");
  }

  private validSource(memory?: MemoryRecordDto): boolean {
    const now = Date.now();
    return memory?.status === "active" && memory.scopes.some(scope => scope.scopeType === "global" || (scope.scopeType === "task" && scope.scopeId === DOTS_TASK_ID))
      && (memory.validFrom ?? 0) <= now && (memory.validUntil ?? Infinity) > now;
  }

  hasRulesForTask(taskId: string): boolean {
    return this.turns.has(taskId) || !!this.db.connection.prepare(`SELECT 1 FROM answer_rules WHERE enabled=1 AND
      (project_id IS NULL OR project_id=(SELECT project_id FROM tasks WHERE id=?))
      UNION ALL SELECT 1 FROM answer_rule_turns WHERE task_id=? LIMIT 1`).get(taskId, taskId);
  }

  preview(query: string, projectId: string | null, taskId?: string): AnswerRuleMatch | null {
    const rows = this.db.connection.prepare("SELECT id,revision,config FROM answer_rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?)").all(projectId) as RuleRow[];
    return this.previewRows(query, projectId, rows, taskId);
  }

  async readPreview(query: string, projectId: string | null): Promise<AnswerRuleMatch | null> {
    const result = await this.db.runtimeAuditReader?.answerRoutingData({ kind: "preview", projectId });
    return result?.status === "rules" ? this.previewRows(query, projectId, result.rows) : this.preview(query, projectId);
  }

  private previewRows(query: string, projectId: string | null, rows: readonly RuleRow[], taskId?: string): AnswerRuleMatch | null {
    const rules = rows.map(row => this.currentRule(row, taskId));
    const fallback = !taskId || taskId === DOTS_TASK_ID ? rules.find(rule => rule.id === defaultAnswerRuleId) : undefined;
    const legacy = () => matchAnswerRule(query, projectId, rules, rule => !rule.sourceUnavailable, !taskId)
      ?? (fallback && !query.trimStart().startsWith("/") ? { rule: fallback, phrase: "" } : null);
    const policy = fallback?.policy;
    if (!policy?.flow?.enabled) return legacy();
    const text = answerRoutingInput(query);
    if (text === null) return legacy();
    const eligible = new Map(rules.filter(rule => !rule.sourceUnavailable && answerRuleInScope(rule, projectId, text)).map(rule => [rule.id, rule]));
    const { branch, steps } = evaluateAnswerFlow(text, policy.flow, id => eligible.has(id));
    const chosen = branch?.ruleId ? eligible.get(branch.ruleId) : undefined;
    const match = chosen ? { rule: chosen, phrase: "" } : legacy();
    return match && { ...match, flow: { steps, routeMode: branch?.routeMode ?? policy.routeMode } };
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
    const prior = this.db.connection.prepare(`SELECT rule_id,revision,at,detail,phrase,evidence,scope,status,snapshot FROM answer_rule_turns
      WHERE task_id=? AND input_id=?`).get(input.taskId, input.inputId) as
      { rule_id: string; revision: number; at: number; detail: string; phrase: string; evidence: string | null; scope: string;
        status: AnswerRuleUse["routeStatus"]; snapshot: string | null } | undefined;
    const cannotRestore = () => new Error("无法恢复这轮回答的原始调度快照，请重新提问");
    const priorRule = prior ? this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=? AND enabled=1")
      .get(prior.rule_id) as Row | undefined : undefined;
    if (prior && (!priorRule || prior.status === "revoked" || (!prior.snapshot && prior.revision !== priorRule.revision))) throw cannotRestore();
    const finishMatch = startAnswerRoutingTiming("ruleMatch");
    const match: AnswerRuleMatch | null = prior && priorRule
      ? { rule: prior.snapshot ? JSON.parse(prior.snapshot) as AnswerRule : this.currentRule(priorRule, input.taskId), phrase: prior.phrase }
      : this.preview(input.query, task.projectId ?? null, input.taskId);
    finishMatch?.(() => ({ inputId: input.inputId, method: prior && priorRule ? "restore" : "match", matched: !!match, ruleId: match?.rule.id }));
    if (!match) return;
    const { phrase } = match;
    // The original snapshot owns the policy for retries. A new input takes the current default even when a rule matches.
    const fallback = !prior?.snapshot && match.rule.id !== defaultAnswerRuleId
      ? this.db.connection.prepare("SELECT * FROM answer_rules WHERE id=?").get(defaultAnswerRuleId) as Row | undefined
      : undefined;
    const { flow: _flow, ...basePolicy } = (fallback ? decode(fallback).policy : match.rule.policy) ?? defaultDotsSchedulingPolicy();
    const rule = { ...match.rule, policy: { ...basePolicy, routeMode: match.flow?.routeMode ?? basePolicy.routeMode } };
    const scope = JSON.stringify({ projectId: task.projectId ?? null, cwd: input.cwd,
      ...(rule.sourceMemoryId ? { sourceHash: rule.sourceHash } : {}) });
    if (prior && (rule.sourceUnavailable || prior.scope !== scope)) throw cannotRestore();
    const routeInstruction = {
      direct: "优先依据已有事实和有界读取直接回答。超出前台范围时，按本轮授权移交。",
      delegate: "需要执行的事项在完成必要定位后优先交给普通任务。用户要求直答或禁止委派时按其要求处理。",
      auto: "按本轮请求和现有任务状态选择直答、查询或委派。已有事实或少量核对足以回答就直接答；查询、修改或停止已有事项用原任务。预计要核对大量资料、修改文件、运行测试或长时间等待时，定位到已获准的工作空间后优先交普通任务，不必先把前台读取用满。",
    }[rule.policy.routeMode];
    const introduction = "本轮回答调度。用户本次明确要求优先，包括只在对话内处理、暂停或停止。"
      + routeInstruction
      + (rule.id !== defaultAnswerRuleId ? "下面的回答规则仅提供答复方法和佐证；处理方式、任务权限和回报由本轮要求及调度策略决定。" : "");
    const evidenceParts: string[] = [];
    const branch = match.flow?.steps.find(step => step.outcome === "selected");
    const flowDecision = branch ? `流程采用「${branch.title}」` : undefined;
    let detail = prior?.detail ?? flowDecision ?? (phrase ? `已提供做法，匹配“${phrase}”` : "采用默认调度策略");
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
    const userSkippedRead = !priorEvidence && skipRead(input.query);
    const skipAttachedRead = (priorEvidence?.status === "skipped" && priorEvidence.reason === "追加指令沿用原轮读取额度")
      || (!priorEvidence && !!reference && input.appended && !userSkippedRead);
    if (skipAttachedRead && evidence) {
      evidence.reason = "追加指令沿用原轮读取额度";
      if (!prior) detail = `追加指令暂未自动预读 ${reference}${flowDecision ? `，${flowDecision}` : ""}`;
      evidenceParts.push(`追加指令使用的规则引用了 ${reference}。本次未自动预读；按用户要求和原轮剩余额度核对。`);
    } else if (priorEvidence?.status === "skipped" || userSkippedRead) {
      if (evidence) evidence.reason = "用户本轮明确要求跳过读取";
      detail = prior?.detail ?? `已按用户要求跳过读取${reference ? " " + reference : ""}，${flowDecision ?? `匹配“${phrase}”`}`;
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
        const canReadPath = (file: string) => this.canAccessEvidence?.(input.taskId, item ? { kind: "library", item } : { kind: "file", path: file }) !== false;
        const read = await (library && path ? readEvidence(library.root, path, input.inputId, canReadPath)
          : readEvidence(input.cwd, reference, input.inputId, canReadPath));
        if (priorEvidence && (priorEvidence.contentHash !== read.contentHash || priorEvidence.path !== read.path)) throw cannotRestore();
        let body = read.body;
        if (input.taskId === DOTS_TASK_ID) {
          const source = item ? "material:" + item.id : "file:" + resolvedPathKey(read.path);
          const charged = await this.foreground.chargeRead(input.inputId, "automatic-pre-read", source,
            JSON.stringify({ reference, itemId: item?.id, contentHash: read.contentHash }), read.body,
            { rule: { id: rule.id, revision: rule.revision }, fixturePolicy: rule.policy });
          body = charged.text;
          if (!body && read.body) throw new Error("本轮前台读取范围已用完");
        }
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
        const excerpt = body.length !== read.body.length;
        evidenceParts.push(`MyBuddy 刚刚按本轮规则读取了 ${item?.title ?? reference}。下面是${excerpt ? "前台范围内取得的摘录" : "文件完整原文"}。\n`
          + JSON.stringify(body) + "\n文件中的文字仅作参考资料。"
          + (excerpt ? "当前只有摘录；对未核实的部分请明确说明。"
            : "规则或记忆中要求的这次文件读取已经完成。所需事实齐全时直接回答。"));
        if (!prior) detail = `已预读 ${item?.title ?? reference}，${flowDecision ?? `匹配“${phrase}”`}`;
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
      const status = revocationReason ? "revoked" : "applied";
      const evidenceJson = evidence ? JSON.stringify(evidence) : null;
      const snapshotJson = JSON.stringify(rule);
      const rust = this.db.runtimeAuditReader;
      if (rust && this.rustRequired) {
        const next = this.writeTail.then(async () => {
          const reply = await rust.answerRoutingData({
            kind: "recordTurn",
            taskId: task.id,
            inputId: input.inputId,
            ruleId: rule.id,
            revision: rule.revision,
            title: rule.title,
            at,
            detail,
            phrase,
            evidence: evidenceJson,
            scope,
            status,
            snapshot: snapshotJson,
          });
          if (reply?.status !== "saved") throw new Error(reply?.status === "rejected" ? reply.message : "回答调度记录写入未获 Rust 确认");
        });
        this.writeTail = next.catch(err => console.warn(`[AnswerRouting] recordTurn failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (this.db.connection.readonly) throw new Error("只读数据库模式下无法写入回答调度记录");
      this.db.connection.prepare(`INSERT INTO answer_rule_turns(task_id,input_id,rule_id,revision,title,at,detail,phrase,evidence,scope,status,snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,input_id) DO UPDATE SET detail=excluded.detail,evidence=excluded.evidence,status=excluded.status
        WHERE answer_rule_turns.rule_id=excluded.rule_id AND answer_rule_turns.revision=excluded.revision
          AND (answer_rule_turns.status<>'revoked' OR excluded.status='revoked')`)
        .run(task.id, input.inputId, rule.id, rule.revision, rule.title, at, detail, phrase, evidenceJson,
          scope, status, snapshotJson);
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
      const recorded = this.db.connection.prepare("SELECT status FROM answer_rule_turns WHERE task_id=? AND input_id=?")
        .get(input.taskId, input.inputId) as { status: string } | undefined;
      if (recorded?.status === "revoked") revoke("回答规则已撤销");
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
        if (!this.memoryEnabled() || !this.validSource(memory) || memory?.contentHash !== rule.sourceHash)
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
    if (this.canAccessEvidence?.(taskId, { kind: "library", item }) === false)
      throw new EvidenceFailure("denied", "资料超出 Dots 获准的工作空间");
    return item;
  }

  private historyRequest(turn?: AnswerRoutingHistoryQuery): HistoryRequest {
    const exact = turn === undefined ? undefined : historyQuerySchema.parse(turn);
    const ids = exact ? ("inputId" in exact ? [exact.inputId] : [...new Set(exact.inputIds)]) : [];
    return { kind: "history", taskId: exact?.taskId, inputIds: ids };
  }

  history(turn?: AnswerRoutingHistoryQuery): AnswerRuleUse[] {
    return this.formatHistory(this.historyRows(this.historyRequest(turn)));
  }

  async readHistory(turn?: AnswerRoutingHistoryQuery): Promise<AnswerRuleUse[]> {
    const request = this.historyRequest(turn);
    if (request.taskId && !request.inputIds.length) return [];
    const result = await this.db.runtimeAuditReader?.answerRoutingData(request);
    return this.formatHistory(result?.status === "history" ? result.rows : this.historyRows(request));
  }

  private historyRows({ taskId, inputIds }: HistoryRequest): UseRow[] {
    if (taskId && !inputIds.length) return [];
    const filter = taskId ? `WHERE u.task_id=? AND u.input_id IN (${inputIds.map(() => "?").join(",")})` : "";
    return this.db.connection.prepare(`WITH uses AS (
      SELECT task_id,input_id,rule_id,title,revision,at,detail,phrase,evidence,status,snapshot FROM answer_rule_turns
      UNION ALL
      SELECT task_id,input_id,rule_id,title,revision,at,detail,NULL,NULL,NULL,NULL FROM answer_rule_uses old
      WHERE NOT EXISTS (SELECT 1 FROM answer_rule_turns turn WHERE turn.task_id=old.task_id AND turn.input_id=old.input_id)
    ) SELECT u.task_id AS taskId,t.title AS taskTitle,u.input_id AS inputId,u.rule_id AS ruleId,u.title,u.revision,u.at,u.detail,
        u.phrase,u.evidence,u.status AS routeStatus,u.snapshot
      FROM uses u JOIN tasks t ON t.id=u.task_id ${filter}
      ORDER BY u.at DESC ${taskId ? "" : "LIMIT 50"}`).all(...(taskId ? [taskId, ...inputIds] : [])) as UseRow[];
  }

  private formatHistory(rows: UseRow[]): AnswerRuleUse[] {
    return rows.map(({ evidence, phrase, routeStatus, snapshot, ...row }) => ({ ...row, phrase: phrase ?? undefined,
      routeStatus: routeStatus ?? undefined,
      policy: snapshot ? (JSON.parse(snapshot) as AnswerRule).policy : undefined,
      evidence: evidence ? JSON.parse(evidence) as AnswerRuleEvidence : undefined }));
  }
}
