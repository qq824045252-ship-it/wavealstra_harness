/**
 * 本地技能/连接器冒烟：真实安装 mybuddyskills-main 的技能与连接器。
 * 用法：pnpm test:skill-connector
 */
import { SkillsService } from "../src/main/skills/SkillsService";
import { ConnectorService } from "../src/main/connectors/ConnectorService";

function main(): void {
  // 1. 技能市场（只读源，按需安装）
  const skills = new SkillsService();
  const market = skills.listMarket();
  console.log(`[skills] 市场技能总数: ${market.length}`);
  const localCount = market.filter((s) => s.author === "MyBuddy 官方").length;
  console.log(`[skills] MyBuddy 官方源: ${localCount}`);
  const sample = market.find((s) => s.id === "12306") ?? market.find((s) => s.author === "MyBuddy 官方");
  console.log(`[skills] 示例: ${sample?.id} | ${sample?.name} | ${sample?.description?.slice(0, 40)}`);
  // 按需安装一个
  if (sample) {
    const installed = skills.installFromMarket(sample.id);
    console.log(`[skills] 安装「${sample.id}」→ ${installed.name} @ ${installed.filePath}`);
    const again = skills.installFromMarket(sample.id);
    console.log(`[skills] 重复安装（覆盖）→ ${again.name}`);
  }
  console.log(`[skills] 当前已安装总数: ${skills.listInstalled().length}`);

  // 2. 连接器
  const connectors = new ConnectorService();
  const list = connectors.list();
  console.log(`\n[connectors] 市场连接器: ${list.length}，已安装: ${list.filter((c) => c.installed).length}`);
  console.log("[connectors] 前 12 个:");
  for (const c of list.slice(0, 12)) {
    console.log(`  ${c.id} | ${c.name} | ${c.type ?? "?"} | 技能=${c.skillCount} | init=${c.initCommand ?? "-"}`);
  }

  // 安装示例连接器：anydev（1 技能）+ feishu（28 技能）
  for (const id of ["anydev", "feishu"]) {
    try {
      const names = connectors.install(id);
      console.log(`\n[connectors] 安装 ${id} → 技能 ${names.length} 个: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`);
    } catch (err) {
      console.log(`[connectors] 安装 ${id} 失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  const after = connectors.list();
  console.log(`\n[connectors] 安装后已装: ${after.filter((c) => c.installed).map((c) => c.id).join(", ")}`);
  const skills2 = new SkillsService();
  console.log(`[skills] 安装连接器后技能总数: ${skills2.listInstalled().length}`);
}

main();
