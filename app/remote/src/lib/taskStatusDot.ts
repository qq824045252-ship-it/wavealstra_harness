import type { RemoteTaskSummary } from '@mybuddy/shared'

/** 侧栏/最近对话的状态点：running = 蓝点，done-unread = 绿点，null = 不显示 */
export type RemoteTaskDot = 'running' | 'done-unread' | null

/**
 * 状态点判定（与桌面端侧栏同一套语义）：
 *  - 蓝点：任务正在执行（busy）
 *  - 绿点：已结束（completed/failed）且结果还没被看过 → 打开任务即调用 ackDone 清除
 *  - null：空闲 / 未结束 / 已看过
 *
 * doneAckedAt 来自电脑端 tasks.done_acked_at（GET /v1/bootstrap）；
 * localAckAt 是本机确认水位（见 remoteStore 的 localStorage 覆盖层）——
 * 电脑端接口不可用（旧版本 PC / 请求失败）时，仍保证「点了就消失，且刷新不复活」。
 * `?? 0` 让旧电脑端（响应里没有该字段）也能按「未确认」处理，而不是直接不显示绿点。
 */
export function taskStatusDot(
  task: Pick<RemoteTaskSummary, 'status' | 'busy' | 'updatedAt' | 'doneAckedAt'>,
  localAckAt = 0,
): RemoteTaskDot {
  if (task.busy) return 'running'
  if (task.status !== 'completed' && task.status !== 'failed') return null
  const ackedAt = Math.max(task.doneAckedAt ?? 0, localAckAt)
  return ackedAt < task.updatedAt ? 'done-unread' : null
}

export function taskDotLabel(dot: RemoteTaskDot): string | undefined {
  if (dot === 'running') return '执行中'
  if (dot === 'done-unread') return '已结束 · 未查看（点开即清除）'
  return undefined
}
