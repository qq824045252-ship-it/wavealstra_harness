import { app } from "electron";
import { join } from "node:path";
import { OFFICE_USE_TOOLS as office } from "../../shared/office-use";

export function officeUseSkillDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "builtin-skills", "office-use")
    : join(app.getAppPath(), "vendor", "craft-office", "skill", "office-use");
}

export function officeUseInstructions(writable: boolean): string {
  const inspect = `处理 DOCX、XLSX 或 PPTX 时，先读 Office Use 技能和对应格式的参考，再用 ${office.documentRead} 查看结构和定位目标。用 ${office.documentRender} 检查页面、幻灯片或当前 Excel 工作表的可见区域。`;
  if (!writable) return inspect;
  return [
    inspect,
    `先按任务需要选择对应的上游 Skill。用 ${office.nativeTools} 获取 WordCraft、GridCraft 或 DeckCraft 的真实工具参数，再用 ${office.nativeCall} 执行上游工具。需要用户确认的面板编辑用 ${office.selectionPropose} 或 ${office.editPropose}，用 ${office.reviewStatus} 查询回执。`,
  ].join(" ");
}
