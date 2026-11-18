import type { ChatMessage } from "../src/renderer/src/types";

/** Models with image input are deliberately not generation-service candidates. */
export const state = { activeTaskId: null as string | null, tasks: [] as { id: string; messages: ChatMessage[] }[], models: [
  { id: "vision-only/chat", name: "仅图片理解模型", vendor: "vision-only", enabled: true, supportsImages: true, thinkingLevels: [] as string[] },
] };
export function useAppStore<T>(selector: (value: typeof state) => T): T { return selector(state); }
