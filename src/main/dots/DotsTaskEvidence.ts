import type { ChatArtifactDto, ChatMessageDto, TaskHistoryDto } from "../../shared/agent-ipc";
import type { TaskDiagnosticsDto } from "../../shared/task-diagnostics";
import { diagnosticText } from "../agent/durable/DurableToolDiagnostics";

const historyPageSize = 10;
export const dotsExecutionPageSize = 8;

export function dotsTaskMessageExcerpt(text: string, limit: number) {
  return { text: text.slice(-limit), ...(text.length > limit ? { textTruncated: true as const } : {}) };
}

export function dotsTaskArtifactPreviews(artifacts?: readonly ChatArtifactDto[], keepPath = false) {
  return artifacts?.slice(-6).map(({ id, name, kind, content, language, path }) => {
    const preview = ["markdown", "code", "table"].includes(kind) ? diagnosticText(content.slice(0, 800))?.slice(0, 400) : undefined;
    return { id, name: name.slice(0, 200), kind, language, ...(keepPath && { path }), content: preview ?? "",
      ...(content.length > 400 || Boolean(content && !preview) ? { contentTruncated: true as const } : {}) };
  });
}

function historyMessage(message: ChatMessageDto) {
  return {
    id: message.id, entryId: message.entryId, inputRequestId: message.inputRequestId,
    role: message.role, ...dotsTaskMessageExcerpt(message.text, 1800), createdAt: message.createdAt,
    artifacts: dotsTaskArtifactPreviews(message.artifacts),
    attachments: message.attachments?.slice(0, 4).map(file => ({ name: file.name.slice(0, 200) })),
    tools: message.tools?.slice(-3).map(tool => ({
      callId: tool.id, name: tool.tool, status: tool.status,
      summary: diagnosticText(tool.summary.slice(0, 500))?.slice(0, 250), output: diagnosticText(tool.output?.slice(0, 1200))?.slice(0, 600),
    })),
  };
}

export function dotsTaskHistoryPage(history: TaskHistoryDto) {
  const messages = history.messages.slice(-historyPageSize);
  const historyId = history.page?.historyId ?? history.durable?.historyId;
  // The native cursor is inclusive. When trimming a native window, resume immediately before its oldest visible row.
  const first = Number(messages[0]?.entryId);
  const nextBeforeEntryId = !historyId ? undefined
    : history.messages.length > messages.length && Number.isSafeInteger(first) && first > 1
      ? first - 1 : history.page ? history.page.before : history.durable?.historyBefore;
  return { messages: messages.map(historyMessage), artifacts: dotsTaskArtifactPreviews(history.artifacts), historyPage: { historyId, nextBeforeEntryId } };
}

export function dotsTaskExecutionDiagnostics(history: TaskHistoryDto, observations: TaskDiagnosticsDto, expanded: boolean) {
  const output = new Map(history.messages.flatMap(message => (message.tools ?? [])
    .filter(tool => tool.output).map(tool => [tool.id, tool.output!] as const)));
  const toolRows = expanded ? observations.tools : observations.tools.filter(tool => tool.status !== "completed");
  const tools = toolRows.slice(0, expanded ? dotsExecutionPageSize : 5).map(tool => {
    const excerpt = diagnosticText(output.get(tool.callId)?.slice(-800));
    return { callId: tool.callId, executionId: tool.executionId, name: tool.name, status: tool.status,
      startedAt: tool.startedAt, finishedAt: tool.finishedAt,
      diagnostics: tool.diagnostics.slice(0, 4).flatMap(message => diagnosticText(message)?.slice(0, 360) ?? []),
      ...(tool.status === "failed" || tool.status === "interrupted" ? { errorOutput: excerpt } : {}),
      ...(expanded && tool.status === "completed" ? { output: excerpt } : {}),
    };
  });
  const requests = observations.requests.slice(0, expanded ? dotsExecutionPageSize : 5).map(request => ({
    id: request.id, executionId: request.executionId, source: request.sourceKind, provider: request.provider,
    model: request.model, status: request.status, outcome: request.outcome,
    startedAt: request.startedAt, finishedAt: request.finishedAt, httpStatus: request.attempts.at(-1)?.httpStatus,
    error: diagnosticText(request.error)?.slice(0, 600),
  }));
  const waits = observations.waits.slice(0, expanded ? dotsExecutionPageSize : 5).map(wait => ({
    id: wait.id, executionId: wait.executionId, status: wait.status, startedAt: wait.startedAt, finishedAt: wait.finishedAt,
    title: diagnosticText(wait.title)?.slice(0, 240),
  }));
  return { requests, tools, waits, unavailable: observations.unavailable, truncated: observations.truncated,
    nextOffset: expanded && observations.truncated ? observations.offset + dotsExecutionPageSize : undefined };
}
