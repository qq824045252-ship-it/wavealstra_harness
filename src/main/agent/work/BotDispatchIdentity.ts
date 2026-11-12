import { createHash } from "node:crypto";

/** Shared by organization admission and peer-tool replay guards. Keep the
 * existing persisted namespace: a fresh user message is a distinct intention. */
export function botDispatchIdentity(sourceBotId: string, userMessageId: string): string {
  return createHash("sha256").update(JSON.stringify(["primary-dispatch", sourceBotId, userMessageId])).digest("hex");
}
