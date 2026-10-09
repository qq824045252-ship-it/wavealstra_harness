/**
 * Project V2 边界修复：Task 默认值优先级测试（实施文档 §31）。
 *
 * 覆盖：
 * - §31.1 Project 无 Mode/Tag（创建 payload 结构性守卫）
 * - §31.2 Template Suggestion（software → coding + bugfix-test）
 * - §31.3 最近任务优先于模板推荐
 * - §31.4 模板推荐次优先于系统默认
 * - §31.5 System Fallback
 * - §31.6 非法 Template Preset 归一化（不崩溃）
 * - §31.7 Template 不存在 → system fallback（不阻塞 Task 创建）
 * - 跨 Tag / 跨 Mode：同一 Project 的不同 Task 互不干扰
 */
import assert from "node:assert/strict";
import { defaultModePresetId } from "../src/shared/mode-profile";
import {
  buildProjectCreationPlan,
  createDraftFromTemplate,
  listProjectTemplates,
} from "../src/shared/project-template";
import {
  resolveProjectTaskDefaults,
  resolveProjectTemplateTaskSuggestion,
  resolveTemplateTaskSuggestion,
} from "../src/shared/project-task-defaults";

const TEMPLATES = listProjectTemplates();

/** 忽略可选 spaceId（undefined 键在 deepStrictEqual 下与缺键不等价） */
function pickDefaults(defaults: { welcomeMode: string; modePresetId: string | null; source: string }) {
  return { welcomeMode: defaults.welcomeMode, modePresetId: defaults.modePresetId, source: defaults.source };
}

function makeTask(overrides: Partial<{ projectId: string; welcomeMode: string; modePresetId: string | null; updatedAt: number }> = {}) {
  return {
    projectId: "p1",
    welcomeMode: "coding",
    modePresetId: "bugfix-test" as string | null,
    updatedAt: 1000,
    ...overrides,
  };
}

/* ---------- §31.1：Project 创建 payload 不包含任何 Mode/Tag 字段 ---------- */

{
  for (const templateId of ["software-development", "design-creative", "blank"]) {
    const draft = createDraftFromTemplate(templateId);
    draft.name = "边界测试项目";
    const plan = buildProjectCreationPlan(draft);
    const request = plan.request as Record<string, unknown>;
    for (const forbidden of ["modeId", "welcomeMode", "modePresetId", "tagId", "defaultModeId", "defaultPresetId"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(request, forbidden),
        false,
        `ProjectCreateRequest 不允许出现 ${forbidden}（template=${templateId}）`,
      );
    }
    assert.equal(plan.request.templateId, templateId, "templateId 照常携带（来源记录，不参与 Runtime）");
  }

  // 草稿（ProjectCreationDraft）同样不允许 Mode/Tag 字段
  const draft = createDraftFromTemplate("software-development") as unknown as Record<string, unknown>;
  for (const forbidden of ["defaultModeId", "defaultPresetId", "modeId", "tagId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(draft, forbidden), false, `ProjectCreationDraft 不允许 ${forbidden}`);
  }
  const dirty = (draft.dirty as Record<string, boolean>);
  assert.equal(Object.prototype.hasOwnProperty.call(dirty, "mode"), false, "dirty 不允许 mode 键");
}

/* ---------- §31.2：Template Suggestion（软件模板 → coding + bugfix-test） ---------- */

{
  const suggestion = resolveProjectTemplateTaskSuggestion({ templateId: "software-development" }, TEMPLATES);
  assert.deepEqual(suggestion, { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" });

  const design = resolveProjectTemplateTaskSuggestion({ templateId: "design-creative" }, TEMPLATES);
  // 现行模板定义：working + web-prototype（Penpot）。旧断言期望 bot/general，与模板在 95dbe28
  // 的变更不符（且 bot 已不再保留 general/web-prototype，见 mode-preset-test）。
  // project-template-test 同样断言 web-prototype，是同一契约的权威来源。
  assert.deepEqual(design, { recommendedModeId: "working", recommendedPresetId: "web-prototype" }, "设计创意推荐 working + web-prototype");

  // blank 模板不提供推荐
  assert.equal(resolveProjectTemplateTaskSuggestion({ templateId: "blank" }, TEMPLATES), null);
  // 无 templateId → null（已有/空白 Project）
  assert.equal(resolveProjectTemplateTaskSuggestion({}, TEMPLATES), null);
}

/* ---------- §31.3：最近任务优先于模板推荐 ---------- */

{
  const defaults = pickDefaults(resolveProjectTaskDefaults({
    tasks: [makeTask({ welcomeMode: "coding", modePresetId: "code-review", updatedAt: 2000 })],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
  }));
  assert.deepEqual(defaults, {
    welcomeMode: "coding",
    modePresetId: "code-review",
    source: "recent-task",
  }, "recent task 优先于模板推荐，不被拉回 bugfix-test");
}

/* ---------- §31.4：无最近任务 → 模板推荐（次优先） ---------- */

{
  const defaults = pickDefaults(resolveProjectTaskDefaults({
    tasks: [],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
  }));
  assert.deepEqual(defaults, {
    welcomeMode: "coding",
    modePresetId: "bugfix-test",
    source: "project-template",
  });
}

/* ---------- §31.5：无最近任务 + 无模板（templateId=null）→ 系统默认 ---------- */

{
  const defaults = pickDefaults(resolveProjectTaskDefaults({
    tasks: [],
    projectId: "p1",
    templateSuggestion: null,
  }));
  assert.deepEqual(defaults, {
    welcomeMode: "working",
    modePresetId: null,
    source: "system-default",
  });
}

/* ---------- §31.6：非法模板 Preset（mode=coding + preset=ai-ui）→ 归一化，不崩溃 ---------- */

{
  const suggestion = resolveTemplateTaskSuggestion({ recommendedModeId: "coding", recommendedPresetId: "ai-ui" });
  assert.deepEqual(suggestion, {
    recommendedModeId: "coding",
    recommendedPresetId: defaultModePresetId("coding"),
  }, "preset 不属于该 mode → 该 mode 默认 preset（§14）");

  // 模板链路同样归一化
  const defaults = pickDefaults(resolveProjectTaskDefaults({
    tasks: [],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "ai-ui" },
  }));
  assert.deepEqual(defaults, {
    welcomeMode: "coding",
    modePresetId: "minimal",
    source: "project-template",
  });

  // mode 非法 → 整条推荐丢弃，不虚构模式（§14 / §19）
  assert.equal(resolveTemplateTaskSuggestion({ recommendedModeId: "unknown-mode", recommendedPresetId: "bugfix-test" }), null);
  assert.equal(resolveTemplateTaskSuggestion({ recommendedPresetId: "bugfix-test" }), null, "缺 recommendedModeId → 丢弃");
  assert.equal(resolveTemplateTaskSuggestion(undefined), null);
}

/* ---------- §31.7：Template 不存在 → system fallback，不阻塞 ---------- */

{
  assert.equal(resolveProjectTemplateTaskSuggestion({ templateId: "missing-template" }, TEMPLATES), null);
  const defaults = resolveProjectTaskDefaults({
    tasks: [],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "missing-mode" },
  });
  assert.equal(defaults.source, "system-default", "非法推荐不阻塞 Task 创建");
}

/* ---------- 跨 Tag / 跨 Mode：同一 Project 的不同 Task 互不干扰 ---------- */

{
  // 不同 Task 不同 Tag：Task A=code-review、Task B=bugfix-test、Task C=readonly-explain
  const taskA = makeTask({ welcomeMode: "coding", modePresetId: "code-review", updatedAt: 1000 });
  const taskB = makeTask({ welcomeMode: "coding", modePresetId: "bugfix-test", updatedAt: 2000 });
  const taskC = makeTask({ welcomeMode: "coding", modePresetId: "readonly-explain", updatedAt: 3000 });
  const latest = pickDefaults(resolveProjectTaskDefaults({
    tasks: [taskA, taskB, taskC],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
  }));
  assert.deepEqual(latest, {
    welcomeMode: "coding",
    modePresetId: "readonly-explain",
    source: "recent-task",
  }, "默认值取最近 Task 的 Tag（readonly-explain），不被模板或其他 Task 覆盖");

  // 不同 Task 不同 Mode：Task A=coding、Task B=design —— 各自独立
  const modeA = makeTask({ welcomeMode: "coding", modePresetId: "code-review", updatedAt: 1000 });
  const modeB = makeTask({ welcomeMode: "bot", modePresetId: "ai-ui", updatedAt: 2000 });
  const latestMode = resolveProjectTaskDefaults({
    tasks: [modeA, modeB],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
  });
  assert.equal(latestMode.welcomeMode, "bot", "最近 Task 是 design → 默认 design，不被模板的 coding 限制（§0.2 / Rule 6）");

  // 其它 Project 的任务不参与默认值
  const foreign = pickDefaults(resolveProjectTaskDefaults({
    tasks: [makeTask({ projectId: "other-project", welcomeMode: "bot", modePresetId: "ai-ui", updatedAt: 9999 })],
    projectId: "p1",
    templateSuggestion: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
  }));
  assert.deepEqual(foreign, {
    welcomeMode: "coding",
    modePresetId: "bugfix-test",
    source: "project-template",
  }, "跨 Project 任务不串扰");
}

console.log("project-task-defaults-test: PASS");
