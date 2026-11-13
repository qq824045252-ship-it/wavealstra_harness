import { useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BotDirectoryActivitySnapshotDto } from "@shared/bot-work-ipc";
import { EMPTY_BOT_DIRECTORY_ACTIVITY } from "@/lib/botDirectoryActivity";
import { useAppStore } from "@/store/appStore";

const POLL_MS = 5000;
let snapshot: BotDirectoryActivitySnapshotDto = EMPTY_BOT_DIRECTORY_ACTIVITY;
let serialized = JSON.stringify(EMPTY_BOT_DIRECTORY_ACTIVITY);
let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeMessages: (() => void) | null = null;
const listeners = new Set<() => void>();
/** Foreground answers already counted once, so a stream frame costs no request. */
const streamingMessages = new Set<string>();

const isOutput = (status: string): boolean => status === "queued" || status === "running";

function publish(next: BotDirectoryActivitySnapshotDto): void {
  const text = JSON.stringify(next);
  if (text === serialized) return;
  serialized = text;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** A failure keeps the last confirmed counts instead of inventing 空闲. */
export async function refreshBotDirectoryActivity(): Promise<void> {
  const api = window.api?.botWork;
  if (!api?.directoryActivity || inFlight) return;
  inFlight = true;
  try {
    const next = await api.directoryActivity();
    if (next?.bots && next?.teams) publish(next);
  } catch {
    // The next tick or the next message transition retries.
  } finally {
    inFlight = false;
  }
}

/** A reply that starts or stops changes presence; streamed frames do not. */
function onMessageChanged(event: { message: { messageId: string; status: string } }): void {
  const active = isOutput(event.message.status);
  if (active === streamingMessages.has(event.message.messageId)) return;
  if (active) streamingMessages.add(event.message.messageId);
  else streamingMessages.delete(event.message.messageId);
  void refreshBotDirectoryActivity();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshBotDirectoryActivity();
    timer = setInterval(() => void refreshBotDirectoryActivity(), POLL_MS);
    unsubscribeMessages = window.api?.botWork.onMessageChanged?.(onMessageChanged) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer) clearInterval(timer);
    timer = null;
    unsubscribeMessageEvents();
  };
}

function unsubscribeMessageEvents(): void {
  unsubscribeMessages?.();
  unsubscribeMessages = null;
  streamingMessages.clear();
}

export interface BotDirectoryActivityView extends BotDirectoryActivitySnapshotDto {
  /** Foreground answers this window is already rendering, before the host count. */
  liveBots: string[];
  liveTeams: string[];
}

export function useBotDirectoryActivity(): BotDirectoryActivityView {
  const activity = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_BOT_DIRECTORY_ACTIVITY);
  const liveBots = useAppStore(useShallow(state => {
    const ids = new Set<string>();
    for (const pending of Object.values(state.botPendingSends)) ids.add(pending.request.botId);
    for (const history of Object.values(state.botHistories)) {
      if (history?.messages.some(message => message.role === "assistant" && isOutput(message.status))) ids.add(history.botId);
    }
    return [...ids].sort();
  }));
  const liveTeams = useAppStore(useShallow(state => {
    const ids = new Set<string>();
    for (const pending of Object.values(state.botPendingSends)) if (pending.request.teamId) ids.add(pending.request.teamId);
    for (const history of Object.values(state.botHistories)) {
      if (history?.teamId && history.messages.some(message => message.role === "assistant" && isOutput(message.status))) ids.add(history.teamId);
    }
    return [...ids].sort();
  }));
  const sequence = useAppStore(state => state.botWorkCursor?.sequence);
  const hostOnline = useAppStore(state => state.botHostStatus?.online);
  useEffect(() => {
    void refreshBotDirectoryActivity();
  }, [sequence, hostOnline]);
  return { bots: activity.bots, teams: activity.teams, liveBots, liveTeams };
}
