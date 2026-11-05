/**
 * display-names.ts — 子代理显示名池：初代 151 个物种的简中官方名。
 *
 * 产品约定（2026-11）：分派子代理时不传 displayName 时，自动从本池随机取一个
 * **未被当前 active 子代理占用** 的中文名作为显示名；displayName 只用于展示，
 * 身份仍是 `subagentId`（ASCII、唯一性、文件名、worker 参数均不变）。
 *
 * 池子只收初代 151 个物种；不含训练家/人类角色、后续世代、民间旧译名。
 */

import { normalizeSubagentDisplayName } from "../../../shared/subagent-model-config";

export interface PokemonDisplayName {
  /** 简中官方名（允许中文与 ♀/♂ 符号），用于 displayName */
  zh: string;
  /** 对应英文官方名（小写、ASCII），仅作为约定记录，不进入 subagentId */
  en: string;
}

export const GEN1_POKEMON_NAMES: readonly PokemonDisplayName[] = [
  { zh: "妙蛙种子", en: "bulbasaur" },
  { zh: "妙蛙草", en: "ivysaur" },
  { zh: "妙蛙花", en: "venusaur" },
  { zh: "小火龙", en: "charmander" },
  { zh: "火恐龙", en: "charmeleon" },
  { zh: "喷火龙", en: "charizard" },
  { zh: "杰尼龟", en: "squirtle" },
  { zh: "卡咪龟", en: "wartortle" },
  { zh: "水箭龟", en: "blastoise" },
  { zh: "绿毛虫", en: "caterpie" },
  { zh: "铁甲蛹", en: "metapod" },
  { zh: "巴大蝶", en: "butterfree" },
  { zh: "独角虫", en: "weedle" },
  { zh: "铁壳蛹", en: "kakuna" },
  { zh: "大针蜂", en: "beedrill" },
  { zh: "波波", en: "pidgey" },
  { zh: "比比鸟", en: "pidgeotto" },
  { zh: "大比鸟", en: "pidgeot" },
  { zh: "小拉达", en: "rattata" },
  { zh: "拉达", en: "raticate" },
  { zh: "烈雀", en: "spearow" },
  { zh: "大嘴雀", en: "fearow" },
  { zh: "阿柏蛇", en: "ekans" },
  { zh: "阿柏怪", en: "arbok" },
  { zh: "皮卡丘", en: "pikachu" },
  { zh: "雷丘", en: "raichu" },
  { zh: "穿山鼠", en: "sandshrew" },
  { zh: "穿山王", en: "sandslash" },
  { zh: "尼多兰♀", en: "nidoran-f" },
  { zh: "尼多娜", en: "nidorina" },
  { zh: "尼多后", en: "nidoqueen" },
  { zh: "尼多朗♂", en: "nidoran-m" },
  { zh: "尼多力诺", en: "nidorino" },
  { zh: "尼多王", en: "nidoking" },
  { zh: "皮皮", en: "clefairy" },
  { zh: "皮可西", en: "clefable" },
  { zh: "六尾", en: "vulpix" },
  { zh: "九尾", en: "ninetales" },
  { zh: "胖丁", en: "jigglypuff" },
  { zh: "胖可丁", en: "wigglytuff" },
  { zh: "超音蝠", en: "zubat" },
  { zh: "大嘴蝠", en: "golbat" },
  { zh: "走路草", en: "oddish" },
  { zh: "臭臭花", en: "gloom" },
  { zh: "霸王花", en: "vileplume" },
  { zh: "派拉斯", en: "paras" },
  { zh: "派拉斯特", en: "parasect" },
  { zh: "毛球", en: "venonat" },
  { zh: "摩鲁蛾", en: "venomoth" },
  { zh: "地鼠", en: "diglett" },
  { zh: "三地鼠", en: "dugtrio" },
  { zh: "喵喵", en: "meowth" },
  { zh: "猫老大", en: "persian" },
  { zh: "可达鸭", en: "psyduck" },
  { zh: "哥达鸭", en: "golduck" },
  { zh: "猴怪", en: "mankey" },
  { zh: "火暴猴", en: "primeape" },
  { zh: "卡蒂狗", en: "growlithe" },
  { zh: "风速狗", en: "arcanine" },
  { zh: "蚊香蝌蚪", en: "poliwag" },
  { zh: "蚊香君", en: "poliwhirl" },
  { zh: "蚊香泳士", en: "poliwrath" },
  { zh: "凯西", en: "abra" },
  { zh: "勇基拉", en: "kadabra" },
  { zh: "胡地", en: "alakazam" },
  { zh: "腕力", en: "machop" },
  { zh: "豪力", en: "machoke" },
  { zh: "怪力", en: "machamp" },
  { zh: "喇叭芽", en: "bellsprout" },
  { zh: "口呆花", en: "weepinbell" },
  { zh: "大食花", en: "victreebel" },
  { zh: "玛瑙水母", en: "tentacool" },
  { zh: "毒刺水母", en: "tentacruel" },
  { zh: "小拳石", en: "geodude" },
  { zh: "隆隆石", en: "graveler" },
  { zh: "隆隆岩", en: "golem" },
  { zh: "小火马", en: "ponyta" },
  { zh: "烈焰马", en: "rapidash" },
  { zh: "呆呆兽", en: "slowpoke" },
  { zh: "呆壳兽", en: "slowbro" },
  { zh: "小磁怪", en: "magnemite" },
  { zh: "三合一磁怪", en: "magneton" },
  { zh: "大葱鸭", en: "farfetchd" },
  { zh: "嘟嘟", en: "doduo" },
  { zh: "嘟嘟利", en: "dodrio" },
  { zh: "小海狮", en: "seel" },
  { zh: "白海狮", en: "dewgong" },
  { zh: "臭泥", en: "grimer" },
  { zh: "臭臭泥", en: "muk" },
  { zh: "大舌贝", en: "shellder" },
  { zh: "刺甲贝", en: "cloyster" },
  { zh: "鬼斯", en: "gastly" },
  { zh: "鬼斯通", en: "haunter" },
  { zh: "耿鬼", en: "gengar" },
  { zh: "大岩蛇", en: "onix" },
  { zh: "催眠貘", en: "drowzee" },
  { zh: "引梦貘人", en: "hypno" },
  { zh: "大钳蟹", en: "krabby" },
  { zh: "巨钳蟹", en: "kingler" },
  { zh: "霹雳电球", en: "voltorb" },
  { zh: "顽皮雷弹", en: "electrode" },
  { zh: "蛋蛋", en: "exeggcute" },
  { zh: "椰蛋树", en: "exeggutor" },
  { zh: "卡拉卡拉", en: "cubone" },
  { zh: "嘎啦嘎啦", en: "marowak" },
  { zh: "飞腿郎", en: "hitmonlee" },
  { zh: "快拳郎", en: "hitmonchan" },
  { zh: "大舌头", en: "lickitung" },
  { zh: "瓦斯弹", en: "koffing" },
  { zh: "双弹瓦斯", en: "weezing" },
  { zh: "独角犀牛", en: "rhyhorn" },
  { zh: "钻角犀兽", en: "rhydon" },
  { zh: "吉利蛋", en: "chansey" },
  { zh: "蔓藤怪", en: "tangela" },
  { zh: "袋兽", en: "kangaskhan" },
  { zh: "墨海马", en: "horsea" },
  { zh: "海刺龙", en: "seadra" },
  { zh: "角金鱼", en: "goldeen" },
  { zh: "金鱼王", en: "seaking" },
  { zh: "海星星", en: "staryu" },
  { zh: "宝石海星", en: "starmie" },
  { zh: "魔墙人偶", en: "mr-mime" },
  { zh: "飞天螳螂", en: "scyther" },
  { zh: "迷唇姐", en: "jynx" },
  { zh: "电击兽", en: "electabuzz" },
  { zh: "鸭嘴火兽", en: "magmar" },
  { zh: "凯罗斯", en: "pinsir" },
  { zh: "肯泰罗", en: "tauros" },
  { zh: "鲤鱼王", en: "magikarp" },
  { zh: "暴鲤龙", en: "gyarados" },
  { zh: "拉普拉斯", en: "lapras" },
  { zh: "百变怪", en: "ditto" },
  { zh: "伊布", en: "eevee" },
  { zh: "水伊布", en: "vaporeon" },
  { zh: "雷伊布", en: "jolteon" },
  { zh: "火伊布", en: "flareon" },
  { zh: "多边兽", en: "porygon" },
  { zh: "菊石兽", en: "omanyte" },
  { zh: "多刺菊石兽", en: "omastar" },
  { zh: "化石盔", en: "kabuto" },
  { zh: "镰刀盔", en: "kabutops" },
  { zh: "化石翼龙", en: "aerodactyl" },
  { zh: "卡比兽", en: "snorlax" },
  { zh: "急冻鸟", en: "articuno" },
  { zh: "闪电鸟", en: "zapdos" },
  { zh: "火焰鸟", en: "moltres" },
  { zh: "迷你龙", en: "dratini" },
  { zh: "哈克龙", en: "dragonair" },
  { zh: "快龙", en: "dragonite" },
  { zh: "超梦", en: "mewtwo" },
  { zh: "梦幻", en: "mew" },
] as const;

/** 洗牌（Fisher–Yates），返回新数组，不改池子。 */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 为一次分派分配 n 个显示名：
 * - 先排除 `reserved`（当前 active 子代理已占用的显示名 + 本批显式传入的名字）；
 * - 从剩余的池子里洗牌取前 n 个，保证同一批内不重复；
 * - 剩余候选不足时（并发 > 151 或池子被占满）用随机池值补齐——显示名允许重复。
 * 只返回中文显示名；空输入返回空数组。
 */
export function assignPokemonDisplayNames(count: number, reserved: readonly string[] = []): string[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const blocked = new Set(reserved);
  const available = GEN1_POKEMON_NAMES.map((entry) => entry.zh).filter((name) => !blocked.has(name));
  const picked = shuffled(available).slice(0, count);
  // 池子耗尽（并发大于池子容量）时补齐：显示名重复可接受，身份仍由 subagentId 保证。
  while (picked.length < count) {
    const index = Math.floor(Math.random() * GEN1_POKEMON_NAMES.length);
    picked.push(GEN1_POKEMON_NAMES[index].zh);
  }
  return picked;
}

/**
 * 为一批待分派项解析显示名：显式传入优先；缺失时从池子补，
 * 并排除 active 已占用与本批显式名字，保证同一批内不重复。
 * 返回顺序与输入一一对应（显式名字已归一化）。
 */
export function resolveBatchDisplayNames(
  items: ReadonlyArray<{ displayName?: string }>,
  reserved: readonly string[],
): string[] {
  const explicit = items.map((item) => normalizeSubagentDisplayName(item.displayName));
  const auto = assignPokemonDisplayNames(
    explicit.filter((name) => !name).length,
    [...reserved, ...explicit.filter((name): name is string => Boolean(name))],
  );
  let cursor = 0;
  return explicit.map((name) => name ?? auto[cursor++] ?? "");
}
