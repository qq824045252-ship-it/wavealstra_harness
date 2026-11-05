import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export function userMessage(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

export function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture",
    stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
