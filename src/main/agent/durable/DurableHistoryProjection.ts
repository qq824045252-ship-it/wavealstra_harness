import { basename } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord, TaskId } from "@earendil-works/pi-durable";
import type { ChatMessageDto } from "../../../shared/agent-ipc";
import { summarizeToolInput } from "../../../shared/pi-event-mapper";
import type { DurableBotSnapshot } from "../../../shared/durable-bot";

export type DurableInputMetadata = { text: string; displayText: string; attachments: Array<{ name: string; path: string }>; botRequestId?: string; audit?: import("./DurableSkillProjection").DurableInputAudit };
/** 完成态实测速度（由 `DurableBotRuntime.recordResponse()` 用 host 侧生成计时算出）。 */
export type DurableResponseSpeed = { readonly tps?: number | null; readonly ttftMs?: number | null };
type ToolRow = NonNullable<ChatMessageDto["tools"]>[number];
type ToolResult = Extract<Message, { role: "toolResult" }>;
export type InterruptedNested = { ownerId: string; message: ToolResult; toolTaskId: TaskId };
export const DURABLE_HISTORY_ENTRY_LIMIT = 200;

export function durableContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => part.text).join("");
}

/** Immutable entries are converted once. A result replaces only its owning assistant row. */
export class DurableHistoryProjection {
  private readonly entries = new Map<number, EntryRecord>();
  private readonly rows = new Map<string, ChatMessageDto>();
  private readonly owners = new Map<string, string>();
  private readonly presentationRows = new Map<string, string>();
  private readonly rowIndices = new Map<string, number>();
  private readonly results = new Map<string, ToolResult>();
  private ordered: ChatMessageDto[] = [];
  private dirty = false;
  private latestStatusEntry = 0;
  private latestInputEntry = 0;
  private newestEntry?: number;
  private oldestEntry?: number;
  readonly children = new Map<string, number>();
  readonly interrupted: InterruptedNested[] = [];
  error?: string;
  outcome?: DurableBotSnapshot["outcome"];
  turnStartedAt?: number;

  get newest(): number | undefined { return this.newestEntry; }
  get oldest(): number | undefined { return this.oldestEntry; }
  has(entryId: number): boolean { return this.entries.has(entryId); }
  ownerId(callId: string): string | undefined { return this.owners.get(callId); }
  row(id: string): ChatMessageDto | undefined { return this.rows.get(id); }
  presentationId(key: string): string | undefined { return this.presentationRows.get(key); }
  index(id: string): number | undefined { return this.rowIndices.get(id); }
  get messages(): ChatMessageDto[] {
    if (this.dirty) {
      this.ordered = [...this.rows.values()].sort((a, b) => Number(a.id.slice(8)) - Number(b.id.slice(8)));
      this.rowIndices.clear();
      this.ordered.forEach((row, index) => this.rowIndices.set(row.id, index));
      this.dirty = false;
    }
    return this.ordered;
  }

  /** Keep the current window and active tool owners; persisted entries remain pageable. */
  trim(activeCallIds: ReadonlySet<string> = new Set()): number | undefined {
    if (this.entries.size <= DURABLE_HISTORY_ENTRY_LIMIT) return;
    const ids = [...this.entries.keys()].sort((a, b) => b - a);
    const keep = new Set(ids.slice(0, DURABLE_HISTORY_ENTRY_LIMIT));
    for (const call of activeCallIds) {
      const owner = this.owners.get(call);
      if (owner) keep.add(Number(owner.slice(8)));
    }
    let before: number | undefined;
    for (const id of ids) if (!keep.has(id)) {
      this.entries.delete(id); this.rows.delete(`durable-${id}`);
      before = Math.max(before ?? id, id); this.dirty = true;
    }
    for (const [call, owner] of this.owners) if (!this.rows.has(owner)) {
      this.owners.delete(call); this.children.delete(call);
    }
    for (const call of this.results.keys()) if (!this.owners.has(call)) this.results.delete(call);
    for (const [key, id] of this.presentationRows) if (!this.rows.has(id)) this.presentationRows.delete(key);
    this.oldestEntry = this.entries.size ? Math.min(...this.entries.keys()) : undefined;
    return before;
  }

  /** `timing` 是 `${taskId}:${timestamp}` → completedAt；`speed` 是同一 key → 完成态实测速度。 */
  merge(entries: readonly EntryRecord[], metadata: ReadonlyMap<number, DurableInputMetadata>, timing: Readonly<Record<string, number>>,
    speed: Readonly<Record<string, DurableResponseSpeed>> = {}): EntryRecord[] {
    const fresh = entries.filter(entry => !this.entries.has(entry.id)).sort((a, b) => a.id - b.id);
    for (const entry of fresh) {
      this.entries.set(entry.id, entry);
      this.newestEntry = Math.max(this.newestEntry ?? entry.id, entry.id);
      this.oldestEntry = Math.min(this.oldestEntry ?? entry.id, entry.id);
      const id = `durable-${entry.id}`;
      for (const message of entry.model ?? []) {
        if (message.role === "user" && (entry.kind === "pi.user" || entry.kind === "mybuddy.user")) {
          const input = metadata.get(entry.id);
          this.rows.set(id, { id, projectionVersion: 1, entryId: String(entry.id), role: "user", botRequestId: input?.botRequestId, text: input?.displayText ?? durableContentText(message.content), attachments: input?.attachments, createdAt: message.timestamp });
          this.dirty = true;
          if (entry.id >= this.latestInputEntry) { this.latestInputEntry = entry.id; this.turnStartedAt = message.timestamp; }
          if (entry.id >= this.latestStatusEntry) { this.latestStatusEntry = entry.id; this.outcome = undefined; this.error = undefined; }
        } else if (message.role === "assistant") {
          const user = [...this.entries.values()].filter(item => item.id <= entry.id && (item.kind === "pi.user" || item.kind === "mybuddy.user")).sort((a, b) => b.id - a.id)[0];
          const startedAt = user?.model?.find(item => item.role === "user")?.timestamp ?? message.timestamp;
          const key = `${entry.byTaskId}:${message.timestamp}`;
          const row = assistantRow(id, entry.byTaskId, message, timing[key], startedAt, false, speed[key]);
          this.rows.set(id, row); this.dirty = true;
          if (row.presentationKey) this.presentationRows.set(row.presentationKey, id);
          for (const tool of row.tools ?? []) {
            this.owners.set(tool.id, id);
            const result = this.results.get(tool.id);
            if (result) this.applyResult(result);
          }
          if (entry.id >= this.latestStatusEntry) {
            this.latestStatusEntry = entry.id;
            this.error = message.stopReason === "error" ? message.errorMessage : undefined;
            this.outcome = message.stopReason === "stop" ? "completed" : message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" || message.stopReason === "length" ? "failed" : undefined;
          }
        } else if (message.role === "toolResult") {
          this.results.set(message.toolCallId, message);
          this.applyResult(message);
          const ownerId = this.owners.get(message.toolCallId);
          if (ownerId && message.toolName === "codemode" && message.isError && !resultDetails(message)?.calls?.length && entry.byTaskId !== undefined) {
            this.interrupted.push({ ownerId, message, toolTaskId: entry.byTaskId });
          }
        }
      }
    }
    return fresh;
  }

  replace(row: ChatMessageDto): ChatMessageDto {
    const next = { ...row, projectionVersion: (this.rows.get(row.id)?.projectionVersion ?? 0) + 1 };
    this.rows.set(row.id, next);
    this.dirty = true;
    return next;
  }

  private applyResult(message: ToolResult): void {
    const ownerId = this.owners.get(message.toolCallId);
    const owner = ownerId && this.rows.get(ownerId);
    if (!owner) return;
    const details = resultDetails(message);
    const calls = (details?.calls ?? []).map((call, index) => nestedToolRow(message.toolCallId, call, index));
    const tools = (owner.tools ?? []).map(tool => tool.id === message.toolCallId
      ? { ...tool, status: message.isError ? "error" as const : "success" as const, output: durableContentText(message.content), detail: message.details === undefined ? tool.detail : JSON.stringify(message.details) } : tool);
    for (const call of calls) if (!tools.some(tool => tool.id === call.id)) tools.push(call);
    if (details?.conversationId && message.toolName === "codemode") this.children.set(message.toolCallId, details.conversationId);
    const artifacts = details?.imagePaths?.map(path => ({ id: `${message.toolCallId}:${path}`, name: basename(path), kind: "image" as const, path, content: "" }));
    this.replace({ ...owner, tools, ...(artifacts?.length ? { artifacts: [...owner.artifacts ?? [], ...artifacts.filter(artifact => !owner.artifacts?.some(item => item.id === artifact.id))] } : {}) });
  }
}

/**
 * 一条 assistant 回复的 DTO。
 * `metrics` 只在完成态生效：`tps` / `ttftMs` 来自 host 侧实测（持久化在 `mybuddy.response-timing`），
 * 历史重载时如果那次调用没有被观测到计时，就是 null —— 不拿 0 冒充。
 * 流式行由 runtime 用实时估算覆盖，这里保持 tps=null。
 */
export function assistantRow(id: string, taskId: TaskId | undefined, message: AssistantMessage, completedAt?: number, startedAt = message.timestamp,
  streaming = false, metrics?: DurableResponseSpeed): ChatMessageDto {
  return { id, ...(!streaming ? { entryId: id.slice(8), projectionVersion: 1 } : {}), role: "assistant", presentationKey: taskId ? `durable-generation-${taskId}${message.stopReason === "aborted" ? `-${id.slice(8)}` : ""}` : id,
    durationMs: completedAt !== undefined ? Math.max(0, completedAt - startedAt) : undefined,
    generationStats: { phase: streaming ? "generating" : "complete", startedAt, updatedAt: completedAt ?? message.timestamp,
      tps: streaming ? null : validSpeed(metrics?.tps), estimated: false, outputTokens: message.usage.output,
      ttftMs: streaming ? null : validDuration(metrics?.ttftMs),
      ...(!streaming ? { outcome: message.stopReason === "aborted" ? "aborted" as const : message.stopReason === "error" || message.stopReason === "length" ? "error" as const : "completed" as const } : {}) },
    text: durableContentText(message.content) + (message.errorMessage ? `\n${message.errorMessage}` : ""),
    thinking: message.content.filter(item => item.type === "thinking").map(item => item.thinking).join(""),
    tools: message.content.filter(item => item.type === "toolCall").map(call => {
      const text = summarizeToolInput(call.name, call.arguments);
      return { id: call.id, tool: call.name, summary: text.summary, ...(text.detail === undefined ? {} : { detail: text.detail }), status: "running" as const };
    }),
    modelName: message.model, createdAt: message.timestamp, streaming,
  };
}

/** 持久化/外部时间数据不可信：非正、非有限的速度一律折算成 null（界面据此显示「已完成」而不是 NaN）。 */
function validSpeed(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 时长同理：负值（时钟回拨）与 NaN 都不进 UI。 */
function validDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export type NestedCallDetail = { readonly id?: string | number; readonly name: string; readonly args?: unknown; readonly status?: string; readonly output?: string; readonly durationMs?: number; readonly error?: string };
export function nestedToolRow(parentCallId: string, call: NestedCallDetail, index: number): ToolRow {
  // 嵌套调用的 args 可能是字符串（已成形文本）或对象；字符串保持原样，对象走统一摘要。
  const text = summarizeToolInput(call.name, call.args);
  return { id: typeof call.id === "number" ? `${parentCallId}/c${call.id}` : `${parentCallId}:nested:${call.id ?? String(index)}`, parentToolCallId: parentCallId, tool: call.name,
    summary: typeof call.args === "string" ? call.args : text.summary,
    ...(typeof call.args === "string" || text.detail === undefined ? {} : { detail: text.detail }),
    status: call.status === "error" ? "error" : call.status === "running" || call.status === "pending" ? "running" : "success", output: call.output ?? call.error ?? "" };
}
function resultDetails(message: ToolResult): { conversationId?: number; imagePaths?: string[]; calls?: readonly NestedCallDetail[] } | undefined {
  return message.details as { conversationId?: number; imagePaths?: string[]; calls?: readonly NestedCallDetail[] } | undefined;
}
