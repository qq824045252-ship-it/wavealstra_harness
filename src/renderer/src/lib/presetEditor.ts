/**
 * Mode Preset（Tag）编辑器纯逻辑：UI 与测试共用。
 * ModesTab 的可视化 Tag 编辑、HubPage 回读、单测全部消费这里，
 * 避免各页面重新发明序列化/归一化规则。
 */
import type {
  ModeArtifactPolicy,
  ModeMcpPolicy,
  ModePolicyDto,
  ModePresetDto,
  ModeSkillPolicy,
  WelcomeMode,
} from "@shared/mode-profile";
import { MODE_SEED_PRESET_IDS, normalizeArtifactExtensions } from "@shared/mode-profile";

/** 建议权限合法枚举（与 ModePresetDto.suggestedPermissionMode 一致） */
export const PERMISSION_MODES = ["default", "readonly", "auto"] as const;
export type PermissionModeValue = (typeof PERMISSION_MODES)[number];

export const PERMISSION_OPTIONS: ReadonlyArray<{
  value: PermissionModeValue | null;
  label: string;
  hint: string;
}> = [
  { value: null, label: "无建议（继承 Mode）", hint: "不推荐权限，会话按用户显式选择 / Mode 默认" },
  { value: "default", label: "default", hint: "标准权限：写操作需确认" },
  { value: "readonly", label: "readonly", hint: "只读：禁写文件/编辑/终端（可被用户显式覆盖）" },
  { value: "auto", label: "auto", hint: "自动审批低风险工具" },
];

export function permissionLabel(value: string | null | undefined): string {
  const opt = PERMISSION_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? "无建议（继承 Mode）";
}

/* ---------------- 序列化 / 归一化（保存前清洗） ---------------- */

function strList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String).map((s) => s.trim()).filter(Boolean);
}

function optString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s || null;
}

/** 单条 preset 归一化：非法值回退（与主进程 ModeProfileStore.normalizePresets 语义一致） */
export function normalizePresetDraft(raw: Partial<ModePresetDto> | undefined): ModePresetDto {
  const id = optString(raw?.id) ?? "";
  const label = optString(raw?.label) ?? "";
  return {
    id,
    label,
    description: optString(raw?.description) ?? undefined,
    promptAddon: optString(raw?.promptAddon) ?? undefined,
    durableToolMode: raw?.durableToolMode === "codemode" ? "codemode" : raw?.durableToolMode === "native" ? "native" : undefined,
    providerMcpIds: strList(raw?.providerMcpIds),
    suggestedModelId: optString(raw?.suggestedModelId),
    suggestedPermissionMode: PERMISSION_MODES.includes(
      raw?.suggestedPermissionMode as PermissionModeValue,
    )
      ? (raw!.suggestedPermissionMode as PermissionModeValue)
      : null,
    recommendedExpertIds: strList(raw?.recommendedExpertIds),
    skillPolicy: raw?.skillPolicy ? normalizeSkillPolicy(raw.skillPolicy) : undefined,
    mcpPolicy: raw?.mcpPolicy ? normalizeMcpPolicy(raw.mcpPolicy) : undefined,
  };
}

export function normalizeSkillPolicy(raw: Partial<ModeSkillPolicy> | undefined): ModeSkillPolicy {
  return {
    prefer: strList(raw?.prefer),
    demote: strList(raw?.demote),
    hide: strList(raw?.hide),
    allow: strList(raw?.allow),
  };
}

export function normalizeMcpPolicy(raw: Partial<ModeMcpPolicy> | undefined): ModeMcpPolicy {
  return {
    mode: raw?.mode === "soft" ? "soft" : "hard",
    allow: strList(raw?.allow),
    deny: strList(raw?.deny),
  };
}

export function normalizeArtifactPolicy(
  raw: Partial<ModeArtifactPolicy> | undefined,
): ModeArtifactPolicy {
  const deny = normalizeArtifactExtensions(strList(raw?.deny));
  const denySet = new Set(deny);
  // 与主进程一致：deny 优先，同名扩展从 allow 剔除
  const allow = normalizeArtifactExtensions(strList(raw?.allow)).filter((e) => !denySet.has(e));
  return {
    mode: raw?.mode === "soft" ? "soft" : "hard",
    allow,
    deny,
  };
}

/** preset 是否可保存（id 与 label 非空） */
export function isPresetDraftValid(draft: ModePresetDto): boolean {
  return Boolean(draft.id.trim() && draft.label.trim());
}

/** 出厂（seed）预设不可删除：读时会被 ModeProfileStore 合并还原，删除只会造成“假删除” */
export function isSeedPreset(mode: WelcomeMode, presetId: string): boolean {
  return MODE_SEED_PRESET_IDS[mode].includes(presetId);
}

/** 列表操作（新增 / 更新 / 删除） ---------------- */

/** 按 id 替换或追加（保序）；返回新数组 */
export function upsertPreset(presets: ModePresetDto[], draft: ModePresetDto): ModePresetDto[] {
  const next = normalizePresetDraft(draft);
  const idx = presets.findIndex((p) => p.id === next.id);
  if (idx >= 0) {
    const out = [...presets];
    out[idx] = next;
    return out;
  }
  return [...presets, next];
}

export function removePreset(presets: ModePresetDto[], id: string): ModePresetDto[] {
  return presets.filter((p) => p.id !== id);
}

/** 把（已编辑的）preset 列表写回 policy（仅改 presets 字段，其余 base 字段原样） */
export function applyPresetsToPolicy(policy: ModePolicyDto, presets: ModePresetDto[]): ModePolicyDto {
  return {
    ...policy,
    presets: presets.map((p) => normalizePresetDraft(p)).filter((p) => p.id && p.label),
  };
}

/** 从 label 生成新 preset 的默认 id（slug；冲突时追加序号） */
export function suggestPresetId(label: string, presets: ModePresetDto[]): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom";
  const ids = new Set(presets.map((p) => p.id));
  if (!ids.has(base)) return base;
  let i = 2;
  while (ids.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/* ---------------- 模型建议选项（可用 / 已缺失） ---------------- */

export interface ModelSuggestionOption {
  /** 空字符串 = 无建议（null） */
  value: string;
  label: string;
  missing: boolean;
}

/** 建议模型下拉选项：无建议 + 模型列表；已配置但列表缺失的模型以「已缺失」呈现 */
export function buildModelSuggestionOptions(
  suggested: string | null | undefined,
  models: Array<{ id: string; name?: string }>,
): ModelSuggestionOption[] {
  const options: ModelSuggestionOption[] = [
    { value: "", label: "无建议（跟随默认）", missing: false },
  ];
  const known = new Set(models.map((m) => m.id));
  for (const m of models) {
    options.push({ value: m.id, label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id, missing: false });
  }
  if (suggested && !known.has(suggested)) {
    options.push({ value: suggested, label: `已缺失：${suggested}（已卸载/未配置）`, missing: true });
  }
  return options;
}

/** 建议模型是否可用（在模型列表中） */
export function isModelSuggestionAvailable(
  suggested: string | null | undefined,
  models: Array<{ id: string }>,
): boolean {
  if (!suggested) return false;
  return models.some((m) => m.id === suggested);
}
