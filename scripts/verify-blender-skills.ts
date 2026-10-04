/**
 * Blender Skill 真实环境验证（只读，不修改 ~/.mybuddy / mcp.json）。
 *
 * 针对本机真实装配链验证：
 * 1) loadSkills（agentDir=~/.mybuddy）能发现 4 个 blender-* 技能且未禁用模型调用；
 * 2) ModeProfileStore 读真实 design profile：3d-blender preset 的 skillPolicy 已从
 *    seed 补回（验证 ModeProfileStore 出厂能力补全修复在真实持久化 policy.json 上生效）；
 * 3) resolveRuntimeContextPolicy（design + 3d-blender）→ filterSkillsForMode 真实技能集：
 *    恰好 4 个 blender-* 可见（allow 白名单收窄），且 finalAllowedSet === visible
 *    （AgentService.createSession 的 P1-A/B 不变量）；
 * 4) Blender MCP 保持不变：mcp.json blender 条目 command/env/port 原样。
 *
 * 运行：node scripts/build-blender-skill-check.mjs && node out/tests/verify-blender-skills.cjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";

const BLENDER_SKILLS = ["blender-core", "blender-modeling", "blender-lookdev", "blender-validation"];

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function main(): Promise<void> {
  const { ModeProfileStore } = await import("../src/main/agent/ModeProfileStore");
  const { resolveRuntimeContextPolicy } = await import("../src/main/agent/RuntimeContextResolver");
  const { filterSkillsForMode, filterLoaderSkills } = await import("../src/main/agent/SkillPolicy");

  const mybuddyDir = resolve(join(homedir(), ".mybuddy"));
  console.log(`[verify-blender-skills] agentDir=${mybuddyDir}`);

  console.log("== [1] loadSkills 发现 4 个 blender-* 技能（真实 ~/.mybuddy/skills） ==");
  const { skills } = loadSkills({
    cwd: process.cwd(),
    agentDir: mybuddyDir,
    skillPaths: [],
    includeDefaults: true,
  });
  const blenderLoaded = skills.filter((s) => BLENDER_SKILLS.includes(s.name));
  for (const id of BLENDER_SKILLS) {
    const s = blenderLoaded.find((x) => x.name === id);
    ok(s !== undefined, `发现技能 ${id}`);
    ok(s !== undefined && !s.disableModelInvocation, `${id} 未被 disable-model-invocation 禁用`);
  }
  ok(
    blenderLoaded.length === BLENDER_SKILLS.length,
    `blender-* 技能数 = ${BLENDER_SKILLS.length}（实际 ${blenderLoaded.length}）`,
  );

  console.log("== [2] 真实 design profile：3d-blender / Ardot / FreeCAD Tag 已退役 ==");
  const store = new ModeProfileStore();
  const profile = store.getProfile("design");
  const preset = profile.policy.presets?.find((p) => p.id === "3d-blender");
  ok(preset === undefined, "3d-blender preset 已退役");
  ok(
    !(profile.policy.presets ?? []).some((p) => p.id === "ai-ui" || p.id === "mechanical-cad"),
    "ai-ui / mechanical-cad 已退役",
  );

  console.log("== [3] 全链合成：design 默认 preset（无 blender 白名单） ==");
  const ctx = resolveRuntimeContextPolicy({
    welcomeMode: "design",
    profile,
    projectContext: null,
    preset: profile.policy.presets?.find((p) => p.id === "web-prototype"),
    expertId: null,
    connectorIds: [],
  });
  const refs = skills.map((s) => ({
    id: s.name,
    name: s.name,
    description: s.description || "",
    command: s.name,
    enabled: !s.disableModelInvocation,
  }));
  const filter = filterSkillsForMode(refs, "design", ctx.runtimePolicy.skillPolicy, {
    policySources: ctx.skillPolicySources,
  });
  const visibleNames = filter.visible.map((s) => s.name);
  ok(!visibleNames.includes("blender-core"), "默认 design tag 不再收窄到 blender 技能");
  // AgentService.createSession 不变量：Final Allowed Skill Set === assembly.skillFilter.visible
  const finalAllowed = new Set(visibleNames);
  const loader = filterLoaderSkills({ skills, diagnostics: [] }, finalAllowed);
  ok(
    loader.skills.every((s) => finalAllowed.has(s.name)) && loader.skills.length === finalAllowed.size,
    "filterLoaderSkills 收敛：loader.getSkills() === Final Allowed Set",
  );

  console.log("== [4] Blender MCP 配置保持不变 ==");
  const mcp = JSON.parse(readFileSync(join(mybuddyDir, "mcp.json"), "utf-8")) as {
    mcpServers: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }
    >;
  };
  const b = mcp.mcpServers?.blender;
  ok(b !== undefined, "mcp.json 存在 blender 条目");
  ok(b?.command?.includes("uv.exe") || b?.command?.includes("uv"), "blender 条目 command 为 uv run blender-mcp（未变）");
  ok(JSON.stringify(b?.args ?? []).includes("blender_mcp"), "blender 条目 args 指向 MyBuddyTools/mcp/blender_mcp（未变）");
  ok(b?.env?.BLENDER_PATH?.includes("blender-5.2.0-windows-x64"), "blender 条目 env.BLENDER_PATH 未变");
  ok(b?.env?.BLENDER_MCP_PORT === "9876", "blender 条目 env.BLENDER_MCP_PORT=9876 未变");
  ok(b?.disabled !== true, "blender 条目未禁用");

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
