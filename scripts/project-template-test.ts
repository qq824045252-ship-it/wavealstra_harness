import assert from "node:assert/strict";
import { DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS } from "../src/shared/project-domain";
import {
  applyTemplateToDraft,
  buildProjectCreationPlan,
  createDraftFromTemplate,
  getProjectTemplate,
  isBlankTemplate,
  isDraftDirty,
  listProjectTemplates,
  resolveProjectTemplate,
  validateProjectName,
} from "../src/shared/project-template";

// T1：7 个模板 id 唯一、blank 无 instructions/policies、列表顺序正确
{
  const templates = listProjectTemplates();
  assert.equal(templates.length, 7, "exactly 7 templates");
  const ids = templates.map((template) => template.id);
  assert.deepEqual(ids, [
    "product-development",
    "software-development",
    "research-analysis",
    "office-collaboration",
    "design-creative",
    "long-term-knowledge",
    "blank",
  ], "template list order: 空白最后");
  assert.equal(new Set(ids).size, 7, "template ids unique");
  const blank = templates[6];
  assert.equal(blank.id, "blank");
  assert.equal(blank.instructions, undefined, "blank has no instructions");
  assert.equal(blank.policies, undefined, "blank has no policies");
  assert.equal(blank.taskSuggestions, undefined, "blank has no taskSuggestions");
  for (const template of templates) {
    assert.ok(template.name, `name present: ${template.id}`);
    assert.ok(template.description, `description present: ${template.id}`);
    if (template.id !== "blank") {
      assert.ok(template.instructions?.length, `instructions present: ${template.id}`);
    }
  }
  // taskSuggestions.recommendedModeId 与 preset 合法性
  const byId = new Map(ids.map((id, index) => [id, templates[index]]));
  assert.equal(byId.get("software-development")!.taskSuggestions?.recommendedModeId, "coding");
  assert.equal(byId.get("design-creative")!.taskSuggestions?.recommendedModeId, "design");
  for (const template of templates) {
    if (template.id === "blank") continue;
    assert.ok(template.taskSuggestions?.recommendedModeId, `recommendedModeId present: ${template.id}`);
    assert.ok(template.taskSuggestions?.recommendedPresetId, `recommendedPresetId present: ${template.id}`);
  }
}

// T2：getProjectTemplate 命中/未命中；isBlankTemplate
{
  assert.equal(getProjectTemplate("software-development")?.name, "软件开发");
  assert.equal(getProjectTemplate("not-a-template"), undefined);
  assert.equal(isBlankTemplate("blank"), true);
  assert.equal(isBlankTemplate("software-development"), false);
  // 返回拷贝，调用方修改不影响内置列表
  const copy = getProjectTemplate("blank")!;
  copy.name = "hacked";
  assert.equal(getProjectTemplate("blank")!.name, "空白项目");
}

// T3：resolveProjectTemplate 正常解析（假 registries 包含/不包含引用 id）
{
  const registries = {
    experts: [
      { id: "code-review-expert", enabled: true },
      { id: "debug-expert", enabled: false },
    ],
    skills: [{ id: "github", enabled: true }],
    connectors: [{ id: "web-search", available: true, connected: true }],
    mcps: [{ id: "pi", installed: true }],
  };
  const resolved = resolveProjectTemplate("software-development", registries);
  assert.deepEqual(resolved.resolvedExperts, ["code-review-expert"]);
  assert.deepEqual(resolved.missingExperts, ["debug-expert"], "disabled entry is missing");
  assert.deepEqual(resolved.resolvedSkills, ["github"]);
  assert.deepEqual(resolved.missingSkills, ["testing", "documentation"]);
  assert.deepEqual(resolved.resolvedMcps, ["pi"]);
  assert.ok(resolved.warnings.includes("debug-expert 专家尚未配置"), "expert warning text");
  assert.ok(resolved.warnings.includes("testing 技能尚未配置"), "skill warning text");
  assert.equal(resolved.warnings.includes("pi MCP 尚未配置"), false, "installed mcp has no warning");
  assert.equal(resolved.instructions.length > 0, true);
  assert.equal(resolved.taskSuggestion?.recommendedModeId, "coding");
  assert.equal(resolved.taskSuggestion?.recommendedPresetId, "bugfix-test");

  // 全部包含 → 全 resolved、无 warning
  const full = resolveProjectTemplate("design-creative", {
    experts: [{ id: "ui-designer", enabled: true }],
    skills: [{ id: "ui-design" }, { id: "diagram" }],
    mcps: [{ id: "penpot", installed: true }],
  });
  assert.deepEqual(full.resolvedExperts, ["ui-designer"]);
  assert.deepEqual(full.missingExperts, []);
  assert.deepEqual(full.resolvedSkills, ["ui-design", "diagram"]);
  assert.deepEqual(full.resolvedMcps, ["penpot"]);
  assert.deepEqual(full.warnings, []);
  assert.equal(full.taskSuggestion?.recommendedModeId, "design");
  // 设计创意模板本身不是「AI UI 设计」→ 推荐 general（实施文档 §19），而非 ai-ui
  assert.equal(full.taskSuggestion?.recommendedPresetId, "general");
}

// T4：缺失能力 → missing 列表与 warnings 有值且不 throw；未提供 registries → 不报错
{
  const resolved = resolveProjectTemplate("research-analysis", {
    experts: [],
    skills: [],
    connectors: [],
    mcps: [],
  });
  assert.deepEqual(resolved.resolvedExperts, []);
  assert.deepEqual(resolved.missingExperts, ["research-analyst"]);
  assert.deepEqual(resolved.resolvedSkills, []);
  assert.deepEqual(resolved.missingSkills, ["web-search", "report-writing"]);
  assert.deepEqual(resolved.missingConnectors, ["web-search"]);
  assert.equal(resolved.warnings.length, 4, "one warning per missing capability");

  // 未提供 registries（保守）：全部视为 resolved、warnings 为空
  const offline = resolveProjectTemplate("software-development");
  assert.deepEqual(offline.resolvedExperts, ["code-review-expert", "debug-expert"]);
  assert.deepEqual(offline.missingExperts, []);
  assert.deepEqual(offline.warnings, []);

  // blank 无任何引用
  const blank = resolveProjectTemplate("blank");
  assert.equal(blank.instructions, "");
  assert.deepEqual(blank.resolvedExperts, []);
  assert.deepEqual(blank.warnings, []);
  assert.equal(blank.taskSuggestion, undefined);
}

// T5：未知 templateId → throw
{
  assert.throws(() => resolveProjectTemplate("no-such-template"), /未知项目模板/);
}

// T6：createDraftFromTemplate 初始化正确（dirty 全 false、模板默认值进入 draft）
{
  const draft = createDraftFromTemplate("software-development");
  assert.equal(draft.templateId, "software-development");
  assert.equal(draft.name, "");
  assert.equal(draft.description, "");
  assert.ok(draft.instructions.length > 0, "instructions from template");
  assert.deepEqual(draft.experts, ["code-review-expert", "debug-expert"]);
  assert.deepEqual(draft.skills, ["github", "testing", "documentation"]);
  assert.deepEqual(draft.mcps, ["pi"]);
  assert.equal(draft.resourceBudgetChars, DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS);
  assert.deepEqual(draft.dirty, {
    name: false,
    description: false,
    instructions: false,
    experts: false,
    skills: false,
    connectors: false,
    mcps: false,
    budget: false,
  });

  const blankDraft = createDraftFromTemplate("blank");
  assert.equal(blankDraft.instructions, "");
  assert.deepEqual(blankDraft.experts, []);
  assert.throws(() => createDraftFromTemplate("no-such-template"), /未知项目模板/);
}

// T7：applyTemplateToDraft（instructions dirty → 保留；experts 未动 → 换新模板值；name/description 不受影响）
{
  const draft = createDraftFromTemplate("software-development");
  draft.name = "我的产品项目";
  draft.description = "固定描述";
  draft.instructions = "用户自定义说明";
  draft.dirty.instructions = true;
  draft.dirty.name = false;
  draft.dirty.description = false;
  draft.dirty.experts = false;

  const switched = applyTemplateToDraft(draft, "product-development");
  assert.equal(switched.templateId, "product-development");
  assert.equal(switched.instructions, "用户自定义说明", "dirty instructions kept");
  assert.deepEqual(switched.experts, ["product-management", "requirement-analyst"], "non-dirty experts replaced");
  assert.deepEqual(switched.skills, ["requirements", "roadmap"], "non-dirty skills replaced");
  assert.equal(switched.name, "我的产品项目", "name never changes on switch");
  assert.equal(switched.description, "固定描述", "description never changes on switch");

  // dirty=true 的 experts 保留用户值
  const withDirtyExperts = createDraftFromTemplate("software-development");
  withDirtyExperts.experts = ["custom-expert"];
  withDirtyExperts.dirty.experts = true;
  const kept = applyTemplateToDraft(withDirtyExperts, "design-creative");
  assert.deepEqual(kept.experts, ["custom-expert"]);
  assert.deepEqual(kept.skills, ["ui-design", "diagram"], "non-dirty skills replaced with design template");

  // 切到 blank：instructions 清空（未 dirty）
  const toBlank = applyTemplateToDraft(createDraftFromTemplate("software-development"), "blank");
  assert.equal(toBlank.instructions, "");
  assert.deepEqual(toBlank.experts, []);
  assert.throws(() => applyTemplateToDraft(createDraftFromTemplate("blank"), "no-such-template"), /未知项目模板/);
}

// T8：isDraftDirty 全 false / 部分 true
{
  assert.equal(isDraftDirty(createDraftFromTemplate("blank")), false);
  const draft = createDraftFromTemplate("office-collaboration");
  draft.dirty.name = true;
  assert.equal(isDraftDirty(draft), true);
  draft.dirty.name = false;
  draft.dirty.budget = true;
  assert.equal(isDraftDirty(draft), true);
}

// T9：validateProjectName（空、纯空格、40 字符边界、41 字符、正常）
{
  assert.deepEqual(validateProjectName(""), { ok: false, error: "项目名称不能为空" });
  assert.deepEqual(validateProjectName("   "), { ok: false, error: "项目名称不能为空" });
  assert.deepEqual(validateProjectName("a".repeat(40)), { ok: true, name: "a".repeat(40) });
  assert.deepEqual(validateProjectName("a".repeat(41)), { ok: false, error: "项目名称不能超过 40 字符" });
  assert.deepEqual(validateProjectName("  正常名称  "), { ok: true, name: "正常名称" });
}

// T10：buildProjectCreationPlan（policies 合并、去重、空过滤、mcp allow、templateId、默认预算）
{
  const draft = createDraftFromTemplate("software-development");
  draft.name = "  新项目  ";
  draft.description = "";
  draft.experts = ["code-review-expert", "", "code-review-expert", "debug-expert"];
  draft.skills = ["github", "", "testing", "github"];
  draft.connectors = [];
  draft.mcps = ["pi", "pi", ""];

  const { request, warnings } = buildProjectCreationPlan(draft);
  assert.equal(request.name, "  新项目  ", "name passed through (service trims)");
  assert.equal(request.description, undefined, "empty description omitted");
  assert.ok(request.instructions, "instructions present");
  assert.equal(request.templateId, "software-development", "request carries templateId");
  assert.equal(request.resourceBudgetChars, DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS);

  assert.deepEqual(request.policies.expert.allow, ["code-review-expert", "debug-expert"], "dedup + empty filter");
  assert.deepEqual(
    request.policies.expert.recommended,
    ["code-review-expert", "debug-expert"],
    "template recommended kept when still selected",
  );
  assert.deepEqual(request.policies.expert.deny, [], "no deny in simple defaults");
  assert.deepEqual(request.policies.skill.prefer, ["github", "testing"], "skills dedup + empty filter");
  assert.deepEqual(request.policies.skill.demote, []);
  assert.deepEqual(request.policies.skill.hide, []);
  assert.deepEqual(request.policies.skill.allow, []);
  assert.deepEqual(request.policies.connector.allow, []);
  assert.deepEqual(request.policies.connector.recommended, []);
  assert.deepEqual(request.policies.mcp.allow, ["pi"], "mcp allow");
  assert.deepEqual(request.policies.mcp.deny, []);
  assert.equal(request.policies.mcp.mode, "hard");

  // 用户手动移除模板推荐项 → recommended 同步收缩
  const shrunk = createDraftFromTemplate("software-development");
  shrunk.experts = ["debug-expert"];
  const plan = buildProjectCreationPlan(shrunk);
  assert.deepEqual(plan.request.policies.expert.allow, ["debug-expert"]);
  assert.deepEqual(plan.request.policies.expert.recommended, ["debug-expert"], "removed item no longer recommended");

  // 空名称草稿也能产出 request（名称校验由 service 负责）
  const empty = createDraftFromTemplate("blank");
  const blankPlan = buildProjectCreationPlan(empty);
  assert.equal(blankPlan.request.templateId, "blank");
  assert.deepEqual(blankPlan.request.policies.expert.allow, []);
  assert.equal(blankPlan.request.description, undefined);

  // registries 缺失能力 → warnings 进入计划
  const withWarnings = buildProjectCreationPlan(createDraftFromTemplate("software-development"), {
    experts: [],
    skills: [],
    connectors: [],
    mcps: [],
  });
  assert.ok(withWarnings.warnings.includes("code-review-expert 专家尚未配置"));
  assert.ok(withWarnings.warnings.includes("pi MCP 尚未配置"));
}

console.log("project-template-test: PASS");
