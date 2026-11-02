import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relative: string): string => readFileSync(join(process.cwd(), relative), "utf8");
const create = read("src/renderer/src/components/pages/NewProjectModal.tsx");
const materials = read("src/renderer/src/components/pages/project/ProjectMaterials.tsx");
const taskModal = read("src/renderer/src/components/pages/project/NewProjectTaskModal.tsx");
const tasks = read("src/renderer/src/components/pages/project/ProjectTasks.tsx");
const execution = read("src/renderer/src/components/pages/project/ProjectExecutionMaterials.tsx");
const recovery = read("src/renderer/src/components/chat/TaskRecoveryNotice.tsx");
const relocation = read("src/renderer/src/components/pages/project/ProjectFolderRelocation.tsx");

const dailyFlows = [
  { name: "create-project", source: create, checks: ["项目工作目录", "ensureSpaceFromPath", "activate: false"] },
  { name: "import-and-search-materials", source: materials, checks: ["搜索全部项目资料", "项目资料", "补充参考", "常用资料"] },
  { name: "start-project-task", source: taskModal, checks: ["任务工作目录", "startProjectTask", "项目"] },
  { name: "inspect-execution-materials", source: execution, checks: ["本次实际使用资料", "listRuntimeContextSnapshots", "实际执行目录"] },
  { name: "recover-moved-folder", source: relocation, checks: ["重新关联", "previewProjectFolder", "commitProjectFolder"] },
  { name: "recover-task-in-project", source: recovery, checks: ["任务恢复", "打开项目资料", "listExecutionFailures"] },
];
for (const flow of dailyFlows) {
  for (const token of flow.checks) assert.ok(flow.source.includes(token), `${flow.name}: missing ${token}`);
  assert.equal(flow.source.includes("SettingsModal"), false, `${flow.name}: daily project flow must not require global Settings`);
}
assert.ok(dailyFlows.length >= 5);
assert.equal(dailyFlows.filter((flow) => !flow.source.includes("SettingsModal")).length / dailyFlows.length >= 0.8, true, "at least 80% representative daily flows avoid global Settings");
assert.equal(tasks.includes("openWorkspaceDetail"), false, "Project task working-directory badge must not jump into global Workspace Detail");
assert.ok(tasks.includes("任务工作目录"));
// Project identity, folder relocation, and runtime snapshots are covered by
// project-binding-matrix, project-folder-relocation, and project-agent-integration.
console.log(`project convergence acceptance: PASS (${dailyFlows.length}/${dailyFlows.length} representative daily flows stay inside Project UI)`);