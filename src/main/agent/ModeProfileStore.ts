import previousModeBlocks from "./previous-mode-blocks.json";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { shell } from "electron";
import {
  MODE_BLOCK_IDS,
  MODE_BLOCK_LABELS,
  RETIRED_MODE_PRESET_IDS,
  sanitizeModePresets,
  WELCOME_MODE_LABELS,
  WELCOME_MODES,
  emptyArtifactPolicy,
  emptyModePolicy,
  generalModeConfiguration,
  normalizeArtifactExtensions,
  type ModeArtifactPolicy,
  type ModeBlockId,
  type ModeMcpPolicy,
  type ModePolicyDto,
  type ModePresetDto,
  type ModeProfileDto,
  type ModeProfileSummaryDto,
  type ModeSceneChip,
  type ModeSkillPolicy,
  type WelcomeMode,
} from "../../shared/mode-profile";
import {
  RUNTIME_LAUNCH_POLICIES,
  RUNTIME_OPEN_UI_POLICIES,
  RUNTIME_READINESS_POLICIES,
  type RuntimeRequirementInput,
} from "../../shared/runtime-requirement";
import { getModesDir } from "../paths";
import { MODE_SEEDS, PENPOT_PRESET } from "./mode-defaults";

function isWelcomeMode(id: string): id is WelcomeMode {
  return (WELCOME_MODES as string[]).includes(id);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeText(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n", "utf-8");
}

function normalizeSkillPolicy(raw: unknown): ModeSkillPolicy {
  const s = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  return { prefer: arr(s.prefer), demote: arr(s.demote), hide: arr(s.hide), allow: arr(s.allow) };
}

function normalizeMcpPolicy(raw: unknown): ModeMcpPolicy {
  const m = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  return {
    mode: m.mode === "soft" ? "soft" : "hard",
    allow: arr(m.allow),
    deny: arr(m.deny),
  };
}

function normalizeSelectionPolicy(
  raw: unknown,
): import("../../shared/project-domain").ProjectSelectionPolicyDto | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const arr = (input: unknown): string[] =>
    Array.isArray(input) ? input.map(String).map((item) => item.trim()).filter(Boolean) : [];
  return { allow: arr(value.allow), deny: arr(value.deny), recommended: arr(value.recommended) };
}

function normalizeArtifactPolicy(raw: unknown): ModeArtifactPolicy {
  if (!raw || typeof raw !== "object") return emptyArtifactPolicy();
  const m = raw as Record<string, unknown>;
  // 白名单与黑名单互斥：同一扩展名不可同时出现在两侧（以 deny 优先剔除 allow）
  const deny = normalizeArtifactExtensions(Array.isArray(m.deny) ? m.deny.map(String) : []);
  const denySet = new Set(deny);
  const allow = normalizeArtifactExtensions(Array.isArray(m.allow) ? m.allow.map(String) : []).filter(
    (e) => !denySet.has(e),
  );
  return {
    mode: m.mode === "soft" ? "soft" : "hard",
    allow,
    deny,
  };
}

/**
 * requiredRuntimes 归一化：兼容旧 string 与结构化 RuntimeRequirement 声明。
 * - string → 原样保留（运行时经 shared/runtime-requirement 默认策略解析）；
 * - 对象 → 保留 providerId 与合法枚举字段（非法枚举丢弃，运行时回落默认）；
 * - 非法项 / 空结果 → undefined（= 未声明，字段级回补逻辑不受影响）。
 */
function normalizeRuntimeRequirements(raw: unknown): RuntimeRequirementInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RuntimeRequirementInput[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const value = item.trim();
      if (value) out.push(value);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const providerId = typeof o.providerId === "string" ? o.providerId.trim() : "";
    if (!providerId) continue;
    const entry: Record<string, unknown> = { providerId };
    if (typeof o.launchPolicy === "string" && (RUNTIME_LAUNCH_POLICIES as readonly string[]).includes(o.launchPolicy)) {
      entry.launchPolicy = o.launchPolicy;
    }
    if (
      typeof o.readinessPolicy === "string" &&
      (RUNTIME_READINESS_POLICIES as readonly string[]).includes(o.readinessPolicy)
    ) {
      entry.readinessPolicy = o.readinessPolicy;
    }
    if (typeof o.openUi === "string" && (RUNTIME_OPEN_UI_POLICIES as readonly string[]).includes(o.openUi)) {
      entry.openUi = o.openUi;
    }
    if (typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) {
      entry.timeoutMs = Math.round(o.timeoutMs);
    }
    out.push(entry as RuntimeRequirementInput);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 该模式出厂 preset skillPolicy.allow 的并集（工厂技能白名单，去重保序）。
 * seed preset 是出厂能力声明；用户 base allow 已启用白名单时，这些工厂技能应始终
 * 能被子集 preset 收窄命中（base ∩ preset 不为空），旧配置迁移机器由此自动获得
 * 新出厂技能（如 3d-blender 的 blender-*）——只补缺失，绝不删除/覆盖用户条目。
 */
export function factorySkillAllowForMode(mode: WelcomeMode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const preset of MODE_SEEDS[mode].policy.presets ?? []) {
    for (const name of preset.skillPolicy?.allow ?? []) {
      const key = name.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function normalizePresets(raw: unknown, seedPresets?: ModePresetDto[]): ModePresetDto[] {
  // 向后兼容：旧 policy.json 无 presets 字段 → 回退出厂预设（base 策略仍用用户覆盖）
  if (!Array.isArray(raw)) return seedPresets ?? [];
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  return raw
    .map((p): ModePresetDto | null => {
      if (!p || typeof p !== "object") return null;
      const item = p as Record<string, unknown>;
      const id = String(item.id ?? "").trim();
      const label = String(item.label ?? "").trim();
      if (!id || !label) return null;
      const providerMcpIds = arr(item.providerMcpIds);
      return {
        id,
        label,
        durableToolMode: item.durableToolMode === "codemode" ? "codemode" : item.durableToolMode === "native" ? "native" : undefined,
        description:
          item.description === undefined || item.description === null
            ? undefined
            : String(item.description),
        promptAddon:
          item.promptAddon === undefined || item.promptAddon === null
            ? undefined
            : String(item.promptAddon),
        skillPolicy:
          item.skillPolicy === undefined || item.skillPolicy === null
            ? undefined
            : normalizeSkillPolicy(item.skillPolicy),
        mcpPolicy:
          item.mcpPolicy === undefined || item.mcpPolicy === null
            ? undefined
            : normalizeMcpPolicy(item.mcpPolicy),
        providerMcpIds: providerMcpIds.length ? providerMcpIds : undefined,
        requiredRuntimes: normalizeRuntimeRequirements(item.requiredRuntimes),
        suggestedModelId:
          item.suggestedModelId === null || item.suggestedModelId === undefined
            ? null
            : String(item.suggestedModelId),
        suggestedPermissionMode:
          item.suggestedPermissionMode === "default" ||
          item.suggestedPermissionMode === "readonly" ||
          item.suggestedPermissionMode === "auto"
            ? item.suggestedPermissionMode
            : null,
        recommendedExpertIds: arr(item.recommendedExpertIds),
        expertPolicy: normalizeSelectionPolicy(item.expertPolicy),
        connectorPolicy: normalizeSelectionPolicy(item.connectorPolicy),
      };
    })
    .filter((x): x is ModePresetDto => x != null);
}

function normalizeScenes(raw: unknown): ModeSceneChip[] {
  const scenesRaw = Array.isArray(raw) ? raw : [];
  return scenesRaw
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const item = s as Record<string, unknown>;
      const label = String(item.label ?? "").trim();
      const prompt = String(item.prompt ?? "").trim();
      if (!label || !prompt) return null;
      return { label, prompt };
    })
    .filter((x): x is ModeSceneChip => x != null);
}

function scenesEqual(a: ModeSceneChip[], b: ModeSceneChip[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 旧 policy 的用户自定义 scenes → 运行时 promptAddon-only legacy presets（保留用户 tag） */
function legacyPresetsFromScenes(scenes: ModeSceneChip[]): ModePresetDto[] {
  return scenes.map((s, i) => ({
    id: `legacy-scene-${i + 1}`,
    label: s.label,
    description: "由原有场景芯片自动转换",
    promptAddon: s.prompt,
  }));
}

function normalizePolicy(raw: unknown, seedPresets?: ModePresetDto[]): ModePolicyDto {
  const base = emptyModePolicy();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const skill = (o.skillPolicy ?? {}) as Record<string, unknown>;
  const tool = (o.toolPolicy ?? {}) as Record<string, unknown>;
  const mcp = (o.mcpPolicy ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const scenes = normalizeScenes(o.scenes);

  const toolMode = tool.mode === "hard" ? "hard" : "soft";
  const mcpMode = mcp.mode === "soft" ? "soft" : "hard";
  return {
    skillPolicy: {
      prefer: arr(skill.prefer),
      demote: arr(skill.demote),
      hide: arr(skill.hide),
      allow: arr(skill.allow),
    },
    toolPolicy: {
      mode: toolMode,
      prefer: arr(tool.prefer),
      demote: arr(tool.demote),
      deny: arr(tool.deny),
    },
    mcpPolicy: {
      mode: mcpMode,
      allow: arr(mcp.allow),
      deny: arr(mcp.deny),
    },
    artifactPolicy: normalizeArtifactPolicy(o.artifactPolicy),
    suggestedModelId:
      o.suggestedModelId === null || o.suggestedModelId === undefined
        ? null
        : String(o.suggestedModelId),
    suggestedPermissionMode:
      o.suggestedPermissionMode === "default" ||
      o.suggestedPermissionMode === "readonly" ||
      o.suggestedPermissionMode === "auto"
        ? o.suggestedPermissionMode
        : null,
    recommendedExpertIds: arr(o.recommendedExpertIds),
    expertPolicy: normalizeSelectionPolicy(o.expertPolicy),
    connectorPolicy: normalizeSelectionPolicy(o.connectorPolicy),
    scenes,
    presets: normalizePresets(o.presets, seedPresets),
  };
}

function validatePolicy(policy: ModePolicyDto): string | null {
  if (policy.toolPolicy.mode !== "soft" && policy.toolPolicy.mode !== "hard") {
    return "toolPolicy.mode 必须是 soft 或 hard";
  }
  if (policy.mcpPolicy.mode !== "soft" && policy.mcpPolicy.mode !== "hard") {
    return "mcpPolicy.mode 必须是 soft 或 hard";
  }
  if (policy.artifactPolicy.mode !== "soft" && policy.artifactPolicy.mode !== "hard") {
    return "artifactPolicy.mode 必须是 soft 或 hard";
  }
  const artExtOk = (ext: string): boolean => /^[a-z0-9][a-z0-9.+_-]{0,31}$/i.test(ext);
  for (const ext of policy.artifactPolicy.deny) {
    if (!artExtOk(ext)) return `artifactPolicy.deny 含非法扩展名: ${ext}`;
  }
  for (const ext of policy.artifactPolicy.allow) {
    if (!artExtOk(ext)) return `artifactPolicy.allow 含非法扩展名: ${ext}`;
  }
  for (const scene of policy.scenes) {
    if (!scene.label.trim() || !scene.prompt.trim()) {
      return "scenes 中每项需要非空 label 与 prompt";
    }
  }
  const presetIds = new Set<string>();
  for (const preset of policy.presets ?? []) {
    if (!preset.id.trim() || !preset.label.trim()) {
      return "presets 中每项需要非空 id 与 label";
    }
    if (presetIds.has(preset.id)) {
      return `presets 中存在重复 id: ${preset.id}`;
    }
    presetIds.add(preset.id);
    if (preset.mcpPolicy && preset.mcpPolicy.mode !== "soft" && preset.mcpPolicy.mode !== "hard") {
      return `preset ${preset.id} 的 mcpPolicy.mode 必须是 soft 或 hard`;
    }
  }
  return null;
}

function normText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
}

function policiesEqual(a: ModePolicyDto, b: ModePolicyDto): boolean {
  return JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b));
}

/**
 * 场景模式资料：出厂种子会物化到磁盘，便于用户直接打开编辑。
 * 路径：~/.mybuddy/modes/<id>/{goal,workflow,delivery,forbid,criteria}.md + policy.json
 * source：磁盘内容与出厂一致 → seed；有改动 → user
 */
export class ModeProfileStore {
  private penpotPreset(current?: ModePresetDto): ModePresetDto {
    let preset = { ...PENPOT_PRESET };
    // Read the legacy general/policy original before the mode strips execution metadata. Working edits win.
    for (const source of ["general"]) {
      const raw = readText(join(getModesDir(), source, "policy.json"));
      if (!raw) continue;
      try {
        const prior = normalizePresets(JSON.parse(raw).presets).find(item => item.id === PENPOT_PRESET.id);
        if (prior) preset = { ...preset, ...Object.fromEntries(Object.entries(prior).filter(([, value]) => value !== undefined && value !== null)) };
      } catch { /* Invalid legacy files do not block the working preset. */ }
    }
    if (current) preset = { ...preset, ...Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined)) };
    return { ...preset, label: "Penpot", durableToolMode: undefined,
      promptAddon: preset.promptAddon?.replaceAll("网页原型 · Penpot", "Penpot"),
    };
  }

  private modeDir(id: WelcomeMode): string {
    return join(getModesDir(), id);
  }

  private blockPath(id: WelcomeMode, blockId: ModeBlockId): string {
    return join(this.modeDir(id), `${blockId}.md`);
  }

  private policyFilePath(id: WelcomeMode): string {
    return join(this.modeDir(id), "policy.json");
  }

  /**
   * One-way migration for the retired "bot" mode id: modes/bot -> modes/general.
   * If both exist, copy files missing from the target and move the old directory
   * aside; never delete user-edited prompts.
   */
  private migrateLegacyModeDirs(): void {
    const root = getModesDir();
    const legacy = join(root, "bot");
    const target = join(root, "general");
    if (!existsSync(legacy)) return;
    try {
      if (!existsSync(target)) {
        renameSync(legacy, target);
        return;
      }
      for (const entry of readdirSync(legacy, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const to = join(target, entry.name);
        if (!existsSync(to)) copyFileSync(join(legacy, entry.name), to);
      }
      renameSync(legacy, join(root, `general.legacy-${Date.now()}`));
    } catch (error) {
      console.warn("[ModeProfile] legacy bot mode directory migration failed", error);
    }
  }

  /** Keep the generated general README label in sync with the migrated directory name. */
  private migrateLegacyReadme(): void {
    const path = join(this.modeDir("general"), "README.md");
    const text = readText(path);
    if (!text?.startsWith("# Bot（bot）")) return;
    writeText(path, text.replace(/^# Bot（bot）/, "# 通用模式（general）"));
  }

  /** Rewrite the retired botToolMode preset key to durableToolMode without touching other fields. */
  private migrateLegacyPolicyKeys(): void {
    for (const mid of WELCOME_MODES) {
      const path = this.policyFilePath(mid);
      if (!existsSync(path)) continue;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as { presets?: Array<Record<string, unknown>> };
        if (!Array.isArray(raw.presets)) continue;
        let changed = false;
        for (const preset of raw.presets) {
          if (!preset || typeof preset !== "object") continue;
          if (preset.durableToolMode === undefined && preset.botToolMode !== undefined) {
            preset.durableToolMode = preset.botToolMode;
            changed = true;
          }
          if ("botToolMode" in preset) { delete preset.botToolMode; changed = true; }
        }
        if (changed) writeText(path, JSON.stringify(raw, null, 2));
      } catch {
        // Invalid policy files are handled by the normal normalize/fallback path.
      }
    }
  }

  /**
   * 将出厂文案/策略写入磁盘（已存在则不覆盖）。
   * 打开设置、列模式、打开目录/文件时调用，保证 .md 与 policy.json 都在。
   */
  ensureMaterialized(id?: WelcomeMode): void {
    this.migrateLegacyModeDirs();
    this.migrateLegacyReadme();
    this.migrateLegacyPolicyKeys();
    const ids = id && isWelcomeMode(id) ? [id] : [...WELCOME_MODES];
    for (const mid of ids) {
      try {
        const seed = MODE_SEEDS[mid];
        ensureDir(this.modeDir(mid));
        for (const blockId of MODE_BLOCK_IDS) {
          const path = this.blockPath(mid, blockId);
          const current = readText(path);
          const previous = (previousModeBlocks as Partial<Record<WelcomeMode, Partial<Record<ModeBlockId, string>>>>)[mid]?.[blockId];
          if (previous !== undefined && (current === previous || current === previous + "\n")) {
            writeText(path, seed.blocks[blockId]);
          } else if (previous !== undefined && current !== null && current !== seed.blocks[blockId] && current !== seed.blocks[blockId] + "\n") {
            // Preview alongside the customized block; never replace user text.
            const previewPath = path + ".factory-update.md";
            if (readText(previewPath) !== seed.blocks[blockId] + "\n") {
              writeText(previewPath, seed.blocks[blockId]);
              console.info("[ModeProfile] 自定义块已保留；出厂更新可预览", previewPath);
            }
          }
          // Upgrade only exact former factory text. User-authored blocks remain user configuration.
          if (current === null) {
            writeText(path, seed.blocks[blockId]);
            console.log("[ModeProfile] materialized", path);
          }
        }
        const pol = this.policyFilePath(mid);
        if (!existsSync(pol)) {
          const policy = normalizePolicy(seed.policy);
          if (mid === "working") policy.presets = policy.presets?.map(preset => preset.id === PENPOT_PRESET.id ? this.penpotPreset() : preset);
          writeText(pol, JSON.stringify(policy, null, 2));
          console.log("[ModeProfile] materialized", pol);
        }
        const readme = join(this.modeDir(mid), "README.md");
        if (!existsSync(readme)) {
          writeText(
            readme,
            [
              `# ${WELCOME_MODE_LABELS[mid]}（${mid}）`,
              "",
              "本目录为 MyBuddy 场景模式**文案**与策略。",
              "",
              "## 文案（Markdown，可外部编辑）",
              "",
              ...MODE_BLOCK_IDS.map((b) => `- \`${b}.md\` — ${MODE_BLOCK_LABELS[b]}`),
              "",
              "## 策略",
              "",
              "- `policy.json` — 技能 / MCP / 工具 / 产物扩展名 / 场景芯片（JSON）",
              "",
              "在应用「设置 → 场景模式」编辑并保存会写回这些文件；点「恢复」写回出厂文案。",
              "**仅对新任务生效**。",
              "",
            ].join("\n"),
          );
        }
      } catch (err) {
        console.error("[ModeProfile] ensureMaterialized failed for", mid, err);
      }
    }
  }

  listSummaries(): ModeProfileSummaryDto[] {
    this.ensureMaterialized();
    return WELCOME_MODES.map((id) => {
      const p = this.getProfile(id);
      return {
        id,
        labelZh: p.labelZh,
        hasUserOverride: p.hasUserOverride,
        totalChars: p.totalChars,
        version: p.version,
      };
    });
  }

  getProfile(id: WelcomeMode): ModeProfileDto {
    if (!isWelcomeMode(id)) {
      throw new Error(`未知场景模式: ${id}`);
    }
    this.ensureMaterialized(id);
    const seed = MODE_SEEDS[id];
    const blocks = MODE_BLOCK_IDS.map((blockId) => {
      const path = this.blockPath(id, blockId);
      const disk = readText(path);
      const seedText = seed.blocks[blockId];
      const content = disk ?? seedText;
      const isUser = disk != null && normText(disk) !== normText(seedText);
      return {
        id: blockId,
        label: MODE_BLOCK_LABELS[blockId],
        content,
        source: (isUser ? "user" : "seed") as "user" | "seed",
        chars: content.length,
        filePath: path,
      };
    });

    const policyPath = this.policyFilePath(id);
    const policyUser = readText(policyPath);
    const seedPolicy = normalizePolicy(seed.policy);
    let policy = seedPolicy;
    let policyUserOverride = false;
    if (policyUser != null) {
      try {
        let diskRaw = JSON.parse(policyUser) as Record<string, unknown>;
        let seedPresets = seedPolicy.presets;
        if (id === "working") {
          const current = normalizePresets(diskRaw.presets).find(preset => preset.id === PENPOT_PRESET.id);
          seedPresets = seedPresets?.map(preset => preset.id === PENPOT_PRESET.id ? this.penpotPreset(current) : preset);
          if (current) diskRaw = { ...diskRaw, presets: normalizePresets(diskRaw.presets).map(preset => preset.id === PENPOT_PRESET.id ? this.penpotPreset(current) : preset) };
        }
        // 向后兼容：旧 policy.json 无 artifactPolicy 时回退出厂产物黑名单（办公禁 py 等）
        if (diskRaw.artifactPolicy === undefined || diskRaw.artifactPolicy === null) {
          diskRaw = { ...diskRaw, artifactPolicy: seedPolicy.artifactPolicy };
        }
        // 出厂技能白名单补全（只增不改，全模式通用）：用户 base skillPolicy.allow 非空
        // （= 已启用白名单收窄）时，把该模式出厂 preset skillPolicy.allow 声明的工厂技能
        // 补进 base allow。原因：effective allow = base ∩ preset（tag 不能越出 base），旧配置
        // 迁移机器若 base allow 缺新出厂技能（如 3d-blender 的 blender-*），交集为空导致
        // 新出厂技能被静默隐藏（曾发生在 freecad/blender-* 上）。只补缺失项，绝不删除/
        // 覆盖用户显式条目；base allow 为空（未启用白名单）时不补，避免凭空创建白名单
        // 改变技能目录语义。
        const diskSkillPolicy = diskRaw.skillPolicy as Record<string, unknown> | undefined;
        const diskBaseAllow = Array.isArray(diskSkillPolicy?.allow)
          ? (diskSkillPolicy!.allow as unknown[]).filter((x): x is string => typeof x === "string")
          : null;
        if (diskBaseAllow && diskBaseAllow.length > 0) {
          const factory = factorySkillAllowForMode(id);
          const missing = factory.filter((name) => !diskBaseAllow.includes(name));
          if (missing.length > 0) {
            diskRaw = {
              ...diskRaw,
              skillPolicy: { ...(diskSkillPolicy ?? {}), allow: [...diskBaseAllow, ...missing] },
            };
          }
        }
        // 向后兼容（全模式通用）：用户旧 policy.json 无 presets 时回退出厂预设；
        // 仅当该模式出厂 presets 全为 prompt-only（working/coding，无 provider/MCP 语义）
        // 且用户自定义过 scenes（≠ 出厂）时，运行时转换为 legacy presets，避免用户 tag 消失；
        // 出厂 seed presets（如 working 的 general-office/drawio-ai）始终只增不改地并入。
        let fallbackPresets: ModePresetDto[] | undefined;
        if (!Array.isArray(diskRaw.presets)) {
          // 向后兼容（全模式通用）：旧 policy.json 无 presets 时，用户自定义 scenes
          // 转换为 promptAddon-only legacy presets（保留用户 tag）并与出厂 seed preset 并存，
          // 保证旧用户 tag 不消失、新出厂能力不缩水；无自定义 scenes 时直接回退出厂。
          const diskScenes = normalizeScenes(diskRaw.scenes);
          const scenesDiffer = diskScenes.length > 0 && !scenesEqual(diskScenes, seedPolicy.scenes);
          fallbackPresets = scenesDiffer
            ? sanitizeModePresets(id, [...legacyPresetsFromScenes(diskScenes), ...(seedPresets ?? [])])
            : seedPresets;
        } else {
          // 升级语义（只增不改）：磁盘已有 presets 数组时，把出厂新增的 seed preset 并入，
          // 保证新出厂 tag（如 working 的 general-office/drawio-ai）在已个性化机器上也可见。
          // seed preset 是出厂能力：读时总是补回缺失 id（UI 已禁止删除 seed，见
          // ModesTab.deleteSelectedPreset 门禁）；用户同名 preset 不被覆盖，用户自定义
          // preset 保持不变。
          const retired = new Set(RETIRED_MODE_PRESET_IDS[id]);
          const diskPresets = normalizePresets(diskRaw.presets).filter((p) => !retired.has(p.id));
          const diskIds = new Set(diskPresets.map((p) => p.id));
          const merged: ModePresetDto[] = [...diskPresets];
          for (const seedPreset of seedPresets ?? []) {
            if (!diskIds.has(seedPreset.id)) merged.push(seedPreset);
          }
          // 出厂能力字段补全（只增不改）：磁盘同名 preset 缺 requiredRuntimes 时
          // 从 seed 补回（如 mechanical-cad 的 freecad runtime requirement），
          // 保证旧个性化机器也能获得新出厂能力声明；不覆盖用户显式字段。
          for (let i = 0; i < merged.length; i += 1) {
            const seedMatch = (seedPresets ?? []).find((sp) => sp.id === merged[i].id);
            if (seedMatch && !merged[i].requiredRuntimes && seedMatch.requiredRuntimes) {
              merged[i] = { ...merged[i], requiredRuntimes: seedMatch.requiredRuntimes };
            }
            // 出厂能力字段补全（只增不改）：磁盘同名 preset 缺 skillPolicy 时从 seed 补回
            // （如 3d-blender 的 blender-* 技能白名单），保证旧个性化机器也能获得新出厂
            // 技能策略；不覆盖用户显式设置的 skillPolicy。
            if (seedMatch && !merged[i].skillPolicy && seedMatch.skillPolicy) {
              merged[i] = { ...merged[i], skillPolicy: seedMatch.skillPolicy };
            }
            // Adopt the new OfficeCLI whitelist only for the unchanged previous factory policy.
            // Custom allow/hide/prefer choices remain authoritative; reads never rewrite disk.
            if (id === "working" && seedMatch?.id === "general-office" && seedMatch.skillPolicy
              && JSON.stringify(merged[i].skillPolicy) === JSON.stringify({ ...seedMatch.skillPolicy, allow: [] })) {
              merged[i] = { ...merged[i], skillPolicy: seedMatch.skillPolicy };
            }
          }
          diskRaw = {
            ...diskRaw,
            presets: sanitizeModePresets(id, merged),
          };
        }
        policy = normalizePolicy(diskRaw, fallbackPresets);
        policy = {
          ...policy,
          presets: sanitizeModePresets(id, policy.presets ?? []),
        };
        policyUserOverride = !policiesEqual(policy, seedPolicy);
      } catch {
        policy = seedPolicy;
        policyUserOverride = false;
      }
    }

    const hasUserOverride =
      policyUserOverride || blocks.some((b) => b.source === "user");
    const totalChars = blocks.reduce((n, b) => n + b.chars, 0);

    return {
      id,
      labelZh: WELCOME_MODE_LABELS[id],
      version: seed.version,
      blocks,
      policy: id === "general" ? generalModeConfiguration(policy) : policy,
      hasUserOverride,
      totalChars,
      userDir: this.modeDir(id),
      policyPath,
    };
  }

  /** 拼进 system prompt 的场景说明（含各块标题） */
  buildSystemSection(id: WelcomeMode): string {
    const profile = this.getProfile(id);
    const parts = [
      `## 场景模式：${profile.labelZh}`,
      ...profile.blocks.map((b) => `### ${b.label}\n${b.content.trim()}`),
    ];
    const tool = profile.policy.toolPolicy;
    if (tool.prefer.length || tool.demote.length || tool.deny.length) {
      parts.push(
        [
          "### 工具偏好",
          tool.mode === "hard" ? "（硬约束：部分工具可能不可用）" : "（软偏好，按任务需要调整）",
          tool.prefer.length ? `- 优先：${tool.prefer.join(", ")}` : "",
          tool.demote.length ? `- 慎用：${tool.demote.join(", ")}` : "",
          tool.deny.length ? `- 避免：${tool.deny.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    const art = profile.policy.artifactPolicy;
    if (art.deny.length || art.allow.length) {
      parts.push(
        [
          "### 产物扩展名限制（显示过滤）",
          "（黑白名单仅用于产物面板显示过滤；文件写入不受影响，不会拦截 write/edit）",
          art.deny.length ? `- 黑名单 deny：${art.deny.map((e) => `.${e}`).join(", ")}` : "- 黑名单：未配置",
          art.allow.length
            ? `- 白名单 allow：仅 ${art.allow.map((e) => `.${e}`).join(", ")}`
            : "- 白名单：未启用（allow 为空）",
          "请按本场景推荐交付格式产出；黑白名单按本模式独立配置。",
        ].join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  saveBlock(id: WelcomeMode, blockId: ModeBlockId, content: string): ModeProfileDto {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    if (!MODE_BLOCK_IDS.includes(blockId)) throw new Error(`未知块: ${blockId}`);
    const text = content ?? "";
    if (!text.trim()) throw new Error("内容不能为空");
    if (text.length > 20_000) throw new Error("单块内容过长（上限 20000 字符）");
    ensureDir(this.modeDir(id));
    writeText(this.blockPath(id, blockId), text);
    return this.getProfile(id);
  }

  savePolicy(id: WelcomeMode, policy: ModePolicyDto): ModeProfileDto {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    // 保存时同样兼容：缺 presets 的旧 policy 回退出厂预设
    const normalized = id === "general" ? generalModeConfiguration(normalizePolicy(policy, MODE_SEEDS[id].policy.presets)) : normalizePolicy(policy, MODE_SEEDS[id].policy.presets);
    const err = validatePolicy(normalized);
    if (err) throw new Error(err);
    ensureDir(this.modeDir(id));
    writeText(this.policyFilePath(id), JSON.stringify(normalized, null, 2));
    return this.getProfile(id);
  }

  resetBlock(id: WelcomeMode, blockId: ModeBlockId): ModeProfileDto {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    if (!MODE_BLOCK_IDS.includes(blockId)) throw new Error(`未知块: ${blockId}`);
    const seed = MODE_SEEDS[id];
    // 写回出厂内容（文件始终存在，便于暴露）
    writeText(this.blockPath(id, blockId), seed.blocks[blockId]);
    return this.getProfile(id);
  }

  resetPolicy(id: WelcomeMode): ModeProfileDto {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    const seed = MODE_SEEDS[id];
    writeText(this.policyFilePath(id), JSON.stringify(normalizePolicy(seed.policy), null, 2));
    return this.getProfile(id);
  }

  resetProfile(id: WelcomeMode): ModeProfileDto {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    const seed = MODE_SEEDS[id];
    ensureDir(this.modeDir(id));
    for (const blockId of MODE_BLOCK_IDS) {
      writeText(this.blockPath(id, blockId), seed.blocks[blockId]);
    }
    writeText(this.policyFilePath(id), JSON.stringify(normalizePolicy(seed.policy), null, 2));
    return this.getProfile(id);
  }

  async openModesDir(id?: WelcomeMode): Promise<string> {
    if (id && isWelcomeMode(id)) this.ensureMaterialized(id);
    else this.ensureMaterialized();
    const dir = id && isWelcomeMode(id) ? this.modeDir(id) : getModesDir();
    ensureDir(dir);
    await shell.openPath(dir);
    return dir;
  }

  /** 用系统默认程序打开某一文案块（.md）或 policy.json */
  async openModeFile(id: WelcomeMode, target: ModeBlockId | "policy"): Promise<string> {
    if (!isWelcomeMode(id)) throw new Error(`未知场景模式: ${id}`);
    this.ensureMaterialized(id);
    const seed = MODE_SEEDS[id];
    let path: string;
    if (target === "policy") {
      path = this.policyFilePath(id);
      if (!existsSync(path)) {
        writeText(path, JSON.stringify(normalizePolicy(seed.policy), null, 2));
      }
    } else {
      if (!MODE_BLOCK_IDS.includes(target)) {
        throw new Error(`未知文案块: ${target}（期望 goal/workflow/… 或 policy）`);
      }
      path = this.blockPath(id, target);
      // 双保险：缺失则立即写出对应 md，绝不误开 policy.json
      if (!existsSync(path)) {
        writeText(path, seed.blocks[target]);
      }
    }
    if (!existsSync(path)) {
      throw new Error(`文件不存在: ${path}`);
    }
    console.log("[ModeProfile] openModeFile", { id, target, path });
    const err = await shell.openPath(path);
    if (err) throw new Error(`无法打开 ${path}: ${err}`);
    return path;
  }
}
