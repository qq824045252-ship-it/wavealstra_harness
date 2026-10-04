/**
 * Project Config Rail Detail 纯逻辑测试（实施规划 §31）。
 * 覆盖：
 * - 搜索（name / description，§12）
 * - Draft 深拷贝（§6/§20）
 * - Available 划分（§9）
 * - Detail 元数据完整性（§5）
 * - 多 Guard 数组语义（§7：全部保存成功才放行；任一失败保留现场）
 */
import assert from "node:assert/strict";
import {
  CAPABILITY_MANAGE_ENTRY,
  PROJECT_CAPABILITY_SCOPE_HINT,
  PROJECT_DETAIL_META,
  UNAVAILABLE_LABEL,
  clonePolicies,
  filterCapabilityItems,
  splitCapabilityOptions,
} from "../src/renderer/src/lib/projectConfigDetail";
import { resolveUnsavedGuardAction, type ProjectUnsavedGuard } from "../src/renderer/src/lib/projectWorkspace";
import { setProjectSelectionPolicyState } from "../src/shared/project-policy-editor";
import { emptyProjectPolicies, type ProjectPoliciesDto } from "../src/shared/project-domain";

/* ---------- §12：搜索匹配 name / description ---------- */
{
  const items = [
    { id: "a", name: "Git", description: "版本控制" },
    { id: "b", name: "Testing", description: "测试技能" },
    { id: "c", name: "DOCX", description: "Word 文档处理" },
  ];
  assert.deepEqual(filterCapabilityItems(items, "git").map((i) => i.id), ["a"], "name match");
  assert.deepEqual(filterCapabilityItems(items, "测试").map((i) => i.id), ["b"], "description match");
  assert.deepEqual(filterCapabilityItems(items, "  GIT  ").map((i) => i.id), ["a"], "trim + case-insensitive");
  assert.equal(filterCapabilityItems(items, "zzz").length, 0, "no match");
  assert.equal(filterCapabilityItems(items, "").length, 3, "empty query returns all");
  assert.equal(filterCapabilityItems(items, undefined as unknown as string).length, 3, "undefined query treated as empty");
  // 无 description 的项不因 undefined 报错
  assert.deepEqual(filterCapabilityItems([{ id: "x", name: "Only" }], "only").map((i) => i.id), ["x"]);
}

/* ---------- §6/§20：Draft 深拷贝，不共享引用 ---------- */
{
  const base = emptyProjectPolicies();
  base.expert.allow.push("e1");
  base.skill.prefer.push("s1");
  base.connector.recommended.push("c1");
  base.mcp = { mode: "hard", allow: ["pi"], deny: [] };

  const draft = clonePolicies(base);
  assert.deepEqual(draft, base, "clone equals source");
  assert.notEqual(draft.expert, base.expert, "expert not shared");
  assert.notEqual(draft.skill, base.skill, "skill not shared");
  assert.notEqual(draft.connector, base.connector, "connector not shared");
  assert.notEqual(draft.mcp, base.mcp, "mcp not shared");
  assert.notEqual(draft.expert.allow, base.expert.allow, "expert.allow array not shared");

  // 改 draft 不影响源（§20：Draft 关闭后销毁，不持久化）
  draft.expert.allow.push("e2");
  assert.equal(base.expert.allow.length, 1, "source untouched");
  assert.equal(draft.expert.allow.length, 2, "draft mutated independently");
}

/* ---------- §9：Available = Registry 中未被策略引用的项 ---------- */
{
  const all = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const { available } = splitCapabilityOptions(all, ["a", "c"]);
  assert.deepEqual(available.map((i) => i.id), ["b"], "referenced ids excluded");
  const { available: none } = splitCapabilityOptions(all, ["a", "b", "c"]);
  assert.equal(none.length, 0, "all referenced → empty available");
  const { available: allAvail } = splitCapabilityOptions(all, []);
  assert.equal(allAvail.length, 3, "nothing referenced → all available");
}

/* ---------- §5/§8/§9：Detail 元数据完整（五分区都有统一壳所需字段） ---------- */
{
  const sections = ["instructions", "experts", "skills", "connectors", "mcp"] as const;
  for (const section of sections) {
    const meta = PROJECT_DETAIL_META[section];
    assert.ok(meta.title.length > 0, `${section}: title present`);
    assert.ok(meta.description.length > 0, `${section}: description present`);
  }
  assert.ok(PROJECT_CAPABILITY_SCOPE_HINT.length > 0, "scope hint present");
  assert.equal(UNAVAILABLE_LABEL, "不可用", "unavailable label stable");
}

/* ---------- §13/§14：全局管理入口映射（文案与目标页不串） ---------- */
{
  assert.equal(CAPABILITY_MANAGE_ENTRY.connectors?.label, "管理连接器");
  assert.equal(CAPABILITY_MANAGE_ENTRY.connectors?.page, "connectors", "connector manage → 全局 connectors Hub");
  assert.equal(CAPABILITY_MANAGE_ENTRY.mcp?.label, "管理 MCP");
  assert.equal(CAPABILITY_MANAGE_ENTRY.mcp?.page, "mcp", "mcp manage → 全局 mcp Hub");
  assert.equal(CAPABILITY_MANAGE_ENTRY.experts, undefined, "expert has no manage entry");
  assert.equal(CAPABILITY_MANAGE_ENTRY.skills, undefined, "skill has no manage entry");
  assert.notEqual(
    CAPABILITY_MANAGE_ENTRY.connectors?.label,
    CAPABILITY_MANAGE_ENTRY.mcp?.label,
    "labels must not be mixed",
  );
}

/* ---------- §11：普通 remove ≠ deny（inherit 清除全部列表，绝不写 deny） ---------- */
{
  const policy = { allow: ["e1"], deny: [], recommended: [] };
  const removed = setProjectSelectionPolicyState(policy, "e1", "inherit");
  assert.deepEqual(removed, { allow: [], deny: [], recommended: [] }, "remove clears allow, deny stays empty");

  // 高级 deny 项可通过 inherit 解除，但普通 × 移除绝不产生 deny
  const denied = { allow: [], deny: ["e2"], recommended: [] };
  assert.deepEqual(
    setProjectSelectionPolicyState(denied, "e2", "inherit"),
    { allow: [], deny: [], recommended: [] },
    "inherit lifts deny without side effects",
  );
  const reAdded = setProjectSelectionPolicyState(policy, "e1", "allow");
  assert.equal(reAdded.deny.length, 0, "add/remove never writes deny");
}

/* ---------- §7：多 Guard 数组语义 ---------- */
{
  void (async () => {
    const calls: string[] = [];
    const guard = (name: string, opts: { saveFail?: boolean } = {}): ProjectUnsavedGuard => ({
      dirty: true,
      save: async () => {
        calls.push(`save:${name}`);
        if (opts.saveFail) throw new Error(`fail:${name}`);
      },
      discard: () => calls.push(`discard:${name}`),
    });

    // 全部保存成功 → navigate
    calls.length = 0;
    const ok = await resolveUnsavedGuardAction("save", [guard("rail"), guard("pane")]);
    assert.equal(ok, "navigate");
    assert.deepEqual(calls, ["save:rail", "save:pane"], "all dirty guards saved in order");

    // 任一失败 → stay-error，前面的已保存（不重复提交）
    calls.length = 0;
    const failed = await resolveUnsavedGuardAction("save", [guard("rail", { saveFail: true }), guard("pane")]);
    assert.equal(failed, "stay-error");
    assert.deepEqual(calls, ["save:rail"], "stops at first failure");

    // discard → 全部放弃
    calls.length = 0;
    const discarded = await resolveUnsavedGuardAction("discard", [guard("rail"), guard("pane")]);
    assert.equal(discarded, "navigate");
    assert.deepEqual(calls, ["discard:rail", "discard:pane"]);

    // cancel → stay，无副作用
    calls.length = 0;
    assert.equal(await resolveUnsavedGuardAction("cancel", [guard("rail")]), "stay");
    assert.deepEqual(calls, []);

    // 空数组 → 直接放行（无 dirty guard）
    assert.equal(await resolveUnsavedGuardAction("save", []), "navigate");

    // 兼容旧签名：单个 guard
    const single = await resolveUnsavedGuardAction("save", guard("solo"));
    assert.equal(single, "navigate");

    console.log("project-config-detail-test: PASS");
  })();
}
