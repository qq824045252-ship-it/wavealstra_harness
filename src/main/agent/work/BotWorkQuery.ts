import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { workTrackingReader, type BotWorkTracking } from "./BotWorkTracking";
import type { WorkLifecycle, WorkMode, WorkClosureConclusion, DeliverableStatus } from "../../../shared/bot-work";

export const botWorkQuerySchema = z.object({
  workId: z.string().min(1).max(32000).regex(/\S/).trim().optional(),
  view: z.enum(["summary", "detail"]).optional().describe("summary返回分页摘要；detail必须指定workId并返回原始完整详情数组"),
  status: z.enum(["open", "all", "active", "paused", "closing", "closed"]).optional().describe("open=active/paused/closing，默认open；历史用all或closed"),
  search: z.string().min(1).max(200).regex(/\S/).trim().optional().describe("在标题和目标中按字面子串搜索，不把%或_当通配符"),
  deadlineFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe("承诺期限下界（包含），Unix毫秒；与deadlineBefore组成时间窗口，不是下次检查时间"),
  deadlineBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe("承诺期限上界（不包含），Unix毫秒；过期用当前请求时间，今天用本地次日零点"),
  needsUserInput: z.boolean().optional().describe("true只列当前有未解决的待用户输入阻碍；false排除这类事项"),
  sort: z.enum(["created_desc", "deadline_asc"]).optional().describe("默认created_desc；期限优先用deadline_asc，未设期限放最后；相同期限按创建时间和ID稳定排序"),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(2048).optional().describe("续页须保留全部筛选和sort；直接使用上页nextQuery参数"),
}).strict();
export type BotWorkQueryInput = z.infer<typeof botWorkQuerySchema>;
const cursorSchema = z.object({ v: z.literal(2), scope: z.string(), createdAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().nonnegative().nullable(), workId: z.string().min(1) }).strict();
const waitingForUser = `EXISTS(SELECT 1 FROM work_blockers b WHERE b.work_id=w.work_id AND b.status='open' AND b.waiting_for_user_input=1)`;
const visible = `w.user_id=@userId AND (w.owner_bot_id=@botId OR EXISTS
  (SELECT 1 FROM work_participants p WHERE p.work_id=w.work_id AND p.bot_id=@botId))`;

export interface BotWorkSummary {
  workId: string;
  title: string;
  mode: WorkMode;
  lifecycle: WorkLifecycle;
  ownerBotId: string;
  closureConclusion: WorkClosureConclusion | null;
  progressSummary: string | null;
  closureSummary: string | null;
  latestDeliverableSummary: string | null;
  latestDeliverableStatus: DeliverableStatus | null;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number | null;
  openBlockerCount: number;
  needsUserInput: boolean;
  nextWakeAt: number | null;
  activeSubscriptionCount: number;
  stoppedSubscriptionCount: number;
  watchRule: { cronExpression: string | null; timezone: string | null; stopConditionText: string | null; endsAt: number | null; terminationReason: string | null } | null;
  versionGuard: { expectedStateVersion: number; expectedIntentRevision: number; expectedOwnerEpoch: number };
  /** Summaries omit long reports, history and evidence. Read workId for originals. */
  detailAvailable: true;
  tracking: BotWorkTracking;
}

/** SQL-only catalogue. Never hydrate every Work or build projections to list it. */
export class BotWorkQuery {
  constructor(private readonly db: Database.Database, private readonly userId: string, private readonly botId: string, private readonly teamId?: string) {
    // Additive indexes support existing current-schema databases without discarding data.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_works_user_created ON works(user_id,created_at DESC,work_id DESC);
      CREATE INDEX IF NOT EXISTS idx_works_user_deadline ON works(user_id,deadline_at,created_at DESC,work_id DESC);
      CREATE INDEX IF NOT EXISTS idx_work_participants_bot_work ON work_participants(bot_id,work_id);`);
  }

  private visible(): string {
    return this.teamId ? `w.user_id=@userId AND EXISTS (SELECT 1 FROM work_team_ownership t WHERE t.work_id=w.work_id AND t.team_id=@teamId)` : visible;
  }

  canRead(workId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM works w WHERE w.work_id=@workId AND ${this.visible()}`)
      .get({ userId: this.userId, botId: this.botId, teamId: this.teamId ?? "", workId });
  }

  soleOpenWorkId(): string | undefined {
    const rows = this.db.prepare(`SELECT w.work_id FROM works w WHERE ${this.visible()} AND w.lifecycle!='closed' LIMIT 2`)
      .all({ userId: this.userId, botId: this.botId, teamId: this.teamId ?? "" }) as Array<{ work_id: string }>;
    return rows.length === 1 ? rows[0]!.work_id : undefined;
  }

  page(input: BotWorkQueryInput) {
    const status = input.status ?? (input.workId ? "all" : "open");
    const limit = input.limit ?? 20;
    const sort = input.sort ?? "created_desc";
    if (input.deadlineFrom !== undefined && input.deadlineBefore !== undefined && input.deadlineFrom >= input.deadlineBefore)
      throw new Error("承诺期限窗口无效：deadlineFrom 必须小于 deadlineBefore");
    // Bind cursors to caller and filters. They are positions, never authorization.
    const scope = createHash("sha256").update(JSON.stringify([this.userId, this.botId, this.teamId ?? null, status, input.search ?? "", input.workId ?? "",
      input.deadlineFrom ?? null, input.deadlineBefore ?? null, input.needsUserInput ?? null, sort]))
      .digest("hex");
    let after: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
      catch { throw new Error("查询游标无效，请重新查询第一页"); }
      if (after.scope !== scope) throw new Error("查询游标与当前用户、Bot 或筛选不匹配，请重新查询第一页");
    }
    const params: Record<string, string | number> = { userId: this.userId, botId: this.botId, teamId: this.teamId ?? "" };
    const predicates = [this.visible()];
    if (input.workId) { predicates.push("w.work_id=@workId"); params.workId = input.workId; }
    if (input.search) {
      // Literal substring search, including % and _, rather than SQL wildcards.
      predicates.push("(instr(lower(w.title),lower(@search))>0 OR instr(lower(coalesce(w.goal_description,'')),lower(@search))>0)");
      params.search = input.search;
    }
    if (input.deadlineFrom !== undefined) { predicates.push("w.deadline_at>=@deadlineFrom"); params.deadlineFrom = input.deadlineFrom; }
    if (input.deadlineBefore !== undefined) { predicates.push("w.deadline_at<@deadlineBefore"); params.deadlineBefore = input.deadlineBefore; }
    if (input.needsUserInput !== undefined) {
      predicates.push(`${waitingForUser}=@needsUserInput`); params.needsUserInput = input.needsUserInput ? 1 : 0;
    }
    const base = predicates.join(" AND ");
    const counts = this.db.prepare(`SELECT w.lifecycle,COUNT(*) count FROM works w WHERE ${base} GROUP BY w.lifecycle`)
      .all(params) as Array<{ lifecycle: WorkLifecycle; count: number }>;
    const statusCounts: Record<WorkLifecycle, number> = { active: 0, paused: 0, closing: 0, closed: 0 };
    for (const row of counts) statusCounts[row.lifecycle] = row.count;
    const total = status === "all" ? Object.values(statusCounts).reduce((sum, count) => sum + count, 0)
      : status === "open" ? statusCounts.active + statusCounts.paused + statusCounts.closing : statusCounts[status];
    if (status === "open") predicates.push("w.lifecycle!='closed'");
    else if (status !== "all") { predicates.push("w.lifecycle=@status"); params.status = status; }
    if (after) {
      const older = "(w.created_at<@createdAt OR (w.created_at=@createdAt AND w.work_id<@afterId))";
      if (sort === "created_desc") predicates.push(older);
      else if (after.deadlineAt === null) predicates.push(`(w.deadline_at IS NULL AND ${older})`);
      else {
        predicates.push(`(w.deadline_at IS NULL OR w.deadline_at>@afterDeadline OR (w.deadline_at=@afterDeadline AND ${older}))`);
        params.afterDeadline = after.deadlineAt;
      }
      params.createdAt = after.createdAt; params.afterId = after.workId;
    }
    params.take = limit + 1;
    // Text is sliced in SQLite, so even oversized historical reports never enter the host's list response.
    const rows = this.db.prepare(`SELECT w.work_id workId,substr(w.title,1,200) title,w.mode,w.lifecycle,w.owner_bot_id ownerBotId,
      w.closure_conclusion closureConclusion,substr(w.progress_summary,1,400) progressSummary,substr(w.closure_summary,1,400) closureSummary,
      w.created_at createdAt,w.updated_at updatedAt,w.deadline_at deadlineAt,w.state_version stateVersion,
      w.intent_revision intentRevision,w.owner_epoch ownerEpoch,
      (SELECT substr(d.summary,1,400) FROM work_deliverables d WHERE d.work_id=w.work_id
        AND d.intent_revision=w.intent_revision AND d.input_snapshot_id=w.input_snapshot_id
        AND d.status IN ('proposed','accepted') ORDER BY d.created_at DESC,d.deliverable_id DESC LIMIT 1) latestDeliverableSummary,
      (SELECT d.status FROM work_deliverables d WHERE d.work_id=w.work_id
        AND d.intent_revision=w.intent_revision AND d.input_snapshot_id=w.input_snapshot_id
        AND d.status IN ('proposed','accepted') ORDER BY d.created_at DESC,d.deliverable_id DESC LIMIT 1) latestDeliverableStatus,
      substr(json_extract(w.watch_rule_json,'$.cronExpression'),1,200) cronExpression,
      substr(json_extract(w.watch_rule_json,'$.timezone'),1,100) timezone,
      substr(json_extract(w.watch_rule_json,'$.stopConditionText'),1,400) stopConditionText,
      json_extract(w.watch_rule_json,'$.endsAt') endsAt,
      json_extract(w.watch_rule_json,'$.termination.reason') terminationReason,
      (SELECT COUNT(*) FROM work_blockers b WHERE b.work_id=w.work_id AND b.status='open') openBlockerCount,
      ${waitingForUser} needsUserInput,
      (SELECT MIN(s.next_wake_at) FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL) nextWakeAt,
      (SELECT COUNT(*) FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL) activeSubscriptionCount,
      (SELECT COUNT(*) FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NOT NULL) stoppedSubscriptionCount
      FROM works w WHERE ${predicates.join(" AND ")} ORDER BY ${sort === "deadline_asc" ? "w.deadline_at IS NULL,w.deadline_at," : ""}w.created_at DESC,w.work_id DESC LIMIT @take`)
      .all(params) as Array<Omit<BotWorkSummary, "watchRule" | "versionGuard" | "detailAvailable" | "needsUserInput" | "tracking"> & {
        cronExpression: string | null; timezone: string | null; stopConditionText: string | null; endsAt: number | null; terminationReason: string | null; needsUserInput: number;
        stateVersion: number; intentRevision: number; ownerEpoch: number;
      }>;
    const hasMore = rows.length > limit;
    const tracking = workTrackingReader(this.db);
    const observedAt = Date.now();
    const summaries: Array<Omit<BotWorkSummary, "tracking">> = rows.slice(0, limit).map(({ stateVersion, intentRevision, ownerEpoch,
      cronExpression, timezone, stopConditionText, endsAt, terminationReason, needsUserInput, ...row }) => ({ ...row, needsUserInput: !!needsUserInput,
      watchRule: row.mode === "watch" ? { cronExpression, timezone, stopConditionText, endsAt, terminationReason } : null,
      versionGuard: { expectedStateVersion: stateVersion, expectedIntentRevision: intentRevision, expectedOwnerEpoch: ownerEpoch },
      detailAvailable: true }));
    const items: BotWorkSummary[] = summaries.map(item => ({ ...item, tracking: tracking(item, observedAt) }));
    const last = items.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ v: 2, scope, createdAt: last.createdAt, deadlineAt: last.deadlineAt, workId: last.workId })).toString("base64url") : null;
    const nextQuery: BotWorkQueryInput | null = nextCursor ? { view: "summary", status, limit, cursor: nextCursor,
      ...(input.search ? { search: input.search } : {}), ...(input.workId ? { workId: input.workId } : {}),
      ...(input.deadlineFrom !== undefined ? { deadlineFrom: input.deadlineFrom } : {}),
      ...(input.deadlineBefore !== undefined ? { deadlineBefore: input.deadlineBefore } : {}),
      ...(input.needsUserInput !== undefined ? { needsUserInput: input.needsUserInput } : {}),
      ...(input.sort !== undefined ? { sort } : {}) } : null;
    return { items, total, statusCounts, status, limit, hasMore, nextCursor, nextQuery, order: sort === "deadline_asc" ? "deadlineAt_asc_nulls_last_createdAt_desc_workId_desc" : "createdAt_desc_workId_desc",
      filters: { deadlineFrom: input.deadlineFrom ?? null, deadlineBefore: input.deadlineBefore ?? null, needsUserInput: input.needsUserInput ?? null },
      detailHint: "列表仅为摘要；使用 workId 查询完整成果、证据和历史。提交成果不等于整项完成；总数不是本页条数。" };
  }
}
