import { BoundedTTLCache } from "./BoundedTTLCache";

const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 2000;

/** Runtime dedupe for callers without a durable receipt. Tuple encoding avoids
 * delimiter collisions; lookup and capacity eviction do not scan or sort entries.
 */
export function createIdempotencyGuard(
  windowMs = IDEMPOTENCY_WINDOW_MS,
  maxEntries = IDEMPOTENCY_MAX_ENTRIES,
): ((channelId: string, chatId: string, messageId: string) => boolean) & {
  forget(channelId: string, chatId: string, messageId: string): void;
} {
  const processed = new BoundedTTLCache<string, true>({ ttlMs: windowMs, maxEntries });
  const key = (channelId: string, chatId: string, messageId: string) => JSON.stringify([channelId, chatId, messageId]);
  const guard = (channelId: string, chatId: string, messageId: string): boolean => {
    const id = key(channelId, chatId, messageId);
    if (processed.has(id)) return false;
    processed.set(id, true);
    return true;
  };
  return Object.assign(guard, { forget: (channelId: string, chatId: string, messageId: string) => {
    processed.delete(key(channelId, chatId, messageId));
  } });
}

/** Empty allowlists preserve the explicitly supported callback policy. */
export function isAllowedUser(allowUsers: string[], senderId?: string): boolean {
  return allowUsers.length === 0 || Boolean(senderId && allowUsers.includes(senderId));
}
