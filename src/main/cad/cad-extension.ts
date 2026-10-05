/**
 * CadExtension — Mechanical CAD native tools 注入（pi extension factory）。
 *
 * 仅在 design + mechanical-cad preset 下条件注入（AgentService.createSession 决定），
 * 不污染其它模式。安全链：
 * - cad_* 属于 native 工具（McpSideEffectPolicy 已纳入判定，不会误判 MCP）
 * - cad_freecad_run 是任意 FreeCAD Python 逃生通道：dangerous + 强制审批（auto 模式除外）
 * - 所有文件路径参数都被限制在 taskRoot 内
 */
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { isPathInsideOrEqual } from "../task/TaskExecutionWorkspace";
import { CAD_DIR_NAME, type CadAvailability } from "./CadTypes";
import { CadToolError, type CadRuntimeService } from "./CadRuntimeService";
import type { CadArtifactService } from "./CadArtifactService";
import type { FreeCadInterop } from "./FreeCadInterop";
import { buildCadPlan, routeCadRequest } from "./CadRouter";
import { codeExecutionEvidenceIdentity, executeVerifiedProcess, type VerifiedProcessBridge } from "../agent/VerifiedCodeExecution";
import { recordCadFreeCadRuntimeFailure, resolveCadFreeCadRuntimeFailure } from "../agent/CadFailureRecovery";
import {
  fcstdReadbackSchema,
  freeCadRunSchema,
  openFreeCadSchema,
  planSchema,
  routeSchema,
  techdrawSchema,
  type FcstdReadbackParams,
  type FreeCadRunParams,
  type OpenFreeCadParams,
  type PlanParams,
  type RouteParams,
  type TechdrawParams,
} from "./CadToolDefinitions";

/**
 * CAD 扩展注入 gate（纯函数，可单测）：
 * 仅在 design + mechanical-cad preset 下注入 cad_* native tools，不污染其它模式。
 */
export function shouldInjectCadExtension(
  welcomeMode: string,
  modePresetId: string | null | undefined,
): boolean {
  // Retained only for legacy callers. Bot never installs this approval-wrapped extension.
  return welcomeMode === "design" && modePresetId === "mechanical-cad";
}

export interface CadApprovalRequest {
  toolCallId: string;
  toolName: string;
  summary: string;
  detail?: string;
  dangerous: boolean;
}

export interface CadExtensionBridge {
  taskId: string;
  taskRoot: string;
  runtime: CadRuntimeService;
  artifacts?: CadArtifactService | null;
  freeCad?: FreeCadInterop | null;
  getPermissionMode: () => PermissionMode;
  /** 当前 assistant messageId（artifact producer 溯源用；无则 undefined） */
  getProducerMessageId: () => string | undefined;
  requestApproval: (info: CadApprovalRequest) => Promise<boolean>;
  /** Main-session process outcome evidence for the dangerous FreeCAD script escape hatch. */
  verification?: VerifiedProcessBridge;
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const cadError = error instanceof CadToolError ? error : new CadToolError(
    error instanceof Error ? error.message : String(error),
    "internal",
  );
  return {
    content: [{ type: "text" as const, text: `[cad] ${cadError.code}: ${cadError.message}` }],
    isError: true,
    details: { error: cadError.code, message: cadError.message },
  };
}

/** 校验 model_id 形如 m-<hex>（防路径穿越） */
function assertSafeModelId(modelId: string): void {
  if (!/^m-[a-zA-Z0-9-]{8,64}$/.test(modelId)) {
    throw new CadToolError(`非法 model_id: ${modelId}`, "invalid_model_id");
  }
}

/** 校验可选 model_id（防路径穿越）；未提供则跳过 */
function assertSafeModelIdSafe(modelId: string | undefined): void {
  if (modelId) assertSafeModelId(modelId);
}

export function createCadExtension(bridge: CadExtensionBridge): ExtensionFactory {
  const { taskId, taskRoot } = bridge;

  const requireRuntime = (): CadRuntimeService => bridge.runtime;

  /** 产物 producer 溯源（messageId 来自 AgentService 会话上下文；toolCallId 是本次工具调用） */
  const producerOf = (toolCallId: string): { messageId?: string; toolCallId: string } => ({
    messageId: bridge.getProducerMessageId(),
    toolCallId,
  });

  const cadAvailability = (): CadAvailability => ({
    freecad: bridge.freeCad?.available ?? false,
  });

  return (pi: ExtensionAPI) => {
    // ---------- 高层 ----------




    // ---------- 中层 ----------








    pi.registerTool({
      name: "cad_open_freecad",
      label: "机械 CAD · 在 FreeCAD 中打开",
      description:
        "把模型 STEP（或 FCStd）交给 FreeCAD 打开（保留现有 FreeCAD MCP runtime 链路）。" +
        "用于人工精修、Sketcher/PartDesign 交互式建模、TechDraw 出图等。",
      promptSnippet: "cad_open_freecad(model_id | file) — 在 FreeCAD 中打开",
      parameters: openFreeCadSchema,
      execute: async (tc, params: OpenFreeCadParams) => {
        try {
          const freeCad = bridge.freeCad;
          if (!freeCad) return errorResult(new CadToolError("FreeCAD 互操作未配置", "freecad_unavailable"));
          let file: string | null = params.file ?? null;
          if (params.model_id) {
            assertSafeModelId(params.model_id);
            const step = resolve(taskRoot, "cad", params.model_id, "model.step");
            if (isPathInsideOrEqual(taskRoot, step)) file = step;
          }
          if (!file) return errorResult(new CadToolError("需要 model_id 或 file", "invalid_params"));
          const abs = isAbsolute(file) ? file : resolve(taskRoot, file);
          if (!isPathInsideOrEqual(taskRoot, abs)) {
            return errorResult(new CadToolError(`文件必须在任务目录内: ${file}`, "out_of_task"));
          }
          const result = await freeCad.openInFreeCAD(abs);
          return result.ok
            ? textResult(`✅ ${result.detail}`, result)
            : errorResult(new CadToolError(result.detail, "open_failed"));
        } catch (error) {
          return errorResult(error);
        }
      },
    });


    // ---------- P1/P2：路由 / 规划 ----------



    pi.registerTool({
      name: "cad_route",
      label: "机械 CAD · 能力路由",
      description:
        "结构化能力路由：根据任务目标/feature 与 capability registry 返回 FreeCAD 命中能力 " +
        "（Sketcher/PartDesign/Spreadsheet/TechDraw/Assembly/FEM/Path-CAM/FCStd/读回验证/导出）与 reason/score。" +
        "主链恒为 FreeCAD；用于确认能力覆盖，不用于选引擎。",
      promptSnippet: "cad_route(goal, features?) — FreeCAD 能力覆盖路由",
      parameters: routeSchema,
      execute: async (_tc, params: RouteParams) => {
        try {
          const decision = routeCadRequest({ goal: params.goal, features: params.features }, cadAvailability());
          return textResult(
            [
              `引擎: ${decision.engine}（score=${decision.score}）`,
              `原因: ${decision.reason}`,
              `匹配能力: ${decision.matchedCapabilities.join(", ") || "（无）"}`,
              `FreeCAD 可用: ${decision.availableEngines.freecad}`,
            ].filter(Boolean).join("\n"),
            decision,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "cad_plan",
      label: "机械 CAD · 自动规划",
      description:
        "把结构化需求拆成 FreeCAD 原生执行计划：read（读取已有模型/规格）→ spec（尺寸/基准/约束规划）→ " +
        "build（Sketcher/PartDesign 参数化建模）→ verify（cad_fcstd_readback 结构化 gate）→ export（STEP/STL/TechDraw）。" +
        "计划是建议：Agent 按顺序执行对应 cad_* / FreeCAD MCP 工具；不默认裸脚本。",
      promptSnippet: "cad_plan(goal, inputFile?, features?) — FreeCAD 主链执行计划",
      parameters: planSchema,
      execute: async (_tc, params: PlanParams) => {
        try {
          const plan = buildCadPlan({
            goal: params.goal,
            inputFile: params.inputFile,
            features: params.features,
          });
          return textResult(
            [
              `引擎计划: ${plan.enginePlan.engine} — ${plan.enginePlan.reason}`,
              `  步骤: ${plan.enginePlan.steps.join(" → ")}`,
              `建模步骤:`,
              ...plan.modelingSteps.map((s, i) => `  ${i + 1}. [${s.tool}] ${s.step}`),
              `验证 gate: ${plan.verifyPlan.tool}（${plan.verifyPlan.gates.join("；")}）`,
              `交付: ${plan.deliveryPlan.formats.join(", ")} / ${plan.deliveryPlan.artifacts.join(", ")}`,
            ].join("\n"),
            plan,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    // ---------- P1：GLB 3D 预览 ----------


    // ---------- P2：STEP 逆向 / 比较 ----------





    // ---------- P2：装配 ----------










    // ---------- P1：TechDraw / FreeCAD 受管脚本 ----------

    pi.registerTool({
      name: "cad_techdraw",
      label: "机械 CAD · 工程图",
      description:
        "从模型生成工程图（真实 FreeCAD TechDraw：DrawPage + Front/Top/Right 三视图 + 尺寸标注）：" +
        "输出 techdraw.svg（console 合成）与 techdraw.fcstd（含 DrawPage，可在 FreeCAD GUI 打开继续编辑）。" +
        "限制：FreeCADCmd console 无 TechDrawGui（PDF 导出依赖 TechDrawGui，headless 不可用——已实测），" +
        "format=pdf 显式拒绝并返回原因；全页 SVG 由 viewPartAsSvg 合成。",
      promptSnippet: "cad_techdraw(model_id|step_file|fcstd_file) — 三视图工程图",
      parameters: techdrawSchema,
      execute: async (tc, params: TechdrawParams, signal?: AbortSignal) => {
        try {
          if (params.format === "pdf") {
            return errorResult(new CadToolError(
              "PDF 导出需要 TechDrawGui（FreeCAD GUI），FreeCADCmd headless 不可用（已实测：console 无法加载 Gui 模块）。" +
              "请在 FreeCAD GUI 中打开 techdraw.fcstd 手动导出 PDF，或使用 format=svg（默认）。",
              "techdraw_pdf_requires_gui",
            ));
          }
          if (params.model_id) assertSafeModelId(params.model_id);
          const freeCad = bridge.freeCad;
          if (!freeCad || !freeCad.available) {
            return errorResult(new CadToolError("FreeCADCmd 不可用：TechDraw 需要 portable FreeCAD", "freecad_unavailable"));
          }
          const result = await bridge.runtime.techdraw(taskId, taskRoot, {
            modelId: params.model_id,
            stepFile: params.step_file,
            fcstdFile: params.fcstd_file,
            format: params.format,
            includeDims: params.include_dims,
          }, freeCad.freeCadCmdPath() ?? undefined, { signal, producer: producerOf(tc) });
          return textResult(
            `✅ 工程图已生成（engine=${result.engine}）\n${Object.entries(result.files).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
            result,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "cad_fcstd_readback",
      label: "机械 CAD · FCStd 受管读回",
      description:
        "FCStd 受管结构化读回（FreeCADCmd console）：打开 FCStd → 结构化摘要（对象名/类型/关键参数/形状体积）" +
        "+ 导出 STEP（readback.step）。边界（诚实声明）：这是“受管结构化读回 + 继续编辑”路径，不是完整参数化读回；" +
        "参数化语义保留在源 FCStd 内，读出的 STEP 可进入 cad_techdraw 等下游继续编辑闭环。",
      promptSnippet: "cad_fcstd_readback(fcstd_file) — FCStd 结构化读回 + STEP 导出",
      parameters: fcstdReadbackSchema,
      execute: async (tc, params: FcstdReadbackParams, signal?: AbortSignal) => {
        try {
          const freeCad = bridge.freeCad;
          if (!freeCad || !freeCad.available) {
            return errorResult(new CadToolError("FreeCADCmd 不可用：FCStd 读回需要 portable FreeCAD", "freecad_unavailable"));
          }
          const abs = resolve(taskRoot, params.fcstd_file);
          if (!isPathInsideOrEqual(taskRoot, abs)) {
            return errorResult(new CadToolError(`文件必须在任务目录内: ${params.fcstd_file}`, "out_of_task"));
          }
          const result = await bridge.runtime.fcstdReadback(
            taskId, taskRoot, params.fcstd_file, freeCad.freeCadCmdPath() ?? undefined,
            { signal, producer: producerOf(tc) },
          );
          const s = result.summary;
          return textResult(
            [
              `✅ FCStd 读回完成（${s.objectCount} 对象 / ${s.shapeObjectCount} 形状对象，engine=${result.engine}）`,
              `类型分布: ${JSON.stringify(s.typeCounts)}`,
              ...s.objects.slice(0, 12).map((o) => `  - ${o.name} [${o.type}] label=${o.label}`),
              s.objects.length > 12 ? `  …（共 ${s.objects.length} 个对象，完整摘要见 readback.json）` : "",
              `STEP 导出: ${s.stepFile}（${s.stepBytes} bytes）→ 可用 cad_step_import/reconstruct/techdraw 继续编辑`,
            ].filter((l) => l !== "").join("\n"),
            result,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "cad_freecad_run",
      label: "机械 CAD · FreeCAD 脚本执行",
      description:
        "在 FreeCADCmd（portable，独立控制台进程，绝不触碰用户 GUI FreeCAD）中执行受管 Python 脚本。" +
        "脚本运行于 FreeCAD 自带 Python 3.11 环境（FreeCAD/Part/Import/TechDraw 模块可用）；" +
        "参数经 JSON 文件传递，脚本内用 fc_args() 读取（argv 会被 FreeCAD 重置，勿依赖 sys.argv）。" +
        "危险：脚本可读写任务目录内任意文件，需人工审批（auto 模式除外）；" +
        "仅作 escape hatch（FreeCAD MCP/结构化工具不可达时的兜底），不作为常规建模推荐路径。",
      promptSnippet: "cad_freecad_run(script, args?) — FreeCADCmd 受管脚本（危险，需审批）",
      parameters: freeCadRunSchema,
      execute: async (toolCallId, params: FreeCadRunParams, signal?: AbortSignal) => {
        try {
          const freeCad = bridge.freeCad;
          if (!freeCad || !freeCad.available) {
            const runtimeError = new CadToolError("FreeCADCmd 不可用", "freecad_unavailable");
            if (!signal?.aborted) recordCadFreeCadRuntimeFailure(bridge.verification, runtimeError.message);
            return errorResult(runtimeError);
          }
          resolveCadFreeCadRuntimeFailure(bridge.verification);
          const mode = bridge.getPermissionMode();
          if (mode !== "auto") {
            const approved = await bridge.requestApproval({
              toolCallId,
              toolName: "cad_freecad_run",
              summary: `FreeCAD 脚本执行：${params.script.slice(0, 120)}`,
              detail: `任务 ${taskId} 内执行 FreeCAD Python（portable FreeCADCmd）\n${params.script.slice(0, 2000)}`,
              dangerous: true,
            });
            if (!approved) {
              return {
                content: [{ type: "text" as const, text: "[cad_freecad_run] 用户已拒绝执行" }],
                isError: true,
                details: { error: "rejected" },
              };
            }
          }
          const scriptsDir = resolve(taskRoot, CAD_DIR_NAME, "_freecad_scripts");
          const name = `fc_${Date.now().toString(36)}`;
          const evidenceIdentity = codeExecutionEvidenceIdentity({
            language: "freecad-python",
            code: params.script,
            args: params.args,
          });
          return await executeVerifiedProcess({
            bridge: bridge.verification,
            toolCallId,
            toolName: "cad_freecad_run",
            targetNamespace: "cad:freecad-run",
            evidenceIdentity,
            causePrefix: "cad-freecad-run",
            executionLabel: "cad_freecad_run",
            signal,
            execute: async () => {
              const result = await freeCad.runScript(scriptsDir, name, {
                script: params.script,
                args: params.args,
                timeoutMs: params.timeout_ms ?? 180_000,
                signal,
              });
              const toolResult = result.exitCode === 0
                ? textResult(
                    `✅ FreeCAD 脚本完成（exit=${result.exitCode}）\nstdout:\n${result.stdout.slice(-2000)}\nstderr:\n${result.stderr.slice(-1000)}`,
                    result,
                  )
                : {
                    content: [{ type: "text" as const, text: `[cad_freecad_run] script_exit_nonzero: FreeCAD 脚本退出码 ${result.exitCode}\nstdout:\n${result.stdout.slice(-2000)}\nstderr:\n${result.stderr.slice(-1000)}` }],
                    isError: true as const,
                    details: { error: "script_exit_nonzero", ...result },
                  };
              return { result: toolResult, exitCode: result.exitCode };
            },
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    // ---------- 逃生通道 ----------

  };
}


