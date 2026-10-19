import { existsSync, readFileSync } from "node:fs";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";
import type { PermissionMode, DiskSpaceDto } from "../shared/agent-ipc";
import {
  normalizeExternalAgentConfigOptions,
  normalizeExternalAgentConfigSelections,
  normalizeExternalAgentPermissionPolicies,
  type ExternalAgentConfigOptionDto,
  type ExternalAgentPermissionPolicy,
} from "../shared/external-agent";
import { normalizeModelPreferences, type ModelPreferencesDto } from "../shared/model-metadata";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { migrateLegacyShellPreferences, normalizeTerminalShellPath } from "./agent-shell-settings";
import { DEFAULT_CODE_THEME, normalizeCodeTheme, type CodeThemeId } from "../shared/code-theme";
import {
  DEFAULT_ISOLATION_LEVEL,
  normalizeIsolationLevel,
  type IsolationLevel,
} from "./security/TaskExecutionIsolation";
import {
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_COMPACTION_TRIGGER_TOKENS,
  normalizeCompactionTriggerTokens,
  normalizeCompactionTriggerRatio,
} from "../shared/compaction-policy";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferencesDto,
} from "../shared/notification";

// statfsSync 可能在某些 Electron 版本中不可用，按需加载
let _statfsSync: typeof import("node:fs")["statfsSync"] | undefined;
try {
  _statfsSync = require("node:fs").statfsSync;
} catch {
  // ignore
}

export interface AppSettings {
  language: string;
  permissionMode: PermissionMode;
  defaultModelId: string;
  proxyUrl: string;
  memoryEnabled: boolean;
  /** External Agent Memory Gateway master switch (loopback only). */
  memoryGatewayEnabled: boolean;
  /** Master write gate; each delegated grant must also be read-write. */
  memoryGatewayWriteEnabled: boolean;
  /** Loopback HTTP/MCP port. */
  memoryGatewayPort: number;
  /** Android/Mobile Remote Access，默认关闭且只监听 loopback。 */
  remoteAccessEnabled: boolean;
  remoteAccessPort: number;
  remoteAccessBaseUrl: string;
  remoteAccessBindMode: "loopback" | "lan";
  theme: "light" | "dark" | "system";
  /** UI projection of Pi modelThinkingLevels; never persisted as product state. */
  modelPreferences?: ModelPreferencesDto;
  /** Resume selections only; Pi enabledModels remains the runtime authority. */
  pausedProviderModels?: Record<string, string[]>;
  /** 是否按场景模式过滤技能目录（默认开启） */
  skillModeFilterEnabled: boolean;
  /** 点击关闭窗口时最小化到系统托盘（默认开启） */
  closeToTray: boolean;
  /** 统一通知中心 / 桌面通知策略。 */
  notificationPreferences: NotificationPreferencesDto;
  /**
   * 界面缩放百分比（75–150，默认 100）。
   * 兼容旧版离散档 0–4（会在 read 时迁移为 85/92/100/110/125）。
   */
  fontSize: number;
  /** 旧版字体族；仅用于迁移。 */
  fontFamily: string;
  /** 界面真实字号（px），不使用 CSS zoom。 */
  uiFontSize: number;
  /** 代码/终端真实字号（px）。 */
  codeFontSize: number;
  /** 界面字体族；空字符串 = 系统默认。 */
  uiFontFamily: string;
  /** 代码字体族；空字符串 = 系统等宽字体。 */
  codeFontFamily: string;
  /** 代码块语法高亮主题。 */
  codeTheme: CodeThemeId;
  /**
   * Shell 执行隔离等级（P2）。
   * 默认 guarded；os-sandbox 为实验性加固，须显式开启，不得默认打开。
   */
  shellIsolationLevel: IsolationLevel;
  /** Interactive terminal only; empty uses the platform default. Pi shellPath is reserved for Bash. */
  terminalShellPath: string;
  /**
   * 任务级 Active Connector 持久化（F3：无新 DB schema，复用 settings.json 可扩展字段）。
   * taskId → 激活连接器 id 列表。
   */
  taskConnectorIds?: Record<string, string[]>;
  /**
   * 上下文压缩触发比例（0.1–0.9，默认 0.8）：
   * 会话上下文达到「模型窗口 × 该比例」时自动压缩（reserveTokens = 窗口 × (1 − 比例)）。
   * 按当前会话模型窗口动态计算，不同上下文窗口的模型均在同一比例触发。
   */
  compactionTriggerRatio?: number;
  /** Absolute token threshold; null disables it. Combined with ratio using OR. */
  compactionTriggerTokens?: number | null;
  /**
   * 对话分支（Branch in new task）灰度开关（实施规划 §15.1）。
   * 默认关闭；验收通过后默认开启。
   */
  conversationBranchEnabled?: boolean;
  /** ACP 管理页显式停用的外部 Agent id；缺省/空数组 = 全部启用。 */
  disabledExternalAgentIds?: string[];
  /** ACP 会话选项偏好：agentId → configId → value（select valueId 或 boolean）。 */
  externalAgentConfigSelections?: Record<string, Record<string, string | boolean>>;
  /** 各 ACP Agent 最近探测到的会话选项快照（设置页下拉数据源）。 */
  externalAgentConfigOptions?: Record<string, ExternalAgentConfigOptionDto[]>;
  /** ACP 权限策略：agentId → ask | auto-allow | auto-deny（缺省 ask）。 */
  externalAgentPermissionPolicies?: Record<string, ExternalAgentPermissionPolicy>;
}

export {
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_COMPACTION_TRIGGER_TOKENS,
  normalizeCompactionTriggerTokens,
  normalizeCompactionTriggerRatio,
} from "../shared/compaction-policy";

/** 旧版 5 档 → 百分比 */
const LEGACY_FONT_SIZE_PCT = [85, 92, 100, 110, 125] as const;

/** 默认界面缩放（百分比） */
export const DEFAULT_FONT_SCALE = 105;
export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 13;

function normalizeUiFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_UI_FONT_SIZE;
  return Math.min(20, Math.max(12, Math.round(raw)));
}

function normalizeCodeFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CODE_FONT_SIZE;
  return Math.min(20, Math.max(12, Math.round(raw)));
}

function legacyScaleToUiFontSize(raw: unknown): number {
  const pct = normalizeFontScale(raw);
  return normalizeUiFontSize(Math.round((14 * pct) / 100));
}

/** 将 settings 中的 fontSize 规范为 75–150 的百分比 */
export function normalizeFontScale(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_FONT_SCALE;
  // 旧版离散 0–4
  if (Number.isInteger(raw) && raw >= 0 && raw <= 4) {
    return LEGACY_FONT_SIZE_PCT[raw] ?? DEFAULT_FONT_SCALE;
  }
  return Math.min(150, Math.max(75, Math.round(raw)));
}

const DEFAULTS: AppSettings = {
  language: "zh-CN",
  permissionMode: "default",
  defaultModelId: "",
  proxyUrl: "",
  memoryEnabled: true,
  memoryGatewayEnabled: false,
  memoryGatewayWriteEnabled: false,
  memoryGatewayPort: 3351,
  remoteAccessEnabled: false,
  remoteAccessPort: 3352,
  remoteAccessBaseUrl: "",
  remoteAccessBindMode: "loopback",
  theme: "system",
  modelPreferences: {},
  skillModeFilterEnabled: true,
  closeToTray: true,
  notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  fontSize: DEFAULT_FONT_SCALE,
  fontFamily: "",
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  uiFontFamily: "",
  codeFontFamily: "",
  codeTheme: DEFAULT_CODE_THEME,
  shellIsolationLevel: DEFAULT_ISOLATION_LEVEL,
  terminalShellPath: "",
  compactionTriggerRatio: DEFAULT_COMPACTION_TRIGGER_RATIO,
  compactionTriggerTokens: DEFAULT_COMPACTION_TRIGGER_TOKENS,
  conversationBranchEnabled: false,
};

export function getSettingsPath(): string {
  return join(getMyBuddyDir(), "settings.json");
}

/**
 * 安全原子写（收口）：同目录临时文件 + flush/close + rename 替换（Windows 兼容，rename 可替换
 * 已存在目标）。失败时清理临时文件并抛错，原文件绝不被截断（旧 writeFileSync 直接截断目标，
 * 崩溃窗口会把 settings.json 写成空/半文件）。
 */
function writeSettingsAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeFileSync(fd, data, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export class AppSettingsStore {
  read(): AppSettings {
    const path = getSettingsPath();
    this.recoverStaleTmp(path);
    if (!existsSync(path)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<AppSettings> & Record<string, unknown>;
      const merged = { ...DEFAULTS, ...migrateLegacyShellPreferences(raw).settings } as AppSettings;
      delete (merged as AppSettings & Record<string, unknown>).backupFiles;
      const piSettings = SettingsManager.create(process.cwd(), getMyBuddyDir());
      const piDefaultProvider = piSettings.getDefaultProvider();
      const piDefaultModel = piSettings.getDefaultModel();
      merged.defaultModelId = piDefaultProvider && piDefaultModel
        ? `${piDefaultProvider}/${piDefaultModel}`
        : "";
      merged.fontSize = normalizeFontScale(merged.fontSize);
      merged.uiFontSize = raw.uiFontSize === undefined
        ? legacyScaleToUiFontSize(raw.fontSize)
        : normalizeUiFontSize(raw.uiFontSize);
      merged.codeFontSize = normalizeCodeFontSize(raw.codeFontSize);
      merged.uiFontFamily = typeof raw.uiFontFamily === "string"
        ? raw.uiFontFamily
        : typeof raw.fontFamily === "string"
          ? raw.fontFamily
          : "";
      merged.codeFontFamily = typeof raw.codeFontFamily === "string" ? raw.codeFontFamily : "";
      merged.codeTheme = normalizeCodeTheme(raw.codeTheme);
      merged.memoryGatewayEnabled = merged.memoryGatewayEnabled === true;
      merged.memoryGatewayWriteEnabled = merged.memoryGatewayWriteEnabled === true;
      merged.memoryGatewayPort = Number.isInteger(merged.memoryGatewayPort) && merged.memoryGatewayPort >= 1024 && merged.memoryGatewayPort <= 65535
        ? merged.memoryGatewayPort
        : 3351;
      merged.remoteAccessEnabled = merged.remoteAccessEnabled === true;
      merged.remoteAccessPort = Number.isInteger(merged.remoteAccessPort) && merged.remoteAccessPort >= 1024 && merged.remoteAccessPort <= 65535
        ? merged.remoteAccessPort
        : 3352;
      merged.remoteAccessBaseUrl = typeof merged.remoteAccessBaseUrl === "string" ? merged.remoteAccessBaseUrl.trim() : "";
      merged.remoteAccessBindMode = merged.remoteAccessBindMode === "lan" ? "lan" : "loopback";
      merged.fontFamily = typeof merged.fontFamily === "string" ? merged.fontFamily : "";
      merged.notificationPreferences = normalizeNotificationPreferences(merged.notificationPreferences);
      merged.disabledExternalAgentIds = Array.isArray(merged.disabledExternalAgentIds)
        ? [...new Set(merged.disabledExternalAgentIds.map((id) => String(id).trim()).filter(Boolean))]
        : undefined;
      merged.externalAgentConfigSelections = normalizeExternalAgentConfigSelections(raw.externalAgentConfigSelections);
      merged.externalAgentConfigOptions = normalizeExternalAgentConfigOptions(raw.externalAgentConfigOptions);
      merged.externalAgentPermissionPolicies = normalizeExternalAgentPermissionPolicies(raw.externalAgentPermissionPolicies);
      merged.modelPreferences = Object.fromEntries(Object.entries(piSettings.getAllModelThinkingLevels())
        .map(([modelId, effort]) => [modelId, { reasoning: { effort } }]));
      // Legacy global thinkingLevel is intentionally dropped: it cannot be safely mapped without model-native reasoning metadata.
      delete (merged as AppSettings & Record<string, unknown>).thinkingLevel;
      merged.shellIsolationLevel = normalizeIsolationLevel(merged.shellIsolationLevel);
      merged.terminalShellPath = normalizeTerminalShellPath(merged.terminalShellPath);
      merged.compactionTriggerRatio = normalizeCompactionTriggerRatio(merged.compactionTriggerRatio);
      merged.compactionTriggerTokens = normalizeCompactionTriggerTokens(merged.compactionTriggerTokens);
      merged.conversationBranchEnabled = merged.conversationBranchEnabled === true;
      return merged;
    } catch {
      // 损坏：轮换保留最近两代损坏副本（.corrupt.bak 最新、.corrupt.bak.1 上一代，数量有界），
      // 告警后安全回退默认；绝不静默覆盖原文件 —— 后续原子写会替换损坏文件，副本可人工恢复。
      try {
        const backup = `${path}.corrupt.bak`;
        const prev = `${backup}.1`;
        if (existsSync(backup)) {
          try {
            rmSync(prev, { force: true });
            renameSync(backup, prev);
          } catch {
            /* 轮换失败仍保留当前 bak */
          }
        }
        copyFileSync(path, backup);
      } catch {
        /* 备份失败不阻断回退 */
      }
      console.warn(
        `[AppSettingsStore] settings.json 解析失败，已回退默认值（损坏副本保留于 ${path}.corrupt.bak）`,
      );
      return { ...DEFAULTS };
    }
  }

  write(partial: Partial<AppSettings>): AppSettings {
    const next = { ...this.read(), ...partial };
    delete (next as AppSettings & Record<string, unknown>).backupFiles;
    if (partial.memoryGatewayPort !== undefined) {
      next.memoryGatewayPort = Number.isInteger(partial.memoryGatewayPort) && partial.memoryGatewayPort >= 1024 && partial.memoryGatewayPort <= 65535
        ? partial.memoryGatewayPort
        : 3351;
    }
    if (partial.remoteAccessPort !== undefined) {
      next.remoteAccessPort = Number.isInteger(partial.remoteAccessPort) && partial.remoteAccessPort >= 1024 && partial.remoteAccessPort <= 65535
        ? partial.remoteAccessPort
        : 3352;
    }
    if (partial.remoteAccessBaseUrl !== undefined) {
      next.remoteAccessBaseUrl = typeof partial.remoteAccessBaseUrl === "string" ? partial.remoteAccessBaseUrl.trim() : "";
    }
    if (partial.remoteAccessBindMode !== undefined) {
      next.remoteAccessBindMode = partial.remoteAccessBindMode === "lan" ? "lan" : "loopback";
    }
    if (partial.fontSize !== undefined) {
      next.fontSize = normalizeFontScale(partial.fontSize);
    }
    if (partial.uiFontSize !== undefined) {
      next.uiFontSize = normalizeUiFontSize(partial.uiFontSize);
    }
    if (partial.codeFontSize !== undefined) {
      next.codeFontSize = normalizeCodeFontSize(partial.codeFontSize);
    }
    if (partial.uiFontFamily !== undefined) {
      next.uiFontFamily = typeof partial.uiFontFamily === "string" ? partial.uiFontFamily : "";
    }
    if (partial.codeFontFamily !== undefined) {
      next.codeFontFamily = typeof partial.codeFontFamily === "string" ? partial.codeFontFamily : "";
    }
    if (partial.codeTheme !== undefined) {
      next.codeTheme = normalizeCodeTheme(partial.codeTheme);
    }
    if (partial.notificationPreferences !== undefined) {
      next.notificationPreferences = normalizeNotificationPreferences(partial.notificationPreferences);
    }
    if (partial.disabledExternalAgentIds !== undefined) {
      next.disabledExternalAgentIds = [...new Set((partial.disabledExternalAgentIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    }
    if (partial.externalAgentConfigSelections !== undefined) {
      next.externalAgentConfigSelections = normalizeExternalAgentConfigSelections(partial.externalAgentConfigSelections);
    }
    if (partial.externalAgentConfigOptions !== undefined) {
      next.externalAgentConfigOptions = normalizeExternalAgentConfigOptions(partial.externalAgentConfigOptions);
    }
    delete (next as AppSettings & Record<string, unknown>).thinkingLevel;
    if (partial.shellIsolationLevel !== undefined) {
      next.shellIsolationLevel = normalizeIsolationLevel(partial.shellIsolationLevel);
    }
    if (partial.terminalShellPath !== undefined) {
      next.terminalShellPath = normalizeTerminalShellPath(partial.terminalShellPath);
    }
    if (partial.compactionTriggerRatio !== undefined) {
      next.compactionTriggerRatio = normalizeCompactionTriggerRatio(partial.compactionTriggerRatio);
    }
    if (partial.compactionTriggerTokens !== undefined) {
      next.compactionTriggerTokens = normalizeCompactionTriggerTokens(partial.compactionTriggerTokens);
    }
    const persisted = { ...next } as Record<string, unknown>;
    delete persisted.defaultModelId;
    delete persisted.modelPreferences;
    // Until startup migration has succeeded, retain the inert legacy source.
    // Consumers read only the Pi projection above.
    const legacy = this.readLegacyModelPreferences();
    if (Object.keys(legacy).length) persisted.modelPreferences = legacy;
    writeSettingsAtomic(getSettingsPath(), `${JSON.stringify(persisted, null, 2)}\n`);
    return next;
  }

  readLegacyModelPreferences(): ModelPreferencesDto {
    try {
      const raw = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      return normalizeModelPreferences(raw.modelPreferences);
    } catch { return {}; }
  }

  /** Run before Pi sessions/subagent workers read the shared settings file. */
  migrateShellPreferences(path = getSettingsPath()): void {
    this.recoverStaleTmp(path);
    if (!existsSync(path)) return;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
    catch { return; } // The existing read/recovery path handles corrupt settings without losing the source.
    const migration = migrateLegacyShellPreferences(raw);
    if (migration.changed) writeSettingsAtomic(path, `${JSON.stringify(migration.settings, null, 2)}\n`);
  }

  archiveLegacyModelPreferences(): void {
    const path = getSettingsPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.modelPreferences === undefined) return;
    // Archival only; no runtime consumer reads this field.
    raw.legacyModelPreferences = raw.modelPreferences;
    delete raw.modelPreferences;
    writeSettingsAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
  }

  /**
   * P3-4：崩溃残留 settings.json.tmp 的安全处理（与 tmp+fsync+rename 原子写一致）：
   * - 主文件存在（无论是否可解析）→ tmp 是陈旧残留（原子写崩溃发生在 rename 前，主文件仍是
   *   上一版完整数据），安全删除；
   * - 主文件缺失且 tmp 是完整有效 JSON → 原子恢复（rename 回正式路径），避免丢失唯一副本；
   * - 主文件缺失且 tmp 无效/半写 → 保守删除并告警，绝不把半写 tmp 当正式配置。
   */
  private recoverStaleTmp(path: string): void {
    const tmp = `${path}.tmp`;
    if (!existsSync(tmp)) return;
    if (existsSync(path)) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      return;
    }
    // 主文件缺失：仅完整有效 JSON 才恢复
    try {
      JSON.parse(readFileSync(tmp, "utf-8"));
      renameSync(tmp, path);
      console.warn(`[AppSettingsStore] settings.json 缺失，已从 .tmp 原子恢复（${path}）`);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      console.warn(`[AppSettingsStore] settings.json 缺失且 .tmp 无效，已删除残留（${tmp}）`);
    }
  }

  /**
   * P3-3：孤儿 key 对账（幂等）—— 删除 taskConnectorIds 中所有不存在于 existingTaskIds 的任务 key
   * （仅明确不存在的任务；trash/archive/restore 中任务行仍在，其 key 保留）。返回被清理的 taskId
   * 列表；无孤儿时零写入。启动时调用：purge 删行与 onPurge 清理之间崩溃的窗口由下次启动兜底。
   */
  reconcileTaskConnectorIds(existingTaskIds: ReadonlySet<string>): string[] {
    const current = this.read();
    const record = current.taskConnectorIds;
    if (!record || Object.keys(record).length === 0) return [];
    const orphans = Object.keys(record).filter((taskId) => !existingTaskIds.has(taskId));
    if (orphans.length === 0) return [];
    const next = { ...record };
    for (const taskId of orphans) delete next[taskId];
    this.write({ ...current, taskConnectorIds: next });
    return orphans;
  }

  /** 任务级 Active Connector 持久化：读取（无记录返回 undefined，不落盘默认值） */
  getTaskConnectorIds(taskId: string): string[] | undefined {
    if (!taskId) return undefined;
    const record = this.read().taskConnectorIds;
    const ids = record?.[taskId];
    return Array.isArray(ids) ? ids : undefined;
  }

  /** 任务级 Active Connector 持久化：写入（空数组也显式记录，与「未设置」区分） */
  setTaskConnectorIds(taskId: string, ids: string[]): void {
    if (!taskId) return;
    const next = [...new Set((ids ?? []).map((x) => String(x).trim()).filter(Boolean))];
    const current = this.read();
    this.write({ ...current, taskConnectorIds: { ...(current.taskConnectorIds ?? {}), [taskId]: next } });
  }

  /** 任务级 Active Connector 持久化：删除任务时清理对应记录（防无限增长） */
  clearTaskConnectorIds(taskId: string): void {
    if (!taskId) return;
    const current = this.read();
    const record = current.taskConnectorIds;
    if (!record || !(taskId in record)) return;
    const next = { ...record };
    delete next[taskId];
    this.write({ ...current, taskConnectorIds: next });
  }

  /** 获取 ~/.mybuddy 所在磁盘的容量信息 */
  getDiskSpace(): DiskSpaceDto {
    const dir = getMyBuddyDir();
    try {
      // Node >= 18.15 的 statfsSync
      if (_statfsSync) {
        const stats = _statfsSync(dir);
        const blockSize = stats.bsize;
        return {
          usedBytes: (stats.blocks - stats.bfree) * blockSize,
          totalBytes: stats.blocks * blockSize,
          freeBytes: stats.bavail * blockSize,
        };
      }
    } catch {
      // fallback below
    }
    // fallback: 用 PowerShell 获取磁盘信息
    try {
      const driveLetter = dir.substring(0, 1).toUpperCase();
      const cmd = `powershell -NoProfile -Command "(Get-PSDrive ${driveLetter}).Used,(Get-PSDrive ${driveLetter}).Free"`;
      const raw = execSync(cmd, { encoding: "utf-8", timeout: 8000 });
      const [usedStr, freeStr] = raw.trim().split(/\r?\n/);
      const usedBytes = parseInt(usedStr, 10) || 0;
      const freeBytes = parseInt(freeStr, 10) || 0;
      return { usedBytes, totalBytes: usedBytes + freeBytes, freeBytes };
    } catch {
      // fallback: statfsSync (Node >= 18.15)
      try {
        if (_statfsSync) {
          const stats = _statfsSync(dir);
          const blockSize = stats.bsize;
          return {
            usedBytes: (stats.blocks - stats.bfree) * blockSize,
            totalBytes: stats.blocks * blockSize,
            freeBytes: stats.bavail * blockSize,
          };
        }
      } catch {
        // ignore
      }
    }
    return { usedBytes: 0, totalBytes: 0, freeBytes: 0 };
  }
}
