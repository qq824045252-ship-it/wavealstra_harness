import { useEffect, useSyncExternalStore } from "react";
import type { BotWorkIndicatorsDto } from "@shared/bot-work-ipc";
import { EMPTY_BOT_WORK_INDICATORS } from "@/lib/botWorkIndicators";
import { useAppStore } from "@/store/appStore";

const POLL_MS = 5000;
let snapshot: BotWorkIndicatorsDto = EMPTY_BOT_WORK_INDICATORS;
let serialized = JSON.stringify(EMPTY_BOT_WORK_INDICATORS);
let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(next: BotWorkIndicatorsDto): void {
  const text = JSON.stringify(next);
  if (text === serialized) return;
  serialized = text;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Counters only: a failure keeps the last confirmed numbers instead of
 * inventing 空闲. Every row shares this single request and interval. */
export async function refreshBotWorkIndicators(): Promise<void> {
  const api = window.api?.botWork;
  if (!api?.workIndicators || inFlight) return;
  inFlight = true;
  try {
    const next = await api.workIndicators();
    if (next?.bots && next?.teams) publish(next);
  } catch {
    // The next tick or a Work projection wakeup retries.
  } finally {
    inFlight = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshBotWorkIndicators();
    timer = setInterval(() => void refreshBotWorkIndicators(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useBotWorkIndicators(): BotWorkIndicatorsDto {
  const indicators = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_BOT_WORK_INDICATORS);
  const sequence = useAppStore(state => state.botWorkCursor?.sequence);
  const hostOnline = useAppStore(state => state.botHostStatus?.online);
  useEffect(() => {
    void refreshBotWorkIndicators();
  }, [sequence, hostOnline]);
  return indicators;
}
