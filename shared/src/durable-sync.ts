export type DurableVersioned<Message, State> = State & { epoch: string; revision: number; messages: Message[] }

/** Metadata replaces the previous metadata, so omitted optional fields are cleared. */
export interface DurableStreamDelta<Message, State> {
  epoch: string
  baseRevision: number
  revision: number
  state: State
  upserts: Message[]
  removed: string[]
  /** Present only when rows are inserted, removed or reordered. */
  order?: string[]
}

export type DurableDeltaResult<Message, State> =
  | { kind: 'applied'; snapshot: DurableVersioned<Message, State> }
  | { kind: 'stale' }
  | { kind: 'resync' }

/** Committed rows are immutable: comparing references never serializes historical text. */
export function durableDelta<Message extends { id: string }, State>(
  previous: DurableVersioned<Message, State>,
  next: DurableVersioned<Message, State>,
  state: State,
): DurableStreamDelta<Message, State> {
  const before = new Map(previous.messages.map(message => [message.id, message]))
  const upserts: Message[] = []
  let reordered = previous.messages.length !== next.messages.length
  for (const [index, message] of next.messages.entries()) {
    if (before.get(message.id) !== message) upserts.push(message)
    if (previous.messages[index]?.id !== message.id) reordered = true
    before.delete(message.id)
  }
  return { epoch: next.epoch, baseRevision: previous.revision, revision: next.revision, state,
    upserts, removed: [...before.keys()], ...(reordered ? { order: next.messages.map(message => message.id) } : {}) }
}

/** A revision gap is an explicit full-read boundary, never a best-effort merge. */
export function applyDurableDelta<Message extends { id: string }, State>(
  previous: DurableVersioned<Message, State> | undefined,
  delta: DurableStreamDelta<Message, State>,
): DurableDeltaResult<Message, State> {
  if (previous?.epoch === delta.epoch && previous.revision >= delta.revision) return { kind: 'stale' }
  if (!previous || previous.epoch !== delta.epoch || previous.revision !== delta.baseRevision || delta.revision <= delta.baseRevision) return { kind: 'resync' }
  const rows = new Map(previous.messages.map(message => [message.id, message]))
  for (const id of delta.removed) rows.delete(id)
  for (const message of delta.upserts) rows.set(message.id, message)
  const order = delta.order ?? previous.messages.map(message => message.id)
  if (rows.size !== order.length || new Set(order).size !== order.length) return { kind: 'resync' }
  const messages: Message[] = []
  for (const id of order) {
    const message = rows.get(id)
    if (!message) return { kind: 'resync' }
    messages.push(message)
  }
  return { kind: 'applied', snapshot: { ...delta.state, epoch: delta.epoch, revision: delta.revision, messages } }
}
