import type { ChatMessageDto, ChatToolCallDto } from "../../../shared/agent-ipc";

const presentedTools = new Set(["web_search", "fetch_content", "ocr_file", "speech_to_text", "text_to_speech",
  "deepseek_web_search", "deepseek_read_url", "deepseek_file_upload", "multi_model_consult"]);

/** Keep the request's real result cards; unrelated internal tools remain a compact activity line. */
export function botCapabilityTools(rows: readonly ChatMessageDto[]): ChatToolCallDto[] {
  const tools = new Map<string, ChatToolCallDto>();
  for (const row of rows) for (const tool of row.tools ?? []) {
    if (presentedTools.has(tool.tool)) tools.set(tool.id, tool);
  }
  return [...tools.values()];
}

export function botRequestCapabilityTools(rows: readonly ChatMessageDto[], requestId: string): ChatToolCallDto[] | undefined {
  let lastUser = rows.length - 1;
  while (lastUser >= 0 && rows[lastUser].role !== "user") lastUser--;
  if (lastUser < 0 || rows[lastUser].botRequestId !== requestId) return undefined;
  return botCapabilityTools(rows.slice(lastUser + 1));
}

/** A terminal bubble cannot leave a tool spinner running after cancellation/restart. */
export function settleBotCapabilityTools(tools: ChatToolCallDto[], status: string): ChatToolCallDto[] {
  if (status === "running" || status === "queued") return tools;
  return tools.map(tool => tool.status === "running" ? { ...tool, status: "error", output: tool.output ||
    (status === "cancelled" ? "此次调用已取消。" : "未收到此次调用的完整结果。") } : tool);
}
