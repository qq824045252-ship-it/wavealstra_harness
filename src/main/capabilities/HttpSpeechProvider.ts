import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { BuiltinCapabilityRuntime, SpeechCapabilityProvider, SpeechToTextOutput } from "./BuiltinCapabilityRuntime";
import { recognitionRequest } from "./HttpRecognitionService";

export const HTTP_ASR_MAX_BYTES = 10 * 1024 * 1024;
export const HTTP_ASR_MAX_SECONDS = 120;

/** PCM WAV only: duration is measured from the file, never trusted from the caller. */
export function wavDuration(bytes: Buffer): number {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("format: PCM WAV required");
  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error("format: truncated WAV");
    const chunk = bytes.toString("ascii", offset, offset + 4);
    if (chunk === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(offset + 8) !== 1) throw new Error("format: PCM WAV required");
      byteRate = bytes.readUInt32LE(offset + 16);
    }
    if (chunk === "data") dataSize += size;
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error("format: missing WAV audio");
  return dataSize / byteRate;
}

export function createHttpSpeechProvider(runtime: BuiltinCapabilityRuntime): SpeechCapabilityProvider {
  return {
    id: "http-asr", label: "HTTP ASR · short WAV",
    async test() {
      runtime.recognitionService("speech-to-text", "http-asr");
      return "配置完整；未上传音频，连通/认证、模型、实际转写均未验证。用 speech_to_text 显式试运行。";
    },
    async speechToText(input, context): Promise<SpeechToTextOutput> {
      const config = runtime.recognitionService("speech-to-text", "http-asr");
      if (extname(input.audioPath).toLowerCase() !== ".wav") throw new Error("format: only PCM .wav supported; no transcoding");
      if ((await stat(input.audioPath)).size > HTTP_ASR_MAX_BYTES) throw new Error("limit: WAV exceeds 10 MiB");
      const bytes = await readFile(input.audioPath);
      if (wavDuration(bytes) > HTTP_ASR_MAX_SECONDS) throw new Error("limit: audio exceeds 120 seconds; long meeting segmentation unsupported");
      const body = new FormData();
      body.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), basename(input.audioPath));
      body.set("model", config.model);
      body.set("response_format", "verbose_json");
      if (input.language) body.set("language", input.language);
      if (input.prompt) body.set("prompt", input.prompt);
      const result = await recognitionRequest(config, config.credentialRef ? runtime.credentials.get(config.credentialRef) : null, body, context.signal) as { text: string; language?: string; segments?: SpeechToTextOutput["segments"] };
      if (typeof result.text !== "string") throw new Error("response: ASR text missing");
      runtime.recordRecognitionRun("speech-to-text");
      return { text: result.text, language: result.language, segments: result.segments, provider: "http-asr" };
    },
  };
}
