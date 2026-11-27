import { z } from "zod";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import {
  boardLanes,
  boardViews,
  type BoardAction,
  type BoardPage,
  type BoardQuery,
  type TaskBoardRow,
} from "../../shared/task-board";
import type { RuntimeAuditReader, RuntimeTaskBoardPage, RuntimeTaskBoardQuery } from "../platform/runtime-audit";
import { TaskWriteQueue } from "../db/TaskWriteQueue";

const querySchema = z.object({
  view: z.enum(boardViews),
  lane: z.enum(boardLanes).optional(),
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
const boardAction = z.enum(["visit", "read", "today", "later", "clear"]);

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
  project_id: string | null;
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
  failure: string | null;
  wait_kind: NonNullable<TaskBoardRow["wait"]>["kind"] | null;
  wait_reason: string | null;
  pending_reviews: number;
  message: string | null;
  tool: string | null;
};

type AutomationRow = {
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
};

type TaskBoardClient = Pick<RuntimeAuditReader, "taskBoard" | "writeTaskBoardAction" | "writeTaskBoardNote">;

export class TaskBoardRepository {
  private waiting = new Set<string>();
  private waits = new Map<string, RuntimeTaskBoardQuery["waits"][number]>();
  private activities = new Map<string, NonNullable<TaskBoardRow["activity"]>>();
  private readonly writes = new TaskWriteQueue();
  private readonly core: TaskBoardClient;

  constructor(source: { core: TaskBoardClient }) {
    this.core = source.core;
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }

  follow(id: string, detail: string, at = Date.now()): void {
    this.note(id, "follow", detail, at);
  }

  note(id: string, kindName: "follow" | "visit" | "read" | "result", detail = "", at = Date.now()): void {
    const trimmed = detail.trim().slice(0, 120).replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
    void this.writes.run([id], async () => {
      if (!await this.core.writeTaskBoardNote({ id, kindName, detail: trimmed, at })) {
        throw new Error("任务看板记录未获 Rust Core 确认");
      }
    }).catch(error => console.warn("[TaskBoard] 看板记录未保存", error));
  }

  action(id: string, action: BoardAction, now = Date.now()): Promise<void> {
    boardAction.parse(action);
    const laterUntil = action === "later" ? localOffset(now, 1) : null;
    return this.writes.run([id], async () => {
      if (!await this.core.writeTaskBoardAction({ id, action, now, laterUntil })) {
        throw new Error("看板操作未获 Rust Core 确认");
      }
    });
  }

  patch(patch: AgentUiPatch): void {
    if (patch.type === "tool_start" && patch.status === "pending_approval") {
      this.waits.set(`${patch.taskId}\0${patch.toolCallId}`, {
        id: patch.taskId, token: patch.toolCallId, message: patch.messageId, detail: patch.summary, at: Date.now(),
      });
    } else if (patch.type === "tool_update" && patch.status && patch.status !== "pending_approval") {
      this.waits.delete(`${patch.taskId}\0${patch.toolCallId}`);
    } else if (patch.type === "assistant_end") {
      for (const [key, entry] of this.waits) {
        if (entry.id === patch.taskId && entry.message === patch.messageId) this.waits.delete(key);
      }
      if (!patch.cancelled) this.note(patch.taskId, "result");
    } else if (patch.type === "durable_snapshot" || patch.type === "durable_delta") {
      const state = patch.type === "durable_snapshot" ? patch.snapshot : patch.delta.state;
      const inputKey = `${patch.taskId}\0`;
      if (state.status === "waiting_input" && !this.waiting.has(patch.taskId)) {
        if (!this.waits.has(inputKey)) {
          this.waits.set(inputKey, { id: patch.taskId, token: "", message: null, detail: "等待你回答", at: Date.now() });
        }
      } else if (state.status !== "waiting_input" && this.waiting.has(patch.taskId)) {
        this.waits.delete(inputKey);
      }
      if (state.status === "waiting_input") this.waiting.add(patch.taskId);
      else this.waiting.delete(patch.taskId);
      if (state.status === "retrying") {
        this.activities.set(patch.taskId, { kind: "retrying", reason: state.retry?.error.slice(0, 240) });
      } else if (state.compacting) {
        this.activities.set(patch.taskId, { kind: "compacting" });
      } else this.activities.delete(patch.taskId);
    }
  }

  async page(input: BoardQuery, now = Date.now(), ordinary?: RuntimeTaskBoardQuery["ordinary"]): Promise<BoardPage> {
    const q = querySchema.parse(input);
    const weekFrom = localOffset(now, -((new Date(now).getDay() + 6) % 7));
    const request: RuntimeTaskBoardQuery = {
      ...q,
      jobId: q.jobId || undefined,
      scope: q.scope === undefined ? undefined : { spaceId: q.scope },
      ordinary,
      calendar: { now, today: localOffset(now, 0), tomorrow: localOffset(now, 1), recentFrom: localOffset(now, -13),
        weekFrom, weekUntil: localOffset(weekFrom, 7), automationFrom: localOffset(now, -29) },
      waits: [...this.waits.values()],
    };
    if (q.view === "automation") {
      if (ordinary) throw new Error("自动化记录不属于普通任务看板");
      const result = await this.core.taskBoard<AutomationRow>(request);
      if (!result) throw new Error("自动化看板未获 Rust Core 确认");
      return this.automationPage(q, result.rows, q.preview ? 4 : 25);
    }
    const result = await this.core.taskBoard<SqlRow>(request);
    if (!result) throw new Error("任务看板未获 Rust Core 确认");
    return this.taskPage(q, result, q.preview ? 4 : q.lane ? 10 : 25);
  }

  private taskPage(q: BoardQuery, { rows, total }: RuntimeTaskBoardPage<SqlRow>, size: number): BoardPage {
    const page = rows.slice(0, size).map((row) => this.card(row, q.view));
    const last = page.at(-1);
    return {
      rows: page,
      total,
      next: rows.length > size && last ? { rank: last.rank, at: last.at, id: last.id } : undefined,
    };
  }

  private automationPage(q: BoardQuery, rows: AutomationRow[], size: number): BoardPage {
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
      ...(b.project_id && { projectId: b.project_id }),
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
      wait: b.wait_kind ? { kind: b.wait_kind, reason: b.wait_reason?.trim() || undefined } : undefined,
      activity: b.status === "in_progress" ? this.activities.get(b.id) : undefined,
      reason: view === "frequent" ? `近 14 天主动关注了 ${b.rank} 天` : b.signal || undefined,
      failureReason: b.failure ?? undefined,
      pendingReviewCount: b.pending_reviews || undefined,
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
