import { randomUUID } from "node:crypto";
import type { SpeechAudioEvent, SpeechCancelRequest, SpeechProviderAudioEvent, SpeechStreamScope } from "../../shared/speech-stream";
import type { ToolExecutionContext } from "./BuiltinCapabilityRuntime";

export interface SpeechStreamHandle {
  scope: SpeechStreamScope;
  signal: AbortSignal;
  audioStream: (event: SpeechProviderAudioEvent) => void;
  complete(): void;
  fail(error: unknown): void;
}

/** Main-process ownership of live speech. Credentials and PCM never enter durable tool output. */
export class SpeechStreamService {
  private readonly streams = new Map<string, { scope: SpeechStreamScope; cancel: () => void }>();
  private readonly listeners = new Set<(event: SpeechAudioEvent) => void>();

  onAudio(listener: (event: SpeechAudioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SpeechAudioEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* A closed renderer must not interrupt synthesis. */ }
    }
  }

  start(context: ToolExecutionContext): SpeechStreamHandle {
    context.signal?.throwIfAborted();
    const scope: SpeechStreamScope = { streamId: randomUUID(), taskId: context.taskId,
      messageId: context.producerMessageId ?? `speech-${context.toolCallId}`, toolCallId: context.toolCallId };
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    let started = false, terminal = false, providerFinished = false, sequence = 0, bytes = 0;
    const finish = (event: SpeechAudioEvent): void => {
      if (terminal) return;
      terminal = true;
      this.streams.delete(scope.streamId);
      context.signal?.removeEventListener("abort", abort);
      this.emit(event);
    };
    const abort = (): void => {
      if (terminal) return;
      controller.abort(new Error("语音合成已取消"));
      finish({ ...scope, kind: "cancelled" });
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    this.streams.set(scope.streamId, { scope, cancel: abort });
    return {
      scope, signal,
      audioStream: event => {
        if (terminal) return;
        if (event.type === "start") {
          if (started) throw new Error("语音流重复开始");
          started = true;
          this.emit({ ...scope, kind: "start", format: event.format, sampleRate: event.sampleRate, channels: event.channels });
        } else if (event.type === "chunk") {
          if (!started || providerFinished) throw new Error("语音帧顺序错误");
          if (!event.audio.byteLength || event.audio.byteLength % 2 || event.audio.byteLength > 48 * 1024) throw new Error("语音帧格式错误");
          bytes += event.audio.byteLength;
          if (bytes > 24_000 * 2 * 30 * 60) throw new Error("语音流超出时长限制");
          this.emit({ ...scope, kind: "chunk", sequence: sequence++, pcmBase64: Buffer.from(event.audio).toString("base64") });
        } else if (event.type === "finish") {
          if (!started || !bytes) throw new Error("语音服务没有返回音频");
          providerFinished = true;
        } else {
          finish({ ...scope, kind: "error", error: event.message });
        }
      },
      complete: () => {
        if (terminal) return;
        if (!providerFinished) throw new Error("语音服务未确认合成完成");
        finish({ ...scope, kind: "complete" });
      },
      fail: error => {
        if (signal.aborted) { abort(); return; }
        finish({ ...scope, kind: "error", error: error instanceof Error ? error.message : "语音合成失败" });
      },
    };
  }

  cancel(input: SpeechCancelRequest): boolean {
    if (!input || typeof input.streamId !== "string" || typeof input.taskId !== "string" || typeof input.toolCallId !== "string") return false;
    const active = this.streams.get(input.streamId);
    if (!active || active.scope.taskId !== input.taskId || active.scope.toolCallId !== input.toolCallId) return false;
    active.cancel();
    return true;
  }

  close(): void {
    for (const active of [...this.streams.values()]) active.cancel();
    this.listeners.clear();
  }
}
