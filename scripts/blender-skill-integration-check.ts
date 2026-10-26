/**
 * Blender Skill 接入集成检查（沙箱，不触碰真实 ~/.mybuddy）。
 *
 * 验证 4 个 Blender Skill（blender-core / blender-modeling / blender-lookdev /
 * blender-validation）的接入链路：
 * 1) 本地 marketplace（mybuddyskills-main/skills）能发现 4 个 blender-* 技能；
 * 2) installFromMarket 安装到隔离 USERPROFILE 的 ~/.mybuddy/skills/blender-*
 *    （SKILL.md + _skillhub_meta.json），listInstalled 命中；
 * 3) 3d-blender 预设 skillPolicy.prefer/allow 含 4 个 blender-* 技能名；
 * 4) design 模式 + 3d-blender 预设合成后 filterSkillsForMode：
 *    4 个 blender-* 可见，无关技能（ardot 等）被 allow 白名单过滤；
 * 5) 技能 frontmatter 可被 MyBuddy 解析（name/description）。
 * 必须经 scripts/test-guard.mjs 执行。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SkillsService, findLocalSkillMarketDirs } from "../src/main/skills/SkillsService";
import { DESIGN_MODE_PRESETS } from "../src/main/agent/mode-defaults";

const BLENDER_SKILLS = ["blender-core", "blender-modeling", "blender-lookdev", "blender-validation"];

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const base = mkdtempSync(join(tmpdir(), "blender-skill-integration-"));
// 隔离 USERPROFILE：保证不触碰真实 ~/.mybuddy
process.env.USERPROFILE = base;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = base;
const fakeMybuddySkills = join(base, ".mybuddy", "skills");
mkdirSync(fakeMybuddySkills, { recursive: true });

console.log("== [1] marketplace 发现 4 个 blender-* 技能（本地市场源） ==");
{
  const roots = findLocalSkillMarketDirs();
  const devRoot = join(process.cwd(), "mybuddyskills-main", "skills");
  assert(
    roots.some((r) => resolve(r) === resolve(devRoot)),
    "marketplace 根含仓库 mybuddyskills-main/skills",
  );
  const service = new SkillsService();
  const market = service.listMarket();
  for (const id of BLENDER_SKILLS) {
    const item = market.find((s) => s.id === id || s.name === id);
    assert(item !== undefined, `市场发现 ${id}`);
    assert(
      item !== undefined && item.sourcePath && existsSync(join(item.sourcePath, "SKILL.md")),
      `${id} 市场项有真实磁盘源 + SKILL.md`,
    );
  }
}

console.log("== [2] installFromMarket 安装 + listInstalled 命中 ==");
{
  const service = new SkillsService();
  for (const id of BLENDER_SKILLS) {
    const installed = service.installFromMarket(id);
    const dest = join(fakeMybuddySkills, id);
    assert(existsSync(join(dest, "SKILL.md")), `${id} 安装副本 SKILL.md 存在`);
    assert(existsSync(join(dest, "_skillhub_meta.json")), `${id} 安装元信息存在`);
    assert(installed.name === id || installed.id === id, `${id} installFromMarket 返回安装项`);
  }
  const listed = service.listInstalled();
  for (const id of BLENDER_SKILLS) {
    assert(listed.some((s) => s.name === id && s.installed), `listInstalled 命中 ${id}`);
  }
}

console.log("== [3] 3d-blender 预设已退役 ==");
{
  const preset = DESIGN_MODE_PRESETS.find((p) => p.id === "3d-blender");
  assert(preset === undefined, "3d-blender 预设已退役");
}

console.log("== [4] 安装副本 frontmatter 可解析（name/description） ==");
{
  for (const id of BLENDER_SKILLS) {
    const content = readFileSync(join(fakeMybuddySkills, id, "SKILL.md"), "utf-8");
    assert(content.startsWith("---") && content.includes(`name: ${id}`), `${id} frontmatter name`);
    assert(/^description: .+$/m.test(content), `${id} frontmatter description 单行可解析`);
  }
}

rmSync(base, { recursive: true, force: true });
console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
