/**
 * ExpertService 单测（沿用 test:memory 模式：esbuild bundle 后 node 直跑）。
 *
 * 覆盖：内置市场 / 安装 / 启停 / 角色注入 / 官方插件格式导入（zip+目录）/
 * 导出回读 / 卸载 / 单专家包过滤。
 * 测试使用临时 USERPROFILE，不触碰真实 ~/.mybuddy。
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

// ---- 隔离环境：把 HOME/USERPROFILE 指到临时目录（必须在 import 服务前设置） ----
const sandbox = join(tmpdir(), `mybuddy-expert-test-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

// eslint-disable-next-line import/first
import { ExpertService } from "../src/main/experts/ExpertService";

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

async function main(): Promise<void> {
  console.log("[expert-test] sandbox:", sandbox);
  const svc = new ExpertService();

  // ---------- 1. 内置市场 ----------
  console.log("\n1. 市场与安装");
  const market = svc.listMarket();
  assert(market.length >= 3, `内置市场 ≥3 位专家（实际 ${market.length}）`);
  assert(market.some((e) => e.id === "weekly-report"), "市场含 weekly-report");
  assert(market.some((e) => e.id === "data-analysis"), "市场含 data-analysis");
  assert(market.some((e) => e.id === "doc-polish"), "市场含 doc-polish");
  assert(svc.listInstalled().length === 0, "初始未安装任何专家");

  const installed = svc.installFromMarket("weekly-report");
  assert(installed.installed && installed.enabled, "安装后 installed/enabled=true");
  assert(installed.source === "builtin-market", "来源 = builtin-market");
  const promptPath = join(sandbox, ".mybuddy", "experts", "weekly-report", "prompt.md");
  assert(existsSync(promptPath), "prompt.md 已写入");
  const promptMd = readFileSync(promptPath, "utf-8");
  assert(promptMd.startsWith("---\nname: weekly-report"), "prompt.md 保留官方 frontmatter 格式");
  assert(promptMd.includes("周报撰写专家"), "prompt.md 正文含人设");

  // ---------- 2. 启停 ----------
  console.log("\n2. 启停");
  const disabled = svc.setEnabled("weekly-report", false);
  assert(!disabled.enabled, "setEnabled(false) 生效");
  let roleErr = "";
  try {
    svc.getRolePrompt("weekly-report");
  } catch (err) {
    roleErr = err instanceof Error ? err.message : String(err);
  }
  assert(roleErr.includes("已停用"), "停用后注入被拦截");
  const enabled2 = svc.setEnabled("weekly-report", true);
  assert(enabled2.enabled, "setEnabled(true) 恢复");

  // ---------- 3. 角色注入 ----------
  console.log("\n3. 角色注入");
  const role = svc.getRolePrompt("weekly-report");
  assert(role.kind === "expert", "角色 kind=expert");
  assert(role.prompt.startsWith("## 专家角色"), "注入段以 ## 专家角色 开头");
  assert(role.prompt.includes("你是资深职场周报撰写专家"), "注入段含角色正文");
  assert(role.prompt.includes("典型任务示例"), "注入段含任务示例");

  // ---------- 4. 官方插件格式：目录导入 ----------
  console.log("\n4. 官方 .codebuddy-plugin 目录导入");
  const pluginDir = join(sandbox, "imports", "senior-ai-agent");
  mkdirSync(join(pluginDir, ".codebuddy-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "agents"), { recursive: true });
  mkdirSync(join(pluginDir, "avatars"), { recursive: true });
  mkdirSync(join(pluginDir, "skills", "architecture-review", "references"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({
      name: "senior-ai-agent",
      version: "2.1.0",
      description: "来自市场的描述",
      displayName: { zh: "高级 AI Agent 研发专家", en: "Senior AI Agent Expert" },
      tags: ["RAG", "架构"],
      category: "数据智能",
      author: "YuSec",
    }),
  );
  writeFileSync(
    join(pluginDir, "agents", "senior-ai-agent.md"),
    `---
name: senior-ai-agent
description: AI Agent 架构设计审查与 RAG 工程化
displayName:
  zh: "高级 AI Agent 研发专家"
tags: [RAG, Agent架构]
category: 数据智能
---

# 高级 AI Agent 研发专家

你是一位资深的 AI Agent 研发专家，精通 RAG 工程化与向量数据库优化。
`,
  );
  writeFileSync(join(pluginDir, "avatars", "expert.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(
    join(pluginDir, "skills", "architecture-review", "SKILL.md"),
    `---
name: architecture-review
description: 审查 Agent 架构
---

# Architecture Review
`,
  );
  writeFileSync(
    join(pluginDir, "skills", "architecture-review", "references", "checklist.md"),
    `# Review Checklist\n\n- runtime boundary\n- capability scope\n`,
  );
  writeFileSync(join(pluginDir, "skills", "architecture-review", "_user_meta.json"), JSON.stringify({ sourcePath: "C:/Users/private/source" }));
  writeFileSync(join(pluginDir, "skills", "architecture-review", "_skillhub_meta.json"), JSON.stringify({ source: "local", sourcePath: "C:/Users/private/market" }));

  const imported = svc.installByPath(pluginDir);
  assert(imported.id === "senior-ai-agent", `目录导入 id 正确（${imported.id}）`);
  assert(imported.name === "高级 AI Agent 研发专家", "displayName.zh 优先于 name");
  assert(imported.description === "来自市场的描述", "plugin.json description 覆盖 agents frontmatter");
  assert(imported.tags.includes("RAG"), "tags 来自 plugin.json");
  assert(imported.source === "folder", "来源 = folder");
  assert(existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "avatar.png")), "头像已拷贝");
  assert(
    existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review", "SKILL.md")),
    "目录导入保留 Private Skill",
  );
  assert(!existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review", "_user_meta.json")), "目录导入剔除 Private Skill 本机 user metadata");
  assert(!existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review", "_skillhub_meta.json")), "目录导入剔除 Private Skill 本机 market metadata");
  const dirRole = svc.getRolePrompt("senior-ai-agent");
  assert(dirRole.prompt.includes("RAG 工程化"), "导入专家角色可注入");

  // ---------- 5. zip 导入（官方「导入专家」流） ----------
  console.log("\n5. zip 导入");
  const zip = new JSZip();
  zip.file(
    ".codebuddy-plugin/plugin.json",
    JSON.stringify({ name: "weekly-report", version: "1.2.0", displayName: { zh: "周报撰写专家" }, tags: ["周报"] }),
  );
  zip.file(
    "agents/weekly-report.md",
    `---
name: weekly-report
displayName:
  zh: "周报撰写专家"
---

# 周报撰写专家（zip 版）

测试用 zip 导入的周报专家。
`,
  );
  zip.file("avatars/expert.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const zipPath = join(sandbox, "weekly-report.zip");
  writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));

  const zipImported = await svc.importZip(zipPath);
  assert(zipImported.id === "weekly-report" && zipImported.source === "zip", "zip 导入覆盖安装（id/source 正确）");
  assert(zipImported.version === "1.2.0", "zip 版本来自 plugin.json");
  assert(existsSync(join(sandbox, ".mybuddy", "experts", "weekly-report", "avatar.png")), "zip 头像已解出");
  const zipRole = svc.getRolePrompt("weekly-report");
  assert(zipRole.prompt.includes("zip 版"), "zip 导入的角色提示词生效");

  // ---------- 6. 导出 → 回读（格式兼容） ----------
  console.log("\n6. 导出回读");
  const installedPrivateDir = join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review");
  writeFileSync(join(installedPrivateDir, "_user_meta.json"), JSON.stringify({ sourcePath: "C:/Users/private/legacy" }));
  writeFileSync(join(installedPrivateDir, "_skillhub_meta.json"), JSON.stringify({ sourcePath: "C:/Users/private/legacy-market" }));
  const outsideSecret = join(sandbox, "outside-private-skill-secret.txt");
  writeFileSync(outsideSecret, "must never be exported", "utf-8");
  let exportSymlinkCreated = false;
  try {
    symlinkSync(outsideSecret, join(installedPrivateDir, "outside-secret-link.txt"), "file");
    exportSymlinkCreated = true;
  } catch {
    // Windows may deny symlink creation without Developer Mode; metadata defense is still exercised.
  }
  const exportPath = await svc.exportZip("senior-ai-agent");
  assert(existsSync(exportPath), `导出 zip 已生成（${exportPath}）`);
  const exportBuf = readFileSync(exportPath);
  const exportZip = await JSZip.loadAsync(exportBuf);
  const pluginJson = JSON.parse(await exportZip.file(".codebuddy-plugin/plugin.json")!.async("string"));
  assert(pluginJson.name === "senior-ai-agent", "导出 plugin.json.name 正确");
  assert(pluginJson.displayName.zh === "高级 AI Agent 研发专家", "导出 displayName 正确");
  const agentMd = await exportZip.file("agents/senior-ai-agent.md")!.async("string");
  assert(agentMd.includes("# 高级 AI Agent 研发专家"), "导出 agents/*.md 内容完整");
  assert(exportZip.file("avatars/")?.dir === undefined || exportZip.file("avatars/expert.png") !== undefined, "导出含头像");
  assert(exportZip.file("skills/architecture-review/SKILL.md") !== null, "导出包含 Private Skill");
  assert(
    exportZip.file("skills/architecture-review/references/checklist.md") !== null,
    "导出递归保留 Private Skill 附属文件",
  );
  assert(exportZip.file("skills/architecture-review/_user_meta.json") === null, "导出不包含遗留 user metadata");
  assert(exportZip.file("skills/architecture-review/_skillhub_meta.json") === null, "导出不包含遗留 market metadata");
  if (exportSymlinkCreated) assert(exportZip.file("skills/architecture-review/outside-secret-link.txt") === null, "导出不跟随 package 外 symlink");

  // 导出包再导入（模拟生态流转）
  const reimport = await svc.importZip(exportPath);
  assert(reimport.id === "senior-ai-agent" && reimport.source === "zip", "导出的包可被再次导入");
  assert(
    existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review", "SKILL.md")),
    "导出包重导入后 Private Skill 仍存在",
  );
  assert(
    existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent", "skills", "architecture-review", "references", "checklist.md")),
    "导出包重导入后 Private Skill 附属文件仍存在",
  );
  assert(
    svc.listExpertPrivateSkills("senior-ai-agent").some((skill) => skill.id === "architecture-review"),
    "重导入后 Private Skill 可被运行时枚举",
  );

  // ---------- 7. Team packages are removed ----------
  console.log("\n7. Expert-only contract");
  assert(!svc.listMarket().some((e) => e.id === "review-team"), "team entries are absent from expert market");
  let teamInstallErr = "";
  try {
    svc.installFromMarket("team:review-team");
  } catch (err) {
    teamInstallErr = err instanceof Error ? err.message : String(err);
  }
  assert(teamInstallErr.includes("仅支持单专家"), "team install is explicitly rejected");
  let teamRoleErr = "";
  try {
    svc.getRolePrompt("team:review-team");
  } catch (err) {
    teamRoleErr = err instanceof Error ? err.message : String(err);
  }
  assert(teamRoleErr.includes("仅支持单专家"), "team role resolution is explicitly rejected");

  // ---------- 8. Uninstall expert ----------
  console.log("\n8. Uninstall expert");
  svc.uninstall("senior-ai-agent");
  assert(!existsSync(join(sandbox, ".mybuddy", "experts", "senior-ai-agent")), "expert directory removed");
  assert(svc.listInstalled().every((e) => e.id !== "senior-ai-agent"), "uninstalled expert absent from list");
  let uninstallErr = "";
  try {
    svc.uninstall("senior-ai-agent");
  } catch (err) {
    uninstallErr = err instanceof Error ? err.message : String(err);
  }
  assert(uninstallErr.includes("未找到已安装专家"), "repeated uninstall reports error");

  // ---------- 9. Local market: single experts only ----------
  console.log("\n9. Local market expert-only filtering");
  const marketRoot = join(sandbox, ".mybuddy", "expert-market", "experts");
  const agentPkg = join(marketRoot, "demo-agent");
  const teamPkg = join(marketRoot, "demo-team");
  for (const dir of [agentPkg, teamPkg]) {
    mkdirSync(join(dir, ".codebuddy-plugin"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "avatars"), { recursive: true });
  }
  writeFileSync(
    join(agentPkg, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo-agent",
      displayName: { zh: "Demo Expert", en: "Demo Expert" },
      profession: { zh: "Demo Expert", en: "Demo Expert" },
      displayDescription: { zh: "local expert package", en: "local expert package" },
      categoryId: "09-OperationsHR",
      expertType: "agent",
      agentName: "demo-agent",
      version: "1.0.0",
    }),
  );
  writeFileSync(join(agentPkg, "agents", "demo-agent.md"), `---\nname: demo-agent\n---\n\n# Demo Expert\n\nSingle expert package.\n`);
  writeFileSync(join(agentPkg, "avatars", "demo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  writeFileSync(
    join(teamPkg, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo-team",
      displayName: { zh: "Demo Team" },
      expertType: "team",
      teamInfo: { leadAgent: "lead-agent", memberAgents: ["lead-agent"] },
      members: [{ id: "lead-agent", name: { zh: "Lead" }, profession: { zh: "Lead" }, role: "lead" }],
      version: "1.0.0",
    }),
  );
  writeFileSync(join(teamPkg, "agents", "lead-agent.md"), `---\nname: lead-agent\n---\n\n# Lead\n\nTeam package.\n`);

  const market2 = svc.listMarket();
  assert(market2.some((e) => e.id === "demo-agent"), "local single expert appears in market");
  assert(!market2.some((e) => e.id === "demo-team"), "team package is filtered from market");

  let teamPathErr = "";
  try {
    svc.installByPath(teamPkg);
  } catch (err) {
    teamPathErr = err instanceof Error ? err.message : String(err);
  }
  assert(teamPathErr.includes("仅支持单专家包"), "team folder import is rejected");

  const demoInstalled = svc.installFromMarket("demo-agent");
  assert(demoInstalled.source === "local-market", "local single expert installs normally");
  assert(existsSync(join(sandbox, ".mybuddy", "experts", "demo-agent", "avatar.png")), "local expert avatar copied");
  svc.uninstall("demo-agent");

  // ---------- 汇总 ----------
  console.log(`\n[expert-test] ${passed} passed, ${failed} failed`);
  rmSync(sandbox, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[expert-test] fatal", err);
  process.exit(1);
});
