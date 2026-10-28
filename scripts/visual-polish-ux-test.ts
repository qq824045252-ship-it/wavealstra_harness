import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const contains = (path: string, value: string, message: string): void => assert.ok(source(path).includes(value), message);
const excludes = (path: string, value: string, message: string): void => assert.ok(!source(path).includes(value), message);

const globalCssPath = "src/renderer/src/styles/global.css";
const libraryCssPath = "src/renderer/src/styles/library.css";
const sidebarPath = "src/renderer/src/components/Sidebar.tsx";
const chatViewPath = "src/renderer/src/components/chat/ChatView.tsx";
const globalCss = source(globalCssPath);
const sidebar = source(sidebarPath);
const chatView = source(chatViewPath);

const walkCss = (directory: string): string[] =>
  readdirSync(resolve(process.cwd(), directory), { withFileTypes: true }).flatMap((entry) => {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walkCss(child);
    return entry.isFile() && entry.name.endsWith(".css") ? [child] : [];
  });

for (const token of [
  "--surface-app",
  "--surface-sidebar",
  "--surface-main",
  "--surface-right",
  "--surface-elevated",
  "--surface-input",
  "--surface-hover",
  "--surface-active",
  "--border-subtle",
  "--border-default",
  "--border-strong",
  "--focus-ring",
  "--radius-sm: 8px",
  "--radius-md: 12px",
  "--radius-lg: 16px",
  "--motion-fast: 120ms",
  "--motion-ui: 160ms",
  "--motion-panel: 200ms",
]) {
  assert.ok(globalCss.includes(token), `global polish token missing: ${token}`);
}

contains(globalCssPath, 'html[data-theme="light"]', "light theme must retain explicit semantic surfaces");
contains(globalCssPath, 'html[data-theme="dark"]', "dark theme must retain explicit semantic surfaces");
for (const cssPath of walkCss("src/renderer/src")) {
  assert.doesNotMatch(source(cssPath), /transition\s*:\s*all\b/i, `${cssPath} must not animate every property`);
}
contains(globalCssPath, "prefers-reduced-motion: reduce", "motion must respect the OS reduced-motion preference");
excludes(globalCssPath, ".native-scrollbar,", "unused legacy 12px native scrollbar rules must not return");
contains(globalCssPath, ".message-scroll::-webkit-scrollbar-button", "conversation scrollbars must remove native arrow buttons");
contains(globalCssPath, "display: none;", "scrollbar arrow override must remain explicit");

assert.equal((sidebar.match(/className="sidebar-cta-btn"/g) ?? []).length, 1, "sidebar must expose exactly one large primary CTA");
contains(sidebarPath, "sidebar-section-add", "workspace creation must remain available as a compact tree-header action");
contains(sidebarPath, "workspaceTaskCount", "workspace section count must reflect the number of tasks inside workspaces");
contains(sidebarPath, "independentTaskCount", "independent section count must reflect the number of independent tasks");
excludes(sidebarPath, "rootWorkspaceCount", "workspace section count must count tasks, not top-level spaces");
excludes(sidebarPath, "spaces.filter((item) => !item.effectiveArchived).length", "workspace section count must not count spaces");
contains(sidebarPath, "CreateWorkspaceDialog", "workspace creation must keep the existing dialog flow");
excludes(sidebarPath, "sidebar-cta-btn--secondary", "workspace creation must not return as a second large CTA");
contains(globalCssPath, "mask-image: linear-gradient", "collapsed user bubbles must fade with a mask, not a mismatched overlay");
contains(globalCssPath, ".sidebar .task-item", "real task rows must use the shared compact radius and state language");
contains(globalCssPath, ".sidebar .space-header.space-active", "real workspace rows must use the shared active surface");

for (const marker of ["WorkspaceCrumb", "RuntimeStatusChips", "<ChatInput", "chat-expert-chip-label"]) {
  contains(chatViewPath, marker, `chat header/composer capability missing: ${marker}`);
}
contains(
  "src/renderer/src/components/chat/ConversationGoalChip.tsx",
  '{goal ? goal.title : "Goal"}',
  "Goal chip empty label must be Goal",
);
excludes(
  "src/renderer/src/components/chat/ConversationGoalChip.tsx",
  "设定 Goal",
  "Goal chip must not keep the 设定 Goal prefix",
);
contains(
  globalCssPath,
  ".chat-column.task-ambient .conversation-goal-chip",
  "Goal/Todo chips must inherit the scene-mode tint used by 代码开发",
);
contains(globalCssPath, "var(--hero-mode) 14%", "Goal/Todo and mode chips must share the scene-mode fill");
assert.ok(
  chatView.indexOf("<ChatProjectCrumb") < chatView.indexOf("<WorkspaceCrumb") &&
    chatView.indexOf("<WorkspaceCrumb") < chatView.indexOf('className="chat-header-title"'),
  "chat location order must be Project / Workspace / Task title",
);
contains("src/renderer/src/components/chat/ExecutionTimeline.tsx", "<span>Thinking</span>", "thinking must use the calm product label");
contains("src/renderer/src/components/chat/ToolCallCard.tsx", "tool-row--${toolCall.status}", "tool rows must expose visual state classes");
contains("src/renderer/src/components/chat/ToolCallCard.tsx", "aria-expanded={open}", "tool disclosure must expose its expanded state");
contains("src/renderer/src/components/chat/ToolCallCard.tsx", "IconCheck", "completed tools must expose a clear completion glyph");

contains("src/renderer/src/components/artifact/OverviewView.tsx", "RuntimeObservatory", "right-panel runtime observatory must be preserved");
contains("src/renderer/src/components/artifact/ArtifactPanel.tsx", "ExtensionTopBar", "right-panel topbar architecture must be preserved");
contains(globalCssPath, ".extension-top-bar", "right-panel topbar must use the converged secondary surface");
contains(globalCssPath, ".extension-artifact-item.active", "right-panel artifact selection must use the converged active state");
contains(globalCssPath, ".approval-bar", "tool approval must retain a prominent warning surface");
assert.match(globalCss, /\.artifact-panel\s*\{[^}]*\bborder-left:\s*0\s*;/s, "right panel boundary must have one visual owner");
for (const tab of ["概览", "上下文", "资料库", "文件", "Gadgets"]) {
  contains("src/renderer/src/components/workspace/WorkspaceDetail.tsx", tab, `workspace IA must retain ${tab}`);
}

for (const marker of ["var(--surface-main)", "var(--surface-sidebar)", "var(--surface-input)", "var(--surface-elevated)"]) {
  contains(libraryCssPath, marker, `Library must use shared semantic surface ${marker}`);
}

for (const marker of [
  ".project-task-table",
  ".settings-section-card",
  ".account-popup",
  ".input-popup",
  ".full-access-dialog",
  ".auto-toast",
]) {
  contains(globalCssPath, marker, `global consistency primitive missing: ${marker}`);
}

contains(globalCssPath, "grid-template-rows: minmax(0, 1fr)", "models provider layout must bound its grid row");
contains("src/renderer/src/components/settings/SettingsModal.tsx", "useBlockNativeSurfaces(true)", "settings modal must hide native WebContentsViews");

contains(
  "src/renderer/src/components/settings/SettingsModal.tsx",
  '{ id: "remote", icon: IconShare, label: "远程连接" }',
  "remote access must be a first-class settings tab",
);
contains(
  "src/renderer/src/components/settings/SettingsModal.tsx",
  '{tab === "remote" && <RemoteAccessTab />}',
  "remote settings tab must render its dedicated surface",
);
excludes(
  "src/renderer/src/components/settings/SettingsModal.tsx",
  'title="Android / Mobile Remote"',
  "legacy remote-access block must not return to SecurityTab",
);
contains(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  'className="remote-panel"',
  "remote page must keep its structured panels",
);
contains(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  "允许新设备接入",
  "desktop pairing entry must stay one click away",
);
contains(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  "remote-pair-code",
  "the one-time 6 digit code must be rendered for the phone to type",
);
contains(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  "tailscale serve --bg",
  "Tailscale Serve command must stay documented where the address is configured",
);
excludes(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  "USB 数据线",
  "USB/ADB pairing was retired: Android pairs with address + one-time code",
);
excludes(
  "src/renderer/src/components/settings/RemoteAccessTab.tsx",
  "bindMode",
  "LAN bind-mode switching was retired: the service only listens on loopback",
);

console.log("visual-polish-ux-test: ok");
