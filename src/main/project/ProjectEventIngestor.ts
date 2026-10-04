/**
 * ProjectEventIngestor — 项目外部输入入口层（source / ingestion / event contract）。
 *
 * 背景：Autopilot 内部闭环（snapshot → attention → proposals → cadence）已完整，但外部输入
 * （IM/Gateway、会议纪要、文档、MCP 事件等）没有统一入口——此前唯一落点是手动 posts。
 * 本模块提供通用事件契约：任意来源以 {source, kind, title, body?, ref?, payload?} 投递，
 * 落库为可追溯的项目事件（审计/输入层，非业务真源；plan/todo/task/memory 真源不变）。
 *
 * 约束：
 * - 事件不参与派生计算（snapshot/attention/proposal 不从事件取数）；ingest 后仅触发
 *   既有收敛（onIngested 注入：attention 重算广播 + 活动流刷新），绝不后台执行/apply；
 * - source/kind 白名单（防自由文本污染契约）；title/body/payload 有界；
 * - archived 项目拒绝新增事件（归档 = 服务层只读）；A/B 按 projectId 隔离；
 * - 来源适配器（当前：gateway）通过同一 ingest 入口接入；ERP 等外部系统后续同契约扩展。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ARCHIVED_PROJECT_WRITE_GUIDANCE,
  PROJECT_EVENT_LIST_MAX_LIMIT,
  PROJECT_EVENT_RETENTION_PER_PROJECT,
  type ProjectEventCreateRequest,
  type ProjectEventDto,
  type ProjectEventKind,
  type ProjectEventSource,
} from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";

export const PROJECT_EVENT_SOURCES: readonly ProjectEventSource[] = [
  "gateway",
  "cron",
  "manual",
  "document",
  "mcp",
];
export const PROJECT_EVENT_KINDS: readonly ProjectEventKind[] = [
  "message",
  "note",
  "run",
  "reminder",
  "update",
];
export const PROJECT_EVENT_TITLE_MAX_CHARS = 200;
export const PROJECT_EVENT_BODY_MAX_CHARS = 4000;
export const PROJECT_EVENT_REF_MAX_CHARS = 200;
export const PROJECT_EVENT_PAYLOAD_MAX_BYTES = 4096;
export const PROJECT_EVENT_LIST_DEFAULT_LIMIT = 50;

export interface ProjectEventIngestorOptions {
  /** ingest 成功后的收敛回调（调用方注入：attention 重算广播等；绝不 apply） */
  onIngested?: (projectId: string, event: ProjectEventDto) => void;
  now?: () => number;
}

export function isProjectEventSource(value: unknown): value is ProjectEventSource {
  return typeof value === "string" && (PROJECT_EVENT_SOURCES as readonly string[]).includes(value);
}

export function isProjectEventKind(value: unknown): value is ProjectEventKind {
  return typeof value === "string" && (PROJECT_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * 解析 IM 消息中的项目投递指令：`@项目 <名称>：内容`（或 `@项目 <名称>` 无内容 = 打卡/ping）。
 * 名称取首个全角/半角冒号前；内容取冒号后（保留换行）。无前缀 → null（不改写原消息流）。
 */
export function parseProjectMessageDirective(text: string): { projectName: string; content: string } | null {
  const trimmed = text.trim();
  const prefix = "@项目";
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) return null;
  const colon = rest.search(/[：:]/);
  if (colon === -1) return { projectName: rest, content: "" };
  const name = rest.slice(0, colon).trim();
  if (!name) return null;
  return { projectName: name, content: rest.slice(colon + 1).trim() };
}

/**
 * Cron run 摘要 → 事件契约输入（第二真实 source adapter 的纯翻译层）。
 * 只记录完成/失败摘要 + stable ref（runId）；有界截断，绝不把完整敏感输出无界写入。
 */
export function cronRunEventInput(summary: {
  runId: string;
  jobName: string;
  status: "success" | "failed";
  error?: string;
}): ProjectEventCreateRequest {
  const jobName = summary.jobName.trim().slice(0, PROJECT_EVENT_TITLE_MAX_CHARS - 20) || "定时任务";
  const title = `定时任务「${jobName}」${summary.status === "success" ? "完成" : "失败"}`.slice(0, PROJECT_EVENT_TITLE_MAX_CHARS);
  const body =
    summary.status === "failed" && summary.error?.trim()
      ? summary.error.trim().slice(0, PROJECT_EVENT_BODY_MAX_CHARS)
      : undefined;
  return { source: "cron", kind: "run", title, body, ref: summary.runId };
}

export class ProjectEventIngestor {
  private readonly now: () => number;

  constructor(
    private readonly projects: ProjectService,
    private readonly opts: ProjectEventIngestorOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 通用 ingest 入口：校验（项目存在/来源与类型白名单/长度与载荷有界）→ 落库 → onIngested。
   * 抛错表示契约违规（调用方应捕获并降级，不影响原业务流）。
   */
  ingest(projectId: string, request: ProjectEventCreateRequest): ProjectEventDto {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (!isProjectEventSource(request.source)) {
      throw new Error(`事件来源非法：${String(request.source)}`);
    }
    if (!isProjectEventKind(request.kind)) {
      throw new Error(`事件类型非法：${String(request.kind)}`);
    }
    const title = request.title.trim();
    if (!title) throw new Error("事件标题不能为空");
    if (title.length > PROJECT_EVENT_TITLE_MAX_CHARS) {
      throw new Error(`事件标题不能超过 ${PROJECT_EVENT_TITLE_MAX_CHARS} 字符`);
    }
    const body = request.body?.trim();
    if (body !== undefined && body.length > PROJECT_EVENT_BODY_MAX_CHARS) {
      throw new Error(`事件正文不能超过 ${PROJECT_EVENT_BODY_MAX_CHARS} 字符`);
    }
    if (request.ref !== undefined && request.ref.length > PROJECT_EVENT_REF_MAX_CHARS) {
      throw new Error(`事件来源引用不能超过 ${PROJECT_EVENT_REF_MAX_CHARS} 字符`);
    }
    let payload: Record<string, unknown> = {};
    if (request.payload !== undefined) {
      const serialized = JSON.stringify(request.payload);
      if (Buffer.byteLength(serialized, "utf8") > PROJECT_EVENT_PAYLOAD_MAX_BYTES) {
        throw new Error(`事件载荷不能超过 ${PROJECT_EVENT_PAYLOAD_MAX_BYTES} 字节`);
      }
      payload = request.payload;
    }
    // ref 幂等：同 (project, source, ref) 已存在（如平台重试/重复回调）→ 返回既有事件，不重复落库/不重复回调
    if (request.ref?.trim()) {
      const existing = this.projects.findProjectEventByRef(projectId, request.source, request.ref.trim());
      if (existing) return existing;
    }
    const event: ProjectEventDto = {
      id: `pevt_${randomUUID()}`,
      projectId,
      source: request.source,
      kind: request.kind,
      title,
      body: body || undefined,
      ref: request.ref,
      payload,
      triageStatus: "open",
      createdAt: this.now(),
    };
    this.projects.insertProjectEvent(event);
    try {
      this.opts.onIngested?.(projectId, event);
    } catch (err) {
      console.warn(`[ProjectEventIngestor] onIngested 失败 ${projectId}：`, err);
    }
    return event;
  }

  /**
   * 文档/纪要文本 → 事件（source=document, kind=note）：第三真实 source adapter。
   * 规则：正文必填（不猜测内容含义，不自动总结）；title/body/ref 走 ingest() 全部有界校验（超限拒绝而非截断）；
   * ref 缺省 = sha256(title\0body) 内容哈希 → 同文重复导入幂等（不堆事件）；显式 ref 则以其为准（平台文档 id 等）。
   * 归档项目拒绝追加（归档 = 服务层只读）；不触发 promotion，不写任何业务真源。
   */
  ingestDocument(projectId: string, input: { title: string; body: string; ref?: string }): ProjectEventDto {
    const title = input.title?.trim() ?? "";
    const body = input.body?.trim() ?? "";
    if (!title) throw new Error("文档标题不能为空");
    if (!body) throw new Error("文档正文不能为空");
    const ref =
      input.ref?.trim() ||
      createHash("sha256").update(title).update("\0").update(body).digest("hex");
    return this.ingest(projectId, { source: "document", kind: "note", title, body, ref });
  }

  /** 事件列表（created_at DESC；limit 有界） */
  list(projectId: string, limit = PROJECT_EVENT_LIST_DEFAULT_LIMIT): ProjectEventDto[] {
    const clamped = Math.max(1, Math.min(limit, PROJECT_EVENT_LIST_MAX_LIMIT));
    return this.projects.listProjectEvents(projectId, clamped);
  }
}
