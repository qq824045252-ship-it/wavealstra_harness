/**
 * ModeProfileStore 单测：种子加载 / 用户覆盖 / 恢复出厂 / system 段。
 * 使用临时 USERPROFILE，不触碰真实 ~/.mybuddy。
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), `mybuddy-mode-test-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
mkdirSync(sandbox, { recursive: true });

// eslint-disable-next-line import/first
import { ModeProfileStore } from "../src/main/agent/ModeProfileStore";
import previousModeBlocks from "../src/main/agent/previous-mode-blocks.json";
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
// eslint-disable-next-line import/first
import { assemblePrompt, resolveSessionTools } from "../src/main/agent/PromptAssembly";
// eslint-disable-next-line import/first
import { filterSkillsForMode } from "../src/main/agent/SkillPolicy";

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

async function main(): Promise<void> {
  console.log("[mode-profile-test] sandbox:", sandbox);
  const legacyBotDir = join(sandbox, ".mybuddy", "modes", "bot");
  mkdirSync(legacyBotDir, { recursive: true });
  writeFileSync(join(legacyBotDir, "goal.md"), "LEGACY_BOT_GOAL");
  writeFileSync(join(legacyBotDir, "policy.json"), JSON.stringify({ presets: [{ id: "legacy-tag", label: "Legacy", botToolMode: "codemode" }] }));
  writeFileSync(join(legacyBotDir, "README.md"), "# Bot（bot）\n\nlegacy readme\n");
  const store = new ModeProfileStore();

  console.log("\n1. 种子加载");
  const working = store.getProfile("working");
  assert(working.labelZh === "日常办公", "working 标签");
  assert(working.blocks.length === 5, "5 个文案块");
  assert(working.blocks.every((b) => b.source === "seed"), "初始全为 seed（与出厂一致）");
  assert(working.hasUserOverride === false, "无用户覆盖");
  assert(working.blocks.every((b) => b.filePath && b.filePath.endsWith(".md")), "文案块暴露 filePath");
  assert(!!working.policyPath && working.policyPath.endsWith("policy.json"), "暴露 policyPath");
  assert(store.buildSystemSection("working").includes("日常办公"), "system 段含场景名");
  // 磁盘已物化
  const { existsSync } = await import("node:fs");
  assert(existsSync(working.blocks[0]!.filePath), "goal.md 已写入磁盘");
  assert(working.policy.mcpPolicy.mode === "hard", "working mcp hard");
  assert(
    working.policy.mcpPolicy.deny.includes("serena") &&
      working.policy.mcpPolicy.deny.includes("codegraph"),
    "working 默认 deny serena/codegraph",
  );
  assert(working.policy.artifactPolicy.mode === "hard", "working 产物 hard");
  assert(
    working.policy.artifactPolicy.deny.includes("py") &&
      working.policy.artifactPolicy.deny.includes("ts"),
    "working 默认禁 py/ts 等代码产物",
  );
  assert(
    Array.isArray(working.policy.artifactPolicy.allow) &&
      working.policy.artifactPolicy.allow.length === 0,
    "working 默认白名单空（不启用）",
  );
  const codingSeed = store.getProfile("coding");
  assert(codingSeed.policy.mcpPolicy.deny.length === 0, "coding 默认不 deny MCP");
  assert(codingSeed.policy.artifactPolicy.deny.length === 0, "coding 默认不限制产物扩展名");
  assert(codingSeed.policy.artifactPolicy.allow.length === 0, "coding 默认白名单空");
  const bot = store.getProfile("general");
  assert(bot.labelZh === "通用模式", "通用模式标签");
  const legacyBotDirAfter = join(sandbox, ".mybuddy", "modes", "bot");
  const generalDir = join(sandbox, ".mybuddy", "modes", "general");
  assert(!existsSync(legacyBotDirAfter) && existsSync(generalDir), "modes/bot 目录迁移为 modes/general");
  assert(bot.blocks.find(b => b.id === "goal")?.content === "LEGACY_BOT_GOAL", "迁移保留用户 goal.md");
  assert(bot.policy.presets?.find(p => p.id === "legacy-tag")?.durableToolMode === "codemode", "迁移 botToolMode 为 durableToolMode");
  const migratedReadme = (await import("node:fs")).readFileSync(join(generalDir, "README.md"), "utf-8");
  assert(migratedReadme.startsWith("# 通用模式（general）"), "迁移 README 标题");
  assert(bot.policy.skillPolicy.allow.length === 0 && bot.policy.skillPolicy.hide.length === 0, "Bot 不应用技能名单");
  assert(bot.policy.mcpPolicy.allow.length === 0 && bot.policy.mcpPolicy.deny.length === 0, "Bot 不应用 MCP 名单");
  assert(bot.policy.toolPolicy.deny.length === 0, "Bot 不拦截原生工具");
  assert(bot.policy.artifactPolicy.unfiltered === true, "Bot 不过滤产物显示");
  // 已落盘的旧出厂 goal 文案应随显示名升级；用户自定义内容不受影响。
  const botSeedGoalPath = bot.blocks.find((b) => b.id === "goal")!.filePath;
  writeFileSync(botSeedGoalPath, previousModeBlocks.general.goal + "\n");
  const migratedBot = store.getProfile("general");
  assert(
    migratedBot.blocks.find((b) => b.id === "goal")?.content.trimEnd() === MODE_SEEDS.general.blocks.goal,
    "旧 Bot goal 出厂文案升级为通用模式",
  );
  assert(migratedBot.blocks.find((b) => b.id === "goal")?.source === "seed", "升级后仍为 seed");

  for (const mode of ["working", "coding"] as const) {
    const profile = store.getProfile(mode);
    for (const blockId of ["workflow", "delivery", "criteria"] as const) {
      const path = profile.blocks.find(b => b.id === blockId)!.filePath;
      writeFileSync(path, previousModeBlocks[mode][blockId] + "\n");
      assert(store.getProfile(mode).blocks.find(b => b.id === blockId)?.content.trimEnd() === MODE_SEEDS[mode].blocks[blockId],
        `${mode}/${blockId}: exact stock block upgraded on disk`);
      writeFileSync(path, "自定义，保留原文");
      assert(store.getProfile(mode).blocks.find(b => b.id === blockId)?.content === "自定义，保留原文", "custom block retained");
      assert(existsSync(path + ".factory-update.md"), "factory update preview available");
      store.resetBlock(mode, blockId);
    }
  }
  console.log("\n2. 用户覆盖");
  store.saveBlock("working", "goal", "自定义目标：只做周报。");
  const after = store.getProfile("working");
  assert(after.blocks.find((b) => b.id === "goal")?.source === "user", "goal 为 user");
  assert(after.blocks.find((b) => b.id === "goal")?.content.includes("自定义目标"), "goal 内容已改");
  assert(after.hasUserOverride === true, "hasUserOverride");
  assert(store.buildSystemSection("working").includes("自定义目标"), "system 段反映覆盖");

  console.log("\n3. 策略保存");
  const pol = { ...after.policy, scenes: [{ label: "测", prompt: "测一下" }] };
  store.savePolicy("coding", pol);
  const coding = store.getProfile("coding");
  assert(coding.policy.scenes.some((s) => s.label === "测"), "coding scenes 已保存");

  console.log("\n4. 恢复");
  store.resetBlock("working", "goal");
  assert(store.getProfile("working").blocks.find((b) => b.id === "goal")?.source === "seed", "goal 恢复 seed");
  store.resetPolicy("coding");
  assert(!store.getProfile("coding").policy.scenes.some((s) => s.label === "测"), "policy 恢复");
  store.saveBlock("general", "forbid", "用户禁令测试");
  store.resetProfile("general");
  assert(store.getProfile("general").hasUserOverride === false, "Bot 整模式恢复");

  console.log("\n5. 非法空内容");
  let threw = false;
  try {
    store.saveBlock("working", "goal", "   ");
  } catch {
    threw = true;
  }
  assert(threw, "空内容拒绝保存");

  console.log("\n6. 装配与技能过滤");
  const profile = store.getProfile("working");
  const assembly = assemblePrompt({
    welcomeMode: "working",
    profile,
    soul: { name: "Buddy", alias: "你", persona: "务实" },
    expertPrompt: "## 专家角色\n你是周报专家",
    permissionMode: "default",
    platform: "win32",
    memoryEnabled: true,
    skills: [
      { id: "weekly-summary", name: "weekly-summary", description: "周报摘要" },
      { id: "k8s-deploy", name: "k8s-deploy", description: "deploy k8s" },
      { id: "hello", name: "hello-buddy", description: "打招呼" },
    ],
  });
  assert(assembly.appendParts.some((p) => p.includes("专家角色")), "含专家段");
  assert(assembly.appendParts.some((p) => p.includes("场景模式")), "含场景段");
  assert(assembly.appendParts.some((p) => p.includes("产物扩展名限制")), "含产物黑名单段");
  assert(assembly.appendParts.some((p) => p.includes(".py")), "提示含 .py 禁止");
  assert(assembly.artifactPolicy.deny.includes("py"), "装配 trace 含 artifactPolicy");
  assert(assembly.skillFilter.hidden.includes("k8s-deploy") || assembly.skillFilter.demoted.includes("k8s-deploy"), "deploy 技能被 demote/hide");
  assert(assembly.effectiveAt === "new_session_only", "生效语义");

  // 产物扩展名匹配纯函数（黑/白名单独立）
  const {
    pathMatchesArtifactDeny,
    shouldBlockArtifactWrite,
    evaluateArtifactWrite,
    artifactVisibleForDisplay,
    normalizeArtifactExtension,
  } = await import("../src/shared/mode-profile");
  assert(normalizeArtifactExtension(".PY") === "py", "扩展名归一化");
  assert(pathMatchesArtifactDeny("report.py", ["py", "ts"]), "path 命中 py");
  assert(!pathMatchesArtifactDeny("report.md", ["py", "ts"]), "md 不命中");
  assert(
    shouldBlockArtifactWrite("x.py", { mode: "hard", allow: [], deny: ["py"] }),
    "hard 黑名单拦截 .py",
  );
  assert(
    !shouldBlockArtifactWrite("x.py", { mode: "soft", allow: [], deny: ["py"] }),
    "soft 不硬拦",
  );
  assert(
    shouldBlockArtifactWrite("x.py", { mode: "hard", allow: ["md", "docx"], deny: [] }),
    "hard 白名单外拦截 .py",
  );
  assert(
    !shouldBlockArtifactWrite("x.md", { mode: "hard", allow: ["md", "docx"], deny: [] }),
    "hard 白名单内放行 .md",
  );
  const deniedWrite = evaluateArtifactWrite("a.py", { mode: "hard", allow: ["md"], deny: ["py"] });
  assert(
    deniedWrite.block && deniedWrite.reason === "deny",
    "同时配置时 deny 优先",
  );

  // V3.6 显示过滤：黑白名单影响产物面板与消息芯片，不区分 soft/hard（写入拦截已移除）
  assert(
    !artifactVisibleForDisplay("report.py", { mode: "hard", allow: [], deny: ["py"] }),
    "deny 命中 → 面板隐藏",
  );
  assert(
    artifactVisibleForDisplay("report.md", { mode: "hard", allow: [], deny: ["py"] }),
    "deny 未命中 → 面板显示",
  );
  assert(
    !artifactVisibleForDisplay("x.py", { mode: "hard", allow: ["md", "docx"], deny: [] }),
    "allow 非空且未命中 → 面板隐藏",
  );
  assert(
    artifactVisibleForDisplay("x.md", { mode: "hard", allow: ["md", "docx"], deny: [] }),
    "allow 命中 → 面板显示",
  );
  assert(
    !artifactVisibleForDisplay("noext", { mode: "soft", allow: ["md"], deny: [] }),
    "allow 启用时无扩展名产物隐藏（与 evaluateArtifactWrite 判定一致）",
  );
  assert(
    artifactVisibleForDisplay("report.md", { mode: "soft", allow: [], deny: [] }),
    "黑白名单皆空 → 不过滤",
  );
  assert(
    artifactVisibleForDisplay("report.py", null),
    "无策略 → 不过滤",
  );
  // 通用机制回归：非 .py 的业务产物（以 .step/.fcstd 等为样例）不受 py 黑名单影响
  assert(
    artifactVisibleForDisplay("lego_car.step", { mode: "hard", allow: [], deny: ["py"] }),
    "CAD 成品不受 py 黑名单影响",
  );

  // 分模式保存：各自黑白名单互不影响
  store.savePolicy("working", {
    ...store.getProfile("working").policy,
    artifactPolicy: { mode: "hard", allow: ["md", "docx"], deny: ["py"] },
  });
  store.savePolicy("coding", {
    ...store.getProfile("coding").policy,
    artifactPolicy: { mode: "soft", allow: [], deny: [] },
  });
  assert(
    store.getProfile("working").policy.artifactPolicy.allow.includes("md") &&
      store.getProfile("working").policy.artifactPolicy.deny.includes("py"),
    "working 黑白名单各自持久化",
  );
  assert(
    store.getProfile("coding").policy.artifactPolicy.deny.length === 0 &&
      store.getProfile("coding").policy.artifactPolicy.allow.length === 0,
    "coding 名单不受 working 影响",
  );

  const toolsReadonly = resolveSessionTools("readonly", profile.policy.toolPolicy);
  assert(toolsReadonly?.includes("read") && !toolsReadonly?.includes("write"), "readonly 工具");
  const hardTools = resolveSessionTools("default", {
    mode: "hard",
    prefer: [],
    demote: [],
    deny: ["bash"],
  });
  assert(hardTools && !hardTools.includes("bash"), "hard deny bash");

  const filt = filterSkillsForMode(
    [{ id: "x", name: "foo", description: "周报" }],
    "working",
    { prefer: ["周报"], demote: [], hide: [], allow: [] },
  );
  assert(filt.visible[0]?.name === "foo", "prefer 可见");

  const allowOnly = filterSkillsForMode(
    [
      { id: "weekly", name: "weekly-summary", description: "周报" },
      { id: "other", name: "hello", description: "hi" },
    ],
    "working",
    { prefer: [], demote: [], hide: [], allow: ["weekly"] },
  );
  assert(allowOnly.visible.length === 1 && allowOnly.visible[0]?.id === "weekly", "技能白名单");
  assert(allowOnly.hidden.some((s) => s.id === "other"), "白名单外隐藏");

  console.log("\nBot 旧配置：不再依赖已删除的 design 目录");
  const legacyDir = join(sandbox, ".mybuddy", "modes", "design");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "policy.json"), JSON.stringify({ presets: [
    { id: "general", label: "通用设计" },
    { id: "web-prototype", label: "旧设计 Penpot", promptAddon: "旧设计提示词", suggestedModelId: "design-only-model" },
  ] }));
  writeFileSync(join(legacyDir, "goal.md"), "旧设计目标文案，不应再被读取");
  const botGoalPath = join(sandbox, ".mybuddy", "modes", "general", "goal.md");
  rmSync(botGoalPath, { force: true });
  const botAfterRemoval = store.getProfile("general");
  assert(botAfterRemoval.blocks.find(b => b.id === "goal")?.content.trim() === MODE_SEEDS.general.blocks.goal.trim(), "bot 缺失块回退出厂文案，不再从 design 复制");
  writeFileSync(bot.policyPath, JSON.stringify({ ...bot.policy, presets: [
    { id: "general", label: "通用设计" },
    { id: "web-prototype", label: "网页原型 · Penpot", promptAddon: "网页原型 · Penpot：最新提示词", suggestedModelId: "custom-model" },
    { id: "custom-bot", label: "自定义 Bot", promptAddon: "保留自定义" },
  ] }));
  const existingOffice = store.getProfile("working").policy;
  writeFileSync(working.policyPath, JSON.stringify({ ...existingOffice, presets: existingOffice.presets?.filter(p => p.id !== "web-prototype") }));
  const migrated = store.getProfile("working");
  const penpot = migrated.policy.presets?.find(p => p.id === "web-prototype");
  assert(penpot?.label === "Penpot" && penpot.promptAddon === "Penpot：最新提示词", "重命名且保留最新旧提示词");
  assert(penpot?.suggestedModelId === "custom-model", "保留旧模型推荐");
  assert(penpot?.suggestedModelId !== "design-only-model", "design 目录的旧模型推荐不再被读取");
  assert(penpot?.providerMcpIds?.includes("penpot") && penpot.mcpPolicy?.allow.includes("penpot"), "保留 Penpot MCP 能力");
  assert(penpot?.requiredRuntimes?.some(r => typeof r !== "string" && r.providerId === "penpot" && r.launchPolicy === "backend" && r.readinessPolicy === "http" && r.openUi === "browser"), "保留后端启动、HTTP 就绪与浏览器打开");
  const cleanBot = store.getProfile("general");
  assert(!cleanBot.policy.presets?.some(p => ["general", "web-prototype"].includes(p.id)), "旧磁盘 Tag 不在 Bot 复活");
  assert(cleanBot.policy.presets?.some(p => p.id === "custom-bot"), "保留其它自定义 Bot Tag");
  store.savePolicy("working", { ...migrated.policy, presets: migrated.policy.presets?.map(p => p.id === "web-prototype" ? { ...p, promptAddon: "办公编辑优先" } : p) });
  const reloadedPenpot = new ModeProfileStore().getProfile("working").policy.presets?.find(p => p.id === "web-prototype");
  assert(reloadedPenpot?.promptAddon === "办公编辑优先" && reloadedPenpot.label === "Penpot", "重开后办公修改优先于旧配置");

  console.log(`\n[mode-profile-test] ${passed} passed, ${failed} failed`);
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
