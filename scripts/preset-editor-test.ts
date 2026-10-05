/**
 * Preset/Tag 编辑器 UI 闭环单测（轻量，无 Electron）：
 *   1. normalizePresetDraft：recommendedExpertIds / suggestedModelId / suggestedPermissionMode /
 *      providerMcpIds / promptAddon / skillPolicy / mcpPolicy 序列化与非法值回退
 *   2. upsertPreset / removePreset / suggestPresetId / applyPresetsToPolicy（base 字段不丢）
 *   3. buildModelSuggestionOptions：缺失模型「已缺失」呈现 + 清除路径
 *   4. ModeProfileStore round-trip：全字段 preset 保存→回读不丢；旧 working/design 出厂预设可回读
 *   5. buildPresetBarChips：providerMcpIds 未配置 → Tag 置灰（UI gate 与编辑器数据一致）
 *
 * 运行：pnpm test:preset-editor
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), `mybuddy-preset-editor-test-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
mkdirSync(sandbox, { recursive: true });

// eslint-disable-next-line import/first
import {
  applyPresetsToPolicy,
  buildModelSuggestionOptions,
  isModelSuggestionAvailable,
  isPresetDraftValid,
  isSeedPreset,
  normalizePresetDraft,
  removePreset,
  suggestPresetId,
  upsertPreset,
} from "../src/renderer/src/lib/presetEditor";
// eslint-disable-next-line import/first
import type { ModePolicyDto, ModePresetDto } from "../src/shared/mode-profile";
// eslint-disable-next-line import/first
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
// eslint-disable-next-line import/first
import { ModeProfileStore } from "../src/main/agent/ModeProfileStore";
// eslint-disable-next-line import/first
import { buildPresetBarChips } from "../src/renderer/src/lib/modePresetBar";

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

/** 全字段 preset（覆盖 UI 可编辑的全部新字段） */
function fullPreset(over: Partial<ModePresetDto> = {}): Partial<ModePresetDto> {
  return {
    id: "ui-edited",
    label: "UI 编辑全字段",
    description: "来自可视化编辑器",
    promptAddon: "附加段",
    recommendedExpertIds: ["doc-polish", "code-review-expert"],
    suggestedModelId: "claude-sonnet-4-20250514",
    suggestedPermissionMode: "readonly",
    providerMcpIds: ["drawio-ai", "penpot"],
    skillPolicy: { prefer: ["周报"], demote: [], hide: ["serena"], allow: [] },
    mcpPolicy: { mode: "hard", allow: ["drawio-ai"], deny: ["serena"] },
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("\n== 1. normalizePresetDraft 序列化 / 回退 ==");
  {
    const d = normalizePresetDraft(fullPreset() as ModePresetDto);
    assert(d.id === "ui-edited" && d.label === "UI 编辑全字段", "id/label 保留");
    assert(d.description === "来自可视化编辑器" && d.promptAddon === "附加段", "description/promptAddon 保留");
    assert(
      JSON.stringify(d.recommendedExpertIds) === JSON.stringify(["doc-polish", "code-review-expert"]),
      "recommendedExpertIds 保留（多选专家）",
    );
    assert(d.suggestedModelId === "claude-sonnet-4-20250514", "suggestedModelId 保留");
    assert(d.suggestedPermissionMode === "readonly", "suggestedPermissionMode 保留");
    assert(
      JSON.stringify(d.providerMcpIds) === JSON.stringify(["drawio-ai", "penpot"]),
      "providerMcpIds 保留（受管 MCP 多选）",
    );
    assert(d.skillPolicy?.hide.includes("serena") && d.mcpPolicy?.allow.includes("drawio-ai"), "skillPolicy/mcpPolicy 保留");

    const bad = normalizePresetDraft({
      id: "  x-1  ",
      label: "  L  ",
      suggestedPermissionMode: "banana" as never,
      suggestedModelId: "   ",
      recommendedExpertIds: ["a", " ", "b", "a"],
      providerMcpIds: [1, "c"] as never,
    });
    assert(bad.id === "x-1" && bad.label === "L", "字符串 trim 清洗");
    assert(bad.suggestedPermissionMode === null, "非法权限值 → null（不炸）");
    assert(bad.suggestedModelId === null, "空白模型建议 → null（无建议）");
    assert(JSON.stringify(bad.recommendedExpertIds) === JSON.stringify(["a", "b", "a"]), "专家列表 trim+滤空（保序不去重）");
    assert(JSON.stringify(bad.providerMcpIds) === JSON.stringify(["1", "c"]), "providerMcpIds 非字符串安全转字符串");
    assert(isPresetDraftValid({ id: "a", label: "b" } as ModePresetDto), "有效 preset 校验通过");
    assert(!isPresetDraftValid({ id: " ", label: "" } as ModePresetDto), "空 id/label 校验失败");
  }

  console.log("\n== 2. upsertPreset / removePreset / suggestPresetId / applyPresetsToPolicy ==");
  {
    const list = [normalizePresetDraft(fullPreset()) as ModePresetDto];
    const replaced = upsertPreset(list, { id: "ui-edited", label: "改名", suggestedModelId: "m2" });
    assert(replaced.length === 1 && replaced[0].label === "改名", "按 id 替换（不新增）");
    assert(
      replaced[0].suggestedModelId === "m2" &&
        replaced[0].recommendedExpertIds.length === 0 &&
        replaced[0].suggestedPermissionMode === null,
      "替换 = 整体替换（调用方须传入完整草稿；缺省字段归一化为空）",
    );
    const added = upsertPreset(list, { id: "brand-new", label: "新 Tag" });
    assert(added.length === 2 && added[1].id === "brand-new", "新 id 追加");
    const removed = removePreset(added, "brand-new");
    assert(removed.length === 1 && removed[0].id === "ui-edited", "removePreset 按 id 删除");
    assert(suggestPresetId("新 预设", list) === "新-预设" || suggestPresetId("new tag", list) === "new-tag", "suggestPresetId slug 生成");
    const used = [normalizePresetDraft(fullPreset({ id: "new-tag" })) as ModePresetDto];
    assert(suggestPresetId("new tag", used) === "new-tag-2", "suggestPresetId 冲突追加序号");

    const base = {
      ...({} as ModePolicyDto),
      skillPolicy: { prefer: ["base"], demote: [], hide: [], allow: [] },
      toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
      mcpPolicy: { mode: "hard", allow: [], deny: [] },
      suggestedModelId: "base-model",
      suggestedPermissionMode: "default",
      recommendedExpertIds: ["base-expert"],
      scenes: [],
      presets: [],
    };
    const merged = applyPresetsToPolicy(base, [normalizePresetDraft(fullPreset()) as ModePresetDto, { id: "", label: "" } as ModePresetDto]);
    assert(merged.presets.length === 1 && merged.presets[0].id === "ui-edited", "applyPresetsToPolicy 归一化并滤掉空条目");
    assert(
      merged.suggestedModelId === "base-model" &&
        merged.suggestedPermissionMode === "default" &&
        merged.recommendedExpertIds[0] === "base-expert" &&
        merged.skillPolicy.prefer[0] === "base",
      "base 字段（模型/权限/推荐专家/技能/MCP 策略）原样保留",
    );
    assert(
      merged.presets[0].suggestedPermissionMode === "readonly" &&
        merged.presets[0].recommendedExpertIds.length === 2,
      "preset 新字段经 applyPresetsToPolicy 不丢",
    );
  }

  console.log("\n== 3. 建议模型选项（可用 / 已缺失）==");
  {
    const models = [{ id: "m1", name: "模型一" }, { id: "m2" }];
    const opts = buildModelSuggestionOptions("m1", models);
    assert(opts[0].value === "" && opts[0].label.includes("无建议"), "首个选项 = 无建议（跟随默认）");
    assert(opts.some((o) => o.value === "m1" && !o.missing), "已配置模型出现在选项");
    assert(isModelSuggestionAvailable("m1", models), "可用模型判定 true");
    assert(!isModelSuggestionAvailable(null, models) && !isModelSuggestionAvailable("ghost", models), "无建议/缺失模型判定 false");
    const ghost = buildModelSuggestionOptions("ghost-model", models);
    assert(
      ghost.some((o) => o.value === "ghost-model" && o.missing && o.label.includes("已缺失")),
      "已卸载/未配置模型 → 「已缺失」选项（可回选清除）",
    );
  }

  console.log("\n== 4. ModeProfileStore：全字段 preset 保存→回读 ==");
  {
    const store = new ModeProfileStore();
    const wFile = join(sandbox, ".mybuddy", "modes", "working", "policy.json");
    mkdirSync(join(sandbox, ".mybuddy", "modes", "working"), { recursive: true });
    const working = store.getProfile("working");
    const policy: ModePolicyDto = {
      ...working.policy,
      presets: [
        ...(working.policy.presets ?? []),
        normalizePresetDraft(fullPreset()) as ModePresetDto,
      ],
    };
    store.savePolicy("working", policy);
    const back = store.getProfile("working");
    const saved = back.policy.presets?.find((p) => p.id === "ui-edited");
    assert(!!saved, "自定义 preset 保存后可回读");
    assert(saved?.label === "UI 编辑全字段" && saved?.promptAddon === "附加段", "label/promptAddon 回读");
    assert(
      JSON.stringify(saved?.recommendedExpertIds) === JSON.stringify(["doc-polish", "code-review-expert"]),
      "recommendedExpertIds 经 normalizePresets 不丢",
    );
    assert(saved?.suggestedModelId === "claude-sonnet-4-20250514", "suggestedModelId 经 normalizePresets 不丢");
    assert(saved?.suggestedPermissionMode === "readonly", "suggestedPermissionMode 经 normalizePresets 不丢");
    assert(
      JSON.stringify(saved?.providerMcpIds) === JSON.stringify(["drawio-ai", "penpot"]),
      "providerMcpIds 经 normalizePresets 不丢",
    );
    assert(
      saved?.skillPolicy?.hide.includes("serena") && saved?.mcpPolicy?.allow.includes("drawio-ai"),
      "skillPolicy/mcpPolicy 经 normalizePresets 不丢",
    );
    const disk = JSON.parse(readFileSync(wFile, "utf-8")) as { presets?: ModePresetDto[] };
    assert(
      disk.presets?.some((p) => p.id === "ui-edited" && p.suggestedPermissionMode === "readonly"),
      "policy.json 落盘包含全字段 preset",
    );
    // 出厂 preset 回读（旧 Working/Design 配置可读）
    const drawio = back.policy.presets?.find((p) => p.id === "drawio-ai");
    assert(
      drawio?.providerMcpIds?.join(",") === "drawio-ai" && drawio?.mcpPolicy?.allow.includes("drawio-ai"),
      "working drawio-ai 出厂 preset 可回读（providerMcpIds 不回归）",
    );
    const design = store.getProfile("bot");
    const blender = design.policy.presets?.find((p) => p.id === "3d-blender");
    const freecad = design.policy.presets?.find((p) => p.id === "mechanical-cad");
    const aiUi = design.policy.presets?.find((p) => p.id === "ai-ui");
    assert(!blender && !freecad && !aiUi, "Ardot / Blender / FreeCAD Tag 已退役");
    const penpot = store.getProfile("working").policy.presets?.find((p) => p.id === "web-prototype");
    assert(penpot?.label === "Penpot" && penpot.providerMcpIds?.includes("penpot"), "Penpot 移到办公并保留 MCP 配置");
    assert(!design.policy.presets?.some((p) => ["general", "web-prototype"].includes(p.id)), "Bot 不保留通用设计和 Penpot");
    const opendesign = design.policy.presets?.find((p) => p.id === "opendesign");
    assert(!opendesign, "OpenDesign Tag 已退役");
    // 三模式 seed 一致
    assert(MODE_SEEDS.working.policy.presets?.length === 8, "working 出厂 8 presets");
    assert(MODE_SEEDS.bot.policy.presets?.length === 2, "Bot 出厂 2 Tags");
    assert(MODE_SEEDS.coding.policy.presets?.length === 8, "coding 出厂 8 presets");
  }

  console.log("\n== 5. buildPresetBarChips：providerMcpIds 与编辑器数据一致 ==");
  {
    const chips = buildPresetBarChips({
      presets: [
        normalizePresetDraft(fullPreset({ id: "with-provider", label: "有受管服务" })) as ModePresetDto,
        normalizePresetDraft(fullPreset({ id: "plain", label: "纯文本", providerMcpIds: [] })) as ModePresetDto,
      ],
      selectedPresetId: "with-provider",
      availableMcpServerNames: new Set(["drawio-ai", "penpot"]),
      locked: false,
    });
    const withProvider = chips.find((c) => c.id === "with-provider");
    const plain = chips.find((c) => c.id === "plain");
    assert(!!withProvider && withProvider.selected, "选中态保留");
    assert(
      !withProvider?.disabled && withProvider?.title === undefined,
      "providerMcpIds 全部可用 → Tag 可选",
    );
    assert(plain && !plain.disabled, "无 providerMcpIds 的 Tag 始终可选");
    const chips2 = buildPresetBarChips({
      presets: [normalizePresetDraft(fullPreset({ id: "with-provider" })) as ModePresetDto],
      selectedPresetId: null,
      availableMcpServerNames: new Set(["drawio-ai"]),
      locked: false,
    });
    assert(
      chips2[0].disabled && chips2[0].title?.includes("Penpot"),
      "providerMcpIds 缺 penpot → Tag 置灰并说明缺失服务",
    );
    const chips3 = buildPresetBarChips({
      presets: [normalizePresetDraft(fullPreset({ id: "with-provider" })) as ModePresetDto],
      selectedPresetId: "with-provider",
      availableMcpServerNames: new Set(["drawio-ai", "penpot"]),
      locked: true,
    });
    assert(chips3[0].disabled && chips3[0].title?.includes("锁定"), "任务已开始 → Tag 锁定（语义不回归）");
  }

  // 6. 出厂预设删除 gate（seed preset 不可删：读时会被 ModeProfileStore 合并还原）
  {
    assert(isSeedPreset("coding", "code-review") === true, "coding code-review 是 seed（不可删）");
    assert(isSeedPreset("working", "general-office") === true, "working general-office 是 seed");
    assert(isSeedPreset("working", "web-prototype") === true, "办公 Penpot 是 seed");
    assert(isSeedPreset("bot", "web-prototype") === false, "Bot Penpot 已移除");
    assert(isSeedPreset("bot", "ai-ui") === false, "design ai-ui 已退役");
    assert(isSeedPreset("bot", "opendesign") === false, "design opendesign 已退役");
    assert(isSeedPreset("coding", "custom-tag") === false, "自定义 preset 不是 seed（可删）");
    assert(isSeedPreset("working", "project-management") === true, "working project-management 是 seed");
    assert(isSeedPreset("working", "inventory-summary") === false, "库存摘要已退役，不再是 seed");
  }

  console.log(`\npreset-editor: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
