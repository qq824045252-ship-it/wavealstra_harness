import { create } from 'zustand'
import type {
  RemoteWorkCard, RemoteWorkCardReadResult, RemoteWorkControlResult, RemoteWorkCursor,
  RemoteWorkFeedbackRequest, RemoteWorkResendRequest, RemoteWorkSummary, RemoteWorkUpdate,
} from '@mybuddy/shared'
import type { RemoteClient } from '../api/RemoteClient'

/**
 * The host journal is the only source of truth. A cursor and every pending response belong
 * to one authenticated client, view scope and host epoch; a replacement cannot inherit
 * cards, read watermarks or diagnostics from the previous context.
 */
interface WorkState {
  client: RemoteClient | null
  works: RemoteWorkSummary[]
  cursor: RemoteWorkCursor | null
  selectedWorkId: string | null
  includeClosed: boolean
  loading: boolean
  error: string | null
  generation: number
  contextGeneration: number
  diagnostics: Record<string, unknown>
  /** Only connection lifecycle code may bind a client; late callbacks cannot rebind it. */
  setClient: (client: RemoteClient | null) => void
  setSelectedWork: (workId: string | null) => void
  setIncludeClosed: (includeClosed: boolean) => void
  refresh: (client: RemoteClient) => Promise<void>
  applyUpdate: (update: RemoteWorkUpdate) => void
  markCardRead: (client: RemoteClient, workId: string, semanticCardKey: string) => Promise<RemoteWorkCardReadResult>
  submitFeedback: (client: RemoteClient, workId: string, request: Omit<RemoteWorkFeedbackRequest, 'workId'>) =>
    Promise<RemoteWorkControlResult>
  resendNotification: (client: RemoteClient, workId: string, notificationId: string,
    request: Omit<RemoteWorkResendRequest, 'operationId' | 'notificationId'>) => Promise<RemoteWorkControlResult>
  loadDiagnostics: (client: RemoteClient, workId: string, limit?: number) => Promise<void>
}

const emptyView = () => ({
  works: [] as RemoteWorkSummary[], cursor: null, selectedWorkId: null,
  loading: false, error: null, diagnostics: {} as Record<string, unknown>,
})
const changedContext = () => ({ ok: false, message: '连接或事项视图已切换，请刷新后重试' })
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const mergeCardRead = (incoming: RemoteWorkCard, observed?: RemoteWorkCard): RemoteWorkCard => {
  if (!observed) return incoming
  return observed.readVersion > incoming.readVersion || (observed.readAt ?? -1) > (incoming.readAt ?? -1)
    ? { ...incoming, readAt: observed.readAt, readVersion: Math.max(observed.readVersion, incoming.readVersion) }
    : incoming
}

const mergeReadState = (incoming: RemoteWorkSummary, observed?: RemoteWorkSummary): RemoteWorkSummary => {
  if (!observed) return incoming
  const cards = new Map(observed.cards.map(card => [card.semanticCardKey, card]))
  return { ...incoming, cards: incoming.cards.map(card => mergeCardRead(card, cards.get(card.semanticCardKey))) }
}

const sameWorkVersion = (left: RemoteWorkSummary, right?: RemoteWorkSummary) => right
  && left.stateVersion === right.stateVersion && left.intentRevision === right.intentRevision
  && left.ownerEpoch === right.ownerEpoch && left.inputSnapshotId === right.inputSnapshotId
  && left.artifactSnapshotId === right.artifactSnapshotId

function retainDiagnostics(state: WorkState, works: RemoteWorkSummary[]): Record<string, unknown> {
  const previous = new Map(state.works.map(work => [work.workId, work]))
  return Object.fromEntries(works.filter(work => sameWorkVersion(work, previous.get(work.workId))
    && Object.hasOwn(state.diagnostics, work.workId)).map(work => [work.workId, state.diagnostics[work.workId]]))
}

export const useRemoteWorkStore = create<WorkState>((set, get) => {
  let diagnosticRequest = 0
  const diagnosticsInFlight = new Map<string, number>()
  const isCurrent = (client: RemoteClient, context: number) =>
    get().client === client && get().contextGeneration === context

  return {
    ...emptyView(), client: null, includeClosed: false, generation: 0, contextGeneration: 0,

    setClient: (client) => {
      if (get().client === client) return
      diagnosticsInFlight.clear()
      set(state => ({ ...emptyView(), client, generation: state.generation + 1,
        contextGeneration: state.contextGeneration + 1 }))
    },
    setSelectedWork: (selectedWorkId) => set({ selectedWorkId }),
    setIncludeClosed: (includeClosed) => {
      if (get().includeClosed === includeClosed) return
      set(state => ({ ...emptyView(), includeClosed, generation: state.generation + 1,
        contextGeneration: state.contextGeneration + 1 }))
    },

    applyUpdate: (update) => {
      const state = get()
      const requireSnapshot = () => set({ ...emptyView(), loading: state.loading,
        contextGeneration: state.contextGeneration + 1 })
      if (update.kind === 'resync_required') { requireSnapshot(); return }
      if (update.cursor.scope !== (state.includeClosed ? 'all' : 'open')) { requireSnapshot(); return }
      if (update.kind === 'snapshot') {
        const sameScope = state.cursor?.epoch === update.cursor.epoch && state.cursor.scope === update.cursor.scope
        if (sameScope && state.cursor!.sequence > update.cursor.sequence) return
        const observed = new Map(state.works.map(work => [work.workId, work]))
        const works = update.works.map(work => sameScope ? mergeReadState(work, observed.get(work.workId)) : work)
        set({ works, cursor: update.cursor, diagnostics: sameScope ? retainDiagnostics(state, works) : {},
          contextGeneration: state.contextGeneration + (sameScope ? 0 : 1),
          selectedWorkId: sameScope && works.some(work => work.workId === state.selectedWorkId) ? state.selectedWorkId : null })
        return
      }
      if (!state.cursor || state.cursor.epoch !== update.cursor.epoch || state.cursor.scope !== update.cursor.scope) {
        requireSnapshot(); return
      }
      if (update.cursor.sequence <= state.cursor.sequence) return
      if (update.from !== state.cursor.sequence || update.cursor.sequence !== update.from + update.events.length
        || update.events.some((event, index) => event.sequence !== update.from + index + 1)) {
        requireSnapshot(); return
      }
      const next = new Map(state.works.map(work => [work.workId, work]))
      for (const event of update.events) {
        if (event.kind === 'remove') next.delete(event.workId)
        else next.set(event.work.workId, mergeReadState(event.work, next.get(event.work.workId)))
      }
      const works = [...next.values()]
      set({ works, cursor: update.cursor, diagnostics: retainDiagnostics(state, works),
        selectedWorkId: next.has(state.selectedWorkId ?? '') ? state.selectedWorkId : null })
    },

    refresh: async (client) => {
      if (get().client !== client) return
      const generation = get().generation + 1
      const includeClosed = get().includeClosed
      const current = () => get().client === client && generation === get().generation
      set({ generation, loading: true, error: null })
      try {
        let update = await client.workSync({ includeClosed, cursor: get().cursor ?? undefined })
        if (!current()) return
        get().applyUpdate(update)
        // Bounded paging under the captured scope; a gap requires a full snapshot.
        for (let page = 0; page < 50 && update.kind === 'delta' && update.hasMore; page += 1) {
          const cursor = get().cursor
          if (!cursor) break
          update = await client.workSync({ includeClosed, cursor })
          if (!current()) return
          get().applyUpdate(update)
        }
        if (!get().cursor) {
          const snapshot = await client.workSync({ includeClosed })
          if (!current()) return
          get().applyUpdate(snapshot)
        }
        set({ loading: false })
      } catch (error) {
        if (current()) set({ loading: false, error: errorMessage(error) })
      }
    },

    markCardRead: async (client, workId, semanticCardKey) => {
      const context = get().contextGeneration
      if (!isCurrent(client, context)) return changedContext()
      try {
        const result = await client.workCardRead(workId, semanticCardKey)
        if (!isCurrent(client, context)) return changedContext()
        if (result.ok && result.readAt !== undefined) {
          set(state => ({ works: state.works.map(work => work.workId !== workId ? work : { ...work,
            cards: work.cards.map(card => card.semanticCardKey === semanticCardKey
              ? mergeCardRead({ ...card, readAt: result.readAt, readVersion: result.readVersion ?? card.readVersion }, card)
              : card) }) }))
        }
        return result
      } catch (error) {
        return isCurrent(client, context) ? { ok: false, message: errorMessage(error) } : changedContext()
      }
    },

    submitFeedback: async (client, workId, request) => {
      const context = get().contextGeneration
      if (!isCurrent(client, context)) return changedContext()
      try {
        const result = await client.workFeedback(workId, request)
        return isCurrent(client, context) ? result : changedContext()
      } catch (error) {
        return isCurrent(client, context) ? { ok: false, message: errorMessage(error) } : changedContext()
      }
    },

    resendNotification: async (client, workId, notificationId, request) => {
      const context = get().contextGeneration
      if (!isCurrent(client, context)) return changedContext()
      try {
        const result = await client.workResend(workId, notificationId, {
          ...request, operationId: `phone-resend-${crypto.randomUUID()}`,
        })
        return isCurrent(client, context) ? result : changedContext()
      } catch (error) {
        return isCurrent(client, context) ? { ok: false, message: errorMessage(error) } : changedContext()
      }
    },

    loadDiagnostics: async (client, workId, limit = 20) => {
      const context = get().contextGeneration
      const work = get().works.find(item => item.workId === workId)
      if (!isCurrent(client, context) || !work) return
      const request = ++diagnosticRequest
      diagnosticsInFlight.set(workId, request)
      const current = () => isCurrent(client, context) && diagnosticsInFlight.get(workId) === request
        && sameWorkVersion(work, get().works.find(item => item.workId === workId))
      try {
        const result = await client.workDiagnostics(workId, { limit })
        if (current()) set(state => ({ diagnostics: { ...state.diagnostics, [workId]: result } }))
      } catch (error) {
        if (current()) set({ error: errorMessage(error) })
      } finally {
        if (diagnosticsInFlight.get(workId) === request) diagnosticsInFlight.delete(workId)
      }
    },
  }
})

export const selectWork = (workId: string | null) => (state: WorkState) =>
  state.works.find(work => work.workId === workId)
