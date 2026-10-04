// 验证 mybuddy 技能目录可被 pi loadSkills 发现（与 SkillsService.listInstalled 相同调用）
import { loadSkills } from "@earendil-works/pi-coding-agent";

const { skills } = loadSkills({
  cwd: "C:/Users/servi/Desktop/mybuddy",
  agentDir: "C:/Users/servi/.mybuddy",
  skillPaths: [],
  includeDefaults: true,
});

const ardotSkills = skills.filter((s) =>
  ["ardot", "ardot-design-assistant", "image-to-ui", "image-understanding-native"].includes(s.name)
);

for (const s of ardotSkills) {
  console.log(
    `FOUND name=${s.name} | disableModelInvocation=${s.disableModelInvocation} | file=${s.filePath}`
  );
}

// 检查插件技能引用的关键相对路径文件是否可达
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const base = "C:/Users/servi/.mybuddy/skills/ardot-design-generator/skills/ardot-design-assistant";
const checks = [
  join(base, "SKILL.md"),
  join(base, "..", "..", "rules", "design-rules.md"),        // ../../rules/design-rules.md
  join(base, "..", "..", "rules", "style-guide.md"),
  join(base, "..", "..", "rules", "style-guide-tags.md"),
  join(base, "references", "ardot-workflow.md"),
  join(base, "references", "slides-workflow.md"),
  join(base, "references", "slides-agent-teams-workflow.md"),
  join(base, "references", "design-to-code-workflow.md"),
  "C:/Users/servi/.mybuddy/skills/ardot/SKILL.md",
];
for (const c of checks) {
  console.log(`${existsSync(resolve(c)) ? "OK  " : "MISS"} ${resolve(c)}`);
}

console.log(`\nTotal ardot-related skills discovered: ${ardotSkills.length}/4`);
process.exit(ardotSkills.length === 4 ? 0 : 1);
