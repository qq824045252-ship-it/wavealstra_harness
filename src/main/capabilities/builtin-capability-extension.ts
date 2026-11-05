import { registerLocalWorkflowTools, type LocalWorkflowBridge } from "./local-workflow-extension";
import { VideoJobPendingError } from "./VideoGenerationJobs";
import { consultToolResult } from "./MultiModelConsult";
import { consultSummary, type MultiModelConsultInput, type MultiModelConsultReport } from "../../shared/multi-model-consult";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createBashTool,
  createPowerShellTool,
  type BashSpawnContext,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ArtifactService } from "../artifact/ArtifactService";
import { isPathInsideOrEqual } from "../task/TaskExecutionWorkspace";
import type { IsolationLevel } from "../security/TaskExecutionIsolation";
import { applyShellIsolationSpawnContext, normalizeIsolationLevel } from "../security/TaskExecutionIsolation";
import type {
  BuiltinCapabilityRuntime,
  ImageGenerateInput,
  TextToSpeechInput,
  ToolExecutionContext,
  VisionCapabilityProvider,
  VideoGenerateInput,
} from "./BuiltinCapabilityRuntime";
import type { BrowserAutomationService, BrowserExecInput } from "./BrowserAutomationService";
import { uiAutomationService, type UiExecInput } from "./UiAutomationService";
import { computerAutomationService, type ComputerBatchAction, type ComputerExecInput, type ComputerExecOutput } from "./ComputerAutomationService";
import { formatComputerUseFailureEvidence, withComputerUseDeliveryEvidence } from "./ComputerUsePolicy";
import { computerUseToolCopy } from "../platform/computer-use/support";
import { currentPlatformId } from "../platform";
import { computerUseRunCoordinator } from "./ComputerUseRunCoordinator";
import { getAgentBashShellPath } from "../agent-shell-settings";
import { getMyBuddyDir } from "../paths";
import { runtimeProbeService, type RuntimeProbeInput } from "./RuntimeProbeService";
import { MediaArtifactMaterializer, MediaMaterializationPartialStateError } from "./MediaArtifactMaterializer";
import { routeVisionForPaths, type VisionRouteResult } from "./VisionRouting";
import { createWebAccessCapabilityExtension } from "./web-access/index";
import { quoteBashArg, quotePowerShellLiteral, toBashPath } from "../agent/ShellArguments";
import { executeCodeLanguages } from "../platform/shell-tools";
import type { VerifiedProcessBridge } from "../agent/VerifiedCodeExecution";
import { codeExecutionEvidenceIdentity, executeVerifiedCode, recordCodeRuntimePreparationFailure, resolveCodeRuntimePreparationFailure } from "../agent/VerifiedCodeExecution";
import { recordComputerUseFailureRecovery, settleComputerUseResultRecovery, type ComputerUseRecoveryBridge } from "../agent/ComputerUseFailureRecovery";
import { recordUiAutomationFailureRecovery, settleUiAutomationRecovery, type UiAutomationRecoveryBridge } from "../agent/UiAutomationFailureRecovery";
import { recordBrowserAutomationFailureRecovery, settleBrowserAutomationRecovery, type BrowserAutomationRecoveryBridge } from "../agent/BrowserAutomationFailureRecovery";
import { recordSkillAuthoringFailureRecovery, settleSkillAuthoringRecovery, type SkillAuthoringRecoveryBridge } from "../agent/SkillAuthoringFailureRecovery";
import type { PythonRuntimeService } from "../runtime/PythonRuntimeService";
import { executePython } from "../runtime/PythonExecutor";
import type { PythonEnvironmentSpec } from "../../shared/python-runtime";
import type { SkillScriptOwner } from "../skills/SkillsService";

export interface BuiltinCapabilityExtensionBridge {
  localWorkflow?: LocalWorkflowBridge;
  /** Durable owns execution; keep product capabilities without session gates/recovery or execute_code. */
  nativeExecution?: boolean;
  consult?: (id: string, input: MultiModelConsultInput, signal: AbortSignal | undefined, onUpdate: (report: MultiModelConsultReport) => void) => Promise<MultiModelConsultReport>;
  taskId: string;
  taskRoot: string;
  runtime: BuiltinCapabilityRuntime;
  browser: BrowserAutomationService;
  artifactService: () => ArtifactService | null;
  markArtifactEmitted?: (path: string) => void;
  getProducerMessageId: () => string | undefined;
  getIsolationLevel: () => IsolationLevel | unknown;
  getExecutionRunId?: () => string | undefined;
  /** Evidence for the optional execute_code capability; Pi core tools do not use this bridge. */
  shellVerification?: VerifiedProcessBridge;
  /** Task-scoped Computer Use recovery evidence; execution policy remains in ComputerAutomationService. */
  computerRecovery?: ComputerUseRecoveryBridge;
  /** Task-scoped MyBuddy UI automation recovery evidence. */
  uiRecovery?: UiAutomationRecoveryBridge;
  /** Task-scoped MyBuddy browser automation recovery evidence. */
  browserRecovery?: BrowserAutomationRecoveryBridge;
  /** Task-scoped Meta Skill creation recovery evidence. */
  skillAuthoringRecovery?: SkillAuthoringRecoveryBridge;
  /**
   * 受管 Python 运行时。execute_code 的 Python 分支只经它取解释器路径，
   * 不做 PATH 查找、不静默回退系统 Python。
   */
  pythonRuntime?: PythonRuntimeService;
  /**
   * 脚本路径 → 所属技能。execute_code 的 script 模式用它做两件事：
   * 确认路径落在某个技能目录内（而不是任务区外的任意文件），
   * 以及取出该技能的依赖声明来决定用哪套受管环境。null 表示不属于任何已知技能。
   */
  resolveSkillScript?: (scriptPath: string) => SkillScriptOwner | null;
  skillAuthoring?: {
    assess: (intent: string, modelId?: string) => Promise<unknown>;
    create: (intent: string, forceCreate?: boolean, modelId?: string) => Promise<unknown>;
  };
}
function errorResult(tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const computerEvidence = tool === "computer_exec" ? formatComputerUseFailureEvidence(error) : "";
  const additional = error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
  const details = error instanceof VideoJobPendingError
    ? { error: message, ...additional, videoJob: { jobId: error.jobId, remoteId: error.remoteId, reason: error.reason, remoteCancelled: false } }
    : (error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object")
    ? { error: message, details: error.details as Record<string, unknown> }
    : { error: message };
  return {
    content: [{ type: "text" as const, text: `[${tool}] ${message}${computerEvidence ? `\n\n执行证据（先回读状态，禁止重放已执行或结果未知的输入）：\n${computerEvidence}` : ""}` }],
    isError: true as const,
    details: details as Record<string, unknown>,
  };
}

function jsonResult(summary: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(details, null, 2)}` }],
    details,
  };
}

/** 本次 Python 执行真正用到的受管环境；附在结果上便于回答「这是哪套环境跑的」 */
interface PythonExecutionContext {
  environmentId: string;
  pythonVersion: string;
  pythonPath: string;
}

function withPythonDetails<T>(result: T, python: PythonExecutionContext | null): T {
  if (!python) return result;
  const details = ((result as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
  return { ...(result as object), details: { ...details, python } } as T;
}

function imageMimeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

async function nativeImageContent(filePath: string) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength <= 0) throw new Error(`图片为空：${filePath}`);
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error(`图片过大，无法直接注入主模型：${filePath}`);
  return { type: "image" as const, data: bytes.toString("base64"), mimeType: imageMimeForPath(filePath) };
}

async function visionAwareImageResult(options: {
  summary: string;
  details: Record<string, unknown>;
  images: Array<{ path: string; bytes: Uint8Array; mimeType: string }>;
  model: unknown;
  vision: VisionCapabilityProvider | null;
  context: ToolExecutionContext;
  prompt: string;
}) {
  const route = await routeVisionForPaths({
    model: options.model,
    provider: options.vision,
    imagePaths: options.images.map((item) => item.path),
    prompt: options.prompt,
    context: options.context,
  });
  const details = { ...options.details, vision: route };
  if (route.route !== "native-multimodal") return jsonResult(options.summary, details);
  return {
    content: [
      { type: "text" as const, text: `${options.summary}\n\n${JSON.stringify(details, null, 2)}\n\n截图已直接作为多模态 Tool Result 附在下方，请直接观察图片。` },
      ...options.images.map((item) => ({
        type: "image" as const,
        data: Buffer.from(item.bytes).toString("base64"),
        mimeType: item.mimeType,
      })),
    ],
    details,
  };
}

function delegatedVisionDetails(route: VisionRouteResult): Record<string, unknown> {
  return {
    route: route.route,
    model: route.model,
    provider: route.provider,
    descriptions: route.descriptions,
    error: route.error,
  };
}

function assertTaskPath(taskRoot: string, raw: string): string {
  const target = resolve(taskRoot, raw);
  if (!isPathInsideOrEqual(taskRoot, target)) throw new Error(`文件必须位于当前任务目录：${raw}`);
  return target;
}

function capabilityPath(bridge: BuiltinCapabilityExtensionBridge, raw: string): string {
  return bridge.nativeExecution ? resolve(bridge.taskRoot, raw) : assertTaskPath(bridge.taskRoot, raw);
}

function toolContext(
  bridge: BuiltinCapabilityExtensionBridge,
  toolCallId: string,
  signal?: AbortSignal,
): ToolExecutionContext {
  return {
    taskId: bridge.taskId,
    taskRoot: bridge.taskRoot,
    toolCallId,
    producerMessageId: bridge.getProducerMessageId(),
    signal,
  };
}

const describeImageSchema = Type.Object({
  image_path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { minItems: 1, maxItems: 8 })),
  prompt: Type.Optional(Type.String({ maxLength: 4_000 })),
}, { additionalProperties: false });

const imageGenerateSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 10_000 }),
  negative_prompt: Type.Optional(Type.String({ maxLength: 5_000 })),
  aspect_ratio: Type.Optional(Type.String({ maxLength: 40 })),
  width: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192 })),
  height: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  model: Type.Optional(Type.String({ maxLength: 300 })),
  seed: Type.Optional(Type.Integer({ minimum: 0 })),
  input_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 8 })),
}, { additionalProperties: false });

const videoGenerateSchema = Type.Object({
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
  job_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "已有视频任务的本地编号；恢复查询与下载，不重新提交生成。" })),
  negative_prompt: Type.Optional(Type.String({ maxLength: 5_000 })),
  aspect_ratio: Type.Optional(Type.String({ maxLength: 40 })),
  duration_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
  resolution: Type.Optional(Type.String({ maxLength: 40 })),
  model: Type.Optional(Type.String({ maxLength: 300 })),
  seed: Type.Optional(Type.Integer({ minimum: 0 })),
  input_image_path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  generate_audio: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const speechToTextSchema = Type.Object({
  audio_path: Type.String({ minLength: 1, maxLength: 4_000 }),
  language: Type.Optional(Type.String({ maxLength: 40 })),
  prompt: Type.Optional(Type.String({ maxLength: 2_000 })),
}, { additionalProperties: false });

const textToSpeechSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 50_000 }),
  voice: Type.Optional(Type.String({ maxLength: 200 })),
  rate: Type.Optional(Type.String({ maxLength: 40 })),
  format: Type.Optional(Type.Union([Type.Literal("mp3"), Type.Literal("wav"), Type.Literal("ogg")])),
}, { additionalProperties: false });

const browserExecSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"), Type.Literal("navigate"), Type.Literal("read"),
    Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("screenshot"),
  ]),
  url: Type.Optional(Type.String({ maxLength: 2_000 })),
  selector: Type.Optional(Type.String({ maxLength: 1_000 })),
  text: Type.Optional(Type.String({ maxLength: 100_000 })),
  key: Type.Optional(Type.String({ maxLength: 60 })),
  max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
}, { additionalProperties: false });

const uiExecSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"), Type.Literal("snapshot"), Type.Literal("find"), Type.Literal("inspect"),
    Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("scroll"),
    Type.Literal("screenshot"), Type.Literal("wait_for"),
  ]),
  target: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("browser"), Type.Literal("artifact")])),
  selector: Type.Optional(Type.String({ maxLength: 2_000 })),
  text: Type.Optional(Type.String({ maxLength: 4_000 })),
  role: Type.Optional(Type.String({ maxLength: 200 })),
  name: Type.Optional(Type.String({ maxLength: 1_000 })),
  value: Type.Optional(Type.String({ maxLength: 100_000 })),
  key: Type.Optional(Type.String({ maxLength: 80 })),
  delta_x: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  delta_y: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000 })),
  state: Type.Optional(Type.Union([
    Type.Literal("attached"), Type.Literal("detached"), Type.Literal("visible"), Type.Literal("hidden"),
  ])),
}, { additionalProperties: false });

const computerOutcomeExpectationSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("target_present"), Type.Literal("target_closed"), Type.Literal("target_foreground"),
    Type.Literal("new_window"), Type.Literal("control_present"), Type.Literal("control_absent"),
  ]),
  window_title_contains: Type.Optional(Type.String({ maxLength: 500 })),
  control_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  automation_id: Type.Optional(Type.String({ maxLength: 1_000 })),
  control_type: Type.Optional(Type.String({ maxLength: 200 })),
  control_runtime_id: Type.Optional(Type.String({ maxLength: 4_096 })),
  control_class_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  exact_name: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const computerBatchStepSchema = Type.Object({
  action: Type.Union([
    Type.Literal("move_client"), Type.Literal("click_client"), Type.Literal("drag_client"),
    Type.Literal("scroll_client"), Type.Literal("mouse_down_client"), Type.Literal("mouse_up_client"),
    Type.Literal("key_down"), Type.Literal("key_up"), Type.Literal("key_press"), Type.Literal("type_text"), Type.Literal("paste_text"),
  ]),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  x2: Type.Optional(Type.Number()),
  y2: Type.Optional(Type.Number()),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  delta_x: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  delta_y: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  key: Type.Optional(Type.String({ maxLength: 120 })),
  text: Type.Optional(Type.String({ maxLength: 200_000 })),
  click_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  hold_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000 })),
  steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  notches: Type.Optional(Type.Integer({ minimum: -50, maximum: 50 })),
  modifiers: Type.Optional(Type.Array(Type.Union([Type.Literal("ctrl"), Type.Literal("shift"), Type.Literal("alt"), Type.Literal("win")]), { maxItems: 4 })),
  background: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const computerExecSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("attach_app"),
    Type.Literal("status"),
    Type.Literal("active_window"), Type.Literal("list_windows"), Type.Literal("inspect_window"),
    Type.Literal("focus_window"), Type.Literal("wait_for_window"),
    Type.Literal("screenshot"), Type.Literal("screenshot_window"), Type.Literal("ocr_window"),
    Type.Literal("inspect_controls"), Type.Literal("find_control"), Type.Literal("invoke_control"), Type.Literal("set_control_value"),
    Type.Literal("move_client"), Type.Literal("click_client"), Type.Literal("drag_client"), Type.Literal("scroll_client"),
    Type.Literal("mouse_down_client"), Type.Literal("mouse_up_client"), Type.Literal("key_down"), Type.Literal("key_up"),
    Type.Literal("paste_text"), Type.Literal("drag_screen"),
    Type.Literal("move_window"), Type.Literal("resize_window"),
    Type.Literal("mouse_move"), Type.Literal("mouse_click"), Type.Literal("mouse_drag"), Type.Literal("scroll"),
    Type.Literal("key_press"), Type.Literal("type_text"),
  ])),
  actions: Type.Optional(Type.Array(computerBatchStepSchema, {
    minItems: 1,
    maxItems: 8,
    description: "批量窗口输入：1–8 个步骤按顺序执行、出错即停，只做一次最终观察。与 action 二选一，步骤共用顶层窗口目标。",
  })),
  settle_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_000, description: "批量步骤之间的等待毫秒数，默认 120。" })),
  app_session_id: Type.Optional(Type.String({ maxLength: 100, description: "attach_app 返回的应用会话 id；后续动作用它代替 window_handle/title。" })),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  x2: Type.Optional(Type.Number()),
  y2: Type.Optional(Type.Number()),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  delta_x: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  delta_y: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  key: Type.Optional(Type.String({ maxLength: 120 })),
  text: Type.Optional(Type.String({ maxLength: 200_000 })),
  click_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "1–3 次点击（双击/三击）。" })),
  modifiers: Type.Optional(Type.Array(Type.Union([Type.Literal("ctrl"), Type.Literal("shift"), Type.Literal("alt"), Type.Literal("win")]), { maxItems: 4, description: "点击时按住的修饰键。" })),
  hold_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000, description: "按下保持毫秒数（长按）。" })),
  steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "拖拽插值步数。" })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "拖拽时长毫秒；0 表示尽快。" })),
  notches: Type.Optional(Type.Integer({ minimum: -50, maximum: 50, description: "滚轮格数，正数向上、负数向下。" })),
  background: Type.Optional(Type.Boolean({ description: "不抢焦点（仅 Windows：screenshot_window 用 PrintWindow/WGC，click_client 用 PostMessage）。Linux/Wayland 没有后台截图，传 true 会被明确拒绝。" })),
  window_title: Type.Optional(Type.String({ maxLength: 1_000 })),
  window_handle: Type.Optional(Type.String({ maxLength: 100 })),
  window_x: Type.Optional(Type.Number({ minimum: -32_000, maximum: 32_000, description: "move_window 的目标左上角 X（逻辑/布局像素，与 hyprctl clients 的 at 同域）。" })),
  window_y: Type.Optional(Type.Number({ minimum: -32_000, maximum: 32_000, description: "move_window 的目标左上角 Y（逻辑/布局像素）。" })),
  window_width: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_000, description: "resize_window 的目标宽度（逻辑/布局像素）。" })),
  window_height: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_000, description: "resize_window 的目标高度（逻辑/布局像素）。" })),
  process_id: Type.Optional(Type.Integer({ minimum: 1 })),
  process_name: Type.Optional(Type.String({ maxLength: 200 })),
  class_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  screen_id: Type.Optional(Type.String({ maxLength: 100 })),
  control_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  automation_id: Type.Optional(Type.String({ maxLength: 1_000 })),
  control_type: Type.Optional(Type.String({ maxLength: 200 })),
  control_runtime_id: Type.Optional(Type.String({ maxLength: 4_096 })),
  control_class_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  exact_name: Type.Optional(Type.Boolean()),
  client_only: Type.Optional(Type.Boolean({ default: true, description: "默认 true：Windows 返回客户区 DIP 图像；false 返回含边框图像。Linux 截图是独立观察，禁止用截图像素生成输入坐标。" })),
  ensure_foreground: Type.Optional(Type.Boolean()),
  observation_id: Type.Optional(Type.String({ maxLength: 100 })),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "UIA/AT-SPI 控件树深度，默认 10；truncated=true 表示查询预算内未遍历完，不能推断控件不存在。" })),
  max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  max_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "ocr_window 最多返回的文本行数，默认 80。" })),
  min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "ocr_window 最低置信度，默认 0.5。" })),
  restore_foreground: Type.Optional(Type.Boolean({ description: "动作结束后把原来的前台窗口切回去（不把自动化目标留在前台）。" })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000 })),
  wait_state: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("foreground"), Type.Literal("closed")])),
  expected_outcomes: Type.Optional(Type.Array(computerOutcomeExpectationSchema, { maxItems: 4, description: "Semantic postconditions for verifying that the intended window/control state was actually reached, not merely captured." })),
  observe_after: Type.Optional(Type.Boolean()),
  capture_after: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const runtimeProbeSchema = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("mark"), Type.Literal("read")]),
  target: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("browser"), Type.Literal("artifact")])),
  after_sequence: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  levels: Type.Optional(Type.Array(Type.Union([
    Type.Literal("debug"), Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"),
  ]), { maxItems: 4 })),
  kinds: Type.Optional(Type.Array(Type.Union([
    Type.Literal("console"), Type.Literal("runtime-error"), Type.Literal("load"),
    Type.Literal("navigation"), Type.Literal("process"), Type.Literal("lifecycle"),
  ]), { maxItems: 6 })),
}, { additionalProperties: false });

const skillAuthoringAssessSchema = Type.Object({
  intent: Type.String({ minLength: 1, maxLength: 8_000 }),
  model_id: Type.Optional(Type.String({ maxLength: 300 })),
}, { additionalProperties: false });

const skillAuthoringCreateSchema = Type.Object({
  intent: Type.String({ minLength: 1, maxLength: 8_000 }),
  force_create: Type.Optional(Type.Boolean()),
  model_id: Type.Optional(Type.String({ maxLength: 300 })),
}, { additionalProperties: false });

/**
 * execute_code 的 schema：language 由平台门控（PowerShell 仅 Windows；见 platform/shell-tools）。
 * 其它字段与文案与迁移前一致。
 */
function executeCodeSchemaFor(languages: readonly string[]) {
  return Type.Object({
    language: Type.Union(languages.map((language) => Type.Literal(language))),
    /** 内联代码；与 script 二选一 */
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 500_000 })),
    /** 已存在的脚本路径（仅 Python）：技能自带脚本走这里，环境按该技能的依赖声明准备 */
    script: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    /** 传给脚本的命令行参数 */
    args: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 64 })),
    /** 追加到受管 Python 环境的包名（如 `camelot-py[cv]>=0.16`）；并入规格后得到新环境 id，绝不在已用过的环境里装包 */
    python_dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 })),
    timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }, { additionalProperties: false });
}

export function createBuiltinCapabilityExtension(bridge: BuiltinCapabilityExtensionBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const config = bridge.runtime.config();
    // 平台门控：execute_code 的 language / schema / PowerShell 工具只在支持的平台上提供。
    const codeLanguages = executeCodeLanguages();
    const supportsPowerShell = codeLanguages.includes("powershell");
    const executeCodeSchema = executeCodeSchemaFor(codeLanguages);
    const materializer = new MediaArtifactMaterializer(bridge.artifactService, bridge.markArtifactEmitted);
    const vision = config.vision.enabled ? bridge.runtime.visionProvider() : null;
    const imageCandidate = config.imageGeneration.enabled ? bridge.runtime.imageProvider() : null;
    const image = imageCandidate && (imageCandidate.isAvailable?.() ?? true) ? imageCandidate : null;
    const video = config.videoGeneration.enabled ? bridge.runtime.videoProvider() : null;
    const stt = config.speechToText.enabled ? bridge.runtime.speechToTextProvider() : null;
    const tts = config.textToSpeech.enabled ? bridge.runtime.textToSpeechProvider() : null;

    // Images are normalized once when Pi accepts a tool result. Keep that
    // history stable through tool continuations; Pi compaction owns retirement.
    // A sliding screenshot window rewrites earlier provider input and destroys
    // prompt-prefix reuse even when the canonical session file is unchanged.

    if (bridge.localWorkflow) registerLocalWorkflowTools(pi, {
      taskId: bridge.taskId, taskRoot: bridge.taskRoot, services: bridge.localWorkflow,
      terminalEnabled: config.execution.terminalEnabled,
    });
    if (config.web.enabled) createWebAccessCapabilityExtension(pi);

    if (config.multiModelConsult.enabled && bridge.consult) {
      pi.registerTool({
        name: "multi_model_consult", label: "多模型会诊",
        description: "显式请求设置中的不同模型独立分析同一个任务，返回各模型原始答案。适用于易错判断、设计、诊断、数据解释、方案比较和代码 Review；不是任务分工。没有自动触发、Judge、递归或写权限。传入完整任务与必要事实，不传自己的结论；收到结果后由你综合共识、分歧、独有发现和证据，不能用票数代替验证。用户明确要求本条使用多模型时调用一次；下一条不继承该要求。",
        promptSnippet: "multi_model_consult(task, context?) — independent answers from explicitly configured models",
        parameters: Type.Object({
          task: Type.String({ minLength: 1, maxLength: 100000 }),
          context: Type.Optional(Type.String({ maxLength: 100000 })),
        }, { additionalProperties: false }),
        execute: async (id, input, signal, onUpdate) => {
          try {
            const report = await bridge.consult!(id, input, signal, (consult) => onUpdate?.({
              content: [{ type: "text", text: consultSummary(consult) }], details: { consult },
            }));
            return consultToolResult(report);
          } catch (error) { return errorResult("multi_model_consult", error); }
        },
      });
    }

    if (bridge.skillAuthoring) {
      pi.registerTool({
        name: "skill_authoring_assess",
        label: "元 Skill · 评估",
        description: "MyBuddy Meta Skill 的一等只读入口。用户提到“元 Skill/Meta Skill”、想创建/复用/改进 Skill，或询问某个流程是否值得固化成 Skill 时优先调用。返回 create/reuse/improve-existing/no-skill；不写文件。",
        promptSnippet: "skill_authoring_assess(intent, model_id?)",
        parameters: skillAuthoringAssessSchema,
        execute: async (_id, p: { intent: string; model_id?: string }) => {
          try {
            return jsonResult("Meta Skill 评估完成", await bridge.skillAuthoring!.assess(p.intent, p.model_id));
          } catch (error) { return errorResult("skill_authoring_assess", error); }
        },
      });
      pi.registerTool({
        name: "skill_authoring_create",
        label: "元 Skill · 创建",
        description: "通过 MyBuddy Meta Skill 创建 Skill。内部会再次执行 No-Skill/Skill Atlas Gate；用户说“根据元 Skill 创建……”时使用此工具，而不是手写 SKILL.md。force_create 只用于用户明确要求忽略 Gatekeeper 仍然新建，Agent 不得自行开启。新 Skill 安装后默认停用。",
        promptSnippet: "skill_authoring_create(intent, force_create?, model_id?)",
        parameters: skillAuthoringCreateSchema,
        execute: async (_id, p: { intent: string; force_create?: boolean; model_id?: string }) => {
          try {
            const result = await bridge.skillAuthoring!.create(p.intent, p.force_create, p.model_id);
            settleSkillAuthoringRecovery(bridge.skillAuthoringRecovery, p.intent, result);
            return jsonResult("Meta Skill 创建流程完成", result);
          } catch (error) {
            recordSkillAuthoringFailureRecovery(bridge.skillAuthoringRecovery, p.intent, error);
            return errorResult("skill_authoring_create", error);
          }
        },
      });
    }

    if (vision) {
      pi.registerTool({
        name: "describe_image",
        label: "图像理解",
        description: "分析当前任务目录内的一张或多张图片。当前主模型支持图片时直接把图片作为多模态 Tool Result 返回；纯文本主模型才调用内部委托 Vision。",
        promptSnippet: "describe_image(image_path | image_paths, prompt?)",
        parameters: describeImageSchema,
        execute: async (tc, p: { image_path?: string; image_paths?: string[]; prompt?: string }, signal, _onUpdate, ctx) => {
          try {
            const raw = [...(p.image_paths ?? []), ...(p.image_path ? [p.image_path] : [])];
            if (!raw.length) throw new Error("需要 image_path 或 image_paths");
            const paths = [...new Set(raw.map((item) => capabilityPath(bridge, item)))];
            const context = toolContext(bridge, tc, signal);
            const route = await routeVisionForPaths({
              model: ctx?.model,
              provider: vision,
              imagePaths: paths,
              prompt: p.prompt,
              context,
            });
            if (route.route === "native-multimodal") {
              const images = await Promise.all(paths.map(nativeImageContent));
              const details = { vision: delegatedVisionDetails(route), imagePaths: paths };
              return {
                content: [
                  { type: "text" as const, text: `当前主模型支持图片输入；${paths.length} 张图片已直接作为多模态 Tool Result 附在下方。\n\n${JSON.stringify(details, null, 2)}` },
                  ...images,
                ],
                details,
              };
            }
            if (route.route === "delegated-vision") {
              return jsonResult(`已通过委托 Vision 分析 ${route.descriptions?.length ?? 0} 张图片（${route.provider ?? "unknown"}）`, { vision: delegatedVisionDetails(route) });
            }
            return errorResult("describe_image", route.error ?? "当前没有可用的图片理解路径");
          } catch (error) { return errorResult("describe_image", error); }
        },
      });
    }

    if (image) {
      pi.registerTool({
        name: "image_generate",
        label: "图像生成",
        description: "按文本生成或编辑图片；输出始终下载到当前任务目录并登记 Image Artifact。回复时用 ![图片说明](<返回的绝对路径>) 将图片嵌在相关说明文字旁，不要只给下载链接。",
        promptSnippet: "image_generate(prompt, aspect_ratio?, width?, height?, count?, input_image_paths?)",
        parameters: imageGenerateSchema,
        execute: async (tc, p: Record<string, unknown>, signal?: AbortSignal) => {
          try {
            const input: ImageGenerateInput = {
              prompt: String(p.prompt),
              negativePrompt: p.negative_prompt as string | undefined,
              aspectRatio: p.aspect_ratio as string | undefined,
              width: p.width as number | undefined,
              height: p.height as number | undefined,
              count: p.count as number | undefined,
              model: (p.model as string | undefined) ?? bridge.runtime.mediaModel("image-generation"),
              seed: p.seed as number | undefined,
              inputImagePaths: Array.isArray(p.input_image_paths)
                ? (p.input_image_paths as string[]).map((item) => capabilityPath(bridge, item))
                : undefined,
            };
            const context = toolContext(bridge, tc, signal);
            if (!bridge.runtime.config().imageGeneration.enabled) throw new Error("图片生成已关闭。");
            const provider = bridge.runtime.imageProvider();
            if (!provider?.generateImage) throw new Error("请先配置图片生成服务。");
            const generated = await provider.generateImage(input, context);
            const saved = await materializer.materialize("image", generated, context, "生成图片");
            return jsonResult(`已生成并保存 ${saved.paths.length} 张图片`, { ...generated, items: saved.paths, artifactIds: saved.artifacts.map((a) => a.id) });
          } catch (error) { return errorResult("image_generate", error); }
        },
      });
    }

    if (video || (config.videoGeneration.enabled && bridge.runtime.hasVideoJobs(bridge.taskId))) {
      pi.registerTool({
        name: "video_generate",
        label: "视频生成",
        description: "从文本或任务内图片生成视频；输出下载到当前任务目录并登记 Video Artifact。返回等待中或断线错误时保留 job_id，以该编号恢复查询，不能重发原始生成请求。停止等待不代表取消远端生成。",
        promptSnippet: "video_generate(prompt?, job_id?, duration_seconds?, aspect_ratio?, resolution?, input_image_path?)",
        parameters: videoGenerateSchema,
        execute: async (tc, p: Record<string, unknown>, signal?: AbortSignal) => {
          try {
            if (p.job_id && Object.entries(p).some(([key, value]) => key !== "job_id" && value !== undefined)) throw new Error("恢复视频时只传 job_id；原服务和生成参数已保存在任务中。");
            const input: VideoGenerateInput = {
              prompt: typeof p.prompt === "string" ? p.prompt : undefined,
              jobId: p.job_id as string | undefined,
              negativePrompt: p.negative_prompt as string | undefined,
              aspectRatio: p.aspect_ratio as string | undefined,
              durationSeconds: p.duration_seconds as number | undefined,
              resolution: p.resolution as string | undefined,
              model: p.job_id ? undefined : (p.model as string | undefined) ?? bridge.runtime.mediaModel("video-generation"),
              seed: p.seed as number | undefined,
              inputImagePath: typeof p.input_image_path === "string" ? capabilityPath(bridge, p.input_image_path) : undefined,
              generateAudio: p.generate_audio as boolean | undefined,
            };
            const context = toolContext(bridge, tc, signal);
            if (!bridge.runtime.config().videoGeneration.enabled) throw new Error("视频生成已关闭。");
            const provider = input.jobId ? null : bridge.runtime.videoProvider();
            if (!input.jobId && !provider?.generateVideo) throw new Error("请先配置视频生成服务。");
            const generated = input.jobId ? await bridge.runtime.resumeVideo(input.jobId, context) : await provider!.generateVideo!(input, context);
            let saved;
            try { saved = await materializer.materialize("video", generated, context, "生成视频"); }
            catch (error) {
              if (typeof generated.metadata?.jobId === "string") {
                const pending = new VideoJobPendingError(generated.metadata.jobId, error instanceof MediaMaterializationPartialStateError ? "artifact-partial" : "artifact-save", generated.requestId);
                if (error instanceof MediaMaterializationPartialStateError) {
                  pending.message = `${error.message}。请先处理残留产物，避免重复保存。\n${pending.message}`;
                  Object.assign(pending, { details: { retainedPaths: error.retainedPaths, retainedArtifactIds: error.retainedArtifactIds } });
                }
                throw pending;
              }
              throw error;
            }
            return jsonResult(`已生成并保存 ${saved.paths.length} 个视频`, { ...generated, items: saved.paths, artifactIds: saved.artifacts.map((a) => a.id) });
          } catch (error) { return errorResult("video_generate", error); }
        },
      });
    }

    if (config.ocr?.enabled) {
      pi.registerTool({
        name: "ocr_file", label: "图片文字识别",
        description: "识别任务目录内 PNG/JPEG（≤10 MiB）。返回正文和可选输入像素框；无框不能用于点击。PDF/Office、窗口 OCR 未支持。",
        parameters: Type.Object({ image_path: Type.String() }),
        execute: async (tc, p: { image_path: string }, signal?: AbortSignal) => {
          try {
            bridge.runtime.assertRecognitionAgentPolicy("ocr");
            const adapter = bridge.runtime.ocrAdapter();
            if (!adapter) throw new Error("请先配置图片文字识别服务。");
            const result = await adapter.recognize(capabilityPath(bridge, p.image_path), toolContext(bridge, tc, signal));
            return jsonResult(result.boxes?.length ? "图片文字识别完成（含输入像素位置框）" : "图片文字提取完成（服务未提供位置框）", result);
          } catch (error) { return errorResult("ocr_file", error); }
        },
      });
    }

    if (stt) {
      pi.registerTool({
        name: "speech_to_text",
        label: "语音转文字",
        description: "转写当前任务目录内的音频文件。",
        promptSnippet: "speech_to_text(audio_path, language?, prompt?)",
        parameters: speechToTextSchema,
        execute: async (tc, p: { audio_path: string; language?: string; prompt?: string }, signal?: AbortSignal) => {
          try {
            if (!bridge.runtime.config().speechToText.enabled) throw new Error("disabled: speech-to-text");
            bridge.runtime.assertRecognitionAgentPolicy("speech-to-text");
            const provider = bridge.runtime.speechToTextProvider();
            if (!provider?.speechToText) throw new Error("请先配置转写服务。");
            const result = await provider.speechToText({ audioPath: capabilityPath(bridge, p.audio_path), model: bridge.runtime.mediaModel("speech-to-text"), language: p.language, prompt: p.prompt }, toolContext(bridge, tc, signal));
            return jsonResult(`转写完成（${result.provider}）`, result);
          } catch (error) { return errorResult("speech_to_text", error); }
        },
      });
    }

    if (tts) {
      pi.registerTool({
        name: "text_to_speech",
        label: "文字转语音",
        description: "把文本合成为语音；输出保存到当前任务目录并登记 Audio Artifact。",
        promptSnippet: "text_to_speech(text, voice?, rate?, format?)",
        parameters: textToSpeechSchema,
        execute: async (tc, p: TextToSpeechInput, signal?: AbortSignal) => {
          try {
            const context = toolContext(bridge, tc, signal);
            if (!bridge.runtime.config().textToSpeech.enabled) throw new Error("文字转语音已关闭。");
            const provider = bridge.runtime.textToSpeechProvider();
            if (!provider?.textToSpeech) throw new Error("请先配置文字转语音服务。");
            const current = bridge.runtime.config().textToSpeech;
            const generated = await provider.textToSpeech({
              ...p,
              model: bridge.runtime.mediaModel("text-to-speech"),
              voice: p.voice ?? current.voice,
              rate: p.rate ?? current.rate,
            }, context);
            const saved = await materializer.materialize("audio", generated, context, "合成语音");
            return jsonResult(`已生成并保存 ${saved.paths.length} 个音频`, { ...generated, items: saved.paths, artifactIds: saved.artifacts.map((a) => a.id) });
          } catch (error) { return errorResult("text_to_speech", error); }
        },
      });
    }

    if (config.browser.enabled && bridge.browser.available) {
      pi.registerTool({
        name: "browser_exec",
        label: "浏览器操作",
        description: "操作 MyBuddy 自有浏览器。仅支持 status/navigate/read/click/fill/press/screenshot 枚举动作，不执行任意 JavaScript。screenshot 会按当前主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。需要桌面窗口级操作（跨应用、结构化控件、窗口输入）时用 computer_exec，不要用本工具。",
        promptSnippet: "browser_exec(action, url?, selector?, text?, key?)",
        parameters: browserExecSchema,
        execute: async (tc, p: BrowserExecInput & { max_chars?: number }, signal, _onUpdate, ctx) => {
          let input: BrowserExecInput | undefined;
          try {
            const context = toolContext(bridge, tc, signal);
            input = { ...p, maxChars: p.max_chars };
            const result = await bridge.browser.execute(input, signal);
            settleBrowserAutomationRecovery(bridge.browserRecovery, input, result);
            if (result.screenshot) {
              const saved = await materializer.materialize("image", {
                provider: "mybuddy-browser",
                items: [{ bytes: result.screenshot, mimeType: "image/png", fileName: "browser-screenshot.png" }],
              }, context, "浏览器截图");
              const details = { ...result, screenshot: undefined, path: saved.paths[0], artifactId: saved.artifacts[0]?.id };
              return visionAwareImageResult({
                summary: "浏览器截图已保存", details, model: ctx?.model, vision, context,
                images: [{ path: saved.paths[0], bytes: result.screenshot, mimeType: "image/png" }],
                prompt: "请分析这张浏览器截图，准确描述页面主要内容、可见控件、文本、状态、错误提示和与当前任务相关的可交互目标。不要猜测不可见内容。",
              });
            }
            return jsonResult(`浏览器动作完成：${p.action}`, result);
          } catch (error) {
            if (input) recordBrowserAutomationFailureRecovery(bridge.browserRecovery, input, error);
            return errorResult("browser_exec", error);
          }
        },
      });
    }

    if (config.browser.enabled && uiAutomationService.anyAvailable()) {
      pi.registerTool({
        name: "ui_exec",
        label: "界面操作",
        description: "观察并操作 MyBuddy 主界面、内嵌浏览器或 Artifact 页面。点击/键盘走 Electron 输入事件，适合真实复现 UI Bug；不执行任意 JavaScript。screenshot 已自动视觉路由，不需要再手动调用 describe_image。只覆盖 MyBuddy 自身的渲染界面；跨应用、桌面窗口和结构化控件操作请用 computer_exec。",
        promptSnippet: "ui_exec(action, target?, selector?/text?/role?/name?, value?, key?, state?)",
        parameters: uiExecSchema,
        execute: async (tc, p: Record<string, unknown>, signal, _onUpdate, ctx) => {
          let input: UiExecInput | undefined;
          try {
            input = {
              action: p.action as UiExecInput["action"],
              target: p.target as UiExecInput["target"],
              selector: p.selector as string | undefined,
              text: p.text as string | undefined,
              role: p.role as string | undefined,
              name: p.name as string | undefined,
              value: p.value as string | undefined,
              key: p.key as string | undefined,
              deltaX: p.delta_x as number | undefined,
              deltaY: p.delta_y as number | undefined,
              maxChars: p.max_chars as number | undefined,
              timeoutMs: p.timeout_ms as number | undefined,
              state: p.state as UiExecInput["state"],
            };
            const result = await uiAutomationService.execute(input, signal);
            settleUiAutomationRecovery(bridge.uiRecovery, input, result);
            if (result.screenshot) {
              const context = toolContext(bridge, tc, signal);
              const saved = await materializer.materialize("image", {
                provider: "mybuddy-ui",
                items: [{ bytes: result.screenshot, mimeType: "image/png", fileName: `ui-${result.target}-screenshot.png` }],
              }, context, "界面截图");
              const details = { ...result, screenshot: undefined, path: saved.paths[0], artifactId: saved.artifacts[0]?.id };
              return visionAwareImageResult({
                summary: "界面截图已保存", details, model: ctx?.model, vision, context,
                images: [{ path: saved.paths[0], bytes: result.screenshot, mimeType: "image/png" }],
                prompt: "请分析这张 MyBuddy 界面截图，准确描述当前窗口、主要控件、文本、状态、错误提示和与当前任务相关的可交互目标。不要猜测不可见内容。",
              });
            }
            return jsonResult(`界面动作完成：${input.action}`, result);
          } catch (error) {
            if (input) recordUiAutomationFailureRecovery(bridge.uiRecovery, input, error);
            return errorResult("ui_exec", error);
          }
        },
      });
    }

    if (config.browser.enabled && computerAutomationService.available) {
      const computerUseCopy = computerUseToolCopy(currentPlatformId, { nativeExecution: bridge.nativeExecution });
      pi.registerTool({
        name: "computer_exec",
        label: computerUseCopy.label,
        description: computerUseCopy.description,
        promptSnippet: "computer_exec(action?|actions?, window_handle?/window_title?/process_id?, control_name?/automation_id?, x?/y?, observation_id?, capture_after?, expected_outcomes?)",
        parameters: computerExecSchema,
        execute: async (tc, p: Record<string, unknown>, signal, _onUpdate, ctx) => {
          let input: ComputerExecInput | undefined;
          let operationSignal: AbortSignal | undefined;
          let finishToolScope: (() => void) | undefined;
          let actionResult: ComputerExecOutput | undefined;
          try {
            const batchActions = Array.isArray(p.actions)
              ? (p.actions as Array<Record<string, unknown>>).map((step) => ({
                action: step.action as ComputerBatchAction,
                x: step.x as number | undefined,
                y: step.y as number | undefined,
                x2: step.x2 as number | undefined,
                y2: step.y2 as number | undefined,
                button: step.button as ComputerExecInput["button"],
                deltaX: step.delta_x as number | undefined,
                deltaY: step.delta_y as number | undefined,
                key: step.key as string | undefined,
                text: step.text as string | undefined,
                clickCount: step.click_count as number | undefined,
                modifiers: step.modifiers as ComputerExecInput["modifiers"],
                holdMs: step.hold_ms as number | undefined,
                steps: step.steps as number | undefined,
                durationMs: step.duration_ms as number | undefined,
                notches: step.notches as number | undefined,
                background: step.background as boolean | undefined,
              }))
              : undefined;
            if (p.action != null && p.actions != null) throw new Error("computer_exec 的 action 与 actions 只能二选一；列出窗口请只传 action=list_windows");
            const action = p.action as ComputerExecInput["action"] | undefined;
            if (!action && !batchActions?.length) throw new Error("computer_exec 需要 action 或 actions");
            input = {
              action,
              actions: batchActions?.length ? batchActions : undefined,
              settleMs: p.settle_ms as number | undefined,
              taskId: bridge.taskId,
              x: p.x as number | undefined,
              y: p.y as number | undefined,
              x2: p.x2 as number | undefined,
              y2: p.y2 as number | undefined,
              button: p.button as ComputerExecInput["button"],
              deltaX: p.delta_x as number | undefined,
              deltaY: p.delta_y as number | undefined,
              key: p.key as string | undefined,
              text: p.text as string | undefined,
              appSessionId: p.app_session_id as string | undefined,
              clickCount: p.click_count as number | undefined,
              modifiers: p.modifiers as ComputerExecInput["modifiers"],
              holdMs: p.hold_ms as number | undefined,
              steps: p.steps as number | undefined,
              durationMs: p.duration_ms as number | undefined,
              notches: p.notches as number | undefined,
              background: p.background as boolean | undefined,
              windowTitle: p.window_title as string | undefined,
              windowHandle: p.window_handle as string | undefined,
              windowX: p.window_x as number | undefined,
              windowY: p.window_y as number | undefined,
              windowWidth: p.window_width as number | undefined,
              windowHeight: p.window_height as number | undefined,
              processId: p.process_id as number | undefined,
              processName: p.process_name as string | undefined,
              className: p.class_name as string | undefined,
              screenId: p.screen_id as string | undefined,
              controlName: p.control_name as string | undefined,
              automationId: p.automation_id as string | undefined,
              controlType: p.control_type as string | undefined,
              controlRuntimeId: p.control_runtime_id as string | undefined,
              controlClassName: p.control_class_name as string | undefined,
              exactName: p.exact_name as boolean | undefined,
              clientOnly: p.client_only as boolean | undefined,
              ensureForeground: p.ensure_foreground as boolean | undefined,
              observationId: p.observation_id as string | undefined,
              maxDepth: p.max_depth as number | undefined,
              maxNodes: p.max_nodes as number | undefined,
              maxLines: p.max_lines as number | undefined,
              minScore: p.min_score as number | undefined,
              restoreForeground: p.restore_foreground as boolean | undefined,
              timeoutMs: p.timeout_ms as number | undefined,
              waitState: p.wait_state as ComputerExecInput["waitState"],
              expectedOutcomes: p.expected_outcomes as ComputerExecInput["expectedOutcomes"],
              observeAfter: p.observe_after as boolean | undefined,
              captureAfter: p.capture_after as boolean | undefined,
            };
            if (bridge.nativeExecution) {
              const scoped = computerUseRunCoordinator.scopeTool(bridge.taskId, signal, bridge.getExecutionRunId?.());
              operationSignal = scoped.signal;
              finishToolScope = scoped.finish;
            } else operationSignal = computerUseRunCoordinator.scope(bridge.taskId, signal, bridge.computerRecovery?.resolveContext()?.executionId);
            operationSignal?.throwIfAborted();
            const result = await computerAutomationService.execute(input, operationSignal);
            actionResult = result;
            operationSignal?.throwIfAborted();
            settleComputerUseResultRecovery(bridge.computerRecovery, input, result);
            if (result.screenshot) {
              const context = toolContext(bridge, tc, operationSignal);
              const mimeType = result.screenshotMimeType ?? "image/png";
              const fileName = result.artifactFileName ?? (mimeType === "image/jpeg" ? "desktop-screenshot.jpg" : "desktop-screenshot.png");
              const saved = await materializer.materialize("image", {
                provider: "mybuddy-computer",
                items: [{ bytes: result.screenshot, mimeType, fileName }],
              }, context, "桌面截图");
              operationSignal?.throwIfAborted();
              const details = { ...result, screenshot: undefined, path: saved.paths[0], artifactId: saved.artifacts[0]?.id };
              const imageResult = await visionAwareImageResult({
                summary: computerUseCopy.screenshotSummary, details, model: ctx?.model, vision, context,
                images: [{ path: saved.paths[0], bytes: result.screenshot, mimeType }],
                prompt: computerUseCopy.visionPrompt,
              });
              operationSignal?.throwIfAborted();
              return imageResult;
            }
            return jsonResult(batchActions?.length
              ? `批量桌面动作结果：${result.batch?.steps.filter((step) => step.ok).length ?? 0}/${batchActions.length} 步完成`
              : `桌面动作结果：${String(action)}`, result);
          } catch (error) {
            const failure = withComputerUseDeliveryEvidence(error, actionResult, operationSignal);
            if (input) {
              computerUseRunCoordinator.fail(input, operationSignal);
              recordComputerUseFailureRecovery(bridge.computerRecovery, input, failure);
            }
            return errorResult("computer_exec", failure);
          } finally { finishToolScope?.(); }
        },
      });
    }

    if (config.diagnostics?.enabled ?? config.browser.enabled) {
      pi.registerTool({
        name: "runtime_probe",
        label: "运行时探针",
        description: "读取 MyBuddy/内嵌浏览器/Artifact 的有界运行时证据：console、未处理异常/Promise rejection、导航、加载失败、renderer 退出、焦点与文档状态。用于 UI 操作前后做 mark/read 对照；不修改产品状态。",
        promptSnippet: "runtime_probe(action, target?, after_sequence?, limit?, levels?, kinds?)",
        parameters: runtimeProbeSchema,
        execute: async (_tc, p: Record<string, unknown>) => {
          try {
            const input: RuntimeProbeInput = {
              action: p.action as RuntimeProbeInput["action"],
              target: p.target as RuntimeProbeInput["target"],
              afterSequence: p.after_sequence as number | undefined,
              limit: p.limit as number | undefined,
              levels: p.levels as RuntimeProbeInput["levels"],
              kinds: p.kinds as RuntimeProbeInput["kinds"],
            };
            const result = await runtimeProbeService.execute(input);
            return jsonResult(`运行时探针：${input.action}`, result);
          } catch (error) { return errorResult("runtime_probe", error); }
        },
      });
    }

    const spawnHook = (ctx: BashSpawnContext) =>
      applyShellIsolationSpawnContext(normalizeIsolationLevel(bridge.getIsolationLevel()), bridge.taskRoot, ctx);
    const bashTool = createBashTool(bridge.taskRoot, {
      spawnHook,
      shellPath: getAgentBashShellPath(bridge.taskRoot, getMyBuddyDir()),
    });
    const powerShellTool = supportsPowerShell ? createPowerShellTool(bridge.taskRoot, { spawnHook }) : null;
    if (config.execution.codeExecutionEnabled && !bridge.nativeExecution) {
      pi.registerTool({
        name: "execute_code",
        label: "代码执行",
        description:
          (supportsPowerShell
            ? "在当前任务目录执行一次性 JavaScript、Python、PowerShell 或 Bash 代码；PowerShell 使用独立原生后端，不经 Bash 二次转义。"
            : "在当前任务目录执行一次性 JavaScript、Python 或 Bash 代码。") +
          "JavaScript 以 Node ESM（.mjs）执行：用 `import x from 'node:fs'`，不要用 require。" +
          "Python 由 MyBuddy 受管运行时提供解释器与依赖环境：需要额外第三方库时，在代码里用注释 `# mybuddy-deps: pandas, openpyxl>=2.1` 声明，" +
          "需要特定版本时用 `# mybuddy-python: 3.12` 声明；不要自行 pip install、不要创建 .venv，也不要假设系统装有 Python。" +
          "运行技能自带的 Python 脚本时用 script 模式（`script` + `args`，只支持 Python）：脚本路径必须在任务目录或技能目录内，" +
          "解释器与依赖由该技能 SKILL.md 的 `python` / `python-dependencies` 声明决定，同样不要为技能自建 venv 或按需 pip install。" +
          "报 ModuleNotFoundError 时用 `python_dependencies` 参数带上缺失的包名重试，受管运行时会准备一套包含它的新环境；" +
          "首次准备环境会下载并安装，进度对用户可见；受管环境不可用时本工具直接返回失败阶段，不会静默改用系统 Python。",
        promptSnippet: "execute_code(language, code | script+args, python_dependencies?, timeout?)",
        parameters: executeCodeSchema,
        execute: async (
          id,
          p: {
            language: "javascript" | "python" | "powershell" | "shell";
            code?: string;
            script?: string;
            args?: string[];
            python_dependencies?: string[];
            timeout?: number;
          },
          signal,
          onUpdate,
        ) => {
          const code = p.code ?? "";
          const script = p.script?.trim() ?? "";
          const scriptMode = script.length > 0;
          if (scriptMode && code) return errorResult("execute_code", "code 与 script 只能二选一");
          if (!scriptMode && !code) return errorResult("execute_code", "必须提供 code 或 script");
          if (scriptMode && p.language !== "python") {
            return errorResult("execute_code", "script 模式只支持 Python；其它语言请读出文件内容后用 code 运行");
          }
          if (p.language === "powershell" && !supportsPowerShell) {
            return errorResult(
              "execute_code",
              `当前平台不支持 PowerShell（仅 Windows）；可用语言：${codeLanguages.join(" / ")}`,
            );
          }

          // Python 只走受管解释器：先解析（必要时自动准备），失败即明确报错，
          // 绝不回退裸 `python` 的 PATH 查找——那会让"机器没装 Python"变成不可诊断的失败。

          let pythonContext: PythonExecutionContext | null = null;
          let scriptPath = "";
          let useProjectBinding = false;
          if (p.language === "python") {
            const pythonRuntime = bridge.pythonRuntime;
            if (!pythonRuntime) {
              const message = "Python 运行时服务未装配；拒绝回退系统 Python";
              if (!signal?.aborted) recordCodeRuntimePreparationFailure(bridge.shellVerification, message);
              return errorResult("execute_code", message);
            }
            let spec: PythonEnvironmentSpec;
            if (scriptMode) {
              // 归属校验先于执行：技能目录在任务区之外，是唯一被允许的越界。
              // 少了这一步，script 参数就变成「用受管解释器跑机器上任意文件」的入口。
              scriptPath = resolve(bridge.taskRoot, script);
              const owner = bridge.resolveSkillScript?.(scriptPath) ?? null;
              const allowed =
                isPathInsideOrEqual(bridge.taskRoot, scriptPath) ||
                (owner !== null && isPathInsideOrEqual(owner.baseDir, scriptPath));
              if (!allowed) {
                return errorResult("execute_code", `脚本必须位于任务目录或技能目录内：${scriptPath}`);
              }
              if (!existsSync(scriptPath)) return errorResult("execute_code", `脚本不存在：${scriptPath}`);
              // 只有项目目录中的普通脚本允许使用显式项目解释器；Skill 必须保持自己的受管依赖环境。
              useProjectBinding = owner === null && isPathInsideOrEqual(bridge.taskRoot, scriptPath);
              spec = owner ? pythonRuntime.specFromSkillDeclaration(owner.frontmatter) : {};
            } else {
              // 临时代码永远走受管环境。否则项目 .venv 会吞掉 python_dependencies，导致依赖语义失效。
              spec = pythonRuntime.specFromCode(code);
            }
            // 额外包名并入规格：受管运行时按新的环境 id 准备一套新环境，
            // 而不是往已在用的环境里装包——那会破坏正在跑的任务。
            const extra = (p.python_dependencies ?? []).map((dep) => dep.trim()).filter(Boolean);
            if (extra.length > 0) spec = { ...spec, dependencies: [...(spec.dependencies ?? []), ...extra] };
            let resolution: Awaited<ReturnType<PythonRuntimeService["resolveForExecution"]>>;
            try {
              resolution = await pythonRuntime.resolveForExecution(spec, {
                signal,
                taskRoot: bridge.taskRoot,
                useProjectBinding,
              });
            } catch (error) {
              const message = `受管 Python 环境准备异常：${error instanceof Error ? error.message : String(error)}`;
              if (!signal?.aborted) recordCodeRuntimePreparationFailure(bridge.shellVerification, message);
              return errorResult("execute_code", error);
            }
            if (!resolution.ok) {
              const message = `受管 Python 环境不可用（失败阶段：${resolution.failureStage}）：${resolution.detail}`;
              if (!signal?.aborted) recordCodeRuntimePreparationFailure(bridge.shellVerification, message);
              return errorResult("execute_code", message);
            }
            resolveCodeRuntimePreparationFailure(bridge.shellVerification);
            pythonContext = {
              environmentId: resolution.environmentId,
              pythonVersion: resolution.pythonVersion,
              pythonPath: resolution.pythonPath,
            };
            const release = pythonRuntime.acquireExecution(resolution.environmentId);
            let temporaryDir: string | undefined;
            try {
              if (!scriptMode) {
                await mkdir(pythonRuntime.executionDir, { recursive: true });
                temporaryDir = await mkdtemp(join(pythonRuntime.executionDir, "execution-"));
                scriptPath = join(temporaryDir, "run.py");
                await writeFile(scriptPath, code, "utf8");
              }
              const evidenceIdentity = codeExecutionEvidenceIdentity({
                language: p.language,
                code: scriptMode ? undefined : code,
                scriptPath: scriptMode ? scriptPath : undefined,
                args: p.args,
                pythonDependencies: p.python_dependencies,
              });
              return await executeVerifiedCode({
                bridge: bridge.shellVerification,
                toolCallId: id,
                evidenceIdentity,
                signal,
                execute: async () => {
                  const result = await executePython({
                    pythonPath: resolution.pythonPath, scriptPath, args: p.args, cwd: bridge.taskRoot,
                    signal, timeoutSeconds: p.timeout,
                    isolationLevel: bridge.getIsolationLevel(),
                    onOutput: text => onUpdate?.({ content: [{ type: "text", text }], details: pythonContext ?? {} }),
                  });
                  return {
                    result: {
                      content: [{ type: "text" as const, text: result.text || `(exit ${result.exitCode})` }],
                      isError: result.exitCode !== 0 || result.cancelled || result.timedOut,
                      details: { ...pythonContext, exitCode: result.exitCode, cancelled: result.cancelled, timedOut: result.timedOut },
                    },
                    exitCode: result.exitCode,
                    cancelled: result.cancelled,
                    timedOut: result.timedOut,
                  };
                },
              });
            } catch (error) {
              return errorResult("execute_code", error);
            } finally {
              release();
              if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
            }
          }

          const runDir = resolve(bridge.taskRoot, ".mybuddy-execution");
          if (!isPathInsideOrEqual(bridge.taskRoot, runDir)) return errorResult("execute_code", "执行目录越出任务工作区");
          await mkdir(runDir, { recursive: true });
          const base = join(runDir, `run-${randomUUID()}`);
          const spec = p.language === "javascript"
            ? { file: `${base}.mjs`, runner: "bash" as const, command: (file: string) => `node ${quoteBashArg(toBashPath(file))}` }
            : p.language === "powershell"
                ? { file: `${base}.ps1`, runner: "powershell" as const, command: (file: string) => `& ${quotePowerShellLiteral(file)}` }
                : { file: `${base}.sh`, runner: "bash" as const, command: (file: string) => `bash ${quoteBashArg(toBashPath(file))}` };
          try {
            await writeFile(spec.file, code, "utf8");
            const tool = spec.runner === "powershell" ? powerShellTool : bashTool;
            // schema 已按平台门控；这里是防御性兜底（例如调用方绕过 schema 直接传参）。
            if (!tool) return errorResult("execute_code", "当前平台不支持 PowerShell（仅 Windows）");
            const evidenceIdentity = codeExecutionEvidenceIdentity({ language: p.language, code });
            return await executeVerifiedCode({
              bridge: bridge.shellVerification,
              toolCallId: id,
              evidenceIdentity,
              signal,
              execute: async () => ({
                result: withPythonDetails(
                  await tool.execute(id, { command: spec.command(spec.file), timeout: p.timeout }, signal, onUpdate),
                  pythonContext,
                ),
                exitCode: 0,
              }),
            });
          } catch (error) {
            return errorResult("execute_code", error);
          } finally {
            try { await rm(spec.file, { force: true }); } catch { /* best effort */ }
          }
        },
      });
    }
  };
}
