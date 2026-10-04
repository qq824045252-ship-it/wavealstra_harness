/**
 * Python 运行时管理 IPC 契约
 *
 * 定位：MyBuddy 受管的 Python 解释器与环境层。Agent 不决定安装目录、不拼装
 * uv 参数、不寻找解释器；它只声明「需要什么」，由运行时服务负责准备与绑定。
 *
 * 冻结约束（违反即为缺陷）：
 * - 已就绪环境绝不原地装包或升级。新依赖 → 新环境 → 就绪后再绑定。
 * - 受管环境不可用时返回明确失败阶段，绝不静默回退系统 Python。
 * - 环境目录与任务工作目录彻底分离：解释器/依赖/锁在运行时目录，
 *   输入输出仍发生在任务工作区。
 * - 安装失败只留下可清理的 staging 目录，不把半成品标成就绪。
 *
 * 本文件是 renderer 也会打包的契约，因此不得 import 任何 node 内置模块。
 * 规格身份计算（sha256）在主进程侧：src/main/runtime/python-environment-spec.ts。
 */

/** 准备阶段。用户与 Agent 都能看到「首次运行慢在哪里」。 */
export type PythonRuntimePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "verifying"
  | "ready"
  | "failed";

/** 失败阶段，用于定位问题（附在运行结果里）。 */
export type PythonFailureStage =
  | "uv-unavailable"
  | "uv-download-failed"
  | "uv-checksum-mismatch"
  | "interpreter-install-failed"
  | "environment-create-failed"
  | "dependency-install-failed"
  | "verify-failed"
  | "cancelled";

/** 依赖规格。相同兼容规格复用同一环境；冲突规格自然落到不同环境。 */
export interface PythonEnvironmentSpec {
  /** uv 版本选择子，如 "3.12" 或 ">=3.11,<3.13"；缺省用 DEFAULT_PYTHON_REQUEST */
  python?: string;
  /** PEP 508 依赖，如 ["pandas", "openpyxl>=2.1"]；缺省为基础环境 */
  dependencies?: string[];
  /**
   * 隔离维度，参与环境 id 计算但不影响依赖解析。
   * 内置能力用 `capability:<id>@<version>`：能力版本升级 → id 变化 → 新环境，
   * 从而满足「独立固定环境，随能力版本升级」且不原地升级已投入使用的旧环境。
   */
  profile?: string;
}

/** 未声明依赖时的基础环境请求。包清单刻意留空：按实际内置能力再增补，不预装所有库。 */
export const DEFAULT_PYTHON_REQUEST = "3.12";

export const PYTHON_BASE_ENVIRONMENT_LABEL = "base";

/**
 * 项目解释器的手动覆盖记录。
 *
 * 正常路径是零配置自动发现项目内 .venv/venv/env；只有自动识别不合适时才写入此记录。
 * 仍按项目目录建键而不是 workspace，保证同一项目从不同入口执行时语义一致。
 */
export interface PythonProjectBinding {
  /** 绑定时的原始目录（resolve 后），用于 UI 展示 */
  projectDir: string;
  /** 大小写/分隔符归一后的查找键，由主进程计算 */
  dirKey: string;
  pythonPath: string;
  /** 绑定时探测到的真实版本；探测失败的绑定不会被保存 */
  pythonVersion: string | null;
  /** 项目自己的清单（pyproject.toml / requirements.txt / .python-version） */
  manifestPath: string | null;
  boundAt: number;
}

/** UI 视图：附带解释器是否仍存在——失效绑定必须一眼可见，而不是静默回退。 */
export interface PythonProjectBindingView extends PythonProjectBinding {
  /** 稳定的短 id，与执行结果里的 environmentId 一致 */
  bindingId: string;
  available: boolean;
}

export interface PythonProjectBindingRequest {
  projectDir: string;
  pythonPath: string;
}

export type PythonProjectBindingMutationResult =
  | { ok: true; binding: PythonProjectBindingView }
  | { ok: false; error: string };

/** 当前项目实际会使用哪一个 Python。UI 只展示这一条，不管理绑定表。 */
export interface PythonProjectInterpreterView {
  /** renderer 传入的当前空间/任务目录 */
  projectDir: string;
  /** override=用户手动覆盖；auto=自动发现项目虚拟环境；managed=回到 MyBuddy 受管运行时 */
  source: "override" | "auto" | "managed";
  /** 真正命中的项目根；managed 时为 null */
  resolvedProjectDir: string | null;
  pythonPath: string | null;
  pythonVersion: string | null;
  manifestPath: string | null;
  available: boolean;
  detail: string;
}

export interface PythonInterpreterInfo {
  version: string;
  path: string;
}

export interface PythonEnvironmentInfo {
  id: string;
  label: string;
  pythonRequest: string;
  pythonVersion: string | null;
  dependencies: string[];
  path: string;
  ready: boolean;
  /** 就绪后是否已被任务绑定使用过；用于「不原地升级」的判断依据 */
  inUse: boolean;
  createdAt: number | null;
}

export interface PythonUvInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: "managed" | "setting" | "env" | null;
}

export interface PythonRuntimeRoots {
  runtime: string;
  toolchain: string;
  interpreters: string;
  environments: string;
  manifests: string;
  cache: string;
  staging: string;
}

export interface PythonRuntimeStatus {
  phase: PythonRuntimePhase;
  /** 中文可读说明，含当前/失败阶段 */
  detail: string;
  uv: PythonUvInfo;
  interpreters: PythonInterpreterInfo[];
  environments: PythonEnvironmentInfo[];
  error: string | null;
  failureStage: PythonFailureStage | null;
  roots: PythonRuntimeRoots;
}

/** 准备进度事件（main → renderer）。fraction 未知时为 null，但字节数始终上报。 */
export interface PythonRuntimeProgressEvent {
  environmentId: string | null;
  phase: PythonRuntimePhase;
  detail: string;
  fraction: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

/** 解释器解析结果：成功带环境标识与版本，失败带阶段。绝不返回系统 Python 兜底。 */
export type PythonInterpreterResolution =
  | {
      ok: true;
      environmentId: string;
      pythonPath: string;
      pythonVersion: string;
      dependencies: string[];
    }
  | {
      ok: false;
      phase: PythonRuntimePhase;
      failureStage: PythonFailureStage;
      detail: string;
      error: string;
    };

export interface PreparePythonEnvironmentRequest extends PythonEnvironmentSpec {
  /** 绑定标签，仅用于 UI 展示（如 "base"、"voice"、技能 id）；不参与 id 计算 */
  label?: string;
}

export interface PreparePythonEnvironmentResult {
  ok: boolean;
  environmentId: string;
  spec: { python: string; dependencies: string[] };
  pythonPath?: string;
  pythonVersion?: string;
  environmentPath?: string;
  /** 本次是否新建（false 表示复用了已就绪环境） */
  created?: boolean;
  failureStage?: PythonFailureStage;
  detail?: string;
  error?: string;
}

/**
 * 诊断导出结果。
 *
 * `cancelled` 单列：用户在保存对话框里点「取消」不是故障，UI 不该渲染成红色错误；
 * 只有写盘失败才是。
 */
export interface PythonDiagnosticsExportResult {
  ok: boolean;
  cancelled: boolean;
  detail: string;
}

export const PythonRuntimeIpc = {
  /** invoke：查询当前状态（不触发下载） */
  status: "python-runtime:status",
  /** invoke：按规格准备环境（复用或新建） */
  prepare: "python-runtime:prepare",
  /** invoke：列出已就绪环境 */
  list: "python-runtime:list",
  /** invoke：删除一个未被使用的环境（回收） */
  remove: "python-runtime:remove",
  /** invoke：清理 staging 残留 */
  cleanStaging: "python-runtime:cleanStaging",
  /** invoke：回收被取代的 uv 版本目录与下载缓存 */
  reclaimDisk: "python-runtime:reclaimDisk",
  /** invoke：导出诊断信息到用户选择的 JSON 文件 */
  exportDiagnostics: "python-runtime:exportDiagnostics",
  /** invoke：检查当前项目实际会使用的解释器（自动发现 + 手动覆盖） */
  inspectProject: "python-runtime:project:inspect",
  /** invoke：列出手动覆盖记录（诊断/兼容用；产品 UI 不管理此列表） */
  listProjectBindings: "python-runtime:projectBindings:list",
  /** invoke：显式绑定一个项目目录到它自己的解释器 */
  bindProject: "python-runtime:projectBindings:bind",
  /** invoke：解除项目模式绑定，回到受管环境 */
  unbindProject: "python-runtime:projectBindings:unbind",
  /** invoke：原生目录选择器（返回 null 表示取消） */
  pickProjectDir: "python-runtime:pickProjectDir",
  /** invoke：原生解释器选择器（返回 null 表示取消） */
  pickInterpreter: "python-runtime:pickInterpreter",
  /** main → renderer：准备进度/状态变更 */
  progress: "python-runtime:progress",
} as const;

/**
 * 中文 detail 文案的唯一来源，保证 CLI/IPC/前端措辞一致。纯函数。
 */
export function pythonRuntimeDetail(
  phase: PythonRuntimePhase,
  context?: { spec?: string; failureStage?: PythonFailureStage | null; reason?: string | null },
): string {
  const spec = context?.spec;
  switch (phase) {
    case "idle":
      return "尚未准备 Python 运行时";
    case "checking":
      return spec ? `正在检查环境：${spec}` : "正在检查 Python 运行时";
    case "downloading":
      return spec ? `正在下载：${spec}` : "正在下载 Python 运行时组件";
    case "installing":
      return spec ? `正在安装：${spec}` : "正在安装 Python 运行时组件";
    case "verifying":
      return "正在校验安装结果";
    case "ready":
      return spec ? `已就绪：${spec}` : "Python 运行时已就绪";
    case "failed":
      return `准备失败（${pythonFailureStageLabel(context?.failureStage ?? null)}）${
        context?.reason ? `：${context.reason}` : ""
      }`;
  }
}

export function pythonFailureStageLabel(stage: PythonFailureStage | null): string {
  switch (stage) {
    case "uv-unavailable":
      return "安装工具不可用";
    case "uv-download-failed":
      return "安装工具下载失败";
    case "uv-checksum-mismatch":
      return "安装工具校验失败";
    case "interpreter-install-failed":
      return "解释器安装失败";
    case "environment-create-failed":
      return "环境创建失败";
    case "dependency-install-failed":
      return "依赖安装失败";
    case "verify-failed":
      return "结果校验失败";
    case "cancelled":
      return "已取消";
    case null:
      return "未知阶段";
  }
}
