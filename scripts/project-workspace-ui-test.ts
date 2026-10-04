import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyModeProfileResponse,
  collectDroppedLocalFiles,
  dataTransferHasFiles,
  dataTransferHasProjectAssets,
  decodeProjectAssetDrag,
  deriveProjectActivity,
  decideProjectNavigation,
  decideTabSwitchGuard,
  emptyModeTagOptionLabel,
  PROJECT_PRIMARY_TABS,
  PROJECT_WORKSPACE_TAB_HINTS,
  PROJECT_WORKSPACE_TAB_LABELS,
  encodeProjectAssetDrag,
  filterProjectAssets,
  groupProjectPlanTasks,
  movableProjectAssetIds,
  planColumnForStatus,
  PROJECT_ASSET_DRAG_TYPE,
  statusForPlanColumn,
  filterProjectTasks,
  filterProjectsByQuery,
  resolveProjectTaskCrumb,
  formatAssetBytes,
  formatAssetQuota,
  formatRelativeTime,
  projectAssetDisplayKind,
  projectAssetDragIds,
  projectAssetTypeLabel,
  projectAssetsInFolder,
  sortProjectAssets,
  lockProjectTaskCreate,
  matchesArchiveFilter,
  normalizeProjectWorkspaceTab,
  projectActivityAt,
  projectBuddyName,
  projectTaskCount,
  recentProjectTasks,
  resolveProjectLastActivityAt,
  resolveProjectTagLabel,
  resolveUnsavedGuardAction,
  sameProjectFormValue,
  summarizeProjectCapabilities,
  workspaceAfterCreate,
  workspaceAfterProjectRemoved,
} from "../src/renderer/src/lib/projectWorkspace";
import { emptyProjectPolicies } from "../src/shared/project-domain";

const now = Date.UTC(2026, 7, 13, 12, 0, 0);

{
  const projects = [
    { id: "a", name: "Review MyBuddy", description: "代码审查" },
    { id: "b", name: "ERP", description: "Architecture" },
    { id: "c", name: "Archived", description: "old" },
  ];
  assert.deepEqual(
    filterProjectsByQuery(projects, "review").map((item) => item.id),
    ["a"],
    "search matches name",
  );
  assert.deepEqual(
    filterProjectsByQuery(projects, "arch").map((item) => item.id),
    ["b", "c"],
    "search matches description",
  );
  assert.equal(filterProjectsByQuery(projects, "   ").length, 3, "blank query keeps all");
}

{
  assert.equal(matchesArchiveFilter(false, "active"), true);
  assert.equal(matchesArchiveFilter(true, "active"), false);
  assert.equal(matchesArchiveFilter(true, "archived"), true);
  assert.equal(matchesArchiveFilter(undefined, "archived"), false);
}

{
  const tasks = [
    { id: "t1", projectId: "p1", title: "Review MyBuddy", status: "in_progress", updatedAt: 30 },
    { id: "t2", projectId: "p1", title: "ERP Architecture", status: "completed", updatedAt: 20 },
    { id: "t3", projectId: "p1", title: "Old", status: "in_progress", archived: true, updatedAt: 40 },
    { id: "t4", projectId: "p2", title: "Other", status: "in_progress", updatedAt: 50 },
  ];
  assert.equal(projectTaskCount(tasks, "p1"), 3);
  assert.deepEqual(
    filterProjectTasks(tasks, "p1").map((item) => item.id),
    ["t1", "t2"],
    "all hides archived / trashed project tasks",
  );
  assert.deepEqual(filterProjectTasks(tasks, "p1", { status: "active" }).map((item) => item.id), ["t1"]);
  assert.deepEqual(
    filterProjectTasks(tasks, "p1", { status: "done" }).map((item) => item.id),
    ["t2"],
    "done is completed live tasks, not sidebar-archived ones",
  );
  assert.deepEqual(filterProjectTasks(tasks, "p1", { query: "erp" }).map((item) => item.id), ["t2"]);
  assert.deepEqual(recentProjectTasks(tasks, "p1", 1).map((item) => item.id), ["t1"]);
}

{
  assert.equal(resolveProjectTaskCrumb({ taskTitle: "独立任务" }), null);
  assert.equal(resolveProjectTaskCrumb({ projectId: "  ", taskTitle: "空 id" }), null);
  assert.deepEqual(resolveProjectTaskCrumb({ projectId: "p1", projectName: "ERP", taskTitle: "盘点" }), {
    projectId: "p1",
    projectName: "ERP",
    taskTitle: "盘点",
  });
  assert.deepEqual(resolveProjectTaskCrumb({ projectId: "p1" }), {
    projectId: "p1",
    projectName: "项目",
    taskTitle: "任务",
  });
}

{
  assert.equal(projectActivityAt(10, [{ projectId: "p1", updatedAt: 40 }, { projectId: "p2", updatedAt: 90 }], "p1"), 40);
  assert.equal(projectActivityAt(80, [{ projectId: "p1", updatedAt: 40 }], "p1"), 80);
}

{
  assert.equal(
    resolveProjectLastActivityAt({ id: "p1", updatedAt: 10 }, []),
    10,
    "no tasks falls back to project.updatedAt",
  );
  assert.equal(
    resolveProjectLastActivityAt(
      { id: "p1", updatedAt: 10 },
      [
        { projectId: "p1", updatedAt: 40 },
        { projectId: "p1", updatedAt: 25 },
      ],
    ),
    40,
    "max task updatedAt wins",
  );
  assert.equal(
    resolveProjectLastActivityAt(
      { id: "p1", updatedAt: 10 },
      [{ projectId: "p2", updatedAt: 90 }],
    ),
    10,
    "tasks of other projects are not counted",
  );
}

{
  assert.equal(formatRelativeTime(now - 10_000, now), "刚刚");
  assert.equal(formatRelativeTime(now - 60 * 60_000, now), "1 小时前");
  assert.equal(formatRelativeTime(now - 3 * 60 * 60_000, now), "3 小时前");
  assert.equal(formatRelativeTime(now - 26 * 60 * 60_000, now), "昨天");
  assert.equal(formatRelativeTime(Date.UTC(2026, 7, 1, 8, 0, 0), now), "8月1日");
}

{
  const policies = emptyProjectPolicies();
  policies.expert.allow = ["reviewer"];
  policies.expert.recommended = ["reviewer", "designer"];
  policies.skill.prefer = ["code-review"];
  policies.skill.hide = ["pdf"];
  policies.connector.allow = ["github"];
  policies.mcp.allow = ["penpot", "drawio"];
  assert.deepEqual(summarizeProjectCapabilities(policies), {
    experts: 2,
    skills: 2,
    connectors: 1,
    mcp: 2,
  });
}

{
  const locked = lockProjectTaskCreate("proj-1");
  assert.equal(locked.projectId, "proj-1");
  assert.equal(locked.projectLocked, true);
  assert.deepEqual(workspaceAfterCreate("proj-1"), {
    activeProjectId: "proj-1",
    activeProjectTab: "activity",
  });
  assert.equal(workspaceAfterProjectRemoved("proj-1", "proj-1"), null);
  assert.equal(workspaceAfterProjectRemoved("proj-1", "proj-2"), "proj-1");
  assert.equal(workspaceAfterProjectRemoved(null, "proj-1"), null);
}

{
  assert.equal(planColumnForStatus("in_progress"), "doing");
  assert.equal(statusForPlanColumn("done"), "completed");
  const grouped = groupProjectPlanTasks([
    { id: "t1", projectId: "p1", title: "A", status: "pending", updatedAt: 2 },
    { id: "t2", projectId: "p1", title: "B", status: "in_progress", updatedAt: 3 },
    { id: "t3", projectId: "p1", title: "C", status: "completed", updatedAt: 1 },
  ], "p1");
  assert.deepEqual(grouped.todo.map((item) => item.id), ["t1"]);
  assert.deepEqual(grouped.doing.map((item) => item.id), ["t2"]);
  assert.deepEqual(grouped.done.map((item) => item.id), ["t3"]);
  const searched = groupProjectPlanTasks([
    { id: "t1", projectId: "p1", title: "写周报", status: "pending", updatedAt: 2 },
    { id: "t2", projectId: "p1", title: "修 bug", status: "pending", updatedAt: 3 },
  ], "p1", "周报");
  assert.deepEqual(searched.todo.map((item) => item.id), ["t1"]);
  assert.equal(filterProjectAssets([{ title: "指南.pdf", kind: "file" }, { title: "说明", kind: "text" }], { kind: "file" }).length, 1);
  assert.equal(projectAssetTypeLabel("file", "资产库使用指南.pdf"), "PDF");
  assert.equal(projectAssetDisplayKind({ kind: "folder", title: "系统文件" }), "folder");
  assert.equal(formatAssetBytes(877 * 1024).includes("KB"), true);
  assert.ok(formatAssetQuota(1200, 128000).includes("1,200"));
  const nested = [
    { id: "f", title: "系统文件", kind: "folder", updatedAt: 1 },
    { id: "a", title: "指南.pdf", kind: "file", parentId: "f", updatedAt: 2 },
    { id: "b", title: "根目录.md", kind: "text", updatedAt: 3 },
  ];
  assert.deepEqual(projectAssetsInFolder(nested, null).map((item) => item.id), ["f", "b"]);
  assert.deepEqual(filterProjectAssets(nested, { folderId: "f" }).map((item) => item.id), ["a"]);
  assert.deepEqual(sortProjectAssets(nested, { key: "name" }).map((item) => item.id), ["f", "b", "a"]);
  assert.deepEqual(
    collectDroppedLocalFiles(
      [{ name: "指南.pdf", path: "" }, { name: "副本.pdf", path: "C:\\docs\\指南.pdf" }],
      (file) => (file.name === "指南.pdf" ? "C:\\docs\\指南.pdf" : file.path || ""),
    ),
    [{ name: "指南.pdf", path: "C:\\docs\\指南.pdf" }],
  );
  assert.equal(dataTransferHasFiles(["Files", "text/plain"]), true);
  assert.equal(dataTransferHasProjectAssets(["Files"]), false);
  assert.equal(dataTransferHasProjectAssets([PROJECT_ASSET_DRAG_TYPE]), true);
  assert.deepEqual(projectAssetDragIds("a", new Set(["a", "b"])), ["a", "b"]);
  assert.deepEqual(projectAssetDragIds("c", new Set(["a", "b"])), ["c"]);
  assert.deepEqual(decodeProjectAssetDrag(encodeProjectAssetDrag(["a", "a", ""])), ["a"]);
  assert.deepEqual(
    movableProjectAssetIds({ ids: ["b", "a"], targetParentId: "f", resources: nested }),
    ["b"],
  );
  assert.deepEqual(
    movableProjectAssetIds({ ids: ["f"], targetParentId: "f", resources: nested }),
    [],
    "cannot drop a folder onto itself",
  );
  const nestedFolder = [
    ...nested,
    { id: "child", title: "子夹", kind: "folder", parentId: "f", updatedAt: 4 },
  ];
  assert.deepEqual(
    movableProjectAssetIds({ ids: ["f"], targetParentId: "child", resources: nestedFolder }),
    [],
    "cannot drop a folder into its descendant",
  );
  const feed = deriveProjectActivity({
    project: { name: "test", createdAt: 1, updatedAt: 4 },
    tasks: [
      { id: "t1", title: "修复bug", updatedAt: 3, status: "completed" },
      { id: "t-gone", title: "新任务", updatedAt: 9, archived: true },
    ],
    posts: [{ id: "n1", body: "开工", createdAt: 5 }],
    events: [
      { id: "e1", title: "外部消息（alice）", body: "明天上线前确认", source: "gateway", kind: "message", createdAt: 7 },
      { id: "e2", title: "定时任务完成", source: "cron", kind: "run", createdAt: 6 },
    ],
  });
  assert.equal(feed[0]?.kind, "event");
  assert.equal(feed[0]?.actor, "system");
  assert.equal(feed[0]?.title, "外部消息（alice）");
  assert.equal(feed[0]?.detail, "明天上线前确认");
  assert.equal(feed[0]?.id, "event-e1");
  assert.ok(feed.some((item) => item.kind === "event" && item.title === "定时任务完成"), "events 全部进入动态流");
  const postItem = feed.find((item) => item.kind === "post");
  assert.equal(postItem?.actor, "user");
  assert.equal(postItem?.title, "开工");
  assert.equal(feed.some((item) => item.title === "修复bug"), true);
  assert.equal(feed.some((item) => item.title === "新任务"), false, "trashed/archived tasks stay out of activity");
  const welcome = feed.find((item) => item.kind === "welcome");
  assert.ok(welcome, "new project has a welcome post");
  assert.equal(welcome?.actor, "buddy");
  assert.ok(welcome?.title.includes("「test」"), "welcome names the project");
  assert.ok(welcome?.title.includes("MyBuddy"), "welcome speaks as MyBuddy");
  assert.equal(welcome?.title.includes("WorkBuddy"), false, "welcome must not copy WorkBuddy copy");
  assert.equal(projectBuddyName(), "MyBuddy");
  assert.equal(projectBuddyName().includes("WorkBuddy"), false);
  assert.equal(welcome?.title.includes("共同协作的工作台"), false);
}

{
  const saved = { expert: { allow: ["a"], deny: [], recommended: [] } };
  const edited = { expert: { recommended: [], deny: [], allow: ["a"] } };
  assert.equal(sameProjectFormValue(saved, edited), true, "key order does not mark dirty");
  assert.equal(sameProjectFormValue(saved, { expert: { allow: ["b"], deny: [], recommended: [] } }), false);
  assert.equal(sameProjectFormValue({ name: "test", description: "" }, { description: "", name: "test" }), true);
  assert.equal(sameProjectFormValue({ name: "test" }, { name: "test", description: "" }), false);
  const settingsSaved = { name: "test", description: "review", resourceBudgetChars: 128000 };
  assert.equal(sameProjectFormValue(settingsSaved, { ...settingsSaved }), true);
  assert.equal(
    sameProjectFormValue(settingsSaved, { ...settingsSaved, description: "changed" }),
    false,
    "settings description edit is dirty",
  );
}

void (async () => {
  assert.equal(decideProjectNavigation(false), "proceed");
  assert.equal(decideProjectNavigation(true), "prompt");

  /* §7：主 Tab 切换不触发 Rail Guard；Capabilities/Settings 切换仍 Guard */
  assert.equal(decideTabSwitchGuard("activity", { rail: true, pane: false }), false, "rail dirty + primary tab → no guard");
  assert.equal(decideTabSwitchGuard("health", { rail: true, pane: false }), false, "health is a primary tab so rail dirty does not guard");
  assert.equal(decideTabSwitchGuard("plan", { rail: true, pane: false }), false);
  assert.equal(decideTabSwitchGuard("tasks", { rail: true, pane: false }), false);
  assert.equal(decideTabSwitchGuard("assets", { rail: true, pane: false }), false);
  assert.equal(decideTabSwitchGuard("activity", { rail: true, pane: true }), true, "pane dirty + primary tab → guard");
  assert.equal(decideTabSwitchGuard("capabilities", { rail: true, pane: false }), true, "rail dirty + capabilities tab → guard");
  assert.equal(decideTabSwitchGuard("settings", { rail: false, pane: true }), true);
  assert.equal(decideTabSwitchGuard("activity", {}), false, "no dirty → no guard");

  const calls: string[] = [];
  const guard = {
    save: async () => {
      calls.push("save");
    },
    discard: () => {
      calls.push("discard");
    },
  };
  assert.equal(await resolveUnsavedGuardAction("cancel", guard), "stay");
  assert.deepEqual(calls, []);
  assert.equal(await resolveUnsavedGuardAction("discard", guard), "navigate");
  assert.deepEqual(calls, ["discard"]);
  assert.equal(await resolveUnsavedGuardAction("save", guard), "navigate");
  assert.deepEqual(calls, ["discard", "save"]);
  const failing = {
    save: async () => {
      throw new Error("保存失败");
    },
    discard: () => {
      calls.push("discard-fail");
    },
  };
  assert.equal(await resolveUnsavedGuardAction("save", failing), "stay-error");

  console.log("project-workspace-ui-test: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const labels = new Map([["weekly-report", "每周报告"], ["bugfix-test", "修 bug 并自测"]]);
  assert.equal(resolveProjectTagLabel("weekly-report", labels), "每周报告");
  assert.equal(resolveProjectTagLabel("deleted-preset", labels), "已移除的 Tag");
  assert.equal(resolveProjectTagLabel(null, labels), "无 Tag");
  assert.equal(emptyModeTagOptionLabel(), "默认");
}

{
  const lateA = applyModeProfileResponse({
    requestedMode: "working",
    currentMode: "design",
    presets: [{ id: "general-office" }],
    currentPresetId: "general-office",
    fallbackPresetId: "ai-ui",
  });
  assert.equal(lateA.ignore, true, "stale Mode A response is ignored");
  const currentB = applyModeProfileResponse({
    requestedMode: "design",
    currentMode: "design",
    presets: [{ id: "ai-ui" }, { id: "web-prototype" }],
    currentPresetId: "general-office",
    fallbackPresetId: "ai-ui",
  });
  assert.equal(currentB.ignore, false);
  if (!currentB.ignore) assert.equal(currentB.modePresetId, "ai-ui");
}

{
  const legacyContextPath = join(process.cwd(), "src/renderer/src/components/pages/project/ProjectContext.tsx");
  assert.equal(existsSync(legacyContextPath), false, "legacy ProjectContext presentation is removed; materials owns the project context surface");
  const materialsSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectMaterials.tsx"), "utf8");
  assert.ok(materialsSource.includes("ProjectBrief"), "materials owns project brief presentation");
  assert.ok(materialsSource.includes("ProjectExecutionMaterials"), "materials owns execution-material evidence presentation");
  assert.ok(materialsSource.includes("ProjectAssets"), "materials owns supplemental reference presentation");
  assert.ok(materialsSource.includes('aria-label="搜索项目资料"'), "materials exposes one unified project-material search");
  assert.ok(materialsSource.includes("query={query} hideSearch"), "supplemental references consume the shared search instead of exposing a second search box");

  const sidebarSource = readFileSync(join(process.cwd(), "src/renderer/src/components/Sidebar.tsx"), "utf8");
  assert.ok(sidebarSource.includes("requestProjectsRoot"), "sidebar asks to return to project list");

  assert.deepEqual(
    [...PROJECT_PRIMARY_TABS],
    ["activity", "health", "plan", "tasks", "memory", "assets"],
    "health is a primary tab beside overview, not stacked into it",
  );
  assert.equal((PROJECT_PRIMARY_TABS as readonly string[]).includes("library"), false, "project no longer has a library tab");
  assert.equal(PROJECT_WORKSPACE_TAB_LABELS.health, "健康");
  assert.equal(normalizeProjectWorkspaceTab("health"), "health", "health links open the health tab");
  assert.equal(normalizeProjectWorkspaceTab("overview"), "activity", "old overview links land on the activity tab");
  assert.equal(normalizeProjectWorkspaceTab("library"), "assets", "old project library tab lands on assets");
  assert.equal(PROJECT_WORKSPACE_TAB_LABELS.assets, "资料");
  assert.match(PROJECT_WORKSPACE_TAB_HINTS.assets, /项目资料.*常用引用.*补充参考.*实际使用/);

  const planSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectPlan.tsx"), "utf8");
  assert.ok(planSource.includes("listProjectTodos"), "plan loads todos");
  assert.ok(planSource.includes("list"), "plan has list view");
  assert.ok(planSource.includes("gantt"), "plan has gantt view");
  assert.ok(planSource.includes("calendar"), "plan has calendar view");
  assert.ok(planSource.includes("createProjectTodo"), "plan creates todos, not agent tasks");
  assert.ok(planSource.includes("deleteProjectTodo"), "plan can delete todos");
  assert.ok(planSource.includes("ConfirmDialog"), "plan delete uses ConfirmDialog");
  assert.equal(planSource.includes("createProjectPlanTask"), false);
  assert.ok(planSource.includes("planId: todo.id"), "starting a plan item carries its stable plan id into the task draft");
  assert.equal(planSource.includes("onOpenTask"), false, "plan does not open agent tasks");
  assert.equal(planSource.includes("task.modePresetId || \"无 Tag\""), false);

  const activitySource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectActivity.tsx"), "utf8");
  assert.equal(activitySource.includes("ProjectStatusCard"), false, "activity no longer embeds health");
  assert.ok(activitySource.includes('aria-label="项目动态"'), "activity feed is a labeled region");
  assert.ok(activitySource.includes("project-activity-cluster"), "activity toolbar groups chips so they wrap as units");
  assert.equal(
    activitySource.includes('className="project-activity-filter project-activity-filter-label"'),
    false,
    "event label is not a shrinkable filter chip",
  );

  const libraryDocSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/library/LibraryDocumentView.tsx"), "utf8");
  assert.ok(libraryDocSource.includes("ConfirmDialog"), "library delete uses ConfirmDialog");
  assert.equal(libraryDocSource.includes("window.confirm"), false, "library delete no longer uses window.confirm");
  assert.ok(libraryDocSource.includes("library-doc-bar"), "library document uses the compact bar");

  const libraryPageSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/library/LibraryPage.tsx"), "utf8");
  assert.ok(libraryPageSource.includes("library-compose-modal"), "library create uses the app modal");
  assert.ok(libraryPageSource.includes("openCreateItem"), "library create asks for a title first");
  assert.equal(libraryPageSource.includes("library-prompt-mask"), false, "old library prompt overlay is gone");

  const memorySource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectMemory.tsx"), "utf8");
  assert.ok(memorySource.includes("deleteProjectMemory"), "memory can delete items");
  assert.ok(memorySource.includes("ConfirmDialog"), "memory delete uses ConfirmDialog");
  assert.ok(memorySource.includes("project-memory-card"), "memory list uses card layout");
  assert.equal(memorySource.includes("window.confirm"), false, "memory delete no longer uses window.confirm");
  assert.ok(memorySource.includes("只看有效"), "memory can hide superseded/resolved");

  const todoModalSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/NewProjectTodoModal.tsx"), "utf8");
  assert.ok(todoModalSource.includes("onDelete"), "todo modal can delete an existing plan item");
  assert.ok(todoModalSource.includes("删除"), "todo modal exposes a delete action");
  assert.ok(todoModalSource.includes("开始任务"), "an existing plan item can explicitly start an agent task");

  const modalSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/NewProjectTaskModal.tsx"), "utf8");
  assert.ok(modalSource.includes("cancelled"), "mode profile request is cancelled on switch");
  assert.ok(modalSource.includes("emptyModeTagOptionLabel"), "empty tag state is not a raw id");
  assert.ok(modalSource.includes("任务工作目录"), "create modal uses task working-directory product label");
  assert.equal(modalSource.includes(">Space<"), false);

  const projectTasksSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectTasks.tsx"), "utf8");
  assert.equal(projectTasksSource.includes("openWorkspaceDetail"), false, "project task directory badge must not jump into the global Workspace product model");
  assert.ok(projectTasksSource.includes("任务工作目录"), "project task rows present Space as a task working directory");

  const css = readFileSync(join(process.cwd(), "src/renderer/src/styles/global.css"), "utf8");
  assert.ok(css.includes(".project-detail-empty"), "live empty-state style remains");
  assert.equal(css.includes(".project-detail-overlay"), false);
  assert.equal(css.includes(".project-detail-head"), false);
  assert.equal(css.includes("ProjectDetailModal"), false);
  assert.match(
    css,
    /\.project-activity-seg button \{[\s\S]*?white-space:\s*nowrap/,
    "activity filter chips must not wrap CJK character-by-character",
  );
  assert.match(
    css,
    /\.project-activity-cluster \{[\s\S]*?flex-wrap:\s*nowrap/,
    "activity chip clusters stay on one line and wrap as a group",
  );
  assert.match(
    css,
    /\.project-activity-toolbar \{[\s\S]*?flex-wrap:\s*wrap/,
    "activity toolbar wraps whole clusters instead of crushing chips",
  );
  assert.equal(css.includes("project-overview-split"), false, "overview does not steal width for a health column");
  assert.match(
    css,
    /\.project-desk-scroll:has\(> \.project-activity\) \.project-activity-feed \{[\s\S]*?overflow:\s*auto/,
    "overview feed fills the remaining height and scrolls in place",
  );

  const homeCss = readFileSync(join(process.cwd(), "src/renderer/src/styles/project-home.css"), "utf8");
  assert.ok(homeCss.includes(".project-home-grid"), "homepage card grid style exists");
  assert.ok(homeCss.includes(".project-template-grid"), "homepage template grid style exists");

  const listSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectList.tsx"), "utf8");
  assert.ok(listSource.includes("从模板创建"), "homepage keeps template section");
  assert.equal(listSource.includes("projectTaskCount"), false, "homepage card hides task count metadata");
  assert.equal(listSource.includes("recentProjectTasks"), false, "homepage card hides recent-task metadata");

  const cardSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectCard.tsx"), "utf8");
  assert.ok(cardSource.includes("resolveProjectLastActivityAt"), "card time uses the single helper");
  assert.equal(cardSource.includes("projectTaskCount"), false, "card does not render task counts");

  const workspaceSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectWorkspace.tsx"), "utf8");
  assert.ok(workspaceSource.includes('variant="project"'), "project dock composer can pick a tag");
  assert.ok(workspaceSource.includes("sendFromProject"), "project dock navigates to the visible chat stream when sending");
  assert.ok(workspaceSource.includes("resolveProjectTaskDefaults"), "project dock seeds mode/tag from last task");
  assert.ok(workspaceSource.includes('tab === "health"'), "health is its own workspace pane");
  assert.ok(workspaceSource.includes("ProjectStatusCard"), "health tab renders the status card");
  assert.equal(workspaceSource.includes("project-overview-split"), false, "workspace does not split overview into feed + health columns");
  assert.ok(workspaceSource.includes('if (tab === "activity")'), "overview pane is only the activity feed");
  assert.ok(workspaceSource.includes('aria-label="项目健康度"'), "health pane is a labeled region");
  assert.equal(workspaceSource.includes("ProjectLibrary"), false, "project workspace no longer embeds library");
  assert.equal(workspaceSource.includes('tab === "library"'), false, "project workspace has no library pane");

  const appStoreSource = readFileSync(join(process.cwd(), "src/renderer/src/store/appStore.ts"), "utf8");
  assert.equal(appStoreSource.includes("createProjectPlanTask"), false, "dead second task-creation path is removed");
  assert.equal(appStoreSource.includes("setTaskSchedule"), false, "dead Task-to-Plan scheduling helper is removed");
  assert.ok(appStoreSource.includes('relation: "CONTAINS"'), "materialized plan task records Plan CONTAINS Task");

  const chatInputSource = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
  assert.ok(chatInputSource.includes("TagPicker"), "project composer exposes TagPicker");
  assert.ok(chatInputSource.includes("ModePicker"), "project composer exposes ModePicker");

  const tagPickerSource = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/TagPicker.tsx"), "utf8");
  assert.ok(tagPickerSource.includes("setModePreset"), "tag picker writes the same preset sendMessage uses");

  const assetsSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectAssets.tsx"), "utf8");
  assert.equal(assetsSource.includes('setPage("library")'), false, "project materials stay within the project");
  assert.ok(assetsSource.includes("新建文件夹"), "assets can create folders");
  assert.ok(assetsSource.includes("formatAssetBytes"), "assets show file size");
  assert.ok(assetsSource.includes("更新人"), "assets table has updater");
  assert.ok(assetsSource.includes("拖入文件"), "assets empty state mentions drag-in");
  assert.ok(assetsSource.includes("onDrop"), "assets pane accepts file drops");
  assert.ok(assetsSource.includes("draggable"), "asset rows can be dragged into folders");
  assert.equal(assetsSource.includes("升级"), false, "assets must not clone cloud upgrade");

  const tasksSource = readFileSync(join(process.cwd(), "src/renderer/src/components/pages/project/ProjectTasks.tsx"), "utf8");
  assert.ok(tasksSource.includes("搜索任务"), "project tasks tab has search");
  assert.ok(tasksSource.includes("query"), "project tasks search is wired");
  assert.ok(tasksSource.includes("project-task-mark"), "project tasks show a project mark");

  const chatSource = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatView.tsx"), "utf8");
  assert.ok(chatSource.includes("ChatProjectCrumb"), "project-bound chat shows a project crumb");

  const crumbSource = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatProjectCrumb.tsx"), "utf8");
  assert.ok(crumbSource.includes("openProjectDetails"), "crumb returns to the project");
  assert.ok(crumbSource.includes("requestProjectsRoot"), "crumb 项目 goes to the project list");

  const taskItemSource = readFileSync(join(process.cwd(), "src/renderer/src/components/sidebar/TaskItem.tsx"), "utf8");
  assert.ok(taskItemSource.includes("task-project-mark"), "sidebar marks project-bound tasks");
}
