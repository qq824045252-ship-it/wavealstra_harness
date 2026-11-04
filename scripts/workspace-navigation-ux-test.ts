import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blueprintSummaryParts, summarizeBlueprintDefinition } from "../src/renderer/src/lib/blueprintUi";

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const contains = (path: string, value: string, message: string): void => assert.ok(source(path).includes(value), message);
const excludes = (path: string, value: string, message: string): void => assert.ok(!source(path).includes(value), message);

const summary = summarizeBlueprintDefinition({
  schemaVersion: 1,
  kind: "composite",
  workspace: {
    key: "root", name: "Root", defaultContext: "method", files: [{ path: "README.md", content: "seed" }],
    tasks: [{ key: "task", title: "Start here" }], gadgets: [],
    children: [{ key: "child", name: "Child", gadgets: [{ key: "g", name: "Tool", manifest: { schemaVersion: 1, name: "Tool", type: "web", entry: "index.html" }, sourceFiles: [] }] }],
  },
  gadgets: [{ key: "global", name: "Global", manifest: { schemaVersion: 1, name: "Global", type: "web", entry: "index.html" }, sourceFiles: [] }],
});
assert.deepEqual(summary, { workspaces: 2, tasks: 1, gadgets: 2, files: 1, hasContext: true });
assert.deepEqual(blueprintSummaryParts({ schemaVersion: 1, kind: "workspace", workspace: { key: "root", name: "Root" } }), ["1 个工作空间"]);

// Sidebar 现行分区标题为中文（独立任务 / 工作空间），并复用 buildWorkspaceTree 渲染层级；
// 旧的 >WORK< / >WORKSPACES< / >RESOURCES< 英文标签在现行 UI 中不存在（RESOURCES 概念已移除）。
contains("src/renderer/src/components/Sidebar.tsx", "独立任务", "sidebar must expose the standalone-task section");
contains("src/renderer/src/components/Sidebar.tsx", "工作空间", "sidebar must expose the workspace section");
contains("src/renderer/src/components/Sidebar.tsx", "buildWorkspaceTree", "sidebar must render the workspace tree hierarchy");
contains("src/renderer/src/components/Sidebar.tsx", "CreateWorkspaceDialog", "new workspace must use the creation flow");
contains("src/renderer/src/components/workspace/CreateWorkspaceDialog.tsx", "从 Blueprint 创建", "creation flow must offer Blueprint");
contains("src/renderer/src/components/workspace/WorkspaceDetail.tsx", "保存为 Blueprint", "workspace menu must expose Blueprint capture");
// WorkspaceDetail 的分区标签现由 TAB_LABELS 提供（中文 + Gadgets）；旧断言的
// Overview/Context/Library/Files/Active Work/Recent Artifacts 只在 CSS 类名里出现，
// 或（Active Work / Recent Artifacts）已被移除。改为断言现行的全部页签标签。
for (const label of ["概览", "记忆", "上下文", "资料", "文件", "Gadgets", "终端"]) contains("src/renderer/src/components/workspace/WorkspaceDetail.tsx", label, `workspace UI must include ${label}`);

contains("src/renderer/src/components/gadget/GadgetSection.tsx", "保存到工作空间", "task Gadget must expose the localized save-to-workspace action");
contains("src/renderer/src/components/gadget/GadgetSection.tsx", "保存到我的工作台", "task Gadget must expose the localized personal-workbench action");
contains("src/renderer/src/components/gadget/GadgetSection.tsx", 'setMoveItem({ item, initialTarget: "workspace" })', "workspace save must open the workspace target picker");
contains("src/renderer/src/components/gadget/GadgetSection.tsx", 'moveScope({ gadgetId: item.id, scope: { type: "global" } })', "personal-workbench save must preserve the global Gadget scope");
excludes("src/renderer/src/components/gadget/GadgetSection.tsx", "window.prompt(\"目标", "Gadget move must not request a raw target id");
contains("src/renderer/src/components/gadget/GadgetMoveDialog.tsx", "WorkspacePicker", "Gadget move must reuse WorkspacePicker");
contains("src/renderer/src/components/chat/WorkspacePicker.tsx", "effectiveArchived", "WorkspacePicker must filter effective-archived targets");

for (const path of ["src/renderer/src/components/blueprint/BlueprintCaptureDialog.tsx", "src/renderer/src/components/blueprint/BlueprintLibrary.tsx"]) {
  excludes(path, "JSON.stringify", "Blueprint UI must not expose raw definition JSON");
  excludes(path, "schemaVersion", "Blueprint UI must not expose schema details");
}
contains("src/main/gadget/GadgetService.ts", "workspaceEffectiveArchived", "Main must reject archived Gadget workspace targets");
excludes("src/shared/blueprint-types.ts", "targetRootPath", "Renderer Blueprint IPC must not select an arbitrary filesystem target");
excludes("src/main/blueprint/BlueprintService.ts", "request.targetRootPath", "Blueprint materialization must stay in the Main-owned instances root");
contains("src/main/blueprint/BlueprintService.ts", "workspaceInstancesRoot, `bp-${randomUUID()}`", "Blueprint instances must use a Main-owned unique root");
contains("src/main/blueprint/BlueprintService.ts", "reconcileWorkspaceInstances", "Blueprint startup must reconcile crash-window orphan roots");

console.log("workspace-navigation-ux-test: ok");
