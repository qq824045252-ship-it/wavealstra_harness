import type { SpeechAudioEvent, SpeechStreamScope } from "@shared/speech-stream";
import { PcmStreamPlayer } from "./PcmStreamPlayer";

export type { SpeechStreamScope } from "@shared/speech-stream";

export interface SpeechStreamEntry extends SpeechStreamScope {
  player: PcmStreamPlayer;
  transport: "streaming" | "complete" | "error" | "cancelled";
  bytes: number;
  lastSequence?: number;
  updatedAt: number;
}

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_STREAMS = 16;
const TERMINAL_TTL = 5 * 60 * 1000;

const sameScope = (left: SpeechStreamScope, right: SpeechStreamScope): boolean => left.streamId === right.streamId
  && left.taskId === right.taskId && left.messageId === right.messageId && left.toolCallId === right.toolCallId;
const listening = (entry: SpeechStreamEntry): boolean => ["playing", "buffering"].includes(entry.player.getSnapshot().status);

/** Bounded, ephemeral PCM storage shared by ordinary chat and Bot conversation cards. */
export class SpeechStreamRegistry {
  private entries = new Map<string, SpeechStreamEntry>();
  private listeners = new Set<() => void>();

  constructor(private readonly playerFactory: () => PcmStreamPlayer = () => new PcmStreamPlayer(), private readonly now = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(scope: SpeechStreamScope): SpeechStreamEntry | undefined {
    const entry = this.entries.get(scope.streamId);
    return entry && sameScope(entry, scope) ? entry : undefined;
  }

  forTool(taskId: string, toolCallId: string): SpeechStreamEntry | undefined {
    return [...this.entries.values()].filter(entry => entry.taskId === taskId && entry.toolCallId === toolCallId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.player.dispose();
    this.entries.delete(id);
  }

  private expire(): void {
    for (const [id, entry] of this.entries) {
      if (entry.transport !== "streaming" && !listening(entry) && this.now() - entry.updatedAt > TERMINAL_TTL) this.remove(id);
    }
  }

  private fail(entry: SpeechStreamEntry, error: string): void {
    // Local preview loss must not claim that remote synthesis failed, or hide
    // its cancellation control. A later terminal event still updates transport.
    entry.bytes = 0;
    entry.player.fail(error);
    this.notify();
  }

  private makeRoom(incoming: number, currentId?: string): boolean {
    const total = (): number => [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (total() + incoming > MAX_TOTAL_BYTES || (!currentId && this.entries.size >= MAX_STREAMS)) {
      const candidates = [...this.entries.values()].filter(entry => entry.streamId !== currentId && !listening(entry)
        && (entry.transport !== "streaming" || entry.player.getSnapshot().status === "error"));
      candidates.sort((a, b) => Number(a.transport === "streaming") - Number(b.transport === "streaming") || a.updatedAt - b.updatedAt);
      if (!candidates[0]) return false;
      this.remove(candidates[0].streamId);
    }
    return true;
  }

  ingest(event: SpeechAudioEvent): void {
    this.expire();
    if (event.kind === "start") {
      // Duplicate/replayed starts cannot reset an existing stream or take over
      // another task's player. Only a host-authored, fully scoped start creates it.
      if (this.entries.has(event.streamId)) return;
      if (event.format !== "pcm_s16le" || event.sampleRate !== 24_000 || event.channels !== 1 || !this.makeRoom(0)) return;
      const player = this.playerFactory();
      const entry: SpeechStreamEntry = { taskId: event.taskId, messageId: event.messageId, toolCallId: event.toolCallId,
        streamId: event.streamId, player, transport: "streaming", bytes: 0, updatedAt: this.now() };
      player.subscribe(() => { entry.bytes = player.retainedPcmBytes; });
      this.entries.set(event.streamId, entry);
      this.notify();
      return;
    }
    const entry = this.get(event);
    if (!entry || entry.transport !== "streaming") return;
    entry.updatedAt = this.now();
    if (event.kind === "chunk") {
      if (entry.player.getSnapshot().status === "error") return;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) { this.fail(entry, "实时音频的片段编号无效。"); return; }
      if (entry.lastSequence !== undefined && event.sequence <= entry.lastSequence) return;
      if ((entry.lastSequence === undefined && event.sequence !== 0)
        || (entry.lastSequence !== undefined && event.sequence !== entry.lastSequence + 1)) {
        this.fail(entry, "实时音频有片段缺失。完成后可播放保存的完整文件。"); return;
      }
      // Reject oversized/malformed messages before decoding or allocating samples.
      if (!event.pcmBase64 || event.pcmBase64.length > 65_536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.pcmBase64)) {
        this.fail(entry, "实时音频片段格式无效。"); return;
      }
      let bytes: Uint8Array;
      try {
        const decoded = atob(event.pcmBase64);
        bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      } catch { this.fail(entry, "无法解码实时音频片段。"); return; }
      if (bytes.length % 2) { this.fail(entry, "收到不完整的实时音频样本。"); return; }
      if (entry.bytes + bytes.length > MAX_STREAM_BYTES || !this.makeRoom(bytes.length, entry.streamId)) {
        this.fail(entry, "实时试听已达到缓冲上限。音频仍在生成，完成后可播放保存的文件。"); return;
      }
      entry.lastSequence = event.sequence;
      entry.bytes += bytes.length;
      entry.player.append(bytes);
      if (entry.player.getSnapshot().status === "error") entry.bytes = 0;
      return;
    }
    entry.transport = event.kind;
    if (event.kind === "complete") entry.player.complete();
    else {
      entry.bytes = 0;
      entry.player.fail(event.kind === "error" ? event.error || "语音生成失败。" : "语音生成已取消。");
    }
    this.notify();
  }

  /** Scope changes/hidden views stop playback; arriving chunks remain silent. */
  stopPlayback(exceptStreamId?: string): void {
    for (const entry of this.entries.values()) if (entry.streamId !== exceptStreamId
      && (listening(entry) || entry.player.getSnapshot().status === "paused")) entry.player.stop();
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id);
    this.notify();
  }
}

const registry = new SpeechStreamRegistry();
export const ingestSpeechAudio = (event: SpeechAudioEvent): void => registry.ingest(event);
export const getSpeechStream = (scope: SpeechStreamScope): SpeechStreamEntry | undefined => registry.get(scope);
export const getSpeechStreamForTool = (taskId: string, toolCallId: string): SpeechStreamEntry | undefined => registry.forTool(taskId, toolCallId);
export const subscribeSpeechStreams = registry.subscribe;
export const stopSpeechPlayback = (exceptStreamId?: string): void => registry.stopPlayback(exceptStreamId);
