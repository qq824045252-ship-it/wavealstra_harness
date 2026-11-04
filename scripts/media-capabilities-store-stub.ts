/** Models with image input are deliberately not generation-service candidates. */
export const state = { models: [
  { id: "vision-only/chat", name: "仅图片理解模型", vendor: "vision-only", enabled: true, supportsImages: true, thinkingLevels: [] as string[] },
] };
export function useAppStore<T>(selector: (value: typeof state) => T): T { return selector(state); }
