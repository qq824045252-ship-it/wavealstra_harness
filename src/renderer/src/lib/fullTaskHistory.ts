import type { ChatMessage } from "../types";
import type { TaskHistoryDto } from "../../../shared/agent-ipc";
import { durableMessageToChatMessage } from "../store/app/messages/historyMapper";

/** Display-only archive: updates replace their row, never evict an older row. */
export function mergeFullTaskHistory(previous: ChatMessage[], updates: ChatMessage[]): ChatMessage[] {
  const liveIds = new Set(updates.map(row => row.id));
  const liveKeys = new Set(updates.map(row => row.presentationKey).filter(Boolean));
  // A cancelled/retried generation can disappear without keeping its temporary
  // id (aborted durable rows also have a different presentation key). Archive
  // persisted rows, not vanished streaming shells.
  const result = previous.filter(row => !row.id.startsWith("durable-live-")
    || liveIds.has(row.id) || (row.presentationKey && liveKeys.has(row.presentationKey)));
  const byId = new Map<string, number>();
  const byPresentation = new Map<string, number>();
  const byInput = new Map<string, number>();
  const index = (row: ChatMessage, position: number): void => {
    byId.set(row.id, position);
    if (row.presentationKey) byPresentation.set(row.presentationKey, position);
    if (row.inputRequestId) byInput.set(row.inputRequestId, position);
  };
  result.forEach(index);
  for (const row of updates) {
    const presentationPosition = row.presentationKey ? byPresentation.get(row.presentationKey) : undefined;
    // Presentation keys reconcile live-to-persisted identity, not two distinct
    // persisted entries (e.g. native retry/attempt history with a shared key).
    const temporaryPosition = presentationPosition !== undefined
      && (row.id.startsWith("durable-live-") || result[presentationPosition].id.startsWith("durable-live-"))
      ? presentationPosition : undefined;
    const position = byId.get(row.id)
      ?? temporaryPosition
      ?? (row.inputRequestId ? byInput.get(row.inputRequestId) : undefined);
    if (position === undefined) {
      index(row, result.length);
      result.push(row);
    } else {
      result[position] = row;
      index(row, position);
    }
  }
  return result;
}

export async function readTaskHistoryPage(
  cursor: number, historyId: string, load: (before: number) => Promise<TaskHistoryDto>, isCurrent = () => true,
): Promise<{ before: number | undefined; messages: ChatMessage[] } | undefined> {
  const history = await load(cursor);
  if (!isCurrent()) return undefined;
  if (history.historyError) throw new Error(history.historyError);
  if (!history.page || history.page.historyId !== historyId) {
    throw new Error("历史记录已变化，请重新加载当前对话");
  }
  const before = history.page.before;
  if (before !== undefined && before >= cursor) throw new Error("历史记录游标未向前推进");
  return { before, messages: history.messages.map(durableMessageToChatMessage) };
}

/** Read a contiguous span, ending at the earliest loaded entry during reconnect recovery. */
export async function readFullTaskHistory(options: {
  before: number | undefined;
  historyId: string;
  load: (before: number) => Promise<TaskHistoryDto>;
  isCurrent: () => boolean;
  stop?: (before: number) => boolean;
}): Promise<ChatMessage[] | undefined> {
  let before = options.before;
  const pages: ChatMessage[][] = [];
  while (before !== undefined && !options.stop?.(before)) {
    if (!options.isCurrent()) return undefined;
    const page = await readTaskHistoryPage(before, options.historyId, options.load, options.isCurrent);
    if (!page) return undefined;
    pages.push(page.messages);
    before = page.before;
  }
  // Collect newest-to-oldest pages, then deduplicate once in chronological order.
  // Re-merging the growing archive for every page would make a long chat O(N²).
  return options.isCurrent() ? mergeFullTaskHistory([], pages.reverse().flat()) : undefined;
}
