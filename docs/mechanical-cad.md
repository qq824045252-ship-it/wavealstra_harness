# Mechanical CAD（FreeCAD 主链）

MyBuddy 机械 CAD 主链：**LLM → Mechanical CAD 情景/Tag → FreeCAD Skill/Policy →
FreeCAD MCP + native 薄工具 → FreeCAD Runtime → inspect/verify/export**。
kernel 后端已随 2026-08 主链切换移除；FCStd 由 FreeCAD 自身产生与编辑。

## 架构

```
用户/LLM
  → design + mechanical-cad preset（promptAddon：read→spec→build→verify→export）
  → FreeCAD Skill（Sketcher/PartDesign 工作纪律）+ skillPolicy（allow: freecad）
  → FreeCAD MCP（uvx freecad-mcp ↔ GUI addon 127.0.0.1:9875）   ← 结构化建模优先
  ＋ native 工具（6）：
     cad_route / cad_plan         能力路由与执行计划
     cad_fcstd_readback           结构化读回（对象/State/草图约束状态）+ STEP 导出
     cad_techdraw                 三视图工程图（SVG + FCStd）
     cad_open_freecad             GUI 打开
     cad_freecad_run              FreeCADCmd 受管脚本（escape hatch，审批）
  → FreeCAD Runtime（FreeCADRuntime provider 启动/健康 + FreeCadInterop.runScript 无头）
  → verify：readback 的 recomputeErrors / shape.valid / sketch 约束状态 + get_view 截图
```

## 文件

| 文件 | 职责 |
|---|---|
| `src/main/cad/FreeCadInterop.ts` | FreeCADCmd 定位/受管脚本/techdraw/fcstdReadback/open |
| `src/main/cad/freecad-scripts.ts` | FreeCADCmd 内嵌脚本（techdraw 三视图、FCStd 结构化读回） |
| `src/main/cad/CadRouter.ts` | 能力路由（恒 freecad）+ 自动计划（read/spec/build/verify/export） |
| `src/main/cad/cad-extension.ts` | 6 个 native 工具注册（design + mechanical-cad 条件注入） |
| `src/main/cad/CadRuntimeService.ts` | task 级 facade（interop + artifact 注册） |
| `src/main/cad/CadArtifactService.ts` | TechDraw/FCStd 读回产物注册 |
| `src/main/cad/CadTypes.ts` | 主链数据契约 |
| `src/main/professional-tools/ProfessionalToolRuntime.ts` | FreeCADRuntime（FreeCAD.exe + MCP addon 健康） |
| `mybuddyskills-main/skills/freecad/SKILL.md` | FreeCAD 原生建模工作流技能 |

## FCStd 受管结构化读回（验证 gate）

`cad_fcstd_readback`（FreeCADCmd console）输出 `readback.json`：
- document：`recomputeErrors`（recompute 后失败态；API 不可得 → null）
- 对象：name/label/type/**State**（如 Invalid/Touched）/标量参数/shape（valid/solids/faces/edges/volume）
- Sketcher::SketchObject：`geometryCount`/`constraintCount`/`conflicts`/`redundancies`/
  `solveStatus`/`fullyConstrained`（无法稳定判定 → null，绝不伪造通过）
- 另导出 `readback.step`（继续编辑桥）

边界（诚实声明）：受管结构化读回，非完整参数化读回；参数化语义保留在源 FCStd。

## 产物

```
cad/_techdraw/       techdraw.svg + techdraw.fcstd
cad/_fcstd_readback/ readback.json + readback.step
```
产物经 CadArtifactService 注册（entryFile 幂等 + producer 溯源）。

## 测试

- `test:cad-router` / `test:cad-security` / `test:cad-extension` / `test:cad-artifact`（guarded 单测）
- `test:cad-freecad`（真实 portable FreeCADCmd：脚本执行/TechDraw 结构/读回增强字段/草图约束状态/techdraw 直连）
- 全部经 `scripts/test-guard.mjs`（6GB/900s 护栏）执行。

## 数据保留

`app.db.cad_models` 表与迁移保留（dormant：历史 kernel 模型索引，停止新写）。
