import type { BotHistoryDto } from "@shared/bot-conversation";
import type { RefFileItem } from "./refTaskArtifacts";

/** Only this Bot/team conversation owns these references; never consult the ordinary active Task. */
export function collectBotConversationFiles(history?: BotHistoryDto): RefFileItem[] {
  const files = new Map<string, RefFileItem>();
  const add = (item: RefFileItem) => {
    const key = item.path || item.id;
    if (!files.has(key)) files.set(key, item);
  };
  for (const message of history?.messages ?? []) {
    for (const attachment of message.attachments ?? []) add({
      id: `attachment:${message.messageId}:${attachment.path}`, ...attachment, source: "attachment",
    });
    for (const file of message.workFeedback?.report?.files ?? []) {
      if (file.openPath) add({id: file.ref, name: file.name, path: file.openPath, source: "artifact"});
    }
  }
  return [...files.values()];
}
