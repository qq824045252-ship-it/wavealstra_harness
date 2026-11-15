import type { SpeechCapabilityProvider } from "../BuiltinCapabilityRuntime";
import {
  ApiProviderError, apiJson, apiMedia, assertNotAborted, readTaskFile, requiredText,
  resolveApiConnection, type ApiProviderOptions,
} from "./ApiServiceConnection";
import { streamDeepSeekSpeech, type DeepSeekTtsSocketFactory } from "./DeepSeekTtsStream";

interface AudioInfo { mime: "audio/wav" | "audio/ogg"; durationMs: number; channels: number }
const SAMPLE_RATES = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]);

/** Walk RIFF chunks instead of assuming a 44-byte header. Streaming WAV may use unknown sizes. */
function wavInfo(bytes: Buffer, streaming = false): AudioInfo {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new ApiProviderError("format", "invalid PCM WAV audio");
  const declared = bytes.readUInt32LE(4);
  const unknown = streaming && (declared === 0xffffffff || declared === 0);
  if (!unknown && declared + 8 !== bytes.length) throw new ApiProviderError("format", "WAV audio is incomplete or has an invalid container length");
  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let dataBytes = 0;
  let position = 12;
  while (position < bytes.length) {
    if (position + 8 > bytes.length) throw new ApiProviderError("format", "WAV chunk header is incomplete");
    const kind = bytes.toString("ascii", position, position + 4);
    const rawSize = bytes.readUInt32LE(position + 4);
    const size = streaming && kind === "data" && rawSize === 0xffffffff ? bytes.length - position - 8 : rawSize;
    const start = position + 8;
    if (start + size > bytes.length) throw new ApiProviderError("format", "WAV audio is incomplete");
    if (kind === "fmt ") {
      if (size < 16 || format) throw new ApiProviderError("format", "invalid WAV format chunk");
      const tag = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const sampleRate = bytes.readUInt32LE(start + 4);
      const blockAlign = bytes.readUInt16LE(start + 12);
      const bits = bytes.readUInt16LE(start + 14);
      if (tag !== 1 || bits !== 16 || (channels !== 1 && channels !== 2) || !SAMPLE_RATES.has(sampleRate)
        || blockAlign !== channels * 2 || bytes.readUInt32LE(start + 8) !== sampleRate * blockAlign) {
        throw new ApiProviderError("format", "DeepSeek requires 16-bit PCM WAV at a supported sample rate with one or two channels");
      }
      format = { channels, sampleRate, blockAlign };
    } else if (kind === "data") dataBytes += size;
    position = start + size + (size % 2);
  }
  if (!format || !dataBytes || dataBytes % format.blockAlign !== 0 || position !== bytes.length) throw new ApiProviderError("format", "WAV sample data is missing or incomplete");
  return { mime: "audio/wav", channels: format.channels, durationMs: dataBytes / format.blockAlign / format.sampleRate * 1_000 };
}

/** Ogg granule positions use Opus' 48kHz clock, regardless of the source sample rate. */
function oggInfo(bytes: Buffer): AudioInfo {
  let position = 0;
  let serial: number | undefined;
  let channels = 0;
  let preSkip = 0;
  let firstPacket: Buffer[] = [];
  let headRead = false;
  let finalGranule = -1n;
  let ended = false;
  while (position < bytes.length) {
    if (ended || position + 27 > bytes.length || bytes.toString("ascii", position, position + 4) !== "OggS" || bytes[position + 4] !== 0) throw new ApiProviderError("format", "invalid or incomplete Ogg Opus audio");
    const flags = bytes[position + 5];
    const pageSerial = bytes.readUInt32LE(position + 14);
    if (serial === undefined) serial = pageSerial;
    if (serial !== pageSerial) throw new ApiProviderError("format", "chained or multiplexed Ogg audio is not supported");
    const segments = bytes[position + 26];
    const table = position + 27;
    if (table + segments > bytes.length) throw new ApiProviderError("format", "incomplete Ogg segment table");
    let payload = table + segments;
    for (let index = 0; index < segments; index++) {
      const size = bytes[table + index];
      if (payload + size > bytes.length) throw new ApiProviderError("format", "incomplete Ogg audio packet");
      if (!headRead) {
        firstPacket.push(bytes.subarray(payload, payload + size));
        if (size < 255) {
          const head = Buffer.concat(firstPacket); firstPacket = [];
          if (head.length < 19 || head.toString("ascii", 0, 8) !== "OpusHead" || head[8] !== 1 || (head[9] !== 1 && head[9] !== 2)) throw new ApiProviderError("format", "DeepSeek requires Ogg Opus audio, not another Ogg codec");
          channels = head[9]; preSkip = head.readUInt16LE(10); headRead = true;
        }
      }
      payload += size;
    }
    const granule = bytes.readBigUInt64LE(position + 6);
    if (granule !== 0xffffffffffffffffn) finalGranule = granule;
    ended = Boolean(flags & 4);
    position = payload;
  }
  if (!headRead || !ended || finalGranule <= BigInt(preSkip)) throw new ApiProviderError("format", "Ogg Opus audio is incomplete or has no duration");
  const durationMs = Number(finalGranule - BigInt(preSkip)) / 48;
  if (!Number.isFinite(durationMs)) throw new ApiProviderError("format", "invalid Ogg Opus duration");
  return { mime: "audio/ogg", channels, durationMs };
}

function audioInfo(bytes: Buffer): AudioInfo {
  return bytes.toString("ascii", 0, 4) === "OggS" ? oggInfo(bytes) : wavInfo(bytes);
}

function providerError(payload: Record<string, unknown>, operation: string): void {
  if (payload.error !== undefined) throw new ApiProviderError("response", `DeepSeek ${operation} failed`);
}

export function deepSeekSpeechCharacterCount(text: string): number {
  return Array.from(text).reduce((count, character) => count + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0);
}

export interface DeepSeekSpeechProviderOptions extends ApiProviderOptions {
  transport?: () => "http" | "websocket";
  /** Main-process transport injection for isolated, unpaid protocol tests. */
  createWebSocket?: DeepSeekTtsSocketFactory;
}

/** Native speech endpoints do not accept a model, language, prompt or speed parameter. */
export function createDeepSeekSpeechProvider(options: DeepSeekSpeechProviderOptions): SpeechCapabilityProvider {
  const id = options.id ?? "deepseek-speech";
  const getConnection = async () => {
    const connection = await resolveApiConnection(options);
    if (connection.protocol !== "deepseek") throw new ApiProviderError("configuration", "DeepSeek speech requires a DeepSeek service connection");
    return connection;
  };
  return {
    id, label: options.label ?? "DeepSeek 语音",
    get supportsAudioStreaming() { return options.transport?.() === "websocket"; },
    async test() { await getConnection(); return "DeepSeek 语音配置完整；尚未发送音频或合成请求。"; },
    async speechToText(input, context) {
      assertNotAborted(context.signal);
      const connection = await getConnection();
      if (input.language?.trim() || input.prompt?.trim()) throw new ApiProviderError("unsupported", "DeepSeek detects speech language automatically and does not accept language or prompt overrides");
      const bytes = await readTaskFile(input.audioPath, context, 8 * 1024 * 1024, [".wav", ".ogg", ".opus"]);
      const info = audioInfo(bytes);
      if (info.durationMs > 120_000) throw new ApiProviderError("limit", "DeepSeek speech recognition accepts at most 120 seconds; split the audio before transcribing");
      const body = new FormData();
      body.set("file", new Blob([new Uint8Array(bytes)], { type: info.mime }), info.mime === "audio/wav" ? "audio.wav" : "audio.ogg");
      const result = await apiJson(connection, "/v1/tools/asr", { body, signal: context.signal }, options);
      providerError(result, "speech recognition");
      if (typeof result.text !== "string" || typeof result.duration_ms !== "number" || !Number.isFinite(result.duration_ms)
        || result.duration_ms < 0 || result.duration_ms > 120_000) throw new ApiProviderError("response", "DeepSeek returned an invalid transcription");
      const requestId = typeof result.request_id === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(result.request_id) ? result.request_id : undefined;
      return { text: result.text, provider: id, metadata: { durationMs: result.duration_ms, requestId,
        billingUnit: "audio-second", billableSeconds: Math.ceil(result.duration_ms / 1_000), ...(info.channels === 2 ? { channelSelection: "left" } : {}) } };
    },
    async textToSpeech(input, context) {
      assertNotAborted(context.signal);
      const connection = await getConnection();
      const text = requiredText(input.text, "speech text", 50_000);
      const billableCharacters = deepSeekSpeechCharacterCount(text);
      if (billableCharacters > 10_000) throw new ApiProviderError("limit", "DeepSeek speech accepts at most 10,000 billed characters; Chinese characters count as two");
      const voice = input.voice ?? "stella";
      if (voice !== "stella" && voice !== "tide") throw new ApiProviderError("unsupported", "DeepSeek supports the stella and tide voices");
      if (input.rate?.trim() && !["1", "1x", "0%", "+0%"].includes(input.rate.trim())) throw new ApiProviderError("unsupported", "DeepSeek speech does not support speed control");
      // WAV is the native playable output. Raw PCM and raw Opus packets must not be
      // mislabeled as an existing audio artifact container.
      if (input.format !== undefined && input.format !== "wav") throw new ApiProviderError("unsupported", "DeepSeek speech artifacts use WAV; MP3 and Ogg output are not supported");
      const body = JSON.stringify({ text, voice_id: voice, format: "wav", filter_markdown: true });
      if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new ApiProviderError("limit", "DeepSeek speech request exceeds 64 KiB");
      const transport = options.transport?.() ?? "http";
      if (transport === "websocket") {
        const result = await streamDeepSeekSpeech(connection, text, voice, {
          signal: context.signal, audioStream: context.audioStream, createWebSocket: options.createWebSocket,
        });
        assertNotAborted(context.signal);
        return { provider: id,
          items: [{ bytes: result.bytes, mimeType: "audio/wav", fileName: "speech.wav", durationSeconds: result.durationSeconds }],
          metadata: { voice, transport, sampleRate: 24_000, channels: 1, billingUnit: "character", billableCharacters } };
      }
      if (transport !== "http") throw new ApiProviderError("configuration", "DeepSeek speech transport must be HTTP or WebSocket");
      const result = await apiMedia(connection, "/v1/tools/tts", "audio", { body, signal: context.signal, maxBytes: 90 * 1024 * 1024 }, options);
      if (result.mimeType !== "audio/wav") throw new ApiProviderError("response", "DeepSeek did not return WAV speech");
      const info = wavInfo(result.bytes, true);
      if (info.durationMs > 30 * 60_000) throw new ApiProviderError("response", "DeepSeek speech exceeds the maximum duration");
      return { provider: id, requestId: result.requestId,
        items: [{ bytes: result.bytes, mimeType: "audio/wav", fileName: "speech.wav", durationSeconds: info.durationMs / 1_000 }],
        metadata: { voice, transport, billingUnit: "character", billableCharacters } };
    },
  };
}
