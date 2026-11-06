/**
 * task-delete-panel-regression-test.ts — Problem One：删除对话后 Task 级扩展态必须原子收口。
 *
 * 覆盖（方案 3.5）：
 * 1. 删除当前 Task → panelOpen=false。
 * 2. 删除当前 Task → artifactTabs 清空。
 * 3. 删除当前 Task → flyout/menu/pinned 均关闭。
 * 4. 删除当前 Task → 展开面板前的 sidebar 状态得到恢复（不能只置 null 丢了原值）。
 * 5. 删除当前 Task → 只清掉它自己的 browserUrlByTask key，并清空 browserUrlInput。
 * 6. 删除非当前 Task → 不关闭当前 Task 正在使用的右栏。
 * 7. 删除最后一个 Task → activeTaskId=null，Home Browser key 不误删。
 *
 * 运行：pnpm test:task-delete-panel
 */
import assert from "node:assert/strict";
import { prepareTestEnv, minimalTask, installCloseCounters } from "./test-store-harness";
import { useAppStore } from "../src/renderer/src/store/appStore";

function stateWithClosed(patch: Partial<ReturnType<typeof useAppStore.getState>> = {}): void {
  useAppStore.setState({
    tasks: [],
    activeTaskId: null,
    panelOpen: false,
    panelMode: "file",
    panelExpanded: false,
    artifactTabs: [],
    activeArtifactId: null,
    extensionFlyoutOpen: false,
    extensionFlyoutPinned: false,
    extensionMenuOpen: false,
    sidebarCollapsed: false,
    sidebarBeforePanelExpand: null,
    browserUrlByTask: {},
    browserUrlInput: "",
    chatSelections: [],
    ...patch,
  });
}

async function main(): Promise<void> {
  prepareTestEnv();

  // ---- 1. 删除当前 Task → panelOpen=false ----
  stateWithClosed({
    tasks: [minimalTask("task-a")],
    activeTaskId: "task-a",
    panelOpen: true,
  });
  useAppStore.getState().deleteTask("task-a");
  assert.equal(useAppStore.getState().panelOpen, false, "删除当前任务后右栏必须关闭");
  assert.equal(useAppStore.getState().activeTaskId, null, "删除最后一个任务应回到无任务");

  // ---- 2. 删除当前 Task → artifactTabs 清空 ----
  stateWithClosed({
    tasks: [minimalTask("task-a")],
    activeTaskId: "task-a",
    artifactTabs: ["tab-1"],
    activeArtifactId: "tab-1",
  });
  useAppStore.getState().deleteTask("task-a");
  assert.deepEqual(useAppStore.getState().artifactTabs, [], "artifact tabs 必须清空");
  assert.equal(useAppStore.getState().activeArtifactId, null, "activeArtifactId 必须清空");

  // ---- 3. 删除当前 Task → flyout/menu/pinned 均关闭 ----
  stateWithClosed({
    tasks: [minimalTask("task-a")],
    activeTaskId: "task-a",
    extensionFlyoutOpen: true,
    extensionFlyoutPinned: true,
    extensionMenuOpen: true,
  });
  useAppStore.getState().deleteTask("task-a");
  const s3 = useAppStore.getState();
  assert.equal(s3.extensionFlyoutOpen, false, "flyout 必须关闭");
  assert.equal(s3.extensionFlyoutPinned, false, "flyout pinned 必须关闭");
  assert.equal(s3.extensionMenuOpen, false, "menu 必须关闭");

  // ---- 4. 删除当前 Task → 展开面板前的 sidebar 状态得到恢复 ----
  stateWithClosed({
    tasks: [minimalTask("task-a")],
    activeTaskId: "task-a",
    sidebarCollapsed: true,
    sidebarBeforePanelExpand: false,
    panelOpen: true,
  });
  useAppStore.getState().deleteTask("task-a");
  const s4 = useAppStore.getState();
  assert.equal(
    s4.sidebarCollapsed,
    false,
    "删除当前任务应恢复展开面板前的 sidebarCollapsed，而不是丢弃原值",
  );
  assert.equal(s4.sidebarBeforePanelExpand, null, "sidebarBeforePanelExpand 应复位为 null");

  // ---- 5. 删除当前 Task → 只清掉它自己的 browserUrlByTask key，并清空 browserUrlInput ----
  stateWithClosed({
    tasks: [minimalTask("task-a"), minimalTask("task-b")],
    activeTaskId: "task-a",
    browserUrlByTask: { "task-a": "https://example.com", "task-b": "https://other.dev" },
    browserUrlInput: "https://example.com/path",
  });
  useAppStore.getState().deleteTask("task-a");
  const s5 = useAppStore.getState();
  assert.equal(
    "task-a" in (s5.browserUrlByTask ?? {}),
    false,
    "被删任务的 browserUrlByTask key 必须移除",
  );
  assert.equal(
    s5.browserUrlByTask["task-b"],
    "https://other.dev",
    "其它任务的 browserUrlByTask 不得误删",
  );
  assert.equal(s5.browserUrlInput, "", "browserUrlInput 必须清空");

  // ---- 6. 删除非当前 Task → 不关闭当前 Task 正在使用的右栏 ----
  stateWithClosed({
    tasks: [minimalTask("task-a"), minimalTask("task-b")],
    activeTaskId: "task-b",
    panelOpen: true,
  });
  useAppStore.getState().deleteTask("task-a");
  const s6 = useAppStore.getState();
  assert.equal(useAppStore.getState().activeTaskId, "task-b", "非当前任务删除不应改 activeTaskId");
  assert.equal(s6.panelOpen, true, "删除非当前任务不应关闭当前右栏");

  // ---- 7. 删除最后一个 Task → Home Browser key 不误删 ----
  stateWithClosed({
    tasks: [minimalTask("task-a")],
    activeTaskId: "task-a",
    browserUrlByTask: { home: "https://home.dev" },
  });
  useAppStore.getState().deleteTask("task-a");
  const s7 = useAppStore.getState();
  assert.equal(s7.activeTaskId, null, "删除最后一个任务应回无任务");
  assert.equal(
    s7.browserUrlByTask["home"],
    "https://home.dev",
    "Home Browser key 不应被当成 task key 误删",
  );

  // ---- 8. 原生视图关闭时机：仅删除当前任务时显式 close，且删除非当前任务不得误关 ----
  const counters = installCloseCounters();
  // 先删一个非当前任务：不应触发 close
  stateWithClosed({
    tasks: [minimalTask("task-x"), minimalTask("task-current")],
    activeTaskId: "task-current",
    panelOpen: true,
  });
  useAppStore.getState().deleteTask("task-x");
  assert.equal(
    counters.artifactClose(),
    0,
    "删除非当前任务不得关闭当前右栏的原生 Artifact 视图",
  );
  assert.equal(counters.browserClose(), 0, "删除非当前任务不得关闭当前右栏的原生 Browser 视图");
  // 再删当前任务：artifact/browser 各 close 一次
  useAppStore.getState().deleteTask("task-current");
  assert.equal(
    counters.artifactClose(),
    1,
    "删除当前任务时应显式关闭原生 Artifact 视图一次",
  );
  assert.equal(counters.browserClose(), 1, "删除当前任务时应显式关闭原生 Browser 视图一次");

  // ---- 9. 删除中的旧 runtime 事件不得把任务复活成“新任务” ----
  stateWithClosed({
    tasks: [minimalTask("task-ghost")],
    activeTaskId: "task-ghost",
  });
  useAppStore.getState().deleteTask("task-ghost");
  useAppStore.getState().applyAgentPatch({
    type: "assistant_start",
    taskId: "task-ghost",
    messageId: "late-assistant",
    modelName: "late-model",
  });
  useAppStore.getState().applyAgentPatch({
    type: "user_message",
    taskId: "task-ghost",
    messageId: "late-user",
    text: "late event",
    createdAt: Date.now(),
  });
  assert.equal(
    useAppStore.getState().tasks.some((task) => task.id === "task-ghost"),
    false,
    "删除后的迟到 Agent patch 不得重新合成幽灵任务",
  );

  console.log("task delete panel regression: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
