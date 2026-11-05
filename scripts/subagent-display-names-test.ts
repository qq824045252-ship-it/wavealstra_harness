/**
 * subagent-display-names-test.ts — 自动显示名池与分配器。
 *
 * 覆盖：池子恰为初代 151 个物种、中文/英文名唯一且 ASCII 可转写、4 个特殊名映射；
 * 分配时避开 active 占用、同批不重复、超出容量允许重复；批量解析保留显式名。
 */
import {
  assignPokemonDisplayNames,
  GEN1_POKEMON_NAMES,
  resolveBatchDisplayNames,
} from "../src/main/capabilities/subagent/display-names";

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const zhNames = GEN1_POKEMON_NAMES.map((entry) => entry.zh);
const enNames = GEN1_POKEMON_NAMES.map((entry) => entry.en);

console.log("== 名字池 ==");
assert(GEN1_POKEMON_NAMES.length === 151, `恰为初代 151 个物种（${GEN1_POKEMON_NAMES.length}）`);
assert(new Set(zhNames).size === 151, "中文显示名唯一");
assert(new Set(enNames).size === 151, "英文名唯一");
assert(enNames.every((name) => /^[a-z0-9-]+$/.test(name)), "英文名均为小写 ASCII / 连字符");
assert(zhNames.every((name) => name.length > 0 && name.trim() === name), "中文名非空且无首尾空白");
assert(zhNames.includes("皮卡丘") && zhNames.includes("杰尼龟") && zhNames.includes("妙蛙种子"), "含约定示例名");

const specialMappings: Record<string, string> = {
  "尼多兰♀": "nidoran-f",
  "尼多朗♂": "nidoran-m",
  "魔墙人偶": "mr-mime",
  "大葱鸭": "farfetchd",
};
for (const [zh, en] of Object.entries(specialMappings)) {
  assert(GEN1_POKEMON_NAMES.find((entry) => entry.zh === zh)?.en === en, `${zh} → ${en}`);
}

console.log("== 分配器 ==");
{
  const three = assignPokemonDisplayNames(3);
  assert(three.length === 3 && new Set(three).size === 3, `3 个互不相同（${three.join("、")}）`);
  assert(three.every((name) => zhNames.includes(name)), "全部来自池子");

  const remaining = zhNames[150];
  const one = assignPokemonDisplayNames(1, zhNames.slice(0, 150));
  assert(one.length === 1 && one[0] === remaining, `排除 active 已占用（${one[0]}）`);

  const whole = assignPokemonDisplayNames(151);
  assert(new Set(whole).size === 151, "池子容量内取满不重复");

  const many = assignPokemonDisplayNames(200);
  assert(many.length === 200, "超出容量仍按需求数量返回");
  assert(new Set(many).size === 151, "超出容量时覆盖全池、多余部分允许重复");

  assert(assignPokemonDisplayNames(0).length === 0, "count=0 → 空");
  assert(assignPokemonDisplayNames(-3).length === 0, "count<0 → 空");
  assert(assignPokemonDisplayNames(2, ["皮卡丘"]).every((name) => name !== "皮卡丘"), "reserved 名字不被选中");
}

console.log("== 批量解析（显式优先 / 同批不重复） ==");
{
  const batch = resolveBatchDisplayNames([{}, { displayName: "皮卡丘" }, {}, {}], ["杰尼龟"]);
  assert(batch.length === 4, "返回数量与输入一致");
  assert(batch[1] === "皮卡丘", "显式 displayName 原样保留");
  assert(new Set(batch).size === 4, "同一批内不重复");
  assert(!batch.includes("杰尼龟"), "避开 reserved（active 已占用）");
  assert(batch.every((name) => typeof name === "string" && name.length > 0), "空缺项全部补满");

  const blank = resolveBatchDisplayNames([{ displayName: "   " }, {}], []);
  assert(blank.every((name) => name.length > 0) && blank[0] !== blank[1], "空白 displayName 视为缺失并补名");
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
