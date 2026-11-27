import type Database from "better-sqlite3";
import type { RuntimeAuditReader, RuntimeTaskBoardPage, RuntimeTaskBoardQuery } from "../../src/main/platform/runtime-audit";
import type { BoardAction, BoardQuery } from "../../src/shared/task-board";
import { TaskBoardRepository } from "../../src/main/task/TaskBoardRepository";
import { boardSources, ensureTaskBoard } from "./legacy-task-board-schema";

const hidden = `hidden(id) AS (SELECT id FROM spaces WHERE archived=1 UNION
  SELECT s.id FROM spaces s JOIN hidden h ON s.parent_id=h.id)`;
const currentWaits = `board_waits AS MATERIALIZED (
  SELECT key AS rowid, value->>0 AS id, value->>1 AS token, value->>2 AS message,
    value->>3 AS detail, value->>4 AS at FROM json_each(@waits)
)`;
const visibility = "AND (b.space_id IS NULL OR b.space_id NOT IN (SELECT id FROM hidden))";
const actionVisibility = `WITH RECURSIVE ${hidden},${boardSources}
  SELECT 1 FROM board_native b WHERE b.id=@id ${visibility}
  UNION ALL SELECT 1 FROM board_requests b WHERE b.id=@id ${visibility} LIMIT 1`;
const latestResult =
  "(SELECT d.at FROM task_board_days d WHERE d.id=b.id AND d.kind='result' ORDER BY d.day DESC LIMIT 1)";
const afterDeferral =
  "coalesce((SELECT p.deferred_at FROM task_board_plans p WHERE p.id=b.id AND p.later_until>@now),0)";
const pendingQuestion = "SELECT i.id FROM conversation_interactions i WHERE i.task_id=b.id AND i.status='pending'";
const hasWait = `(EXISTS(${pendingQuestion}) OR EXISTS(SELECT 1 FROM board_waits w WHERE w.id=b.id))`;
const taskLane = `CASE
  WHEN b.status IN ('failed','unknown') OR ${hasWait} THEN 'attention'
  WHEN b.status='in_progress' THEN 'running'
  WHEN b.status IN ('completed','stopped') THEN 'finished'
  ELSE 'pending' END`;
const unread = `(b.request_data IS NULL AND b.status IN ('completed','failed') AND
  coalesce(b.ack,0)<coalesce(${latestResult},b.ack,b.updated_at))`;
const active = "coalesce(b.status,'planning') NOT IN ('completed','stopped')";
const planned =
  "EXISTS (SELECT 1 FROM task_board_plans p WHERE p.id=b.id AND p.day=date(@now/1000,'unixepoch','localtime'))";
const deferred = "(SELECT later_until FROM task_board_plans p WHERE p.id=b.id)";
const rankByDay = (key: string) => `SELECT id,max(at) AS at,count(DISTINCT day) AS n FROM task_board_days
  WHERE kind IN (${key}) AND at>=@from AND at<@until GROUP BY id`;

function localOffset(now: number, days: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

type FixtureQuery = {
  sql: string;
  countSql?: string;
  parameters: Record<string, string | number | null>;
  size: number;
  hasCursor: boolean;
};

// SQLite-backed fixtures in older desktop and Dots suites own their own seeds.
export function fixtureTaskBoard(db: Database.Database): TaskBoardRepository {
  return new TaskBoardRepository({ core: new FixtureTaskBoardStore(db) });
}

class FixtureTaskBoardStore {
  constructor(private readonly db: Database.Database) {
    ensureTaskBoard(db);
  }

  async writeTaskBoardAction({ id, action, now, laterUntil }: Parameters<RuntimeAuditReader["writeTaskBoardAction"]>[0]): Promise<boolean> {
    this.db.transaction(() => {
      if (this.db.prepare(actionVisibility).get({ id })) this.writeAction(id, action, now, laterUntil);
    }).immediate();
    return true;
  }

  async writeTaskBoardNote({ id, kindName, detail, at }: Parameters<RuntimeAuditReader["writeTaskBoardNote"]>[0]): Promise<boolean> {
    this.insertNote(id, kindName, detail, at);
    return true;
  }

  private insertNote(id: string, kind: string, detail: string, at: number): void {
    this.db.prepare(`
      INSERT INTO task_board_days(id,kind,day,at,detail)
      VALUES(?,?,date(?/1000.0,'unixepoch','localtime'),?,?) ON CONFLICT(id,kind,day)
      DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=at
    `).run(id, kind, at, at, detail);
  }

  private writeAction(id: string, action: BoardAction, now: number, laterUntil: number | null): void {
    if (action === "visit" || action === "read") return this.insertNote(id, action, "", now);
    if (action === "clear") {
      this.db.prepare("DELETE FROM task_board_plans WHERE id=?").run(id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO task_board_plans(id,day,later_until,deferred_at) VALUES(?,date(?/1000,'unixepoch','localtime'),?,?)
      ON CONFLICT(id) DO UPDATE SET day=excluded.day,later_until=excluded.later_until,deferred_at=excluded.deferred_at`,
      )
      .run(
        id,
        action === "today" ? now : null,
        laterUntil,
        action === "later" ? now : null,
      );
  }

  async taskBoard<Row>(request: RuntimeTaskBoardQuery): Promise<RuntimeTaskBoardPage<Row>> {
    const { ordinary, calendar } = request;
    const q = { ...request, scope: request.scope?.spaceId };
    const now = calendar.now;
    if (q.view === "automation") return this.automation<Row>(q, now);
    const end = localOffset(now, 1);
    const monday = localOffset(now, -((new Date(now).getDay() + 6) % 7));
    let from = localOffset(now, -13),
      until = end;
    let candidates = "",
      at = "b.updated_at",
      rank = "0",
      match = "1";
    const sources = ordinary || q.view === "review" ? ["board_native"] : ["board_native", "board_requests"];
    const ordinaryFilter = ordinary ? `AND b.id NOT GLOB 'gw-*' AND b.id NOT GLOB 'gateway-chat-*'
      AND coalesce(b.space_id,'') NOT GLOB 'sp-gw-*'
      AND NOT EXISTS (SELECT 1 FROM tasks external WHERE external.id=b.id AND external.external_agent_pin_json IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=b.id)
      AND NOT EXISTS (SELECT 1 FROM work_execution_bindings e WHERE e.task_id=b.id)
      ${ordinary.taskId ? "AND b.id=@taskId" : ""}
      ${ordinary.spaceIds ? "AND b.space_id IN (SELECT value FROM json_each(@spaceIds))" : ""}` : "";
    const waits = `SELECT task_id AS id,created_at AS at FROM conversation_interactions WHERE status='pending'
      UNION ALL SELECT id,at FROM board_waits`;
    if (q.view === "recent" || q.view === "frequent") {
      const often = q.view === "frequent";
      candidates =
        rankByDay(often ? "'visit','follow'" : "'follow'") + (often ? " HAVING count(DISTINCT day)>=2" : "");
      at = "k.at";
      rank = often ? "k.n" : "0";
    } else if (q.view === "dates" || q.view === "results") {
      const key = q.view === "results" ? "result" : (q.dateKind ?? "follow");
      from = q.from ?? from;
      until = q.until ?? until;
      if (key === "follow" || key === "result") {
        candidates = rankByDay(`'${key}'`);
        at = "k.at";
      } else {
        at = key === "due" ? "b.due_at" : "b.updated_at";
        match = `${at}>=@from AND ${at}<@until`;
      }
      if (q.view === "results")
        match = `NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM task_board_days v WHERE v.id=b.id AND v.kind IN ('visit','read') AND v.at>=k.at) AND coalesce(b.ack,0)<k.at`;
      if (q.view === "results" && q.preview)
        candidates = `SELECT interest.id,max(d.at) AS at FROM (
        SELECT id FROM task_board_days WHERE kind IN ('follow','visit') AND at>=@from AND at<@until
        UNION SELECT id FROM tasks WHERE is_favorited=1
        UNION SELECT id FROM task_board_plans WHERE day=date(@now/1000,'unixepoch','localtime')
        ) interest CROSS JOIN task_board_days d ON d.id=interest.id AND d.kind='result'
        WHERE d.day>=date(@from/1000,'unixepoch','localtime') AND d.at>=@from AND d.at<@until GROUP BY interest.id`;
    } else if (q.view === "attention" || q.view === "today") {
      candidates = `SELECT id,min(at) AS at,max(n) AS n,max(CASE WHEN n=3 THEN at END) AS newest_wait FROM (
        SELECT id,at,3 AS n FROM (${waits})
        UNION ALL SELECT id,due_at,2 FROM tasks WHERE archived=0 AND due_at<@end AND status IS NOT 'completed' AND status IS NOT 'stopped'
        UNION ALL SELECT id,@now,1 FROM task_board_plans WHERE day=date(@now/1000,'unixepoch','localtime')
        UNION ALL SELECT id,later_until,1 FROM task_board_plans WHERE later_until>=@today AND later_until<=@now
        ${q.view === "attention" ? "UNION ALL SELECT id,updated_at,0 FROM tasks WHERE status='failed' AND updated_at>=@from" : ""}
      ) GROUP BY id`;
      rank = "k.n";
      at = "-k.at";
      match = `(k.n<>0 OR ${unread}) AND (coalesce(${deferred},0)<=@now OR
        k.newest_wait>(SELECT p.deferred_at FROM task_board_plans p WHERE p.id=b.id))`;
      if (q.view === "attention")
        match += ` AND (k.n>0 OR NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id))`;
    } else if (q.view === "week") {
      from = monday;
      until = localOffset(monday, 7);
      match = `b.due_at>=@from AND b.due_at<@until AND ${active}`;
      at = "-b.due_at";
    } else if (q.view === "later") {
      candidates = "SELECT id,later_until AS at FROM task_board_plans WHERE later_until>@now";
      at = "-k.at";
    } else if (q.view === "running") {
      match = `b.status='in_progress' AND NOT ${hasWait}`;
      if (q.preview) match += " AND NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id)";
    } else if (q.view === "review") {
      candidates = "SELECT DISTINCT task_id AS id FROM task_code_review WHERE status='pending'";
    } else if (q.view === "unread") match = unread;
    else if (q.view === "pinned") match = "b.pinned=1";
    if (q.lane) match += ` AND (${taskLane})=@lane`;
    if (q.lane === "attention" && rank === "0") rank = `CASE WHEN ${hasWait} THEN 1 ELSE 0 END`;
    if (q.preview && !["today", "attention"].includes(q.view)) match += ` AND coalesce(${deferred},0)<=@now`;
    const size = q.preview ? 4 : q.lane ? 10 : 25;
    const scope = q.scope === undefined ? "" : " AND b.space_id IS @scope";
    const project = q.projectId ? " AND b.project_id=@project" : "";
    const search = q.search?.trim() ? " AND instr(lower(b.title),lower(@term))>0" : "";
    const select = (source: string, paged: boolean) => `SELECT ${paged ? `b.*,${rank} AS rank,${at} AS at` : "b.id"} FROM
      ${candidates ? `ranked k CROSS JOIN ${source} b ON b.id=k.id` : `${source} b`}
      WHERE (${match}) ${visibility} ${scope} ${project} ${search} ${ordinaryFilter}
      ${paged && q.cursor ? `AND ((${rank})<@rank OR ((${rank})=@rank AND ((${at})<@at OR ((${at})=@at AND b.id>@id))))` : ""}`;
    const hiddenSpaces = ordinary ? hidden.replace("WHERE archived=1", "WHERE archived=1 OR id GLOB 'sp-gw-*' OR id GLOB 'bot-space-*' OR id GLOB 'bot-team-space-*' OR id GLOB 'bot-workspace-group-*'") : hidden;
    const prefix = `WITH RECURSIVE ${hiddenSpaces},${boardSources},${currentWaits}${candidates ? ", ranked AS MATERIALIZED (" + candidates + ")" : ""}`;
    const selection = sources.map((source) => select(source, true)).join(" UNION ALL ");
    // Deferring keeps a card out of focus until a new request arrives. The historical card still shows live blockers.
    const waitSince = q.view === "today" || q.view === "attention" ? afterDeferral : "0";
    const question = `(${pendingQuestion} AND i.created_at>=${waitSince} ORDER BY i.created_at,i.id LIMIT 1)`;
    const signalKind =
      q.view === "recent" || (q.view === "dates" && q.dateKind === "follow")
        ? "follow"
        : q.view === "results" || (q.view === "dates" && q.dateKind === "result")
          ? "result"
          : undefined;
    const signal = signalKind
      ? "(SELECT detail FROM task_board_days d WHERE d.id=b.id AND d.kind=@kind AND d.day=date(b.at/1000,'unixepoch','localtime') AND d.at=b.at)"
      : "NULL";
    const sql = `${prefix}, page AS MATERIALIZED (${selection} ORDER BY rank DESC,at DESC,id LIMIT @limit )
      SELECT b.*, ${unread} AS is_unread,${planned} AS is_planned,${deferred} AS later_until,i.id AS question_id,${latestResult} AS latest_result,
        CASE WHEN b.request_data IS NULL THEN (SELECT count(*) FROM task_code_review c WHERE c.task_id=b.id AND c.status='pending') ELSE 0 END AS pending_reviews,
        CASE WHEN i.id IS NOT NULL THEN 'question' WHEN w.token<>'' THEN 'approval' WHEN w.token='' THEN 'input' END AS wait_kind,
        CASE WHEN i.id IS NOT NULL THEN i.title WHEN w.token<>'' THEN w.detail END AS wait_reason,
        CASE WHEN b.status='failed' THEN coalesce(substr(b.source_error,1,240),(
          SELECT CASE WHEN type='task.failed' THEN substr(body,1,240) END FROM notifications
          WHERE task_id=b.id AND type IN ('task.failed','task.completed') ORDER BY created_at DESC LIMIT 1
        )) END AS failure,coalesce(i.assistant_message_id,w.message) AS message,
        CASE WHEN i.id IS NULL THEN nullif(w.token,'') END AS tool,${signal} AS signal
      FROM page b LEFT JOIN conversation_interactions i ON i.id=${question}
      LEFT JOIN board_waits w ON w.rowid=(SELECT w2.rowid FROM board_waits w2 WHERE w2.id=b.id AND w2.at>=${waitSince} ORDER BY (w2.token=''),w2.at LIMIT 1)
      ORDER BY b.rank DESC,b.at DESC,b.id`;
    const params = {
      now,
      today: localOffset(now, 0),
      end,
      from,
      until,
      limit: size + 1,
      kind: signalKind ?? null,
      lane: q.lane ?? null,
      scope: q.scope ?? null,
      project: q.projectId ?? null,
      taskId: ordinary?.taskId ?? null,
      spaceIds: JSON.stringify(ordinary?.spaceIds ?? []),
      term: q.search?.trim() ?? "",
      rank: q.cursor?.rank ?? 0,
      at: q.cursor?.at ?? 0,
      id: q.cursor?.id ?? "",
      waits: JSON.stringify(request.waits.map(w => [w.id, w.token, w.message, w.detail, w.at])),
    };
    // 焦点预览也要给出总数：栏目标题旁的计数和「还有 N 个被折叠」都依赖它。
    const includeTotal = q.lane || (q.preview && (q.view === "attention" || q.view === "review" || q.view === "running"));
    const countSql = includeTotal
      ? `${prefix} SELECT count(*) FROM (${sources.map(source => select(source, false)).join(" UNION ALL ")})`
      : undefined;
    return this.queryFixture<Row>({
      sql, countSql, parameters: params, size, hasCursor: Boolean(q.cursor),
    });
  }

  private queryFixture<Row>(request: FixtureQuery): RuntimeTaskBoardPage<Row> {
    return this.db.transaction(() => {
      const rows = this.db.prepare(request.sql).all(request.parameters) as Row[];
      const total = request.countSql === undefined ? undefined
        : !request.hasCursor && rows.length <= request.size ? rows.length
          : this.db.prepare(request.countSql).pluck().get(request.parameters) as number;
      return { rows, total };
    })();
  }

  private automation<Row>(q: BoardQuery, now: number): RuntimeTaskBoardPage<Row> {
    const size = q.preview ? 4 : 25;
    const scope = q.scope === undefined ? "" : " AND b.space_id IS @scope";
    const base = `SELECT r.id AS run_id,r.job_id,r.started_at,r.status,r.error,b.id AS task_id,b.title,b.space_id,j.name
      FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id JOIN board_native b ON b.id=r.task_id
      WHERE r.started_at>=@from ${visibility} ${scope} AND instr(lower(j.name),lower(@term))>0`;
    const source = q.jobId
      ? `SELECT *,run_id AS id,1 AS runs FROM runs WHERE job_id=@job`
      : `SELECT *,job_id AS id FROM (SELECT *,count(*) OVER(PARTITION BY job_id) AS runs,
        row_number() OVER(PARTITION BY job_id ORDER BY started_at DESC,run_id DESC) AS position FROM runs) WHERE position=1`;
    const sql = `WITH RECURSIVE ${hidden},${boardSources},runs AS (${base}),chosen AS (${source})
      SELECT * FROM chosen WHERE started_at<@before OR (started_at=@before AND id>@id)
      ORDER BY started_at DESC,id LIMIT @limit`;
    return this.queryFixture<Row>({
      sql, size, hasCursor: Boolean(q.cursor),
      parameters: {
        from: localOffset(now, -29), scope: q.scope ?? null, term: q.search?.trim() ?? "",
        job: q.jobId ?? "", before: q.cursor?.at ?? Number.MAX_SAFE_INTEGER, id: q.cursor?.id ?? "", limit: size + 1,
      },
    });
  }
}
