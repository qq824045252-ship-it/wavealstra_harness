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
