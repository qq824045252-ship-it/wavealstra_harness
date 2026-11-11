import { randomUUID } from "node:crypto";
import { workFirstNextStepSql, workNextStepsSearchSql } from "./WorkListSearch";
import type Database from "better-sqlite3";
import type { WorkProjectionDto } from "../../../shared/bot-work";
import { workQueryRequestSchema, type WorkQueryRequest, type WorkQueryResult, type WorkListStatusGroup } from "../../../shared/bot-work-query";
const databaseIdentities = new WeakMap<Database.Database, string>();

const statuses: Record<string, {
    label: string;
    group: WorkListStatusGroup;
}> = {
    expired: { label: "到期结束", group: "ended" },
    succeeded: { label: "已完成", group: "succeeded" },
    cancelled: { label: "已取消", group: "cancelled" },
    unsuccessful: { label: "已结束 · 未完成", group: "unsuccessful" },
    ended: { label: "已结束", group: "ended" },
    archived: { label: "已归档 · 未完成", group: "unsuccessful" },
    paused: { label: "已暂停", group: "paused" },
    closing: { label: "正在结算", group: "running" },
    expiring: { label: "已到期 · 正在结算", group: "running" },
    input: { label: "等待补充信息", group: "attention" },
    blocked: { label: "需要处理", group: "attention" },
    watchBlocked: { label: "检查受阻", group: "attention" },
    watchUnknown: { label: "检查结果待核对", group: "attention" },
    offline: { label: "等待宿主恢复", group: "waiting" },
    checking: { label: "正在检查", group: "running" },
    checkQueued: { label: "等待检查执行", group: "waiting" },
    checkFailed: { label: "上次检查未完成", group: "attention" },
    noCheck: { label: "暂无后续检查", group: "waiting" },
    eventBlocked: { label: "检查事件受阻", group: "attention" },
    eventQueued: { label: "等待处理检查事件", group: "waiting" },
    nextCheck: { label: "等待下次检查", group: "watching" },
    nextEvent: { label: "等待来源变化", group: "watching" },
    gaps: { label: "执行已结束 · 尚有缺口", group: "attention" },
    finalizing: { label: "正在整理最终结果", group: "results" },
    reviewing: { label: "正在核对结果", group: "results" },
    executing: { label: "正在执行", group: "running" },
    unknown: { label: "执行状态待核对", group: "attention" },
    queued: { label: "等待执行", group: "waiting" },
    failed: { label: "执行已结束 · 未完成", group: "attention" },
    idle: { label: "尚未执行", group: "waiting" },
};
const current = "b.work_id=w.work_id AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL";
const binding = (condition: string) => `EXISTS(SELECT 1 FROM work_execution_bindings b WHERE ${current} AND ${condition})`;
const watchBinding = (condition: string) => binding(`b.owner_epoch=w.owner_epoch AND b.status!='invalidated' AND ${condition}
 AND NOT EXISTS(SELECT 1 FROM work_execution_bindings n WHERE n.work_id=b.work_id AND n.task_id=b.task_id AND n.intent_revision=b.intent_revision
 AND n.input_snapshot_id=b.input_snapshot_id AND n.owner_epoch=b.owner_epoch AND n.invalidated_at IS NULL AND n.status!='invalidated'
 AND (n.admitted_at>b.admitted_at OR (n.admitted_at=b.admitted_at AND n.rowid>b.rowid)))`);
const blocker = "k.work_id=w.work_id AND k.status='open' AND k.kind!='external_effect' AND k.unknown_external_effect_ref IS NULL";
const subscriptions = "SELECT s.subscription_id FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL";
// Recursive, cycle-safe continuation ancestry. A matching real completed fact is required.
const gaps = `EXISTS(SELECT 1 FROM work_subitem_results r JOIN work_execution_bindings b ON b.binding_id=r.binding_id
 WHERE ${current} AND b.status!='invalidated' AND b.owner_epoch<=w.owner_epoch AND (b.owner_epoch=w.owner_epoch OR EXISTS(SELECT 1 FROM work_delegation_adoptions ad
 WHERE ad.binding_id=b.binding_id AND ad.owner_epoch=w.owner_epoch AND ad.adopted_by_bot_id=w.owner_bot_id AND ad.intent_revision=w.intent_revision AND ad.input_snapshot_id=w.input_snapshot_id))
 AND json_extract(r.result_json,'$.required')=1 AND json_extract(r.result_json,'$.outcome')!='completed'
 AND NOT EXISTS(WITH RECURSIVE descendants(plan_id,binding_id) AS (
 SELECT p.plan_id,cb.binding_id FROM work_continuation_plans p JOIN work_dispatch_requests d ON d.continuation_plan_id=p.plan_id AND d.state='dispatched'
 JOIN work_execution_bindings cb ON cb.binding_id=(SELECT lb.binding_id FROM work_execution_bindings lb WHERE lb.task_id=d.task_id ORDER BY lb.admitted_at DESC,lb.rowid DESC LIMIT 1)
 WHERE p.work_id=w.work_id AND p.source_binding_id=r.binding_id AND EXISTS(SELECT 1 FROM json_each(p.gap_items_json) WHERE value=r.item_id) AND cb.status IN ('completed','failed','stopped')
 UNION SELECT p.plan_id,cb.binding_id FROM descendants prev JOIN work_continuation_plans p ON p.source_binding_id=prev.binding_id AND p.work_id=w.work_id AND p.state!='cancelled'
 JOIN work_dispatch_requests d ON d.continuation_plan_id=p.plan_id AND d.state='dispatched'
 JOIN work_execution_bindings cb ON cb.binding_id=(SELECT lb.binding_id FROM work_execution_bindings lb WHERE lb.task_id=d.task_id ORDER BY lb.admitted_at DESC,lb.rowid DESC LIMIT 1)
 WHERE cb.status IN ('completed','failed','stopped'))
 SELECT 1 FROM descendants x JOIN work_subitem_results rr ON rr.binding_id=x.binding_id AND rr.work_id=w.work_id
 WHERE json_extract(rr.result_json,'$.outcome')='completed' AND (rr.item_id=r.item_id OR json_extract(rr.result_json,'$.task')=json_extract(r.result_json,'$.task'))))`;
const statusSql = `CASE
 WHEN w.mode='watch' AND w.lifecycle='closed' AND json_extract(w.watch_rule_json,'$.termination.reason')='schedule_expired' AND json_extract(w.watch_rule_json,'$.termination.settledAt') IS NOT NULL THEN 'expired'
 WHEN w.lifecycle='closed' THEN CASE w.closure_conclusion WHEN 'succeeded' THEN 'succeeded' WHEN 'cancelled' THEN 'cancelled' WHEN 'ended_unsuccessfully' THEN 'unsuccessful' ELSE 'ended' END
 WHEN a.archived_at IS NOT NULL THEN 'archived' WHEN w.lifecycle='paused' THEN 'paused'
 WHEN w.lifecycle='closing' THEN CASE WHEN json_extract(w.watch_rule_json,'$.termination') IS NOT NULL THEN 'expiring' ELSE 'closing' END
 WHEN EXISTS(SELECT 1 FROM work_blockers k WHERE ${blocker} AND k.waiting_for_user_input=1) THEN 'input'
 WHEN EXISTS(SELECT 1 FROM work_blockers k WHERE ${blocker}) THEN CASE WHEN w.mode='watch' THEN 'watchBlocked' ELSE 'blocked' END
 WHEN w.mode='watch' THEN CASE
 WHEN ${watchBinding("b.status='unknown'")} THEN 'watchUnknown' WHEN @online=0 THEN 'offline'
 WHEN ${watchBinding("b.status='running'")} THEN 'checking' WHEN ${watchBinding("b.status IN ('submitted','pending')")} THEN 'checkQueued'
 WHEN ${watchBinding("b.status IN ('failed','stopped')")} THEN 'checkFailed' WHEN NOT EXISTS(${subscriptions}) THEN 'noCheck'
 WHEN EXISTS(SELECT 1 FROM work_events_inbox e WHERE e.subscription_id IN (${subscriptions}) AND e.status='blocked')
 OR EXISTS(SELECT 1 FROM work_paused_source_routes r WHERE r.subscription_id IN (${subscriptions}) AND r.inbox_event_id IS NULL) THEN 'eventBlocked'
 WHEN EXISTS(SELECT 1 FROM work_events_inbox e WHERE e.subscription_id IN (${subscriptions}) AND e.status IN ('pending','merged')) THEN 'eventQueued'
 WHEN EXISTS(SELECT 1 FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL AND s.next_wake_at IS NOT NULL) THEN 'nextCheck'
 WHEN EXISTS(SELECT 1 FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL AND s.source!='cron' AND coalesce(s.cron_expression,'')='') THEN 'nextEvent' ELSE 'noCheck' END
 WHEN ${binding("b.status!='invalidated'")} AND NOT ${binding("b.status NOT IN ('completed','invalidated')")}
 AND NOT EXISTS(SELECT 1 FROM work_action_admissions ad WHERE ad.work_id=w.work_id AND ad.state='admitted') THEN CASE
 WHEN ${gaps} OR EXISTS(SELECT 1 FROM json_each(w.criteria_json) WHERE json_extract(value,'$.status') IN ('failed','blocked')) THEN 'gaps'
 WHEN w.input_snapshot_id!='snapshot:unbound' AND json_array_length(w.criteria_json)>0
 AND NOT EXISTS(SELECT 1 FROM json_each(w.criteria_json) WHERE json_extract(value,'$.status') NOT IN ('satisfied','waived'))
 AND NOT EXISTS(SELECT 1 FROM work_deliverables d JOIN work_execution_bindings b ON b.binding_id=d.execution_id WHERE d.work_id=w.work_id AND d.status='accepted'
 AND d.intent_revision=w.intent_revision AND d.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL AND b.status!='invalidated'
 AND json_array_length(d.uncovered_scope_json)>0 AND d.deliverable_id IN (SELECT value FROM json_each(w.accepted_deliverable_ids_json))) THEN 'finalizing' ELSE 'reviewing' END
 WHEN ${binding("b.status IN ('running','submitted')")} THEN 'executing' WHEN ${binding("b.status='unknown'")} THEN 'unknown'
 WHEN ${binding("b.status='pending'")} THEN 'queued' WHEN ${binding("b.status IN ('failed','stopped')")} THEN 'failed' ELSE 'idle' END`;
// This prefix is also part of the full search document. A positive match can skip
// the correlated detail/guidance reads; a negative match still searches everything.
const searchPrefixSql = `w.work_id||char(10)||w.title||char(10)||coalesce(w.goal_description,'')||char(10)||coalesce(w.closure_summary,'')||char(10)`;
const searchSql = `${searchPrefixSql}
 ||coalesce((SELECT group_concat(json_extract(value,'$.text'),char(10)) FROM json_each(w.criteria_json)),'')||char(10)
 ||coalesce((SELECT group_concat(k.reason,char(10)) FROM work_blockers k WHERE k.work_id=w.work_id AND k.status='open'),'')||char(10)
 ||coalesce((SELECT group_concat(d.summary||char(10)||coalesce((SELECT group_concat(value,char(10)) FROM json_each(d.artifact_refs_json)),''),char(10)) FROM work_deliverables d WHERE d.work_id=w.work_id),'')||char(10)
 ||coalesce((SELECT group_concat(g.path||char(10)||coalesce(json_extract(g.payload_json,'$.snapshotPath'),''),char(10)) FROM work_generated_artifacts g JOIN work_execution_bindings b ON b.binding_id=g.binding_id WHERE b.work_id=w.work_id AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id),'') || char(10) || (${workNextStepsSearchSql({ gaps, currentBinding: current })})`;
type Row = {
    work_id: string;
    project_id: string | null;
    title: string;
    mode: WorkProjectionDto['mode'];
    lifecycle: WorkProjectionDto['lifecycle'];
    pending_conclusion: WorkProjectionDto['pendingConclusion'];
    closure_conclusion: WorkProjectionDto['closureConclusion'];
    owner_bot_id: string;
    owner_epoch: number;
    intent_revision: number;
    source_version: number;
    state_version: number;
    input_snapshot_id: string;
    updated_at: number;
    closed_at: number | null;
    archived_at: number | null;
    deleted_at: number | null;
    status_key: string;
    excerpt: string;
    deliverable_count: number;
    has_result_excerpt: number;
    next_check_at: number | null;
    can_archive: number;
    execution_task_ids: string;
    running: number;
    team_json: string | null;
    watch_json: string | null;
};
/** SQL owns filtering, ordering and counts. Only the bounded page becomes JS objects. */
export class WorkListQuery {
    private readonly databaseIdentity: string;
    private readonly pageCache = new Map<string, WorkQueryResult>();
    constructor(private readonly db: Database.Database, private readonly hostOnline: () => boolean = () => true) {
        this.databaseIdentity = databaseIdentities.get(db) ?? randomUUID();
        databaseIdentities.set(db, this.databaseIdentity);
        // One query normally visits many rows. Keep only the most recent normalized
        // terms, without retaining searchable Work text or changing match semantics.
        let previousQuery: string | undefined;
        let terms: string[] = [];
        db.function('work_list_matches', { deterministic: true }, (text: unknown, query: unknown) => {
            const value = String(query ?? '');
            if (value !== previousQuery) {
                terms = value.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/);
                previousQuery = value;
            }
            const haystack = String(text ?? '').normalize('NFKC').toLocaleLowerCase();
            return terms.every(term => haystack.includes(term)) ? 1 : 0;
        });
        db.exec(`CREATE INDEX IF NOT EXISTS idx_works_user_summary_page ON works(user_id,updated_at DESC,work_id);
            CREATE INDEX IF NOT EXISTS idx_work_summary_subitems ON work_subitem_results(work_id,binding_id);
            CREATE INDEX IF NOT EXISTS idx_work_summary_continuations ON work_continuation_plans(work_id,source_binding_id);`);
    }
    /** The supplied watermark is advisory: always replace with a current atomic page. */
    query(userId: string, input: unknown): WorkQueryResult {
        const request = workQueryRequestSchema.parse(input);
        const cacheAllowed = !this.db.inTransaction;
        return this.db.transaction(() => {
            this.db.prepare("INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (?)").run(userId);
            const stream = this.db.prepare('SELECT epoch,sequence FROM work_projection_streams WHERE user_id=?').get(userId) as { epoch: string; sequence: number };
            const online = this.hostOnline();
            // The journal alone is insufficient: template visibility and related facts can
            // change independently. SQLite counters cover local and other-connection writes.
            const localChanges = this.db.prepare('SELECT total_changes() AS n').get() as { n: number };
            const dataVersion = this.db.pragma('data_version', { simple: true });
            const watermark = { ...stream, revision: `${this.databaseIdentity}:${localChanges.n}:${dataVersion}:${Number(online)}` };
            const { watermark: _advisory, ...pageRequest } = request;
            const key = JSON.stringify([userId, pageRequest, watermark]);
            const cached = cacheAllowed ? this.pageCache.get(key) : undefined;
            if (cached) {
                this.pageCache.delete(key);
                this.pageCache.set(key, cached);
                return structuredClone(cached);
            }
            const result = this.read(userId, request, online, watermark);
            if (cacheAllowed) {
                this.pageCache.set(key, structuredClone(result));
                if (this.pageCache.size > 16) this.pageCache.delete(this.pageCache.keys().next().value!);
            }
            return result;
        }).immediate();
    }
    /** Ownership is checked in SQL before any related facts are selected. */
    get(userId: string, workId: string): WorkProjectionDto | undefined {
        return this.db.transaction(() => {
            const row = this.db.prepare(this.base('w.work_id=@workId') + this.pageSelect() + ' FROM classified w LIMIT 1').get({ userId, workId, online: this.hostOnline() ? 1 : 0 }) as Row | undefined;
            return row ? this.shell(row) : undefined;
        }).deferred();
    }
    private base(scope: string): string {
        return `WITH facts AS (SELECT w.*,a.archived_at,a.deleted_at,t.plan_json,t.created_at AS team_created_at,o.team_id,o.team_name,v.removed_at,
  (a.archived_at IS NOT NULL OR (w.lifecycle='closed' AND coalesce(w.closure_conclusion,'')!='succeeded')) AS is_archived,${statusSql} AS status_key
  FROM works w LEFT JOIN work_record_archive a ON a.work_id=w.work_id LEFT JOIN work_teams t ON t.work_id=w.work_id AND t.user_id=w.user_id
  LEFT JOIN work_team_ownership o ON o.work_id=t.work_id LEFT JOIN work_team_record_visibility v ON v.work_id=t.work_id WHERE w.user_id=@userId AND (${scope})),
  classified AS (SELECT *,CASE WHEN is_archived THEN 'closed' WHEN lifecycle='closed' AND closure_conclusion='succeeded' THEN 'completed' ELSE 'active' END AS view_kind,
  CASE status_key ${Object.entries(statuses).map(([key, value]) => `WHEN '${key}' THEN '${value.group}'`).join(' ')} END AS status_group FROM facts) `;
    }
    private read(userId: string, request: WorkQueryRequest, online: boolean, watermark: WorkQueryResult['watermark']): WorkQueryResult {
        const scope = request.scope;
        let scopeSql: string;
        switch (scope.kind) {
            case 'personal':
                scopeSql = 't.work_id IS NULL AND w.owner_bot_id=@scopeId';
                break;
            case 'team':
                scopeSql = 'o.team_id=@scopeId AND v.removed_at IS NULL';
                break;
            case 'removed_teams':
                scopeSql = 't.work_id IS NOT NULL AND v.removed_at IS NOT NULL';
                break;
            case 'historical_teams':
                scopeSql = `t.work_id IS NOT NULL AND v.removed_at IS NULL AND (o.team_id IS NULL
                    OR NOT EXISTS(SELECT 1 FROM work_team_templates tt WHERE tt.template_id=o.team_id
                        AND tt.user_id=@userId AND tt.deleted_at IS NULL))`;
                break;
            default:
                scopeSql = '1';
        }
        const params = { userId, online: online ? 1 : 0, scopeId: scope.kind === 'personal' ? scope.botId : scope.kind === 'team' ? scope.teamId : '', query: request.query ?? '', view: request.view ?? 'active', status: request.status ?? 'all', showDeleted: request.showDeleted ? 1 : 0 };
        const base = this.base(scopeSql), visibility = '((@showDeleted=1 AND w.deleted_at IS NOT NULL) OR (@showDeleted=0 AND w.deleted_at IS NULL))', view = "(@view='all' OR w.view_kind=@view)";
        let search = '1';
        if (request.query?.trim()) {
            // A bounded scalar-only probe chooses a plan, never narrows the results.
            // Avoid a second matcher call on every row for sparse/deep-only searches.
            const probe = this.db.prepare(base + `SELECT work_list_matches(${searchPrefixSql},@query) AS matches
                FROM classified w WHERE ${visibility} AND ${view} LIMIT 32`).all(params) as { matches: number }[];
            const prefixPlan = probe.length > 0 && probe.filter(row => row.matches).length >= probe.length / 2;
            // CASE guarantees lazy evaluation; OR does not promise to skip the full document.
            search = prefixPlan ? `CASE WHEN work_list_matches(${searchPrefixSql},@query)=1 THEN 1
                ELSE work_list_matches(${searchSql},@query) END=1` : `work_list_matches(${searchSql},@query)=1`;
        }
        const filter = `${visibility} AND ${view} AND ${search}`;
        const viewCounts = { active: 0, completed: 0, closed: 0, all: 0 };
        let deletedCount = 0;
        // One cheap grouped pass supplies navigation totals and trash counts. It does not
        // evaluate status or search fields, which remain in the filtered query below.
        for (const row of this.db.prepare(base + `SELECT view_kind, deleted_at IS NOT NULL AS deleted, count(*) AS n
            FROM classified w GROUP BY view_kind, deleted_at IS NOT NULL`).all(params) as Array<{
                view_kind: 'active' | 'completed' | 'closed'; deleted: number; n: number;
            }>) {
            if (row.deleted) deletedCount += row.n;
            if (Boolean(row.deleted) === Boolean(request.showDeleted)) {
                viewCounts[row.view_kind] += row.n;
                viewCounts.all += row.n;
            }
        }
        const total = viewCounts[request.view ?? 'active'];
        const filterCounts: Partial<Record<WorkListStatusGroup, number>> = {};
        for (const row of this.db.prepare(base + `SELECT status_group,count(*) AS n FROM classified w WHERE ${filter} GROUP BY status_group`).all(params) as {
            status_group: WorkListStatusGroup;
            n: number;
        }[])
            filterCounts[row.status_group] = row.n;
        const filtered = request.status && request.status !== 'all' ? filterCounts[request.status] ?? 0 : Object.values(filterCounts).reduce((sum, n) => sum + (n ?? 0), 0);
        const pageSize = request.pageSize ?? 24, pages = Math.max(1, Math.ceil(filtered / pageSize)), page = Math.min(request.page ?? 1, pages);
        // The exact zero count belongs to this same transaction; there is no page to scan.
        const rows = filtered === 0 ? [] : this.db.prepare(base + this.pageSelect() + ` FROM classified w WHERE ${filter} AND (@status='all' OR status_group=@status) ORDER BY updated_at ${request.sort === 'oldest' ? 'ASC' : 'DESC'},work_id ASC LIMIT @limit OFFSET @offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Row[];
        const workExecutionTaskIds = request.candidateTaskIds?.length ? (this.db.prepare(base + 'SELECT DISTINCT b.task_id FROM work_execution_bindings b JOIN classified w ON w.work_id=b.work_id WHERE b.task_id IN (SELECT value FROM json_each(@candidates)) ORDER BY b.task_id').all({ ...params, candidates: JSON.stringify(request.candidateTaskIds) }) as {
            task_id: string;
        }[]).map(row => row.task_id) : [];
        return { works: rows.map(row => this.shell(row)), total, filtered, page, pageSize, pages, filterCounts, viewCounts, deletedCount, watermark, workExecutionTaskIds };
    }
    private pageSelect(): string {
        const latestResult = `(SELECT d.summary FROM work_deliverables d WHERE d.work_id=w.work_id
            AND d.status IN ('accepted','proposed') ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1)`;
        const firstStep = workFirstNextStepSql({ gaps, currentBinding: current });
        return `SELECT work_id,project_id,title,mode,lifecycle,pending_conclusion,closure_conclusion,owner_bot_id,owner_epoch,intent_revision,source_version,state_version,input_snapshot_id,updated_at,closed_at,archived_at,deleted_at,status_key,
  substr(CASE WHEN w.lifecycle='closed' OR w.is_archived THEN coalesce(nullif(w.closure_summary,''),nullif(${latestResult},''),
    CASE WHEN w.archived_at IS NOT NULL AND w.lifecycle!='closed' THEN '执行未完成，已归档，不再自动重试。打开可查看已有记录。'
      WHEN w.closure_conclusion='succeeded' THEN '委托已完成，打开查看最终记录。'
      WHEN w.closure_conclusion='cancelled' THEN '此委托已取消，已有记录仍可查看。' ELSE '打开查看结束原因与已有记录。' END)
    ELSE coalesce(${latestResult},nullif(${firstStep},''),'打开查看目标、进展与成果。') END,1,600) AS excerpt,
  EXISTS(SELECT 1 FROM work_deliverables d WHERE d.work_id=w.work_id AND d.status IN ('accepted','proposed')) AS has_result_excerpt,
  (SELECT count(*) FROM work_deliverables d WHERE d.work_id=w.work_id) AS deliverable_count,
  CASE WHEN w.mode='watch' AND w.lifecycle='active' AND w.archived_at IS NULL AND @online=1 THEN (SELECT min(s.next_wake_at) FROM work_subscriptions s WHERE s.work_id=w.work_id AND s.stopped_at IS NULL) END AS next_check_at,
  (w.lifecycle='closing' OR (w.lifecycle='active' AND ${binding("b.status='running'")})) AS running,
  '[]' AS execution_task_ids,
  (NOT w.is_archived AND w.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.work_id=w.work_id AND b.status IN ('pending','submitted','running','unknown'))
  AND NOT EXISTS(SELECT 1 FROM work_action_admissions ad WHERE ad.work_id=w.work_id AND ad.state='admitted')
  AND (w.lifecycle='closed' OR (w.lifecycle!='closing' AND w.mode!='watch' AND ${binding("b.status IN ('failed','stopped')")} AND NOT ${binding("b.status NOT IN ('completed','failed','stopped','invalidated')")}))) AS can_archive,
  CASE WHEN w.plan_json IS NOT NULL THEN json_object('teamId',w.team_id,'teamName',w.team_name,'removedAt',w.removed_at,'createdAt',w.team_created_at,
  'members',json(coalesce((SELECT json_group_array(json_object('botId',json_extract(value,'$.botId'),'responsibility','','delegatedScope',json('[]'))) FROM json_each(w.plan_json,'$.members')),'[]'))) END AS team_json,
  CASE WHEN w.watch_rule_json IS NOT NULL THEN json_object('endsAt',json_extract(w.watch_rule_json,'$.endsAt'),'termination',json_extract(w.watch_rule_json,'$.termination')) END AS watch_json`;
    }
    private shell(row: Row): WorkProjectionDto {
        const team = row.team_json ? JSON.parse(row.team_json) : undefined;
        return { workId: row.work_id, projectId: row.project_id ?? undefined, title: row.title, mode: row.mode, lifecycle: row.lifecycle,
            pendingConclusion: row.pending_conclusion ?? undefined, closureConclusion: row.closure_conclusion ?? undefined,
            ownerBotId: row.owner_bot_id, ownerEpoch: row.owner_epoch, intentRevision: row.intent_revision, sourceVersion: row.source_version, stateVersion: row.state_version,
            inputSnapshotId: row.input_snapshot_id, inputSnapshotBound: row.input_snapshot_id !== 'snapshot:unbound', updatedAt: row.updated_at, closedAt: row.closed_at ?? undefined,
            archive: row.archived_at !== null ? { archivedAt: row.archived_at, ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}) } : undefined,
            watchPlan: row.watch_json ? JSON.parse(row.watch_json) : undefined,
            team: team ? { ...team, teamId: team.teamId ?? undefined, teamName: team.teamName ?? undefined, removedAt: team.removedAt ?? undefined, ownerBotId: row.owner_bot_id, ownerResponsibility: '', workId: row.work_id, intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id, ownerEpoch: row.owner_epoch, state: 'queued', executions: [] } : undefined,
            goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [],
            listSummary: { status: statuses[row.status_key], excerpt: row.excerpt, hasResultExcerpt: Boolean(row.has_result_excerpt), deliverableCount: row.deliverable_count, nextCheckAt: row.next_check_at ?? undefined, canArchive: Boolean(row.can_archive), executionTaskIds: JSON.parse(row.execution_task_ids), running: Boolean(row.running) },
        };
    }
}
