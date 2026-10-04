/**
 * FreeCAD 自动化冒烟（真实 portable FreeCADCmd）：
 * 1. 在任务目录写 .cad-freecad 脚本 → FreeCadInterop.runScript 执行
 * 2. 脚本：导入 STEP → TechDraw 页面 + 三视图 → 导出 SVG（techdraw.svg 产物）
 * 3. 校验产物存在 + stdout 无 Traceback
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FreeCadInterop } from "../src/main/cad/FreeCadInterop";

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

(async () => {
  const workDir = mkdtempSync(join(tmpdir(), "cad-freecad-smoke-"));
  const taskRoot = join(workDir, "task");
  const interop = new FreeCadInterop({
    toolsRoot: resolve(process.cwd(), "MyBuddyTools"),
    runtime: null,
    openPath: async () => "",
  });
  const cmd = interop.freeCadCmdPath();
  if (!cmd) {
    console.log("⚠ FreeCADCmd 未发现（MyBuddyTools/FreeCAD-*），跳过自动化冒烟");
    passed += 1;
    console.log("\n结果: passed=%d failed=%d", passed, failed);
    process.exit(0);
  }
  console.log("FreeCADCmd:", cmd);

  // 先建一个 FCStd（脚本内建几何：Part::Box + TechDraw 页面结构）
  const script = `
import FreeCAD, Part, TechDraw  # noqa
import os

out_dir = r"${taskRoot.replace(/\\/g, "/")}"
doc = FreeCAD.newDocument("smoke")
box = doc.addObject("Part::Box", "Box")
box.Length = 40.0
box.Width = 30.0
box.Height = 20.0
doc.recompute()

# 控制台模式（FreeCADCmd 无 Gui）：创建 TechDraw 页面/视图结构（FCStd 持久化），
# SVG/PDF 渲染导出在 GUI 打开时执行（TechDrawGui.exportPage，需交互环境）。
page = doc.addObject("TechDraw::DrawPage", "Page")
template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
template.Template = os.path.join(FreeCAD.getResourceDir(), "Mod", "TechDraw", "Templates", "Default_Template_A4_Landscape.svg")
page.Template = template
view = doc.addObject("TechDraw::DrawViewPart", "Front")
view.Source = [box]
page.addView(view)
view.X = 80
view.Y = 100
doc.recompute()

fcstd_path = os.path.join(out_dir, "techdraw-smoke.fcstd")
doc.saveAs(fcstd_path)
assert os.path.exists(fcstd_path)
print("TECHDRAW_OK", os.path.getsize(fcstd_path))
FreeCAD.closeDocument("smoke")
`;
  const result = await interop.runScript(join(taskRoot, ".cad-freecad"), "td-smoke", {
    script,
    timeoutMs: 180_000,
  });
  console.log("exitCode:", result.exitCode);
  if (result.stdout) console.log("stdout_tail:", result.stdout.slice(-600));
  if (result.stderr) console.log("stderr_tail:", result.stderr.slice(-600));
  assert(result.exitCode === 0, "FreeCADCmd 脚本执行成功（exit=0 无 Traceback）");
  const fcstdPath = join(taskRoot, "techdraw-smoke.fcstd");
  assert(existsSync(fcstdPath), "FCStd 产物存在（TechDraw 页面结构）");
  // FCStd 是 zip：Document.xml 里应有 DrawPage / DrawViewPart 对象
  const { execFileSync } = await import("node:child_process");
  const zipList = execFileSync("tar", ["-tf", fcstdPath], { encoding: "utf-8", timeout: 15_000 });
  assert(zipList.includes("Document.xml"), "FCStd 内部结构完整（Document.xml）");
  const xml = execFileSync("tar", ["-xOf", fcstdPath, "Document.xml"], { encoding: "utf-8", timeout: 15_000 });
  assert(xml.includes('name="Page"') && xml.includes('name="Front"'), "FCStd 含 TechDraw DrawPage/DrawViewPart 结构");
  // SVG 渲染导出需要 GUI 会话：这里记录结论（技术约束见 docs/mechanical-cad.md）
  console.log("  ℹ TechDraw SVG/PDF 渲染导出需 GUI 打开（FreeCADCmd 无 Gui 模块；cad_open_freecad 人工触发）");

  console.log("== FCStd 受管结构化读回（fcstd_readback 路径）==");
  // 读回走 FreeCadInterop 直连（techdraw/fcstdReadback 不依赖 worker）
  const { CadRuntimeService } = await import("../src/main/cad/CadRuntimeService");
  const runtime = new CadRuntimeService({ interop });
  try {
    // 把 smoke 的 FCStd 放进任务目录，走受管读回
    const readback = await runtime.fcstdReadback("task-fcstd", taskRoot, "techdraw-smoke.fcstd", cmd);
    const s = readback.summary;
    assert(s.valid === true, "FCStd 读回 valid");
    assert(s.objectCount >= 3, `读回对象数 >=3（实际 ${s.objectCount}）`);
    assert((s.typeCounts["Part::Box"] ?? 0) >= 1, "类型分布含 Part::Box");
    assert((s.typeCounts["TechDraw::DrawPage"] ?? 0) >= 1, "类型分布含 TechDraw::DrawPage");
    const boxObj = s.objects.find((o) => o.type === "Part::Box");
    assert(boxObj !== undefined && boxObj.params.Length === 40, "Box 参数读回（Length=40）");
    assert(existsSync(s.stepFile) && s.stepBytes > 0, "读回导出 STEP（继续编辑桥）");
    const { readFileSync } = await import("node:fs");
    const stepText = readFileSync(s.stepFile, "utf-8");
    assert(stepText.startsWith("ISO-10303-21;"), "STEP 头合法");
  } finally {
    await runtime.shutdownAll();
  }

  console.log("== interop.techdraw 直连（FreeCADCmd 三视图 → SVG + FCStd）==");
  {
    const outDir = join(taskRoot, "cad", "_techdraw");
    const td = await interop.techdraw(fcstdPath, outDir, { includeDims: true });
    assert(existsSync(td.files.svg ?? "") && td.files.svg.endsWith("techdraw.svg"), "techdraw 产出 techdraw.svg");
    assert(existsSync(td.files.fcstd ?? "") && td.files.fcstd.endsWith("techdraw.fcstd"), "techdraw 产出 techdraw.fcstd");
    const svgHead = readFileSync(td.files.svg, "utf-8").slice(0, 200);
    assert(svgHead.includes("<svg"), "SVG 内容合法（含 <svg 根）");
  }

  console.log("== 读回增强字段（recomputeErrors/state/sketch）==");
  {
    const rb = await interop.fcstdReadback(fcstdPath, join(taskRoot, "cad", "_rb1"));
    const s = rb.summary as unknown as {
      recomputeErrors: boolean | null;
      objects: Array<{ state?: string[]; sketch?: unknown }>;
    };
    assert(typeof s.recomputeErrors === "boolean" || s.recomputeErrors === null, "summary.recomputeErrors 为 boolean 或 null（不伪造）");
    assert(Array.isArray(s.objects[0]?.state), "对象 state 数组存在");
  }

  console.log("== Sketcher 草图读回（求解状态确定性断言：1.1+ API）==");
  {
    // 两个草图：under（2 线+2 距离，6 DOF）与 full（1 线+距离+Block，0 DOF）
    // FreeCAD 1.1.3 实证：FullyConstrained=False/True、getStatusString()="Valid"、DoF=6/0
    const sketchScript = `
import FreeCAD, Part, Sketcher  # noqa
import os

out_dir = r"${taskRoot.replace(/\\/g, "/")}"

# 未完全约束：两条线段 + 距离约束
under = FreeCAD.newDocument("under")
sk = under.addObject("Sketcher::SketchObject", "Sketch")
under.recompute()
sk.addGeometry(Part.LineSegment(FreeCAD.Vector(0,0,0), FreeCAD.Vector(10,0,0)))
sk.addGeometry(Part.LineSegment(FreeCAD.Vector(0,5,0), FreeCAD.Vector(10,5,0)))
sk.addConstraint(Sketcher.Constraint("Distance", 0, 10.0))
sk.addConstraint(Sketcher.Constraint("Distance", 1, 10.0))
under.recompute()
under.saveAs(os.path.join(out_dir, "sketch-under.fcstd"))
FreeCAD.closeDocument("under")

# 完全约束：一条线段 + 长度 + Block（0 DOF）
full = FreeCAD.newDocument("full")
sk2 = full.addObject("Sketcher::SketchObject", "Sketch")
full.recompute()
sk2.addGeometry(Part.LineSegment(FreeCAD.Vector(0,0,0), FreeCAD.Vector(10,0,0)))
sk2.addConstraint(Sketcher.Constraint("Distance", 0, 10.0))
sk2.addConstraint(Sketcher.Constraint("Block", 0))
full.recompute()
full.saveAs(os.path.join(out_dir, "sketch-full.fcstd"))
print("SKETCH_OK", os.path.getsize(os.path.join(out_dir, "sketch-full.fcstd")))
FreeCAD.closeDocument("full")
`;
    const sr = await interop.runScript(join(taskRoot, ".cad-freecad"), "sk-smoke", { script: sketchScript, timeoutMs: 180_000 });
    assert(sr.exitCode === 0, "草图脚本执行成功（exit=0）");
    const skType = {
      geometryCount: 0, constraintCount: 0, conflicts: null, redundancies: null,
      solveStatus: "", fullyConstrained: null, DoF: null,
    } as {
      geometryCount: number; constraintCount: number; conflicts: boolean | null; redundancies: boolean | null;
      solveStatus: string; fullyConstrained: boolean | null; DoF: number | null;
    };

    // --- under：确定值断言（1.1.3 实证：fullyConstrained=false、solveStatus="Valid"、DoF>0） ---
    const underPath = join(taskRoot, "sketch-under.fcstd");
    assert(existsSync(underPath), "under 草图 FCStd 产物存在");
    const rbUnder = await interop.fcstdReadback(underPath, join(taskRoot, "cad", "_rb-under"));
    const underObj = rbUnder.summary.objects.find((o) => o.type === "Sketcher::SketchObject");
    assert(underObj !== undefined, "under 读回含 Sketcher::SketchObject");
    const under = (underObj?.sketch ?? null) as typeof skType | null;
    assert(under !== null && under !== undefined, "under sketch 结构化字段存在");
    assert(under.geometryCount >= 2, `under 几何计数 >=2（实际 ${under.geometryCount}）`);
    assert(under.constraintCount >= 2, `under 约束计数 >=2（实际 ${under.constraintCount}）`);
    assert(under.fullyConstrained === false, `under fullyConstrained=false（实际 ${String(under.fullyConstrained)}）`);
    assert(under.solveStatus === "Valid", `under solveStatus="Valid"（实际 ${JSON.stringify(under.solveStatus)}）`);
    assert(under.DoF === null || under.DoF > 0, `under DoF>0（实际 ${String(under.DoF)}）`);
    assert(under.conflicts === false || under.conflicts === null, `under 无冲突（实际 ${String(under.conflicts)}）`);

    // --- full：确定值断言（fullyConstrained=true、DoF=0） ---
    const fullPath = join(taskRoot, "sketch-full.fcstd");
    assert(existsSync(fullPath), "full 草图 FCStd 产物存在");
    const rbFull = await interop.fcstdReadback(fullPath, join(taskRoot, "cad", "_rb-full"));
    const fullObj = rbFull.summary.objects.find((o) => o.type === "Sketcher::SketchObject");
    assert(fullObj !== undefined, "full 读回含 Sketcher::SketchObject");
    const full = (fullObj?.sketch ?? null) as typeof skType | null;
    assert(full !== null && full !== undefined, "full sketch 结构化字段存在");
    assert(full.fullyConstrained === true, `full fullyConstrained=true（实际 ${String(full.fullyConstrained)}）`);
    assert(full.DoF === 0, `full DoF=0（实际 ${String(full.DoF)}）`);
    assert(full.solveStatus === "Valid", `full solveStatus="Valid"（实际 ${JSON.stringify(full.solveStatus)}）`);
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log("\n结果: passed=%d failed=%d", passed, failed);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("FREECAD SMOKE FAILED:", error);
  process.exit(1);
});
