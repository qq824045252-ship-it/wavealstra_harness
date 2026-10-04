/**
 * CAD Skill 同步检查（SimpleCAD→FreeCAD 迁移收尾）：轻量、无外部依赖。
 *
 * 验证：
 * 1) 本地 marketplace（mybuddyskills-main/skills）能发现 freecad 技能；
 * 2) installFromMarket("freecad") 安装到隔离 USERPROFILE 的 ~/.mybuddy/skills/freecad
 *    （SKILL.md + _skillhub_meta.json），listInstalled 命中；
 * 3) mechanical-cad 预设 skillPolicy.allow:["freecad"] 在 SkillPolicy 过滤后命中该技能
 *    （→ 安装到真实 ~/.mybuddy/skills 后运行时注入生效）。
 * 必须经 scripts/test-guard.mjs 执行；不触碰真实 ~/.mybuddy。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { SkillsService, findLocalSkillMarketDirs } from "../src/main/skills/SkillsService";
import { DESIGN_MODE_PRESETS } from "../src/main/agent/mode-defaults";

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

const base = mkdtempSync(join(tmpdir(), "cad-skill-sync-"));
// 隔离 USERPROFILE：homedir() 惰性读取，保证不触碰真实 ~/.mybuddy
process.env.USERPROFILE = base;
const fakeMybuddySkills = join(base, ".mybuddy", "skills");
mkdirSync(fakeMybuddySkills, { recursive: true });

console.log("== [1] marketplace 发现 freecad（本地市场源） ==");
{
  const roots = findLocalSkillMarketDirs();
  const devRoot = join(process.cwd(), "mybuddyskills-main", "skills");
  assert(roots.some((r) => resolve(r) === resolve(devRoot)), "marketplace 根含仓库 mybuddyskills-main/skills");
  const service = new SkillsService();
  const market = service.listMarket();
  const freecad = market.find((s) => s.id === "freecad" || s.name === "freecad");
  assert(freecad !== undefined, "市场发现 freecad");
  assert(freecad !== undefined && freecad.sourcePath && existsSync(freecad.sourcePath), "freecad 市场项有真实磁盘源");
  assert(freecad !== undefined && existsSync(join(freecad.sourcePath, "SKILL.md")), "市场源含 SKILL.md");
}

console.log("== [2] installFromMarket 安装 + listInstalled 命中 ==");
{
  const service = new SkillsService();
  const installed = service.installFromMarket("freecad");
  const dest = join(fakeMybuddySkills, "freecad");
  assert(existsSync(join(dest, "SKILL.md")), "安装副本 SKILL.md 存在");
  assert(existsSync(join(dest, "_skillhub_meta.json")), "安装元信息 _skillhub_meta.json 存在");
  const meta = JSON.parse(readFileSync(join(dest, "_skillhub_meta.json"), "utf-8")) as { id?: string; source?: string };
  assert(meta.id === "freecad", "元信息 id=freecad");
  assert(installed.name === "freecad" || installed.id === "freecad", "installFromMarket 返回安装项");
  const listed = service.listInstalled();
  assert(listed.some((s) => s.name === "freecad" && s.installed), "listInstalled 命中 freecad");
  const content = readFileSync(join(dest, "SKILL.md"), "utf-8");
  assert(content.includes("name: freecad") && content.includes("cad_fcstd_readback"), "安装副本内容完整（frontmatter + 主链）");
}

console.log("== [3] mechanical-cad 预设已退役 ==");
{
  const preset = DESIGN_MODE_PRESETS.find((p) => p.id === "mechanical-cad");
  assert(preset === undefined, "mechanical-cad 预设已退役");
}

rmSync(base, { recursive: true, force: true });
console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
