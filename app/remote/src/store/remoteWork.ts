import { create } from 'zustand'
import type {
  RemoteWorkCardReadResult, RemoteWorkControlResult, RemoteWorkCursor, RemoteWorkSummary, RemoteWorkUpdate,
} from '@mybuddy/shared'
import type { RemoteClient } from '../api/RemoteClient'

/**
 * Device-side Work view.
 *
 * The host journal is the only source of truth: this store applies delta pages while the
 * cursor stays in the same epoch/scope, and replaces its whole set when either changes.
 * A local Work with a higher `stateVersion` from an older epoch never wins.
 */
interface WorkState {
  works: RemoteWorkSummary[]
  cursor: RemoteWorkCursor | null
  selectedWorkId: string | null
  includeClosed: boolean
  loading: boolean
  error: string | null
  /** Monotonic request generation: a slow page from an older session is discarded. */
  generation: number
  diagnostics: Record<string, unknown>
  setSelectedWork: (workId: string | null) => void
  setIncludeClosed: (includeClosed: boolean) => void
  refresh: (client: RemoteClient) => Promise<void>
  applyUpdate: (update: RemoteWorkUpdate) => void
  markCardRead: (client: RemoteClient, workId: string, semanticCardKey: string) => Promise<RemoteWorkCardReadResult>
  submitFeedback: (client: RemoteClient, workId: string, request: {
    operationId: string; criterionIds: string[]; environment: string; sourceRef: string;
    inputSnapshotId: string; failed: boolean; detail?: string
  }) => Promise<RemoteWorkControlResult>
  resendNotification: (client: RemoteClient, workId: string, notificationId: string, reason: string) =>
    Promise<RemoteWorkControlResult>
  loadDiagnostics: (client: RemoteClient, workId: string, limit?: number) => Promise<void>
}

const mergeReadState = (incoming: RemoteWorkSummary, observed?: RemoteWorkSummary): RemoteWorkSummary => {
  if (!observed) return incoming
  const readAt = new Map(observed.cards.map(card => [card.semanticCardKey, card.readAt]))
  return {
    ...incoming,
    cards: incoming.cards.map(card => {
      const known = readAt.get(card.semanticCardKey) ?? 0
      return (card.readAt ?? 0) < known ? { ...card, readAt: known } : card
    }),
  }
}

export const useRemoteWorkStore = create<WorkState>((set, get) => ({
  works: [],
  cursor: null,
  selectedWorkId: null,
  includeClosed: false,
  loading: false,
  error: null,
  generation: 0,
  diagnostics: {},

  setSelectedWork: (selectedWorkId) => set({ selectedWorkId }),
  setIncludeClosed: (includeClosed) => set({ includeClosed }),

  applyUpdate: (update) => {
    const state = get()
    if (update.kind === 'resync_required') {
      set({ cursor: null })
      return
    }
    if (update.kind === 'snapshot') {
      const sameScope = state.cursor
        && state.cursor.epoch === update.cursor.epoch
        && state.cursor.scope === update.cursor.scope
      if (sameScope && state.cursor!.sequence > update.cursor.sequence) return
      const observed = new Map(state.works.map(work => [work.workId, work]))
      set({
        // A snapshot replaces the whole set: works that no longer exist (closed in the open
        // scope, or from another epoch) must not survive as stale cards.
        works: update.works.map(work => mergeReadState(work, observed.get(work.workId))),
        cursor: update.cursor,
        selectedWorkId: update.works.some(work => work.workId === state.selectedWorkId) ? state.selectedWorkId : null,
      })
      return
    }
    if (!state.cursor || state.cursor.epoch !== update.cursor.epoch || state.cursor.scope !== update.cursor.scope) {
      set({ cursor: null })
      return
    }
    if (update.cursor.sequence <= state.cursor.sequence) return
    if (update.from !== state.cursor.sequence
      || update.events.some((event, index) => event.sequence !== update.from + index + 1)) {
      set({ cursor: null })
      return
    }
    const next = new Map(state.works.map(work => [work.workId, work]))
    for (const event of update.events) {
      if (event.kind === 'remove') next.delete(event.workId)
      else next.set(event.work.workId, mergeReadState(event.work, next.get(event.work.workId)))
    }
    set({
      works: [...next.values()],
      cursor: update.cursor,
      selectedWorkId: next.has(state.selectedWorkId ?? '') ? state.selectedWorkId : null,
    })
  },

  refresh: async (client) => {
    const generation = get().generation + 1
    set({ generation, loading: true, error: null })
    try {
      let update = await client.workSync({ includeClosed: get().includeClosed, cursor: get().cursor ?? undefined })
      if (generation !== get().generation) return
      get().applyUpdate(update)
      // Follow the cursor while the host still has pages, bounded so a runaway loop cannot
      // spin on a broken page.
      for (let page = 0; page < 50 && update.kind === 'delta' && update.hasMore; page += 1) {
        const cursor = get().cursor
        if (!cursor) break
        update = await client.workSync({ includeClosed: get().includeClosed, cursor })
        if (generation !== get().generation) return
        get().applyUpdate(update)
      }
      if (!get().cursor) {
        // Gap or epoch change: one authoritative snapshot, no guessing.
        const snapshot = await client.workSync({ includeClosed: get().includeClosed })
        if (generation !== get().generation) return
        get().applyUpdate(snapshot)
      }
      set({ loading: false })
    } catch (error) {
      if (generation !== get().generation) return
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  markCardRead: async (client, workId, semanticCardKey) => {
    const result = await client.workCardRead(workId, semanticCardKey)
    if (result.ok && result.readAt) {
      set(state => ({
        works: state.works.map(work => work.workId !== workId ? work : {
          ...work,
          cards: work.cards.map(card => card.semanticCardKey === semanticCardKey
            ? { ...card, readAt: result.readAt, readVersion: result.readVersion ?? card.readVersion + 1 }
            : card),
        }),
      }))
    }
    return result
  },

  submitFeedback: async (client, workId, request) => {
    const result = await client.workFeedback(workId, request)
    return result
  },

  resendNotification: async (client, workId, notificationId, reason) => {
    const result = await client.workResend(workId, notificationId, {
      operationId: `phone-resend-${notificationId}-${Date.now()}`,
      reason,
    })
    return result
  },

  loadDiagnostics: async (client, workId, limit = 20) => {
    const result = await client.workDiagnostics(workId, { limit })
    set(state => ({ diagnostics: { ...state.diagnostics, [workId]: result } }))
  },
}))

export const selectWork = (workId: string | null) => (state: WorkState) =>
  state.works.find(work => work.workId === workId)
