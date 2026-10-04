/**
 * CadRouter — Mechanical CAD 主链路由与自动规划（FreeCAD-only）。
 *
 * 纯模块（无 I/O，可单测）：
 * - capability registry：FreeCAD 原生能力（Sketcher/PartDesign/Spreadsheet/TechDraw/
 *   Assembly/FEM/Path/FCStd 结构/读回验证/导出）；
 * - routeCadRequest：主链恒为 freecad（多引擎概念已移除）；返回 matched capabilities
 *   与可用性，供 Agent 判断能力覆盖；
 * - buildCadPlan：生成 FreeCAD 原生工作流 read → spec → build → verify → export，
 *   绝不默认 "open + 裸脚本" 两步。
 */

import type { CadAvailability, CadEngineId, CadPlan, CadRouteDecision } from "./CadTypes";

export interface CadCapability {
  id: string;
  keywords: string[];
  description: string;
}

/** capability registry：FreeCAD 能力面的事实来源 */
export const CAD_CAPABILITIES: CadCapability[] = [
  { id: "sketcher", keywords: ["草图", "sketch", "约束", "全约束", "sketcher", "geometry constraint"], description: "Sketcher 草图与几何/尺寸约束（MCP 或受管脚本）" },
  { id: "partdesign", keywords: ["partdesign", "pad", "pocket", "部件设计", "特征建模", "特征"], description: "PartDesign Body/Pad/Pocket 特征建模" },
  { id: "spreadsheet", keywords: ["电子表格", "spreadsheet", "参数表", "表达式", "alias"], description: "Spreadsheet/表达式参数驱动" },
  { id: "techdraw", keywords: ["工程图", "图纸", "三视图", "techdraw", "出图", "svg 图纸", "dwg"], description: "TechDraw 工程图（三视图/尺寸）" },
  { id: "assembly_wb", keywords: ["装配", "assembly", "配合", "a2plus", "asm3"], description: "FreeCAD Assembly 工作台（A2+/A3）" },
  { id: "fem", keywords: ["有限元", "fem", "应力", "仿真"], description: "FEM 有限元分析" },
  { id: "path_cam", keywords: ["刀路", "cam", "path", "加工", "g代码"], description: "Path/CAM 刀路" },
  { id: "workbench_plugin", keywords: ["工作台", "插件", "workbench", "macro", "宏"], description: "Workbench/插件/宏" },
  { id: "fcstd_native", keywords: ["fcstd", "原生格式", "freecad 文件"], description: "FCStd 原生结构工作" },
  { id: "readback_verify", keywords: ["读回", "验证", "检查", "readback", "约束状态", "特征树", "recompute"], description: "FCStd 结构化读回验证（对象树/约束状态/Shape 有效性/体积）" },
  { id: "export", keywords: ["导出", "step", "stl", "export", "输出格式"], description: "STEP/STL 导出（FreeCAD 原生）" },
];

/**
 * 主链路由（纯函数）：恒为 freecad；返回命中能力与可用性。
 */
export function routeCadRequest(request: { goal: string; features?: string[]; override?: CadEngineId }, available: CadAvailability): CadRouteDecision {
  const text = `${request.goal ?? ""} ${(request.features ?? []).join(" ")}`.toLowerCase();
  const matched = CAD_CAPABILITIES.filter((cap) => cap.keywords.some((k) => text.includes(k.toLowerCase()))).map((c) => c.id);
  return {
    engine: "freecad",
    score: matched.length,
    reason:
      matched.length > 0
        ? `FreeCAD 能力命中: ${matched.join(", ")}`
        : "主链恒为 FreeCAD：Sketcher/PartDesign 参数化建模 → 读回验证 → 导出",
    matchedCapabilities: matched,
    availableEngines: { ...available },
    override: request.override === "freecad" ? "freecad" : undefined,
  };
}

/**
 * FreeCAD 原生建模计划（read → spec → build → verify → export）。
 * 输入：goal 自由文本 + 可选已有文件（step/fcstd）；输出结构化步骤。
 */
export function buildCadPlan(request: {
  goal: string;
  /** 已有文件（任务内 step/fcstd，相对 taskRoot；无则从空白建模） */
  inputFile?: string;
  features?: string[];
}): CadPlan {
  const decision = routeCadRequest(request, { freecad: true });
  const modelingSteps: CadPlan["modelingSteps"] = [];
  if (request.inputFile) {
    modelingSteps.push({
      step: "读取已有模型：cad_fcstd_readback（对象树/特征/约束状态/体积）或 STEP 导入检查",
      tool: "cad_fcstd_readback",
      args: { fcstd_file: request.inputFile },
    });
  } else {
    modelingSteps.push({
      step: "规格先行：先明确尺寸/基准/关键约束与公差（来自用户需求或文档），并用 cad_route 确认能力覆盖，再进入建模",
      tool: "cad_route",
      args: { goal: request.goal },
    });
  }
  modelingSteps.push({
    step: "freecad MCP 参数化建模（主通道，非裸脚本）：check_freecad_connection → sketch_operations（Sketcher 草图 fully constrained）→ partdesign_operations（PartDesign Body/Pad/Pocket/Hole/Pattern）；关键尺寸进 spreadsheet_operations；每完成可验证阶段 view_control(save_document) 落盘",
    tool: "view_control",
    args: { operation: "save_document" },
  });
  modelingSteps.push({
    step: "读回验证：cad_fcstd_readback（recompute 无错 / Shape valid / 草图约束状态 / 体积与关键属性）——必须在 MCP save_document 落盘后执行",
    tool: "cad_fcstd_readback",
    args: {},
  });
  modelingSteps.push({
    step: "交付：FreeCAD 导出 STEP/STL（结构化导出或受管脚本），需要时 cad_techdraw 三视图 + MCP 截图",
    tool: "cad_techdraw",
    args: {},
  });
  return {
    goal: request.goal,
    enginePlan: {
      engine: "freecad",
      reason: decision.reason,
      capabilities: decision.matchedCapabilities,
      steps: ["读取/规格", "Sketcher/PartDesign 参数化建模", "fcstd_readback 验证", "导出 STEP/STL + TechDraw"],
    },
    modelingSteps,
    verifyPlan: {
      tool: "cad_fcstd_readback",
      gates: [
        "recompute 无错误（readback.summary.recomputeErrors !== true）",
        "Shape 有效（readback.shape.valid 且实体数≥1）",
        "草图约束状态：sketch.conflicts/redundancies 非 true；solveStatus 含 fully constrained 或 fullyConstrained=true（null=无法判定，需人工确认）",
        "关键属性核对（volume/包围盒/关键特征存在）",
      ],
      gate: "required",
    },
    deliveryPlan: {
      formats: ["step", "stl"],
      artifacts: ["readback.json", "readback.step", "techdraw.svg/techdraw.fcstd", "get_view 截图"],
    },
  };
}
