/**
 * Mode Preset 配置和兼容性单测（轻量，无 Electron）：
 *   1. resolver 纯函数：5 个 design preset 的 MCP/Skill 收窄合成（deny 并集 / allow 交集）
 *   2. filterMcpConfigForMode 端到端：有效 allow/deny → 实际 enabled server
 *   3. filterSkillsForMode 端到端：有效 skillPolicy → 可见技能
 *   4. assemblePrompt：preset promptAddon 段 + effective policy 进入 system 装配
 *   5. ModeProfileStore 向后兼容：旧 policy.json（无 presets）回退出厂 preset，base 仍为用户覆盖
 *   6. AppDatabase：modePresetId round-trip（upsert/load/保留/清除/旧库迁移）
 *   7. buildPresetBarChips：UI gate（4 chips / selected / locked / 未配置 provider disabled）
 *   8. appStore：setModePreset 空任务可切、锁定任务冻结、sendMessage 透传 req.modePresetId
 *
 * 运行：pnpm test:mode-preset
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), `mybuddy-preset-test-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
mkdirSync(sandbox, { recursive: true });

// eslint-disable-next-line import/first
import {
  DESIGN_PROVIDER_MCP_IDS,
  MODE_SEED_PRESET_IDS,
  defaultModePresetId,
  emptyModePolicy,
  isKnownModePresetId,
  resolveEffectiveModePolicy,
  resolveModePreset,
  resolveModePresetId,
  withEffectiveModePolicy,
  type ModeMcpPolicy,
  type ModePolicyDto,
  type ModePresetDto,
  type ModeSkillPolicy,
} from "../src/shared/mode-profile";
// eslint-disable-next-line import/first
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
// eslint-disable-next-line import/first
import { filterMcpConfigForMode, type McpFilterResult } from "../src/main/mcp/McpModeFilter";
// eslint-disable-next-line import/first
import type { McpConfig } from "../src/main/mcp/McpConfigService";
// eslint-disable-next-line import/first
import { filterSkillsForMode } from "../src/main/agent/SkillPolicy";
// eslint-disable-next-line import/first
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
// eslint-disable-next-line import/first
import { ModeProfileStore } from "../src/main/agent/ModeProfileStore";
// eslint-disable-next-line import/first
import { AppDatabase } from "../src/main/db/AppDatabase";
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

/** 旧情景策略 helper 的 6 个 fixture（Bot 运行时不调用这些过滤器）（测试内联，避免依赖本机 skills 目录） */
const PRESETS: ModePresetDto[] = [
  {
    id: "ai-ui",
    label: "AI UI · Ardot",
    promptAddon: "AI UI 预设说明",
    skillPolicy: { prefer: ["ardot"], demote: [], hide: [], allow: ["ardot", "ardot-design-generator"] },
    mcpPolicy: { mode: "hard", allow: ["ardot-local"], deny: [] },
    providerMcpIds: ["ardot-local"],
  },
  {
    id: "web-prototype",
    label: "网页原型 · Penpot",
    promptAddon: "必须优先调用 penpot MCP 工具，不要跳过 Penpot 只用文字自行设计。",
    mcpPolicy: { mode: "hard", allow: ["penpot"], deny: [] },
    providerMcpIds: ["penpot"],
  },
  {
    id: "3d-blender",
    label: "3D · Blender",
    promptAddon: "Blender 通用 3D 预设说明，不作为精密机械 CAD",
    mcpPolicy: { mode: "hard", allow: ["blender"], deny: [] },
    providerMcpIds: ["blender"],
  },
  {
    id: "mechanical-cad",
    label: "机械 CAD · FreeCAD",
    promptAddon: "FreeCAD 参数化机械 CAD 预设说明，工程尺寸必须精确",
    mcpPolicy: { mode: "hard", allow: ["freecad"], deny: [] },
    providerMcpIds: ["freecad"],
  },
  {
    id: "opendesign",
    label: "AI 设计引擎 · OpenDesign",
    promptAddon: "OpenDesign AI 设计引擎预设说明：Pi 仍是唯一主 Agent，3D/机械 CAD/网页原型边界清晰",
    mcpPolicy: { mode: "hard", allow: ["opendesign"], deny: [] },
    providerMcpIds: ["opendesign"],
  },
  {
    id: "general",
    label: "通用设计",
    promptAddon: "通用设计预设说明",
    mcpPolicy: { mode: "hard", allow: [], deny: [...DESIGN_PROVIDER_MCP_IDS] },
    providerMcpIds: [],
  },
];

function basePolicy(over: Partial<ModePolicyDto> = {}): ModePolicyDto {
  return { ...emptyModePolicy(), presets: PRESETS, ...over };
}

/** 专业工具已配置时的用户 design base：允许全部设计 provider，preset 再做硬收窄 */
const USER_BASE = basePolicy({
  skillPolicy: {
    prefer: ["bot", "ui"],
    demote: ["deploy"],
    hide: [],
    allow: ["ardot", "ardot-design-assistant", "image-to-ui", "image-understanding-native"],
  },
  mcpPolicy: {
    mode: "hard",
    allow: ["canva", "ardot-local", "penpot", "blender", "freecad", "opendesign"],
    deny: [],
  },
});

/** 出厂 design base：allow 空 = 白名单未启用（unrestricted） */
const SEED_BASE = basePolicy({
  skillPolicy: { prefer: ["bot"], demote: ["deploy"], hide: [], allow: [] },
  mcpPolicy: { mode: "hard", allow: [], deny: ["serena", "codegraph"] },
});

const MCP_FULL: McpConfig = {
  mcpServers: {
    "ardot-local": { url: "http://127.0.0.1:50501/api/v1/mcp" },
    penpot: { url: "https://penpot.example.com/mcp" },
    blender: { command: "blender-mcp", modes: ["bot"] },
    freecad: { command: "freecad-mcp", modes: ["bot"] },
    canva: { url: "https://mcp.canva.com/mcp" },
    opendesign: { command: "od", args: ["mcp"], modes: ["bot"] },
    weather: { command: "npx", args: ["weather-mcp"] },
    serena: { command: "serena", args: ["start-mcp-server"], modes: ["coding"] },
  },
};

function enabledOf(r: McpFilterResult): string[] {
  return [...r.config.mcpServers.keys()];
}

const SKILLS = [
  { id: "ardot", name: "ardot", description: "Ardot 设计" },
  { id: "ardot-design-generator", name: "ardot-design-generator", description: "Ardot 生成" },
  { id: "weekly-report", name: "weekly-report-fill", description: "周报" },
];

async function main(): Promise<void> {
  console.log("\n== 1.5 三模式出厂 presets + 默认/校验 helper ==");
  {
    const workingPresets = MODE_SEEDS.working.policy.presets ?? [];
    const codingPresets = MODE_SEEDS.coding.policy.presets ?? [];
    const designPresets = MODE_SEEDS.bot.policy.presets ?? [];
    assert(workingPresets.length === 8, "working 出厂 8 presets（对人交付闭环 + 流程图）");
    assert(
      workingPresets.map((p) => p.id).join(",") ===
        "general-office,summary,weekly-report,meeting-notes,project-management,data-analysis,drawio-ai,web-prototype",
      "working preset ids（通用办公 / 总结 / 周报 / 会议纪要 / 项目管理 / 数据分析 / 流程图）",
    );
    const officeSummary = workingPresets.find((p) => p.id === "summary")!;
    assert(
      officeSummary.label === "总结" &&
        officeSummary.promptAddon?.includes("不是缩写版原文") === true &&
        officeSummary.mcpPolicy?.deny.includes("drawio-ai") === true &&
        (officeSummary.recommendedExpertIds ?? []).includes("doc-polish"),
      "summary 压长材料、禁复述、推荐润色专家",
    );
    const weekly = workingPresets.find((p) => p.id === "weekly-report")!;
    assert(
      weekly.label === "周报" && weekly.promptAddon!.includes("本周完成"),
      "weekly-report 标签为「周报」且保留本周完成结构",
    );
    const meeting = workingPresets.find((p) => p.id === "meeting-notes")!;
    assert(
      meeting.promptAddon?.includes("行动项") === true && meeting.mcpPolicy?.deny.includes("drawio-ai") === true,
      "meeting-notes 为完整场景配置（行动项 + 禁 drawio）",
    );
    const projectMgmt = workingPresets.find((p) => p.id === "project-management")!;
    assert(
      projectMgmt.label === "项目管理" &&
        projectMgmt.promptAddon?.includes("责任人") === true &&
        projectMgmt.mcpPolicy?.deny.includes("drawio-ai") === true,
      "project-management 强调责任人对齐",
    );
    const dataAnalysis = workingPresets.find((p) => p.id === "data-analysis")!;
    assert(
      dataAnalysis.label === "数据分析" &&
        dataAnalysis.promptAddon?.includes("口径") === true &&
        (dataAnalysis.recommendedExpertIds ?? []).includes("data-analysis"),
      "data-analysis 强调口径并推荐数据分析专家",
    );
    const drawio = workingPresets.find((p) => p.id === "drawio-ai")!;
    assert(
      drawio.mcpPolicy?.mode === "hard" &&
        drawio.mcpPolicy?.allow.join(",") === "drawio-ai" &&
        drawio.providerMcpIds?.join(",") === "drawio-ai",
      "drawio-ai preset 硬白名单只放行 drawio-ai 且绑定 provider",
    );
    assert(
      drawio.promptAddon?.includes("start_session") && drawio.promptAddon?.includes("export_diagram"),
      "drawio-ai promptAddon 含完整工具链路由（start_session→export_diagram）",
    );
    const generalOffice = workingPresets.find((p) => p.id === "general-office")!;
    assert(generalOffice.skillPolicy?.allow.join(",") === "officecli", "通用办公默认技能白名单包含 officecli");
    const officePolicy = resolveEffectiveModePolicy(MODE_SEEDS.working.policy, generalOffice);
    const officeSkills = filterSkillsForMode([{ id: "officecli", name: "officecli", description: "Office" }, { id: "other", name: "other", description: "Other" }], "working", officePolicy.skillPolicy);
    assert(officeSkills.visible.map(skill => skill.id).join(",") === "officecli", "通用办公实际技能过滤放行 officecli");
    assert(
      JSON.stringify(generalOffice.mcpPolicy?.deny) === JSON.stringify(["drawio-ai"]),
      "general-office deny OFFICE_PROVIDER_MCP_IDS（防 drawio 泄漏）",
    );
    assert(codingPresets.length === 8, "coding 出厂 8 presets（最小模式 + 原 7 个场景）");
    assert(
      codingPresets.map((p) => p.id).join(",") ===
        "minimal,bugfix-test,feature-dev,refactor,add-tests,code-review,plan-design,readonly-explain",
      "coding preset ids（最小模式排第一 + 原 7 个场景）",
    );
    const minimalCoding = codingPresets[0]!;
    assert(
      minimalCoding.id === "minimal" && minimalCoding.label === "最小模式" && !minimalCoding.promptAddon && !minimalCoding.skillPolicy && !minimalCoding.mcpPolicy,
      "minimal 是第一 Tag，且不追加 prompt / skill / MCP 策略",
    );
    assert(
      codingPresets.slice(1).every((p) => p.promptAddon),
      "minimal 之外的 coding presets 保留 promptAddon",
    );
    const codingReview = codingPresets.find((p) => p.id === "code-review")!;
    assert(
      codingReview.skillPolicy?.prefer?.includes("review") === true &&
        codingReview.suggestedPermissionMode === "readonly" &&
        (codingReview.recommendedExpertIds ?? []).includes("code-review-expert"),
      "code-review preset 为完整场景配置（skill/权限/推荐专家）",
    );
    assert(
      codingPresets.find((p) => p.id === "bugfix-test")?.skillPolicy?.prefer?.includes("debug") ===
        true,
      "bugfix-test preset 携带 skillPolicy",
    );
    const featureDev = codingPresets.find((p) => p.id === "feature-dev")!;
    assert(
      featureDev.label === "新功能" &&
        !!featureDev.promptAddon &&
        featureDev.promptAddon.includes("现有仓库") &&
        featureDev.skillPolicy?.prefer?.includes("test") === true,
      "feature-dev 为完整开发场景（贴仓库实现 + 测试）",
    );
    const refactor = codingPresets.find((p) => p.id === "refactor")!;
    assert(
      refactor.promptAddon?.includes("行为必须保持不变") === true &&
        refactor.skillPolicy?.prefer?.includes("refactor") === true,
      "refactor 强调行为不变并偏好 refactor 技能",
    );
    const addTests = codingPresets.find((p) => p.id === "add-tests")!;
    assert(
      addTests.promptAddon?.includes("默认不改生产代码") === true &&
        addTests.skillPolicy?.prefer?.includes("test") === true,
      "add-tests 默认不改生产代码",
    );
    const planDesign = codingPresets.find((p) => p.id === "plan-design")!;
    assert(
      planDesign.suggestedPermissionMode === "readonly" &&
        planDesign.promptAddon?.includes("2–3 个可落地的备选") === true,
      "plan-design 只读方案对比",
    );
    const readonlyExplain = codingPresets.find((p) => p.id === "readonly-explain")!;
    assert(
      readonlyExplain.suggestedPermissionMode === "readonly" &&
        readonlyExplain.promptAddon?.includes("先读真实代码再解释") === true,
      "readonly-explain 禁止臆测、强制读代码",
    );
    assert(designPresets.length === 2, "Bot 出厂 2 个 Tags");
    assert(
      designPresets.map((p) => p.id).join(",") === "native,codemode",
      "Bot Tags = native / codemode",
    );
    assert(
      designPresets.find((p) => p.id === "opendesign") === undefined,
      "opendesign Tag 已退役，不再出厂",
    );
    assert(!designPresets.some((p) => ["general", "web-prototype"].includes(p.id)), "Bot 移除通用设计与 Penpot");
    assert(isKnownModePresetId("working", "web-prototype"), "Penpot 属于日常办公");
    assert(resolveModePresetId("bot", "general") === "native", "旧通用设计回落原生 Tag");
    assert(resolveModePresetId("bot", "web-prototype") === "native", "旧 Bot Penpot 回落原生 Tag");
    // 默认/校验 helper
    assert(defaultModePresetId("working") === "general-office", "working 默认 = general-office（通用办公）");
    assert(defaultModePresetId("coding") === "minimal", "coding 默认 = minimal");
    assert(defaultModePresetId("bot") === "native", "Bot 默认 = native");
    assert(isKnownModePresetId("working", "meeting-notes"), "working 已知 id 校验（会议纪要）");
    assert(isKnownModePresetId("working", "project-management"), "working 已知 id 校验（项目管理）");
    assert(isKnownModePresetId("working", "drawio-ai"), "working 已知 id 校验（drawio-ai）");
    assert(!isKnownModePresetId("working", "inventory-summary"), "库存摘要已退出 working seed");
    assert(resolveModePresetId("working", "inventory-summary") === "general-office", "旧库存摘要 → 通用办公");
    assert(resolveModePresetId("working", "documents") === "general-office", "旧文档 tag → 通用办公");
    assert(!isKnownModePresetId("coding", "ai-ui"), "跨模式 preset id 非法（ai-ui 不属于 coding）");
    assert(!isKnownModePresetId("bot", "code-review"), "跨模式 preset id 非法（code-review 不属于 design）");
    assert(resolveModePresetId("coding", null) === "minimal", "null → 目标模式默认");
    assert(!isKnownModePresetId("bot", "poster"), "旧 poster id 已退出 design seed");
    assert(resolveModePresetId("bot", "poster") === "native", "旧 poster id → design 默认 general");
    assert(resolveModePresetId("bot", "ai-ui") === "native", "旧 ai-ui → general");
    assert(resolveModePresetId("bot", "3d-blender") === "native", "旧 3d-blender → general");
    assert(resolveModePresetId("bot", "mechanical-cad") === "native", "旧 mechanical-cad → general");
    assert(!isKnownModePresetId("bot", "opendesign"), "旧 opendesign id 已退出 design seed");
    assert(resolveModePresetId("bot", "opendesign") === "native", "旧 opendesign → general");
    assert(
      resolveModePresetId("working", "ai-ui") === "general-office",
      "非法跨模式 id → 目标模式默认（不带到别的模式）",
    );
    assert(
      JSON.stringify(MODE_SEED_PRESET_IDS.working) ===
        JSON.stringify([
          "general-office",
          "summary",
          "weekly-report",
          "meeting-notes",
          "project-management",
          "data-analysis",
          "drawio-ai",
          "web-prototype",
        ]),
      "MODE_SEED_PRESET_IDS.working 与出厂一致（8 个）",
    );
  }

  console.log("\n== 1.6 办公 presets：MCP/Skill 收窄合成 ==");
  {
    // 出厂 working base（allow 空）+ drawio-ai => allow 直接采用 preset 白名单
    const workingBase = MODE_SEEDS.working.policy;
    const drawioEff = resolveEffectiveModePolicy(
      workingBase,
      resolveModePreset(workingBase, "drawio-ai"),
    )!;
    assert(
      drawioEff.mcpPolicy.mode === "hard" &&
        JSON.stringify(drawioEff.mcpPolicy.allow) === JSON.stringify(["drawio-ai"]),
      "drawio-ai 合成：mcpPolicy 硬白名单 = [drawio-ai]",
    );
    assert(
      drawioEff.mcpPolicy.deny.includes("serena") && drawioEff.mcpPolicy.deny.includes("codegraph"),
      "drawio-ai 合成：base deny（serena/codegraph）保留（并集）",
    );
    const workingMcp: McpConfig = {
      mcpServers: {
        "drawio-ai": { command: "npx", args: ["@next-ai-drawio/mcp-server@latest"], modes: ["working"] },
        serena: { command: "serena", args: [], modes: ["coding"] },
        weather: { command: "npx", args: ["weather-mcp"] },
      },
    };
    const rDrawio = filterMcpConfigForMode(workingMcp, "working", drawioEff.mcpPolicy);
    assert(
      rDrawio.enabled.join(",") === "drawio-ai",
      `drawio-ai 实际加载：仅 drawio-ai（实际=[${rDrawio.enabled.join(",")}]）`,
    );
    // drawio-ai 条目 modes:["working"] → coding/design 会话自动隐藏
    const rCoding = filterMcpConfigForMode(workingMcp, "coding", workingBase.mcpPolicy);
    assert(!rCoding.enabled.includes("drawio-ai"), "drawio-ai 不泄漏到 coding（modes: working）");
    const rDesign = filterMcpConfigForMode(workingMcp, "bot", workingBase.mcpPolicy);
    assert(!rDesign.enabled.includes("drawio-ai"), "drawio-ai 不泄漏到 design（modes: working）");
    // 非流程图办公 tag => deny drawio-ai
    for (const id of [
      "general-office",
      "summary",
      "weekly-report",
      "meeting-notes",
      "project-management",
      "data-analysis",
    ]) {
      const eff = resolveEffectiveModePolicy(workingBase, resolveModePreset(workingBase, id))!;
      const r = filterMcpConfigForMode(workingMcp, "working", eff.mcpPolicy);
      assert(
        !r.enabled.includes("drawio-ai") && r.reasons["drawio-ai"]?.includes("deny"),
        `${id} 合成：drawio-ai 被 deny（原因=${r.reasons["drawio-ai"] ?? "无"}）`,
      );
    }
    // 技能：weekly-report 偏好周报技能（不额外白名单收窄）
    const weeklyEff = resolveEffectiveModePolicy(workingBase, resolveModePreset(workingBase, "weekly-report"))!;
    assert(
      weeklyEff.skillPolicy.prefer.includes("weekly-report-fill") &&
        weeklyEff.skillPolicy.prefer.includes("周报"),
      "weekly-report 技能偏好 weekly-report-fill / 周报",
    );
    // drawio-ai 无 skillPolicy → 继承 base（不额外收窄技能）
    const drawioEff2 = resolveEffectiveModePolicy(workingBase, resolveModePreset(workingBase, "drawio-ai"))!;
    assert(
      drawioEff2.skillPolicy.allow.length === 0 &&
        JSON.stringify(drawioEff2.skillPolicy) === JSON.stringify(workingBase.skillPolicy),
      "drawio-ai 不额外收窄技能（继承 base；路由在 promptAddon）",
    );
  }

  console.log("\n== 1. resolver：MCP 收窄合成 ==");
  {
    // design + ai-ui（用户 base allow 白名单）=> 交集 = 仅 ardot-local
    const preset = resolveModePreset(USER_BASE, "ai-ui")!;
    const eff = resolveEffectiveModePolicy(USER_BASE, preset);
    assert(
      JSON.stringify(eff.mcpPolicy.allow) === JSON.stringify(["ardot-local"]),
      "design(用户 base) + ai-ui => allow 交集 = 仅 ardot-local",
    );
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      r.enabled.includes("ardot-local") &&
        !r.enabled.includes("penpot") &&
        !r.enabled.includes("canva"),
      "ai-ui 实际加载：ardot-local 在，penpot/canva 不在",
    );
  }
  {
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "web-prototype"));
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      r.enabled.includes("penpot") &&
        !r.enabled.includes("ardot-local") &&
        !r.enabled.includes("blender") &&
        !r.enabled.includes("freecad") &&
        !r.enabled.includes("canva") &&
        !r.enabled.includes("weather"),
      "web-prototype（专业工具 base）=> 仅 penpot",
    );
    // 出厂 base（unrestricted）=> 可收窄到 penpot
    const effSeed = resolveEffectiveModePolicy(SEED_BASE, resolveModePreset(SEED_BASE, "web-prototype"));
    const rSeed = filterMcpConfigForMode(MCP_FULL, "bot", effSeed.mcpPolicy);
    assert(
      rSeed.enabled.includes("penpot") &&
        !rSeed.enabled.includes("ardot-local") &&
        !rSeed.enabled.includes("blender") &&
        !rSeed.enabled.includes("freecad") &&
        !rSeed.enabled.includes("canva"),
      "web-prototype（base 无白名单）=> 仅 penpot",
    );
  }
  {
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "3d-blender"));
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      r.enabled.includes("blender") &&
        !r.enabled.includes("ardot-local") &&
        !r.enabled.includes("penpot") &&
        !r.enabled.includes("freecad") &&
        !r.enabled.includes("canva"),
      "3d-blender => 仅 blender",
    );
    const preset = resolveModePreset(USER_BASE, "3d-blender")!;
    assert(
      preset.providerMcpIds?.join(",") === "blender" &&
        preset.promptAddon?.includes("精密机械 CAD"),
      "3d-blender 元数据明确 Blender 定位与机械 CAD 边界",
    );
  }
  {
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "mechanical-cad"));
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      r.enabled.includes("freecad") &&
        !r.enabled.includes("ardot-local") &&
        !r.enabled.includes("penpot") &&
        !r.enabled.includes("blender") &&
        !r.enabled.includes("canva"),
      "mechanical-cad => 仅 freecad",
    );
    const preset = resolveModePreset(USER_BASE, "mechanical-cad")!;
    assert(
      preset.providerMcpIds?.join(",") === "freecad" &&
        preset.promptAddon?.includes("工程尺寸"),
      "mechanical-cad 元数据明确 FreeCAD 与精确工程尺寸要求",
    );
  }
  {
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "general"));
    assert(
      eff.mcpPolicy.deny.includes("ardot-local") &&
        eff.mcpPolicy.deny.includes("penpot") &&
        !eff.mcpPolicy.deny.includes("blender") &&
        eff.mcpPolicy.deny.includes("freecad") &&
        eff.mcpPolicy.deny.includes("canva") &&
        eff.mcpPolicy.deny.includes("opendesign"),
      "general => deny 受管设计 provider；blender 作为普通 MCP 插件保留",
    );
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      !r.enabled.includes("ardot-local") &&
        !r.enabled.includes("penpot") &&
        r.enabled.includes("blender") &&
        !r.enabled.includes("freecad") &&
        !r.enabled.includes("canva") &&
        !r.enabled.includes("opendesign"),
      "general（用户 base）=> 排除受管设计 provider，已装 blender 仍可用",
    );
    const effSeed = resolveEffectiveModePolicy(SEED_BASE, resolveModePreset(SEED_BASE, "general"));
    const rSeed = filterMcpConfigForMode(MCP_FULL, "bot", effSeed.mcpPolicy);
    assert(
      !rSeed.enabled.includes("ardot-local") &&
        !rSeed.enabled.includes("penpot") &&
        rSeed.enabled.includes("blender") &&
        !rSeed.enabled.includes("freecad") &&
        !rSeed.enabled.includes("canva") &&
        !rSeed.enabled.includes("opendesign") &&
        rSeed.enabled.includes("weather"),
      "general（base 无白名单）=> 排除受管设计 provider，保留 blender 与通用 weather",
    );
  }
  {
    // opendesign preset：只放行 opendesign；coding/working 模式经 entry.modes 隐藏
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "opendesign"));
    assert(
      JSON.stringify(eff.mcpPolicy.allow) === JSON.stringify(["opendesign"]) &&
        eff.mcpPolicy.mode === "hard",
      "opendesign => effective allow 仅 opendesign（base 白名单交集）",
    );
    const r = filterMcpConfigForMode(MCP_FULL, "bot", eff.mcpPolicy);
    assert(
      r.enabled.includes("opendesign") &&
        !r.enabled.includes("ardot-local") &&
        !r.enabled.includes("penpot") &&
        !r.enabled.includes("blender") &&
        !r.enabled.includes("freecad") &&
        !r.enabled.includes("canva"),
      "opendesign 会话 => 仅加载 opendesign MCP（Penpot/Blender/FreeCAD/Ardot 不注入）",
    );
    const rCoding = filterMcpConfigForMode(MCP_FULL, "coding", eff.mcpPolicy);
    assert(!rCoding.enabled.includes("opendesign"), "coding 模式 => opendesign 因 entry.modes=[design] 隐藏");
    const rWorking = filterMcpConfigForMode(MCP_FULL, "working", eff.mcpPolicy);
    assert(!rWorking.enabled.includes("opendesign"), "working 模式 => opendesign 因 entry.modes=[design] 隐藏");
  }
  {
    // preset 不能越过 base deny / allow
    const base = basePolicy({ mcpPolicy: { mode: "hard", allow: ["canva", "ardot-local"], deny: ["weather"] } });
    const expand = resolveEffectiveModePolicy(base, {
      id: "x",
      label: "越权",
      mcpPolicy: { mode: "hard", allow: ["canva", "penpot", "weather"], deny: ["ardot-local"] },
    });
    assert(
      !expand.mcpPolicy.allow.includes("penpot") &&
        !expand.mcpPolicy.allow.includes("weather") &&
        expand.mcpPolicy.allow.includes("canva"),
      "preset.allow 越权项被交集截断（penpot/weather 不进入 effective allow）",
    );
    assert(
      expand.mcpPolicy.deny.includes("weather") && expand.mcpPolicy.deny.includes("ardot-local"),
      "deny 并集：base deny(weather) + preset deny(ardot-local) 都生效",
    );
    assert(expand.mcpPolicy.mode === "hard", "任一侧 hard => effective hard");
  }
  {
    // 部分交集：base [canva, ardot-local] + preset [ardot-local, penpot] => [ardot-local]
    const partialBase = basePolicy({
      mcpPolicy: { mode: "hard", allow: ["canva", "ardot-local"], deny: [] },
    });
    const partial = resolveEffectiveModePolicy(partialBase, {
      id: "y",
      label: "部分交集",
      mcpPolicy: { mode: "hard", allow: ["ardot-local", "penpot"], deny: [] },
    });
    assert(
      JSON.stringify(partial.mcpPolicy.allow) === JSON.stringify(["ardot-local"]),
      "部分交集 => allow 取交集（ardot-local）",
    );
    const r = filterMcpConfigForMode(MCP_FULL, "bot", partial.mcpPolicy);
    assert(
      r.enabled.includes("ardot-local") && !r.enabled.includes("canva") && !r.enabled.includes("penpot"),
      "部分交集实际加载：仅 ardot-local",
    );
  }
  {
    // working/coding 无 preset → 行为不变
    const w = basePolicy();
    const eff = resolveEffectiveModePolicy(w, null);
    assert(
      JSON.stringify(eff.mcpPolicy) === JSON.stringify(w.mcpPolicy) &&
        JSON.stringify(eff.skillPolicy) === JSON.stringify(w.skillPolicy) &&
        eff.promptAddon === null,
      "无 preset => effective 原样 = base（working/coding 行为不变）",
    );
    const unknown = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "not-exist"));
    assert(
      JSON.stringify(unknown.mcpPolicy) === JSON.stringify(USER_BASE.mcpPolicy),
      "未知 preset id => 回落 base（不静默切其它 preset）",
    );
  }

  console.log("\n== 2. resolver：Skill 收窄合成 ==");
  {
    const eff = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "ai-ui"));
    const filt = filterSkillsForMode(SKILLS, "bot", eff.skillPolicy);
    assert(
      filt.visible.some((s) => s.id === "ardot") &&
        filt.visible.some((s) => s.id === "ardot-design-generator") &&
        !filt.visible.some((s) => s.id === "weekly-report"),
      "ai-ui + base allow(ardot 系列) => 交集后仅 ardot 技能可见",
    );
    const effSeed = resolveEffectiveModePolicy(SEED_BASE, resolveModePreset(SEED_BASE, "ai-ui"));
    const filtSeed = filterSkillsForMode(SKILLS, "bot", effSeed.skillPolicy);
    assert(
      filtSeed.visible.length === 2 && !filtSeed.visible.some((s) => s.id === "weekly-report"),
      "ai-ui（base 无白名单）=> 收窄到 ardot 技能",
    );
    const effGeneral = resolveEffectiveModePolicy(USER_BASE, resolveModePreset(USER_BASE, "general"));
    assert(
      JSON.stringify(effGeneral.skillPolicy) === JSON.stringify(USER_BASE.skillPolicy),
      "general => skillPolicy 保持 base",
    );
    // 空交集：base allow [ardot, weekly] + preset allow [weekly] => 交集 [weekly]（部分）
    const sk = resolveEffectiveModePolicy(
      basePolicy({ skillPolicy: { prefer: [], demote: [], hide: [], allow: ["ardot", "weekly-report"] } }),
      { id: "sk", label: "技能", skillPolicy: { prefer: [], demote: [], hide: [], allow: ["weekly-report"] } },
    );
    const skFilt = filterSkillsForMode(SKILLS, "bot", sk.skillPolicy);
    assert(
      skFilt.visible.some((s) => s.id === "weekly-report") &&
        !skFilt.visible.some((s) => s.id === "ardot"),
      "skill 部分交集 => 仅 weekly-report 可见",
    );
    // 空交集：preset allow [x] 与 base allow 无交集 => hide base 全部，可见为空
    const skEmpty = resolveEffectiveModePolicy(
      basePolicy({ skillPolicy: { prefer: [], demote: [], hide: [], allow: ["ardot", "weekly-report"] } }),
      { id: "sk2", label: "技能2", skillPolicy: { prefer: [], demote: [], hide: [], allow: ["none-skill"] } },
    );
    const skEmptyFilt = filterSkillsForMode(SKILLS, "bot", skEmpty.skillPolicy);
    assert(skEmptyFilt.visible.length === 0, "skill 空交集 => 可见为空（不扩大）");
  }

  console.log("\n== 3. assemblePrompt：preset addon + effective policy ==");
  {
    const preset = resolveModePreset(USER_BASE, "web-prototype")!;
    const effective = resolveEffectiveModePolicy(USER_BASE, preset);
    const effProfile = withEffectiveModePolicy(
      {
        id: "bot",
        labelZh: "设计创意",
        version: "1.0.0",
        blocks: [],
        policy: USER_BASE,
        hasUserOverride: true,
        totalChars: 0,
        userDir: "",
        policyPath: "",
      },
      effective,
    );
    const mcpPreview = filterMcpConfigForMode(MCP_FULL, "bot", effective.mcpPolicy);
    const assembly = assemblePrompt({
      welcomeMode: "bot",
      profile: effProfile,
      soul: { name: "Buddy", alias: "你", persona: "务实" },
      permissionMode: "default",
      platform: "win32",
      memoryEnabled: false,
      skills: SKILLS,
      mcpFilter: {
        enabled: mcpPreview.enabled,
        hidden: mcpPreview.hidden,
        reasons: mcpPreview.reasons,
        policyMode: effective.mcpPolicy.mode,
      },
      modePreset: { id: preset.id, label: preset.label, content: preset.promptAddon ?? "" },
    });
    assert(
      assembly.appendParts.some((p) => p.includes("场景预设：网页原型 · Penpot") && p.includes(preset.promptAddon!)),
      "system 装配含 preset promptAddon 段（design）",
    );
    assert(
      preset.promptAddon?.includes("必须优先调用 penpot MCP 工具") &&
        preset.promptAddon.includes("不要跳过 Penpot 只用文字自行设计"),
      "web-prototype prompt 强制优先调用 Penpot MCP",
    );
    assert(
      JSON.stringify(assembly.mcpPolicy.allow) === JSON.stringify(["penpot"]),
      "trace.mcpPolicy 为 effective（web-prototype + 专业工具 base => 仅 penpot）",
    );

    // coding code-review：promptAddon 进入 system 装配（与 createSession 同一路径）
    const codingSeed = MODE_SEEDS.coding.policy;
    const codeReview = resolveModePreset(codingSeed, "code-review")!;
    const effCoding = resolveEffectiveModePolicy(codingSeed, codeReview);
    const effCodingProfile = withEffectiveModePolicy(
      {
        id: "coding",
        labelZh: "代码开发",
        version: "1.0.0",
        blocks: [],
        policy: codingSeed,
        hasUserOverride: false,
        totalChars: 0,
        userDir: "",
        policyPath: "",
      },
      effCoding,
    );
    const cAssembly = assemblePrompt({
      welcomeMode: "coding",
      profile: effCodingProfile,
      soul: { name: "Buddy", alias: "你", persona: "务实" },
      permissionMode: "default",
      platform: "win32",
      memoryEnabled: false,
      skills: [],
      modePreset: { id: codeReview.id, label: codeReview.label, content: codeReview.promptAddon ?? "" },
    });
    assert(
      cAssembly.appendParts.some(
        (p) => p.includes("场景预设：代码审查") && p.includes("独立审查"),
      ),
      "coding code-review promptAddon 进入 system 装配",
    );
    assert(
      JSON.stringify(cAssembly.mcpPolicy) === JSON.stringify(codingSeed.mcpPolicy),
      "code-review 未配置 mcpPolicy => effective 保持 base（无收窄）",
    );

    // working weekly-report：promptAddon 进入 system 装配
    const workingSeed = MODE_SEEDS.working.policy;
    const weekly = resolveModePreset(workingSeed, "weekly-report")!;
    const effWorking = resolveEffectiveModePolicy(workingSeed, weekly);
    const effWorkingProfile = withEffectiveModePolicy(
      {
        id: "working",
        labelZh: "日常办公",
        version: "1.0.0",
        blocks: [],
        policy: workingSeed,
        hasUserOverride: false,
        totalChars: 0,
        userDir: "",
        policyPath: "",
      },
      effWorking,
    );
    const wAssembly = assemblePrompt({
      welcomeMode: "working",
      profile: effWorkingProfile,
      soul: { name: "Buddy", alias: "你", persona: "务实" },
      permissionMode: "default",
      platform: "win32",
      memoryEnabled: false,
      skills: [],
      modePreset: { id: weekly.id, label: weekly.label, content: weekly.promptAddon ?? "" },
    });
    assert(
      wAssembly.appendParts.some(
        (p) => p.includes("场景预设：周报") && p.includes("本周完成"),
      ),
      "working weekly-report promptAddon 进入 system 装配",
    );

    // 无 preset：working 无 preset 段（旧行为不变）
    const wNoPreset = assemblePrompt({
      welcomeMode: "working",
      profile: effWorkingProfile,
      soul: { name: "Buddy", alias: "你", persona: "务实" },
      permissionMode: "default",
      platform: "win32",
      memoryEnabled: false,
      skills: [],
      modePreset: null,
    });
    assert(
      !wNoPreset.appendParts.some((p) => p.includes("场景预设")),
      "无 preset => 无预设段（现有行为不变）",
    );
  }

  console.log("\n== 4. ModeProfileStore 向后兼容（沙箱 HOME）==");
  const store = new ModeProfileStore();
  {
    // 模拟本机现状：design/policy.json 存在但无 presets 字段（用户 Ardot 配置）
    const designPolicyFile = join(sandbox, ".mybuddy", "modes", "bot", "policy.json");
    mkdirSync(join(sandbox, ".mybuddy", "modes", "bot"), { recursive: true });
    writeFileSync(
      designPolicyFile,
      JSON.stringify({
        skillPolicy: {
          prefer: ["bot", "ui"],
          demote: ["deploy"],
          hide: [],
          allow: ["ardot", "ardot-design-assistant", "image-to-ui", "image-understanding-native"],
        },
        toolPolicy: { mode: "soft", prefer: ["read", "write", "edit"], demote: ["bash"], deny: [] },
        mcpPolicy: { mode: "hard", allow: ["canva", "ardot-local"], deny: [] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: ["doc-polish"],
        scenes: [{ label: "线框 HTML", prompt: "线框" }],
      }),
      "utf-8",
    );
    const p = store.getProfile("bot");
    assert(
      p.policy.presets?.length === 3 && p.policy.presets[0]?.id === "legacy-scene-1",
      "旧 policy.json（无 presets，自定义 scenes）=> legacy 场景 + 回退出厂 2 个 seed Tags",
    );
    assert(
      p.policy.mcpPolicy.allow.length === 0 && p.policy.mcpPolicy.deny.length === 0,
      "Bot 去除旧 MCP 黑白名单",
    );
    assert(p.hasUserOverride === true, "hasUserOverride 仍为 true（用户 base 覆盖）");
    assert(
      p.policy.skillPolicy.allow.length === 0,
      "Bot 不保留技能白名单",
    );
    assert(!resolveModePreset(p.policy, "web-prototype"), "Bot 不再补入 Penpot");
    const officePenpot = resolveModePreset(store.getProfile("working").policy, "web-prototype");
    assert(officePenpot?.label === "Penpot", "办公补入 Penpot");
    // 保存 round-trip：presets 随保存落盘
    store.savePolicy("bot", p.policy);
    const after = store.getProfile("bot");
    assert(after.policy.presets?.length === 3, "savePolicy 后 presets 保留（legacy + seed）");
    const disk = JSON.parse(readFileSync(designPolicyFile, "utf-8"));
    assert(Array.isArray(disk.presets) && disk.presets.length === 3, "policy.json 落盘含 presets");
    assert(disk.mcpPolicy.allow.length === 0, "保存后的 Bot 不包含旧名单");
  }

  // working/coding：旧 policy.json（无 presets）向后兼容
  {
    const wFile = join(sandbox, ".mybuddy", "modes", "working", "policy.json");
    mkdirSync(join(sandbox, ".mybuddy", "modes", "working"), { recursive: true });
    // 模拟本机现状：scenes 与出厂完全一致、无 presets 字段
    writeFileSync(
      wFile,
      JSON.stringify({
        skillPolicy: { prefer: ["周报"], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: ["serena"] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: MODE_SEEDS.working.policy.scenes,
      }),
      "utf-8",
    );
    const working = store.getProfile("working");
    assert(
      (working.policy.presets ?? []).map((p) => p.id).join(",") ===
        "general-office,summary,weekly-report,meeting-notes,project-management,data-analysis,drawio-ai,web-prototype",
      "working 旧 policy（无 presets，scenes=出厂）=> 回退出厂 presets（8 个）",
    );
    assert(working.policy.scenes.length === 3, "scenes 字段仍保留（兼容）");
    const wDisk = JSON.parse(readFileSync(wFile, "utf-8"));
    assert(
      !Array.isArray(wDisk.presets),
      "getProfile 不重写旧 policy.json（磁盘仍无 presets 字段）",
    );
  }
  {
    // Unchanged previous defaults adopt OfficeCLI; custom lists remain intact and reads do not write disk.
    const wFile = join(sandbox, ".mybuddy", "modes", "working", "policy.json");
    const before = readFileSync(wFile, "utf8");
    const prior = structuredClone(MODE_SEEDS.working.policy);
    prior.skillPolicy.allow = ["my-custom"];
    const general = prior.presets!.find(preset => preset.id === "general-office")!;
    general.skillPolicy!.allow = [];
    writeFileSync(wFile, JSON.stringify(prior));
    const upgraded = store.getProfile("working");
    assert(resolveModePreset(upgraded.policy, "general-office")?.skillPolicy?.allow.join(",") === "officecli", "旧通用办公默认白名单读时更新");
    assert(upgraded.policy.skillPolicy.allow.includes("my-custom") && upgraded.policy.skillPolicy.allow.includes("officecli"), "旧 base 白名单补入 officecli 并保留已有条目");
    assert(JSON.parse(readFileSync(wFile, "utf8")).presets.find((p: ModePresetDto) => p.id === "general-office").skillPolicy.allow.length === 0, "默认升级不改写磁盘");
    general.skillPolicy!.allow = ["my-custom"];
    writeFileSync(wFile, JSON.stringify(prior));
    assert(resolveModePreset(store.getProfile("working").policy, "general-office")?.skillPolicy?.allow.join(",") === "my-custom", "保留通用办公自定义白名单");
    writeFileSync(wFile, before);
  }
  {
    // 升级语义：磁盘已有 presets 数组（如本机 3 个 legacy）→ 只增不改并入出厂新增 seed preset
    const wFile = join(sandbox, ".mybuddy", "modes", "working", "policy.json");
    writeFileSync(
      wFile,
      JSON.stringify({
        skillPolicy: { prefer: ["周报"], demote: [], hide: [], allow: ["fastcopy-copy", "officecli"] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: ["serena", "codegraph"] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [],
        presets: MODE_SEEDS.working.policy.presets!.slice(0, 3), // 仅前 3 个出厂
      }),
      "utf-8",
    );
    const merged = store.getProfile("working");
    const ids = (merged.policy.presets ?? []).map((p) => p.id);
    assert(ids.length === 8, `seed 并入：磁盘 3 个 + 新增 5 个 = 8（实际=${ids.length}）`);
    assert(
      JSON.stringify(merged.policy.skillPolicy.allow) === JSON.stringify(["fastcopy-copy", "officecli"]),
      "seed 并入不覆盖用户 base 个性化（skillPolicy.allow 保留）",
    );
    const userWeekly = merged.policy.presets?.find((p) => p.id === "weekly-report");
    assert(userWeekly?.promptAddon?.includes("本周完成"), "用户同名 preset 不被 seed 覆盖");
    const mergedDrawio = merged.policy.presets?.find((p) => p.id === "drawio-ai");
    assert(mergedDrawio?.providerMcpIds?.join(",") === "drawio-ai", "并入的 drawio-ai 带 providerMcpIds");
  }
  {
    // 退役 tag：磁盘上的库存摘要/文档/表格/演示文稿读时剔除，并补上新出厂 tag
    const wFile = join(sandbox, ".mybuddy", "modes", "working", "policy.json");
    writeFileSync(
      wFile,
      JSON.stringify({
        skillPolicy: { prefer: ["周报"], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: ["serena", "codegraph"] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [],
        presets: [
          { id: "inventory-summary", label: "库存摘要", promptAddon: "旧库存" },
          { id: "documents", label: "文档", promptAddon: "旧文档" },
          { id: "weekly-report", label: "周报结构", promptAddon: "本周完成：旧版" },
        ],
      }),
      "utf-8",
    );
    const pruned = store.getProfile("working");
    const prunedIds = (pruned.policy.presets ?? []).map((p) => p.id);
    assert(
      !prunedIds.includes("inventory-summary") && !prunedIds.includes("documents"),
      "退役 working tag 读时从列表剔除",
    );
    assert(prunedIds.includes("weekly-report"), "未退役的用户 weekly-report 保留");
    assert(
      prunedIds.includes("project-management") && prunedIds.includes("data-analysis"),
      "退役后补入项目管理 / 数据分析",
    );
    const keptWeekly = pruned.policy.presets?.find((p) => p.id === "weekly-report");
    assert(keptWeekly?.promptAddon?.includes("旧版"), "用户同名 weekly-report 不被 seed 覆盖");
  }
  {
    // 用户自定义 scenes => 运行时转 promptAddon-only legacy presets（tag 不消失）
    const cFile = join(sandbox, ".mybuddy", "modes", "coding", "policy.json");
    mkdirSync(join(sandbox, ".mybuddy", "modes", "coding"), { recursive: true });
    writeFileSync(
      cFile,
      JSON.stringify({
        skillPolicy: { prefer: [], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: [] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [{ label: "我的自定义场景", prompt: "自定义提示词" }],
      }),
      "utf-8",
    );
    const coding = store.getProfile("coding");
    const legacy = coding.policy.presets ?? [];
    assert(
      legacy.some(
        (p) =>
          p.id === "legacy-scene-1" &&
          p.label === "我的自定义场景" &&
          p.promptAddon === "自定义提示词",
      ),
      "用户自定义 scenes => 运行时转 legacy preset（保留标签与提示词）",
    );
    assert(
      legacy.some((p) => p.id === "bugfix-test") && legacy.some((p) => p.id === "code-review"),
      "legacy 场景与出厂 seed preset 并存（tag 不消失、能力不缩水）",
    );
    assert(
      resolveEffectiveModePolicy(coding.policy, legacy.find((p) => p.id === "legacy-scene-1"))?.promptAddon === "自定义提示词",
      "legacy preset 合成生效（promptAddon 透出）",
    );
    // 用户自带 presets => 用户 presets 优先
    writeFileSync(
      cFile,
      JSON.stringify({
        skillPolicy: { prefer: [], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: [] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [{ label: "旧场景", prompt: "旧提示" }],
        presets: [{ id: "my-preset", label: "我的预设", promptAddon: "我的提示词" }],
      }),
      "utf-8",
    );
    const coding2 = store.getProfile("coding");
    assert(
      coding2.policy.presets?.length === 9 && coding2.policy.presets[0]?.id === "minimal" && coding2.policy.presets.at(-1)?.id === "my-preset",
      "用户自带 presets => minimal 固定第一 + 用户 preset 保留 + 缺失 seed 并入",
    );
    assert(
      coding2.policy.presets?.map((p) => p.id).join(",") ===
        "minimal,bugfix-test,feature-dev,refactor,add-tests,code-review,plan-design,readonly-explain,my-preset",
      "并入顺序：minimal 和其余 seed 在前，用户自定义项保留在 seed 区块之后",
    );
  }

  console.log("\n== 4.1 出厂技能 base allow 回补（旧配置迁移，P2-1）==");
  {
    // 旧配置迁移：design base allow 非空但缺新出厂技能（blender-* / freecad）
    const dFile = join(sandbox, ".mybuddy", "modes", "bot", "policy.json");
    writeFileSync(
      dFile,
      JSON.stringify({
        skillPolicy: {
          prefer: ["bot", "ui"],
          demote: ["deploy"],
          hide: [],
          allow: ["ardot", "ardot-design-assistant", "image-to-ui", "image-understanding-native", "simplecadapi"],
        },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: ["serena", "codegraph"] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [],
      }),
      "utf-8",
    );
    const migrated = store.getProfile("bot");
    const baseAllow = migrated.policy.skillPolicy.allow;
    for (const name of ["ardot", "ardot-design-assistant", "image-to-ui", "image-understanding-native", "simplecadapi"]) {
      assert(!baseAllow.includes(name), `Bot 去除旧技能白名单 ${name}`);
    }
    assert(
      !baseAllow.includes("blender-core") && !baseAllow.includes("freecad"),
      "已退役 Tag 的出厂技能不再补入 base allow",
    );
    assert(resolveModePreset(migrated.policy, "3d-blender") === undefined, "3d-blender 已退役，不在 profile");
    // 读时回补不落盘（磁盘保持用户原样）
    const dDisk = JSON.parse(readFileSync(dFile, "utf-8"));
    assert(dDisk.skillPolicy.allow.length === 5, "getProfile 不重写旧 policy.json（磁盘 base allow 仍 5 项）");
  }
  {
    // 新安装 / 删除 policy 重建：base allow 为空 → 不凭空创建白名单
    const dFile = join(sandbox, ".mybuddy", "modes", "bot", "policy.json");
    writeFileSync(
      dFile,
      JSON.stringify({
        skillPolicy: { prefer: ["bot"], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: [] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [],
      }),
      "utf-8",
    );
    const emptyAllow = store.getProfile("bot");
    assert(emptyAllow.policy.skillPolicy.allow.length === 0, "base allow 为空时不补全（不创建白名单）");
  }

  console.log("\n== 4.2 preset skillPolicy 字段级回补（P3-3 repo 断言）==");
  {
    const dFile = join(sandbox, ".mybuddy", "modes", "bot", "policy.json");
    writeFileSync(
      dFile,
      JSON.stringify({
        skillPolicy: { prefer: ["bot"], demote: [], hide: [], allow: [] },
        toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
        mcpPolicy: { mode: "hard", allow: [], deny: [] },
        suggestedModelId: null,
        suggestedPermissionMode: null,
        recommendedExpertIds: [],
        scenes: [],
        presets: [
          {
            id: "3d-blender",
            label: "3D · Blender",
            description: "x",
            mcpPolicy: { mode: "hard", allow: ["blender"], deny: [] },
            providerMcpIds: ["blender"],
          },
          {
            id: "ai-ui",
            label: "AI UI",
            description: "x",
            skillPolicy: { prefer: [], demote: [], hide: [], allow: ["my-custom"] },
            mcpPolicy: { mode: "hard", allow: ["ardot-local"], deny: [] },
            providerMcpIds: ["ardot-local"],
          },
          {
            id: "opendesign",
            label: "AI 设计引擎 · OpenDesign",
            description: "x",
            mcpPolicy: { mode: "hard", allow: ["opendesign"], deny: [] },
            providerMcpIds: ["opendesign"],
          },
        ],
      }),
      "utf-8",
    );
    const p2 = store.getProfile("bot");
    assert(
      ["3d-blender", "ai-ui", "opendesign"].every(id => p2.policy.presets?.some(x => x.id === id && !x.mcpPolicy && !x.skillPolicy && !x.providerMcpIds)),
      "Bot 保留原 Tag 并去除其门禁策略",
    );
    assert(
      !p2.policy.presets?.some((x) => x.id === "web-prototype"),
      "Bot 不再并入 Penpot",
    );
  }

  console.log("\n== 5. AppDatabase：modePresetId round-trip ==");
  {
    const dbPath = join(sandbox, "db-test", "app.db");
    mkdirSync(join(sandbox, "db-test"), { recursive: true });
    const db = new AppDatabase(dbPath);
    db.upsertTask({
      id: "t1",
      title: "设计任务",
      updatedAt: 1,
      welcomeMode: "bot",
      modePresetId: "ai-ui",
    });
    const loaded = db.listTasks().find((t) => t.id === "t1");
    assert(loaded?.modePresetId === "ai-ui", "upsert → load round-trip：modePresetId=ai-ui");
    assert(loaded?.welcomeMode === "bot", "welcomeMode 同步");
    // 未传字段 → 保留旧值（rename 等路径不清 preset）
    db.upsertTask({ id: "t1", title: "改名", updatedAt: 2 });
    assert(db.listTasks().find((t) => t.id === "t1")?.modePresetId === "ai-ui", "未传 modePresetId 保留旧值");
    // 显式 null → 清除
    db.upsertTask({ id: "t1", title: "改名", updatedAt: 3, modePresetId: null });
    assert(db.listTasks().find((t) => t.id === "t1")?.modePresetId === undefined, "显式 null 清除 preset");
    // 旧任务（无字段）正常加载
    db.upsertTask({ id: "t2", title: "旧任务", updatedAt: 4, welcomeMode: "coding" });
    const old = db.listTasks().find((t) => t.id === "t2");
    assert(old?.modePresetId === undefined && old?.welcomeMode === "coding", "旧任务无字段正常加载");
    // 迁移幂等：同一连接再开一次不报错
    const db2 = new AppDatabase(dbPath);
    assert(db2.listTasks().some((t) => t.id === "t1"), "迁移幂等：重复打开正常");
    (db2 as unknown as { db: { close(): void } }).db.close();
    (db as unknown as { db: { close(): void } }).db.close();
  }

  console.log("\n== 6. buildPresetBarChips: current UI gate ==");
  {
    // This gate follows current design seeds; retired tags must not become a second source of truth.
    const designPresets = MODE_SEEDS.bot.policy.presets ?? [];
    const chips = buildPresetBarChips({
      presets: designPresets,
      selectedPresetId: "native",
      availableMcpServerNames: new Set(),
      locked: false,
    });
    assert(chips.length === 2, "Bot renders native/codemode");
    assert(chips.find((c) => c.id === "native")?.selected === true, "native selected");
    assert(chips.find((c) => c.id === "native")?.disabled === false, "native always enabled");
    assert(chips.find((c) => c.id === "codemode")?.disabled === false, "Bot Tags do not depend on MCP installation");
    assert(!chips.find((c) => c.id === "codemode")?.title?.includes("缺少"), "Bot has no provider gate");
    assert(!chips.some((c) => ["ai-ui", "3d-blender", "mechanical-cad", "opendesign"].includes(c.id)), "retired design tags stay absent from current UI");
    const lockedChips = buildPresetBarChips({
      presets: designPresets,
      selectedPresetId: "native",
      availableMcpServerNames: new Set(["penpot"]),
      locked: true,
    });
    assert(lockedChips.every((c) => c.disabled), "locked task disables all chips");
    assert(Boolean(lockedChips[0]?.title), "locked chip keeps an explanatory title");
    const allAvail = buildPresetBarChips({
      presets: designPresets,
      selectedPresetId: "native",
      availableMcpServerNames: new Set(["penpot"]),
      locked: false,
    });
    assert(allAvail.every((c) => !c.disabled), "current design chips enabled when required provider exists");

    // working presets：legacy + 完整办公；drawio-ai 依赖 MCP 配置，其余无 MCP 依赖始终可选
    const workingChips = buildPresetBarChips({
      presets: MODE_SEEDS.working.policy.presets ?? [],
      selectedPresetId: "weekly-report",
      availableMcpServerNames: new Set(),
      locked: false,
    });
    assert(
      workingChips.length === 8 &&
        workingChips.filter((c) => !c.disabled).length === 6 &&
        workingChips.find((c) => c.id === "weekly-report")?.selected === true,
      "working chips：8 个，非 provider 的 6 个始终可选 + 选中态",
    );
    const drawioChip = workingChips.find((c) => c.id === "drawio-ai");
    assert(
      drawioChip?.disabled === true && (drawioChip.title ?? "").includes("Draw.io AI MCP"),
      "drawio-ai 未配置 MCP => disabled + title 提示 Draw.io AI MCP（不 silent fallback）",
    );
    const drawioEnabled = buildPresetBarChips({
      presets: MODE_SEEDS.working.policy.presets ?? [],
      selectedPresetId: "general-office",
      availableMcpServerNames: new Set(["drawio-ai"]),
      locked: false,
    }).find((c) => c.id === "drawio-ai");
    assert(drawioEnabled?.disabled === false, "drawio-ai MCP 已配置 => chip 可选");
    const codingChips = buildPresetBarChips({
      presets: MODE_SEEDS.coding.policy.presets ?? [],
      selectedPresetId: "code-review",
      availableMcpServerNames: new Set(),
      locked: true,
    });
    assert(
      codingChips.length === 8 && codingChips.every((c) => c.disabled),
      "coding locked => 全部 disabled（与 design 同语义）",
    );
  }

  console.log("\n== 7.5 HomeHero 静态 gate：不再有 scene prompt 填输入框 ==");
  {
    const src = readFileSync(
      join(process.cwd(), "src/renderer/src/components/chat/ChatView.tsx"),
      "utf-8",
    );
    assert(!src.includes("setDraftFill"), "HomeHero 无 setDraftFill（不再写输入框）");
    assert(!src.includes("draftFill"), "HomeHero 无 draftFill 状态");
    assert(!src.includes('className="scene-chip"'), "无旧 scenes chip 渲染分支");
    assert(src.includes("presetChips.map"), "三模式统一渲染 presetChips");
    assert(
      src.includes("buildPresetBarChips") &&
        src.includes("setModePreset(presetId)") &&
        src.includes("onClick={() => selectPreset(chip.id)}"),
      "点击链路统一走 selectPreset → setModePreset，不写输入框",
    );
    assert(
      !src.includes("professionalTools?.prepare") && !src.includes("professionalTools?.open"),
      "专业 design provider 点击 tag 不预热/不 open，发送建会话时再启动",
    );
  }

  console.log("\n== 7.6 InputAddMenu 静态 gate：+ 菜单按 base⊕preset effective policy 收窄 ==");
  {
    const src = readFileSync(
      join(process.cwd(), "src/renderer/src/components/chat/InputAddMenu.tsx"),
      "utf-8",
    );
    assert(
      src.includes("resolveModePreset") && src.includes("resolveEffectiveModePolicy"),
      "复用 shared 纯函数（resolveModePreset + resolveEffectiveModePolicy），不在渲染层重写 compose",
    );
    assert(
      src.includes("task?.modePresetId ?? modePresetId ?? null"),
      "选中 preset = 任务 preset（锁定语义）或全局 selection（与 HomeHero 一致）",
    );
    assert(
      src.includes("isSkillVisibleForMode(s, welcomeMode, effSkillPolicy") &&
        src.includes("isMcpVisibleForMode(s.name, welcomeMode, effMcpPolicy"),
      "技能/MCP 可见性按 effective policy（不是 base）过滤",
    );
    assert(
      !src.includes("getModeProfile(welcomeMode)"),
      "不再直接以 base policy 为唯一过滤依据",
    );
  }

  console.log("\n== 7. appStore：preset 切换/锁定/透传 ==");
  {
    // 动态 import：window.api mock 需在 store 模块初始化之后挂上（theme 初始值依赖 typeof window）
    const mod = await import("../src/renderer/src/store/appStore");
    const useAppStore = mod.useAppStore;
    const upserts: Array<Record<string, unknown>> = [];
    let capturedReq: Record<string, unknown> | null = null;
    let listedTasks: Array<Record<string, unknown>> = [];
    (globalThis as unknown as { window: unknown }).window = {
      api: {
        agent: {
          prompt: async (req: Record<string, unknown>): Promise<void> => {
            capturedReq = req;
          },
        },
        db: {
          upsertTask: (t: Record<string, unknown>): void => {
            upserts.push(t);
          },
          listTasks: async (): Promise<unknown[]> => listedTasks,
        },
      },
    };
    const base = {
      welcomeMode: "coding",
      modePresetId: defaultModePresetId("coding"),
      activeTaskId: null,
      tasks: [],
      draft: null,
      homeSpaceId: null,
      spaces: [],
      models: [],
      activeModelId: "m",
      permissionMode: "default",
    } as const;
    useAppStore.setState(base as never);
    assert(
      useAppStore.getState().modePresetId === "minimal" &&
        isKnownModePresetId("coding", useAppStore.getState().modePresetId),
      "初始全局 selection 对初始模式合法（coding → minimal）",
    );

    // 空任务自由切换 preset（design）
    const emptyTask = {
      id: "t-empty",
      title: "空设计任务",
      updatedAt: Date.now(),
      messages: [],
      welcomeMode: "bot",
      modePresetId: "native",
    };
    useAppStore.setState({ tasks: [emptyTask as never], activeTaskId: "t-empty", welcomeMode: "bot", modePresetId: "native" });
    useAppStore.getState().setModePreset("codemode");
    const t = useAppStore.getState().tasks.find((x) => x.id === "t-empty");
    assert(t?.modePresetId === "codemode", "空任务 setModePreset 更新任务");
    assert(useAppStore.getState().modePresetId === "codemode", "全局 selection 同步");
    assert(
      upserts.some((u) => u.id === "t-empty" && u.modePresetId === "codemode"),
      "setModePreset 持久化 upsertTask.modePresetId",
    );

    // Bot can change tool mode after messages; ordinary coding keeps its existing lock.
    upserts.length = 0;
    const startedBot = { ...emptyTask, messages: [{ id: "m1" }] };
    useAppStore.setState({ tasks: [startedBot as never], activeTaskId: "t-empty" });
    useAppStore.getState().setModePreset("codemode");
    assert(useAppStore.getState().tasks[0]?.modePresetId === "codemode", "已开始的 Bot 可切 Code Mode");
    assert(upserts.some(u => u.id === "t-empty" && u.modePresetId === "codemode"), "Bot Tag 切换持久化");
    const lockedTask = { id: "t-locked", title: "有会话任务", updatedAt: Date.now(),
      messages: [{ id: "m1" }], welcomeMode: "coding", modePresetId: "minimal", sessionFile: "/tmp/s.jsonl" };
    upserts.length = 0;
    useAppStore.setState({ tasks: [lockedTask as never], activeTaskId: "t-locked" });
    useAppStore.getState().setModePreset("code-review");
    assert(useAppStore.getState().tasks[0]?.modePresetId === "minimal", "代码开发任务仍锁定 preset");
    assert(upserts.length === 0, "锁定的代码开发任务不写库");

    // 跨模式切换（空任务）：目标模式始终拿到合法默认 preset
    upserts.length = 0;
    useAppStore.setState({ tasks: [emptyTask as never], activeTaskId: "t-empty", welcomeMode: "bot", modePresetId: "codemode" });
    useAppStore.getState().setWelcomeMode("working");
    const wt = useAppStore.getState().tasks.find((x) => x.id === "t-empty");
    assert(
      wt?.welcomeMode === "working" && wt?.modePresetId === "general-office",
      "design → working：任务 preset = working 默认（general-office，不再携带 design preset）",
    );
    assert(
      upserts.some((u) => u.id === "t-empty" && u.modePresetId === "general-office"),
      "切模式持久化 working 合法 preset（general-office）",
    );
    useAppStore.getState().setModePreset("weekly-report");
    useAppStore.getState().setWelcomeMode("coding");
    assert(
      useAppStore.getState().modePresetId === "minimal" &&
        isKnownModePresetId("coding", useAppStore.getState().modePresetId),
      "working → coding：全局 = coding 默认（minimal），不带 weekly-report",
    );
    useAppStore.getState().setWelcomeMode("bot");
    assert(
      useAppStore.getState().modePresetId === "native" &&
        isKnownModePresetId("bot", useAppStore.getState().modePresetId),
      "coding → design：全局 = design 默认（general）",
    );
    // 重选当前模式：保留 selection
    useAppStore.getState().setModePreset("codemode");
    useAppStore.getState().setWelcomeMode("bot");
    assert(
      useAppStore.getState().modePresetId === "codemode",
      "重选当前模式 => 保留已有 selection（web-prototype）",
    );

    // 锁定任务上切顶层模式：任务不动，全局对新模式合法
    useAppStore.setState({ tasks: [lockedTask as never], activeTaskId: "t-locked" });
    useAppStore.getState().setWelcomeMode("coding");
    const lt2 = useAppStore.getState().tasks.find((x) => x.id === "t-locked");
    assert(lt2?.modePresetId === "minimal" && lt2?.welcomeMode === "coding", "锁定任务上切模式：任务不变");
    assert(
      useAppStore.getState().welcomeMode === "coding" &&
        useAppStore.getState().modePresetId === "minimal",
      "锁定任务上切模式：全局对新模式合法（不能把 design preset 带到 coding）",
    );

    // duplicateTaskWithMode：同模式带 selection；跨模式取目标模式默认
    useAppStore.setState({ tasks: [emptyTask as never], activeTaskId: "t-empty", welcomeMode: "bot", modePresetId: "codemode" });
    useAppStore.getState().duplicateTaskWithMode("bot");
    const dup = useAppStore.getState().tasks[0];
    assert(dup?.modePresetId === "codemode" && dup?.id !== "t-empty", "复制为 design 任务携带当前 selection");
    useAppStore.getState().duplicateTaskWithMode("coding");
    const dupCoding = useAppStore.getState().tasks[0];
    assert(dupCoding?.modePresetId === "minimal", "复制为 coding 任务 preset = coding 默认（合法）");
    useAppStore.getState().duplicateTaskWithMode("working");
    const dupWorking = useAppStore.getState().tasks[0];
    assert(
      dupWorking?.modePresetId === "general-office",
      "复制为 working 任务 preset = working 默认（general-office，合法）",
    );

    // setActiveTask：全局 selection 跟随任务（任务无 preset 时回落该模式默认）
    useAppStore.setState({ tasks: [lockedTask as never], activeTaskId: null, welcomeMode: "coding", modePresetId: "bugfix-test" });
    useAppStore.getState().setActiveTask("t-locked");
    assert(
      useAppStore.getState().modePresetId === "minimal",
      "setActiveTask：全局跟随任务 preset（coding -> minimal）",
    );
    const oldTask = {
      id: "t-old",
      title: "旧任务",
      updatedAt: Date.now(),
      messages: [],
      welcomeMode: "coding",
      // 无 modePresetId（旧任务）
    };
    useAppStore.setState({ tasks: [oldTask as never], activeTaskId: null, welcomeMode: "bot", modePresetId: "codemode" });
    useAppStore.getState().setActiveTask("t-old");
    assert(
      useAppStore.getState().modePresetId === "minimal",
      "setActiveTask：任务无 preset => 全局回落该模式默认（coding → minimal）",
    );

    // Android/外部客户端创建任务：首个 patch 只能造消息壳，随后必须从 DB 补齐权威 mode/tag。
    listedTasks = [{
      id: "remote-working",
      title: "Android 新任务",
      updatedAt: Date.now(),
      welcomeMode: "working",
      modePresetId: "general-office",
      permissionMode: "auto",
      archived: false,
      isFavorited: false,
      spaceSortOrder: 0,
    }];
    useAppStore.setState({ tasks: [], activeTaskId: null, welcomeMode: "coding", modePresetId: "bugfix-test" });
    useAppStore.getState().applyAgentPatch({
      type: "user_message",
      taskId: "remote-working",
      messageId: "remote-user-1",
      text: "来自安卓的新任务",
      createdAt: Date.now(),
    } as never);
    // 模拟用户在 DB hydration 返回前立即点击刚出现的任务。
    useAppStore.getState().setActiveTask("remote-working");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const remoteTask = useAppStore.getState().tasks.find((item) => item.id === "remote-working");
    assert(remoteTask?.welcomeMode === "working", "外部新任务 patch 后从 DB 补齐日常办公 mode");
    assert(remoteTask?.modePresetId === "general-office", "外部新任务 patch 后从 DB 补齐通用办公 Tag");
    assert(
      useAppStore.getState().welcomeMode === "working" && useAppStore.getState().modePresetId === "general-office",
      "外部任务 hydration 返回后，当前 PC UI 同步为日常办公 / 通用办公",
    );
    listedTasks = [];

    // sendMessage：working 首条消息 → prompt req.modePresetId + upsertTask 携带（不再 design-only）
    capturedReq = null;
    upserts.length = 0;
    useAppStore.setState({
      tasks: [],
      activeTaskId: null,
      draft: null,
      welcomeMode: "working",
      modePresetId: "weekly-report",
      homeSpaceId: null,
      spaces: [],
    });
    await useAppStore.getState().sendMessage("帮我写周报", [], undefined);
    assert(
      capturedReq?.modePresetId === "weekly-report",
      "sendMessage（working）→ agent.prompt req.modePresetId = weekly-report",
    );
    assert(
      upserts.some((u) => u.welcomeMode === "working" && u.modePresetId === "weekly-report"),
      "sendMessage → upsertTask 携带 modePresetId（working）",
    );
    // sendMessage：design 首条消息仍正确
    capturedReq = null;
    upserts.length = 0;
    useAppStore.setState({
      tasks: [],
      activeTaskId: null,
      draft: null,
      welcomeMode: "bot",
      modePresetId: "native",
      homeSpaceId: null,
      spaces: [],
    });
    await useAppStore.getState().sendMessage("帮我设计一张海报", [], undefined);
    assert(
      capturedReq?.modePresetId === "native",
      "sendMessage（bot）→ agent.prompt req.modePresetId = native",
    );
  }

  console.log(`\n[mode-preset-test] ${passed} passed, ${failed} failed`);
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
