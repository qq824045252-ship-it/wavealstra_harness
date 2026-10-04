/**
 * 本地专家市场冒烟：扫描真实专家包 + 安装一个单专家。
 * 用法：pnpm test:expert-market [expert-id]
 */
import { ExpertService } from "../src/main/experts/ExpertService";

function main(): void {
  const svc = new ExpertService();
  const market = svc.listMarket();
  console.log(`[market] 专家条目: ${market.length}`);
  console.log(`[market] 已安装专家: ${svc.listInstalled().length}`);

  const byCategory = new Map<string, number>();
  for (const e of market) {
    const c = e.category ?? "未分类";
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
  }
  console.log("\n[market] 分类分布:");
  for (const [c, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }

  const keywords = ["会议", "周报", "报告", "PPT", "Excel", "文档", "邮件", "简历", "法务", "财务", "HR", "招聘", "营销"];
  console.log("\n[market] 办公场景专家示例（含关键词）:");
  for (const e of market) {
    if (keywords.some((k) => e.name.includes(k) || e.description.includes(k) || e.id.includes(k.toLowerCase()))) {
      console.log(`  ${e.id} | ${e.name} | ${e.author} | ${e.description.slice(0, 50)}`);
    }
  }

  const target = process.argv[2] ?? "ai-meeting-notes";
  try {
    const installed = svc.installFromMarket(target);
    console.log(`\n[install] 「${target}」→ ${installed.name} (${installed.id}), source=${installed.source}, filePath=${installed.filePath}`);
    const role = svc.getRolePrompt(installed.id);
    console.log(`[install] 角色注入: ${role.prompt.slice(0, 100).replace(/\n/g, " ")}…`);
  } catch (err) {
    console.log(`[install] 「${target}」失败: ${err instanceof Error ? err.message : err}`);
  }
}

main();
