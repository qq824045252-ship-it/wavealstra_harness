const LAST_ACTIVE_TASK_KEY = 'mybuddy_remote_last_active_task_id'

export function loadLastActiveTaskId(): string | null {
  try {
    const value = localStorage.getItem(LAST_ACTIVE_TASK_KEY)?.trim()
    return value || null
  } catch {
    return null
  }
}

export function saveLastActiveTaskId(taskId: string | null): void {
  try {
    if (taskId) localStorage.setItem(LAST_ACTIVE_TASK_KEY, taskId)
    else localStorage.removeItem(LAST_ACTIVE_TASK_KEY)
  } catch {
    // Non-sensitive navigation state only; storage failure must not block Remote.
  }
}
