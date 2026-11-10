import { useEffect, useSyncExternalStore } from 'react';
import type { BotWorkspaceNavigationDto, BotWorkspaceRequestDto } from '@shared/bot-workspace-navigation';
import { useAppStore } from '@/store/appStore';

const listeners = new Set<() => void>();
let snapshot: { requests: BotWorkspaceRequestDto[]; error: string } = { requests: [], error: '' };
let pending: Promise<void> | undefined;
let selected: BotWorkspaceRequestDto | null = null;
export function openWorkspaceRequest(request: BotWorkspaceRequestDto): void {
  selected = request;
  useAppStore.getState().openWorkspaceDetail(request.spaceId);
  window.dispatchEvent(new CustomEvent('mybuddy:workspace-request', { detail: request }));
}
export function selectedWorkspaceRequest(spaceId: string | null): BotWorkspaceRequestDto | null {
  return selected?.spaceId === spaceId ? selected : null;
}
export function clearWorkspaceRequest(): void { selected = null; }
export const foregroundStatus = (status: BotWorkspaceRequestDto['status']): string => ({
  queued: '排队中', running: '回复中', completed: '已回复', failed: '失败', cancelled: '已停止', unknown: '状态待核实',
})[status];
async function refresh(): Promise<void> {
  if (pending) return pending;
  const api = window.api?.botWork;
  if (!api?.workspaceNavigation) return;
  pending = (async () => {
    try {
      const result: BotWorkspaceNavigationDto = await api.workspaceNavigation();
      // Preserve loaded messages and live execution state: only reconcile navigation ownership.
      useAppStore.setState(state => {
        const spaces = result.spaces.map(space => ({ ...space, parentId: space.parentId ?? null }));
        const owners = new Map(result.taskSpaces.map(item => [item.taskId, item.spaceId]));
        let changed = false;
        const tasks = state.tasks.map(task => { const spaceId = owners.get(task.id); if (!spaceId || spaceId === task.spaceId) return task; changed = true; return { ...task, spaceId }; });
        return { ...(JSON.stringify(state.spaces) === JSON.stringify(spaces) ? {} : { spaces }), ...(changed ? { tasks } : {}) };
      });
      if (snapshot.error || JSON.stringify(snapshot.requests) !== JSON.stringify(result.foregroundRequests)) {
        snapshot = { requests: result.foregroundRequests, error: '' }; listeners.forEach(listener => listener());
      }
    } catch (error) {
      snapshot = { ...snapshot, error: error instanceof Error ? error.message : '前台任务暂时无法加载' }; listeners.forEach(listener => listener());
    } finally { pending = undefined; }
  })();
  return pending;
}
/** Shared read projection; polling never creates a Task or dispatches model work. */
export function useBotWorkspaceNavigation() {
  const value = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
  useEffect(() => {
    void refresh();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (debounce) return; debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 500); };
    const unsubscribe = window.api?.botWork.onMessageChanged?.(changed);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    window.addEventListener('focus', changed);
    window.addEventListener('mybuddy:teams-refresh', changed);
    return () => { clearInterval(timer); clearTimeout(debounce); unsubscribe?.(); window.removeEventListener('focus', changed); window.removeEventListener('mybuddy:teams-refresh', changed); };
  }, []);
  return value;
}
