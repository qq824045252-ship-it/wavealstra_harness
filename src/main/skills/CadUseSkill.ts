import { app } from "electron";
import { join } from "node:path";
import { CAD_USE_TOOLS } from "../../shared/cadcraft";

export function cadUseSkillDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "builtin-skills", "cad-use")
    : join(app.getAppPath(), "vendor", "cadcraft", "skill", "cad-use");
}

export function cadUseInstructions(writable: boolean): string {
  const inspect = `处理 DWG、DXF 或二维 CAD 时，使用 ${CAD_USE_TOOLS.inspect} 读取图纸单位、几何和图元 handle。`;
  if (!writable) return inspect;
  return [
    inspect,
    `新建用 ${CAD_USE_TOOLS.create}。修改已有图元时，先读取目标，再用 ${CAD_USE_TOOLS.edit} 保存同格式副本，最后读取副本复验。`,
    `沿用原图单位。导出其他格式用 ${CAD_USE_TOOLS.export}。`,
  ].join(" ");
}
