/**
 * key-pool.ts — 同一 Provider 多 API Key 池 + 用尽自动轮换（failover）状态。
 *
 * 配置写在 ~/.mybuddy/web-search.json 内（与 pi-web-access 既有配置同文件）：
 *   apiKeyPools:  { "<provider>": ["key1", "key2", ...] }
 *   apiKeyStates: { "<provider>": {
 *                     activeIndex: number,      // 下次搜索从池中哪个位置开始
 *                     cooldownUntil: { "<i>": ts }, // 配额/限流用尽的 key 冷却截止（epoch ms），键为池内索引
 *                     disabled: [<i>, ...]      // 鉴权失败被禁用的 key，值为池内索引
 *                   } }
 *
 * 状态用「池内索引」而非 key 哈希：UI 无需重复哈希即可对齐状态。
 * 池一旦被编辑（增删/排序）即整体重置该 provider 状态（writeApiKeyPool），
 * 因此索引错位问题不存在。
 * 每次读取都重新读盘（文件很小），保证 UI 侧修改后无需重启会话即生效。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

export interface KeyPoolState {
  /** 池中下次优先尝试的索引；越界时自动回 0 */
  activeIndex: number;
  /** 池内索引 -> 冷却截止 epoch ms；过期项视为已恢复 */
  cooldownUntil: Record<number, number>;
  /** 鉴权失败被禁用的池内索引 */
  disabled: number[];
}

export type ApiKeyPools = Record<string, string[]>;
export type ApiKeyStates = Record<string, KeyPoolState>;

const COOLDOWN_RATE_LIMIT_MS = 5 * 60 * 1000; // 429 限流：5 分钟
const COOLDOWN_QUOTA_MS = 60 * 60 * 1000; // 402/配额用尽：1 小时（免费额度按月，保守轮换）
const COOLDOWN_DEFAULT_MS = 10 * 60 * 1000;

function configPath(): string {
  return getWebSearchConfigPath();
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeConfigMerged(patch: Record<string, unknown>): void {
  const current = readConfig();
  const next = { ...current, ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
}

/** 展示用掩码：保留头尾 4 位 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 读取全部 provider 的密钥池（每次读盘，保证与 UI 同步） */
export function readApiKeyPools(): ApiKeyPools {
  const raw = readConfig().apiKeyPools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const pools: ApiKeyPools = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const keys = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (keys.length > 0) pools[provider] = keys;
  }
  return pools;
}

/** 读取全部 provider 的轮换状态 */
export function readApiKeyStates(): ApiKeyStates {
  const raw = readConfig().apiKeyStates;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states: ApiKeyStates = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const activeIndex = typeof obj.activeIndex === "number" && Number.isFinite(obj.activeIndex)
      ? Math.max(0, Math.floor(obj.activeIndex))
      : 0;
    const cooldownUntil: Record<number, number> = {};
    if (obj.cooldownUntil && typeof obj.cooldownUntil === "object" && !Array.isArray(obj.cooldownUntil)) {
      for (const [index, ts] of Object.entries(obj.cooldownUntil as Record<string, unknown>)) {
        const i = Number(index);
        if (Number.isInteger(i) && typeof ts === "number" && Number.isFinite(ts)) cooldownUntil[i] = ts;
      }
    }
    const disabled = Array.isArray(obj.disabled)
      ? obj.disabled
        .map((item) => Number(item))
        .filter((item): item is number => Number.isInteger(item) && item >= 0)
      : [];
    states[provider] = { activeIndex, cooldownUntil, disabled };
  }
  return states;
}

/** 覆盖写入某 provider 的密钥池（池变更后重置该 provider 状态，避免索引错位） */
export function writeApiKeyPool(provider: string, keys: string[]): void {
  const pools = readApiKeyPools();
  const next = { ...pools };
  if (keys.length === 0) delete next[provider];
  else next[provider] = keys;
  writeConfigMerged({ apiKeyPools: next });

  const states = readApiKeyStates();
  if (states[provider]) {
    states[provider] = { activeIndex: 0, cooldownUntil: {}, disabled: [] };
    writeConfigMerged({ apiKeyStates: states });
  }
}

function loadState(provider: string): KeyPoolState {
  const states = readApiKeyStates();
  return states[provider] ?? { activeIndex: 0, cooldownUntil: {}, disabled: [] };
}

function saveState(provider: string, state: KeyPoolState): void {
  const states = readApiKeyStates();
  states[provider] = state;
  writeConfigMerged({ apiKeyStates: states });
}

/**
 * 取某 provider 的有效密钥（池优先，其次旧式单 key 配置，再其次环境变量）。
 * legacyKey 形如 "tavilyApiKey"；envKey 形如 "TAVILY_API_KEY"。
 */
export function resolveProviderKeys(
  provider: string,
  legacyKey: string | undefined,
  envKey: string | undefined,
): string[] {
  const pool = readApiKeyPools()[provider];
  if (pool && pool.length > 0) return [...pool];
  if (legacyKey && legacyKey.trim()) return [legacyKey.trim()];
  if (envKey && envKey.trim()) return [envKey.trim()];
  return [];
}

/** 首个未冷却且未禁用的索引；无可用时返回 0 */
function firstAvailableIndex(pool: string[], state: KeyPoolState, now: number): number {
  const disabled = new Set(state.disabled);
  for (let index = 0; index < pool.length; index++) {
    if (disabled.has(index)) continue;
    const cooldownUntil = state.cooldownUntil[index];
    if (typeof cooldownUntil === "number" && cooldownUntil > now) continue;
    return index;
  }
  return 0;
}

/**
 * 标记某索引的 key 配额/限流失败：写入冷却，并把 activeIndex 推进到下一个可用 key。
 * cooldownMs 可传入具体时长；省略时按 status 判断（429 短冷却，其余配额长冷却）。
 */
export function markQuota(provider: string, index: number, status?: number, cooldownMs?: number): void {
  const pool = readApiKeyPools()[provider] ?? [];
  const state = loadState(provider);
  const duration = cooldownMs
    ?? (status === 429
      ? COOLDOWN_RATE_LIMIT_MS
      : status === 402
        ? COOLDOWN_QUOTA_MS
        : COOLDOWN_DEFAULT_MS);
  state.cooldownUntil[index] = Date.now() + duration;
  state.activeIndex = firstAvailableIndex(pool, state, Date.now());
  saveState(provider, state);
}

/** 标记某索引的 key 鉴权失败（永久禁用，直到用户在 UI 里恢复） */
export function markDisabled(provider: string, index: number): void {
  const state = loadState(provider);
  if (!state.disabled.includes(index)) {
    state.disabled.push(index);
    state.activeIndex = firstAvailableIndex(readApiKeyPools()[provider] ?? [], state, Date.now());
    saveState(provider, state);
  }
}

/** 手动把某索引的 key 设为池中首选 */
export function setActiveKey(provider: string, index: number): void {
  const state = loadState(provider);
  state.activeIndex = index;
  saveState(provider, state);
}

/** 手动清除某索引 key 的冷却/禁用状态（用户「恢复」） */
export function clearKeyState(provider: string, index: number): void {
  const state = loadState(provider);
  delete state.cooldownUntil[index];
  state.disabled = state.disabled.filter((item) => item !== index);
  saveState(provider, state);
}

/** 清除某 provider 全部冷却/禁用，activeIndex 归零 */
export function resetProviderState(provider: string): void {
  saveState(provider, { activeIndex: 0, cooldownUntil: {}, disabled: [] });
}

export function cooldownMsForStatus(status?: number): number {
  if (status === 429) return COOLDOWN_RATE_LIMIT_MS;
  if (status === 402) return COOLDOWN_QUOTA_MS;
  return COOLDOWN_DEFAULT_MS;
}

/* ============ 通用「按 key 池搜索 + 用尽自动轮换」 ============ */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从错误文案提取 HTTP 状态码 */
function providerErrorStatus(message: string): number | undefined {
  const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
  if (!match) return undefined;
  return Number(match[1]);
}

function isAbortError(message: string): boolean {
  return message.toLowerCase().includes("abort");
}

/** 配额/限流用尽（触发自动切换 key） */
function isQuotaError(message: string, status?: number): boolean {
  if (status === 402 || status === 429) return true;
  return /rate limit|quota|too many requests|insufficient credits|exceeded.*(quota|limit)|credit balance|out of credits|no credits/i.test(message);
}

/** key 无效/无权限（触发禁用该 key） */
function isAuthError(status?: number): boolean {
  return status === 401 || status === 403;
}

function formatCooldown(until: number): string {
  const seconds = Math.max(1, Math.round((until - Date.now()) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时`;
}

export interface SearchKeyPoolOptions {
  signal?: AbortSignal;
  /** 展示名，如 "Tavily"、"Serper"；缺省用 provider id */
  providerLabel?: string;
  /** 没有可用 key 时抛错的附加指引（换行分隔） */
  setupHint?: string;
}

/**
 * 通用多 key 池搜索：从 activeIndex 起尝试，配额/限流用尽自动切下一个 key，
 * 鉴权失败禁用该 key 后继续，全部用尽才抛错（供上层 provider 级回退）。
 * 各 provider 只需提供「单 key 搜索函数」即可获得完整轮换能力。
 */
export async function searchWithKeyPool<T>(
  provider: string,
  legacyKey: string | undefined,
  envKey: string | undefined,
  searchOne: (key: string) => Promise<T>,
  options: SearchKeyPoolOptions = {},
): Promise<T> {
  const label = options.providerLabel ?? provider;
  const pool = resolveProviderKeys(provider, legacyKey, envKey);
  if (pool.length === 0) {
    const hint = options.setupHint
      ? `\n${options.setupHint}`
      : `\n  1. 在 ${getWebSearchConfigPath()} 配置 apiKeyPools.${provider} 或 ${provider}ApiKey\n  2. 设置 ${envKey ?? `${provider.toUpperCase()}_API_KEY`} 环境变量`;
    throw new Error(`${label} API key not found.${hint}`);
  }

  const state = readApiKeyStates()[provider] ?? { activeIndex: 0, cooldownUntil: {}, disabled: [] };
  const errors: string[] = [];
  const quotaAttempts: Array<{ masked: string; reason: string }> = [];
  let triedCount = 0;

  const start = state.activeIndex >= 0 && state.activeIndex < pool.length ? state.activeIndex : 0;
  for (let offset = 0; offset < pool.length; offset++) {
    const index = (start + offset) % pool.length;
    const key = pool[index]!;
    const masked = maskKey(key);
    if (state.disabled.includes(index)) continue;
    const cooldownUntil = state.cooldownUntil[index];
    if (typeof cooldownUntil === "number" && cooldownUntil > Date.now()) {
      quotaAttempts.push({ masked, reason: `冷却中（${formatCooldown(cooldownUntil)}）` });
      continue;
    }

    triedCount++;
    try {
      return await searchOne(key);
    } catch (err) {
      const message = errorMessage(err);
      const status = providerErrorStatus(message);
      if (isAbortError(message)) throw err;
      const quota = isQuotaError(message, status);
      const auth = isAuthError(status);
      if (quota) {
        markQuota(provider, index, status);
        quotaAttempts.push({ masked, reason: status ? `HTTP ${status}` : message.slice(0, 120) });
        continue;
      }
      if (auth) {
        markDisabled(provider, index);
        errors.push(`${masked}: ${message.slice(0, 200)}（已禁用）`);
        continue;
      }
      // 非配额/鉴权错误：key 本身没问题，直接抛给上层
      throw err;
    }
  }

  if (triedCount === 0) {
    const reasons = quotaAttempts.map((item) => `  - ${item.masked}：${item.reason}`).join("\n");
    throw new Error(`${label} quota exhausted (all keys cooling down / 全部 key 暂不可用)：\n${reasons}`);
  }
  const detail = [
    ...quotaAttempts.map((item) => `  - ${item.masked}：${item.reason}`),
    ...errors.map((item) => `  - ${item}`),
  ].join("\n");
  throw new Error(`${label} quota exhausted across all API keys (已自动轮换，全部 key 配额用尽):\n${detail}`);
}
