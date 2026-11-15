export type PcmPlaybackStatus = "idle" | "buffering" | "playing" | "paused" | "stopped" | "ended" | "error";

export interface PcmPlaybackSnapshot {
  status: PcmPlaybackStatus;
  receivedSeconds: number;
  playedSeconds: number;
  complete: boolean;
  error?: string;
}

interface PcmChunk { samples: Float32Array; endFrame: number; consumed?: boolean }

/** A local, user-started PCM player. Audio bytes never enter a message or a persisted store. */
export class PcmStreamPlayer {
  private chunks: PcmChunk[] = [];
  private frames = 0;
  private retainedFrames = 0;
  private cursor = 0;
  private context?: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private wanted = false;
  private epoch = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private snapshot: PcmPlaybackSnapshot = { status: "idle", receivedSeconds: 0, playedSeconds: 0, complete: false };

  constructor(
    readonly sampleRate = 24_000,
    private readonly createContext: () => AudioContext = () => new AudioContext({ sampleRate }),
    // Ten minutes of mono speech is already a long inline preview. Completion
    // remains an ordinary WAV artifact even if this transient preview fills up.
    private readonly maxFrames = sampleRate * 600,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new Error("不支持的音频采样率。");
  }

  getSnapshot = (): PcmPlaybackSnapshot => this.snapshot;
  get retainedPcmBytes(): number { return this.retainedFrames * 2; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<PcmPlaybackSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  append(bytes: Uint8Array): void {
    if (this.disposed || this.snapshot.complete || this.snapshot.status === "error") return;
    if (!bytes.byteLength) return;
    if (bytes.byteLength % 2) { this.fail("收到不完整的 PCM 音频样本。完成后可尝试播放保存的音频。"); return; }
    const length = bytes.byteLength / 2;
    if (this.retainedFrames + length > this.maxFrames) { this.fail("实时试听已达到缓冲上限。音频仍在生成，完成后可播放保存的文件。"); return; }
    const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(length);
    for (let index = 0; index < length; index++) samples[index] = input.getInt16(index * 2, true) / 32768;
    this.frames += length;
    this.retainedFrames += length;
    this.chunks.push({ samples, endFrame: this.frames });
    this.update({ receivedSeconds: this.frames / this.sampleRate });
    if (this.wanted) this.schedule();
  }

  complete(): void {
    if (this.disposed || this.snapshot.status === "error") return;
    this.update({ complete: true, ...(this.wanted && !this.sources.size ? { status: "ended" as const } : {}) });
  }

  /** Called directly from a click: constructing/resuming the context needs that gesture. */
  async play(): Promise<void> {
    if (this.disposed || this.snapshot.status === "error") return;
    if (this.snapshot.status === "ended") return;
    this.wanted = true;
    const epoch = ++this.epoch;
    try {
      const context = this.context ??= this.createContext();
      await context.resume();
      if (this.disposed || epoch !== this.epoch || !this.wanted) return;
      this.schedule();
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      this.fail(`无法播放实时音频：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pause(): void {
    if (this.disposed || this.snapshot.status === "error" || !this.wanted) return;
    this.wanted = false;
    this.epoch++;
    this.update({ status: "paused" });
    void this.context?.suspend().catch(() => {});
  }

  /** Stop clears scheduled sources; later chunks never restart it. Completed
   * chunks are released, so a later Play continues the retained live buffer.
   * The saved WAV is the source of truth for replaying from the beginning. */
  stop(): void {
    if (this.disposed) return;
    this.wanted = false;
    this.epoch++;
    this.clearSources();
    this.cursor = 0;
    this.nextStart = 0;
    const context = this.context;
    this.context = undefined;
    void context?.close().catch(() => {});
    if (this.snapshot.status !== "error") this.update({ status: "stopped" });
  }

  fail(error: string): void {
    if (this.disposed) return;
    this.stop();
    this.chunks = [];
    this.retainedFrames = 0;
    this.update({ status: "error", error });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.chunks = [];
    this.retainedFrames = 0;
    this.listeners.clear();
  }

  private clearSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A completed source is already stopped. */ }
      source.disconnect();
      source.buffer = null;
    }
    this.sources.clear();
  }

  private schedule(): void {
    const context = this.context;
    if (!context || !this.wanted || this.disposed || this.snapshot.status === "error") return;
    try {
      // Schedule on the audio clock, not arrival time. A small lead tolerates
      // renderer scheduling jitter; a network gap becomes explicit buffering.
      this.nextStart = Math.max(this.nextStart, context.currentTime + 0.025);
      while (this.cursor < this.chunks.length) {
        const chunk = this.chunks[this.cursor++];
        const buffer = context.createBuffer(1, chunk.samples.length, this.sampleRate);
        buffer.getChannelData(0).set(chunk.samples);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        this.sources.add(source);
        source.onended = () => {
          source.disconnect();
          if (!this.sources.delete(source) || this.disposed) return;
          source.onended = null;
          source.buffer = null;
          chunk.consumed = true;
          while (this.chunks[0]?.consumed) {
            this.retainedFrames -= this.chunks[0].samples.length;
            this.chunks.shift();
            this.cursor--;
          }
          this.update({ playedSeconds: Math.max(this.snapshot.playedSeconds, chunk.endFrame / this.sampleRate) });
          if (this.wanted && !this.sources.size) this.update({ status: this.snapshot.complete ? "ended" : "buffering" });
        };
        source.start(this.nextStart);
        this.nextStart += buffer.duration;
      }
      this.update({ status: this.sources.size ? "playing" : this.snapshot.complete ? "ended" : "buffering" });
    } catch (error) {
      this.fail(`音频播放失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
