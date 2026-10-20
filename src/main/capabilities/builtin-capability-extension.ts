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
import { computerAutomationService, type ComputerBatchAction, type ComputerExecInput } from "./ComputerAutomationService";
import { computerUseRunCoordinator } from "./ComputerUseRunCoordinator";
import { getAgentBashShellPath } from "../agent-shell-settings";
import { getMyBuddyDir } from "../paths";
import { runtimeProbeService, type RuntimeProbeInput } from "./RuntimeProbeService";
import { MediaArtifactMaterializer } from "./MediaArtifactMaterializer";
import { ageToolResultImages } from "./ToolImageAging";
import { routeVisionForPaths, type VisionRouteResult } from "./VisionRouting";
import { createWebAccessCapabilityExtension } from "./web-access/index";
import { quoteBashArg, quotePowerShellLiteral, toBashPath } from "../agent/ShellArguments";
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
  const details = (error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object")
    ? { error: message, details: error.details as Record<string, unknown> }
    : { error: message };
  return {
    content: [{ type: "text" as const, text: `[${tool}] ${message}` }],
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
  prompt: Type.String({ minLength: 1, maxLength: 10_000 }),
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
  control_runtime_id: Type.Optional(Type.String({ maxLength: 1_000 })),
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
  background: Type.Optional(Type.Boolean({ description: "不抢焦点：screenshot_window 用原生 PrintWindow，Chromium/Qt/Tauri 自动改用 WGC 窗口源；click_client 用 PostMessage（仅部分应用接受）。" })),
  window_title: Type.Optional(Type.String({ maxLength: 1_000 })),
  window_handle: Type.Optional(Type.String({ maxLength: 100 })),
  process_id: Type.Optional(Type.Integer({ minimum: 1 })),
  process_name: Type.Optional(Type.String({ maxLength: 200 })),
  class_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  screen_id: Type.Optional(Type.String({ maxLength: 100 })),
  control_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  automation_id: Type.Optional(Type.String({ maxLength: 1_000 })),
  control_type: Type.Optional(Type.String({ maxLength: 200 })),
  control_runtime_id: Type.Optional(Type.String({ maxLength: 1_000 })),
  control_class_name: Type.Optional(Type.String({ maxLength: 1_000 })),
  exact_name: Type.Optional(Type.Boolean()),
  client_only: Type.Optional(Type.Boolean({ default: true, description: "默认 true：返回与 click_client 坐标直接对齐的客户区 DIP 图像；false 返回含窗口边框的 window-DIP 图像。" })),
  ensure_foreground: Type.Optional(Type.Boolean()),
  observation_id: Type.Optional(Type.String({ maxLength: 100 })),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
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

const executeCodeSchema = Type.Object({
  language: Type.Union([
    Type.Literal("javascript"), Type.Literal("python"), Type.Literal("powershell"), Type.Literal("shell"),
  ]),
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

export function createBuiltinCapabilityExtension(bridge: BuiltinCapabilityExtensionBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const config = bridge.runtime.config();
    const materializer = new MediaArtifactMaterializer(bridge.artifactService, bridge.markArtifactEmitted);
    const vision = config.vision.enabled ? bridge.runtime.visionProvider() : null;
    const imageCandidate = config.imageGeneration.enabled ? bridge.runtime.imageProvider() : null;
    const image = imageCandidate && (imageCandidate.isAvailable?.() ?? true) ? imageCandidate : null;
    const video = config.videoGeneration.enabled ? bridge.runtime.videoProvider() : null;
    const stt = config.speechToText.enabled ? bridge.runtime.speechToTextProvider() : null;
    const tts = config.textToSpeech.enabled ? bridge.runtime.textToSpeechProvider() : null;

    // Computer Use accumulates screenshots quickly; keep only the newest two in
    // the model context so every request does not re-send old pixels. Session
    // history keeps the original images. Test doubles may omit the event API.
    if (typeof pi.on === "function") {
      pi.on("context", (event) => {
        const aged = ageToolResultImages(event.messages, 2);
        return aged === event.messages ? undefined : { messages: aged as typeof event.messages };
      });
    }

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
              model: (p.model as string | undefined) ?? config.imageGeneration.model,
              seed: p.seed as number | undefined,
              inputImagePaths: Array.isArray(p.input_image_paths)
                ? (p.input_image_paths as string[]).map((item) => capabilityPath(bridge, item))
                : undefined,
            };
            const context = toolContext(bridge, tc, signal);
            const generated = await image.generateImage!(input, context);
            const saved = await materializer.materialize("image", generated, context, "生成图片");
            return jsonResult(`已生成并保存 ${saved.paths.length} 张图片`, { ...generated, items: saved.paths, artifactIds: saved.artifacts.map((a) => a.id) });
          } catch (error) { return errorResult("image_generate", error); }
        },
      });
    }

    if (video) {
      pi.registerTool({
        name: "video_generate",
        label: "视频生成",
        description: "从文本或任务内图片生成视频；输出下载到当前任务目录并登记 Video Artifact。",
        promptSnippet: "video_generate(prompt, duration_seconds?, aspect_ratio?, resolution?, input_image_path?, generate_audio?)",
        parameters: videoGenerateSchema,
        execute: async (tc, p: Record<string, unknown>, signal?: AbortSignal) => {
          try {
            const input: VideoGenerateInput = {
              prompt: String(p.prompt),
              negativePrompt: p.negative_prompt as string | undefined,
              aspectRatio: p.aspect_ratio as string | undefined,
              durationSeconds: p.duration_seconds as number | undefined,
              resolution: p.resolution as string | undefined,
              model: (p.model as string | undefined) ?? config.videoGeneration.model,
              seed: p.seed as number | undefined,
              inputImagePath: typeof p.input_image_path === "string" ? capabilityPath(bridge, p.input_image_path) : undefined,
              generateAudio: p.generate_audio as boolean | undefined,
            };
            const context = toolContext(bridge, tc, signal);
            const generated = await video.generateVideo!(input, context);
            const saved = await materializer.materialize("video", generated, context, "生成视频");
            return jsonResult(`已生成并保存 ${saved.paths.length} 个视频`, { ...generated, items: saved.paths, artifactIds: saved.artifacts.map((a) => a.id) });
          } catch (error) { return errorResult("video_generate", error); }
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
            const result = await stt.speechToText!({ audioPath: capabilityPath(bridge, p.audio_path), language: p.language, prompt: p.prompt }, toolContext(bridge, tc, signal));
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
            const generated = await tts.textToSpeech!({
              ...p,
              voice: p.voice ?? config.textToSpeech.voice,
              rate: p.rate ?? config.textToSpeech.rate,
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
        description: "操作 MyBuddy 自有浏览器。仅支持 status/navigate/read/click/fill/press/screenshot 枚举动作，不执行任意 JavaScript。screenshot 会按当前主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；background=true 用 PrintWindow（Chromium/Qt/Tauri 自动 WGC 窗口源）后台截图或 PostMessage 后台点击（不抢焦点，部分应用不接受）；click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。",
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
        description: "观察并操作 MyBuddy 主界面、内嵌浏览器或 Artifact 页面。点击/键盘走 Electron 输入事件，适合真实复现 UI Bug；不执行任意 JavaScript。screenshot 已自动视觉路由，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；background=true 用 PrintWindow（Chromium/Qt/Tauri 自动 WGC 窗口源）后台截图或 PostMessage 后台点击（不抢焦点，部分应用不接受）；click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。",
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
      pi.registerTool({
        name: "computer_exec",
        label: "Windows Computer Use",
        description: bridge.nativeExecution ? "Windows 原生 Computer Use。inspect_window/find/inspect 读取窗口和 UIA 控件；invoke/set/click_client/type_text 操作目标窗口。bounds/clientBoundsDip 使用客户区 DIP，screenshot_window 的 client_only 默认 true。截图返回 JPEG，可能等比缩放到 2000px 以内：image_scale 是物理像素/图像像素比例（通常为 1），窗口截图坐标 = 图像像素 × image_scale，desktop 截图仅用于观察。窗口输入会验证 HWND/PID 和焦点。type_text 返回 completed=false 时先观察 typedLength 和当前内容。capture_after 默认关闭，需要视觉确认时显式传 true。actions 可一次执行 1–8 个窗口输入步骤（同一窗口、顺序执行、出错即停），返回 steps 与最终 observation；list_windows 支持 window_title/process_id/process_name/class_name 过滤。截图按主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；background=true 用 PrintWindow（Chromium/Qt/Tauri 自动 WGC 窗口源）后台截图或 PostMessage 后台点击（不抢焦点，部分应用不接受）；click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。" : "Windows 原生 Computer Use。优先按窗口操作：inspect_window → inspect/find UIA control → invoke/set；inspect/find 返回的 bounds/clientBoundsDip 是 click_client 可直接使用的客户区 DIP 坐标。UIA 不可用时 screenshot_window（client_only 默认 true）→ click_client。截图统一为 JPEG 并可能等比缩放到 2000px 以内：image_scale 是物理像素/图像像素比例，窗口截图的客户区坐标 = 图像像素 × image_scale（通常为 1），desktop 截图仅用于观察、legacy 桌面坐标需乘 image_scale。窗口级输入会验证 HWND/PID/前台焦点，目标变化会拒绝执行；目标化 type_text 中断会返回 completed=false 与 typedLength，禁止盲目重试。capture_after 默认关闭，只有需要视觉确认时才显式传 true（否则只做窗口集合观测）。actions 可一次执行 1–8 个窗口输入步骤（move/click/drag/scroll/key/type，同一窗口目标、顺序执行、出错即停），返回 steps、最终 observation 与可选 capture，用它替代逐个动作的多轮往返。list_windows 支持 window_title/process_id/process_name/class_name 过滤并返回精简字段；需要完整几何时用 inspect_window。任何返回截图的动作都会按主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；background=true 用 PrintWindow（Chromium/Qt/Tauri 自动 WGC 窗口源）后台截图或 PostMessage 后台点击（不抢焦点，部分应用不接受）；click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。",
        promptSnippet: "computer_exec(action?|actions?, window_handle?/window_title?/process_id?, control_name?/automation_id?, x?/y?, observation_id?, capture_after?, expected_outcomes?)",
        parameters: computerExecSchema,
        execute: async (tc, p: Record<string, unknown>, signal, _onUpdate, ctx) => {
          let input: ComputerExecInput | undefined;
          let operationSignal: AbortSignal | undefined;
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
            const action = (p.action as ComputerExecInput["action"] | undefined) ?? batchActions?.[0]?.action;
            if (!action && !batchActions?.length) throw new Error("computer_exec 需要 action 或 actions");
            input = {
              action,
              actions: batchActions?.length ? batchActions : undefined,
              settleMs: p.settle_ms as number | undefined,
              taskId: bridge.nativeExecution ? undefined : bridge.taskId,
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
            operationSignal = bridge.nativeExecution ? signal : computerUseRunCoordinator.scope(bridge.taskId, signal);
            operationSignal?.throwIfAborted();
            const result = await computerAutomationService.execute(input, operationSignal);
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
                summary: "Windows 画面已保存", details, model: ctx?.model, vision, context,
                images: [{ path: saved.paths[0], bytes: result.screenshot, mimeType }],
                prompt: "请分析这张 Windows 界面截图，准确描述可见窗口、主要控件、文本、状态、错误提示和与当前任务相关的可交互目标及其相对位置。不要猜测不可见内容。",
              });
              operationSignal?.throwIfAborted();
              return imageResult;
            }
            return jsonResult(batchActions?.length ? `批量桌面动作完成：${batchActions.length} 步` : `桌面动作完成：${String(action)}`, result);
          } catch (error) {
            const failure = operationSignal?.aborted ? operationSignal.reason : error;
            if (input && !bridge.nativeExecution) {
              computerUseRunCoordinator.fail(input, operationSignal);
              recordComputerUseFailureRecovery(bridge.computerRecovery, input, failure);
            }
            return errorResult("computer_exec", failure);
          }
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
    const powerShellTool = createPowerShellTool(bridge.taskRoot, { spawnHook });
    if (config.execution.codeExecutionEnabled && !bridge.nativeExecution) {
      pi.registerTool({
        name: "execute_code",
        label: "代码执行",
        description:
          "在当前任务目录执行一次性 JavaScript、Python、PowerShell 或 Bash 代码；PowerShell 使用独立原生后端，不经 Bash 二次转义。" +
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
