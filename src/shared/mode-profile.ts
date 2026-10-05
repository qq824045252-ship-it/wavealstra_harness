/** 欢迎三模式（日常办公 / 代码开发 / Bot）资料契约 */

import { composeMcpPolicies, composeSkillPolicies } from "./runtime-policy";
import type { RuntimeRequirementInput } from "./runtime-requirement";

export type WelcomeMode = "working" | "coding" | "bot";

/** A missing scene is ordinary office work, never implicit coding. Explicit persisted scenes win. */
export const DEFAULT_WELCOME_MODE: WelcomeMode = "working";
export function resolveWelcomeMode(...candidates: unknown[]): WelcomeMode {
  return candidates.find((mode): mode is WelcomeMode => mode === "working" || mode === "coding" || mode === "bot") ?? DEFAULT_WELCOME_MODE;
}

export type ModeBlockId = "goal" | "workflow" | "delivery" | "forbid" | "criteria";

export const MODE_BLOCK_IDS: ModeBlockId[] = [
  "goal",
  "workflow",
  "delivery",
  "forbid",
  "criteria",
];

export const MODE_BLOCK_LABELS: Record<ModeBlockId, string> = {
  goal: "目标",
  workflow: "工作流程",
  delivery: "交付要求",
  forbid: "禁止事项",
  criteria: "验收标准",
};

export const WELCOME_MODE_LABELS: Record<WelcomeMode, string> = {
  working: "日常办公",
  coding: "代码开发",
  bot: "Bot",
};

export const WELCOME_MODES: WelcomeMode[] = ["coding", "working", "bot"];

export interface ModeSkillPolicy {
  prefer: string[];
  demote: string[];
  /** 限制/黑名单：命中则从本模式技能目录隐藏 */
  hide: string[];
  /**
   * 白名单：非空时仅保留命中项（在 hide 之后生效）。
   * 空数组 = 不启用白名单。
   */
  allow: string[];
}

export interface ModeToolPolicy {
  mode: "soft" | "hard";
  prefer: string[];
  demote: string[];
  deny: string[];
}

/**
 * MCP 按场景策略（会话级，createSession 时过滤）。
 * - A 黑名单：deny 命中则本会话不加载
 * - B 白名单：allow 非空时仅允许命中项；空数组 = 不启用白名单
 * hard = 真正不注入 adapter；soft = 仍加载（仅调试用）
 */
export interface ModeMcpPolicy {
  mode: "soft" | "hard";
  /** B：白名单（空 = 关闭白名单限制） */
  allow: string[];
  /** A：黑名单 */
  deny: string[];
}

/**
 * 产物扩展名策略（V3.6：仅用于产物面板显示过滤，不再拦截 write/edit）。
 * 与 MCP 策略同构，黑白名单各自独立：
 * - A 黑名单 deny：命中则面板隐藏
 * - B 白名单 allow：非空时仅显示命中项；空数组 = 不启用白名单
 * - mode（hard/soft）：写入拦截已移除，两值行为一致，保留兼容配置
 * 判定顺序：先 deny，再 allow（白名单外也隐藏）。
 */
export interface ModeArtifactPolicy {
  /** Bot displays the complete Durable/workspace projection, including intermediate files. */
  unfiltered?: boolean;
  mode: "soft" | "hard";
  /** B：白名单扩展名（空 = 不启用白名单） */
  allow: string[];
  /** A：黑名单扩展名（可写 py 或 .py，归一化为无点小写） */
  deny: string[];
}

/** 归一化扩展名：去空白、去前导点、小写；非法空串返回 "" */
export function normalizeArtifactExtension(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase();
}

/** 归一化扩展名列表（去空、去重，保序） */
export function normalizeArtifactExtensions(list: string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const ext = normalizeArtifactExtension(raw);
    if (!ext || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

/** 从路径提取扩展名（无点小写）；无扩展名返回 "" */
export function extensionFromPath(filePath: string): string {
  const base = String(filePath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  // 忽略以点开头的隐藏文件名本身（如 .gitignore）——取最后一个 . 之后
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return normalizeArtifactExtension(base.slice(dot + 1));
}

/**
 * 路径是否命中产物黑名单。
 * 多段扩展如 .tar.gz 只匹配末段 gz；无扩展名路径永不命中。
 */
export function pathMatchesArtifactDeny(filePath: string, deny: string[]): boolean {
  const ext = extensionFromPath(filePath);
  if (!ext) return false;
  const set = new Set(normalizeArtifactExtensions(deny));
  return set.has(ext);
}

/**
 * 白名单是否允许该路径。
 * allow 为空 = 白名单未启用（视为通过）；无扩展名路径在白名单启用时不通过。
 */
export function pathMatchesArtifactAllow(filePath: string, allow: string[]): boolean {
  const allowNorm = normalizeArtifactExtensions(allow);
  if (allowNorm.length === 0) return true;
  const ext = extensionFromPath(filePath);
  if (!ext) return false;
  return new Set(allowNorm).has(ext);
}

export type ArtifactWriteDecision =
  | { block: false }
  | { block: true; reason: "deny" | "allow"; ext: string };

/**
 * FreeCAD MCP / cad_freecad_run 落盘的临时脚本，不是用户产物。
 * 目录：cad/_freecad_scripts/；文件名：fc_<id>.py / fc_<id>.args.json
 */
export function isCadScratchArtifact(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.split("/").includes("_freecad_scripts")) return true;
  const base = normalized.split("/").pop() ?? "";
  return /^fc_[a-z0-9]+\.(py|args\.json)$/i.test(base);
}

/**
 * 产物显示过滤（产物黑白名单作用于产物面板与消息芯片，不再拦截文件写入）：
 * deny 命中或 allow 非空未命中 → 隐藏；与 evaluateArtifactWrite 判定一致，
 * 但不区分 soft/hard —— 显示过滤始终生效，文件落地不受影响。
 * CAD 临时脚本（isCadScratchArtifact）始终隐藏。
 */
function normalizeArtifactDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isPptdProjectInternalArtifact(
  filePath: string | undefined,
  peerArtifactPaths: readonly string[] | undefined,
): boolean {
  if (!filePath || !peerArtifactPaths?.length) return false;
  const target = normalizeArtifactDisplayPath(filePath);
  for (const rawManifest of peerArtifactPaths) {
    const manifest = normalizeArtifactDisplayPath(rawManifest);
    if (!manifest.endsWith(".pptd")) continue;
    const slash = manifest.lastIndexOf("/");
    const projectDir = slash >= 0 ? manifest.slice(0, slash) : "";
    const prefix = projectDir ? `${projectDir}/` : "";
    if (
      target.startsWith(`${prefix}pages/`) ||
      target.startsWith(`${prefix}media/`) ||
      target.startsWith(`${prefix}.qa-images/`)
    ) {
      return true;
    }
  }
  return false;
}

export function artifactVisibleForDisplay(
  filePath: string | undefined,
  policy: ModeArtifactPolicy | null | undefined,
  peerArtifactPaths?: readonly string[],
): boolean {
  if (policy?.unfiltered) return true;
  if (isCadScratchArtifact(filePath)) return false;
  if (isPptdProjectInternalArtifact(filePath, peerArtifactPaths)) return false;
  if (!policy) return true;
  const deny = normalizeArtifactExtensions(policy.deny);
  const allow = normalizeArtifactExtensions(policy.allow);
  if (!deny.length && !allow.length) return true;
  const ext = filePath ? extensionFromPath(filePath) : "";
  if (ext && deny.length && new Set(deny).has(ext)) return false;
  if (allow.length > 0) {
    if (!ext || !new Set(allow).has(ext)) return false;
  }
  return true;
}

/**
 * 判定是否拦截写入（不考虑 hard/soft；调用方对 soft 只做提示）。
 * 顺序：deny 优先 → allow 非空时仅白名单内放行。
 */
export function evaluateArtifactWrite(
  filePath: string,
  policy: ModeArtifactPolicy | null | undefined,
): ArtifactWriteDecision {
  if (!policy) return { block: false };
  const deny = normalizeArtifactExtensions(policy.deny);
  const allow = normalizeArtifactExtensions(policy.allow);
  if (!deny.length && !allow.length) return { block: false };

  const ext = extensionFromPath(filePath);
  if (ext && deny.length && new Set(deny).has(ext)) {
    return { block: true, reason: "deny", ext };
  }
  if (allow.length > 0) {
    if (!ext || !new Set(allow).has(ext)) {
      return { block: true, reason: "allow", ext: ext || "(无扩展名)" };
    }
  }
  return { block: false };
}

/** hard 模式下是否应拦截该路径写入 */
export function shouldBlockArtifactWrite(
  filePath: string,
  policy: ModeArtifactPolicy | null | undefined,
): boolean {
  if (!policy || policy.mode !== "hard") return false;
  return evaluateArtifactWrite(filePath, policy).block;
}

export function emptyArtifactPolicy(): ModeArtifactPolicy {
  return { mode: "hard", allow: [], deny: [] };
}

/**
 * 办公模式出厂产物黑名单（仅 deny，allow 空 = 不启用白名单）。
 * 各模式独立配置，不与 design/coding 共用一份名单。
 */
export const WORKING_ARTIFACT_DENY_DEFAULT: string[] = [
  "py",
  "pyw",
  "pyi",
  "ipynb",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "swift",
  "m",
  "mm",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "r",
  "lua",
  "pl",
  "pm",
  "vue",
  "svelte",
  "dart",
  "ex",
  "exs",
];

/** 办公模式出厂白名单默认空（不强制只允许 Office 扩展，避免过严） */
export const WORKING_ARTIFACT_ALLOW_DEFAULT: string[] = [];

/**
 * 设计模式出厂产物黑名单：仅本模式自有列表，与 working 独立维护。
 */
export const DESIGN_ARTIFACT_DENY_DEFAULT: string[] = [
  "py",
  "pyw",
  "pyi",
  "ipynb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "swift",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "r",
  "lua",
  "pl",
  "pm",
  "dart",
  "ex",
  "exs",
];

export const DESIGN_ARTIFACT_ALLOW_DEFAULT: string[] = [];

/** 代码开发：默认黑白名单皆空 */
export const CODING_ARTIFACT_DENY_DEFAULT: string[] = [];
export const CODING_ARTIFACT_ALLOW_DEFAULT: string[] = [];

export interface ModeSceneChip {
  label: string;
  prompt: string;
}

/**
 * 场景模式预设（Mode Preset）：Design Mode 下的「专业子模式」配置，不是 provider 本身。
 * 一个 preset 是一份场景配置：Prompt addon + SkillPolicy + McpPolicy（可后续扩模型/工具）。
 * 挂载在 ModePolicyDto.presets 上，随 policy.json 一起持久化（向后兼容：旧文件缺 presets 时回退出厂）。
 */
export interface ModePresetDto {
  /** Bot Tag selects tool presentation; both options run on Pi Durable. */
  botToolMode?: "native" | "codemode";
  /** 场景 preset id（如 web-prototype / general），与 provider 解耦 */
  id: string;
  label: string;
  description?: string;
  /** 附加到 system prompt 的场景职责说明（追加段，仅新会话生效） */
  promptAddon?: string;
  /** 技能策略收窄：与 base 合成（hide 并集 / allow 交集；空 allow = 不额外收窄） */
  skillPolicy?: ModeSkillPolicy;
  /** MCP 策略收窄：与 base 合成（deny 并集 / allow 交集；空 allow = 不额外收窄） */
  mcpPolicy?: ModeMcpPolicy;
  /** 本 preset 绑定的专用设计 provider MCP id（UI 可用性判断；general 为空数组） */
  providerMcpIds?: string[];
  /**
   * 本 preset 要求的受管 runtime（managed provider id，如 freecad/blender）：
   * 选择/激活该 preset 时 best-effort prewarm（启动桌面软件 + 连接 MCP，无业务副作用）；
   * 用户真正发送任务前做 required-runtime preflight gate（未 ready 先 ensureReady，
   * 失败则任务开始前明确失败）。声明式配置，机制可复用于任意 managed provider。
   * 支持旧 string（仅 providerId，策略用 provider 默认）与结构化 RuntimeRequirement
   * （launchPolicy/readinessPolicy/openUi 字段级覆盖；见 shared/runtime-requirement）。
   */
  requiredRuntimes?: RuntimeRequirementInput[];
  /** 预设偏好模型 id（可选；合成时优先级高于 base suggestedModelId） */
  suggestedModelId?: string | null;
  /** 预设建议权限（可选；合成时优先级高于 base suggestedPermissionMode，低于用户显式选择） */
  suggestedPermissionMode?: "default" | "readonly" | "auto" | null;
  /** 预设推荐专家（可选；与 base recommendedExpertIds 去重合并，base 在前） */
  recommendedExpertIds?: string[];
  /** Optional hard candidate gate; Task selection is still the actual Expert choice. */
  expertPolicy?: import("./project-domain").ProjectSelectionPolicyDto;
  /** Optional hard candidate gate for Task-active connectors. */
  connectorPolicy?: import("./project-domain").ProjectSelectionPolicyDto;
}

/**
 * 集中式：全部「设计专用 provider」MCP id。
 * 用于 general preset 的排除合成与 UI 可用性判断；避免 if/else 散落多处。
 * 注意：不迁移用户 mcp.json，只作为 metadata/兼容 fallback。
 * blender 已从受管 runtime 下线，但仍可作为 Hub 已装的普通 MCP 插件使用，
 * 因此不进本名单——否则 general 出厂 deny 会把已装 blender 从设计会话里踢掉。
 */
export const DESIGN_PROVIDER_MCP_IDS = [
  "ardot-local",
  "penpot",
  "canva",
  "freecad",
  "opendesign",
] as const;

/**
 * 集中式：全部「办公 managed provider」MCP id（当前仅 Draw.io AI）。
 * 用于非流程图办公 tag 的排除合成（deny 并集）
 * 与 UI 可用性判断；与 DESIGN_PROVIDER_MCP_IDS 同构。
 */
export const OFFICE_PROVIDER_MCP_IDS = ["drawio-ai"] as const;

/**
 * 各模式出厂默认 preset id（集中式，禁止 UI/store 各自硬编码）。
 * working = 通用办公（default）；coding / design 固定。
 */
export const MODE_DEFAULT_PRESET_IDS: Record<WelcomeMode, string> = {
  working: "general-office",
  coding: "minimal",
  bot: "native",
};

/**
 * 已退出厂的 preset id：旧任务 resolve 回落到该模式默认；
 * 读盘时从欢迎页 tag 列表剔除（见 ModeProfileStore）。
 */
export const RETIRED_MODE_PRESET_IDS: Record<WelcomeMode, readonly string[]> = {
  working: ["inventory-summary", "documents", "spreadsheets", "presentations"],
  coding: [],
  bot: ["general", "web-prototype"],
};

export function isRetiredModePresetId(
  mode: WelcomeMode,
  presetId: string | null | undefined,
): boolean {
  return presetId != null && RETIRED_MODE_PRESET_IDS[mode].includes(presetId);
}

/** 各模式出厂 preset id 清单（测试/防御性校验用；用户自定义 preset 不在其中） */
export const MODE_SEED_PRESET_IDS: Record<WelcomeMode, string[]> = {
  working: [
    "general-office",
    "summary",
    "weekly-report",
    "meeting-notes",
    "project-management",
    "data-analysis",
    "drawio-ai",
    "web-prototype",
  ],
  coding: [
    "minimal",
    "bugfix-test",
    "feature-dev",
    "refactor",
    "add-tests",
    "code-review",
    "plan-design",
    "readonly-explain",
  ],
  bot: ["native", "codemode"],
};

/** 去掉已退役 Tag，并把出厂 seed 按 MODE_SEED_PRESET_IDS 排到对应位置。 */
export function sanitizeModePresets<T extends { id: string }>(mode: WelcomeMode, presets: T[]): T[] {
  const visible = presets.filter((preset) => !isRetiredModePresetId(mode, preset.id));
  const order = MODE_SEED_PRESET_IDS[mode];
  const seedIds = new Set(order);
  const present = new Map(visible.filter((preset) => seedIds.has(preset.id)).map((preset) => [preset.id, preset]));
  let flushed = false;
  const out: T[] = [];
  for (const preset of visible) {
    if (!seedIds.has(preset.id)) {
      out.push(preset);
      continue;
    }
    if (flushed) continue;
    flushed = true;
    for (const id of order) {
      const seed = present.get(id);
      if (seed) out.push(seed);
    }
  }
  if (mode === "coding") {
    const minimalIndex = out.findIndex((preset) => preset.id === "minimal");
    if (minimalIndex > 0) {
      const [minimal] = out.splice(minimalIndex, 1);
      out.unshift(minimal);
    }
  }
  return out;
}

/** 目标模式默认 preset id（切换顶层模式 / 新建任务时取此值，保证合法） */
export function defaultModePresetId(mode: WelcomeMode): string {
  return MODE_DEFAULT_PRESET_IDS[mode];
}

/** presetId 是否为目标模式的出厂合法 id（含空值处理） */
export function isKnownModePresetId(
  mode: WelcomeMode,
  presetId: string | null | undefined,
): boolean {
  return presetId != null && MODE_SEED_PRESET_IDS[mode].includes(presetId);
}

/**
 * 把任意 presetId 归一化为目标模式的合法值：
 * - 已知合法 → 原样返回
 * - null/未知（防御）→ 目标模式默认
 */
export function resolveModePresetId(
  mode: WelcomeMode,
  presetId: string | null | undefined,
): string {
  if (presetId != null && MODE_SEED_PRESET_IDS[mode].includes(presetId)) return presetId;
  return defaultModePresetId(mode);
}

export interface ModePolicyDto {
  skillPolicy: ModeSkillPolicy;
  toolPolicy: ModeToolPolicy;
  mcpPolicy: ModeMcpPolicy;
  /**
   * 产物扩展名黑名单（按场景拦截不宜交付的文件类型）。
   * 缺省字段在 normalize 时回填 emptyArtifactPolicy()；出厂种子见 mode-defaults。
   */
  artifactPolicy: ModeArtifactPolicy;
  suggestedModelId?: string | null;
  suggestedPermissionMode?: "default" | "readonly" | "auto" | null;
  recommendedExpertIds: string[];
  expertPolicy?: import("./project-domain").ProjectSelectionPolicyDto;
  connectorPolicy?: import("./project-domain").ProjectSelectionPolicyDto;
  scenes: ModeSceneChip[];
  /** 场景预设列表（仅 design 模式出厂内置；其它模式为空数组） */
  presets?: ModePresetDto[];
}

export interface ModeBlockDto {
  id: ModeBlockId;
  label: string;
  content: string;
  /** seed = 与出厂一致；user = 相对出厂有改动 */
  source: "seed" | "user";
  chars: number;
  /** 磁盘文案路径（~/.mybuddy/modes/<id>/<block>.md） */
  filePath: string;
}

export interface ModeProfileDto {
  id: WelcomeMode;
  labelZh: string;
  version: string;
  blocks: ModeBlockDto[];
  policy: ModePolicyDto;
  /** 是否存在任意用户覆盖 */
  hasUserOverride: boolean;
  /** 全部 mode 相关块合计字符 */
  totalChars: number;
  /** 本模式目录 ~/.mybuddy/modes/<id>/ */
  userDir: string;
  /** 策略文件路径 policy.json */
  policyPath: string;
}

export interface ModeProfileSummaryDto {
  id: WelcomeMode;
  labelZh: string;
  hasUserOverride: boolean;
  totalChars: number;
  version: string;
}

export function emptyModePolicy(): ModePolicyDto {
  return {
    skillPolicy: { prefer: [], demote: [], hide: [], allow: [] },
    toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
    mcpPolicy: { mode: "hard", allow: [], deny: [] },
    artifactPolicy: emptyArtifactPolicy(),
    suggestedModelId: null,
    suggestedPermissionMode: null,
    recommendedExpertIds: [],
    scenes: [],
    presets: [],
  };
}

/** Bot presets supply configuration and prose only; they never restrict execution or display. */
export function botConfiguration(policy: ModePolicyDto): ModePolicyDto {
  return {
    ...emptyModePolicy(),
    artifactPolicy: { mode: "soft", allow: [], deny: [], unfiltered: true },
    suggestedModelId: policy.suggestedModelId,
    recommendedExpertIds: policy.recommendedExpertIds,
    scenes: policy.scenes,
    presets: policy.presets?.map(preset => ({
      id: preset.id, label: preset.label, description: preset.description,
      promptAddon: preset.promptAddon, suggestedModelId: preset.suggestedModelId,
      recommendedExpertIds: preset.recommendedExpertIds,
      botToolMode: preset.botToolMode ?? (preset.id === "codemode" ? "codemode" : "native"),
    })),
  };
}

/* ------------------------- Mode Preset 纯函数合成 ------------------------- */

/** 列表去重合并（preset 不能通过覆盖移除 base 的项，只能叠加） */
function unionLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * 收窄合成（核心规则）：
 * - deny：base ∪ preset（并集，任何一侧禁用的都禁）
 * - allow：preset.allow 非空时，在 base.allow 范围内取交集；base.allow 为空（= 不启用白名单）时直接取 preset.allow
 *   （base 已白名单时 preset 不能越权扩大到 base 之外的工具）
 * - 交集为空时：保持白名单激活但无可放行项——allow 保留 base.allow，deny 追加 base.allow，
 *   避免 allow=[] 被 filter 理解为「白名单未启用」而扩大（filter 语义：空 allow = 不限制）
 * - mode：任一侧 hard 即 hard（preset 不能把 base 的硬隔离变软）
 */
export interface EffectiveModePolicy {
  skillPolicy: ModeSkillPolicy;
  mcpPolicy: ModeMcpPolicy;
  /** 合成后的提示词附加段（preset.promptAddon；无 preset = null） */
  promptAddon: string | null;
  suggestedModelId: string | null;
  /** 合成后的建议权限（preset ?? base；无 = null） */
  suggestedPermissionMode: "default" | "readonly" | "auto" | null;
  /** 合成后的推荐专家（base ∪ preset，去重保序；无 preset = base 原样） */
  recommendedExpertIds: string[];
}

/** 从 policy.presets 中按 id 取 preset；未知 id / 未配置 → undefined（回落 base，不静默切别的 preset） */
export function resolveModePreset(
  policy: Pick<ModePolicyDto, "presets">,
  presetId?: string | null,
): ModePresetDto | undefined {
  if (!presetId) return undefined;
  const presets = policy.presets ?? [];
  return presets.find((p) => p.id === presetId);
}

/**
 * 合成 base ModePolicy 与选中 preset 的 effective policy（纯函数）。
 * 无 preset / 未知 preset → 原样返回 base（working/coding 等无 preset 模式行为不变）。
 * 合成永远是「收窄」：preset 不能越过 base 的 deny / allow。
 */
export function resolveEffectiveModePolicy(
  base: ModePolicyDto,
  preset?: ModePresetDto | null,
): EffectiveModePolicy {
  if (!preset) {
    return {
      skillPolicy: base.skillPolicy,
      mcpPolicy: base.mcpPolicy,
      promptAddon: null,
      suggestedModelId: base.suggestedModelId ?? null,
      suggestedPermissionMode: base.suggestedPermissionMode ?? null,
      recommendedExpertIds: [...base.recommendedExpertIds],
    };
  }
  return {
    skillPolicy: composeSkillPolicies(base.skillPolicy, preset.skillPolicy ?? emptySkillPolicy()),
    mcpPolicy: composeMcpPolicies(base.mcpPolicy, preset.mcpPolicy ?? emptyMcpPolicy()),
    promptAddon: preset.promptAddon?.trim() || null,
    suggestedModelId: preset.suggestedModelId ?? base.suggestedModelId ?? null,
    suggestedPermissionMode: preset.suggestedPermissionMode ?? base.suggestedPermissionMode ?? null,
    recommendedExpertIds: unionLists(base.recommendedExpertIds, preset.recommendedExpertIds ?? []),
  };
}

/** 合成后的 effective policy 替换回 profile（createSession / assemblePreview 直接消费 profile.policy） */
export function withEffectiveModePolicy(
  profile: ModeProfileDto,
  effective: EffectiveModePolicy,
): ModeProfileDto {
  return {
    ...profile,
    policy: {
      ...profile.policy,
      skillPolicy: effective.skillPolicy,
      mcpPolicy: effective.mcpPolicy,
      suggestedModelId: effective.suggestedModelId ?? profile.policy.suggestedModelId ?? null,
      suggestedPermissionMode:
        effective.suggestedPermissionMode ?? profile.policy.suggestedPermissionMode ?? null,
      recommendedExpertIds: effective.recommendedExpertIds,
    },
  };
}

/* -------------------- 运行时建议值优先级（纯函数，可单测） -------------------- */

/**
 * 会话权限解析：用户/调用方显式 > Tag/Preset 建议 > Mode/base 建议 > 系统默认。
 * 建议值只做“抬升约束”的兜底，绝不覆盖显式选择。
 */
export function resolveEffectivePermission(
  explicit: "default" | "readonly" | "auto" | null | undefined,
  suggested: "default" | "readonly" | "auto" | null | undefined,
  systemDefault: "default" | "readonly" | "auto",
): "default" | "readonly" | "auto" {
  return explicit ?? suggested ?? systemDefault;
}

/**
 * 会话模型解析：显式 > Tag/Preset 建议（须可用）> 系统默认（须可用）> undefined。
 * 建议/系统默认无效时安全降级：不阻塞会话创建。
 * systemDefault 应对齐 UI 全局默认（settings.defaultModelId），不要回落到 pi 的
 * settings.defaultModel——两套字段会漂移，导致界面显示 A、会话实际跑 B，用量只记 B。
 */
export function resolveEffectiveModelId(
  explicit: string | null | undefined,
  suggested: string | null | undefined,
  isAvailable: (modelId: string) => boolean,
  systemDefault?: string | null,
): string | undefined {
  if (explicit) return explicit;
  if (suggested && isAvailable(suggested)) return suggested;
  if (systemDefault && isAvailable(systemDefault)) return systemDefault;
  return undefined;
}

/** 把 `provider/model` 拆开；无斜杠或不完整则 null。 */
export function splitProviderModelId(
  modelId: string | null | undefined,
): { provider: string; model: string } | null {
  const trimmed = modelId?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function emptySkillPolicy(): ModeSkillPolicy {
  return { prefer: [], demote: [], hide: [], allow: [] };
}

function emptyMcpPolicy(): ModeMcpPolicy {
  return { mode: "hard", allow: [], deny: [] };
}

/** 装配检视：每一段的来源与内容（调试 / 预览） */
export interface AssemblySegmentDto {
  id: string;
  title: string;
  source: "seed" | "user" | "runtime" | "project" | "tag" | "expert" | "skill" | "db" | "extra";
  /** Stable source identity for explainability (for example proj_xxx or preset id). */
  sourceId?: string;
  chars: number;
  content: string;
}

export interface AssemblySkillFilterDto {
  prefer: string[];
  demote: string[];
  hide: string[];
  allow: string[];
  visible: string[];
  demoted: string[];
  hidden: string[];
}

export interface AssemblyMcpFilterDto {
  enabled: string[];
  hidden: string[];
  reasons: Record<string, string>;
  policyMode: "soft" | "hard";
}

export interface AssemblyTraceDto {
  welcomeMode: WelcomeMode;
  segments: AssemblySegmentDto[];
  skillFilter: AssemblySkillFilterDto;
  toolPolicy: ModeToolPolicy;
  mcpPolicy: ModeMcpPolicy;
  mcpFilter: AssemblyMcpFilterDto;
  /** Per-capability decisions with source and stable denial reason. */
  capabilities?: import("./runtime-policy").ResolvedCapabilityDto[];
  artifactPolicy: ModeArtifactPolicy;
  totalChars: number;
  /** Effective MyBuddy system-context budget after priority trimming. */
  contextBudget?: {
    limitChars: number;
    rawChars: number;
    usedChars: number;
    truncatedSegmentIds: string[];
  };
  warnings: string[];
  effectiveAt: "new_session_only";
  /** 可直接作为 appendSystemPrompt 的字符串列表 */
  appendParts: string[];
}
