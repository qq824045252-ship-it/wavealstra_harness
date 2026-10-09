/**
 * SkillsService 聚合根目录顶层 stray SKILL.md 防复发测试（P2-2）。
 *
 * 背景：~/.mybuddy/skills 是聚合根（每个子目录一个技能）；顶层 SKILL.md 是非法扁平安装，
 * pi SDK 会把聚合根当成单一 top-level 技能并停止下钻，导致全部子技能静默只剩 1 个。
 *
 * 验证：
 * 1) 构造 顶层 SKILL.md（stray）+ 两个子技能 → listInstalled 后子技能全部可见（不被遮蔽）、
 *    stray 不参与发现；
 * 2) stray 被隔离/重命名为 SKILL.md.stray（原路径消失），有 warning 记录；
 * 3) 二次扫描幂等；市场列表不受影响；
 * 4) 隔离后再误放顶层 SKILL.md → 再次被隔离（防复发闭环）。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-root-guard-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

// eslint-disable-next-line import/first
import {
  SkillsService,
  STRAY_ROOT_SKILL_QUARANTINE_NAME,
} from "../src/main/skills/SkillsService";
// eslint-disable-next-line import/first
import { getSkillsDir } from "../src/main/paths";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

async function main(): Promise<void> {
  // 聚合根已迁移到 ~/.mybuddy/plugins/skills（PluginStorage v1）。旧断言写死迁移前路径，
  // 导致隔离产物被写到 plugins/ 下而测试在旧路径上查找 → 必然失败（且迁移让旧路径断言空转通过）。
  const skillsRoot = getSkillsDir();

  console.log("== [1] 顶层 stray SKILL.md + 子技能并存 ==");
  write(join(skillsRoot, "SKILL.md"), "---\nname: stray-root\ndescription: 非法扁平安装\n---\n# stray\n");
  write(join(skillsRoot, "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: 子技能 A\n---\n# A\n");
  write(join(skillsRoot, "skill-b", "SKILL.md"), "---\nname: skill-b\ndescription: 子技能 B\n---\n# B\n");

  console.log("== [2] listInstalled：子技能不被遮蔽、stray 被隔离 ==");
  const service = new SkillsService();
  const installed = service.listInstalled();
  const names = installed.map((s) => s.name);
  assert(names.includes("skill-a") && names.includes("skill-b"), "子技能 skill-a/skill-b 均被发现（不再被顶层遮蔽）");
  assert(!names.includes("stray-root"), "stray 顶层技能不参与发现");
  assert(!existsSync(join(skillsRoot, "SKILL.md")), "顶层 SKILL.md 原路径已不存在（被隔离）");
  assert(existsSync(join(skillsRoot, STRAY_ROOT_SKILL_QUARANTINE_NAME)), `隔离文件 ${STRAY_ROOT_SKILL_QUARANTINE_NAME} 存在`);
  assert(installed.length >= 2, `发现技能总数 ≥ 2（实际 ${installed.length}）`);

  console.log("== [3] 幂等 + 市场不受影响 ==");
  const second = service.listInstalled();
  assert(second.length === installed.length, "二次扫描幂等（不重复报错/不重复隔离）");
  const market = service.listMarket();
  assert(market.length >= 2, "市场列表仍可发现子技能（≥2）");
  assert(!market.some((m) => m.id === "stray-root"), "stray 不进市场");

  console.log("== [4] 防复发：隔离后再次误放顶层 SKILL.md ==");
  write(join(skillsRoot, "SKILL.md"), "stray again");
  const third = service.listInstalled();
  assert(third.some((s) => s.name === "skill-a") && third.some((s) => s.name === "skill-b"), "再次误放后子技能仍全部可见");
  assert(!existsSync(join(skillsRoot, "SKILL.md")), "再次误放被再次隔离");
  assert(third.length >= 2, "总技能数正常");

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
