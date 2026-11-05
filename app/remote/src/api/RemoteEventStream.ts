import type { RemoteEventEnvelope } from '@mybuddy/shared'
import { RemoteClient } from './RemoteClient'

/** Exactly one loop; stop/restart invalidates every callback from the old connection. */
export class RemoteEventStream {
  private controller: AbortController | null = null
  private generation = 0
  private started = false
  private lastEventId = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly client: RemoteClient,
    private readonly onEvent: (event: RemoteEventEnvelope) => void,
    private readonly onState: (connected: boolean) => void,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    void this.loop(++this.generation)
  }
  stop(): void {
    this.started = false
    ++this.generation
    this.controller?.abort()
    this.controller = null
    clearTimeout(this.retryTimer)
    this.wake?.()
    this.wake = undefined
  }
  restart(): void { this.stop(); this.start() }

  private async loop(generation: number): Promise<void> {
    let delay = 1000
    const current = () => this.started && this.generation === generation
    while (current()) {
      const controller = new AbortController()
      this.controller = controller
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const activity = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => controller.abort(), 45_000)
      }
      activity()
      let reset = false
      try {
        await this.client.eventStream(this.lastEventId, controller.signal, event => {
          if (!current()) return
          if (event.type === 'resync_required') {
            // The legacy server sends the CLIENT's obsolete ID in this event.
            // Never reuse it after a server restart: new IDs would be dropped forever.
            this.lastEventId = 0
            reset = true
            this.onEvent(event)
            controller.abort()
            return
          }
          if (reset || event.id <= this.lastEventId) return
          if (this.lastEventId > 0 && event.id !== this.lastEventId + 1) {
            this.onEvent({ ...event, type: 'resync_required', payload: { reason: 'event_gap' } })
          }
          this.lastEventId = event.id
          this.onEvent(event)
        }, () => {
          if (!current()) return
          delay = 1000
          this.onState(true)
        }, activity)
      } catch { /* EOF, network loss and watchdog abort all reconnect below. */ }
      finally { clearTimeout(watchdog); controller.abort() }
      if (!current()) return
      this.onState(false)
      if (!reset) {
        await new Promise<void>(resolve => {
          this.wake = resolve
          this.retryTimer = setTimeout(resolve, delay)
        })
        this.wake = undefined
        delay = Math.min(15_000, delay * 2)
      }
    }
  }
}
