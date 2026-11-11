import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentTerminalOwnerKey } from "../src/renderer/src/store/app/selectors";

// 工作空间详情页的终端和扩展栏（侧栏）终端必须是两套独立的标签/会话。
const workspacePage = { page: "workspace", activeWorkspaceId: "ws1", activeTaskId: null };
assert.equal(currentTerminalOwnerKey(workspacePage, "workspace"), "workspace:ws:ws1");
assert.equal(currentTerminalOwnerKey(workspacePage, "panel"), "ws:ws1");
assert.equal(currentTerminalOwnerKey({ page: "chat", activeTaskId: "t1" }, "workspace"), "workspace:task:t1");
assert.equal(currentTerminalOwnerKey({ page: "chat", activeTaskId: "t1" }, "panel"), "task:t1");
assert.equal(currentTerminalOwnerKey({}, "panel"), "default");
assert.notEqual(currentTerminalOwnerKey(workspacePage, "workspace"), currentTerminalOwnerKey(workspacePage, "panel"),
  "workspace surface must not share the panel owner key");

// 渲染侧必须显式把工作空间终端标成 workspace；扩展栏保持默认 panel。
const workspaceDetail = readFileSync("src/renderer/src/components/workspace/WorkspaceDetail.tsx", "utf8");
assert.match(workspaceDetail, /<TerminalTabsBar surface="workspace" \/>/);
assert.match(workspaceDetail, /<TerminalView surface="workspace" \/>/);
const extensionTopBar = readFileSync("src/renderer/src/components/artifact/ExtensionTopBar.tsx", "utf8");
assert.match(extensionTopBar, /<TerminalTabsBar \/>/);
const artifactPanel = readFileSync("src/renderer/src/components/artifact/ArtifactPanel.tsx", "utf8");
assert.match(artifactPanel, /<TerminalView \/>/);

console.log("PASS terminal surfaces: workspace detail and panel keep independent tab/session owners");
