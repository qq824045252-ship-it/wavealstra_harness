import type { WelcomeMode } from "@shared/agent-ipc";
import { heroSuggestions, isHeroSuggestion as isBuiltinHeroSuggestion } from "./heroCopy";

export const HERO_SUGGEST_STORAGE_KEY = "mybuddy-hero-suggest";
export const HERO_SUGGEST_MAX = 12;
export const HERO_SUGGEST_MAX_LEN = 40;

export type HeroSuggestStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type HeroSuggestStore = Record<string, string[]>;

export type HeroSuggestResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type HeroSuggestListResult =
  | { ok: true; list: string[] }
  | { ok: false; error: string };

export function heroSuggestSceneKey(mode: WelcomeMode, presetId: string | null | undefined): string {
  return `${mode}:${presetId ?? ""}`;
}

export function normalizeHeroSuggestText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function validateHeroSuggestText(text: string): HeroSuggestResult {
  const value = normalizeHeroSuggestText(text);
  if (!value) return { ok: false, error: "请输入常用词" };
  if (value.length > HERO_SUGGEST_MAX_LEN) {
    return { ok: false, error: `最多 ${HERO_SUGGEST_MAX_LEN} 个字` };
  }
  return { ok: true, value };
}

export function parseHeroSuggestStore(raw: unknown): HeroSuggestStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: HeroSuggestStore = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const unique: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const text = normalizeHeroSuggestText(item);
      if (!text || unique.includes(text)) continue;
      unique.push(text);
      if (unique.length >= HERO_SUGGEST_MAX) break;
    }
    out[key] = unique;
  }
  return out;
}

export function loadHeroSuggestStore(storage: HeroSuggestStorage | null | undefined): HeroSuggestStore {
  if (!storage) return {};
  try {
    const raw = storage.getItem(HERO_SUGGEST_STORAGE_KEY);
    if (!raw) return {};
    return parseHeroSuggestStore(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function saveHeroSuggestStore(
  storage: HeroSuggestStorage | null | undefined,
  store: HeroSuggestStore,
): void {
  if (!storage) return;
  try {
    storage.setItem(HERO_SUGGEST_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota */
  }
}

export function browserHeroSuggestStorage(): HeroSuggestStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function sameHeroSuggestList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

export function resolveHeroSuggestions(
  mode: WelcomeMode,
  presetId: string | null | undefined,
  store: HeroSuggestStore,
): string[] {
  const custom = store[heroSuggestSceneKey(mode, presetId)];
  if (custom) return [...custom];
  return [...heroSuggestions(mode, presetId)];
}

export function sceneHasCustomHeroSuggestions(
  mode: WelcomeMode,
  presetId: string | null | undefined,
  store: HeroSuggestStore,
): boolean {
  return Object.prototype.hasOwnProperty.call(store, heroSuggestSceneKey(mode, presetId));
}

export function writeHeroSuggestions(
  storage: HeroSuggestStorage | null | undefined,
  store: HeroSuggestStore,
  mode: WelcomeMode,
  presetId: string | null | undefined,
  list: readonly string[],
): HeroSuggestStore {
  const key = heroSuggestSceneKey(mode, presetId);
  const defaults = heroSuggestions(mode, presetId);
  const next: HeroSuggestStore = { ...store };
  if (sameHeroSuggestList(list, defaults)) {
    delete next[key];
  } else {
    next[key] = [...list];
  }
  saveHeroSuggestStore(storage, next);
  return next;
}

export function addHeroSuggestion(list: readonly string[], text: string): HeroSuggestListResult {
  const parsed = validateHeroSuggestText(text);
  if (!parsed.ok) return parsed;
  if (list.includes(parsed.value)) return { ok: false, error: "已经有这句了" };
  if (list.length >= HERO_SUGGEST_MAX) return { ok: false, error: `最多 ${HERO_SUGGEST_MAX} 条` };
  return { ok: true, list: [...list, parsed.value] };
}

export function editHeroSuggestion(
  list: readonly string[],
  from: string,
  text: string,
): HeroSuggestListResult {
  const index = list.indexOf(from);
  if (index < 0) return { ok: false, error: "这条常用词已经不在了" };
  const parsed = validateHeroSuggestText(text);
  if (!parsed.ok) return parsed;
  if (parsed.value === from) return { ok: true, list: [...list] };
  if (list.includes(parsed.value)) return { ok: false, error: "已经有这句了" };
  const next = [...list];
  next[index] = parsed.value;
  return { ok: true, list: next };
}

export function removeHeroSuggestion(list: readonly string[], text: string): string[] {
  return list.filter((item) => item !== text);
}

export function isHeroSuggestion(text: string, store?: HeroSuggestStore): boolean {
  if (isBuiltinHeroSuggestion(text)) return true;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const data = store ?? loadHeroSuggestStore(browserHeroSuggestStorage());
  for (const list of Object.values(data)) {
    if (list.includes(trimmed)) return true;
  }
  return false;
}
