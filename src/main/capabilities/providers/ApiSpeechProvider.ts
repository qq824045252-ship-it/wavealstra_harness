import { extname } from "node:path";
import type { SpeechCapabilityProvider, SpeechToTextOutput } from "../BuiltinCapabilityRuntime";
import {
  ApiProviderError, apiJson, apiMedia, assertNotAborted, assertOpenAiShape, audioMime,
  optionalText, readTaskFile, record, requiredText, resolveApiConnection, resolveModel, type ApiProviderOptions,
} from "./ApiServiceConnection";

const AUDIO_INPUTS = [".wav", ".mp3", ".m4a", ".mp4", ".mpeg", ".mpga", ".webm", ".ogg", ".flac"];
const TTS_FORMATS = { mp3: { wire: "mp3", mime: "audio/mpeg" }, wav: { wire: "wav", mime: "audio/wav" }, ogg: { wire: "opus", mime: "audio/ogg" } } as const;

function speechSpeed(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const text = requiredText(value, "speech rate", 40);
  let speed: number;
  if (/^[+-]?\d+(?:\.\d+)?%$/.test(text)) speed = 1 + Number(text.slice(0, -1)) / 100;
  else if (/^\d+(?:\.\d+)?x?$/.test(text)) speed = Number(text.replace(/x$/, ""));
  else throw new ApiProviderError("unsupported", "speech rate must be a multiplier or a relative percentage");
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new ApiProviderError("input", "speech rate must be between 0.25 and 4");
  return speed;
}

function transcript(payload: Record<string, unknown>, provider: string): SpeechToTextOutput {
  if (typeof payload.text !== "string") throw new ApiProviderError("response", "transcription text is missing");
  let language: string | undefined;
  if (typeof payload.language === "string") language = payload.language;
  else if (Array.isArray(payload.languages) && payload.languages.length === 1) {
    const detected = record(payload.languages[0]);
    if (typeof detected.code === "string") language = detected.code;
  }
  let segments: SpeechToTextOutput["segments"];
  if (payload.segments !== undefined) {
    if (!Array.isArray(payload.segments)) throw new ApiProviderError("response", "invalid transcription segments");
    segments = payload.segments.map(value => {
      const segment = record(value);
      if (typeof segment.text !== "string" || typeof segment.start !== "number" || typeof segment.end !== "number"
        || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
        throw new ApiProviderError("response", "invalid transcription segments");
      }
      return { text: segment.text, start: segment.start, end: segment.end };
    });
  }
  return { text: payload.text, provider, ...(language !== undefined ? { language } : {}), ...(segments ? { segments } : {}) };
}

export function createApiSpeechProvider(options: ApiProviderOptions): SpeechCapabilityProvider {
  const id = options.id ?? "api-speech";
  return {
    id, label: options.label ?? "语音 API",
    async test() {
      const connection = await resolveApiConnection(options);
      assertOpenAiShape(connection);
      resolveModel(connection);
      return "配置完整；未上传音频或合成语音，实际服务与模型尚未试用。";
    },
    async speechToText(input, context) {
      assertNotAborted(context.signal);
      const connection = await resolveApiConnection(options);
      assertOpenAiShape(connection);
      const model = resolveModel(connection, input.model);
      const language = optionalText(input.language, "language", 40);
      const prompt = optionalText(input.prompt, "transcription prompt", 2_000);
      const bytes = await readTaskFile(input.audioPath, context, 25 * 1024 * 1024, AUDIO_INPUTS);
      const mimeType = audioMime(bytes);
      if (!mimeType) throw new ApiProviderError("format", "invalid or unsupported audio file");
      const body = new FormData();
      // Do not send local basenames: they may contain personal information.
      body.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), `audio${extname(input.audioPath).toLowerCase()}`);
      body.set("model", model);
      // Basic text is the shared contract. Timestamps/diarization are never fabricated.
      body.set("response_format", "json");
      if (language !== undefined) body.set("language", language);
      if (prompt !== undefined) body.set("prompt", prompt);
      return transcript(await apiJson(connection, "/audio/transcriptions", { body, signal: context.signal }, options), id);
    },
    async textToSpeech(input, context) {
      assertNotAborted(context.signal);
      const connection = await resolveApiConnection(options);
      assertOpenAiShape(connection);
      const model = resolveModel(connection, input.model);
      const text = requiredText(input.text, "speech text", 50_000);
      const voice = requiredText(input.voice, "voice", 200);
      const speed = speechSpeed(input.rate);
      const format = input.format ?? connection.speechFormat ?? "mp3";
      if (!Object.hasOwn(TTS_FORMATS, format)) throw new ApiProviderError("unsupported", "unsupported speech output format");
      const requested = TTS_FORMATS[format];
      const result = await apiMedia(connection, "/audio/speech", "audio", {
        body: JSON.stringify({ model, input: text, voice, response_format: requested.wire, ...(speed !== undefined ? { speed } : {}) }),
        signal: context.signal, maxBytes: 64 * 1024 * 1024,
      }, options);
      if (result.mimeType !== requested.mime) throw new ApiProviderError("response", "speech output does not match the requested format");
      return { provider: id, model, requestId: result.requestId, items: [{ bytes: result.bytes, mimeType: result.mimeType, fileName: `speech.${format}` }] };
    },
  };
}
