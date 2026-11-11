// Source-level ESM harness: the packaged CJS entry normally supplies __dirname.
(globalThis as any).__dirname = process.cwd();
/**
 * 统一能力装配架构测试（Mode → Tag/Preset → Expert/Connector → Skill/MCP → Model/Permission → Session）。
 *
 * 覆盖（对应实现验收项 A–I）：
 * A. effective policy 合成：skill/mcp/prompt/model/permission/recommendedExpertIds；旧/未知字段兼容
 * B. model precedence：explicit > preset 建议 > base > default；坏 suggested 安全降级
 * C. permission precedence：explicit > preset > base > default；readonly 裁剪 write/edit/bash
 * D. Expert Private Skills：安装/列出/卸载；不进入 Global list；只读当前专家
 * E. Connector Private Skills：安装/激活/卸载；仅 Active Connector 进入 Session；旧全局副本迁移
 * F. Skill Resolver：Global + selected Expert + Active Connector → skillPolicy 过滤
 * G. MCP：drawio-ai(working)/penpot(design)/serena(coding) 模式过滤回归
 * H. coding code-review 作为通用样例：推荐专家/readonly/技能/MCP 全走通用机制
 * I. Related Task：同 Space、独立 task/session 字段、引用源任务；无新增 DB schema
 * J. 会话装配路径唯一合成 + renderer 显式/默认契约（P0：真实 sendMessage 主路径）
 * J2. F2 跨任务显式隔离 / F1 regenerate payload / F4 summonExpert 清空（任务级 explicit 作用域）
 * K. Connector enabled 生命周期：安装≠active；停用连接器私有技能不进入候选
 * K2. F3 chip 过滤 / settings.json 持久化 / assemblyDirty 标记（无新 DB schema）
 * L. 旧版 Connector 全局技能副本安全迁移（幂等、meta 归属、不误删共享/孤儿）
 * M. AgentService 集成：F1 regenerate 全链保留 / F3 dirty / P3-3 释放+detach /
 *    P3-1 预览同源 / P3-2 重名诊断 / P3-4 disabled expert gate（真实 Durable 宿主）
 * N. 收口回归：P1 重启兜底矩阵 / P2 预览 dirty 守卫 / shadowed cwd 对齐 /
 *    settings.json 原子写 + 损坏保留 / trash→purge taskConnectorIds 生命周期 /
 *    三 Mode + 5+1 受管 provider / 私有技能不污染 Global Skill Center
 *    P3：回同步守卫按任务自身 flag（切任务/显式改选不回退）/ 孤儿 key 对账 /
 *    .tmp 崩溃残留恢复 / 损坏副本两代轮换
 *
 * 运行：pnpm test:architecture（esbuild bundle + node 直跑，临时 USERPROFILE 沙箱）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { normalizedEditorTextHash } from "../src/shared/regenerate-hash";
import type { Task as RendererTask } from "../src/renderer/src/types";

// ---- 隔离环境：HOME/USERPROFILE 指向临时目录（必须在 import 服务前设置） ----
const sandbox = join(tmpdir(), `mybuddy-arch-test-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
mkdirSync(sandbox, { recursive: true });

// eslint-disable-next-line import/first
import {
  emptyModePolicy,
  resolveEffectiveModelId,
  resolveEffectiveModePolicy,
  resolveEffectivePermission,
  resolveModePreset,
  splitProviderModelId,
  withEffectiveModePolicy,
  type ModePolicyDto,
  type ModePresetDto,
} from "../src/shared/mode-profile";
// eslint-disable-next-line import/first
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
// eslint-disable-next-line import/first
import { ModeProfileStore } from "../src/main/agent/ModeProfileStore";
// eslint-disable-next-line import/first
import { AppDatabase } from "../src/main/db/AppDatabase";
// eslint-disable-next-line import/first
import { filterMcpConfigForMode, type McpFilterResult } from "../src/main/mcp/McpModeFilter";
// eslint-disable-next-line import/first
import type { McpConfig } from "../src/main/mcp/McpConfigService";
// eslint-disable-next-line import/first
import { resolveSessionTools } from "../src/main/agent/PromptAssembly";
// eslint-disable-next-line import/first
import { createPermissionExtension } from "../src/main/agent/permission-extension";
// eslint-disable-next-line import/first
import { SkillsService } from "../src/main/skills/SkillsService";
// eslint-disable-next-line import/first
import { ExpertService } from "../src/main/experts/ExpertService";
// eslint-disable-next-line import/first
import { ConnectorService } from "../src/main/connectors/ConnectorService";
// eslint-disable-next-line import/first
import { filterSkillsForMode } from "../src/main/agent/SkillPolicy";
// eslint-disable-next-line import/first
import {
  buildRelatedTaskPrompt,
  resolveRelatedTaskSpec,
} from "../src/renderer/src/lib/relatedTask";

// eslint-disable-next-line import/first
import Database from "better-sqlite3";

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

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function skillMd(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: test skill ${name}\n${extra}---\n\n# ${name}\n\nbody\n`;
}

function makeFakePi() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    on: (event: string, cb: (event: unknown) => unknown) => {
      handlers.set(event, cb);
    },
    fire: async (event: string, ev: unknown) => handlers.get(event)?.(ev),
  };
}

async function main(): Promise<void> {
  console.log("[architecture-test] sandbox:", sandbox);

  /* ================= A. effective policy 合成 ================= */
  console.log("\nA. effective policy 合成（recommendedExpertIds / permission / model）");
  {
    const base = emptyModePolicy();
    base.recommendedExpertIds = ["doc-polish", "weekly-report"];
    base.suggestedPermissionMode = "default";
    base.suggestedModelId = "base-model";
    const preset: ModePresetDto = {
      id: "code-review",
      label: "代码审查",
      recommendedExpertIds: ["code-review-expert", "doc-polish"],
      suggestedPermissionMode: "readonly",
      suggestedModelId: "review-model",
    };
    const eff = resolveEffectiveModePolicy(base, preset);
    // base 在前、preset 追加、去重
    assert(
      JSON.stringify(eff.recommendedExpertIds) ===
        JSON.stringify(["doc-polish", "weekly-report", "code-review-expert"]),
      "推荐专家 = base ∪ preset，去重保序（base 在前）",
    );
    assert(eff.suggestedPermissionMode === "readonly", "preset 权限建议覆盖 base（preset ?? base）");
    assert(eff.suggestedModelId === "review-model", "preset 模型建议覆盖 base（preset ?? base）");

    // 无 preset：原样继承 base
    const effNoPreset = resolveEffectiveModePolicy(base, undefined);
    assert(
      JSON.stringify(effNoPreset.recommendedExpertIds) ===
        JSON.stringify(["doc-polish", "weekly-report"]),
      "无 preset → 推荐专家 = base 原样",
    );
    assert(effNoPreset.suggestedPermissionMode === "default", "无 preset → 权限建议 = base");

    // preset 未声明字段 → 回落 base
    const preset2: ModePresetDto = { id: "x", label: "X" };
    const eff2 = resolveEffectiveModePolicy(base, preset2);
    assert(eff2.suggestedPermissionMode === "default", "preset 未声明权限 → base 值");
    assert(
      JSON.stringify(eff2.recommendedExpertIds) ===
        JSON.stringify(["doc-polish", "weekly-report"]),
      "preset 未声明推荐 → base 值",
    );

    // withEffectiveModePolicy 回写 profile.policy
    const profile = { policy: base } as Parameters<typeof withEffectiveModePolicy>[0];
    const merged = withEffectiveModePolicy(profile, eff);
    assert(merged.policy.suggestedPermissionMode === "readonly", "effective 权限回写 profile.policy");
    assert(
      merged.policy.recommendedExpertIds.includes("code-review-expert"),
      "effective 推荐专家回写 profile.policy",
    );
  }

  // ModeProfileStore：新增字段持久化 round-trip + 旧 policy 兼容
  console.log("\nA2. ModeProfileStore 序列化兼容");
  {
    const store = new ModeProfileStore();
    // 自定义 preset 含新字段
    const customPolicy = {
      skillPolicy: { prefer: [], demote: [], hide: [], allow: [] },
      toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
      mcpPolicy: { mode: "hard", allow: [], deny: [] },
      suggestedModelId: null,
      suggestedPermissionMode: null,
      recommendedExpertIds: [],
      scenes: [],
      presets: [
        {
          id: "custom-review",
          label: "自定义审查",
          promptAddon: "独立审查",
          suggestedPermissionMode: "readonly",
          recommendedExpertIds: ["code-review-expert"],
          suggestedModelId: null,
        },
      ],
    };
    write(join(sandbox, ".mybuddy", "modes", "coding", "policy.json"), JSON.stringify(customPolicy));
    const p = store.getProfile("coding");
    const custom = p.policy.presets?.find((x) => x.id === "custom-review");
    assert(!!custom, "自定义 preset 可读");
    assert(custom?.suggestedPermissionMode === "readonly", "preset suggestedPermissionMode 保存后不丢");
    assert(
      (custom?.recommendedExpertIds ?? []).includes("code-review-expert"),
      "preset recommendedExpertIds 保存后不丢",
    );
    // 旧 policy（无 presets）→ 回退出厂 coding presets（含升级后的 code-review）
    const legacy = {
      skillPolicy: { prefer: ["review"], demote: [], hide: [], allow: [] },
      toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
      mcpPolicy: { mode: "hard", allow: [], deny: [] },
      suggestedModelId: null,
      suggestedPermissionMode: null,
      recommendedExpertIds: [],
      scenes: [],
    };
    write(join(sandbox, ".mybuddy", "modes", "working", "policy.json"), JSON.stringify(legacy));
    const pw = store.getProfile("working");
    assert(Array.isArray(pw.policy.presets) && pw.policy.presets.length >= 6, "旧 working policy 回退出厂 presets");
    assert(
      pw.policy.artifactPolicy?.deny?.includes("py"),
      "旧 working policy 无 artifactPolicy 时回退出厂产物黑名单（含 py）",
    );
    // 未知/非法字段被安全归一化（不会破坏读取）
    const dirty = { ...customPolicy, presets: [{ id: "bad", label: "坏", suggestedPermissionMode: "banana" }] };
    write(join(sandbox, ".mybuddy", "modes", "general", "policy.json"), JSON.stringify(dirty));
    const pd = store.getProfile("general");
    assert(pd.policy.presets?.[0]?.suggestedPermissionMode === undefined, "Bot 不继承旧权限字段");
  }

  /* ================= B. model precedence ================= */
  console.log("\nB. 模型优先级与安全降级");
  {
    assert(resolveEffectiveModelId("explicit", "suggested", () => false) === "explicit", "显式模型优先（即使建议不可用）");
    assert(resolveEffectiveModelId(undefined, "suggested", () => true) === "suggested", "无显式 → 可用建议模型");
    assert(resolveEffectiveModelId(undefined, "bad-model", () => false) === undefined, "无效建议 → 降级 undefined（默认模型）");
    assert(resolveEffectiveModelId(undefined, undefined, () => true) === undefined, "无建议 → 默认模型");
    assert(resolveEffectiveModelId("", "suggested", () => true) === "suggested", "空显式视为未提供");
    assert(
      resolveEffectiveModelId(undefined, undefined, () => true, "opencode-go/gpt-5.6-luna") ===
        "opencode-go/gpt-5.6-luna",
      "无显式无建议也不启用旧默认审批（UI defaultModelId）",
    );
    assert(
      resolveEffectiveModelId(undefined, "bad-model", () => false, "opencode-go/gpt-5.6-luna") ===
        undefined,
      "建议与系统默认均不可用 → undefined",
    );
    assert(
      resolveEffectiveModelId(undefined, "bad-model", (id) => id === "opencode-go/gpt-5.6-luna", "opencode-go/gpt-5.6-luna") ===
        "opencode-go/gpt-5.6-luna",
      "无效建议 → 回落可用的系统默认",
    );
    assert(
      resolveEffectiveModelId(undefined, "review-model", () => true, "opencode-go/gpt-5.6-luna") ===
        "review-model",
      "可用建议仍优先于系统默认",
    );
    assert(splitProviderModelId("opencode-go/gpt-5.6-luna")?.model === "gpt-5.6-luna", "拆 provider/model");
    assert(splitProviderModelId("mimo-v2.5") === null, "无斜杠不拆");
    assert(splitProviderModelId("opencode-go/") === null, "缺 model 不拆");
  }

  /* ================= C. permission precedence + readonly ================= */
  console.log("\nC. 旧权限配置兼容且不再限制执行");
  {
    assert(resolveEffectivePermission(undefined, "readonly", "default") === "auto", "旧 preset readonly 不再限制执行");
    assert(resolveEffectivePermission("auto", "readonly", "default") === "auto", "显式 auto 不被 preset 覆盖");
    assert(resolveEffectivePermission(undefined, null, "default") === "auto", "无建议也不启用旧默认审批");
    const tools = resolveSessionTools("readonly", emptyModePolicy().toolPolicy);
    assert(
      tools === undefined,
      "legacy readonly does not narrow tool availability",
    );
    // Tool availability is selected through Pi; native execution bypasses product permission hooks.
    const pi = makeFakePi();
    createPermissionExtension({
      getPermissionMode: () => "readonly",
      requestApproval: async () => false,
    })(pi as never);
    const blockWrite = (await pi.fire("tool_call", { toolName: "write", input: { path: "x" } })) as
      | { block?: boolean }
      | undefined;
    const blockEdit = (await pi.fire("tool_call", { toolName: "edit", input: {} })) as
      | { block?: boolean }
      | undefined;
    const blockBash = (await pi.fire("tool_call", { toolName: "bash", input: { command: "rm -rf /" } })) as
      | { block?: boolean }
      | undefined;
    const allowRead = await pi.fire("tool_call", { toolName: "read", input: { path: "x" } });
    assert(blockWrite === undefined, "原生 write 不进入 MyBuddy readonly 钩子");
    assert(blockEdit === undefined, "原生 edit 不进入 MyBuddy readonly 钩子");
    assert(blockBash === undefined, "原生 bash 不进入 MyBuddy readonly 钩子");
    assert(allowRead === undefined, "readonly 放行 read");
  }

  /* ================= D. Expert Private Skills ================= */
  console.log("\nD. Expert Private Skills 生命周期");
  {
    const svc = new ExpertService();
    const skills = new SkillsService();
    const pkgDir = join(sandbox, "expert-pkg");
    write(
      join(pkgDir, ".codebuddy-plugin", "plugin.json"),
      JSON.stringify({ name: "demo-expert", displayName: { zh: "演示专家" } }),
    );
    write(join(pkgDir, "agents", "demo-expert.md"), "---\nname: demo-expert\ndescription: demo\n---\n# Demo\n");
    write(join(pkgDir, "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    write(join(pkgDir, "skills", "beta", "SKILL.md"), skillMd("beta"));

    const installed = svc.installByPath(pkgDir);
    assert(!!installed, "目录安装成功");
    assert((installed.skills ?? []).length === 2 && installed.skills!.includes("alpha"), "DTO.skills 记录私有技能");
    const privateDir = svc.getPrivateSkillsDir("demo-expert");
    assert(!!privateDir && existsSync(join(privateDir!, "alpha", "SKILL.md")), "私有技能落盘到专家目录 skills/");
    assert(svc.getPrivateSkillsDir("missing-expert") === null, "未安装专家 → null");
    const globalNames = skills.listInstalled().map((s) => s.name);
    assert(!globalNames.includes("alpha") && !globalNames.includes("beta"), "私有技能不进入 Global Skill Center");
    assert(skills.listInstalled(undefined, [privateDir!]).some((s) => s.name === "alpha"), "会话附加路径可加载当前专家私有技能");

    // 只读详情 DTO：名称/描述来自 SKILL.md frontmatter（UI 专家卡片消费）
    const details = svc.listExpertPrivateSkills("demo-expert");
    assert(details.length === 2, "listExpertPrivateSkills 枚举 2 个私有技能");
    assert(
      details.some((d) => d.id === "alpha" && d.name === "alpha" && d.description === "test skill alpha"),
      "私有技能详情读 frontmatter 名称/描述",
    );
    assert(details.some((d) => d.id === "beta" && d.name === "beta"), "beta 私有技能 id 存在（目录名小写）");
    assert(svc.listExpertPrivateSkills("missing-expert").length === 0, "未安装专家详情为空（不炸）");

    // 重复安装（升级）幂等
    svc.installByPath(pkgDir);
    assert(existsSync(join(svc.getPrivateSkillsDir("demo-expert")!, "beta", "SKILL.md")), "重复安装后私有技能仍在（覆盖）");

    // 卸载：私有技能随专家目录消失
    svc.uninstall("demo-expert");
    assert(svc.getPrivateSkillsDir("demo-expert") === null, "卸载后私有技能目录消失");
    assert(!existsSync(join(sandbox, ".mybuddy", "plugins", "experts", "demo-expert")), "卸载后专家目录消失");

    // Local market fixture: do not depend on a removed external market package.
    const marketPkgDir = join(sandbox, "fixture-market-expert");
    write(join(marketPkgDir, "prompt.md"), "Local market fixture");
    write(join(marketPkgDir, "skills", "github", "SKILL.md"), skillMd("github"));
    svc.listMarket = () => [{ ...installed, id: "fixture-market-expert", name: "Fixture market expert",
      sourcePath: marketPkgDir } as ReturnType<ExpertService["listMarket"]>[number]];
    const marketExpert = svc.installFromMarket("fixture-market-expert");
    assert(!!marketExpert && marketExpert.id === "fixture-market-expert", "市场安装本地 fixture");
    assert((marketExpert.skills ?? []).includes("github"), "市场包私有技能 github 被保留");
    assert(existsSync(join(svc.getPrivateSkillsDir("fixture-market-expert")!, "github", "SKILL.md")), "github 技能落盘");
    const globalNames2 = skills.listInstalled().map((s) => s.name);
    assert(!globalNames2.includes("github"), "专家私有 github 不进入全局技能列表");
  }

  // zip 导入 + 路径穿越防御
  console.log("\nD2. zip 导入私有技能与路径穿越");
  {
    const svc = new ExpertService();
    const zip = new JSZip();
    zip.file("demo/.codebuddy-plugin/plugin.json", JSON.stringify({ name: "zip-expert" }));
    zip.file("demo/agents/zip-expert.md", "---\nname: zip-expert\ndescription: d\n---\n# z\n");
    zip.file("demo/skills/good/SKILL.md", skillMd("good"));
    zip.file("demo/skills/../evil.md", "evil");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = join(sandbox, "zip-expert.zip");
    write(zipPath, "");
    writeFileSync(zipPath, buf);
    const inst = await svc.importZip(zipPath);
    const privateDir = svc.getPrivateSkillsDir("zip-expert");
    assert(!!privateDir && existsSync(join(privateDir!, "good", "SKILL.md")), "zip 私有技能 good 落盘");
    assert(!existsSync(join(privateDir!, "evil.md")), "zip 路径穿越条目（../evil.md）被拒绝");
    assert(inst.skills?.includes("good") === true, "zip 安装 DTO.skills 记录");
    svc.uninstall("zip-expert");
  }

  /* ================= E. Connector Private Skills ================= */
  console.log("\nE. Connector Private Skills 生命周期");
  {
    const connDir = join(sandbox, ".mybuddy", "plugins", "connector-market", "connectors", "demo");
    write(join(connDir, "connector-meta.json"), JSON.stringify({ name: "演示连接器" }));
    write(join(connDir, "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    write(join(connDir, "skills", "beta", "SKILL.md"), skillMd("beta"));

    const svc = new ConnectorService();
    const skills = new SkillsService();
    const listed = svc.list().find((c) => c.id === "demo");
    assert(!!listed && listed.skillCount === 2, "市场扫描识别连接器私有技能");
    const names = svc.install("demo");
    assert(names.length === 2, "安装返回技能名");
    const regSkills = join(sandbox, ".mybuddy", "plugins", "connectors", "demo", "skills");
    assert(existsSync(join(regSkills, "alpha", "SKILL.md")), "私有技能存于连接器注册目录");
    assert(!existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "alpha")), "不污染全局技能目录");
    assert(JSON.stringify(svc.getPrivateSkillDirs(["demo"])) === JSON.stringify([regSkills]), "激活连接器技能目录可读");
    assert(svc.getPrivateSkillDirs(["nope", "../evil"]).length === 0, "未安装/非法 id → 空");

    // 旧版全局副本迁移：meta 校验为 connector:demo 的全局技能（与包内同名 alpha）被移入连接器目录
    write(join(sandbox, ".mybuddy", "plugins", "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    write(
      join(sandbox, ".mybuddy", "plugins", "skills", "alpha", "_skillhub_meta.json"),
      JSON.stringify({ name: "alpha", source: "connector:demo" }),
    );
    // 共享技能（无归属 meta）不得被动
    write(join(sandbox, ".mybuddy", "plugins", "skills", "shared", "SKILL.md"), skillMd("shared"));
    svc.install("demo");
    assert(existsSync(join(regSkills, "alpha", "SKILL.md")), "旧全局副本迁移进连接器私有目录");
    assert(!existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "alpha")), "迁移后全局副本移除");
    assert(existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "shared")), "共享技能不受迁移影响");

    // 卸载：注册目录（含私有技能）消失；共享技能保留
    svc.uninstall("demo");
    assert(!existsSync(regSkills), "卸载后私有技能随连接器消失");
    assert(existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "shared")), "卸载不影响共享技能");
  }

  /* ================= F. Skill Resolver 三来源 ================= */
  console.log("\nF. Skill Resolver：Global + Expert + Connector 统一过滤");
  {
    const skills = new SkillsService();
    write(join(sandbox, ".mybuddy", "plugins", "skills", "global-skill", "SKILL.md"), skillMd("global-skill"));
    const expertDir = join(sandbox, ".mybuddy", "plugins", "experts", "resolver-expert", "skills");
    write(join(expertDir, "alpha", "SKILL.md"), skillMd("alpha"));
    const connDir = join(sandbox, ".mybuddy", "plugins", "connectors", "c1", "skills");
    write(join(connDir, "gamma", "SKILL.md"), skillMd("gamma"));

    const all = skills.listInstalled(undefined, [expertDir, connDir]).map((s) => s.name);
    assert(all.includes("global-skill") && all.includes("alpha") && all.includes("gamma"), "三来源候选技能齐备");
    // 全局重名优先（loadSkills 首胜）
    write(join(sandbox, ".mybuddy", "plugins", "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    const withGlobalAlpha = skills.listInstalled(undefined, [expertDir]).map((s) => s.name);
    assert(withGlobalAlpha.includes("alpha"), "全局重名技能共存（首胜）");

    // 统一经 skillPolicy 过滤
    const refs = all.map((n) => ({ id: n, name: n, description: `skill ${n}` }));
    const filtered = filterSkillsForMode(refs, "coding", { prefer: ["alpha"], demote: [], hide: [], allow: [] });
    assert(filtered.visible[0]?.name === "alpha", "skillPolicy prefer 命中私有技能（统一过滤）");
    const allowOnly = filterSkillsForMode(refs, "coding", { prefer: [], demote: [], hide: [], allow: ["gamma"] });
    assert(allowOnly.visible.length === 1 && allowOnly.visible[0].name === "gamma", "allow 白名单作用于全部来源");
  }

  /* ================= G. MCP 模式过滤回归 ================= */
  console.log("\nG. MCP 过滤回归（working/design/coding fixture）");
  {
    const full: McpConfig = {
      mcpServers: {
        "drawio-ai": { command: "npx", args: [], modes: ["working"], disabled: false },
        penpot: { url: "http://x", modes: ["working"], disabled: false },
        serena: { command: "serena", args: [], modes: ["coding"], disabled: false },
        plain: { command: "echo", args: [], disabled: false },
      },
    };
    const w = filterMcpConfigForMode(full, "working", { mode: "hard", allow: [], deny: ["serena"] });
    assert(w.enabled.includes("drawio-ai") && w.enabled.includes("plain"), "working 启用 drawio-ai（modes）");
    assert(w.enabled.includes("penpot") && !w.enabled.includes("serena"), "working 加载迁入的 Penpot，隐藏 coding 服务器");
    const d = filterMcpConfigForMode(full, "working", { mode: "hard", allow: ["penpot"], deny: [] });
    assert(d.enabled.includes("penpot") && !d.enabled.includes("plain"), "办公 Penpot 白名单只放行 penpot");
    const c = filterMcpConfigForMode(full, "coding", { mode: "hard", allow: [], deny: [] });
    assert(c.enabled.includes("serena") && c.enabled.includes("plain"), "coding 启用 serena（modes）");
    assert(!c.enabled.includes("drawio-ai") && !c.enabled.includes("penpot"), "coding 隐藏 working/design 服务器");
  }

  /* ================= H. code-review 通用样例 ================= */
  console.log("\nH. coding code-review 走通用机制（无特判）");
  {
    const codingPolicy = MODE_SEEDS.coding.policy;
    const preset = resolveModePreset(codingPolicy, "code-review");
    assert(!!preset, "code-review preset 存在");
    const eff = resolveEffectiveModePolicy(codingPolicy, preset);
    assert(eff.suggestedPermissionMode === "readonly", "code-review → effective readonly（通用合成）");
    assert(
      JSON.stringify(eff.recommendedExpertIds) === JSON.stringify(["code-review-expert"]),
      "code-review → 推荐 code-review-expert（通用合成）",
    );
    assert((preset!.skillPolicy?.prefer ?? []).includes("review"), "code-review skillPolicy 偏好 review");
    assert((preset!.skillPolicy?.prefer ?? []).includes("github"), "code-review skillPolicy 偏好 github（私有技能）");
    assert(!!preset!.promptAddon && preset!.promptAddon!.length > 100, "code-review promptAddon 完整");
    // 其余 coding preset 也按同一机制解析
    for (const id of ["bugfix-test", "feature-dev", "refactor", "add-tests", "plan-design", "readonly-explain"]) {
      const p = resolveModePreset(codingPolicy, id);
      assert(!!p, `${id} preset 可解析`);
      resolveEffectiveModePolicy(codingPolicy, p); // 不抛错即通用
    }
    const bugfix = resolveEffectiveModePolicy(codingPolicy, resolveModePreset(codingPolicy, "bugfix-test"));
    assert(bugfix.suggestedPermissionMode === null, "bugfix-test 不强制权限（常规开发）");
    const feature = resolveEffectiveModePolicy(codingPolicy, resolveModePreset(codingPolicy, "feature-dev"));
    assert(feature.suggestedPermissionMode === null, "feature-dev 不强制权限（常规开发）");
    const plan = resolveEffectiveModePolicy(codingPolicy, resolveModePreset(codingPolicy, "plan-design"));
    assert(plan.suggestedPermissionMode === "readonly", "plan-design 建议只读");
    const explain = resolveEffectiveModePolicy(codingPolicy, resolveModePreset(codingPolicy, "readonly-explain"));
    assert(explain.suggestedPermissionMode === "readonly", "readonly-explain 建议只读");
  }

  /* ================= I. Related Task ================= */
  console.log("\nI. 通用关联任务（同 Space、独立 session、无新 schema）");
  {
    const codingPolicy = MODE_SEEDS.coding.policy;
    const profile = { policy: codingPolicy } as Parameters<typeof resolveRelatedTaskSpec>[0]["profile"];
    const spec = resolveRelatedTaskSpec({
      sourceTitle: "任务A",
      welcomeMode: "coding",
      modePresetId: "code-review",
      expertId: "code-review-expert",
      fallbackPermission: "default",
      fallbackModelId: "m1",
      instruction: "请评审",
      isModelAvailable: () => false,
      profile,
    });
    assert(spec.permissionMode === "readonly", "关联任务权限 = preset 建议 readonly");
    assert(spec.modePresetId === "code-review" && spec.expertId === "code-review-expert", "关联任务 tag/专家透传");
    assert(spec.modelId === "m1", "无有效建议模型 → 回退源模型");
    assert(spec.title.includes("任务A"), "标题关联源任务");

    // 显式覆盖建议
    const spec2 = resolveRelatedTaskSpec({
      sourceTitle: "任务A",
      welcomeMode: "coding",
      modePresetId: "code-review",
      permissionMode: "auto",
      modelId: "explicit-model",
      fallbackPermission: "default",
      fallbackModelId: "m1",
      isModelAvailable: () => true,
      profile,
    });
    assert(spec2.permissionMode === "auto" && spec2.modelId === "explicit-model", "显式权限/模型覆盖 Tag 建议");

    // 建议模型可用时生效
    const withSuggestion = { ...codingPolicy, suggestedModelId: "review-model" };
    const spec3 = resolveRelatedTaskSpec({
      sourceTitle: "任务A",
      welcomeMode: "coding",
      modePresetId: "code-review",
      fallbackPermission: "default",
      fallbackModelId: "m1",
      isModelAvailable: (id) => id === "review-model",
      profile: { policy: withSuggestion } as Parameters<typeof resolveRelatedTaskSpec>[0]["profile"],
    });
    assert(spec3.modelId === "review-model", "Tag 建议模型可用 → 生效");

    // 引用块复用 refTask 文本机制
    const promptText = buildRelatedTaskPrompt("评审指令", {
      title: "任务A",
      cwd: "C:/work",
      messages: [{ role: "user", text: "实现 X" }],
    });
    assert(promptText.includes("## 引用任务：任务A"), "首条消息含源任务引用块");
    assert(promptText.includes("mybuddy:reference-context"), "引用块带隐藏标记（UI 不显示）");
    assert(promptText.includes("实现 X"), "引用块含最近对话（供 Agent；显示层剥离）");

    // DB：关联任务字段完整落库，无新增表/列
    const db = new AppDatabase();
    db.upsertTask({
      id: "related-1",
      title: "关联：任务A",
      spaceId: "space-1",
      updatedAt: Date.now(),
      welcomeMode: "coding",
      modelId: "m1",
      permissionMode: "readonly",
      expertId: "code-review-expert",
      modePresetId: "code-review",
    });
    const row = db.listTasks().find((t) => t.id === "related-1");
    assert(!!row, "关联任务落库");
    assert(row?.spaceId === "space-1", "同 Space");
    assert(row?.welcomeMode === "coding" && row?.modePresetId === "code-review", "mode/tag 持久化");
    assert(row?.permissionMode === "readonly" && row?.expertId === "code-review-expert", "权限/专家持久化");
    assert(row?.modelId === "m1", "模型持久化");
    const rawDb = new Database(join(sandbox, ".mybuddy", "app.db"));
    const cols = rawDb.prepare<[], { name: string }>("PRAGMA table_info(tasks)").all().map(c => c.name);
    rawDb.close();
    assert(
      !cols.some((c) => c === "source_task_id" || c === "review_of_task_id" || c === "task_relation"),
      "无关联任务专用 DB 列（复用现有字段）",
    );
    db.close();
  }

  /* ================= J. 会话装配路径 + renderer 显式/默认契约 ================= */
  console.log("\nJ. 会话装配路径 + renderer 显式/默认契约（P0 真实主路径）");
  {
    // 单一装配路径合成：仅当前专家 + Active 连接器进入候选，不扫描其它
    const { collectSessionSkillPaths } = await import("../src/main/agent/sessionSkillPaths");
    const paths = collectSessionSkillPaths("exp1", ["c1", "c2"], {
      expertSkillDir: (id) => (id === "exp1" ? "/x/exp1/skills" : null),
      connectorSkillDirs: (ids) => ids.filter((i) => i === "c1").map((i) => `/x/${i}/skills`),
    });
    assert(
      paths.length === 2 && paths[0] === "/x/exp1/skills" && paths[1] === "/x/c1/skills",
      "仅当前专家 + 激活连接器进入候选路径（不扫描全部）",
    );
    assert(
      collectSessionSkillPaths(null, undefined, {
        expertSkillDir: () => null,
        connectorSkillDirs: () => [],
      }).length === 0,
      "无专家无连接器 → 空候选",
    );

    // renderer 显式 vs 默认契约（纯函数层）
    const { toRequestModelId, toRequestPermissionMode } = await import(
      "../src/renderer/src/lib/sessionContract"
    );
    assert(
      toRequestModelId({ explicit: false, value: "boot-default-model" }) === undefined,
      "未显式选模型（boot 默认值）→ 不传 explicit（Tag 建议可生效）",
    );
    assert(toRequestModelId({ explicit: true, value: "gpt-5" }) === "gpt-5", "显式模型直传");
    assert(toRequestModelId({ explicit: true, value: "" }) === undefined, "显式但空值 → undefined");
    assert(
      toRequestPermissionMode({ explicit: false, value: "default" }) === undefined,
      "未显式选权限（继承 default）→ 不传 explicit（Tag readonly 可生效）",
    );
    assert(
      toRequestPermissionMode({ explicit: true, value: "default" }) === "default",
      "显式选 default 也是显式（用户放弃 Tag 建议）",
    );
    assert(
      toRequestPermissionMode({ explicit: true, value: "readonly" }) === "readonly",
      "显式 readonly 直传",
    );

    // 全链路：renderer 契约输出 → 主进程 resolveEffective*（真实主路径等价）
    const perm1 = resolveEffectivePermission(
      toRequestPermissionMode({ explicit: false, value: "default" }),
      "readonly",
      "default",
    );
    assert(perm1 === "auto", "主路径：旧 Tag readonly 不再限制执行");
    const perm2 = resolveEffectivePermission(
      toRequestPermissionMode({ explicit: true, value: "default" }),
      "readonly",
      "default",
    );
    assert(perm2 === "auto", "主路径：旧显式 default 不再启用审批");
    const model1 = resolveEffectiveModelId(
      toRequestModelId({ explicit: false, value: "boot-default-model" }),
      "review-model",
      () => true,
    );
    assert(model1 === "review-model", "主路径：未显式 → Tag 建议模型生效");
    const model2 = resolveEffectiveModelId(
      toRequestModelId({ explicit: true, value: "gpt-5" }),
      "review-model",
      () => true,
    );
    assert(model2 === "gpt-5", "主路径：显式模型 → 用户优先");

    // appStore.sendMessage 真实主路径：payload 契约 + 显式标记联动
    const promptCalls: Array<Record<string, unknown>> = [];
    (globalThis as Record<string, unknown>).window = {
      matchMedia: () => ({ matches: false }),
      api: {
        agent: {
          prompt: async (req: Record<string, unknown>) => {
            promptCalls.push(req);
            return { queued: false };
          },
        },
        db: { upsertTask: async () => ({}), listTasks: async () => [] },
      },
    };
    const { useAppStore, applyPatchToMessage } = await import("../src/renderer/src/store/appStore");
    const queuedReply = { id: "queued-ui", role: "assistant" as const, createdAt: 0, blocks: [], streaming: true, pendingBehavior: "followUp" as const };
    const activatedReply = applyPatchToMessage(queuedReply, { type: "assistant_start", taskId: "ui", messageId: "queued-ui" });
    assert(activatedReply.pendingBehavior === undefined && activatedReply.streaming, "assistant_start 才将排队提示切换为执行状态");
    const cancelledReply = applyPatchToMessage(queuedReply, { type: "assistant_end", taskId: "ui", messageId: "queued-ui" });
    assert(cancelledReply.pendingBehavior === undefined && !cancelledReply.streaming, "结束或取消时清理排队提示");
    useAppStore.setState({
      tasks: [],
      activeTaskId: null,
      draft: null,
      activeModelId: "boot-default-model",
      modelExplicit: false,
      permissionMode: "default",
      permissionExplicit: false,
      activeConnectorIds: [],
      welcomeMode: "coding",
      modePresetId: "code-review",
      homeSpaceId: null,
    });
    // sendMessage 是 async：prompt 在 Promise.resolve(taskPersistence).then(...) 之后才调用；
    // 不 await 会读到空 promptCalls（旧断言因此空转通过）。
    await useAppStore.getState().sendMessage("普通新任务首条消息");
    const first = promptCalls[promptCalls.length - 1];
    assert(first?.modelId === undefined, "sendMessage 主路径：未显式 → modelId 不传");
    assert(first?.permissionMode === undefined, "sendMessage 主路径：未显式 → permissionMode 不传");
    assert(
      JSON.stringify(first?.connectorIds ?? []) === "[]",
      "新任务无 Active 连接器 → 空",
    );

    // 用户显式选择后：显式传递 + 任务级连接器
    // Explicit selection needs a model in the Pi-projected available list.
    useAppStore.setState({ models: [{ id: "gpt-5", name: "Fixture model", provider: "fixture", enabled: true, contextWindow: 272000 } as any] });
    useAppStore.getState().setActiveModel("gpt-5");
    useAppStore.getState().setPermissionMode("readonly");
    useAppStore.getState().setActiveConnectors(["c1"]);
    await useAppStore.getState().sendMessage("第二条");
    const second = promptCalls[promptCalls.length - 1];
    assert(second?.modelId === "gpt-5", "显式模型进入主路径 payload");
    assert(second?.permissionMode === "readonly", "显式权限进入主路径 payload");
    assert(
      JSON.stringify(second?.connectorIds) === JSON.stringify(["c1"]),
      "任务级 Active 连接器进入主路径 payload",
    );
    const activeTask = useAppStore.getState().tasks.find(
      (t) => t.id === useAppStore.getState().activeTaskId,
    );
    assert(
      JSON.stringify(activeTask?.connectorIds ?? []) === JSON.stringify(["c1"]),
      "Active 连接器持久到任务（任务级语义）",
    );
    // 草稿期挂载的连接器随首条消息写入新任务
    useAppStore.setState({ activeTaskId: null, draft: { spaceId: "s1" }, activeConnectorIds: ["c2"] });
    await useAppStore.getState().sendMessage("草稿消息");
    const draftTask = useAppStore.getState().tasks.find(
      (t) => t.id === useAppStore.getState().activeTaskId,
    );
    assert(
      JSON.stringify(draftTask?.connectorIds ?? []) === JSON.stringify(["c2"]),
      "草稿态连接器随首条消息写入新任务",
    );
    // 等待 sendMessage 异步链（prompt().then → upsertTask）落地后再拆 window stub
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete (globalThis as Record<string, unknown>).window;
  }

  /* ================= J2. F2 跨任务显式隔离 + F1 regenerate payload + F4 summonExpert ================= */
  console.log("\nJ2. explicit 任务级隔离 / regenerate payload / summonExpert 清空（F1/F2/F4）");
  {
    const promptCalls: Array<Record<string, unknown>> = [];
    const regenCalls: Array<Record<string, unknown>> = [];
    const savedModeProfiles = new Map<string, unknown>();
    const profileFor = (): Record<string, unknown> => ({
      id: "coding",
      labelZh: "编码",
      version: "1.0.0",
      blocks: [],
      hasUserOverride: false,
      totalChars: 0,
      userDir: "",
      policyPath: "",
      policy: {
        ...emptyModePolicy(),
        presets: [
          {
            id: "code-review",
            label: "代码审查",
            suggestedModelId: "review-model",
            suggestedPermissionMode: "readonly",
          },
        ],
      },
    });
    (globalThis as Record<string, unknown>).window = {
      matchMedia: () => ({ matches: false }),
      api: {
        agent: {
          prompt: async (req: Record<string, unknown>) => {
            promptCalls.push(req);
            return { queued: false };
          },
          regenerate: async (req: Record<string, unknown>) => {
            regenCalls.push(req);
          },
          getModeProfile: async (mode: string) => {
            if (!savedModeProfiles.has(mode)) savedModeProfiles.set(mode, profileFor());
            return savedModeProfiles.get(mode);
          },
          getContextUsage: async () => null,
          setTaskConnectorIds: async () => {},
          setPermissionMode: async () => {},
          switchExpert: async () => {},
        },
        db: { upsertTask: async () => ({}), listTasks: async () => [] },
      },
    };
    const { useAppStore } = await import("../src/renderer/src/store/appStore");

    // 任务 A（已显式选模型/权限）与任务 B（未显式，继承默认）
    useAppStore.setState({
      tasks: [
        {
          id: "A",
          title: "A",
          updatedAt: Date.now(),
          messages: [],
          modelId: "gpt-5",
          modelExplicit: true,
          permissionMode: "readonly",
          permissionExplicit: true,
          welcomeMode: "coding",
          modePresetId: "code-review",
          connectorIds: [],
        },
        {
          id: "B",
          title: "B",
          updatedAt: Date.now(),
          messages: [],
          modelId: "m-b",
          permissionMode: "default",
          welcomeMode: "coding",
          modePresetId: "code-review",
          connectorIds: [],
        },
      ],
      activeTaskId: "A",
      draft: null,
      activeModelId: "gpt-5",
      modelExplicit: true,
      permissionMode: "readonly",
      permissionExplicit: true,
      activeConnectorIds: [],
      welcomeMode: "coding",
      modePresetId: "code-review",
      homeSpaceId: null,
      models: [
        {
          id: "review-model",
          name: "review",
          vendor: "v",
          supportsToolCall: true,
          supportsImages: false,
          supportsReasoning: false,
          contextWindow: 128000,
          thinkingLevels: [],
        },
        {
          id: "gpt-5",
          name: "gpt5",
          vendor: "v",
          supportsToolCall: true,
          supportsImages: false,
          supportsReasoning: false,
          contextWindow: 128000,
          thinkingLevels: [],
        },
      ],
    });

    // 切到任务 B（未显式）→ 不泄漏 A 的 explicit 标记
    useAppStore.getState().setActiveTask("B");
    assert(
      useAppStore.getState().modelExplicit === false &&
        useAppStore.getState().permissionExplicit === false,
      "F2：切到未显式任务 → explicit 标记不泄漏",
    );
    await useAppStore.getState().sendMessage("B 首条消息");
    const bPayload = promptCalls[promptCalls.length - 1];
    assert(
      bPayload?.modelId === undefined && bPayload?.permissionMode === undefined,
      "F2：任务 B 未显式 → 不传 explicit（Tag 建议可生效）",
    );

    // 切回任务 A → 显式选择保持
    useAppStore.getState().setActiveTask("A");
    assert(
      useAppStore.getState().modelExplicit === true &&
        useAppStore.getState().permissionExplicit === true,
      "F2：切回显式任务 → 标记恢复",
    );
    await useAppStore.getState().sendMessage("A 继续");
    const aPayload = promptCalls[promptCalls.length - 1];
    assert(
      aPayload?.modelId === "gpt-5" && aPayload?.permissionMode === "readonly",
      "F2：任务 A 显式值继续作为 explicit 传递",
    );

    // 新任务：默认跟随 Tag/Mode（不继承任何 explicit）
    useAppStore.getState().newTask();
    assert(
      useAppStore.getState().modelExplicit === false &&
        useAppStore.getState().permissionExplicit === false,
      "F2：新任务不继承 explicit 标记",
    );

    // F4：summonExpert 清空 Active 连接器（不继承上一任务）
    useAppStore.setState({ activeConnectorIds: ["c1"] });
    useAppStore.getState().summonExpert("e1", "s1");
    assert(
      JSON.stringify(useAppStore.getState().activeConnectorIds) === "[]" &&
        useAppStore.getState().modelExplicit === false &&
        useAppStore.getState().permissionExplicit === false,
      "F4：summonExpert 清空连接器与 explicit 标记",
    );

    // 复位「跟随场景建议」：清除显式标记并按 Tag 建议解析
    useAppStore.setState({
      activeTaskId: "A",
      tasks: [
        {
          id: "A",
          title: "A",
          updatedAt: Date.now(),
          messages: [],
          modelId: "gpt-5",
          modelExplicit: true,
          permissionMode: "readonly",
          permissionExplicit: true,
          welcomeMode: "coding",
          modePresetId: "code-review",
          connectorIds: [],
        },
      ],
      activeModelId: "gpt-5",
      modelExplicit: true,
      permissionMode: "readonly",
      permissionExplicit: true,
    });
    await useAppStore.getState().followSuggestedModel();
    const fmState = useAppStore.getState();
    assert(
      fmState.modelExplicit === false && fmState.activeModelId === "review-model",
      `F2：followSuggestedModel 清标记并按 Tag 建议解析（explicit=${fmState.modelExplicit} model=${fmState.activeModelId}）`,
    );
    assert(
      useAppStore.getState().tasks.find((t) => t.id === "A")?.modelExplicit === false,
      "F2：任务 A 的 modelExplicit 同步复位",
    );
    await useAppStore.getState().followSuggestedPermission();
    assert(
      useAppStore.getState().permissionExplicit === false &&
        useAppStore.getState().permissionMode === "readonly",
      "F2：followSuggestedPermission 清标记并按 Tag 建议解析",
    );

    // F1 renderer 侧：regenerate 请求必须携带任务级 Active 连接器
    useAppStore.setState({
      tasks: [
        {
          id: "R",
          title: "R",
          updatedAt: Date.now(),
          messages: [
            { id: "u1", role: "user", createdAt: Date.now(), blocks: [{ type: "text", text: "hi" }] },
            { id: "a1", role: "assistant", createdAt: Date.now(), blocks: [] },
            { id: "u2", role: "user", createdAt: Date.now(), blocks: [{ type: "text", text: "go" }] },
            { id: "a2", role: "assistant", createdAt: Date.now(), blocks: [] },
          ],
          modelId: "gpt-5",
          permissionMode: "default",
          welcomeMode: "coding",
          modePresetId: "code-review",
          connectorIds: ["c1", "c2"],
        },
      ],
      activeTaskId: "R",
      activeModelId: "gpt-5",
      modelExplicit: false,
      permissionMode: "default",
      permissionExplicit: false,
      activeConnectorIds: ["c1", "c2"],
    });
    useAppStore.getState().regenerateMessage("a2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const regen = regenCalls[regenCalls.length - 1];
    assert(
      JSON.stringify(regen?.connectorIds ?? []) === JSON.stringify(["c1", "c2"]),
      "F1 renderer：regenerate 请求携带任务级 connectorIds",
    );
    assert(regen?.userMessageIndex === 1, "regenerate 定位到正确的用户消息索引");
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete (globalThis as Record<string, unknown>).window;
  }

  /* ================= K. Connector enabled 生命周期（安装 ≠ active） ================= */
  console.log("\nK. Connector enabled 生命周期（安装≠active）");
  {
    const connDir = join(sandbox, ".mybuddy", "plugins", "connector-market", "connectors", "demo2");
    write(join(connDir, "connector-meta.json"), JSON.stringify({ name: "演示连接器2" }));
    write(join(connDir, "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    const svc = new ConnectorService();
    const skills = new SkillsService();
    svc.install("demo2");
    const regSkills = join(sandbox, ".mybuddy", "plugins", "connectors", "demo2", "skills");
    assert(
      JSON.stringify(svc.getPrivateSkillDirs(["demo2"])) === JSON.stringify([regSkills]),
      "安装后默认 enabled → 私有技能进入候选",
    );
    assert(svc.list().find((c) => c.id === "demo2")?.enabled !== false, "DTO.enabled 默认 true");

    svc.setEnabled("demo2", false);
    assert(svc.list().find((c) => c.id === "demo2")?.enabled === false, "停用后 DTO.enabled=false");
    assert(
      svc.getPrivateSkillDirs(["demo2"]).length === 0,
      "停用连接器私有技能不进入候选（安装≠active）",
    );
    // 装配层一致性：collectSessionSkillPaths 经 getPrivateSkillDirs 门禁后同样为空
    const { collectSessionSkillPaths } = await import("../src/main/agent/sessionSkillPaths");
    assert(
      collectSessionSkillPaths(null, ["demo2"], {
        expertSkillDir: () => null,
        connectorSkillDirs: (ids) => svc.getPrivateSkillDirs(ids),
      }).length === 0,
      "停用连接器不进入会话候选路径（装配层一致）",
    );

    svc.setEnabled("demo2", true);
    assert(
      svc.getPrivateSkillDirs(["demo2"]).length === 1,
      "重新启用后私有技能恢复候选",
    );
    try {
      svc.setEnabled("not-installed", true);
      assert(false, "未安装连接器 setEnabled 应抛错");
    } catch {
      assert(true, "未安装连接器 setEnabled 抛错");
    }
    svc.uninstall("demo2");
  }

  /* ================= K2. F3 芯片过滤 / 持久化 / 会话 dirty 标记 ================= */
  console.log("\nK2. F3 chip 过滤 / settings 持久化 / assemblyDirty 标记");
  {
    // 停用连接器不显示为 active chip；重启用自动恢复（安装 ≠ active，停用 ≠ 引用）
    const { activeConnectorChips } = await import("../src/renderer/src/lib/connectorChips");
    const conns = [
      { id: "c1", name: "C1", description: "", enabled: true, installed: true, installedSkillNames: [], skillCount: 0, sourcePath: "" },
      { id: "c2", name: "C2", description: "", enabled: false, installed: true, installedSkillNames: [], skillCount: 0, sourcePath: "" },
    ];
    assert(
      activeConnectorChips(conns, ["c1", "c2"]).map((c) => c.id).join(",") === "c1",
      "F3：停用连接器不显示为 active chip",
    );
    assert(
      activeConnectorChips(conns, ["c1"]).map((c) => c.id).join(",") === "c1",
      "F3：启用连接器正常显示",
    );
    assert(
      activeConnectorChips(
        [{ ...conns[1]!, enabled: true }],
        ["c2"],
      ).map((c) => c.id).join(",") === "c2",
      "F3：重新启用后 chip 自动恢复（任务 connectorIds 不变）",
    );

    // F3：任务级 Active 连接器持久化（settings.json 可扩展字段，无新 DB schema）
    const { AppSettingsStore } = await import("../src/main/AppSettingsStore");
    const store = new AppSettingsStore();
    assert(store.getTaskConnectorIds("t1") === undefined, "无记录 → undefined（不落盘默认值）");
    store.setTaskConnectorIds("t1", ["c1", "c1", " c2 "]);
    assert(
      JSON.stringify(store.getTaskConnectorIds("t1")) === JSON.stringify(["c1", "c2"]),
      "写入去重/去空白",
    );
    const reloaded = new AppSettingsStore();
    assert(
      JSON.stringify(reloaded.getTaskConnectorIds("t1")) === JSON.stringify(["c1", "c2"]),
      "重读（重启等价）后仍可恢复",
    );
    store.setTaskConnectorIds("t1", []);
    assert(
      JSON.stringify(store.getTaskConnectorIds("t1")) === JSON.stringify([]),
      "空数组显式记录（区别于未设置）",
    );
    store.clearTaskConnectorIds("t1");
    assert(store.getTaskConnectorIds("t1") === undefined, "删除任务后清理记录");
    store.setTaskConnectorIds("t1", ["c1"]);
    store.clearTaskConnectorIds("t-other");
    assert(
      JSON.stringify(store.getTaskConnectorIds("t1")) === JSON.stringify(["c1"]),
      "清理其它任务不影响本任务",
    );

    // F1 根因纯函数：装配检测 + regenerate 连接器保留
    const { assemblyInputsChanged, resolveRegenerateConnectorIds } = await import(
      "../src/main/agent/SessionRegistry"
    );
    assert(
      resolveRegenerateConnectorIds(["c1"], undefined, undefined)?.join(",") === "c1",
      "F1：请求显式连接器优先",
    );
    assert(
      resolveRegenerateConnectorIds(undefined, ["c1"], ["c0"])?.join(",") === "c1",
      "F1：无请求值 → 沿用 entry 连接器",
    );
    assert(
      resolveRegenerateConnectorIds(undefined, undefined, ["c0"])?.join(",") === "c0",
      "F1：无 entry → 沿用重建前捕获值",
    );
    assert(
      assemblyInputsChanged({ connectorIds: ["c1"] }, null, ["c1"]) === false,
      "F1：connectorIds 一致 → 不重建（regenerate 全链保留后不再误判）",
    );
    assert(
      assemblyInputsChanged({ connectorIds: ["c1"] }, null, undefined) === true,
      "F1 根因：entry 有连接器而请求缺省 → 判定变更（修复前触发错误重建）",
    );
    assert(
      assemblyInputsChanged({ connectorIds: ["c1"], assemblyDirty: true }, null, ["c1"]) === true,
      "F3：assemblyDirty 标记 → 下一轮重建",
    );
    assert(
      assemblyInputsChanged({ connectorIds: ["c1"], expertId: "e1" }, null, ["c1"]) === true,
      "专家变更 → 重建",
    );

    // F3：SessionRegistry.markConnectorDirty 只标记装配了该连接器的会话
    const { SessionRegistry } = await import("../src/main/agent/SessionRegistry");
    const reg = new SessionRegistry();
    const mkEntry = (taskId: string, connectorIds: string[]) =>
      ({
        taskId,
        session: { dispose: () => {}, unsubscribe: () => {} },
        unsubscribe: () => {},
        cwd: "C:/x",
        permissionMode: "default",
        connectorIds,
        assemblyDirty: false,
      }) as unknown as import("../src/main/agent/SessionRegistry").SessionEntry;
    reg.set(mkEntry("t1", ["c1"]));
    reg.set(mkEntry("t2", ["c2"]));
    const affected = reg.markConnectorDirty("c1");
    assert(affected.join(",") === "t1", "F3：仅含 c1 的会话被标记");
    assert(reg.get("t1")?.assemblyDirty === true, "F3：t1 assemblyDirty=true");
    assert(reg.get("t2")?.assemblyDirty === false, "F3：t2 不受影响");
    assert(reg.markConnectorDirty("nope").length === 0, "F3：未装配连接器 → 无影响");
  }

  /* ================= L. 旧版 Connector 全局技能副本安全迁移 ================= */
  console.log("\nL. 旧版 Connector 全局技能副本安全迁移（幂等 / meta 归属 / 不误删）");
  {
    const svc = new ConnectorService();
    // 已注册连接器 demo3（旧安装可能无配套技能副本，或包技能已变化）
    const regDir = join(sandbox, ".mybuddy", "plugins", "connectors", "demo3");
    mkdirSync(regDir, { recursive: true });
    writeFileSync(
      join(regDir, "meta.json"),
      JSON.stringify({ id: "demo3", installedAt: Date.now(), installedSkillNames: [] }),
    );
    // 其旧全局副本（meta source=connector:demo3）→ 应迁入连接器私有目录
    write(join(sandbox, ".mybuddy", "plugins", "skills", "beta", "SKILL.md"), skillMd("beta"));
    write(
      join(sandbox, ".mybuddy", "plugins", "skills", "beta", "_skillhub_meta.json"),
      JSON.stringify({ source: "connector:demo3" }),
    );
    // 无归属共享技能 → 绝不触碰
    write(join(sandbox, ".mybuddy", "plugins", "skills", "shared", "SKILL.md"), skillMd("shared"));
    // 注册缺失（连接器已删/从未安装）的旧副本 → 保留（不误删）
    write(join(sandbox, ".mybuddy", "plugins", "skills", "orphan", "SKILL.md"), skillMd("orphan"));
    write(
      join(sandbox, ".mybuddy", "plugins", "skills", "orphan", "_skillhub_meta.json"),
      JSON.stringify({ source: "connector:gone" }),
    );

    const r = svc.migrateLegacyGlobalSkills();
    assert(r.migrated === 1 && r.removed === 0, "旧全局副本迁入连接器私有目录");
    assert(!existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "beta")), "迁移后全局副本移除");
    assert(
      existsSync(join(sandbox, ".mybuddy", "plugins", "connectors", "demo3", "skills", "beta", "SKILL.md")),
      "迁移目标位于连接器私有目录",
    );
    assert(existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "shared")), "共享技能不受影响");
    assert(existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "orphan")), "注册缺失的旧副本保留（不误删）");

    // 幂等：二次运行零迁移
    const r2 = svc.migrateLegacyGlobalSkills();
    assert(r2.migrated === 0 && r2.removed === 0, "迁移幂等：二次运行无操作");

    // 新安装已复制同名目标（大小写变体）→ 仅清理旧全局副本（removed 路径）
    write(join(sandbox, ".mybuddy", "plugins", "skills", "BETA", "SKILL.md"), skillMd("beta"));
    write(
      join(sandbox, ".mybuddy", "plugins", "skills", "BETA", "_skillhub_meta.json"),
      JSON.stringify({ source: "connector:demo3" }),
    );
    const r3 = svc.migrateLegacyGlobalSkills();
    assert(r3.removed === 1 && r3.migrated === 0, "同名目标已存在（大小写变体）→ 仅清旧副本");
    assert(!existsSync(join(sandbox, ".mybuddy", "plugins", "skills", "BETA")), "大小写变体旧副本已清理");
    assert(
      existsSync(join(sandbox, ".mybuddy", "plugins", "connectors", "demo3", "skills", "beta", "SKILL.md")),
      "连接器私有目录同名副本保留",
    );
    svc.uninstall("demo3");
  }

  /* ================= M. AgentService 集成（F1/F3/P3-1/P3-3/P3-4 真实 Durable 存储与模型边界夹具） ================= */
  console.log("\nM. AgentService 集成回归（F1 regenerate / F3 dirty / P3 释放/预览/disabled expert）");
  {
    const { AppDatabase } = await import("../src/main/db/AppDatabase");
    const { ExpertService } = await import("../src/main/experts/ExpertService");
    const { SkillsService } = await import("../src/main/skills/SkillsService");
    const { ConnectorService } = await import("../src/main/connectors/ConnectorService");
    const { collectSessionSkillPaths } = await import("../src/main/agent/sessionSkillPaths");

    const db = new AppDatabase();
    const { createAgentDurableFixture } = await import("./agent-durable-fixture");
    const fixture = await createAgentDurableFixture(sandbox, db);
    const { agent, requests } = fixture;
    const runtimeRequirements = (agent as unknown as {
      runtimeRequirements: { ensurePresetReady: (preset?: unknown) => Promise<void> };
    }).runtimeRequirements;
    const expertSvc = new ExpertService();
    const skillsSvc = new SkillsService();

    // 全局技能 alpha（重名诊断用）；连接器 demoX（F3/预览用）；专家 demo-expert（私有 alpha/beta）
    write(join(sandbox, ".mybuddy", "plugins", "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    const connDir = join(sandbox, ".mybuddy", "plugins", "connector-market", "connectors", "demoX");
    write(join(connDir, "connector-meta.json"), JSON.stringify({ name: "演示X" }));
    write(join(connDir, "skills", "gamma", "SKILL.md"), skillMd("gamma"));
    new ConnectorService().install("demoX");
    const pkgDir = join(sandbox, "expert-pkg-m");
    write(
      join(pkgDir, ".codebuddy-plugin", "plugin.json"),
      JSON.stringify({ name: "demo-expert", displayName: { zh: "演示专家" } }),
    );
    write(join(pkgDir, "agents", "demo-expert.md"), "---\nname: demo-expert\ndescription: demo\n---\n# Demo\n");
    write(join(pkgDir, "skills", "alpha", "SKILL.md"), skillMd("alpha"));
    write(join(pkgDir, "skills", "beta", "SKILL.md"), skillMd("beta"));
    expertSvc.installByPath(pkgDir);

    db.upsertTask({ id: "reg-task", title: "Native regeneration", updatedAt: 1, welcomeMode: "coding" });
    const initial = { taskId: "reg-task", text: "hello\n\n## 用户附带文件\n- fixture.txt", displayText: "hello",
      userMessageId: "reg-user", assistantMessageId: "reg-answer", connectorIds: ["demoX"] };
    await fixture.prompt(initial);
    assert(requests.at(-1)?.instructions.includes("gamma"), "连接器私有技能进入原生模型请求");
    const history = await agent.loadTaskHistory("reg-task");
    const user = history.messages.find(message => message.role === "user")!;
    const retry = { taskId: "reg-task", requestId: "native-regenerate", userMessageIndex: 0,
      sourceUserMessageId: user.id, sourceUserEntryId: user.entryId, sourceAssistantMessageId: "reg-answer",
      assistantMessageId: "regenerated", expectedUserTextHash: normalizedEditorTextHash("hello") };
    const before = requests.length;
    const missingTask = await agent.regenerate({ ...retry, taskId: "missing-task" });
    assert(!missingTask.ok && missingTask.code === "SESSION_NOT_FOUND", "不存在的任务返回明确错误");
    const missingTarget = await agent.regenerate({ ...retry, sourceUserEntryId: undefined, userMessageIndex: 99 });
    assert(!missingTarget.ok && missingTarget.code === "TARGET_NOT_FOUND", "不存在的用户消息返回明确错误");
    const wrongUser = await agent.regenerate({ ...retry, sourceUserMessageId: "different-user" });
    assert(!wrongUser.ok && wrongUser.code === "TARGET_DRIFTED" && requests.length === before, "禁止跨用户消息重新生成");
    const drifted = await agent.regenerate({ ...retry, expectedUserTextHash: normalizedEditorTextHash("changed") });
    assert(!drifted.ok && drifted.code === "TARGET_DRIFTED" && requests.length === before, "原始输入漂移时拒绝重新生成，不调用模型");
    const regenerated = await agent.regenerate(retry);
    assert(regenerated.ok, "原生分支按展示文本校验重新生成，保留附件上下文");
    const receipt = await agent.findSubmission("reg-task", `regenerate:${retry.requestId}`);
    if (!receipt?.receipt) throw new Error("Missing regeneration receipt");
    await agent.waitForSubmission(receipt.receipt);
    const after = requests.length;
    assert(after === before + 1, "重新生成恰执行一次原生模型调用");
    assert(requests.at(-1)?.instructions.includes("gamma"), "重新生成保留连接器私有技能");
    assert((await agent.regenerate(retry)).ok && requests.length === after, "重试原生回执不会重复生成");
    agent.setConnectorEnabled("demoX", false);
    await fixture.prompt({ ...initial, userMessageId: "disabled-user", assistantMessageId: "disabled-answer" });
    assert(!requests.at(-1)?.instructions.includes("gamma"), "停用连接器后下一轮移除私有技能");
    agent.setConnectorEnabled("demoX", true);
    await fixture.prompt({ ...initial, userMessageId: "enabled-user", assistantMessageId: "enabled-answer" });
    assert(requests.at(-1)?.instructions.includes("gamma"), "重新启用后下一轮恢复连接器技能");

    db.upsertTask({ id: "retry-preflight", title: "Preflight retry", updatedAt: 1, welcomeMode: "coding" });
    const prepare = runtimeRequirements.ensurePresetReady;
    const preflight = { taskId: "retry-preflight", text: "retry", userMessageId: "preflight-user", assistantMessageId: "preflight-answer" };
    runtimeRequirements.ensurePresetReady = async () => { throw new Error("fixture connection failure"); };
    try {
      await agent.prompt(preflight).then(() => { throw new Error("preflight unexpectedly accepted"); }, error => {
        assert(error instanceof Error && error.message.includes("fixture connection failure"), "准备失败明确返回错误");
      });
      assert(!await agent.findSubmission(preflight.taskId, preflight.userMessageId), "准备失败不产生虚假回执");
    } finally { runtimeRequirements.ensurePresetReady = prepare; }
    await fixture.prompt(preflight);
    const beforeRepeat = requests.length;
    await fixture.prompt(preflight);
    assert(requests.length === beforeRepeat, "准备恢复后同一操作身份只执行一次");

    // ---- P3-1/F/G：预览携带 Tag + 专家 + 连接器；effective 与 createSession 同源；重名诊断 ----
    const profile = (
      agent as unknown as { modeProfiles: { getProfile(m: string): import("../src/shared/mode-profile").ModeProfileDto } }
    ).modeProfiles.getProfile("coding");
    const expected = resolveEffectiveModePolicy(profile.policy, resolveModePreset(profile.policy, "code-review"));
    const trace = agent.assembleModePreview({
      welcomeMode: "coding",
      modePresetId: "code-review",
      expertId: "demo-expert",
      connectorIds: ["demoX"],
    });
    assert(
      JSON.stringify(trace.mcpPolicy.allow) === JSON.stringify(expected.mcpPolicy.allow) &&
        JSON.stringify(trace.mcpPolicy.deny) === JSON.stringify(expected.mcpPolicy.deny),
      "F：预览 mcpPolicy 与 createSession effective 合成一致",
    );
    assert(
      !trace.segments.some((s) => s.id === "permission" || s.id === "shell"),
      "F：提示词预览不再注入 MyBuddy permission 或 shell 行为说明",
    );
    assert(trace.skillFilter.visible.includes("gamma"), "P3-1：预览包含 Active Connector 私有技能");
    assert(trace.skillFilter.visible.includes("beta"), "P3-1：预览包含当前专家私有技能");
    const narrowedTrace = agent.assembleModePreview({
      welcomeMode: "coding",
      modePresetId: "code-review",
      expertId: "demo-expert",
      connectorIds: ["demoX"],
    }, {
      connectorIds: [],
      skillIds: ["beta"],
      mcpIds: [],
      narrowed: true,
      fingerprint: "fixture-loadout",
    });
    assert(!narrowedTrace.skillFilter.visible.includes("gamma"), "Loadout effective selection removes deselected Connector private skill");
    assert(narrowedTrace.skillFilter.visible.includes("beta"), "Loadout effective selection preserves selected Expert private skill");
    assert(
      narrowedTrace.capabilities?.some((item) => item.kind === "connector" && item.id === "demoX" && !item.enabled && item.reason === "loadout_not_selected"),
      "Loadout effective selection is visible in capability trace",
    );
    assert(
      trace.warnings.some((w) => w.includes("alpha") && w.includes("同名")),
      "G：重名诊断出现在预览 warnings（first-wins 优先级不变，仅提示）",
    );
    const shadowed = skillsSvc.listShadowedSkillNames(sandbox, [
      expertSvc.getPrivateSkillsDir("demo-expert")!,
    ]);
    assert(
      shadowed.includes("alpha") && !shadowed.includes("beta"),
      "G：仅被全局同名覆盖的私有技能进入诊断",
    );
    const details = expertSvc.listExpertPrivateSkills("demo-expert");
    assert(
      details.find((d) => d.id === "alpha")?.shadowed === true &&
        details.find((d) => d.id === "beta")?.shadowed !== true,
      "G：专家详情标记 alpha 被全局覆盖、beta 正常",
    );

    // ---- P3-4：disabled 专家不注入私有技能（enabled gate） ----
    expertSvc.setEnabled("demo-expert", false);
    assert(
      expertSvc.getPrivateSkillsDir("demo-expert") === null,
      "E：disabled 专家不再提供私有技能目录",
    );
    assert(
      collectSessionSkillPaths("demo-expert", [], {
        expertSkillDir: (id) => expertSvc.getPrivateSkillsDir(id),
        connectorSkillDirs: () => [],
      }).length === 0,
      "E：disabled 专家不进会话候选路径",
    );
    const trace2 = agent.assembleModePreview({ welcomeMode: "coding", expertId: "demo-expert" });
    assert(
      !trace2.skillFilter.visible.includes("beta"),
      "E：预览不再包含 disabled 专家私有技能",
    );
    expertSvc.setEnabled("demo-expert", true);
    assert(
      expertSvc.getPrivateSkillsDir("demo-expert") !== null,
      "E：重新启用后私有技能恢复",
    );

    await fixture.close();
    db.close();
  }

  /* ================= N. 收口回归：P1 重启兜底 / P2 预览守卫 + shadowed cwd / settings 生命周期 ================= */
  console.log("\nN. P1 重启兜底 + P2 预览守卫/shadowed cwd + F3 settings 原子写与 purge 清理");
  {
    const { resolveSessionRestartFallback } = await import("../src/main/agent/SessionRegistry");
    const { AppSettingsStore, getSettingsPath } = await import("../src/main/AppSettingsStore");
    const { TaskExecutionWorkspaceLifecycle } = await import("../src/main/task/TaskExecutionWorkspaceLifecycle");
    const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
    const { previewBlockedHint } = await import("../src/renderer/src/lib/modesPreviewGuard");
    const { isManagedToolProvider, MANAGED_TOOL_PROVIDER_IDS } = await import(
      "../src/shared/professional-tools",
    );
    const { ExpertService } = await import("../src/main/experts/ExpertService");
    const { SkillsService } = await import("../src/main/skills/SkillsService");
    const expertSvcN = new ExpertService();
    const skillsSvcN = new SkillsService();

    // ---- N1. P1 重启 explicit 语义：resolveSessionRestartFallback 矩阵 + 真实 DB 行 ----
    // 新任务（无行）：无兜底 → 走 显式 > Tag/Mode 建议 > 默认 链
    const fbNew = resolveSessionRestartFallback({}, undefined);
    assert(
      fbNew.modelId === undefined && fbNew.permissionMode === undefined,
      "N1：新任务无兜底（走建议链）",
    );
    // 已有任务首次会话（无 sessionFile = 未锁定）：不冻结持久化值，仍走建议链
    const fbUnlocked = resolveSessionRestartFallback({}, { modelId: "X", permissionMode: "auto" });
    assert(
      fbUnlocked.modelId === undefined && fbUnlocked.permissionMode === undefined,
      "N1：未锁定任务（无会话）不冻结持久化值，仍走建议链",
    );
    // 已有任务重启恢复（sessionFile = 上次生效值已落库）：沿用持久化值（优先于建议）
    const fbLocked = resolveSessionRestartFallback(
      {},
      { sessionFile: "s.jsonl", modelId: "X", permissionMode: "auto" },
    );
    assert(fbLocked.modelId === "X" && fbLocked.permissionMode === "auto", "N1：重启恢复沿用上次生效值");
    // 显式请求永远优先
    const fbExplicit = resolveSessionRestartFallback(
      { modelId: "Y", permissionMode: "readonly" },
      { sessionFile: "s.jsonl", modelId: "X", permissionMode: "auto" },
    );
    assert(
      fbExplicit.modelId === "Y" && fbExplicit.permissionMode === "readonly",
      "N1：显式请求优先于重启兜底",
    );
    // followSuggested 语义：解析值已写回 DB → 兜底返回的正是建议解析值（建议链经 DB 生效）
    const fbFollowed = resolveSessionRestartFallback(
      {},
      { sessionFile: "s.jsonl", modelId: "tag-suggested", permissionMode: "default" },
    );
    assert(fbFollowed.modelId === "tag-suggested", "N1：followSuggested 后兜底=建议解析值");
    // 与真实 resolution 链组合：新任务 → 建议生效；重启任务 → 兜底生效（建议被压制）
    assert(
      resolveEffectiveModelId(fbUnlocked.modelId, "tag-suggest", () => true) === "tag-suggest",
      "N1：新任务建议链生效",
    );
    assert(
      resolveEffectiveModelId(fbLocked.modelId, "tag-suggest", () => true) === "X",
      "N1：重启任务兜底压制建议（UI/DB 显示值一致）",
    );
    assert(
      resolveEffectivePermission(fbUnlocked.permissionMode, "readonly", "default") === "auto" &&
        resolveEffectivePermission(fbLocked.permissionMode, "readonly", "default") === "auto",
      "N1：旧权限配置不因新建或重启重新启用审批",
    );
    // 真实 DB 行：重启恢复路径从 DB 取值（模拟 renderer flag 丢失后主进程仍用上次生效值）
    const nDb = new AppDatabase(join(sandbox, "n1.db"));
    nDb.upsertTask({
      id: "n-restart",
      title: "t",
      updatedAt: Date.now(),
      sessionFile: "s.jsonl",
      modelId: "X",
      permissionMode: "auto",
    });
    const nRow = nDb.listTasks().find((t) => t.id === "n-restart");
    assert(nRow?.sessionFile != null, "N1：DB 行含 sessionFile");
    const fbDb = resolveSessionRestartFallback({}, nRow);
    assert(
      fbDb.modelId === "X" && fbDb.permissionMode === "auto",
      "N1：重启兜底取自真实 DB 行（显式值在重启后仍被主进程使用）",
    );
    nDb.close();

    // ---- N2. 预览 dirty 守卫（P2）：未保存修改时阻断预览并提示基于已保存配置 ----
    assert(previewBlockedHint(false) === null, "N2：无未保存修改不阻断预览");
    assert(
      (previewBlockedHint(true) ?? "").includes("已保存"),
      "N2：dirty 时预览被阻断并提示基于已保存配置",
    );

    // ---- P3-1：回同步守卫读取目标任务自身 explicit flag（轮次内切任务/显式改选不被旧 row 回退） ----
    {
      (globalThis as Record<string, unknown>).window = {
        matchMedia: () => ({ matches: false }),
        api: {
          agent: {
            prompt: async () => ({ queued: false }),
            getContextUsage: async () => null,
            setTaskConnectorIds: async () => {},
            setPermissionMode: async () => {},
            switchExpert: async () => {},
          },
          db: {
            upsertTask: async () => ({}),
            // 主进程落库生效值：模拟 createSession 后 row.modelId/permissionMode 为 ROW 值
            listTasks: async () => [
              {
                id: "T",
                modelId: "ROW-MODEL",
                permissionMode: "auto",
                sessionFile: "s.jsonl",
                cwd: "c",
              },
            ],
          },
        },
      };
      const { useAppStore: storeSync } = await import("../src/renderer/src/store/appStore");
      const flushSync = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
      const mkTask = (over: Partial<RendererTask>): RendererTask => ({
        id: "T",
        title: "T",
        updatedAt: Date.now(),
        messages: [],
        welcomeMode: "coding",
        modelId: "X",
        permissionMode: "default",
        connectorIds: [],
        ...over,
      });
      const syncBase: Partial<ReturnType<typeof storeSync.getState>> = {
        activeTaskId: "T",
        draft: null,
        activeModelId: "X",
        modelExplicit: false,
        permissionMode: "default",
        permissionExplicit: false,
        activeConnectorIds: [],
        welcomeMode: "coding",
        modePresetId: null,
        homeSpaceId: null,
        chatSelections: [],
        models: [
          { id: "X", name: "X", vendor: "v", supportsToolCall: true, supportsImages: false, supportsReasoning: false, contextWindow: 128000, thinkingLevels: [] },
          { id: "ROW-MODEL", name: "R", vendor: "v", supportsToolCall: true, supportsImages: false, supportsReasoning: false, contextWindow: 128000, thinkingLevels: [] },
        ],
      };

      // A：T 未显式 → 主进程生效值回同步到 T（模型+权限）
      storeSync.setState({ ...syncBase, tasks: [mkTask({})] });
      storeSync.getState().sendMessage("hi");
      await flushSync();
      const tA = storeSync.getState().tasks.find((t: { id: string }) => t.id === "T") as {
        modelId?: string;
        permissionMode?: string;
      };
      assert(
        tA?.modelId === "ROW-MODEL" && tA?.permissionMode === "auto",
        "P3-1：未显式任务收到主进程生效值回同步",
      );

      // B：T 自身显式改选（任务 flag）→ 旧 row 不回退
      storeSync.setState({
        ...syncBase,
        tasks: [
          mkTask({ modelId: "PICK", modelExplicit: true, permissionMode: "readonly", permissionExplicit: true }),
        ],
      });
      storeSync.getState().sendMessage("hi");
      await flushSync();
      const tB = storeSync.getState().tasks.find((t: { id: string }) => t.id === "T") as {
        modelId?: string;
        permissionMode?: string;
      };
      assert(
        tB?.modelId === "PICK" && tB?.permissionMode === "readonly",
        "P3-1：目标任务显式改选不被旧 row 回退",
      );

      // C：T 发消息后切到 U（U 未显式）→ 回同步仍按 T 自身 flag 判定：T 未显式 → 同步
      storeSync.setState({ ...syncBase, tasks: [mkTask({})] });
      storeSync.getState().sendMessage("hi");
      storeSync.setState({ activeTaskId: "U" });
      await flushSync();
      const tC = storeSync.getState().tasks.find((t: { id: string }) => t.id === "T") as {
        modelId?: string;
      };
      assert(tC?.modelId === "ROW-MODEL", "P3-1：切到 U 后 T 的回同步仍生效（U 状态不影响 T）");

      // D：T 显式改选 + 切到 U → T 的显式值必须保持（守卫读 T 自身 flag，而非活跃任务）
      storeSync.setState({
        ...syncBase,
        tasks: [
          mkTask({ modelId: "PICK", modelExplicit: true, permissionMode: "readonly", permissionExplicit: true }),
        ],
      });
      storeSync.getState().sendMessage("hi");
      storeSync.setState({ activeTaskId: "U", modelExplicit: false, permissionExplicit: false });
      await flushSync();
      const tD = storeSync.getState().tasks.find((t: { id: string }) => t.id === "T") as {
        modelId?: string;
        permissionMode?: string;
      };
      assert(
        tD?.modelId === "PICK" && tD?.permissionMode === "readonly",
        "P3-1：T 显式值在切到 U 后仍保持（不被旧 row 回退）",
      );
    }

    // ---- N3. shadowed 诊断 cwd 对齐（P2）：任务 cwd 项目技能覆盖私有技能须报告；异 cwd 不假阳性 ----
    const taskCwdA = join(sandbox, "taskA");
    mkdirSync(join(taskCwdA, ".pi", "skills", "projskill"), { recursive: true });
    write(join(taskCwdA, ".pi", "skills", "projskill", "SKILL.md"), skillMd("projskill"));
    const taskCwdB = join(sandbox, "taskB");
    mkdirSync(taskCwdB, { recursive: true });
    const expDirN = expertSvcN.getPrivateSkillsDir("demo-expert");
    assert(expDirN != null, "N3：demo-expert 私有技能目录可用（M 段已安装并启用）");
    write(join(expDirN!, "projskill", "SKILL.md"), skillMd("projskill"));
    const shadowedA = skillsSvcN.listShadowedSkillNames(taskCwdA, [expDirN!]);
    const shadowedB = skillsSvcN.listShadowedSkillNames(taskCwdB, [expDirN!]);
    assert(
      shadowedA.includes("alpha") && shadowedA.includes("projskill"),
      "N3：任务 cwd 项目技能覆盖专家私有技能 → 报告（cwd 对齐真实 session）",
    );
    assert(shadowedB.includes("alpha"), "N3：全局覆盖与 cwd 无关，任何 cwd 都报告");
    assert(!shadowedB.includes("projskill"), "N3：异 cwd 无该项目技能 → 不假阳性");

    // ---- N4. settings.json 原子写 + 损坏保留副本（F3 收口） ----
    const settingsPath = getSettingsPath();
    const st = new AppSettingsStore();
    st.setTaskConnectorIds("t-atomic", ["c1"]);
    assert(existsSync(settingsPath), "N4：设置文件已写出");
    assert(!existsSync(`${settingsPath}.tmp`), "N4：原子写无 .tmp 残留");
    assert(
      JSON.stringify(new AppSettingsStore().getTaskConnectorIds("t-atomic")) ===
        JSON.stringify(["c1"]),
      "N4：原子写后可读回（round-trip）",
    );
    st.clearTaskConnectorIds("t-atomic");
    // 损坏 → 安全回退默认 + 保留损坏副本（不静默覆盖原文件）
    writeFileSync(settingsPath, "{broken json", "utf-8");
    const stCorrupt = new AppSettingsStore();
    assert(stCorrupt.getTaskConnectorIds("t-atomic") === undefined, "N4：损坏时安全回退默认");
    assert(existsSync(`${settingsPath}.corrupt.bak`), "N4：损坏副本保留（可人工恢复）");
    // 再次写入 → 原子替换损坏文件 → 可正常读
    stCorrupt.setTaskConnectorIds("t-fixed", ["c2"]);
    assert(
      JSON.stringify(new AppSettingsStore().getTaskConnectorIds("t-fixed")) ===
        JSON.stringify(["c2"]),
      "N4：损坏后修复写可读",
    );
    new AppSettingsStore().clearTaskConnectorIds("t-fixed");
    // 写入失败（目标只读 → rename 阶段 EPERM）：抛错不静默、原文件不被截断/覆盖、无 .tmp 残留
    writeFileSync(settingsPath, '{"keep": true}\n', "utf-8");
    // Windows 的只读文件属性会让 rename 失败（EPERM）；POSIX 的 rename 只看「目录」写权限，
    // 文件只读并不阻止替换 —— 因此按平台制造不可写条件，否则该断言在 Linux/macOS 上永不成立。
    const settingsDir = dirname(settingsPath);
    const isWin = process.platform === "win32";
    if (isWin) chmodSync(settingsPath, 0o444);
    else chmodSync(settingsDir, 0o555);
    let writeFailed = false;
    try {
      st.setTaskConnectorIds("t-fail", ["c3"]);
    } catch {
      writeFailed = true;
    }
    if (isWin) chmodSync(settingsPath, 0o666);
    else chmodSync(settingsDir, 0o755);
    assert(writeFailed, "N4：目标不可替换时原子写失败（不静默）");
    assert(!existsSync(`${settingsPath}.tmp`), "N4：失败后无 .tmp 残留");
    assert(
      readFileSync(settingsPath, "utf-8").includes('"keep"'),
      "N4：失败后原文件未被截断/覆盖",
    );

    // ---- P3-4：崩溃残留 .tmp 处理（与 tmp+fsync+rename 原子写一致） ----
    const tmpPath = `${settingsPath}.tmp`;
    // a) 主文件有效 + 陈旧 tmp → 删除 tmp，主文件不动
    writeFileSync(settingsPath, '{"keep": true}\n', "utf-8");
    writeFileSync(tmpPath, '{"stale": true}', "utf-8");
    new AppSettingsStore().read();
    assert(!existsSync(tmpPath), "P3-4：有效主文件 + 陈旧 tmp → tmp 被清理");
    assert(readFileSync(settingsPath, "utf-8").includes('"keep"'), "P3-4：主文件不受影响");
    // b) 主文件缺失 + 有效 tmp → 原子恢复
    rmSync(settingsPath, { force: true });
    writeFileSync(tmpPath, '{"recovered": true}\n', "utf-8");
    const recovered = new AppSettingsStore().read();
    assert(
      (recovered as unknown as Record<string, unknown>).recovered === true &&
        !existsSync(tmpPath),
      "P3-4：主文件缺失 + 有效 tmp → 原子恢复",
    );
    // c) 主文件缺失 + 无效 tmp → 保守删除 + 回退默认，绝不把半写 tmp 当真
    rmSync(settingsPath, { force: true });
    writeFileSync(tmpPath, "{half-written", "utf-8");
    const defsRead = new AppSettingsStore().read();
    assert(
      !existsSync(tmpPath) && !existsSync(settingsPath),
      "P3-4：主文件缺失 + 无效 tmp → 删除残留且不恢复",
    );
    assert(defsRead.permissionMode === "default", "P3-4：回退默认值");
    // d) 主文件损坏 + 有效 tmp → tmp 保守清理（不把来源不明的 tmp 当正式文件，主文件走 corrupt 流程）
    writeFileSync(settingsPath, "{broken", "utf-8");
    writeFileSync(tmpPath, '{"valid": true}', "utf-8");
    new AppSettingsStore().read();
    assert(!existsSync(tmpPath), "P3-4：主文件损坏 + tmp → tmp 保守清理");

    // ---- P3-5：损坏副本轮换（有界两代：.corrupt.bak 最新 / .corrupt.bak.1 上一代） ----
    const bakPath = `${settingsPath}.corrupt.bak`;
    const bakPath1 = `${bakPath}.1`;
    rmSync(bakPath, { force: true });
    rmSync(bakPath1, { force: true });
    writeFileSync(settingsPath, "{broken-v1", "utf-8");
    new AppSettingsStore().read(); // 第 1 次损坏
    writeFileSync(settingsPath, "{broken-v2", "utf-8");
    new AppSettingsStore().read(); // 第 2 次损坏
    assert(existsSync(bakPath) && existsSync(bakPath1), "P3-5：两代损坏副本均保留");
    assert(
      readFileSync(bakPath1, "utf-8").includes("broken-v1"),
      "P3-5：.bak.1 为上一代损坏版本",
    );
    writeFileSync(settingsPath, "{broken-v3", "utf-8");
    new AppSettingsStore().read(); // 第 3 次损坏
    assert(existsSync(bakPath) && existsSync(bakPath1), "P3-5：轮换后仍为两代");
    assert(!existsSync(`${bakPath}.2`), "P3-5：损坏副本数量有界（无第三代）");
    assert(
      readFileSync(bakPath, "utf-8").includes("broken-v3") &&
        readFileSync(bakPath1, "utf-8").includes("broken-v2"),
      "P3-5：最新损坏在 .bak、上一代在 .bak.1",
    );
    // 正常写入后损坏副本仍可人工恢复
    new AppSettingsStore().write({ theme: "dark" });
    assert(
      readFileSync(bakPath, "utf-8").includes("broken-v3"),
      "P3-5：正常写入不破坏损坏副本",
    );

    // ---- N5. taskConnectorIds 生命周期：trash 保留 / purge 清理（主进程永久删除路径） ----
    const lcRoot = join(sandbox, "lifecycle");
    const lcWorkspaces = join(lcRoot, "task-workspaces");
    const lcTrash = join(lcRoot, "trash");
    mkdirSync(lcWorkspaces, { recursive: true });
    mkdirSync(lcTrash, { recursive: true });
    const lcDb = new AppDatabase(join(lcRoot, "app.db"));
    const lcWs = new TaskExecutionWorkspace(lcWorkspaces);
    const lcStore = new AppSettingsStore();
    const lifecycle = new TaskExecutionWorkspaceLifecycle({
      db: lcDb,
      workspace: lcWs,
      trashRoot: lcTrash,
      purgeAfterMs: 60_000,
      // 生产 wiring（index.ts）：purge → agentService.clearTaskConnectorIds
      onPurge: (taskId) => lcStore.clearTaskConnectorIds(taskId),
    });
    const lcId = "lc-purge-1";
    const lcDir = lcWs.ensureTaskExecutionWorkspace(lcId);
    lcDb.upsertTask({ id: lcId, title: "t", updatedAt: Date.now(), cwd: lcDir });
    lcStore.setTaskConnectorIds(lcId, ["c1"]);
    await lifecycle.trash(lcId);
    assert(
      JSON.stringify(lcStore.getTaskConnectorIds(lcId)) === JSON.stringify(["c1"]),
      "N5：trash（回收站）保留连接器配置（restore 可恢复）",
    );
    await lifecycle.purge(lcId, { force: true });
    assert(lcDb.getTask(lcId) === undefined, "N5：purge 删除任务行");
    assert(
      lcStore.getTaskConnectorIds(lcId) === undefined,
      "N5：purge（真正永久删除）清理 settings.taskConnectorIds",
    );
    lcDb.close();

    // ---- P3-3：孤儿 key 对账（purge 崩溃窗口兜底；trash/archive 不误删；幂等） ----
    const rcStore = new AppSettingsStore();
    rcStore.setTaskConnectorIds("alive", ["c1"]);
    rcStore.setTaskConnectorIds("trashed", ["c2"]);
    rcStore.setTaskConnectorIds("ghost", ["c3"]);
    const rcRemoved = rcStore.reconcileTaskConnectorIds(new Set(["alive", "trashed"]));
    assert(
      JSON.stringify(rcRemoved) === JSON.stringify(["ghost"]),
      "P3-3：仅清理明确不存在的任务 key",
    );
    assert(
      JSON.stringify(rcStore.getTaskConnectorIds("alive")) === JSON.stringify(["c1"]) &&
        JSON.stringify(rcStore.getTaskConnectorIds("trashed")) === JSON.stringify(["c2"]) &&
        rcStore.getTaskConnectorIds("ghost") === undefined,
      "P3-3：alive/trashed（行仍在）保留、ghost 清除",
    );
    assert(
      JSON.stringify(
        rcStore.reconcileTaskConnectorIds(new Set(["alive", "trashed"])),
      ) === "[]",
      "P3-3：reconcile 幂等（无孤儿零写入）",
    );
    rcStore.clearTaskConnectorIds("alive");
    rcStore.clearTaskConnectorIds("trashed");
    // 崩溃窗口模拟：purge 的事务删行已执行但 onPurge 未跑 → 下次启动 reconcile 兜底
    const cwDb = new AppDatabase(join(sandbox, "crashwin.db"));
    const cwStore = new AppSettingsStore();
    cwDb.upsertTask({ id: "cw-task", title: "t", updatedAt: Date.now() });
    cwStore.setTaskConnectorIds("cw-task", ["c1"]);
    cwDb.deleteTask("cw-task"); // 模拟 purge 事务部分（无 onPurge）
    assert(
      JSON.stringify(cwStore.getTaskConnectorIds("cw-task")) === JSON.stringify(["c1"]),
      "P3-3：模拟崩溃窗口（行已删、key 残留）",
    );
    const cwOrphans = cwStore.reconcileTaskConnectorIds(
      new Set(cwDb.listTasks().map((t) => t.id)),
    );
    assert(
      cwOrphans.includes("cw-task") && cwStore.getTaskConnectorIds("cw-task") === undefined,
      "P3-3：启动 reconcile 兜底清理崩溃窗口孤儿 key",
    );
    cwDb.close();

    // ---- N6. 三 Mode + 5+1 受管 provider 回归；私有技能不污染 Global Skill Center ----
    const modeStoreN = new ModeProfileStore();
    const working = modeStoreN.getProfile("working");
    const design = modeStoreN.getProfile("general");
    const coding = modeStoreN.getProfile("coding");
    const workingPreset = resolveModePreset(working.policy, "drawio-ai");
    assert(workingPreset != null, "N6：working/drawio-ai 预设存在");
    assert(
      JSON.stringify((workingPreset!.providerMcpIds ?? []).filter(isManagedToolProvider)) ===
        JSON.stringify(["drawio-ai"]),
      "N6：drawio-ai 预设声明受管 provider drawio-ai",
    );
    assert(
      (workingPreset!.mcpPolicy?.allow ?? []).includes("drawio-ai"),
      "N6：drawio-ai 预设 mcpPolicy allow",
    );
    const penpotPreset = resolveModePreset(working.policy, "web-prototype");
    assert(penpotPreset?.label === "Penpot", "N6：working/Penpot 预设存在");
    assert(penpotPreset?.providerMcpIds?.includes("penpot"), "N6：办公 Penpot 保留 provider 声明");
    assert(penpotPreset?.mcpPolicy?.allow.includes("penpot"), "N6：办公 Penpot MCP allow");
    assert(!resolveModePreset(design.policy, "web-prototype") && !resolveModePreset(design.policy, "general"), "N6：Bot 不再保留通用设计和 Penpot");
    assert(resolveModePreset(coding.policy, "code-review") != null, "N6：coding/code-review 预设存在");
    for (const id of ["drawio-ai", "penpot"]) {
      assert(
        (MANAGED_TOOL_PROVIDER_IDS as readonly string[]).includes(id),
        `N6：受管 provider 注册表包含 ${id}`,
      );
    }
    // 专家/连接器私有技能不进入 Global Skill Center
    const globalSkills = skillsSvcN.listInstalled(sandbox).map((s) => s.id);
    assert(globalSkills.includes("alpha"), "N6：全局技能仍在");
    assert(
      !globalSkills.includes("gamma") &&
        !globalSkills.includes("beta") &&
        !globalSkills.includes("projskill"),
      "N6：连接器/专家私有技能不进入全局技能中心",
    );

    // ---- N7. Library / Workspace Context 已从 AgentService 抽离，防止 God Object 回流 ----
    const agentSource = readFileSync("src/main/agent/AgentService.ts", "utf8");
    const contextSource = readFileSync("src/main/agent/LibraryWorkspaceContextService.ts", "utf8");
    assert(
      agentSource.includes("LibraryWorkspaceContextService") && agentSource.includes("this.libraryWorkspaceContext.projectionSources(")
        && agentSource.includes("this.libraryWorkspaceContext.validateEvidenceAccess("),
      "N7：AgentService 将 Durable 证据来源及访问校验委托给 LibraryWorkspaceContextService",
    );
    assert(
      !/private\s+(libraryCatalog|libraryAttachmentsForTask|libraryAttachedIds|workspaceSharedContextDigest|renderBtwProjectContextSegments)\s*\(/.test(agentSource),
      "N7：旧 Library/Workspace context helper 不回流 AgentService",
    );
    assert(
      !agentSource.includes("libraryServiceInst") &&
        !agentSource.includes("new LibraryService(this.db)") &&
        !agentSource.includes("new WorkspaceResourceLocator(this.db"),
      "N7：AgentService 不再持有 Library/Workspace locator 实现细节",
    );
    assert(
      contextSource.includes("resolveTask(") &&
        !contextSource.includes("memoryDigest(") &&
        readFileSync(join(process.cwd(), "src/main/agent/EphemeralContextProjection.ts"), "utf8").includes("projectMemoryContext(") &&
        contextSource.includes("renderBtwProjectContextSegments(") &&
        contextSource.includes("resourceLocator()"),
      "N7：Task/BTW/Locator 留在 context service；Memory 只由 Pi request hook 注入",
    );

    // Native lifecycle ownership: product adapters must not recreate SDK task runners.
    const durableSource = readFileSync("src/main/agent/durable/DurableBotService.ts", "utf8");
    const runtimeSource = readFileSync("src/main/agent/durable/DurableBotRuntime.ts", "utf8");
    assert(!agentSource.includes("createAgentSession(") && !agentSource.includes("new DefaultResourceLoader("),
      "主执行入口不创建第二套 SDK 会话或磁盘扩展加载器");
    assert(agentSource.includes("return this.durableBots.prompt(req,") && agentSource.includes("return this.durableBots.regenerate(req)"),
      "主入口和重新生成统一提交到 Durable");
    assert(agentSource.includes("this.sessionExtensions.durableExtensions({") && agentSource.includes("createDurableToolPolicy({"),
      "产品领域工具与实际权限接到同一 Durable 执行边界");
    assert(durableSource.includes("onProjected: snapshot =>") && runtimeSource.includes("this.options.onProjected?.(snapshot)"),
      "生命周期终态等待原生记录完成投影");
    assert(durableSource.includes("submission.wait(context)") && durableSource.includes("await this.invalidate(taskId, open)"),
      "持久回执等待与执行宿主释放由 Durable 适配集中维护");

    // ---- N13. BTW runtime stays in dedicated service ----
    const btwServiceSource = readFileSync("src/main/agent/BtwSessionService.ts", "utf8");
    assert(
      agentSource.includes("return this.btwService.start(req)") &&
        agentSource.includes("return this.btwService.prompt(req)") &&
        agentSource.includes("return this.btwService.abort(btwId)") &&
        agentSource.includes("return this.btwService.close(btwId)") &&
        agentSource.includes("this.btwService.keepalive(btwIds)") &&
        agentSource.includes("this.btwService.disposeAll()"),
      "N13 AgentService exposes BTW only as a thin facade",
    );
    assert(
      !agentSource.includes("btwSessions = new Map") &&
        !agentSource.includes("scheduleBtwPrune(") &&
        !agentSource.includes("buildBtwBaseContext(") &&
        btwServiceSource.includes("canStartBtwSession(") &&
        btwServiceSource.includes("private schedulePrune()") &&
        btwServiceSource.includes("async close(btwId:") &&
        btwServiceSource.includes("formatBtwSnapshot("),
      "N13 BtwSessionService owns snapshot, lifecycle, prune and isolation state",
    );

    // ---- N14. Prompt Enhance stays in dedicated service ----
    const promptEnhancementSource = readFileSync("src/main/agent/PromptEnhancementService.ts", "utf8");
    assert(
      agentSource.includes("return this.promptEnhancement.enhance(req)") &&
        !agentSource.includes("ENHANCE_SYSTEM_ROLE") &&
        !agentSource.includes("enhanceInflight") &&
        !agentSource.includes("resolveEnhanceWorkspaceCwd(") &&
        !agentSource.includes("buildEnhanceEnvironmentContext("),
      "N14 AgentService prompt-enhance API is a thin facade",
    );
    assert(
      promptEnhancementSource.includes("const ENHANCE_SYSTEM_ROLE = `") &&
        promptEnhancementSource.includes("private static readonly MAX_CONCURRENT = 2") &&
        promptEnhancementSource.includes("private resolveWorkspaceCwd(") &&
        promptEnhancementSource.includes("private buildEnvironmentContextForNewTask(") &&
        promptEnhancementSource.includes("sanitizeEnhancedPrompt(raw)"),
      "N14 PromptEnhancementService owns validation, environment projection and transient execution",
    );
  }

  /* ================= P. 不内置第三方软件（防回归：不得再有便携工具根） ================= */
  {
    // 产品规则：不内置 FreeCAD/Blender 等第三方软件，工具根在用户数据目录
    // （~/.mybuddy/tools，只放 compose/配置），不再有 cwd 下的便携工具目录。
    // 待检查的目录名在运行时拼出：源码里不出现该字面量，便于用 grep 自查"是否还有残留"。
    const PORTABLE_TOOL_ROOT = ["MyBuddy", "Tools"].join("");
    console.log(`\nP. 不内置第三方软件：src/ 不得出现便携工具根 "${PORTABLE_TOOL_ROOT}"`);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (readFileSync(full).includes(PORTABLE_TOOL_ROOT)) offenders.push(full);
      }
    };
    walk("src");
    assert(
      offenders.length === 0,
      `src/ 不含便携工具根目录名（不内置第三方软件；工具体根 = ~/.mybuddy/tools）${
        offenders.length > 0 ? `：命中 ${offenders.join(", ")}` : ""
      }`,
    );
  }

  console.log(`\n[architecture-test] passed=${passed} failed=${failed}`);
  rmSync(sandbox, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

void main();
