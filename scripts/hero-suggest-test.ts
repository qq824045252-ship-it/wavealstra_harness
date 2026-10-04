/**
 * 首页常用词：按场景增删改 + 本地持久化。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heroSuggestions } from "../src/renderer/src/components/chat/heroCopy";
import {
  HERO_SUGGEST_MAX,
  HERO_SUGGEST_MAX_LEN,
  HERO_SUGGEST_STORAGE_KEY,
  addHeroSuggestion,
  editHeroSuggestion,
  heroSuggestSceneKey,
  isHeroSuggestion,
  loadHeroSuggestStore,
  parseHeroSuggestStore,
  removeHeroSuggestion,
  resolveHeroSuggestions,
  sceneHasCustomHeroSuggestions,
  writeHeroSuggestions,
  type HeroSuggestStorage,
} from "../src/renderer/src/components/chat/heroSuggest";

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

function memoryStorage(seed: Record<string, string> = {}): HeroSuggestStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

{
  ok(heroSuggestSceneKey("coding", "bugfix-test") === "coding:bugfix-test", "scene key includes mode and preset");
  ok(heroSuggestSceneKey("working", null) === "working:", "missing preset still keys by mode");
}

{
  ok(Object.keys(parseHeroSuggestStore(null)).length === 0, "null store → empty");
  ok(Object.keys(parseHeroSuggestStore("nope")).length === 0, "non-object store → empty");
  ok(Object.keys(parseHeroSuggestStore([])).length === 0, "array store → empty");
  const parsed = parseHeroSuggestStore({
    "coding:bugfix-test": ["  帮我排查  ", "帮我排查", "", 12, "新的一句"],
    bad: "nope",
  });
  ok(
    parsed["coding:bugfix-test"]?.join("|") === "帮我排查|新的一句",
    "parse trims, drops non-strings, de-dupes",
  );
}

{
  const added = addHeroSuggestion(["已有"], "  新一句  ");
  ok(added.ok && added.list.join("|") === "已有|新一句", "add appends trimmed text");
  ok(!addHeroSuggestion(["已有"], "已有").ok, "add rejects duplicate");
  ok(!addHeroSuggestion(["已有"], "   ").ok, "add rejects blank");
  ok(!addHeroSuggestion(["已有"], "x".repeat(HERO_SUGGEST_MAX_LEN + 1)).ok, "add rejects overlong");
  ok(!addHeroSuggestion(Array.from({ length: HERO_SUGGEST_MAX }, (_, i) => `s${i}`), "extra").ok, "add rejects over max");
}

{
  const edited = editHeroSuggestion(["甲", "乙"], "甲", "甲改");
  ok(edited.ok && edited.list.join("|") === "甲改|乙", "edit replaces in place");
  ok(editHeroSuggestion(["甲", "乙"], "甲", "甲").ok, "edit same text is no-op success");
  ok(!editHeroSuggestion(["甲", "乙"], "甲", "乙").ok, "edit rejects colliding text");
  ok(!editHeroSuggestion(["甲"], "丙", "丁").ok, "edit missing item fails");
  ok(removeHeroSuggestion(["甲", "乙", "甲"], "甲").join("|") === "乙", "remove drops matching items");
}

{
  const defaults = heroSuggestions("coding", "bugfix-test");
  ok(defaults.includes("帮我排查这个报错"), "bugfix defaults exist");
  const storage = memoryStorage();
  let store = writeHeroSuggestions(storage, {}, "coding", "bugfix-test", [...defaults, "我的常用词"]);
  ok(sceneHasCustomHeroSuggestions("coding", "bugfix-test", store), "added phrase marks scene customized");
  ok(
    resolveHeroSuggestions("coding", "bugfix-test", store).includes("我的常用词"),
    "custom phrase appears in resolved list",
  );
  ok(
    !resolveHeroSuggestions("coding", "feature-dev", store).includes("我的常用词"),
    "custom phrase stays on that scene",
  );
  const loaded = loadHeroSuggestStore(storage);
  ok(loaded["coding:bugfix-test"]?.includes("我的常用词"), "persisted under scene key");
  ok(storage.getItem(HERO_SUGGEST_STORAGE_KEY)?.includes("我的常用词"), "writes JSON to storage");

  store = writeHeroSuggestions(storage, store, "coding", "bugfix-test", defaults);
  ok(!sceneHasCustomHeroSuggestions("coding", "bugfix-test", store), "matching defaults clears override");
  ok(
    resolveHeroSuggestions("coding", "bugfix-test", store).join("|") === defaults.join("|"),
    "cleared override falls back to defaults",
  );

  store = writeHeroSuggestions(storage, store, "coding", "bugfix-test", []);
  ok(sceneHasCustomHeroSuggestions("coding", "bugfix-test", store), "empty list is a real customization");
  ok(resolveHeroSuggestions("coding", "bugfix-test", store).length === 0, "empty customization hides defaults");
}

{
  const storage = memoryStorage();
  const store = writeHeroSuggestions(storage, {}, "working", "weekly-report", ["本周只写风险"]);
  ok(isHeroSuggestion("帮我排查这个报错"), "builtin phrases still count");
  ok(isHeroSuggestion("本周只写风险", store), "custom phrases count for scene-switch clear");
  ok(!isHeroSuggestion("随便一句话", store), "unrelated text is not a suggestion");
}

{
  const src = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/HeroSuggestChips.tsx"), "utf8");
  ok(src.includes('aria-label="添加常用词"'), "plus chip is labeled as add");
  ok(src.includes("修改") && src.includes("删除"), "chip menu can edit and delete");
  ok(src.includes("恢复默认"), "customized scenes can restore defaults");
  const home = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatView.tsx"), "utf8");
  ok(home.includes("<HeroSuggestChips"), "HomeHero renders the editable chips");
  ok(!home.includes("heroSuggestions("), "HomeHero no longer reads a static suggestion list");
}

console.log(`hero-suggest-test: ${passed} assertions passed`);
