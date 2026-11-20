/**
 * 搜索 API 密钥池。
 * 同一 Provider 多 API Key：用尽（配额/限流）自动切换下一个 key，鉴权失败自动禁用。
 * 配置读写 ~/.mybuddy/web-search.json 的 apiKeyPools / apiKeyStates（由 web-access 扩展消费）。
 * 支持范围由 API_KEY_POOL_PROVIDERS 定义。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconRefresh, IconPlus, IconTrash, IconRotate, IconShield, IconAlert } from "@/components/common/icons";
import type { ApiKeyPoolStateDto, SearchProviderKeyUsageDto, WebSearchConfigDto } from "@shared/agent-ipc";
import { API_KEY_POOL_PROVIDERS } from "@shared/agent-ipc";

const USAGE_AUTO_REFRESH_MS = 60_000;

interface PoolEntry {
  provider: string;
  label: string;
  keys: string[];
  state: ApiKeyPoolStateDto;
}

type UsageMap = Record<string, Record<number, SearchProviderKeyUsageDto>>;

function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function fmtCooldown(until: number): string {
  const seconds = Math.max(1, Math.round((until - Date.now()) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时`;
}

function defaultState(): ApiKeyPoolStateDto {
  return { activeIndex: 0, cooldownUntil: {}, disabled: [] };
}

function readProviderKeys(cfg: WebSearchConfigDto, providerId: string): {
  keys: string[];
  legacyKey: string;
  legacyField: string;
  usesLegacy: boolean;
} {
  const provider = API_KEY_POOL_PROVIDERS.find((item) => item.id === providerId);
  if (!provider) throw new Error("不支持的搜索 API 供应商");
  const pool = cfg.apiKeyPools?.[providerId] ?? [];
  const legacy = (cfg as WebSearchConfigDto & Record<string, unknown>)[provider.legacyKeyField];
  const legacyKey = typeof legacy === "string" ? legacy.trim() : "";
  return {
    keys: pool.length > 0 ? pool : legacyKey ? [legacyKey] : [],
    legacyKey,
    legacyField: provider.legacyKeyField,
    usesLegacy: pool.length === 0 && Boolean(legacyKey),
  };
}

function isKeyAvailable(state: ApiKeyPoolStateDto, index: number, now: number): boolean {
  return !state.disabled.includes(index) && (state.cooldownUntil[String(index)] ?? 0) <= now;
}

/** 显示运行时从首选索引开始实际会使用的首个可用 key。 */
function effectiveActiveIndex(entry: PoolEntry, now: number): number {
  const count = entry.keys.length;
  const start = entry.state.activeIndex >= 0 && entry.state.activeIndex < count ? entry.state.activeIndex : 0;
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    if (isKeyAvailable(entry.state, index, now)) return index;
  }
  return -1;
}

/** 从配置构建每个 provider 的展示条目（池优先，其次旧式单 key 字段） */
function buildEntries(cfg: WebSearchConfigDto): PoolEntry[] {
  const states = cfg.apiKeyStates ?? {};
  return API_KEY_POOL_PROVIDERS.map((provider) => {
    const { keys } = readProviderKeys(cfg, provider.id);
    const state = states[provider.id] ?? defaultState();
    return {
      provider: provider.id,
      label: provider.label,
      keys,
      state: {
        activeIndex: state.activeIndex ?? 0,
        cooldownUntil: state.cooldownUntil ?? {},
        disabled: state.disabled ?? [],
      },
    };
  });
}

export default function SearchApiKeyPools({ onSaved }: { onSaved: (config: WebSearchConfigDto) => void }): React.JSX.Element {
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [newKeyByProvider, setNewKeyByProvider] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageMap>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageCheckedAt, setUsageCheckedAt] = useState<number | null>(null);
  const entriesRef = useRef<PoolEntry[]>([]);
  entriesRef.current = entries;

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await window.api?.agent?.getWebSearchConfig?.();
      if (!cfg) throw new Error("API 未就绪，请重启 MyBuddy");
      setEntries(buildEntries(cfg));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  /** 自动查询各 key 的用量（Tavily /usage），写入 usage 状态 */
  const queryUsage = useCallback(async (): Promise<void> => {
    const targets = entriesRef.current
      .filter((entry) => entry.keys.length > 0)
      .map((entry) => ({ provider: entry.provider, keys: entry.keys }));
    if (targets.length === 0) {
      setUsage({});
      setUsageCheckedAt(Date.now());
      return;
    }
    setUsageLoading(true);
    try {
      const next: UsageMap = {};
      await Promise.all(targets.map(async ({ provider, keys }) => {
        const rows = await window.api?.agent?.getSearchProviderUsage?.(provider, keys) ?? [];
        next[provider] = {};
        for (const row of rows) next[provider][row.keyIndex] = row;
      }));
      setUsage(next);
      setUsageCheckedAt(Date.now());
    } catch {
      /* 单次查询失败不阻塞页面 */
    } finally {
      setUsageLoading(false);
    }
  }, []);

  // 面板打开期间每 60s 自动刷新用量
  useEffect(() => {
    const timer = window.setInterval(() => {
      void queryUsage();
    }, USAGE_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [queryUsage]);

  // 加载完成后自动查询一次用量
  useEffect(() => {
    if (!loading && entries.length > 0) void queryUsage();
  }, [loading, entries.length, queryUsage]);

  /** 读最新配置，套用给定修改，写回；返回新 entries 供刷新 UI */
  const apply = useCallback(async (
    mutate: (cfg: WebSearchConfigDto) => { pools: Record<string, string[]>; states: Record<string, ApiKeyPoolStateDto>; clearLegacyField?: string },
  ): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true;
    setSaving(true);
    setError(null);
    try {
      const cfg = await window.api?.agent?.getWebSearchConfig?.();
      if (!cfg) throw new Error("API 未就绪，请重启 MyBuddy");
      const { pools, states, clearLegacyField } = mutate(cfg);
      const next = await window.api?.agent?.saveWebSearchConfig?.({
        apiKeyPools: pools,
        apiKeyStates: states,
        ...(clearLegacyField ? { [clearLegacyField]: "" } : {}),
      });
      if (!next) throw new Error("搜索 API 密钥池保存失败");
      setEntries(buildEntries(next));
      setSavedAt(Date.now());
      onSaved(next);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }, [onSaved]);

  const addKey = async (providerId: string): Promise<void> => {
    const key = (newKeyByProvider[providerId] ?? "").trim();
    if (!key) return;
    const ok = await apply((cfg) => {
      const pools = { ...(cfg.apiKeyPools ?? {}) };
      const { keys: current, usesLegacy, legacyField } = readProviderKeys(cfg, providerId);
      if (current.includes(key)) throw new Error("该 key 已存在于池中");
      pools[providerId] = [...current, key];
      const states = { ...(cfg.apiKeyStates ?? {}) };
      states[providerId] = defaultState();
      return { pools, states, clearLegacyField: usesLegacy ? legacyField : undefined };
    });
    if (ok) {
      setNewKeyByProvider((prev) => ({ ...prev, [providerId]: "" }));
    }
  };

  const removeKey = async (providerId: string, index: number): Promise<void> => {
    const ok = await apply((cfg) => {
      const pools = { ...(cfg.apiKeyPools ?? {}) };
      const { keys: current, legacyKey, legacyField } = readProviderKeys(cfg, providerId);
      if (index < 0 || index >= current.length) throw new Error("key 不存在");
      const next = current.filter((_, i) => i !== index);
      if (next.length === 0) delete pools[providerId];
      else pools[providerId] = next;
      const states = { ...(cfg.apiKeyStates ?? {}) };
      states[providerId] = defaultState();
      // Do not let a removed key reappear through the old single-key fallback.
      const clearsLegacy = legacyKey && (next.length === 0 || current[index]?.trim() === legacyKey);
      return { pools, states, clearLegacyField: clearsLegacy ? legacyField : undefined };
    });
    void ok;
  };

  const setActive = async (providerId: string, index: number): Promise<void> => {
    const ok = await apply((cfg) => {
      const states = { ...(cfg.apiKeyStates ?? {}) };
      const state = states[providerId] ?? defaultState();
      const { keys } = readProviderKeys(cfg, providerId);
      if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error("key 不存在");
      if (!isKeyAvailable(state, index, Date.now())) throw new Error("该 key 暂不可用，请先恢复");
      states[providerId] = { ...state, activeIndex: index };
      return { pools: cfg.apiKeyPools ?? {}, states };
    });
    void ok;
  };

  const clearKeyState = async (providerId: string, index: number): Promise<void> => {
    const ok = await apply((cfg) => {
      const states = { ...(cfg.apiKeyStates ?? {}) };
      const state = states[providerId] ?? defaultState();
      const cooldownUntil = { ...state.cooldownUntil };
      delete cooldownUntil[String(index)];
      states[providerId] = {
        ...state,
        cooldownUntil,
        disabled: state.disabled.filter((i) => i !== index),
      };
      return { pools: cfg.apiKeyPools ?? {}, states };
    });
    void ok;
  };

  const resetProvider = async (providerId: string): Promise<void> => {
    const ok = await apply((cfg) => {
      const states = { ...(cfg.apiKeyStates ?? {}) };
      states[providerId] = defaultState();
      return { pools: cfg.apiKeyPools ?? {}, states };
    });
    void ok;
  };

  const now = Date.now();
  const summary = entries.map((entry) => {
    const activeIndex = effectiveActiveIndex(entry, now);
    const activeMasked = activeIndex >= 0 ? maskKey(entry.keys[activeIndex]!) : "";
    return { ...entry, activeIndex, activeMasked };
  });

  return (
    <section className="search-api-key-pools" aria-label="搜索 API 密钥池">
      <div className="search-api-key-pools-head">
        <h3>密钥轮换</h3>
        <button type="button" className="btn" onClick={() => void reload()} disabled={loading || saving}>
          <IconRefresh size={14} /> 刷新
        </button>
      </div>
        <fieldset className="ak-body" disabled={loading || saving}>
          <div className="ak-intro">
            <IconShield size={15} />
            <span>
              多个 key 按顺序使用；某 key <strong>配额/限流用尽</strong>（HTTP 402/429）时自动切到下一个并进入冷却，
              <strong>鉴权失败</strong>（401/403）自动禁用。Tavily 自动查询搜索用量（每 60 秒刷新），Serper 暂无用量接口。
            </span>
          </div>

          {error && (
            <div className="ak-error">
              <IconAlert size={15} /> {error}
            </div>
          )}
          {savedAt && <div className="ak-saved">已保存（{new Date(savedAt).toLocaleTimeString()}）</div>}
          {loading && entries.length === 0 && <div className="us-empty">加载中…</div>}

          {summary.map((entry) => (
            <section key={entry.provider} className="ak-card" aria-label={entry.label}>
              <header className="ak-card-head">
                <div>
                  <div className="ak-card-title">
                    {entry.label} <span className="ak-card-tag">搜索 API</span>
                  </div>
                  <div className="ak-card-sub">
                    {entry.keys.length === 0
                      ? "尚未配置 key。添加后联网搜索将按池自动轮换。"
                      : `${entry.keys.length} 个 key · ${entry.activeMasked ? `当前生效 ${entry.activeMasked}` : "暂无可用 key"}`}
                    {usageCheckedAt && entry.keys.length > 0 && (
                      <span className="ak-card-sub-usage"> · 用量更新 {new Date(usageCheckedAt).toLocaleTimeString()}</span>
                    )}
                    {usageLoading && entry.keys.length > 0 && <span className="ak-card-sub-usage"> · 查询中…</span>}
                  </div>
                </div>
                <div className="ak-card-actions">
                  {entry.keys.length > 0 && (
                    <button
                      className="us-text-btn"
                      title="立即刷新各 key 用量"
                      disabled={usageLoading}
                      onClick={() => void queryUsage()}
                    >
                      <IconRefresh size={13} /> 刷新用量
                    </button>
                  )}
                  {entry.keys.length > 0 && (
                    <button
                      className="us-text-btn"
                      title="清除全部冷却/禁用，恢复默认顺序"
                      onClick={() => void resetProvider(entry.provider)}
                    >
                      <IconRotate size={13} /> 重置状态
                    </button>
                  )}
                </div>
              </header>

              {entry.keys.length > 0 ? (
                <ul className="ak-key-list">
                  {entry.keys.map((key, index) => {
                    const cooldown = entry.state.cooldownUntil[String(index)];
                    const cooling = typeof cooldown === "number" && cooldown > now;
                    const disabled = entry.state.disabled.includes(index);
                    const isActive = index === entry.activeIndex;
                    const u = usage[entry.provider]?.[index];
                    const barUsage = u?.ok && typeof u.limit === "number" && u.limit > 0 ? u.usage : u?.planUsage;
                    const barLimit = u?.ok && typeof u.limit === "number" && u.limit > 0 ? u.limit : u?.planLimit;
                    const pct = u?.ok && typeof barUsage === "number" && typeof barLimit === "number" && barLimit > 0
                      ? Math.min(100, Math.round((barUsage / barLimit) * 100))
                      : 0;
                    const barColor = pct >= 100 ? "var(--danger)" : pct >= 80 ? "var(--warning)" : "var(--success)";
                    return (
                      <li key={`${index}-${key.slice(-4)}`} className={`ak-key ${isActive ? "active" : ""} ${disabled ? "disabled" : ""}`}>
                        <div className="ak-key-left">
                          <div className="ak-key-main">
                            <span className="ak-key-mask">{maskKey(key)}</span>
                            <span className={`ak-key-badge ${isActive ? "active" : ""} ${cooling ? "cooling" : ""} ${disabled ? "disabled" : ""}`}>
                              {disabled
                                ? "已禁用"
                                : cooling
                                  ? `冷却中 ${fmtCooldown(cooldown)}`
                                  : isActive
                                    ? "生效中"
                                    : "备用"}
                            </span>
                            <span className="ak-key-index">#{index + 1}</span>
                          </div>
                          {u && (
                            <div className="ak-key-usage">
                              {u.ok ? (
                                <>
                                  <span className="ak-key-usage-search">搜索 {u.searchUsage ?? "—"} 次</span>
                                  {typeof barUsage === "number" && typeof barLimit === "number" && barLimit > 0 && (
                                    <>
                                      <span className="ak-key-usage-track">
                                        <span className="ak-key-usage-bar" style={{ width: `${pct}%`, background: barColor }} />
                                      </span>
                                      <span className="ak-key-usage-num">{barUsage} / {barLimit}</span>
                                    </>
                                  )}
                                  {u.plan && <span className="ak-key-plan">{u.plan}</span>}
                                </>
                              ) : u.error?.includes("暂不支持用量查询") ? (
                                <span className="ak-key-usage-unsupported">该供应商暂不支持用量查询</span>
                              ) : (
                                <span className="ak-key-usage-err">用量查询失败：{u.error}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="ak-key-ops">
                          {!isActive && !cooling && !disabled && (
                            <button
                              className="us-text-btn"
                              title="手动设为当前使用的 key"
                              onClick={() => void setActive(entry.provider, index)}
                            >
                              设为当前
                            </button>
                          )}
                          {(cooling || disabled) && (
                            <button
                              className="us-text-btn"
                              title="清除冷却/禁用状态"
                              onClick={() => void clearKeyState(entry.provider, index)}
                            >
                              恢复
                            </button>
                          )}
                          <button
                            className="us-text-btn ak-key-remove"
                            title="从池中删除"
                            onClick={() => void removeKey(entry.provider, index)}
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="ak-key-empty">暂无 key，请在下方添加。</div>
              )}

              <div className="ak-add-row">
                <input
                  type="password"
                  aria-label={`${entry.label} 新密钥`}
                  className="ak-key-input"
                  placeholder="粘贴新的 API key（如 tvly-…）"
                  value={newKeyByProvider[entry.provider] ?? ""}
                  onChange={(e) =>
                    setNewKeyByProvider((prev) => ({ ...prev, [entry.provider]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addKey(entry.provider);
                  }}
                />
                <button
                  className="ak-add-btn"
                  disabled={!(newKeyByProvider[entry.provider] ?? "").trim()}
                  onClick={() => void addKey(entry.provider)}
                >
                  <IconPlus size={14} /> 添加
                </button>
              </div>
            </section>
          ))}

          <div className="ak-note">
            说明：状态保存在 ~/.mybuddy/web-search.json 的 apiKeyPools / apiKeyStates（明文 key 仅存池内，冷却/禁用只记录索引）。
            用量来自 Tavily GET /usage 接口（搜索次数 search_usage、额度 usage/limit），仅用于展示；Serper 暂未开放用量接口。
            其它 Provider（TinyFish / Brave / Search1API…）后续可按同一机制接入。
          </div>
        </fieldset>
    </section>
  );
}
