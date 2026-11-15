import type { Socket } from "node:net";
import { Agent, WebSocket, buildConnector } from "undici";
import type { SpeechProviderAudioEvent } from "../../../shared/speech-stream";
import { ApiProviderError, assertNotAborted, type ResolvedApiConnection } from "./ApiServiceConnection";

const SAMPLE_RATE = 24_000;
const MAX_DURATION_SECONDS = 30 * 60;
export const DEEPSEEK_TTS_MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_DURATION_SECONDS;
const AUDIO_CHUNK_BYTES = 48 * 1024;
const TEXT_CHUNK_BYTES = 1_024;
const MAX_TEXT_BYTES = 64 * 1024;
type UndiciSocket = InstanceType<typeof WebSocket>;

/** The transport stays in the main process; neither headers nor socket URLs enter stream events. */
export interface DeepSeekTtsSocket {
  binaryType: "blob" | "arraybuffer";
  readonly readyState: number;
  onopen: OmitThisParameter<NonNullable<UndiciSocket["onopen"]>> | null;
  onmessage: OmitThisParameter<NonNullable<UndiciSocket["onmessage"]>> | null;
  onerror: OmitThisParameter<NonNullable<UndiciSocket["onerror"]>> | null;
  onclose: OmitThisParameter<NonNullable<UndiciSocket["onclose"]>> | null;
  send(text: string): void;
  close(code?: number): void;
}

export interface DeepSeekTtsSocketOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxPayloadBytes: number;
}

export type DeepSeekTtsSocketFactory = (url: string, options: DeepSeekTtsSocketOptions) => {
  socket: DeepSeekTtsSocket;
  /** Hard-close this request, including an incomplete handshake or an unresponsive peer. */
  dispose(): void;
};

/** A separate dispatcher and connector prevent cancelling one utterance from closing another. */
export const createDeepSeekTtsSocket: DeepSeekTtsSocketFactory = (url, options) => {
  const sockets = new Set<Socket>();
  let disposed = false;
  const connectionAbort = new AbortController();
  const connect = buildConnector({ timeout: options.timeoutMs, signal: connectionAbort.signal });
  const dispatcher = new Agent({
    connections: 1,
    webSocket: { maxPayloadSize: options.maxPayloadBytes },
    connect(connectOptions, callback) {
      connect(connectOptions, (error, socket) => {
        if (error) { callback(error, null); return; }
        if (disposed) {
          socket.destroy();
          callback(new Error("Speech connection closed"), null);
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        callback(null, socket);
      });
    },
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Also closes TCP/TLS handshakes that have not reached the connector callback yet.
    connectionAbort.abort();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    void dispatcher.destroy().catch(() => undefined);
  };
  try {
    const socket = new WebSocket(url, { headers: options.headers, dispatcher });
    return { socket, dispose };
  } catch {
    dispose();
    throw new ApiProviderError("transport", "DeepSeek speech connection could not be opened");
  }
};

/** Chunk at code-point boundaries; JSON escaping never splits a surrogate pair. */
export function deepSeekTtsTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > TEXT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Slabs keep the final artifact bounded even when a peer sends many tiny binary messages. */
class PcmBuffer {
  private readonly slabs: Buffer[] = [];
  private used = 0;
  byteLength = 0;

  append(bytes: Buffer): void {
    if (this.byteLength + bytes.length > DEEPSEEK_TTS_MAX_PCM_BYTES) {
      throw new ApiProviderError("limit", "DeepSeek speech exceeds the maximum 30-minute audio duration");
    }
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.slabs.length || this.used === AUDIO_CHUNK_BYTES) {
        this.slabs.push(Buffer.allocUnsafe(AUDIO_CHUNK_BYTES));
        this.used = 0;
      }
      const count = Math.min(AUDIO_CHUNK_BYTES - this.used, bytes.length - offset);
      bytes.copy(this.slabs[this.slabs.length - 1], this.used, offset, offset + count);
      this.used += count;
      offset += count;
    }
    this.byteLength += bytes.length;
  }

  wav(): Buffer {
    if (!this.byteLength || this.byteLength % 2) {
      throw new ApiProviderError("format", "DeepSeek speech sample data is missing or incomplete");
    }
    const bytes = Buffer.allocUnsafe(44 + this.byteLength);
    bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
    bytes.writeUInt32LE(this.byteLength, 40);
    let offset = 44;
    for (const slab of this.slabs) offset += slab.copy(bytes, offset, 0, Math.min(slab.length, bytes.length - offset));
    return bytes;
  }
}

function finishError(code: unknown): ApiProviderError {
  // Provider messages can contain submitted text or credentials. Show only known protocol codes.
  const messages: Record<string, string> = {
    invalid_input: "DeepSeek speech could not read the supplied text",
    content_filter: "DeepSeek speech rejected the text during content review",
    input_timeout: "DeepSeek speech timed out while receiving text",
    service_error: "DeepSeek speech synthesis failed",
  };
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? new ApiProviderError(code, messages[code])
    : new ApiProviderError("response", "DeepSeek speech did not finish successfully");
}

export interface DeepSeekTtsStreamOptions {
  signal?: AbortSignal;
  audioStream?: (event: SpeechProviderAudioEvent) => void;
  createWebSocket?: DeepSeekTtsSocketFactory;
}

/** A socket close is not success: the documented finish/success event is mandatory. */
export async function streamDeepSeekSpeech(
  connection: ResolvedApiConnection, text: string, voice: "stella" | "tide", options: DeepSeekTtsStreamOptions,
): Promise<{ bytes: Buffer; durationSeconds: number }> {
  assertNotAborted(options.signal);
  if (connection.baseUrl !== "https://api.deepseek.com") {
    throw new ApiProviderError("configuration", "DeepSeek streaming speech requires the official HTTPS API root");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new ApiProviderError("limit", "DeepSeek speech text exceeds 64 KiB");
  const url = new URL("wss://api.deepseek.com/v1/tools/tts");
  url.searchParams.set("voice_id", voice);
  url.searchParams.set("format", "pcm");
  url.searchParams.set("filter_markdown", "true");
  const headers = { ...connection.headers };
  // The implementation controls the upgrade protocol. Keys are sent only in authenticated headers.
  for (const name of Object.keys(headers)) {
    if (/^(content-type|sec-websocket-.*|upgrade|origin)$/i.test(name)) delete headers[name];
  }
  let transport: ReturnType<DeepSeekTtsSocketFactory>;
  try {
    transport = (options.createWebSocket ?? createDeepSeekTtsSocket)(url.href, {
      headers, timeoutMs: connection.timeoutMs, maxPayloadBytes: DEEPSEEK_TTS_MAX_PCM_BYTES,
    });
  } catch {
    throw new ApiProviderError("transport", "DeepSeek speech connection could not be opened");
  }
  const socket = transport.socket;
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const pcm = new PcmBuffer();
    let pendingByte: number | undefined;
    let settled = false;
    let sentFinishText = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(1000); } catch { /* A failed handshake may already have closed. */ }
      try { transport.dispose(); } catch { /* Cleanup cannot replace the synthesis result. */ }
    };
    const emit = (event: SpeechProviderAudioEvent): void => {
      try { options.audioStream?.(event); }
      catch { throw new ApiProviderError("playback", "The live speech playback channel is unavailable"); }
    };
    const fail = (error: ApiProviderError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { emit({ type: "error", code: error.code, message: error.message }); } catch { /* Do not mask the request failure. */ }
      reject(error);
    };
    const onAbort = (): void => fail(new ApiProviderError("cancelled", "DeepSeek speech request cancelled"));
    const timeout = setTimeout(() => fail(new ApiProviderError("timeout", "DeepSeek speech request timed out")), Math.min(connection.timeoutMs, MAX_DURATION_SECONDS * 1_000));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => {
      if (settled) return;
      try {
        assertNotAborted(options.signal);
        emit({ type: "start", format: "pcm_s16le", sampleRate: SAMPLE_RATE, channels: 1 });
        for (const chunk of deepSeekTtsTextChunks(text)) {
          if (settled) return;
          assertNotAborted(options.signal);
          if (socket.readyState !== 1) throw new ApiProviderError("transport", "DeepSeek speech connection closed while sending text");
          socket.send(JSON.stringify({ event: "text", text: chunk }));
        }
        if (settled) return;
        socket.send(JSON.stringify({ event: "finish_text" }));
        sentFinishText = true;
      } catch (error) {
        fail(error instanceof ApiProviderError ? error : new ApiProviderError("transport", "DeepSeek speech text could not be sent"));
      }
    };
    socket.onmessage = event => {
      if (settled) return;
      try {
        assertNotAborted(options.signal);
        if (event.data instanceof ArrayBuffer) {
          const data = Buffer.from(event.data);
          if (!data.length) return;
          pcm.append(data);
          let offset = 0;
          if (pendingByte !== undefined) {
            const audio = Uint8Array.of(pendingByte, data[0]);
            pendingByte = undefined;
            offset = 1;
            emit({ type: "chunk", audio });
          }
          const end = data.length - ((data.length - offset) % 2);
          while (offset < end && !settled) {
            const next = Math.min(offset + AUDIO_CHUNK_BYTES, end);
            // Copy: consumers cannot mutate the final WAV's collected samples.
            emit({ type: "chunk", audio: new Uint8Array(data.subarray(offset, next)) });
            offset = next;
          }
          if (end < data.length) pendingByte = data[end];
          return;
        }
        if (typeof event.data !== "string" || Buffer.byteLength(event.data, "utf8") > MAX_TEXT_BYTES) {
          throw new ApiProviderError("response", "DeepSeek speech returned an invalid control message");
        }
        let finish: unknown;
        try { finish = JSON.parse(event.data); }
        catch { throw new ApiProviderError("response", "DeepSeek speech returned an invalid control message"); }
        if (!finish || typeof finish !== "object" || Array.isArray(finish) || !("event" in finish) || finish.event !== "finish" || !("code" in finish)) {
          throw new ApiProviderError("response", "DeepSeek speech returned an unexpected control message");
        }
        if (finish.code !== "success") throw finishError(finish.code);
        if (!sentFinishText) throw new ApiProviderError("response", "DeepSeek speech finished before all text was sent");
        const bytes = pcm.wav();
        assertNotAborted(options.signal);
        emit({ type: "finish" });
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ bytes, durationSeconds: pcm.byteLength / 2 / SAMPLE_RATE });
      } catch (error) {
        fail(error instanceof ApiProviderError ? error : new ApiProviderError("response", "DeepSeek speech returned invalid audio"));
      }
    };
    socket.onerror = () => fail(new ApiProviderError("transport", "DeepSeek speech connection failed"));
    socket.onclose = event => fail(new ApiProviderError(event.code === 1009 ? "limit" : "response", event.code === 1009
      ? "DeepSeek speech exceeds the audio response limit" : "DeepSeek speech connection closed before a successful finish"));
    // Abort may have happened during transport construction or event registration.
    if (options.signal?.aborted) onAbort();
  });
}
