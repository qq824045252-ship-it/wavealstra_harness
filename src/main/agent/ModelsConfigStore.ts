import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getModelsPath } from "../paths";
import type { ModelInputLimits } from "@earendil-works/pi-ai";
import type { ModelsModelConfigDto } from "../../shared/agent-ipc";

export { resolveThinkingLevels } from "../../shared/thinking-levels";

/** Pi models.json model definition. Keep only fields accepted by Pi. */
export interface ModelsModelConfig {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  inputLimits?: ModelInputLimits;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      inputTokensAbove: number;
    }>;
  };
  promptCache?: { short?: number; long?: number };
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: ModelsModelConfigDto["samplingParamsByThinkingLevel"];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** Pi models.json provider definition. */
export interface ModelsProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  oauth?: "radius";
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelsModelConfig[];
  modelOverrides?: Record<string, Record<string, unknown>>;
}

export interface ModelsFileConfig {
  providers: Record<string, ModelsProviderConfig>;
}

// This is an editor boundary, not a model catalog. Pi validates these fields.
const EDITABLE_MODEL_FIELDS = [
  "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "inputLimits",
  "cost", "promptCache", "contextWindow", "maxTokens", "samplingParams", "samplingParamsByThinkingLevel", "compat",
] as const;

export function projectModelConfig(model: ModelsModelConfig): ModelsModelConfigDto {
  const projected: Record<string, unknown> = { id: model.id };
  for (const key of EDITABLE_MODEL_FIELDS) {
    if (model[key] !== undefined) projected[key] = model[key];
  }
  return projected as unknown as ModelsModelConfigDto;
}

/** Replace editable fields while retaining headers and unknown native fields. */
export function mergeModelConfig(
  previous: ModelsModelConfig | undefined,
  incoming: ModelsModelConfigDto,
): ModelsModelConfig {
  const merged: Record<string, unknown> = { ...previous, id: incoming.id.trim() };
  for (const key of EDITABLE_MODEL_FIELDS) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
    else delete merged[key];
  }
  return merged as unknown as ModelsModelConfig;
}

/** Thin file access for Pi's own models.json. No migration, projection, or alternate schema. */
export class ModelsConfigStore {
  getPath(): string {
    return getModelsPath();
  }

  read(): ModelsFileConfig {
    const path = getModelsPath();
    if (!existsSync(path)) return { providers: {} };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("providers" in raw)) {
      throw new Error("models.json 不是 Pi 原生 providers 格式");
    }
    const providers = (raw as { providers?: unknown }).providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("models.json 缺少 Pi providers 对象");
    }
    return raw as ModelsFileConfig;
  }

  write(config: ModelsFileConfig): void {
    const path = getModelsPath();
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      renameSync(tmp, path);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup failure
      }
      throw error;
    }
  }
}
