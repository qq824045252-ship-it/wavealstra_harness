import { searchReportFromDetails, searchReportSummary } from "../../shared/web-search";
import { consultReportFromDetails, consultSummary } from "../../shared/multi-model-consult";
import { summarizeToolInput } from "../../shared/pi-event-mapper";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type {
  ChatArtifactDto,
  ChatMessageDto,
  ChatToolCallDto,
  TaskHistoryDto,
} from "../../shared/agent-ipc";
import { parseUserPrompt } from "./parse-user-prompt";
import { openSessionForHistory } from "./SessionFileRecovery";
import { legacyMemoryDisplayCorrections } from "./LegacyMemoryHistoryHygiene";

export { parseUserPrompt } from "./parse-user-prompt";

function toolFromPart(part: Record<string, unknown>): ChatToolCallDto | null {
  if (part.type !== "toolCall" || typeof part.name !== "string") return null;
  const args = (part.arguments && typeof part.arguments === "object"
    ? part.arguments
    : {}) as Record<string, unknown>;
  const tool = part.name;
  const id = typeof part.id === "string" ? part.id : `hist-tool-${tool}-${Date.now()}`;
  const { summary, detail } = summarizeToolInput(tool, args);
  return { id, tool, summary, detail, status: "success" };
}

function artifactFromToolCall(
  part: Record<string, unknown>,
  cwd: string,
  messageIndex: number,
  timestamp: number,
): ChatArtifactDto | null {
  if (part.type !== "toolCall" || (part.name !== "write" && part.name !== "edit")) return null;
  const args = (part.arguments && typeof part.arguments === "object"
    ? part.arguments
    : {}) as Record<string, unknown>;
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) return null;
  const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const name = basename(filePath);
  const ext = extname(name).slice(1).toLowerCase();
  let content = typeof args.content === "string" ? args.content : "";
  if (!content && existsSync(filePath)) {
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      content = "";
    }
  }
  return {
    id: `hist-art-${messageIndex}-${timestamp}-${name}`,
    name,
    kind: ext === "html" || ext === "htm" ? "html" : ext === "md" ? "markdown" : "code",
    content,
    language: ext || undefined,
    // 供 renderer 与 Artifact Domain 按 path/name 对账（hist-art 伪 id 不能直接用）
    path: filePath,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string; thinking?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "thinking" && typeof p.thinking === "string") return p.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 从 pi session jsonl 还原 UI 聊天消息（简化：用户文本 + 助手最终文本）。
 *
 * 对话分支契约（实施规划 §7.1/§7.3）：
 * - `cwdOverride`：child 分支会话必须用 child canonical cwd 解析会话内所有
 *   相对路径（artifact/tool），不能用 Pi header 里的旧 cwd（§7.3 评审裁决）；
 * - 每条 user/assistant 消息透传真实 Pi entry id（`ChatMessageDto.entryId`），
 *   作为 Renderer 唯一可信的分支锚点；UI 序号可能因 parseUserPrompt 过滤而偏移，
 *   不能作为定位锚点。
 *
 * UI 沿 Pi getBranch() 恢复完整当前分支，保留真实 entry id。
 * 模型仍使用 compaction-aware projection；压缩不删除用户可见历史。
 * 其它分支和非 message 记录不会变成聊天气泡。
 */
export function loadTaskHistoryFromSession(
  sessionFile: string,
  cwdOverride?: string,
): TaskHistoryDto {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { messages: [], sessionFile };
  }

  const opened = openSessionForHistory(sessionFile, cwdOverride);
  const sm = opened.manager;
  try {
  const ctx = sm.buildSessionContext();
  const cwd = sm.getCwd();
  const messages: ChatMessageDto[] = [];
  let activeAssistantIndex: number | null = null;
  let pendingArtifacts: ChatArtifactDto[] = [];
  let pendingTools: ChatToolCallDto[] = [];
  const toolsById = new Map<string, ChatToolCallDto>();
  let turnStartedAt: number | null = null;
  /** 最近处理的 message entry id（flush 纯工具回合时兜底） */
  let lastMessageEntryId: string | undefined;

  const mergeArtifacts = (
    current: ChatArtifactDto[] | undefined,
    incoming: ChatArtifactDto[],
  ): ChatArtifactDto[] => {
    const byName = new Map((current ?? []).map((artifact) => [artifact.name, artifact]));
    for (const artifact of incoming) byName.set(artifact.name, artifact);
    return [...byName.values()];
  };

  const mergeTools = (
    current: ChatToolCallDto[] | undefined,
    incoming: ChatToolCallDto[],
  ): ChatToolCallDto[] => {
    const byId = new Map((current ?? []).map((tool) => [tool.id, tool]));
    for (const tool of incoming) byId.set(tool.id, tool);
    return [...byId.values()];
  };

  const flushPendingAssistant = (timestamp: number): void => {
    if (!pendingArtifacts.length && !pendingTools.length) return;
    messages.push({
      id: `hist-asst-${messages.length}-${timestamp}`,
      role: "assistant",
      text: "",
      createdAt: timestamp,
      durationMs:
        turnStartedAt !== null ? Math.max(0, timestamp - turnStartedAt) : undefined,
      artifacts: pendingArtifacts.length ? pendingArtifacts : undefined,
      tools: pendingTools.length ? pendingTools : undefined,
      entryId: lastMessageEntryId,
    });
    activeAssistantIndex = messages.length - 1;
    pendingArtifacts = [];
    pendingTools = [];
  };

  const legacyCorrections = legacyMemoryDisplayCorrections(sm);
  for (const entry of sm.getBranch()) {
    if (entry.type !== "message") continue;
    // The complete branch preserves original tool output for UI/artifacts. Only
    // proven legacy Memory tails use the separately audited display correction.
    const correction = legacyCorrections.get(entry.id);
    const msg = (correction === undefined ? entry.message : { ...entry.message, content: correction }) as { role?: string; content?: unknown; timestamp?: number };
    const role = msg.role;
    const ts =
      typeof msg.timestamp === "number"
        ? msg.timestamp
        : Date.parse(entry.timestamp) || Date.now();
    const entryId = entry.id;
    lastMessageEntryId = entryId;

    if (role === "user") {
      flushPendingAssistant(ts);
      const parsed = parseUserPrompt(textFromContent(msg.content));
      if (!parsed.text && !parsed.attachments?.length && !parsed.taskReferences?.length) continue;
      messages.push({
        id: `hist-user-${messages.length}-${ts}`,
        role: "user",
        text: parsed.text || "请结合已应用任务继续",
        selectionLabels: parsed.selectionLabels,
        attachments: parsed.attachments,
        taskReferences: parsed.taskReferences,
        createdAt: ts,
        entryId,
      });
      activeAssistantIndex = null;
      pendingArtifacts = [];
      pendingTools = [];
      turnStartedAt = ts;
      continue;
    }

    if (role === "toolResult") {
      const toolResult = msg as {
        toolCallId?: string;
        isError?: boolean;
        content?: unknown;
        details?: unknown;
        nestedCalls?: { calls?: unknown[]; complete?: boolean };
      };
      if (toolResult.toolCallId) {
        const tool = toolsById.get(toolResult.toolCallId);
        if (tool) {
          tool.status = toolResult.isError ? "error" : "success";
          const output = textFromContent(toolResult.content).trim();
          const consult = tool.tool === "multi_model_consult" ? consultReportFromDetails(toolResult.details) : undefined;
          if (consult) { tool.consult = consult; tool.summary = consultSummary(consult); }
          const webSearch = searchReportFromDetails(toolResult.details);
          if (webSearch) { tool.webSearch = webSearch; tool.summary = searchReportSummary(webSearch); }
          if (output) tool.output = consult ? output : output.slice(0, 4000);
          // Pi persists child calls on the parent's toolResult, not as independent messages.
          // Restore their identity without inventing unavailable full intermediate results.
          const children: ChatToolCallDto[] = [];
          for (const item of toolResult.nestedCalls?.calls ?? []) {
            if (!item || typeof item !== 'object') continue;
            const child = item as { id?: unknown; name?: unknown; status?: unknown; arguments?: unknown; error?: unknown };
            if (typeof child.id !== 'string' || typeof child.name !== 'string' || toolsById.has(child.id)) continue;
            let detail: string | undefined;
            try { detail = JSON.stringify(child.arguments ?? {}, null, 2); } catch { /* invalid historical payload */ }
            const restored: ChatToolCallDto = {
              id: child.id, parentToolCallId: tool.id, tool: child.name,
              summary: child.name + (detail ? ': ' + detail.replace(/\s+/g, ' ').slice(0, 100) : ''),
              detail, status: child.status === 'ok' ? 'success' : 'error',
              output: typeof child.error === 'string' ? child.error : child.status === 'cancelled' ? '已取消' : undefined,
            };
            toolsById.set(restored.id, restored); children.push(restored);
          }
          if (children.length) {
            const owner = [...messages].reverse().find(message => message.tools?.some(candidate => candidate.id === tool.id));
            if (owner) owner.tools = mergeTools(owner.tools, children);
            else pendingTools = mergeTools(pendingTools, children);
          }
          if (toolResult.nestedCalls?.complete === false) {
            tool.output = (tool.output ?? '') + '\n[Pi 保存的子调用记录不完整，不能据此视为全部执行记录。]';
          }
        }
      }
      continue;
    }

    if (role === "assistant") {
      const content = msg.content;
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const artifacts: ChatArtifactDto[] = [];
      const tools: ChatToolCallDto[] = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as { type?: string; text?: string; thinking?: string };
          if (p.type === "text" && p.text) textParts.push(p.text);
          if (p.type === "thinking" && p.thinking) thinkingParts.push(p.thinking);
          const artifact = artifactFromToolCall(
            part as Record<string, unknown>,
            cwd,
            messages.length,
            ts,
          );
          if (artifact) artifacts.push(artifact);
          const tool = toolFromPart(part as Record<string, unknown>);
          if (tool) {
            tools.push(tool);
            toolsById.set(tool.id, tool);
          }
        }
      } else if (typeof content === "string") {
        textParts.push(content);
      }
      const failure = msg as { stopReason?: string; errorMessage?: string };
      if (failure.stopReason === "error") textParts.push(`错误：${failure.errorMessage || "模型连接或生成失败，请重试。"}`);
      const text = textParts.join("\n").trim();
      const thinking = thinkingParts.join("\n").trim();

      // write/edit 往往以纯 toolCall assistant 消息存在，没有正文或 thinking。
      // 不能因此丢掉产物：已有助手回合时直接挂载，否则留给下一条正文消息。
      if (!text && !thinking) {
        if ((artifacts.length || tools.length) && activeAssistantIndex !== null) {
          const current = messages[activeAssistantIndex];
          current.artifacts = mergeArtifacts(current.artifacts, artifacts);
          current.tools = mergeTools(current.tools, tools);
          if (turnStartedAt !== null) current.durationMs = Math.max(0, ts - turnStartedAt);
        } else if (artifacts.length || tools.length) {
          pendingArtifacts = mergeArtifacts(pendingArtifacts, artifacts);
          pendingTools = mergeTools(pendingTools, tools);
        }
        continue;
      }
      const modelName = (msg as { model?: string }).model;
      const messageArtifacts = mergeArtifacts(pendingArtifacts, artifacts);
      const messageTools = mergeTools(pendingTools, tools);
      pendingArtifacts = [];
      pendingTools = [];

      // pi 会在一次用户提问中产生多条 assistant 消息（思考 → 工具 → 继续
      // 思考 → 最终答复）。UI 应将它们还原为一个助手回合，而不是重复头像、
      // “已完成”和操作栏。每次出现新的 assistant 正文时，把上一段正文归入
      // 工作过程，只保留最后一段作为最终答复。
      if (activeAssistantIndex !== null) {
        const current = messages[activeAssistantIndex];
        const processParts = [current.thinking];
        if (text && current.text) processParts.push(current.text);
        if (thinking) processParts.push(thinking);
        current.thinking = processParts.filter(Boolean).join("\n\n") || undefined;
        if (text) current.text = text;
        if (modelName) current.modelName = modelName;
        if (turnStartedAt !== null) current.durationMs = Math.max(0, ts - turnStartedAt);
        if (messageArtifacts.length) {
          current.artifacts = mergeArtifacts(current.artifacts, messageArtifacts);
        }
        if (messageTools.length) current.tools = mergeTools(current.tools, messageTools);
        // 回合 LIFO：最后一段正文的 entry 即回头合并后整个回合的锚点
        current.entryId = entryId;
      } else {
        messages.push({
          id: `hist-asst-${messages.length}-${ts}`,
          role: "assistant",
          text,
          thinking: thinking || undefined,
          modelName,
          createdAt: ts,
          durationMs: turnStartedAt !== null ? Math.max(0, ts - turnStartedAt) : undefined,
          artifacts: messageArtifacts.length ? messageArtifacts : undefined,
          tools: messageTools.length ? messageTools : undefined,
          entryId,
        });
        activeAssistantIndex = messages.length - 1;
      }
    }
  }

  flushPendingAssistant(Date.now());

  return {
    messages,
    // Even when a temporary read-only recovery copy was used, never persist that
    // ephemeral path back into the Task. The original JSONL remains authoritative.
    sessionFile,
    cwd,
    sessionRecovery: opened.recovery,
  };
  } finally {
    opened.cleanup();
  }
}
