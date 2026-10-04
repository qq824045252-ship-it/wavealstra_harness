import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { parseUserPrompt } from './parse-user-prompt';
import { legacyMemoryDisplayCorrections } from './LegacyMemoryHistoryHygiene';

/** UI indexes refer to visible users on Pi's complete current branch, not
 * getUserMessagesForForking(), which includes abandoned branches as well. Keep
 * the same parsing/filter as loadTaskHistoryFromSession and retain real entry IDs. */
export function getVisibleSessionUserMessages(manager: SessionManager): Array<{
  entryId: string;
  text: string;
  displayText: string;
}> {
  const corrections = legacyMemoryDisplayCorrections(manager);
  return manager.getBranch().flatMap((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'user') return [];
    const correction = corrections.get(entry.id);
    const content = correction === undefined ? entry.message.content : correction;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : '';
    const parsed = parseUserPrompt(text);
    if (!parsed.text && !parsed.attachments?.length && !parsed.taskReferences?.length) return [];
    return [{ entryId: entry.id, text, displayText: parsed.text || '请结合已应用任务继续' }];
  });
}
