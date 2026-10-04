/**
 * RuntimeRequirement — 设计模式统一 Runtime 生命周期的声明模型（共享层，纯数据/纯函数）。
 *
 * 背景：`requiredRuntimes: string[]` 只有 providerId 一个维度，无法表达「弹 GUI / 只起
 * backend / 什么都不起」「分层 readiness / 端口 / HTTP」「是否自动打开浏览器」。
 * 本模块提供：
 * - 结构化声明类型（RuntimeRequirement）；
 * - 每个 managed provider 的出厂默认策略表（Registry，provider 细节集中在声明层，
 *   AgentService/renderer 不写 provider 特判）；
 * - 旧 `string[]` → 结构化声明的优雅归一化（resolveRuntimeRequirement），
 *   旧数据（磁盘 policy.json / 旧 seed）无需迁移即可获得正确默认策略。
 */
import {
  isManagedToolProvider,
  type ManagedToolProviderId,
} from "./professional-tools";

/** 启动策略：gui = 启动可见桌面软件；backend = 只启动服务/daemon/Docker；none = 绝不自动启动 */
export type RuntimeLaunchPolicy = "gui" | "backend" | "none";
/** readiness 判定：layered = app-visible + backend 分层；tcp/http = 端口/HTTP 探测；preflight-only = 仅配置预检 */
export type RuntimeReadinessPolicy = "layered" | "tcp" | "http" | "preflight-only";
/** ready 后是否自动打开 UI（浏览器/应用内）；none = 只有显式 open() 才打开 */
export type RuntimeOpenUiPolicy = "none" | "browser" | "app";

export interface RuntimeRequirement {
  providerId: ManagedToolProviderId;
  launchPolicy: RuntimeLaunchPolicy;
  readinessPolicy: RuntimeReadinessPolicy;
  openUi: RuntimeOpenUiPolicy;
  /** 单次 ensureReady 等待上限（ms）；缺省用 RuntimePrewarmService 默认 */
  timeoutMs?: number;
}

/**
 * preset 声明输入：旧 string（仅 providerId，策略走默认）或结构化对象（字段级覆盖）。
 * 结构化对象缺失的字段在 resolve 时用 provider 默认补齐。
 * providerId 使用宽 string：磁盘数据未经类型约束，合法性在 resolve 时校验。
 */
export type RuntimeRequirementInput =
  | string
  | ({ providerId: string } & Partial<Omit<RuntimeRequirement, "providerId">>);

export const RUNTIME_LAUNCH_POLICIES: readonly RuntimeLaunchPolicy[] = ["gui", "backend", "none"];
export const RUNTIME_READINESS_POLICIES: readonly RuntimeReadinessPolicy[] = [
  "layered",
  "tcp",
  "http",
  "preflight-only",
];
export const RUNTIME_OPEN_UI_POLICIES: readonly RuntimeOpenUiPolicy[] = ["none", "browser", "app"];

/**
 * 出厂默认策略表（Registry）。provider 的「启动/readiness/UI」行为默认值集中在这里；
 * 实际判定实现仍在各自 Runtime 类中，本表只做声明解析。
 */
export const RUNTIME_REQUIREMENT_DEFAULTS: Readonly<
  Record<ManagedToolProviderId, Omit<RuntimeRequirement, "providerId">>
> = {
  // 服务类：Docker compose。Penpot Ready 后用系统浏览器打开 9001
  penpot: { launchPolicy: "backend", readinessPolicy: "http", openUi: "browser" },
  // adapter-managed：进程由会话内 MCP adapter 托管，MyBuddy 不启动、不判 backend
  "drawio-ai": { launchPolicy: "none", readinessPolicy: "preflight-only", openUi: "none" },
};

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * 把 preset 声明（string 或结构化对象）解析为完整 RuntimeRequirement。
 * - string（旧格式）→ 只用 provider 默认策略；
 * - 对象 → 默认策略 + 字段级覆盖（非法枚举回落默认）；
 * - 未知 provider / 空输入 → null（调用方跳过，不阻塞）。
 */
export function resolveRuntimeRequirement(
  input: RuntimeRequirementInput | null | undefined,
): RuntimeRequirement | null {
  if (!input) return null;
  if (typeof input === "string") {
    const id = input.trim();
    if (!isManagedToolProvider(id)) return null;
    return { providerId: id, ...RUNTIME_REQUIREMENT_DEFAULTS[id] };
  }
  const id = input.providerId;
  if (!isManagedToolProvider(id)) return null;
  const d = RUNTIME_REQUIREMENT_DEFAULTS[id];
  const resolved: RuntimeRequirement = {
    providerId: id,
    launchPolicy: pickEnum(input.launchPolicy, RUNTIME_LAUNCH_POLICIES, d.launchPolicy),
    readinessPolicy: pickEnum(input.readinessPolicy, RUNTIME_READINESS_POLICIES, d.readinessPolicy),
    openUi: pickEnum(input.openUi, RUNTIME_OPEN_UI_POLICIES, d.openUi),
  };
  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    resolved.timeoutMs = Math.round(input.timeoutMs);
  }
  return resolved;
}

/** 解析整个 requiredRuntimes 列表：未知/非法项跳过；同 provider 取首个（保序）。 */
export function resolveRuntimeRequirementList(
  inputs: RuntimeRequirementInput[] | null | undefined,
): RuntimeRequirement[] {
  if (!Array.isArray(inputs)) return [];
  const out: RuntimeRequirement[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const resolved = resolveRuntimeRequirement(input);
    if (!resolved || seen.has(resolved.providerId)) continue;
    seen.add(resolved.providerId);
    out.push(resolved);
  }
  return out;
}
