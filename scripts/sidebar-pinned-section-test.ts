import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Sidebar from "../src/renderer/src/components/Sidebar";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { Space, Task } from "../src/renderer/src/types";

const now = Date.now();
const task = (partial: Pick<Task, "id" | "title" | "spaceId" | "isFavorited">): Task => ({
  ...partial,
  updatedAt: now,
  messages: [],
  spaceSortOrder: 1000,
});

const space: Space = { id: "sp-1", name: "财务", parentId: null, sortOrder: 1000, createdAt: 1 };

// renderToStaticMarkup reads Zustand's initial snapshot, not later setState.
const initial = useAppStore.getInitialState();
initial.page = "chat";
initial.expandedSpaceIds = ["sp-1"];
initial.taskFilterStatus = "all";
initial.taskFilterTime = "all";
initial.pinnedTaskIds = [];
initial.spaces = [space];
initial.tasks = [
  task({ id: "pin-root", title: "了解财务软件选项", isFavorited: true }),
  task({ id: "plain", title: "普通独立任务", isFavorited: false }),
  task({ id: "pin-space", title: "空间里的置顶", spaceId: "sp-1", isFavorited: true }),
  task({ id: "space-plain", title: "空间里的普通任务", spaceId: "sp-1", isFavorited: false }),
];

const html = renderToStaticMarkup(createElement(Sidebar));
const pinnedStart = html.indexOf('<div class="sidebar-pinned">');
const independentStart = html.indexOf("独立任务");
assert.ok(pinnedStart >= 0 && pinnedStart < independentStart);
const pinned = html.slice(pinnedStart, independentStart);
assert.match(pinned, /置顶 \(2\)/);
assert.match(pinned, /了解财务软件选项/);
assert.match(pinned, /空间里的置顶/);
assert.doesNotMatch(pinned, /普通独立任务|空间里的普通任务/);
const titleRows = (markup: string, title: string): number =>
  markup.split(`class="task-item-title">${title}`).length - 1;
assert.equal(titleRows(html, "了解财务软件选项"), 1);
assert.equal(titleRows(html, "空间里的置顶"), 1);
assert.equal(titleRows(html, "普通独立任务"), 1);
assert.equal(titleRows(html, "空间里的普通任务"), 1);
assert.match(html, /独立任务<\/span><span class="sidebar-section-count">1<\/span>/);
assert.match(html, /工作空间<\/span><span class="sidebar-section-count">1<\/span>/);
assert.ok(html.indexOf("了解财务软件选项") < html.indexOf("普通独立任务"));
assert.match(html, /财务/);
const workspaceStart = html.indexOf("工作空间");
const workspaceHtml = html.slice(workspaceStart);
assert.match(workspaceHtml, /空间里的普通任务/);
assert.doesNotMatch(workspaceHtml, /空间里的置顶/);

initial.tasks = [];
initial.spaces = [];
initial.expandedSpaceIds = [];
const empty = renderToStaticMarkup(createElement(Sidebar));
assert.doesNotMatch(empty, /置顶 \(/);
assert.match(empty, /暂无独立任务/);

console.log("sidebar-pinned-section-test: ok");
