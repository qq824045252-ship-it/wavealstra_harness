import type { RemoteHistoryMessage, RemoteTaskHistory } from '@mybuddy/shared'

/** Client projection only. Server event time, not phone receipt time, orders the turn. */
export interface LiveRemoteMessage extends RemoteHistoryMessage {
  streaming?: boolean
  activity?: 'thinking' | 'responding' | 'tool'
  replyToId?: string
  observedAt?: number
  endedAt?: number
  nextTextSegment?: boolean
}

function sameUser(a: RemoteHistoryMessage, b: RemoteHistoryMessage): boolean {
  return a.role === 'user' && b.role === 'user' && (a.id === b.id || (
    a.text.trim() === b.text.trim() && Math.abs(a.createdAt - b.createdAt) <= 30_000
    && (a.attachments?.map(x => x.name).join('|') ?? '') === (b.attachments?.map(x => x.name).join('|') ?? '')
  ))
}

export function mergeVisibleText(left = '', right = ''): string {
  if (!right) return left
  if (!left || right.includes(left)) return right
  if (left.includes(right)) return left
  // A snapshot may overlap the beginning of a buffered live segment.
  const limit = Math.min(left.length, right.length, 8192)
  const pattern = right.slice(0, limit)
  const prefix = new Uint32Array(pattern.length)
  for (let i = 1, n = 0; i < pattern.length; i++) {
    while (n && pattern[i] !== pattern[n]) n = prefix[n - 1]
    if (pattern[i] === pattern[n]) n++
    prefix[i] = n
  }
  let overlap = 0
  const suffix = left.slice(-limit)
  for (let i = 0; i < suffix.length; i++) {
    const ch = suffix[i]
    while (overlap && (overlap === pattern.length || ch !== pattern[overlap])) overlap = prefix[overlap - 1]
    if (ch === pattern[overlap]) overlap++
  }
  if (overlap) return left + right.slice(overlap)
  return left + '\n\n' + right
}

function coveredByHistory(live: LiveRemoteMessage, history: RemoteTaskHistory): boolean {
  if (live.streaming) return false
  const assistants = history.messages.filter(x => x.role === 'assistant')
  return assistants.some(h => {
    const sameTools = !!live.tools?.length && live.tools.every(t => h.tools?.some(x => x.id === t.id))
    const sameId = h.id === live.id
    const near = Math.abs(h.createdAt - live.createdAt) <= 30_000
    const hasContent = !!(live.text || live.thinking)
    return (sameTools || sameId || (near && hasContent))
      && (!live.text || h.text.includes(live.text))
      && (!live.thinking || (h.thinking ?? '').includes(live.thinking))
  })
}

export function reconcileLiveMessagesWithHistory(
  live: Record<string, LiveRemoteMessage>, history: RemoteTaskHistory,
): Record<string, LiveRemoteMessage> {
  const next = { ...live }
  const unmatched = history.messages.filter(x => x.role === 'user')
  // One-to-one matching: two rapid 'continue' messages are not one user turn.
  for (const m of Object.values(live).sort((a, b) => a.createdAt - b.createdAt)) {
    if (m.role === 'user') {
      const i = unmatched.findIndex(h => sameUser(m, h))
      if (i >= 0) {
        const canonical = unmatched[i]
        // Keep the causal anchor after replacing a live user with its session entry.
        for (const [id, reply] of Object.entries(next)) {
          if (reply.replyToId === m.id) next[id] = { ...reply, replyToId: canonical.id }
        }
        delete next[m.id]; unmatched.splice(i, 1)
      }
    } else if (coveredByHistory(m, history)) delete next[m.id]
  }
  return next
}

export function coalesceAssistantTurnMessages(messages: LiveRemoteMessage[]): LiveRemoteMessage[] {
  const result: LiveRemoteMessage[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (message.role !== 'assistant' || previous?.role !== 'assistant') {
      result.push({ ...message, tools: message.tools?.map(x => ({ ...x })), artifacts: message.artifacts?.map(x => ({ ...x })) })
      continue
    }
    const tools = new Map((previous.tools ?? []).map(t => [t.id, t]))
    for (const t of message.tools ?? []) tools.set(t.id, { ...tools.get(t.id), ...t })
    const artifacts = new Map((previous.artifacts ?? []).map(a => [a.id, a]))
    for (const a of message.artifacts ?? []) artifacts.set(a.id, a)
    // Desktop invariant: visible prose is never moved into the hidden thinking panel.
    previous.text = mergeVisibleText(previous.text, message.text)
    previous.thinking = mergeVisibleText(previous.thinking, message.thinking) || undefined
    previous.tools = tools.size ? [...tools.values()] : undefined
    previous.artifacts = artifacts.size ? [...artifacts.values()] : undefined
    previous.modelName = message.modelName ?? previous.modelName
    previous.durationMs = message.durationMs ?? previous.durationMs
    previous.streaming = message.streaming ?? previous.streaming
    previous.activity = message.activity
  }
  return result
}

export function buildRemoteTimeline(history: RemoteHistoryMessage[], live: Record<string, LiveRemoteMessage>): LiveRemoteMessage[] {
  const users = history.filter(x => x.role === 'user').map(x => ({ ...x }))
  const unmatched = [...users]
  const aliases = new Map<string, string>()
  const historyTurns = new Map<string | null, LiveRemoteMessage[]>()
  const ownerById = new Map<string, string | null>()
  const toolOwner = new Map<string, string | null>()
  let anchor: string | null = null
  // The server's branch order is authoritative, including same-millisecond entries.
  for (const message of history) {
    if (message.role === 'user') { anchor = message.id; continue }
    const turn = historyTurns.get(anchor) ?? []
    turn.push({ ...message }); historyTurns.set(anchor, turn)
    ownerById.set(message.id, anchor)
    for (const tool of message.tools ?? []) toolOwner.set(tool.id, anchor)
  }
  for (const message of Object.values(live).filter(x => x.role === 'user').sort((a, b) => a.createdAt - b.createdAt)) {
    const i = unmatched.findIndex(h => sameUser(message, h))
    if (i >= 0) { aliases.set(message.id, unmatched[i].id); unmatched.splice(i, 1) }
    else users.push({ ...message })
  }
  users.sort((a, b) => a.createdAt - b.createdAt)
  const liveTurns = new Map<string | null, LiveRemoteMessage[]>()
  for (const message of Object.values(live).filter(x => x.role === 'assistant')) {
    let owner: string | null | undefined
    const bound = message.replyToId ? aliases.get(message.replyToId) ?? message.replyToId : undefined
    if (bound && users.some(u => u.id === bound)) owner = bound
    if (owner === undefined && ownerById.has(message.id)) owner = ownerById.get(message.id)
    if (owner === undefined) {
      const identity = message.tools?.find(t => toolOwner.has(t.id))
      if (identity) owner = toolOwner.get(identity.id)
    }
    if (owner === undefined && message.text) {
      // Recovery for old cached live IDs, after the user alias was already reconciled.
      const match = history.find(h => h.role === 'assistant' && h.text
        && Math.abs(h.createdAt - message.createdAt) < 30_000
        && (h.text.includes(message.text) || message.text.includes(h.text)))
      if (match) owner = ownerById.get(match.id)
    }
    if (owner === undefined) {
      owner = users.filter(u => u.createdAt <= message.createdAt).at(-1)?.id ?? null
      // agent_start can precede the persisted first user by a few milliseconds.
      if (owner === null && users.length && users[0].createdAt - message.createdAt <= 1000) owner = users[0].id
    }
    const turn = liveTurns.get(owner) ?? []
    turn.push({ ...message }); liveTurns.set(owner, turn)
  }
  const result: LiveRemoteMessage[] = []
  const appendTurn = (owner: string | null) => {
    const base = historyTurns.get(owner) ?? []
    const updates = (liveTurns.get(owner) ?? []).sort((a, b) => a.createdAt - b.createdAt)
    // Snapshot is the base. Live updates win regardless of when JSONL persisted it.
    const merged = coalesceAssistantTurnMessages([...base, ...updates])
    result.push(...merged)
  }
  appendTurn(null)
  for (const u of users) { result.push(u); appendTurn(u.id) }
  return result
}
