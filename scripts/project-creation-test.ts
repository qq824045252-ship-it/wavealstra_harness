/**
 * Wave 1C/D/E：新建项目 Template-first 创建流程 renderer 纯函数测试。
 * 覆盖 src/renderer/src/lib/projectCreate.ts 的纯函数，
 * 以及 共享层 draft/resolve/merge → 创建计划 的接线集成断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTemplateToDraft,
  createDraftFromTemplate,
  isDraftDirty,
  resolveProjectTemplate,
} from "../src/shared/project-template";
import {
  buildCapabilityRegistries,
  buildTemplateSummary,
  clampResourceBudgetChars,
  countDraftCapabilities,
  formatTemplateSummaryLine,
  validateAndBuildCreationPlan,
} from "../src/renderer/src/lib/projectCreate";

/* ---------- countDraftCapabilities ---------- */

{
  const draft = createDraftFromTemplate("software-development");
  assert.deepEqual(countDraftCapabilities(draft), {
    experts: 2,
    skills: 3,
    connectors: 0,
    mcps: 1,
  }, "software-development draft counts（code-review-expert/debug-expert + github/testing/documentation + pi）");

  const blank = createDraftFromTemplate("blank");
  assert.deepEqual(countDraftCapabilities(blank), { experts: 0, skills: 0, connectors: 0, mcps: 0 }, "blank draft counts are all zero");
}

/* ---------- buildTemplateSummary / formatTemplateSummaryLine ---------- */

{
  const draft = createDraftFromTemplate("software-development");
  const summary = buildTemplateSummary(draft);
  assert.equal(
    formatTemplateSummaryLine(summary),
    "2 个专家 · 3 个技能 · 0 个连接器 · 1 个 MCP",
    "summary line shows capability counts only（Mode/Tag 不属于 Project，不混入 Summary，实施文档 §20）",
  );
}

{
  const draft = createDraftFromTemplate("blank");
  assert.equal(formatTemplateSummaryLine(buildTemplateSummary(draft)), "0 个专家 · 0 个技能 · 0 个连接器 · 0 个 MCP", "blank summary counts are all zero");
}

/* ---------- clampResourceBudgetChars ---------- */

{
  assert.equal(clampResourceBudgetChars(128_000), 128_000, "in-range value unchanged");
  assert.equal(clampResourceBudgetChars(100), 8_000, "below min clamped to min");
  assert.equal(clampResourceBudgetChars(999_999), 256_000, "above max clamped to max");
  assert.equal(clampResourceBudgetChars(Number.NaN), 8_000, "NaN falls back to min");
  assert.equal(clampResourceBudgetChars(50_000.6), 50_001, "fractional rounded");
}

/* ---------- buildCapabilityRegistries ---------- */

{
  const registries = buildCapabilityRegistries({
    experts: [{ id: "code-review-expert", enabled: true }, { id: "debug-expert", enabled: false }],
    skills: [{ id: "github", enabled: true }],
    connectors: [
      { id: "web-search", installed: true, enabled: true },
      { id: "github-connector", installed: true, enabled: false },
      { id: "not-installed", installed: false },
    ],
    mcps: [
      { id: "pi", installed: true, disabled: false },
      { id: "penpot", installed: true, disabled: true },
      { id: "drawio", installed: false },
    ],
  });

  const resolved = resolveProjectTemplate("software-development", registries);
  assert.deepEqual(resolved.resolvedExperts, ["code-review-expert"], "enabled expert resolves");
  assert.deepEqual(resolved.missingExperts, ["debug-expert"], "disabled expert is missing");
  assert.ok(resolved.warnings.some((warning) => warning.includes("debug-expert")), "disabled expert warns");

  assert.deepEqual(resolved.resolvedMcps, ["pi"], "installed & enabled mcp resolves");
  assert.deepEqual(resolved.missingMcps, [], "software-development only references pi");

  const designResolved = resolveProjectTemplate("design-creative", registries);
  assert.deepEqual(designResolved.resolvedMcps, [], "disabled penpot does not resolve");
  assert.deepEqual(designResolved.missingMcps, ["penpot"], "disabled penpot is missing");
  assert.ok(designResolved.warnings.some((warning) => warning.includes("penpot")), "penpot MCP 尚未配置 warning");

  const researchResolved = resolveProjectTemplate("research-analysis", registries);
  assert.deepEqual(researchResolved.resolvedConnectors, ["web-search"], "installed & enabled connector resolves");
  assert.deepEqual(researchResolved.missingConnectors, [], "unreferenced disabled connectors do not enter missing");

  // 模板引用的连接器被停用/未安装 → 才进 missing + warning（经 buildCapabilityRegistries 转换，贴近真实调用链）
  const researchDisabled = resolveProjectTemplate(
    "research-analysis",
    buildCapabilityRegistries({
      connectors: [
        { id: "web-search", installed: true, enabled: false },
        { id: "other", installed: false },
      ],
    }),
  );
  assert.deepEqual(researchDisabled.resolvedConnectors, [], "disabled referenced connector does not resolve");
  assert.deepEqual(researchDisabled.missingConnectors, ["web-search"], "disabled referenced connector is missing");
  assert.ok(researchDisabled.warnings.some((warning) => warning.includes("web-search")), "disabled connector warns");
}

/* ---------- validateAndBuildCreationPlan（提交前校验） ---------- */

{
  const draft = createDraftFromTemplate("blank");
  const invalid = validateAndBuildCreationPlan(draft, undefined);
  assert.equal(invalid.ok, false, "empty name is rejected");
  if (!invalid.ok) assert.equal(invalid.error, "项目名称不能为空");

  const tooLong = validateAndBuildCreationPlan({ ...draft, name: "x".repeat(41) }, undefined);
  assert.equal(tooLong.ok, false, "41-char name is rejected");
  if (!tooLong.ok) assert.equal(tooLong.error, "项目名称不能超过 40 字符");

  const trimmed = validateAndBuildCreationPlan({ ...draft, name: "  我的项目  " }, undefined);
  assert.equal(trimmed.ok, true, "whitespace-padded name is accepted");
  if (trimmed.ok) assert.equal(trimmed.request.name, "我的项目", "name is trimmed in request");
}

/* ---------- 集成：draft → 创建计划端到端 ---------- */

{
  const draft = createDraftFromTemplate("software-development");
  draft.name = "模板化创建测试";
  const plan = validateAndBuildCreationPlan(draft, undefined);
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error(plan.error);
  assert.equal(plan.request.templateId, "software-development");
  assert.equal(plan.request.name, "模板化创建测试");
  assert.equal(plan.request.resourceBudgetChars, 128_000);
  assert.deepEqual(plan.request.policies?.expert?.allow, ["code-review-expert", "debug-expert"], "experts → allow");
  assert.deepEqual(plan.request.policies?.expert?.recommended, ["code-review-expert", "debug-expert"], "template recommended experts stay recommended");
  assert.deepEqual(plan.request.policies?.skill?.prefer, ["github", "testing", "documentation"], "skills → prefer");
  assert.deepEqual(plan.request.policies?.mcp?.allow, ["pi"], "mcps → allow");
  assert.equal(plan.request.policies?.mcp?.mode, "hard", "hard template keeps hard mode");
  assert.deepEqual(plan.warnings, [], "no registries → conservative, no warnings");
  assert.ok(plan.request.instructions?.includes("软件开发工程师"), "template instructions prefilled");

  // 带真实（不完整）注册表：缺失能力只进 warnings，不阻塞创建
  const withRegistries = validateAndBuildCreationPlan(draft, {
    experts: [{ id: "code-review-expert", enabled: true }],
    skills: [{ id: "github", enabled: true }, { id: "testing", enabled: true }, { id: "documentation", enabled: true }],
    connectors: [],
    mcps: [],
  });
  assert.equal(withRegistries.ok, true, "missing capabilities never block creation");
  if (withRegistries.ok) {
    assert.ok(withRegistries.warnings.length >= 1, "missing debug-expert warns");
    assert.equal(withRegistries.request.name, "模板化创建测试");
  }
}

{
  const draft = createDraftFromTemplate("blank");
  draft.name = "空白项目测试";
  const plan = validateAndBuildCreationPlan(draft, undefined);
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error(plan.error);
  assert.equal(plan.request.templateId, "blank");
  assert.deepEqual(plan.request.policies?.expert?.allow, [], "blank has no experts");
  assert.deepEqual(plan.request.policies?.skill?.prefer, [], "blank has no skills");
  assert.equal(plan.request.instructions, undefined, "blank has no instructions");
  assert.deepEqual(plan.warnings, [], "blank has no warnings");
}

/* ---------- 集成：模板切换 dirty 保护 ---------- */

{
  const draft = createDraftFromTemplate("software-development");
  draft.name = "保留名称";
  draft.dirty.name = true;
  draft.experts = ["code-review-expert"]; // 用户移除 debug-expert
  draft.dirty.experts = true;

  const next = applyTemplateToDraft(draft, "design-creative");
  assert.equal(next.templateId, "design-creative");
  assert.equal(next.name, "保留名称", "name never changes on template switch");
  assert.deepEqual(next.experts, ["code-review-expert"], "dirty experts kept");
  assert.deepEqual(next.skills, ["ui-design", "diagram"], "non-dirty skills take new template defaults");
  assert.equal(isDraftDirty(draft), true, "dirty draft detected");
  assert.equal(isDraftDirty(createDraftFromTemplate("blank")), false, "fresh draft is clean");

  // 重新配置分支：createDraftFromTemplate 后仅保留 name/description
  const fresh = createDraftFromTemplate("design-creative");
  fresh.name = draft.name;
  fresh.description = draft.description;
  fresh.dirty.name = draft.dirty.name;
  fresh.dirty.description = draft.dirty.description;
  assert.deepEqual(fresh.experts, ["ui-designer"], "reset path uses template defaults");
  assert.equal(fresh.name, "保留名称", "reset path keeps name");
}

/* ---------- 源级守卫：NewProjectModal hook 顺序（回归保护，修复过"白屏"崩溃） ---------- */

{
  // 背景：早期 return 放在 useMemo 之前时，draft 从 null 变为非 null 会触发
  // "Rendered more hooks than during the previous render"（React 整树崩溃 → 白屏）。
  // 修复方式是所有 hooks 无条件先跑完，提前 return 必须排在最后一个 hook 之后。
  const source = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/NewProjectModal.tsx"), "utf8");
  const lines = source.split(/\r?\n/);
  const guardIndex = lines.findIndex((line) => line.trim() === "if (!open || !draft) return null;");
  assert.ok(guardIndex !== -1, "NewProjectModal 必须包含提前 return 守卫");
  const hookCall = /\buse(Memo|State|Effect|Ref|Callback|Id)\(/;
  const offenders = lines
    .slice(guardIndex + 1)
    .map((line, index) => ({ line, fileLine: guardIndex + index + 2 }))
    .filter(({ line }) => hookCall.test(line));
  assert.deepEqual(
    offenders.map(({ fileLine, line }) => `${fileLine}: ${line.trim()}`),
    [],
    "提前 return 之后不允许再调用任何 hook（会导致 hook 数量不一致白屏）",
  );
}

/* ---------- 项目工作目录：Project 只拿默认目录，不污染首页 Workspace 选择 ---------- */
{
  const modalSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/NewProjectModal.tsx"), "utf8");
  const storeSource = readFileSync(join(process.cwd(), "src/renderer/src/store/appStore.ts"), "utf8");
  assert.ok(modalSource.includes('ensureSpaceFromPath(projectFolder.path, projectFolder.name, null, { activate: false })'), "项目创建必须使用不激活 homeSpaceId 的目录挂载路径");
  assert.ok(modalSource.includes('updateProject?.({ id: savedProject.id, defaultSpaceId: mounted.id })'), "项目创建后必须显式写 defaultSpaceId");
  assert.ok(modalSource.includes('if (mounted?.created)'), "仅本次新建的目录记录允许失败补偿删除");
  assert.ok(storeSource.includes('ensureSpaceFromPath: async (folderPath, name, parentId = null, options = {}) =>'), "store 必须提供可选择是否激活的统一目录挂载实现");
  assert.ok(storeSource.includes('const activate = options.activate !== false;'), "activate=false 必须有显式语义");
  assert.ok(storeSource.includes('get().ensureSpaceFromPath(folderPath, name, parentId, { activate: true })'), "旧 addSpaceFromPath 保持激活行为兼容");
}
console.log("project-creation-test: PASS");
