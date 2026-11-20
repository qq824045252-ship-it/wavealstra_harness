import { app } from "electron";
import { join } from "node:path";

export function drawioUseSkillDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "builtin-skills", "drawio-use")
    : join(app.getAppPath(), "vendor", "drawio", "skill", "drawio-use");
}

export function drawioUseInstructions(writable: boolean): string {
  const read = "处理 Draw.io 或需要交付可编辑图表时，加载 drawio-use 技能。用 drawio_read 核对图纸，用 drawio_reference 获取官方格式规范，用 drawio_shapes 查真实形状。";
  return writable ? read + " 标准图用 Mermaid 创建，精确图用 Draw.io XML。使用 drawio_create、drawio_edit、drawio_layout 和 drawio_export 交付任务产物。" : read;
}
