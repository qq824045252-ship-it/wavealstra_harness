import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectContextResolver } from "../src/main/project/ProjectContextResolver";
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
import { emptyModePolicy, type ModeProfileDto } from "../src/shared/mode-profile";
import { assemblyInputsChanged } from "../src/main/agent/SessionRegistry";
import { filterSkillsForMode } from "../src/main/agent/SkillPolicy";
import { RuntimeContextSnapshotRepository } from "../src/main/agent/RuntimeContextSnapshotRepository";
import {
  resolveMcpCapability,
  resolveRuntimePolicy,
  resolveSelectionCapability,
  resolveSkillCapability,
} from "../src/shared/runtime-policy";
import {
  getProjectMcpPolicyState,
  getProjectSelectionPolicyState,
  getProjectSkillPolicyState,
  mergeProjectCapabilityOptions,
  setProjectMcpPolicyState,
  setProjectSelectionPolicyState,
  setProjectSkillPolicyState,
} from "../src/shared/project-policy-editor";
import { resolveProjectTaskDefaults } from "../src/shared/project-task-defaults";
import { diffRuntimeAuditSnapshots, sanitizeRuntimeAuditSnapshot } from "../src/shared/runtime-audit-inspector";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-domain-"));
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const repository = new ProjectRepository(db.connection);
const service = new ProjectService(repository, memory);

{
  const expert = setProjectSelectionPolicyState(
    { allow: ["reviewer"], deny: [], recommended: ["reviewer"] },
    "reviewer",
    "deny",
  );
  assert.deepEqual(expert, { allow: [], deny: ["reviewer"], recommended: [] });
  assert.equal(getProjectSelectionPolicyState(expert, "reviewer"), "deny");

  const skill = setProjectSkillPolicyState(
    { allow: ["git"], prefer: ["git"], demote: [], hide: [] },
    "git",
    "hide",
  );
  assert.deepEqual(skill, { allow: [], prefer: [], demote: [], hide: ["git"] });
  assert.equal(getProjectSkillPolicyState(skill, "git"), "hide");

  const mcp = setProjectMcpPolicyState(
    { mode: "soft", allow: ["github"], deny: [] },
    "github",
    "deny",
  );
  assert.deepEqual(mcp, { mode: "soft", allow: [], deny: ["github"] });
  assert.equal(getProjectMcpPolicyState(mcp, "github"), "deny");

  const options = mergeProjectCapabilityOptions([{ id: "known", name: "Known" }], ["known", "missing"]);
  assert.deepEqual(options.map((option) => option.id), ["known", "missing"]);

  const defaults = resolveProjectTaskDefaults({
    tasks: [
      { projectId: "p", spaceId: "old", welcomeMode: "working", modePresetId: "old-tag", updatedAt: 1 },
      { projectId: "p", spaceId: "recent", welcomeMode: "general", modePresetId: "ui", updatedAt: 2 },
      { projectId: "other", spaceId: "wrong", updatedAt: 3 },
    ],
    projectId: "p",
  });
  assert.deepEqual(defaults, {
    spaceId: "recent",
    welcomeMode: "general",
    modePresetId: "ui",
    source: "recent-task",
  });
}

try {
  const created = service.create({
    name: "MyBuddy",
    description: "长期产品目标",
    instructions: "保持 Project 与 Space 正交。",
    policies: {
      skill: { prefer: ["typescript"], demote: [], hide: [], allow: ["typescript", "git", "penpot"] },
      mcp: { mode: "hard", allow: ["github"], deny: ["blender"] },
    },
  });
  assert.match(created.id, /^proj_/);
  assert.deepEqual(created.policies.skill.allow, ["typescript", "git", "penpot"]);
  assert.equal(service.list().length, 1);
  const normalizedPolicies = service.create({
    name: "Policy normalization",
    policies: {
      expert: { allow: ["reviewer"], deny: ["REVIEWER"], recommended: ["reviewer"] },
      skill: { allow: ["git"], prefer: ["git"], demote: ["git"], hide: ["GIT"] },
      connector: { allow: ["github"], deny: ["GITHUB"], recommended: ["github"] },
      mcp: { mode: "soft", allow: ["server"], deny: ["SERVER"] },
    },
  });
  assert.deepEqual(normalizedPolicies.policies.expert, { allow: [], deny: ["REVIEWER"], recommended: [] });
  assert.deepEqual(normalizedPolicies.policies.skill, { allow: [], prefer: [], demote: [], hide: ["GIT"] });
  assert.deepEqual(normalizedPolicies.policies.connector, { allow: [], deny: ["GITHUB"], recommended: [] });
  assert.deepEqual(normalizedPolicies.policies.mcp, { mode: "soft", allow: [], deny: ["SERVER"] });
  service.delete(normalizedPolicies.id);
  const resourceFile = join(root, "project-guide.md");
  writeFileSync(resourceFile, "Project file guidance", "utf8");
  const textResource = service.createResource({
    projectId: created.id,
    kind: "text",
    title: "Decision log",
    value: "Keep the runtime resolver unified.",
  });
  service.createResource({ projectId: created.id, kind: "file", title: "Guide", value: resourceFile });
  service.createResource({ projectId: created.id, kind: "url", title: "Reference", value: "https://example.com/spec" });
  assert.equal(service.get(created.id)?.resources.length, 3);
  const folderProject = service.create({ name: "Asset Folders" });
  const folder = service.createResource({ projectId: folderProject.id, kind: "folder", title: "系统文件", value: "" });
  const nestedFile = service.createResource({
    projectId: folderProject.id,
    kind: "file",
    title: "nested.md",
    value: resourceFile,
    parentId: folder.id,
  });
  assert.equal(nestedFile.parentId, folder.id);
  const movedToRoot = service.updateResource({ id: nestedFile.id, parentId: null });
  assert.equal(movedToRoot.parentId, undefined);
  const movedBack = service.updateResource({ id: nestedFile.id, parentId: folder.id });
  assert.equal(movedBack.parentId, folder.id);
  assert.throws(
    () => service.updateResource({ id: folder.id, parentId: folder.id }),
    /不能把资料放进自己/,
  );
  const folderContext = new ProjectContextResolver(db, repository, memory).resolveProject(folderProject.id);
  assert.equal(folderContext?.resources.some((resource) => resource.title === "系统文件"), false, "folders are not injected");
  assert.equal(folderContext?.resources.some((resource) => resource.title === "nested.md"), true);
  const duplicatedFolders = service.duplicate({ sourceId: folderProject.id });
  const duplicatedFolder = duplicatedFolders.resources.find((resource) => resource.kind === "folder");
  const duplicatedChild = duplicatedFolders.resources.find((resource) => resource.title === "nested.md");
  assert.ok(duplicatedFolder, "duplicate keeps folders");
  assert.equal(duplicatedChild?.parentId, duplicatedFolder?.id, "duplicate remaps folder parent ids");
  service.delete(duplicatedFolders.id);
  service.delete(folderProject.id);
  service.update({ id: created.id, goal: "交付可靠的项目页", currentStage: "实现中" });
  const sourceWithResources = service.get(created.id)!;
  const duplicated = service.duplicate({ sourceId: created.id });
  assert.equal(duplicated.name, "MyBuddy 副本");
  assert.equal(duplicated.archived, false);
  assert.equal(duplicated.instructions, created.instructions);
  assert.equal(duplicated.goal, "交付可靠的项目页", "duplicate keeps the long-lived goal");
  assert.equal(duplicated.currentStage, undefined, "duplicate does not copy transient current stage");
  assert.deepEqual(duplicated.policies, created.policies);
  assert.equal(duplicated.resources.length, 3);
  assert.ok(duplicated.resources.every((resource) => resource.projectId === duplicated.id));
  assert.equal(
    duplicated.resources.some((resource) => sourceWithResources.resources.some((source) => source.id === resource.id)),
    false,
    "Duplicated resources must receive independent identities",
  );
  assert.equal(db.listTasks().some((task) => task.projectId === duplicated.id), false);
  service.delete(duplicated.id);

  db.upsertTask({ id: "task-1", title: "实现 Project", updatedAt: 1, projectId: created.id });
  assert.equal(db.getTask("task-1")?.projectId, created.id);
  db.upsertSpace({ id: "space-1", name: "Workspace", path: root });
  service.update({ id: created.id, defaultSpaceId: "space-1" });
  assert.equal(new ProjectRepository(db.connection).get(created.id)?.defaultSpaceId, "space-1");
  assert.equal(db.getTask("task-1")?.spaceId, undefined, "Changing default must not rebind existing tasks");
  assert.throws(() => service.update({ id: created.id, defaultSpaceId: "missing" }), /文件夹/);
  assert.equal(resolveProjectTaskDefaults({ tasks: [{ projectId: created.id, spaceId: "old", updatedAt: 1 }], projectId: created.id, defaultSpaceId: "space-1" }).spaceId, "space-1");
  service.update({ id: created.id, defaultSpaceId: null });
  assert.equal(service.get(created.id)?.defaultSpaceId, undefined);
  service.update({ id: created.id, defaultSpaceId: "space-1" });
  db.upsertTask({
    id: "task-1",
    title: "双重绑定",
    updatedAt: 5,
    projectId: created.id,
    spaceId: "space-1",
  });
  db.deleteSpaceTree("space-1");
  assert.equal(service.get(created.id)?.defaultSpaceId, undefined, "Deleted folder must clear project preference");
  assert.equal(db.getTask("task-1")?.spaceId, undefined);
  assert.equal(db.getTask("task-1")?.projectId, created.id, "Explicit Space-tree deletion must not alter Project binding");

  db.upsertTaskExecutionWorkspaceState({
    taskId: "task-1",
    directoryName: "task-1",
    state: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  db.connection.exec("CREATE TABLE test_artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL)");
  db.connection.prepare("INSERT INTO test_artifacts (id, task_id) VALUES (?, ?)").run("artifact-1", "task-1");
  db.upsertTask({
    id: "old-task",
    title: "升级前任务",
    updatedAt: 1,
  });
  assert.equal(db.getTask("old-task")?.projectId, undefined, "Legacy Tasks must remain compatible");

  const resolver = new ProjectContextResolver(db, repository, memory);
  const context = resolver.resolveTask("task-1");
  assert.equal(context?.sourceId, created.id);
  assert.equal(context?.instructions, "保持 Project 与 Space 正交。");
  assert.equal(context?.resources.length, 3);
  assert.ok(context?.resources.some((resource) => resource.content.includes("Project file guidance")));
  assert.ok(context?.resources.some((resource) => resource.content.includes("https://example.com/spec")));
  const profile: ModeProfileDto = {
    id: "coding",
    labelZh: "代码开发",
    version: "test",
    blocks: [{ id: "goal", label: "目标", content: "Mode instructions", source: "seed", chars: 17, filePath: "" }],
    policy: emptyModePolicy(),
    hasUserOverride: false,
    totalChars: 17,
    userDir: "",
    policyPath: "",
  };
  const trace = assemblePrompt({
    welcomeMode: "coding",
    profile,
    soul: { name: "Buddy", alias: "用户", persona: "System persona" },
    projectContext: context,
    modePreset: { id: "review", label: "Review", content: "Tag instructions" },
    expertPrompt: "Expert instructions",
    permissionMode: "default",
    platform: "win32",
    memoryEnabled: false,
  });
  const ordered = trace.segments.map((segment) => segment.id);
  assert.ok(ordered.indexOf("mode") < ordered.indexOf("project"));
  assert.ok(ordered.indexOf("project") < ordered.indexOf("modePreset"));
  assert.ok(ordered.indexOf("modePreset") < ordered.indexOf("expert"));
  assert.equal(trace.segments.find((segment) => segment.id === "project")?.sourceId, created.id);
  assert.equal(trace.segments.find((segment) => segment.id === "projectResources")?.sourceId, created.id);
  assert.equal(
    assemblyInputsChanged(
      { expertId: undefined, connectorIds: [], projectContextVersion: "old" },
      null,
      [],
      context?.version,
    ),
    false,
    "Project activity/version clock alone must not invalidate session assembly; runtimeAssembly fingerprint owns real prompt changes",
  );
  const updatedProject = service.update({ id: created.id, instructions: "新的长期指令" });
  const updatedContext = resolver.resolveTask("task-1");
  assert.ok(updatedProject.updatedAt > created.updatedAt);
  assert.notEqual(updatedContext?.version, context?.version);
  assert.equal(updatedContext?.instructions, "新的长期指令");

  const basePolicy = emptyModePolicy();
  const tag = {
    id: "review",
    label: "Review",
    skillPolicy: { prefer: [], demote: [], hide: ["penpot"], allow: ["typescript", "git"] },
    mcpPolicy: { mode: "hard" as const, allow: ["github"], deny: ["blender"] },
  };
  const runtime = resolveRuntimePolicy({ mode: basePolicy, project: created.policies, tag });
  assert.deepEqual(runtime.skillPolicy.allow, ["typescript", "git"]);
  assert.ok(runtime.skillPolicy.hide.includes("penpot"));
  assert.deepEqual(runtime.mcpPolicy.allow, ["github"]);
  assert.ok(runtime.mcpPolicy.deny.includes("blender"));

  const tagOnly = resolveRuntimePolicy({
    mode: basePolicy,
    tag: { id: "tag-only", label: "Tag only", skillPolicy: tag.skillPolicy },
  });
  assert.deepEqual(tagOnly.skillPolicy.allow, ["typescript", "git"]);

  const bundledSkillDecision = resolveSkillCapability("penpot", [
    { source: "project", sourceId: created.id, policy: created.policies.skill },
    { source: "tag", sourceId: tag.id, policy: tag.skillPolicy },
  ]);
  assert.equal(bundledSkillDecision.enabled, false, "Expert-bundled Skills remain subject to Tag policy");
  assert.equal(bundledSkillDecision.reason, "tag_policy_denied");

  const connectorDecision = resolveSelectionCapability("github", "connector", [
    { source: "project", sourceId: created.id, policy: { allow: ["github"], deny: [], recommended: [] } },
    { source: "tag", sourceId: tag.id, policy: { allow: ["github"], deny: ["github"], recommended: [] } },
  ]);
  assert.equal(connectorDecision.enabled, false);
  assert.equal(connectorDecision.reason, "tag_policy_denied");

  for (const kind of ["expert", "connector"] as const) {
    const cases = [
      { project: { allow: ["cap"], deny: [], recommended: [] }, tag: { allow: ["cap"], deny: [], recommended: [] }, enabled: true, reason: undefined },
      { project: { allow: ["cap"], deny: [], recommended: [] }, tag: { allow: ["cap"], deny: ["cap"], recommended: [] }, enabled: false, reason: "tag_policy_denied" },
      { project: { allow: ["cap"], deny: ["cap"], recommended: [] }, tag: { allow: ["cap"], deny: [], recommended: [] }, enabled: false, reason: "project_policy_denied" },
      { project: { allow: ["cap"], deny: ["cap"], recommended: [] }, tag: { allow: ["cap"], deny: ["cap"], recommended: [] }, enabled: false, reason: "project_policy_denied" },
    ];
    for (const item of cases) {
      const decision = resolveSelectionCapability("cap", kind, [
        { source: "project", sourceId: created.id, policy: item.project },
        { source: "tag", sourceId: tag.id, policy: item.tag },
      ]);
      assert.equal(decision.enabled, item.enabled, `${kind} Project/Tag matrix enabled`);
      assert.equal(decision.reason, item.reason, `${kind} Project/Tag matrix reason`);
    }
  }

  const mcpMatrix = [
    { project: { mode: "hard" as const, allow: ["cap"], deny: [] }, tag: { mode: "hard" as const, allow: ["cap"], deny: [] }, enabled: true, reason: undefined },
    { project: { mode: "hard" as const, allow: ["cap"], deny: [] }, tag: { mode: "hard" as const, allow: ["cap"], deny: ["cap"] }, enabled: false, reason: "tag_policy_denied" },
    { project: { mode: "hard" as const, allow: ["cap"], deny: ["cap"] }, tag: { mode: "hard" as const, allow: ["cap"], deny: [] }, enabled: false, reason: "project_policy_denied" },
    { project: { mode: "hard" as const, allow: ["cap"], deny: ["cap"] }, tag: { mode: "hard" as const, allow: ["cap"], deny: ["cap"] }, enabled: false, reason: "project_policy_denied" },
  ];
  for (const item of mcpMatrix) {
    const decision = resolveMcpCapability("cap", [
      { source: "project", sourceId: created.id, policy: item.project },
      { source: "tag", sourceId: tag.id, policy: item.tag },
    ]);
    assert.equal(decision.enabled, item.enabled, "MCP Project/Tag matrix enabled");
    assert.equal(decision.reason, item.reason, "MCP Project/Tag matrix reason");
  }

  assert.equal(
    resolveSelectionCapability("cap", "expert", [
      { source: "tag", sourceId: tag.id, policy: { allow: ["cap"], deny: [], recommended: [] } },
    ]).enabled,
    true,
    "No-Project capability chain remains compatible",
  );

  const expertConflict = resolveSelectionCapability("reviewer", "expert", [
    { source: "project", sourceId: created.id, policy: { allow: ["reviewer"], deny: [], recommended: [] } },
    { source: "tag", sourceId: tag.id, policy: { allow: ["reviewer"], deny: ["reviewer"], recommended: [] } },
  ]);
  assert.equal(expertConflict.enabled, false);
  assert.equal(expertConflict.reason, "tag_policy_denied");
  assert.equal(
    resolveSelectionCapability("reviewer", "expert", [
      { source: "project", sourceId: created.id, policy: { allow: [], deny: ["reviewer"], recommended: [] } },
      { source: "tag", sourceId: tag.id, policy: { allow: ["reviewer"], deny: [], recommended: [] } },
    ]).reason,
    "project_policy_denied",
  );

  const mcpConflict = resolveMcpCapability("github", [
    { source: "project", sourceId: created.id, policy: { mode: "hard", allow: ["github"], deny: [] } },
    { source: "tag", sourceId: tag.id, policy: { mode: "hard", allow: ["github"], deny: ["github"] } },
  ]);
  assert.equal(mcpConflict.enabled, false);
  assert.equal(mcpConflict.reason, "tag_policy_denied");
  assert.equal(
    resolveMcpCapability("github", [
      { source: "project", sourceId: created.id, policy: { mode: "hard", allow: [], deny: ["github"] } },
      { source: "tag", sourceId: tag.id, policy: { mode: "hard", allow: ["github"], deny: [] } },
    ]).reason,
    "project_policy_denied",
  );

  const namedSkill = {
    id: "skill-opaque-id",
    name: "Git Review",
    description: "Reviews pull requests",
    enabled: true,
  };
  const namedPolicy = { prefer: [], demote: [], hide: ["git review"], allow: [] };
  assert.equal(
    resolveSkillCapability(namedSkill, [{ source: "tag", sourceId: tag.id, policy: namedPolicy }]).enabled,
    false,
  );
  const namedSkillFilter = filterSkillsForMode([namedSkill], "coding", namedPolicy);
  assert.deepEqual(
    namedSkillFilter.hidden.map((skill) => skill.id),
    [namedSkill.id],
    "Skill trace and real filter must use the same id/name/description matcher",
  );
  assert.equal(
    namedSkillFilter.capabilities[0]?.reason,
    "mode_policy_denied",
    "Real Skill filter must emit the capability decision consumed by trace",
  );

  // Partial task writes must preserve the binding; explicit null must clear it.
  db.upsertTask({ id: "task-1", title: "重命名", updatedAt: 2 });
  assert.equal(db.getTask("task-1")?.projectId, created.id);
  db.upsertTask({ id: "task-1", title: "解绑", updatedAt: 3, projectId: null });
  assert.equal(db.getTask("task-1")?.projectId, undefined);

  db.upsertTask({
    id: "task-1",
    title: "重新绑定",
    updatedAt: 4,
    projectId: created.id,
    cwd: root,
    sessionFile: join(root, "session.jsonl"),
  });
  service.archive(created.id, true);
  assert.equal(db.getTask("task-1")?.archived, false, "Project archive must not archive Task");
  assert.equal(service.list().length, 0);
  assert.equal(service.list(true).length, 1);
  assert.equal(
    resolver.resolveTask("task-1")?.instructions,
    "新的长期指令",
    "Archived Project remains a context source for already-bound Tasks",
  );
  assert.doesNotThrow(() =>
    db.upsertTask({ id: "task-1", title: "归档后继续", updatedAt: 5, projectId: created.id }),
  );
  assert.throws(
    () => db.upsertTask({ id: "new-archived-task", title: "禁止新绑定", updatedAt: 1, projectId: created.id }),
    /归档项目不能绑定新任务/,
  );
  service.archive(created.id, false);
  assert.doesNotThrow(() =>
    db.upsertTask({ id: "restored-project-task", title: "恢复后可绑定", updatedAt: 1, projectId: created.id }),
  );
  service.archive(created.id, true);
  const beforeResourceChangeVersion = resolver.resolveTask("task-1")?.version;
  assert.throws(
    () => service.updateResource({ id: textResource.id, enabled: false }),
    /归档.*只读|只读.*归档/,
    "Archived Project must reject resource mutations in the service layer",
  );
  assert.equal(resolver.resolveTask("task-1")?.resources.some((item) => item.id === textResource.id), true);
  assert.equal(
    resolver.resolveTask("task-1")?.version,
    beforeResourceChangeVersion,
    "Rejected archived mutation must not change the Project version",
  );

  const healthProject = service.create({ name: "Resource Health", resourceBudgetChars: 8_000 });
  const nearBudget = service.createResource({
    projectId: healthProject.id,
    kind: "text",
    title: "项目参考名称".repeat(100),
    value: `  ${"x".repeat(70_000)}  `,
  });
  const budgetSkipped = service.createResource({
    projectId: healthProject.id,
    kind: "url",
    title: "Budget skipped",
    value: `https://example.com/${"a".repeat(5000)}`,
  });
  const missing = service.createResource({
    projectId: healthProject.id,
    kind: "file",
    title: "Missing",
    value: join(root, "missing.txt"),
  });
  const binaryFile = join(root, "binary.bin");
  writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3]));
  const binary = service.createResource({ projectId: healthProject.id, kind: "file", title: "Binary", value: binaryFile });
  const largeFile = join(root, "large.txt");
  writeFileSync(largeFile, "z".repeat(64 * 1024 + 1));
  const tooLarge = service.createResource({ projectId: healthProject.id, kind: "file", title: "Large", value: largeFile });
  const inspection = resolver.inspectProjectResources(healthProject.id);
  assert.equal(inspection?.items.find((item) => item.resourceId === nearBudget.id)?.status, "ready");
  assert.equal(service.get(healthProject.id)?.resources.find(item => item.id === nearBudget.id)?.title, "项目参考名称".repeat(100));
  assert.equal(resolver.resolveProject(healthProject.id)?.resources.find(item => item.id === nearBudget.id)?.title, "项目参考名称".repeat(100));
  assert.equal(service.get(healthProject.id)?.resources.find(item => item.id === nearBudget.id)?.value, `  ${"x".repeat(70_000)}  `);
  assert.equal(resolver.resolveProject(healthProject.id)?.resources.find(item => item.id === tooLarge.id)?.content, "z".repeat(64 * 1024 + 1));
  assert.equal(resolver.resolveProject(healthProject.id)?.resources.find(item => item.id === budgetSkipped.id)?.content, `参考 URL：https://example.com/${"a".repeat(5000)}`);
  assert.throws(() => service.createResource({ projectId: healthProject.id, kind: "url", title: "Invalid", value: "file:///etc/passwd" }), /http\(s\)/);
  assert.equal(inspection?.items.find((item) => item.resourceId === budgetSkipped.id)?.status, "ready");
  assert.equal(inspection?.items.find((item) => item.resourceId === missing.id)?.status, "missing");
  assert.equal(inspection?.items.find((item) => item.resourceId === binary.id)?.status, "binary");
  assert.equal(inspection?.items.find((item) => item.resourceId === tooLarge.id)?.status, "ready");
  service.updateResource({ id: budgetSkipped.id, sortOrder: 0 });
  service.updateResource({ id: nearBudget.id, sortOrder: 1 });
  assert.equal(service.get(healthProject.id)?.resources[0]?.id, budgetSkipped.id, "Resource order must be persisted");
  const reordered = resolver.inspectProjectResources(healthProject.id);
  assert.equal(reordered?.items.find((item) => item.resourceId === budgetSkipped.id)?.status, "ready");
  assert.equal(reordered?.items.find((item) => item.resourceId === nearBudget.id)?.status, "ready");

  const directDelete = service.create({
    name: "Direct SQL Project",
    policies: { expert: { allow: ["reviewer"], deny: [], recommended: [] } },
  });
  db.upsertTask({ id: "direct-delete-task", title: "Direct SQL", updatedAt: 1, projectId: directDelete.id });
  assert.equal(db.connection.pragma("foreign_keys", { simple: true }), 1);
  const taskForeignKeys = db.connection.pragma("foreign_key_list(tasks)") as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  assert.ok(
    taskForeignKeys.some(
      (key) => key.table === "projects" && key.from === "project_id" && key.on_delete === "SET NULL",
    ),
  );
  db.connection.prepare("DELETE FROM projects WHERE id = ?").run(directDelete.id);
  assert.equal(db.getTask("direct-delete-task")?.projectId, undefined);
  for (const table of [
    "project_expert_policy",
    "project_skill_policy",
    "project_connector_policy",
    "project_mcp_policy",
  ]) {
    assert.equal(
      (db.connection.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`).get(directDelete.id) as { count: number }).count,
      0,
      `Direct SQL deletion must cascade ${table}`,
    );
  }
  assert.throws(
    () =>
      db.connection
        .prepare("INSERT INTO project_skill_policy (project_id) VALUES (?)")
        .run("missing-project"),
    /FOREIGN KEY constraint failed/,
    "Policy tables must reject orphan rows when foreign_keys is enabled",
  );

  service.delete(created.id);
  assert.ok(db.getTask("task-1"), "Project deletion must retain Task");
  assert.equal(db.getTask("task-1")?.projectId, undefined);
  assert.equal(db.getTask("task-1")?.cwd, root);
  assert.equal(db.getTask("task-1")?.sessionFile, join(root, "session.jsonl"));
  assert.equal(
    (db.connection.prepare("SELECT count(*) AS count FROM test_artifacts WHERE task_id = ?").get("task-1") as { count: number }).count,
    1,
    "Project deletion must retain Task artifacts",
  );
  assert.ok(
    db.getTaskExecutionWorkspaceState("task-1"),
    "Project deletion must retain TaskExecutionWorkspace lifecycle state",
  );
  assert.equal(
    (db.connection.prepare("SELECT count(*) AS count FROM project_resources WHERE project_id = ?").get(created.id) as { count: number }).count,
    0,
    "Project deletion must cascade Project Resources without touching Tasks",
  );

  const projectColumns = db.connection.pragma("table_info(projects)") as Array<{ name: string }>;
  assert.equal(projectColumns.some((column) => column.name === "space_id"), false);

  const projectsPageSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/ProjectsPage.tsx"),
    "utf8",
  );
  const modalSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/NewProjectModal.tsx"),
    "utf8",
  );
  const pickerSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/chat/ProjectPicker.tsx"),
    "utf8",
  );
  const listSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/ProjectList.tsx"),
    "utf8",
  );
  const workspaceSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/ProjectWorkspace.tsx"),
    "utf8",
  );
  const tasksSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/ProjectTasks.tsx"),
    "utf8",
  );
  const capabilitiesSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/ProjectCapabilities.tsx"),
    "utf8",
  );
  const settingsSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/ProjectSettings.tsx"),
    "utf8",
  );
  const newTaskSource = readFileSync(
    join(process.cwd(), "src/renderer/src/components/pages/project/NewProjectTaskModal.tsx"),
    "utf8",
  );
  assert.equal(projectsPageSource.includes("@/mock/data"), false, "Projects page must not use mock templates");
  assert.ok(projectsPageSource.includes("createProject") || modalSource.includes("createProject"));
  assert.ok(listSource.includes("archiveProject") || settingsSource.includes("archiveProject"));
  assert.ok(listSource.includes("deleteProject") || settingsSource.includes("deleteProject"));
  assert.ok(capabilitiesSource.includes("Expert Policy"));
  assert.ok(capabilitiesSource.includes("Skill Policy"));
  assert.ok(capabilitiesSource.includes("Connector Policy"));
  assert.ok(capabilitiesSource.includes("MCP Policy"));
  assert.ok(capabilitiesSource.includes("recommended"));
  assert.ok(capabilitiesSource.includes("demote"));
  assert.ok(capabilitiesSource.includes("hide"));
  assert.ok(capabilitiesSource.includes("Hard · allow 白名单"));
  assert.ok(pickerSource.includes("bindProjectContext"));
  assert.equal(pickerSource.includes("bindTaskSpace"), false, "Project selector must not mutate Space");
  assert.ok(tasksSource.includes("task.projectId === projectId"), "Project tasks derive from Task.projectId");
  assert.ok(workspaceSource.includes("startProjectTask") || newTaskSource.includes("startProjectTask"));
  assert.ok(newTaskSource.includes("projectLocked") || newTaskSource.includes("project-locked-context"));
  assert.equal(workspaceSource.includes("project_tasks"), false, "Project detail must not invent a relation table");
  assert.equal(projectsPageSource.includes("ProjectDetailModal"), false, "Legacy ProjectDetailModal must be removed");

  db.upsertTask({ id: "audit-task", title: "Audit", updatedAt: 1 });
  const auditRepository = new RuntimeContextSnapshotRepository(db.connection);
  const runningAudit = auditRepository.record({
    workingDirectory: root,
    taskId: "audit-task",
    userMessageId: "audit-user",
    assistantMessageId: "audit-assistant",
    status: "running",
    startedAt: 10,
    assemblyHash: "hash-a",
    mode: "coding",
    resolvedInstructions: [],
    resolvedCapabilities: [],
    warnings: [],
  });
  auditRepository.finish(runningAudit.executionId, "failed", "expected failure");
  assert.equal(auditRepository.list("audit-task", 1)[0]?.status, "failed");
  assert.equal(auditRepository.list("audit-task", 1)[0]?.error, "expected failure");
  assert.equal(auditRepository.list("audit-task", 1)[0]?.workingDirectory, root);
  const longContent = "sensitive-resource:" + "x".repeat(12_000);
  const compactedAudit = auditRepository.record({
    taskId: "audit-task",
    userMessageId: "compact-user",
    assistantMessageId: "compact-assistant",
    status: "completed",
    startedAt: 11,
    completedAt: 12,
    assemblyHash: "hash-compact",
    mode: "coding",
    resolvedInstructions: [{
      id: "projectResources",
      title: "Project resources",
      source: "project",
      sourceId: created.id,
      chars: longContent.length,
      content: longContent,
    }],
    resolvedCapabilities: [],
    warnings: [],
  });
  assert.equal(compactedAudit.resolvedInstructions[0]?.storage, "excerpt");
  assert.ok((compactedAudit.resolvedInstructions[0]?.storedChars ?? Infinity) < longContent.length);
  assert.equal(compactedAudit.resolvedInstructions[0]?.content.includes(longContent), false);
  assert.equal(compactedAudit.resolvedInstructions[0]?.contentHash.length, 64);
  assert.ok(compactedAudit.storageBytes < Buffer.byteLength(longContent));
  const sanitized = sanitizeRuntimeAuditSnapshot(compactedAudit) as { instructions: Array<Record<string, unknown>> };
  assert.equal("content" in sanitized.instructions[0]!, false, "Redacted export must omit instruction bodies");
  const changedForDiff = { ...compactedAudit, assemblyHash: "hash-next", mode: "general" as const };
  assert.ok(diffRuntimeAuditSnapshots(compactedAudit, changedForDiff).some((change) => change.startsWith("Mode:")));
  const capabilityAddedForDiff = {
    ...compactedAudit,
    resolvedCapabilities: [{
      id: "opendesign",
      kind: "mcp" as const,
      enabled: false,
      sources: [{ source: "mode" as const, sourceId: "coding", decision: "denied" as const }],
      reason: "mode_not_supported",
    }],
  };
  assert.ok(
    diffRuntimeAuditSnapshots(compactedAudit, capabilityAddedForDiff)
      .includes("mcp:opendesign: added (disabled)"),
    "Snapshot diff must distinguish a newly added disabled capability from disabled -> disabled",
  );
  for (let index = 0; index < 105; index += 1) {
    auditRepository.record({
      taskId: "audit-task",
      userMessageId: `user-${index}`,
      assistantMessageId: `assistant-${index}`,
      status: "completed",
      startedAt: index,
      completedAt: index + 1,
      assemblyHash: `hash-${index}`,
      mode: "coding",
      resolvedInstructions: [],
      resolvedCapabilities: [],
      warnings: [],
    });
  }
  assert.equal(
    (db.connection.prepare("SELECT count(*) AS count FROM task_runtime_context_snapshots WHERE task_id = ?").get("audit-task") as { count: number }).count,
    50,
    "Runtime audit retention must keep at most 50 executions per Task",
  );
  assert.ok(auditRepository.clear("audit-task") > 0);
  assert.equal(auditRepository.list("audit-task").length, 0);
  db.upsertTask({ id: "audit-budget-task", title: "Audit Budget", updatedAt: 1 });
  const oldAudit = auditRepository.record({
    taskId: "audit-budget-task", userMessageId: "old", assistantMessageId: "old-a",
    status: "completed", startedAt: 1, completedAt: 2, assemblyHash: "old", mode: "coding",
    resolvedInstructions: [], resolvedCapabilities: [], warnings: ["old"],
  });
  db.connection.prepare("UPDATE task_runtime_context_snapshots SET created_at = ? WHERE id = ?")
    .run(Date.now() - 91 * 24 * 60 * 60 * 1000, oldAudit.id);
  for (let index = 0; index < 30; index += 1) {
    auditRepository.record({
      taskId: "audit-budget-task", userMessageId: `budget-u-${index}`, assistantMessageId: `budget-a-${index}`,
      status: "completed", startedAt: index, completedAt: index + 1, assemblyHash: `budget-${index}`, mode: "coding",
      resolvedInstructions: [], resolvedCapabilities: [], warnings: ["w".repeat(100_000)],
    });
  }
  const budgetedAudits = auditRepository.list("audit-budget-task", 100);
  assert.equal(budgetedAudits.some((snapshot) => snapshot.id === oldAudit.id), false, "90-day retention must prune old Audit");
  assert.ok(budgetedAudits.length < 30 && budgetedAudits.length >= 1, "Byte budget must prune oldest Audit records");
  assert.ok(auditRepository.clear() >= budgetedAudits.length, "Global Audit cleanup must remove all tasks");

  const restartPath = join(root, "restart.db");
  const beforeRestart = new AppDatabase(restartPath);
  const restartService = new ProjectService(
    new ProjectRepository(beforeRestart.connection),
    new MemoryService(beforeRestart, { semantic: false }),
  );
  const restartProject = restartService.create({ name: "Restart Project", instructions: "Persist me" });
  beforeRestart.upsertTask({
    id: "restart-task",
    title: "Restart Task",
    updatedAt: 1,
    projectId: restartProject.id,
  });
  beforeRestart.connection.close();
  const afterRestart = new AppDatabase(restartPath);
  try {
    const restoredProject = new ProjectRepository(afterRestart.connection).get(restartProject.id);
    assert.equal(restoredProject?.instructions, "Persist me");
    assert.equal(afterRestart.getTask("restart-task")?.projectId, restartProject.id);
  } finally {
    afterRestart.connection.close();
  }

  const v1Path = join(root, "version-1.db");
  const v1Database = new AppDatabase(v1Path);
  v1Database.upsertTask({ id: "v1-task", title: "V1 audit", updatedAt: 1 });
  const v1AuditRepository = new RuntimeContextSnapshotRepository(v1Database.connection);
  const v1Audit = v1AuditRepository.record({
    taskId: "v1-task", userMessageId: "v1-u", assistantMessageId: "v1-a",
    status: "completed", startedAt: 1, completedAt: 2, assemblyHash: "v1", mode: "coding",
    resolvedInstructions: [], resolvedCapabilities: [], warnings: [],
  });
  const legacyLongSegment = [{ id: "projectResources", title: "Legacy", source: "project", chars: 20_000, content: "L".repeat(20_000) }];
  v1Database.connection.prepare(
    "UPDATE task_runtime_context_snapshots SET resolved_instructions_json = ?, storage_bytes = 0, schema_version = 2 WHERE id = ?",
  ).run(JSON.stringify(legacyLongSegment), v1Audit.id);
  v1Database.connection.pragma("user_version = 1");
  v1Database.connection.close();
  const v2Database = new AppDatabase(v1Path);
  try {
    assert.equal(v2Database.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(v2Database.getTask("v1-task"), undefined, "incompatible DB task data is intentionally discarded");
    assert.equal(new RuntimeContextSnapshotRepository(v2Database.connection).list("v1-task", 1).length, 0, "incompatible audit rows are intentionally discarded");
    assert.ok(
      (v2Database.connection.pragma("table_info(task_runtime_context_snapshots)") as Array<{ name: string }>).some((column) => column.name === "storage_bytes"),
      "fresh current schema contains audit storage accounting",
    );
  } finally {
    v2Database.connection.close();
  }

  const legacyPath = join(root, "legacy-project-fk.db");
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, instructions TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, space_id TEXT, project_id TEXT, status TEXT,
      updated_at INTEGER NOT NULL, session_file TEXT, cwd TEXT, welcome_mode TEXT, model_id TEXT,
      permission_mode TEXT, archived INTEGER NOT NULL DEFAULT 0, expert_id TEXT,
      mode_preset_id TEXT, context_used_tokens INTEGER, context_window_tokens INTEGER,
      FOREIGN KEY (space_id) REFERENCES spaces(id)
    );
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('legacy-project', 'Legacy', 1, 1);
    INSERT INTO tasks (id, title, project_id, updated_at) VALUES
      ('legacy-valid', 'Valid', 'legacy-project', 1),
      ('legacy-dangling', 'Dangling', 'missing-project', 1);
    CREATE TABLE tasks_project_fk_next (stale TEXT);
  `);
  legacy.close();
  const migrated = new AppDatabase(legacyPath);
  try {
    assert.equal(migrated.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(migrated.getTask("legacy-valid"), undefined, "legacy task data is discarded instead of migrated");
    assert.equal(migrated.getTask("legacy-dangling"), undefined, "legacy dangling task is discarded with the old DB");
    assert.equal(migrated.connection.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(new ProjectRepository(migrated.connection).get("legacy-project"), undefined, "legacy project data is intentionally discarded");
    assert.ok(
      (migrated.connection.pragma("table_info(project_resources)") as Array<{ name: string }>).some((column) => column.name === "sort_order"),
      "current schema includes Project Resource ordering",
    );
    assert.ok(
      (migrated.connection.pragma("table_info(project_resources)") as Array<{ name: string }>).some((column) => column.name === "parent_id"),
      "current schema includes asset folders",
    );
    assert.ok(
      (migrated.connection.pragma("table_info(task_runtime_context_snapshots)") as Array<{ name: string }>).some((column) => column.name === "storage_bytes"),
      "current schema includes audit storage accounting",
    );
    assert.equal(
      (migrated.connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks_project_fk_next'").get() as { count: number }).count,
      0,
      "stale legacy rebuild table is gone because incompatible DB is replaced",
    );
  } finally {
    migrated.connection.close();
  }
  console.log("PASS  Project CRUD/policies and Task binding contract");
} finally {
  db.connection.close();
  rmSync(root, { recursive: true, force: true });
}
