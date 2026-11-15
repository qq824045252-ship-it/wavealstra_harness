import type { SpeechStreamScope } from "./speech-stream";

/** Presentation data from a host tool result; never synthesized from assistant prose. */
export type CapabilityResult =
  | { kind: "ocr"; text: string; provider?: string; pages?: Array<{ index: number; text: string; finishReason?: string }>;
      pageCount?: number; truncated?: boolean; purpose?: string }
  | { kind: "transcript"; text: string; provider?: string; language?: string; durationMs?: number;
      billableSeconds?: number; channelSelection?: string; segments?: Array<{ start: number; end: number; text: string }> }
  | { kind: "speech"; stream?: SpeechStreamScope; artifacts: Array<{ id: string; name: string; durationSeconds?: number }>;
      provider?: string; voice?: string; transport?: "http" | "websocket"; durationSeconds?: number; billableCharacters?: number };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function capabilityResultFromDetails(tool: string, details: unknown): CapabilityResult | undefined {
  const result = object(details);
  if (!result || result.error) return undefined;
  const provider = text(result.provider);
  const metadata = object(result.metadata);
  if (tool === "ocr_file" && typeof result.text === "string") {
    const pages = Array.isArray(result.pages) ? result.pages.flatMap(value => {
      const page = object(value);
      return page && number(page.index) !== undefined && typeof page.text === "string"
        ? [{ index: page.index as number, text: page.text, finishReason: text(page.finishReason) }] : [];
    }) : undefined;
    return { kind: "ocr", text: result.text, provider, pages, pageCount: number(result.pageCount),
      truncated: result.truncated === true, purpose: text(result.purpose) };
  }
  if (tool === "speech_to_text" && typeof result.text === "string") {
    const segments = Array.isArray(result.segments) ? result.segments.flatMap(value => {
      const segment = object(value);
      return segment && number(segment.start) !== undefined && number(segment.end) !== undefined && typeof segment.text === "string"
        ? [{ start: segment.start as number, end: segment.end as number, text: segment.text }] : [];
    }) : undefined;
    return { kind: "transcript", text: result.text, provider, language: text(result.language), segments,
      durationMs: number(metadata?.durationMs), billableSeconds: number(metadata?.billableSeconds), channelSelection: text(metadata?.channelSelection) };
  }
  if (tool === "text_to_speech") {
    const presentation = object(result.capabilityResult);
    const stream = object(presentation?.stream);
    const scope = stream && ["taskId", "messageId", "toolCallId", "streamId"].every(key => typeof stream[key] === "string" && stream[key])
      ? stream as unknown as SpeechStreamScope : undefined;
    const artifacts = Array.isArray(presentation?.artifacts) ? presentation.artifacts.flatMap(value => {
      const artifact = object(value);
      return artifact && typeof artifact.id === "string" && artifact.id && typeof artifact.name === "string"
        ? [{ id: artifact.id, name: artifact.name, durationSeconds: number(artifact.durationSeconds) }] : [];
    }) : Array.isArray(result.artifactIds) ? result.artifactIds.filter((id): id is string => typeof id === "string" && Boolean(id)).map(id => ({ id, name: "合成语音" })) : [];
    if (!scope && !artifacts.length && presentation?.kind !== "speech") return undefined;
    return { kind: "speech", stream: scope, artifacts, provider, voice: text(metadata?.voice),
      transport: metadata?.transport === "websocket" ? "websocket" : metadata?.transport === "http" ? "http" : undefined,
      durationSeconds: number(presentation?.durationSeconds), billableCharacters: number(metadata?.billableCharacters) };
  }
  return undefined;
}
