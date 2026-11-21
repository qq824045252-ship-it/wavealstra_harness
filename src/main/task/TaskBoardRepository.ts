import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import {
  boardViews,
  type BoardAction,
  type BoardPage,
  type BoardQuery,
  type TaskBoardRow,
} from "../../shared/task-board";
import { ensureTaskBoard } from "./TaskBoardActivity";

const querySchema = z.object({
  view: z.enum(boardViews),
  scope: z.string().nullable().optional(),
  projectId: z.string().optional(),
  search: z.string().max(500).optional(),
  jobId: z.string().optional(),
  dateKind: z.enum(["follow", "result", "due", "updated"]).optional(),
  from: z.number().int().optional(),
  until: z.number().int().optional(),
  preview: z.boolean().optional(),
  cursor: z.object({ rank: z.number().int(), at: z.number().int(), id: z.string() }).optional(),
});
const hidden = `hidden(id) AS (SELECT id FROM spaces WHERE archived=1 UNION
  SELECT s.id FROM spaces s JOIN hidden h ON s.parent_id=h.id)`;
const visibility = "AND (b.space_id IS NULL OR b.space_id NOT IN (SELECT id FROM hidden))";
const latestResult =
  "(SELECT d.at FROM task_board_days d WHERE d.id=b.id AND d.kind='result' ORDER BY d.day DESC LIMIT 1)";
const afterDeferral =
  "coalesce((SELECT p.deferred_at FROM task_board_plans p WHERE p.id=b.id AND p.later_until>@now),0)";
const question = `(SELECT i.id FROM conversation_interactions i WHERE i.task_id=b.id AND i.status='pending' AND i.created_at>=${afterDeferral} ORDER BY i.created_at,i.id LIMIT 1)`;
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

type SqlRow = {
  id: string;
  title: string;
  space_id: string | null;
  status: string | null;
  updated_at: number;
  due_at: number | null;
  start_at: number | null;
  pinned: number;
  ack: number | null;
  is_unread: number;
  rank: number;
  at: number;
  is_planned: number;
  later_until: number | null;
  request_data: string | null;
  question_id: string | null;
  latest_result: number | null;
  signal: string | null;
  problem: string | null;
  message: string | null;
  tool: string | null;
};

export class TaskBoardRepository {
  constructor(private db: Database.Database) {
    ensureTaskBoard(db);
  }

  // The agent has already accepted this input. A projection error must not turn it into a rejected send.
  follow(id: string, detail: string, at = Date.now()): void {
    try {
      this.note(id, "follow", detail, at);
    } catch (error) {
      console.warn("[TaskBoard] 跟进记录未保存", error);
    }
  }

  note(id: string, kind: "follow" | "visit" | "read" | "result", detail = "", at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO task_board_days(id,kind,day,at,detail)
      VALUES(?,?,date(?/1000.0,'unixepoch','localtime'),?,?) ON CONFLICT(id,kind,day)
      DO UPDATE SET at=excluded.at, detail=excluded.detail WHERE excluded.at>=at`,
      )
      .run(id, kind, at, at, detail.trim().slice(0, 120));
  }

  action(id: string, action: BoardAction, now = Date.now()): void {
    z.enum(["visit", "read", "today", "later", "clear"]).parse(action);
    if (
      !this.db
        .prepare(
          `WITH RECURSIVE ${hidden} SELECT 1 FROM board_native b WHERE b.id=? ${visibility}
      UNION ALL SELECT 1 FROM board_requests b WHERE b.id=? ${visibility} LIMIT 1`,
        )
        .get(id, id)
    )
      return;
    if (action === "visit" || action === "read") return this.note(id, action, "", now);
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
        action === "later" ? localOffset(now, 1) : null,
        action === "later" ? now : null,
      );
  }

  patch(patch: AgentUiPatch): void {
    if (patch.type === "tool_start" && patch.status === "pending_approval") {
      this.db
        .prepare("INSERT OR REPLACE INTO board_waits VALUES(?,?,?,?,?)")
        .run(patch.taskId, patch.toolCallId, patch.messageId, patch.summary, Date.now());
    } else if (patch.type === "tool_update" && patch.status && patch.status !== "pending_approval") {
      this.db.prepare("DELETE FROM board_waits WHERE id=? AND token=?").run(patch.taskId, patch.toolCallId);
    } else if (patch.type === "assistant_end") {
      this.db.prepare("DELETE FROM board_waits WHERE id=? AND message=?").run(patch.taskId, patch.messageId);
      if (!patch.cancelled) this.note(patch.taskId, "result");
    } else if (patch.type === "durable_snapshot" || patch.type === "durable_delta") {
      const state = patch.type === "durable_snapshot" ? patch.snapshot : patch.delta.state;
      if (state.status === "waiting_input" && !this.waiting.has(patch.taskId)) {
        this.db
          .prepare("INSERT OR IGNORE INTO board_waits VALUES(?,'',NULL,'等待你回答',?)")
          .run(patch.taskId, Date.now());
      } else if (state.status !== "waiting_input" && this.waiting.has(patch.taskId)) {
        this.db.prepare("DELETE FROM board_waits WHERE id=? AND token=''").run(patch.taskId);
      }
      if (state.status === "waiting_input") this.waiting.add(patch.taskId);
      else this.waiting.delete(patch.taskId);
    }
  }
  private waiting = new Set<string>();

  page(input: BoardQuery, now = Date.now()): BoardPage {
    const q = querySchema.parse(input);
    if (q.view === "automation") return this.automation(q, now);
    const end = localOffset(now, 1);
    const monday = localOffset(now, -((new Date(now).getDay() + 6) % 7));
    let from = localOffset(now, -13),
      until = end;
    let candidates = "",
      at = "b.updated_at",
      rank = "0",
      match = "1";
    const sources = ["board_native", "board_requests"];
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
    } else if (q.view === "unread") match = unread;
    else if (q.view === "pinned") match = "b.pinned=1";
    if (q.preview && !["today", "attention"].includes(q.view)) match += ` AND coalesce(${deferred},0)<=@now`;
    const size = q.preview ? 4 : 25;
    const scope = q.scope === undefined ? "" : " AND b.space_id IS @scope";
    const project = q.projectId ? " AND b.id IN (SELECT id FROM tasks WHERE project_id=@project)" : "";
    const search = q.search?.trim() ? " AND instr(lower(b.title),lower(@term))>0" : "";
    const select = (source: string) => `SELECT b.*, ${rank} AS rank,${at} AS at FROM
      ${candidates ? `ranked k CROSS JOIN ${source} b ON b.id=k.id` : `${source} b`}
      WHERE (${match}) ${visibility} ${scope} ${project} ${search}
      ${q.cursor ? `AND ((${rank})<@rank OR ((${rank})=@rank AND ((${at})<@at OR ((${at})=@at AND b.id>@id))))` : ""}`;
    const prefix = `WITH RECURSIVE ${hidden}${candidates ? ", ranked AS MATERIALIZED (" + candidates + ")" : ""}`;
    const selection = sources.map(select).join(" UNION ALL ");
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
        coalesce(i.title,w.detail,CASE WHEN b.status='failed' THEN (
          SELECT CASE WHEN type='task.failed' THEN substr(body,1,240) END FROM notifications
          WHERE task_id=b.id AND type IN ('task.failed','task.completed') ORDER BY created_at DESC LIMIT 1
        ) END) AS problem,coalesce(i.assistant_message_id,w.message) AS message,
        CASE WHEN i.id IS NULL THEN nullif(w.token,'') END AS tool,${signal} AS signal
      FROM page b LEFT JOIN conversation_interactions i ON i.id=${question}
      LEFT JOIN board_waits w ON w.rowid=(SELECT w2.rowid FROM board_waits w2 WHERE w2.id=b.id AND w2.at>=${afterDeferral} ORDER BY (w2.token=''),w2.at LIMIT 1)
      ORDER BY b.rank DESC,b.at DESC,b.id`;
    const params = {
      now,
      today: localOffset(now, 0),
      end,
      from,
      until,
      limit: size + 1,
      kind: signalKind ?? null,
      scope: q.scope ?? null,
      project: q.projectId ?? null,
      term: q.search?.trim() ?? "",
      rank: q.cursor?.rank ?? 0,
      at: q.cursor?.at ?? 0,
      id: q.cursor?.id ?? "",
    };
    const rows = this.db.prepare(sql).all(params) as SqlRow[];
    const total =
      q.preview && q.view === "attention" && rows.length > size
        ? (this.db.prepare(`${prefix} SELECT count(*) AS n FROM (${selection})`).get(params) as { n: number }).n
        : undefined;
    const page = rows.slice(0, size).map((row) => this.card(row, q.view));
    const last = page.at(-1);
    return {
      rows: page,
      total,
      next: rows.length > size && last ? { rank: last.rank, at: last.at, id: last.id } : undefined,
    };
  }

  private automation(q: BoardQuery, now: number): BoardPage {
    const size = q.preview ? 4 : 25;
    const scope = q.scope === undefined ? "" : " AND b.space_id IS @scope";
    const base = `SELECT r.id AS run_id,r.job_id,r.started_at,r.status,r.error,b.id AS task_id,b.title,b.space_id,j.name
      FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id JOIN board_native b ON b.id=r.task_id
      WHERE r.started_at>=@from ${visibility} ${scope} AND instr(lower(j.name),lower(@term))>0`;
    const source = q.jobId
      ? `SELECT *,run_id AS id,1 AS runs FROM runs WHERE job_id=@job`
      : `SELECT *,job_id AS id FROM (SELECT *,count(*) OVER(PARTITION BY job_id) AS runs,
        row_number() OVER(PARTITION BY job_id ORDER BY started_at DESC,run_id DESC) AS position FROM runs) WHERE position=1`;
    const rows = this.db
      .prepare(
        `WITH RECURSIVE ${hidden},runs AS (${base}),chosen AS (${source})
      SELECT * FROM chosen WHERE started_at<@before OR (started_at=@before AND id>@id)
      ORDER BY started_at DESC,id LIMIT @limit`,
      )
      .all({
        from: localOffset(now, -29),
        scope: q.scope ?? null,
        term: q.search?.trim() ?? "",
        job: q.jobId ?? "",
        before: q.cursor?.at ?? Number.MAX_SAFE_INTEGER,
        id: q.cursor?.id ?? "",
        limit: size + 1,
      }) as Array<{
      id: string;
      task_id: string;
      job_id: string;
      name: string;
      title: string;
      space_id: string | null;
      started_at: number;
      status: string;
      runs: number;
      error: string | null;
    }>;
    const last = rows[size - 1];
    return {
      rows: rows.slice(0, size).map((r) => ({
        id: q.jobId ? r.task_id : r.job_id,
        jobId: q.jobId ? undefined : r.job_id,
        title: q.jobId ? r.title : r.name,
        spaceId: r.space_id,
        updatedAt: r.started_at,
        at: r.started_at,
        rank: 0,
        status: r.status === "success" ? "completed" : r.status === "error" ? "failed" : "in_progress",
        reason:
          (q.jobId ? "" : `近 30 天运行 ${r.runs} 次 · `) +
          (r.error || ({ success: "运行成功", error: "运行失败" }[r.status] ?? "运行中")),
        pinned: false,
        unread: false,
        planned: false,
      })),
      next: rows.length > size ? { rank: 0, at: last.started_at, id: last.id } : undefined,
    };
  }

  private card(b: SqlRow, view: BoardQuery["view"]): TaskBoardRow {
    return {
      id: b.id,
      title: b.title,
      spaceId: b.space_id,
      status: b.status ?? "planning",
      updatedAt: b.updated_at,
      dueAt: b.due_at ?? undefined,
      startAt: b.start_at ?? undefined,
      pinned: !!b.pinned,
      unread: !!b.is_unread,
      planned: !!b.is_planned,
      laterUntil: b.later_until ?? undefined,
      rank: b.rank,
      at: b.at,
      messageId: b.message ?? undefined,
      interactionId: b.question_id ?? undefined,
      toolCallId: b.tool ?? undefined,
      reason: view === "frequent" ? `近 14 天主动关注了 ${b.rank} 天` : b.signal || b.problem || undefined,
      resultSinceFollow:
        view === "recent" && b.latest_result != null && b.latest_result > b.at && (b.ack ?? 0) < b.latest_result
          ? b.latest_result
          : undefined,
      request: b.request_data
        ? {
            ...JSON.parse(b.request_data),
            id: b.id,
            title: b.title,
            spaceId: b.space_id,
            updatedAt: b.updated_at,
            archived: false,
          }
        : undefined,
    };
  }
}
