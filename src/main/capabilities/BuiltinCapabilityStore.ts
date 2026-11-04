import { normalizeConsultConfig } from "../../shared/multi-model-consult";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_BUILTIN_CAPABILITIES_CONFIG,
  type BuiltinCapabilitiesConfigDto,
} from "../../shared/builtin-capabilities";
import { getMyBuddyDir } from "../paths";
import { MEDIA_CAPABILITY_IDS, type ApiCapabilityConnection, type MediaCapabilityBinding, type MediaCapabilityId } from "../../shared/media-capabilities";

const CONFIG_FILE = "capabilities.json";

function cloneDefaults(): BuiltinCapabilitiesConfigDto {
  return structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeConnections(raw: BuiltinCapabilitiesConfigDto["connections"]): Record<string, ApiCapabilityConnection> {
  const connections: Record<string, ApiCapabilityConnection> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return connections;
  for (const [id, item] of Object.entries(raw)) {
    if (!/^api-[a-z0-9-]{1,80}$/i.test(id) || !item || typeof item !== "object") continue;
    if (item.protocol !== "openai-compatible" && item.protocol !== "mistral-ocr") continue;
    connections[id] = {
      name: cleanOptionalText(item.name, 100) ?? "API 服务",
      protocol: item.protocol,
      baseUrl: cleanOptionalText(item.baseUrl, 2000) ?? "",
      auth: item.auth === "none" ? "none" : "api-key",
      credentialRef: cleanOptionalText(item.credentialRef, 100),
      timeoutMs: Number.isFinite(item.timeoutMs) ? Math.max(1000, Math.min(600_000, item.timeoutMs)) : 120_000,
    };
  }
  return connections;
}

function normalizeBindings(raw: BuiltinCapabilitiesConfigDto["mediaBindings"]): Partial<Record<MediaCapabilityId, MediaCapabilityBinding>> {
  const bindings: Partial<Record<MediaCapabilityId, MediaCapabilityBinding>> = {};
  if (!raw || typeof raw !== "object") return bindings;
  for (const capability of MEDIA_CAPABILITY_IDS) {
    const item = raw[capability];
    if (!item || typeof item !== "object") continue;
    bindings[capability] = {
      connectionId: cleanOptionalText(item.connectionId, 200) ?? "",
      model: cleanOptionalText(item.model, 300),
      selection: item.selection === "auto" && capability === "image-generation" ? "auto" : "manual",
      dataPolicy: item.dataPolicy === "local-only" ? "local-only" : item.dataPolicy === "allow-cloud" ? "allow-cloud" : undefined,
    };
  }
  return bindings;
}

function normalize(raw: unknown): BuiltinCapabilitiesConfigDto {
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const value = raw as Partial<BuiltinCapabilitiesConfigDto>;
  // This file intentionally supports only the current schema.  An unknown
  // version is not guessed or migrated: defaults are safer than a partial
  // capability/permission configuration.
  if (value.schemaVersion !== 1) return cloneDefaults();
  const defaults = cloneDefaults();
  return {
    schemaVersion: 1,
    connections: normalizeConnections(value.connections),
    // An old schema-v1 file without bindings keeps its selected providers and
    // explicit disabled flags. Only genuinely new defaults opt into auto image selection.
    mediaBindings: normalizeBindings(value.mediaBindings),
    services: value.services ?? {},
    ocr: value.ocr ?? { enabled: false },
    web: { enabled: value.web?.enabled !== false },
    vision: {
      enabled: value.vision?.enabled !== false,
      model: cleanOptionalText(value.vision?.model, 300),
    },
    imageGeneration: {
      enabled: value.imageGeneration?.enabled !== false,
      provider: cleanOptionalText(value.imageGeneration?.provider, 100) ?? defaults.imageGeneration.provider,
      model: cleanOptionalText(value.imageGeneration?.model, 300) ?? defaults.imageGeneration.model,
    },
    videoGeneration: {
      enabled: value.videoGeneration?.enabled !== false,
      provider: cleanOptionalText(value.videoGeneration?.provider, 100),
      model: cleanOptionalText(value.videoGeneration?.model, 300),
    },
    speechToText: {
      serviceId: cleanOptionalText(value.speechToText?.serviceId, 100),
      enabled: value.speechToText?.enabled !== false,
      provider: cleanOptionalText(value.speechToText?.provider, 100) ?? defaults.speechToText.provider,
    },
    textToSpeech: {
      enabled: value.textToSpeech?.enabled !== false,
      provider: cleanOptionalText(value.textToSpeech?.provider, 100),
      model: cleanOptionalText(value.textToSpeech?.model, 300),
      voice: cleanOptionalText(value.textToSpeech?.voice, 200),
      rate: cleanOptionalText(value.textToSpeech?.rate, 40),
    },
    browser: { enabled: value.browser?.enabled !== false },
    diagnostics: { enabled: value.diagnostics?.enabled ?? value.browser?.enabled !== false },
    execution: {
      terminalEnabled: value.execution?.terminalEnabled !== false,
      codeExecutionEnabled: value.execution?.codeExecutionEnabled !== false,
    },
    subagent: { enabled: value.subagent?.enabled !== false },
    multiModelConsult: normalizeConsultConfig(value.multiModelConsult),
  };
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  let fd: number | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(temporary, "w");
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export class BuiltinCapabilityStore {
  readonly path: string;

  constructor(path = join(getMyBuddyDir(), CONFIG_FILE)) {
    this.path = path;
  }

  read(): BuiltinCapabilitiesConfigDto {
    if (!existsSync(this.path)) return cloneDefaults();
    try {
      return normalize(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      console.warn("[BuiltinCapabilityStore] invalid capabilities.json; using defaults", error);
      return cloneDefaults();
    }
  }

  write(config: BuiltinCapabilitiesConfigDto): BuiltinCapabilitiesConfigDto {
    const next = normalize(config);
    writeAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
