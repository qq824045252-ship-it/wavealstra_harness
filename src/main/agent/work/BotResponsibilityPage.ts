import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BotWorkQueryInput } from "./BotWorkQuery";
import { botCollaborationStatusSchema } from "../../../shared/bot-collaboration";

export interface BotReadScope { userId: string; botId: string; teamId?: string; conversationScope?: string }
export interface ReminderReadFact { reminderId: string; title: string; content: string; createdAt: number; state: string }
export const delegationSchema = z.object({ collaborationId: z.string(), sourceConversationId: z.string(), targetBotId: z.string() });
export type BotWorkDelegation = z.infer<typeof delegationSchema>;
const identity = { id: z.string(), createdAt: z.number(), deadlineAt: z.number().nullable() };
const referenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("work"), workId: z.string(), collaborationId: z.string().nullable() }),
  z.object({ ...identity, kind: z.literal("reminder") }),
  z.object({ ...identity, kind: z.literal("collaboration"), collaborationId: z.string(), title: z.string(),
    state: botCollaborationStatusSchema, targetBotId: z.string(), targetDisplayName: z.string(), sourceConversationId: z.string(),
    requestPreview: z.string().nullable(), replyPreview: z.string().nullable(), scopeChanged: z.number().transform(value => value !== 0) }),
]);
export type ResponsibilityReference = z.infer<typeof referenceSchema>;
const cursorSchema = z.object({ v: z.literal(1), scope: z.string(), structure: z.string(),
  id: z.string(), createdAt: z.number(), deadlineAt: z.number().nullable() }).strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function hasOutgoingScope(db: Database.Database, scope: BotReadScope): boolean {
  return !scope.teamId && !scope.conversationScope
    && Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_collaborations'").get());
}
export function outgoingJoin(): string {
  return "c.user_id=w.user_id AND c.source_bot_id=@botId AND c.work_id=w.work_id AND c.target_bot_id=w.owner_bot_id";
}
export function workReadPredicate(scope: BotReadScope, outgoing: boolean): string {
  const personal = `(w.owner_bot_id=@botId OR EXISTS (SELECT 1 FROM work_participants p WHERE p.work_id=w.work_id AND p.bot_id=@botId)
    ${outgoing ? `OR EXISTS (SELECT 1 FROM bot_collaborations c WHERE ${outgoingJoin()})` : ""})`;
  const owned = scope.teamId ? "EXISTS (SELECT 1 FROM work_team_ownership t WHERE t.work_id=w.work_id AND t.team_id=@teamId)" : personal;
  return `w.user_id=@userId AND ${owned}${scope.conversationScope ? " AND EXISTS (SELECT 1 FROM work_conversations wc WHERE wc.work_id=w.work_id AND wc.conversation_id=@conversationScope)" : ""}`;
}

/** One read projection, with stable source identities. Only the selected page
 * is hydrated; counts and cursor structure scan matching lightweight keys. */
export function responsibilityPage(db: Database.Database, scope: BotReadScope, input: BotWorkQueryInput, reminders: ReminderReadFact[]) {
  const outgoing = hasOutgoingScope(db, scope), status = input.status ?? "open", sort = input.sort ?? "created_desc", limit = input.limit ?? 20;
  if (input.deadlineFrom !== undefined && input.deadlineBefore !== undefined && input.deadlineFrom >= input.deadlineBefore)
    throw new Error("承诺期限窗口无效：deadlineFrom 必须小于 deadlineBefore");
  const params: Record<string, string | number> = { userId: scope.userId, botId: scope.botId,
    teamId: scope.teamId ?? "", conversationScope: scope.conversationScope ?? "", reminders: JSON.stringify(reminders) };
  const relationId = outgoing ? "c.collaboration_id" : "NULL";
  const sourceCreated = outgoing ? "coalesce(c.created_at,w.created_at)" : "w.created_at";
  const sourceConversation = outgoing ? "c.source_conversation_id" : "NULL";
  const sourceBot = outgoing ? "c.target_bot_id" : "NULL";
  const workKey = outgoing ? "CASE WHEN c.collaboration_id IS NULL THEN 'work:'||w.work_id ELSE 'collaboration:'||c.collaboration_id END" : "'work:'||w.work_id";
  const unbound = outgoing ? `UNION ALL SELECT 'collaboration','collaboration:'||c.collaboration_id,NULL,c.collaboration_id,c.created_at,NULL,
    coalesce((SELECT substr(json_extract(m.value_json,'$.text'),1,200) FROM bot_collaboration_messages m
      WHERE m.collaboration_id=c.collaboration_id AND json_extract(m.value_json,'$.kind')='request' ORDER BY m.ordinal LIMIT 1),
      '与 '||json_extract(c.value_json,'$.targetDisplayName')||' 的协作'),
    c.status,NULL,NULL,0,c.target_bot_id,json_extract(c.value_json,'$.targetDisplayName'),c.source_conversation_id,
    (SELECT substr(json_extract(m.value_json,'$.text'),1,500) FROM bot_collaboration_messages m
      WHERE m.collaboration_id=c.collaboration_id AND json_extract(m.value_json,'$.kind')='request' ORDER BY m.ordinal LIMIT 1),
    (SELECT substr(json_extract(m.value_json,'$.text'),1,500) FROM bot_collaboration_messages m
      WHERE m.collaboration_id=c.collaboration_id AND json_extract(m.value_json,'$.senderBotId')=c.target_bot_id
      AND json_extract(m.value_json,'$.kind')<>'request' ORDER BY m.ordinal DESC LIMIT 1),c.work_id IS NOT NULL,
    json_extract(c.value_json,'$.targetDisplayName')
    FROM bot_collaborations c WHERE c.user_id=@userId AND c.source_bot_id=@botId
      AND NOT EXISTS (SELECT 1 FROM works w WHERE w.work_id=c.work_id AND ${workReadPredicate(scope, true)})` : "";
  const predicates: string[] = [];
  if (status === "open") predicates.push("((kind='work' AND state!='closed') OR (kind='collaboration' AND state!='cancelled' AND (scopeChanged=1 OR state!='returned')) OR (kind='reminder' AND state NOT IN ('delivered','cancelled'))) ");
  else if (status !== "all") { predicates.push("kind='work' AND state=@status"); params.status = status; }
  if (input.workId) { predicates.push("kind='work' AND workId=@workId"); params.workId = input.workId; }
  if (input.search) {
    predicates.push(`(instr(lower(title),lower(@search))>0 OR instr(lower(searchText),lower(@search))>0
      ${outgoing ? `OR (kind='collaboration' AND EXISTS (SELECT 1 FROM bot_collaboration_messages m
        WHERE m.collaboration_id=candidates.collaborationId AND json_extract(m.value_json,'$.kind')='request'
        AND instr(lower(json_extract(m.value_json,'$.text')),lower(@search))>0))` : ""})`);
    params.search = input.search;
  }
  if (input.deadlineFrom !== undefined) { predicates.push("kind='work' AND deadlineAt>=@deadlineFrom"); params.deadlineFrom = input.deadlineFrom; }
  if (input.deadlineBefore !== undefined) { predicates.push("kind='work' AND deadlineAt<@deadlineBefore"); params.deadlineBefore = input.deadlineBefore; }
  if (input.needsUserInput !== undefined) { predicates.push("kind='work' AND needsUserInput=@needsUserInput"); params.needsUserInput = Number(input.needsUserInput); }
  const cte = `WITH candidates(kind,id,workId,collaborationId,createdAt,deadlineAt,title,state,mode,needsUserInput,
    eventSubscriptionCount,targetBotId,targetDisplayName,sourceConversationId,requestPreview,replyPreview,scopeChanged,searchText) AS (
    SELECT 'work',${workKey},w.work_id,${relationId},${sourceCreated},w.deadline_at,substr(w.title,1,200),w.lifecycle,w.mode,
      EXISTS(SELECT 1 FROM work_blockers b WHERE b.work_id=w.work_id AND b.status='open' AND b.waiting_for_user_input=1),
      (SELECT COUNT(*) FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.source!='cron'),
      ${sourceBot},NULL,${sourceConversation},NULL,NULL,0,${input.search ? "w.title||' '||coalesce(w.goal_description,'')" : "''"}
    FROM works w ${outgoing ? "LEFT JOIN bot_collaborations c ON c.user_id=w.user_id AND c.source_bot_id=@botId AND c.work_id=w.work_id" : ""}
    WHERE ${workReadPredicate(scope, outgoing)}
    ${unbound}
    UNION ALL SELECT 'reminder','reminder:'||json_extract(value,'$.reminderId'),NULL,NULL,json_extract(value,'$.createdAt'),NULL,
      substr(json_extract(value,'$.title'),1,200),json_extract(value,'$.state'),NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,0,
      json_extract(value,'$.title')||' '||json_extract(value,'$.content')
    FROM json_each(@reminders))
    ,filtered AS (SELECT * FROM candidates WHERE ${predicates.join(" AND ") || "1"})`;
  const counts = z.object({ total: z.number(), reminders: z.number(), onceWorks: z.number(), watchWorks: z.number(), collaborations: z.number(), eventSubscriptions: z.number() })
    .parse(db.prepare(`${cte} SELECT COUNT(*) total,coalesce(sum(kind='reminder'),0) reminders,
      coalesce(sum(kind='work' AND mode='once'),0) onceWorks,coalesce(sum(kind='work' AND mode='watch'),0) watchWorks,
      coalesce(sum(kind='collaboration'),0) collaborations,coalesce(sum(eventSubscriptionCount),0) eventSubscriptions FROM filtered`).get(params));
  // Progress/receipt writes do not invalidate a cursor. Membership, identity and
  // its selected ordering keys do; a late deadline must not silently skip a row.
  const structureHash = createHash("sha256");
  for (const row of db.prepare(`${cte} SELECT id,createdAt${sort === "deadline_asc" ? ",deadlineAt" : ""} FROM filtered ORDER BY id`).iterate(params))
    structureHash.update(JSON.stringify(row));
  const structure = structureHash.digest("hex");
  const cursorScope = hash(["responsibility-overview", scope, status, sort, input.search ?? null,
    input.workId ?? null, input.deadlineFrom ?? null, input.deadlineBefore ?? null, input.needsUserInput ?? null]);
  let after: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
    catch { throw new Error("查询游标无效，请重新查询第一页"); }
    if (after.scope !== cursorScope) throw new Error("查询游标与当前用户、Bot、会话或筛选不匹配，请重新查询第一页");
    if (after.structure !== structure) throw new Error("事项集合或排序已变化，请移除 cursor 重新查询第一页；不要拼接旧页推断完整列表");
  }
  let boundary = "1";
  if (after) {
    const older = "(createdAt<@afterCreated OR (createdAt=@afterCreated AND id<@afterId))";
    boundary = sort === "created_desc" ? older : after.deadlineAt === null ? `deadlineAt IS NULL AND ${older}`
      : `(deadlineAt IS NULL OR deadlineAt>@afterDeadline OR (deadlineAt=@afterDeadline AND ${older}))`;
    params.afterCreated = after.createdAt; params.afterId = after.id;
    if (sort === "deadline_asc" && after.deadlineAt !== null) params.afterDeadline = after.deadlineAt;
  }
  params.take = limit + 1;
  const rows = db.prepare(`${cte} SELECT kind,id,workId,collaborationId,createdAt,deadlineAt,title,state,
    targetBotId,targetDisplayName,sourceConversationId,requestPreview,replyPreview,scopeChanged FROM filtered WHERE ${boundary} ORDER BY
    ${sort === "deadline_asc" ? "deadlineAt IS NULL,deadlineAt," : ""}createdAt DESC,id DESC LIMIT @take`).all(params).map(row => referenceSchema.parse(row));
  const references = rows.slice(0, limit), last = references.at(-1), hasMore = rows.length > limit;
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ v: 1, scope: cursorScope, structure,
    id: last.id, createdAt: last.createdAt, deadlineAt: last.deadlineAt })).toString("base64url") : null;
  const { cursor: _cursor, ...filters } = input;
  const nextQuery = nextCursor ? { ...filters, status, sort, limit, cursor: nextCursor } : null;
  return { references, counts, total: counts.total, limit, hasMore, nextCursor, nextQuery,
    order: sort === "deadline_asc" ? "deadlineAt_asc_nulls_last_createdAt_desc_id_desc" : "createdAt_desc_id_desc" };
}
