import type { RemoteAcpPermissionOption } from '@mybuddy/shared'

/** ACP 权限选项 → 手机端短标签：优先表达「范围」而不是照搬英文原文（与桌面端同一套规则） */
export function acpOptionLabel(option: RemoteAcpPermissionOption): string {
  const raw = option.name.trim()
  if (option.kind.startsWith('reject')) return '拒绝'
  if (/bypass/i.test(raw)) return '自动放行'
  if (!option.kind.endsWith('always')) return option.kind.startsWith('allow') ? '允许一次' : raw || '允许'
  const scope = /all projects?/i.test(raw)
    ? '所有项目'
    : /(?:this|current) project/i.test(raw)
      ? '当前项目'
      : /(?:this|current) session/i.test(raw)
        ? '本次会话'
        : /(?:this|current) command/i.test(raw)
          ? '此命令'
          : ''
  if (scope) return `${scope}始终允许`
  return '始终允许'
}

/** ACP run 状态 → 手机端短标签（只描述传输/执行状态，不代表业务正确性） */
export function acpStatusLabel(status: string): string {
  switch (status) {
    case 'starting': return '启动中'
    case 'working': return '执行中'
    case 'blocked': return '等待授权'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已停止'
    default: return status
  }
}
