/**
 * Computer Use screenshots are large tool-result images. Keeping every one of
 * them in the transcript makes each later provider request re-send all pixels
 * and grows prefill time. Before every LLM call we keep only the newest
 * `keep` image-bearing tool results and replace older images with a short note.
 *
 * The session history itself is untouched: reopening a task still shows the
 * original screenshots and artifacts; only the model context is aged.
 */

export interface ImageAgingMessage {
  role?: string;
  content?: unknown;
}

interface ContentBlock {
  type?: string;
  [key: string]: unknown;
}

const OMITTED_TEXT = "[older screenshot omitted to keep the context small; request a fresh screenshot_window when needed]";

function isImageBlock(block: unknown): block is ContentBlock {
  return Boolean(block) && typeof block === "object" && (block as ContentBlock).type === "image";
}

export function ageToolResultImages<T extends ImageAgingMessage>(messages: readonly T[], keep = 2): readonly T[] {
  if (keep < 0) return messages;
  const imageMessages: number[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return;
    if ((message.content as unknown[]).some(isImageBlock)) imageMessages.push(index);
  });
  if (imageMessages.length <= keep) return messages;
  const keepSet = new Set(imageMessages.slice(-keep));
  let changed = false;
  const aged = messages.map((message, index) => {
    if (!imageMessages.includes(index) || keepSet.has(index)) return message;
    const content = (message.content as unknown[]).map((block) => {
      if (!isImageBlock(block)) return block;
      changed = true;
      return { type: "text", text: OMITTED_TEXT };
    });
    return { ...message, content } as T;
  });
  return changed ? aged : messages;
}
