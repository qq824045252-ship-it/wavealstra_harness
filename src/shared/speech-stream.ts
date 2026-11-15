/** Audio is transient IPC data. It must never enter the model transcript or durable history. */
export interface SpeechStreamScope {
  taskId: string;
  messageId: string;
  toolCallId: string;
  streamId: string;
}

export type SpeechProviderAudioEvent =
  | { type: "start"; format: "pcm_s16le"; sampleRate: 24000; channels: 1 }
  | { type: "chunk"; audio: Uint8Array }
  | { type: "finish" }
  | { type: "error"; code: string; message: string };

export type SpeechAudioEvent = SpeechStreamScope & (
  | { kind: "start"; format: "pcm_s16le"; sampleRate: 24000; channels: 1 }
  | { kind: "chunk"; sequence: number; pcmBase64: string }
  | { kind: "complete" }
  | { kind: "error"; error: string }
  | { kind: "cancelled" }
);

export interface SpeechCancelRequest { streamId: string; taskId: string; toolCallId: string }
export const SpeechIpc = { audio: "speech:audio", cancel: "speech:cancel" } as const;
