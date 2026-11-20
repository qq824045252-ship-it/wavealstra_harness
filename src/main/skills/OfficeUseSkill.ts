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
    `新建用 ${office.documentCreate}。修改已打开的文件，先用 ${office.selectionRead} 读取目标，再用 ${office.selectionPropose} 提交确认。`,
    `样式、Excel 图表和冻结窗格、幻灯片备注和形状用 ${office.editPropose}。通过 ${office.reviewStatus} 区分待确认、已应用、已复验和已保存。`,
  ].join(" ");
}
