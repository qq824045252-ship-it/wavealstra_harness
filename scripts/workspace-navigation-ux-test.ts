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

contains("src/renderer/src/components/Sidebar.tsx", ">WORK<", "sidebar must expose WORK hierarchy");
contains("src/renderer/src/components/Sidebar.tsx", ">WORKSPACES<", "sidebar must expose WORKSPACES hierarchy");
contains("src/renderer/src/components/Sidebar.tsx", ">RESOURCES<", "sidebar must expose RESOURCES hierarchy");
contains("src/renderer/src/components/Sidebar.tsx", "CreateWorkspaceDialog", "new workspace must use the creation flow");
contains("src/renderer/src/components/workspace/CreateWorkspaceDialog.tsx", "From Blueprint", "creation flow must offer Blueprint");
contains("src/renderer/src/components/workspace/WorkspaceDetail.tsx", "Save as Blueprint", "workspace menu must expose Blueprint capture");
for (const label of ["Overview", "Context", "Library", "Files", "Gadgets", "Active Work", "Recent Artifacts"]) contains("src/renderer/src/components/workspace/WorkspaceDetail.tsx", label, `workspace UI must include ${label}`);

contains("src/renderer/src/components/gadget/GadgetSection.tsx", "Save to Workspace", "task Gadget must save to workspace");
contains("src/renderer/src/components/gadget/GadgetSection.tsx", "Save to My Gadgets", "task Gadget must save to My Gadgets");
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
