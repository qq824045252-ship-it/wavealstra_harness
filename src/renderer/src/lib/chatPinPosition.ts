export function latestHumanMessageId(
  messages: readonly { id: string; role: string; goalContinuation?: unknown }[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && !message.goalContinuation) return message.id;
  }
  return null;
}

/** Reserve only the distance missing to make the human anchor reachable. */
export function chatPinPosition(input: {
  scrollTop: number;
  naturalHeight: number;
  viewportHeight: number;
  anchorOffset: number;
  topInset: number;
}): { top: number; tailSpace: number } {
  const top = Math.max(0, input.scrollTop + input.anchorOffset - input.topInset);
  const naturalMax = input.naturalHeight - input.viewportHeight;
  return { top, tailSpace: top === 0 ? 0 : Math.max(0, Math.ceil(top - naturalMax)) };
}
