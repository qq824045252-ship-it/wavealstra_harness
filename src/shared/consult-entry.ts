import { normalizeConsultConfig } from "./multi-model-consult";

export type ConsultEntryReadiness =
  | { ready: true }
  | { ready: false; notice: string };

/** A missing/invalid IPC result is not evidence that the user has no configuration. */
export function consultEntryReadiness(raw: unknown): ConsultEntryReadiness {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("未能读取多模型会诊配置，请重试；已有配置不会被修改。");
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.participants)) {
    throw new Error("多模型会诊配置返回不完整，请重试；已有配置不会被修改。");
  }
  const config = normalizeConsultConfig(value);
  if (!config.enabled) {
    return { ready: false, notice: "多模型会诊尚未启用。可打开配置启用，并保存后返回本条消息。" };
  }
  if (config.participants.length < 2) {
    return { ready: false, notice: "多模型会诊需要至少两个参与者（不同模型，或同一模型的不同思考等级）。请选择后点击“保存能力配置”。" };
  }
  return { ready: true };
}
