import type { BotReplySegment } from "../../../shared/bot-conversation";
import type { ChatMessageDto } from "../../../shared/agent-ipc";

/** Preserve each public generation, rather than replacing a pre-tool sentence with its result.
 * Live and committed rows share presentationKey. No reasoning, arguments, or tool output is copied.
 */
export function projectBotReplySegments(rows: readonly ChatMessageDto[], previous: readonly BotReplySegment[] = [], now = Date.now()): BotReplySegment[] {
  const segments = new Map(previous.map(segment => [segment.id, segment]));
  rows.forEach((row, index) => {
    const id = row.presentationKey ?? row.id;
    const prior = segments.get(id);
    const kind = row.tools?.length || index < rows.length - 1 || prior?.kind === "commentary" ? "commentary" : "answer";
    // A new generation may still be silent. Reclassify the earlier visible prelude,
    // but never manufacture a model acknowledgment from a receipt or a tool status.
    if (!row.text.trim()) return;
    segments.set(id, prior && prior.text === row.text && prior.kind === kind ? prior : {
      id, kind, text: row.text, createdAt: prior?.createdAt ?? now, updatedAt: now,
    });
  });
  return [...segments.values()];
}

/** A final receipt can precede the last watch frame. Settle exactly one answer in that case. */
export function completeBotReplySegments(previous: readonly BotReplySegment[] | undefined, text: string, _requestId: string, now = Date.now()): BotReplySegment[] {
  const segments = [...(previous ?? [])];
  const last = segments.at(-1);
  if (last?.kind === "answer") {
    segments[segments.length - 1] = last.text === text ? last : { ...last, text, updatedAt: now };
  } else segments.push({ id: "final", kind: "answer", text, createdAt: now, updatedAt: now });
  return segments;
}
