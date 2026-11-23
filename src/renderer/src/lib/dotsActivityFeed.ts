import { useSyncExternalStore } from "react";
import type { DotsActivityItem } from "@shared/dots";

type Snapshot = { items: DotsActivityItem[]; loading: boolean; error?: string };
let snapshot: Snapshot = { items: [], loading: true };
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let reading = false;
let dirty = false;

function publish(next: Snapshot): void {
  snapshot = next;
  listeners.forEach(listener => listener());
}

async function read(): Promise<void> {
  if (reading || !dirty || !listeners.size) return;
  const api = window.api?.dots;
  if (!api?.activity) {
    publish({ items: [], loading: false, error: "Dots 服务不可用" });
    return;
  }
  reading = true;
  dirty = false;
  try {
    publish({ items: await api.activity(), loading: false });
  } catch (error) {
    publish({ ...snapshot, loading: false, error: String(error) });
  } finally {
    reading = false;
    if (dirty) refreshDotsActivity();
  }
}

export function refreshDotsActivity(): void {
  dirty = true;
  if (reading || timer !== undefined || !listeners.size) return;
  timer = setTimeout(() => {
    timer = undefined;
    void read();
  }, 180);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribe = window.api?.dots?.onChanged(refreshDotsActivity);
    refreshDotsActivity();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function useDotsActivity(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
