import type { RemoteEventEnvelope, RemoteHistoryMessage, RemoteToolCall } from '@mybuddy/shared'
import type { LiveRemoteMessage } from './remoteTimeline'

/** One deterministic reducer for live packets, replay and phone regression tests. */
export function reduceRemotePatch(
  live: Record<string, LiveRemoteMessage>, history: RemoteHistoryMessage[], event: RemoteEventEnvelope,
): Record<string, LiveRemoteMessage> {
  const p = event.payload as Record<string, unknown>
  const id = typeof p.messageId === 'string' ? p.messageId : ''
  if (!id) return live
  const types = ['user_message', 'assistant_start', 'assistant_message_start', 'text_delta', 'thinking_delta', 'tool_start', 'tool_update', 'assistant_end', 'artifact_ref']
  if (!types.includes(String(p.type))) return live
  const at = Number.isFinite(event.at) ? event.at : Date.now()
  const next = { ...live }
  if (p.type === 'user_message') {
    next[id] = { ...next[id], id, role: 'user', text: String(p.text ?? ''), createdAt: Number(p.createdAt) || at }
    return next
  }
  if (p.type === 'artifact_ref' && typeof p.artifactId !== 'string') return live
  const historyOwner = p.toolCallId ? history.find(m => m.tools?.some(t => t.id === p.toolCallId)) : undefined
  const previous = next[id] ?? {
    id, role: 'assistant' as const, text: '', createdAt: historyOwner?.createdAt ?? at, tools: [],
    streaming: true,
    replyToId: [...history, ...Object.values(live)].filter(m => m.role === 'user' && m.createdAt <= (historyOwner?.createdAt ?? at))
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.id,
  }
  const message: LiveRemoteMessage = { ...previous, observedAt: at }
  if (p.type === 'artifact_ref') {
    const artifacts = new Map((previous.artifacts ?? []).map(a => [a.id, a]))
    if (p.change === 'removed') artifacts.delete(String(p.artifactId))
    else artifacts.set(String(p.artifactId), { id: String(p.artifactId), name: String(p.name ?? '生成图片'), kind: typeof p.kind === 'string' ? p.kind : undefined })
    next[id] = { ...previous, artifacts: [...artifacts.values()] }
    return next
  }
  if (p.type === 'assistant_start') {
    message.streaming = true
    message.activity = undefined
    message.modelName = typeof p.modelName === 'string' ? p.modelName : previous.modelName
  } else if (p.type === 'assistant_message_start') {
    message.nextTextSegment = !!previous.text
    message.activity = undefined
  } else if (p.type === 'text_delta') {
    if (p.final === false) message.thinking = (previous.thinking ?? '') + String(p.delta ?? '')
    else {
      const delta = String(p.delta ?? '')
      message.text = previous.text + (delta && previous.nextTextSegment ? '\n\n' : '') + delta
      if (delta) message.nextTextSegment = false
    }
    if (p.delta) message.activity = p.final === false ? 'thinking' : 'responding'
  } else if (p.type === 'thinking_delta') {
    message.thinking = (previous.thinking ?? '') + String(p.delta ?? '')
    if (p.delta) message.activity = 'thinking'
  } else if (p.type === 'tool_start' || p.type === 'tool_update') {
    const toolId = String(p.toolCallId ?? '')
    if (!toolId) return live
    const prior = previous.tools?.find(t => t.id === toolId) ?? historyOwner?.tools?.find(t => t.id === toolId)
    const tool: RemoteToolCall = {
      ...prior, id: toolId,
      tool: typeof p.tool === 'string' ? p.tool : prior?.tool ?? 'tool',
      summary: typeof p.summary === 'string' ? p.summary : prior?.summary ?? '',
      detail: typeof p.detail === 'string' ? p.detail : prior?.detail,
      output: typeof p.output === 'string' ? p.output : prior?.output,
      status: typeof p.status === 'string' ? p.status : prior?.status ?? (p.type === 'tool_start' ? 'running' : 'pending'),
    }
    const tools = new Map((previous.tools ?? []).map(t => [t.id, t]))
    tools.set(toolId, tool)
    message.tools = [...tools.values()]
    if (p.type === 'tool_start') message.activity = 'tool'
  } else if (p.type === 'assistant_end') {
    message.streaming = false
    message.activity = undefined
    message.endedAt = at
    message.durationMs = typeof p.durationMs === 'number' ? p.durationMs : previous.durationMs
    if (p.error) message.text = previous.text + '\n\n错误：' + String(p.error)
  }
  next[id] = message
  return next
}
