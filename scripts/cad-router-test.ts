/**
 * CAD Router / Planner 单元测试（FreeCAD-only 主链）：
 * - capability registry：FreeCAD 能力面（sketcher/partdesign/spreadsheet/techdraw/...）
 * - routeCadRequest：主链恒为 freecad；reason/matchedCapabilities 结构化返回
 * - buildCadPlan：read → spec → build → verify → export 阶段；verify gate 为 fcstd_readback
 */
import { buildCadPlan, CAD_CAPABILITIES, routeCadRequest } from "../src/main/cad/CadRouter";

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

const AVAILABLE = { freecad: true };
const NO_FREECAD = { freecad: false };

console.log("== capability registry（FreeCAD-only）==");
assert(CAD_CAPABILITIES.length >= 10, `capability registry 完备（${CAD_CAPABILITIES.length} 项）`);
assert(CAD_CAPABILITIES.some((c) => c.id === "sketcher"), "含 sketcher 能力");
assert(CAD_CAPABILITIES.some((c) => c.id === "partdesign"), "含 partdesign 能力");
assert(CAD_CAPABILITIES.some((c) => c.id === "techdraw"), "含 techdraw 能力");
assert(CAD_CAPABILITIES.some((c) => c.id === "readback_verify"), "含 readback_verify 能力");

console.log("== 主链路由恒为 freecad ==");
const r1 = routeCadRequest({ goal: "创建一个直径 40 的法兰盘，中心孔 6mm，厚度 10" }, AVAILABLE);
assert(r1.engine === "freecad", `常规参数化 → freecad（实际 ${r1.engine}）`);
assert(r1.reason.length > 0, "reason 结构化返回");
const r1b = routeCadRequest({ goal: "画一个带全约束的草图" }, AVAILABLE);
assert(r1b.matchedCapabilities.includes("sketcher"), "草图目标命中 sketcher 能力");

const r2 = routeCadRequest({ goal: "用 TechDraw 出三视图工程图并标注尺寸" }, AVAILABLE);
assert(r2.engine === "freecad" && r2.matchedCapabilities.includes("techdraw"), "TechDraw 命中 techdraw 能力");

const r3 = routeCadRequest({ goal: "画一个盒子" }, AVAILABLE);
assert(r3.engine === "freecad", "无特定能力命中仍恒为 freecad");

const r4 = routeCadRequest({ goal: "用 Sketcher 画一个带几何约束的草图" }, AVAILABLE);
assert(r4.matchedCapabilities.includes("sketcher"), "草图命中 sketcher");

const r5 = routeCadRequest({ goal: "对支架做 FEM 应力仿真" }, AVAILABLE);
assert(r5.matchedCapabilities.includes("fem"), "FEM 命中 fem");

const r6 = routeCadRequest({ goal: "对零件做 FCStd 读回验证" }, AVAILABLE);
assert(r6.matchedCapabilities.includes("readback_verify"), "读回验证命中 readback_verify");

const r7 = routeCadRequest({ goal: "任何建模任务" }, NO_FREECAD);
assert(r7.engine === "freecad" && r7.availableEngines.freecad === false, "freecad 不可用时仍返回 freecad 决策（可用性如实）");

console.log("== 自动规划（read/spec/build/verify/export）==");
const plan = buildCadPlan({ goal: "做一批法兰零件" });
assert(plan.enginePlan.engine === "freecad", "plan engine=freecad");
assert(plan.modelingSteps.length >= 4, `modeling steps >= 4（实际 ${plan.modelingSteps.length}）`);
assert(
  plan.modelingSteps.some((s) => s.step.includes("读取已有模型") || s.step.includes("规格先行")),
  "第一步为读取/规格（非 open+裸脚本）",
);
assert(plan.modelingSteps.some((s) => s.tool === "cad_fcstd_readback"), "含读回验证步骤");
assert(plan.modelingSteps.some((s) => s.step.includes("Sketcher") && s.step.includes("PartDesign")), "建模步骤为 Sketcher/PartDesign 参数化");
assert(
  !plan.modelingSteps.some((s) => s.tool === "cad_freecad_run"),
  "主建模通道不默认 cad_freecad_run（执行面矛盾修复：MCP structured tools 为主）",
);
assert(
  plan.modelingSteps.some((s) => s.tool === "view_control" && s.args?.operation === "save_document"),
  "建模链含 view_control(save_document) 落盘步骤（保存闭环）",
);
assert(plan.verifyPlan.tool === "cad_fcstd_readback" && plan.verifyPlan.gate === "required", "verify gate=fcstd_readback/required");
assert(plan.verifyPlan.gates.some((g) => g.includes("recompute")), "verify gate 含 recompute 检查");
assert(plan.verifyPlan.gates.some((g) => g.includes("fully constrained")), "verify gate 含全约束检查");
assert(plan.deliveryPlan.formats.includes("step"), "delivery 含 step");
assert(plan.deliveryPlan.artifacts.includes("readback.json"), "delivery 含 readback.json");

const planWithFile = buildCadPlan({ goal: "修改这个支架", inputFile: "part.fcstd" });
assert(planWithFile.modelingSteps[0].tool === "cad_fcstd_readback", "有输入文件时第一步为读回");

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
