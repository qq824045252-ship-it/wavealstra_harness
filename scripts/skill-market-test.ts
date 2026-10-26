/**
 * 技能市场安装语义测试：安装=复制，市场源保留，列表不消失。
 * 通过 USERPROFILE 隔离到临时目录，不触碰真实 ~/.mybuddy。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsService } from "../src/main/skills/SkillsService";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), "skill-market-"));
process.env.USERPROFILE = base;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = base;

// 遗留市场源 ~/.mybuddy/skills
mkdirSync(join(base, ".mybuddy", "skills", "legacy-skill"), { recursive: true });
writeFileSync(
  join(base, ".mybuddy", "skills", "legacy-skill", "SKILL.md"),
  `---\nname: legacy-skill\ndescription: 遗留技能测试\nversion: 1.0.0\n---\n\n# legacy-skill\n`,
);

const service = new SkillsService();

console.log("[1] 安装前市场");
const before = service.listMarket();
assert(before.some((s) => s.name === "legacy-skill"), "市场含 legacy-skill");
const builtinCount = before.length;

console.log("\n[2] 安装");
const installed = service.installFromMarket("legacy-skill");
assert(installed.installed === true && installed.name === "legacy-skill", "安装成功（复制到 ~/.mybuddy/skills）");

console.log("\n[3] 安装后市场（核心断言：不消失）");
const after = service.listMarket();
assert(
  after.some((s) => s.name === "legacy-skill"),
  "安装后市场仍保留 legacy-skill（安装=复制，非迁移）",
);
assert(after.length === builtinCount, `市场条目数不变（${builtinCount} → ${after.length}）`);
assert(
  service.listInstalled().some((s) => s.name === "legacy-skill"),
  "已安装列表含 legacy-skill",
);

console.log("\n[4] 内置市场条目同样保留");
const builtinId = before.find((s) => s.author === "MyBuddy")?.id;
if (builtinId) {
  service.installFromMarket(builtinId!);
  const afterBuiltin = service.listMarket();
  assert(
    afterBuiltin.some((s) => s.id === builtinId),
    `内置技能 ${builtinId} 安装后仍在市场`,
  );
}

rmSync(base, { recursive: true, force: true });
console.log("\n全部通过 ✔");
process.exit(0);
