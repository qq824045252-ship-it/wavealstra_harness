import type { RemoteTaskMode, RemoteTaskSummary } from '@mybuddy/shared'

export function taskModeLabel(task: RemoteTaskSummary, modes: RemoteTaskMode[] = []): string {
  const mode = modes.find(mode => mode.id === task.welcomeMode)
  const label = mode?.label ?? (task.welcomeMode ? { working: '日常办公', coding: '代码开发', bot: 'Bot' }[task.welcomeMode] : '未标注模式')
  const tag = mode?.tags.find(tag => tag.id === task.modePresetId)
  // Keep unknown/removed identifiers visible instead of silently relabeling an old task.
  return `${label} · ${tag?.label ?? task.modePresetId ?? '未指定 Tag'}`
}
