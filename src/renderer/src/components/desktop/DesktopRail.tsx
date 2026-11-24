import { UiIcon } from "@mybuddy/shared/icons";
import { useAppStore } from "@/store/appStore";
import type { Page } from "@/types";
import DesktopNotifications from "./DesktopNotifications";

const MODULES = [
  { page: "chat", label: "MyBuddy", glyph: "conversation" },
  { page: "task-board", label: "任务看板", glyph: "task-board-compact" },
  { page: "library", label: "笔记", glyph: "notes" },
  { page: "projects", label: "项目", glyph: "projects" },
  { page: "automation", label: "自动化", glyph: "automation" },
  { page: "experts", label: "扩展", glyph: "extensions" },
  { page: "gadgets", label: "工作台", glyph: "workbench" },
  { page: "files", label: "任务成果", glyph: "task-results" },
] as const;

export function isTaskPage(page: Page): boolean {
  return page === "chat" || page === "workspace";
}

export function isExtensionsPage(page: Page): page is "experts" | "skills" | "mcp" | "connectors" {
  return page === "experts" || page === "skills" || page === "mcp" || page === "connectors";
}

function primaryModule(page: Page): Page {
  if (isTaskPage(page)) return "chat";
  if (isExtensionsPage(page)) return "experts";
  return page;
}

export default function DesktopRail({ onNavigate, onSettings }: {
  onNavigate: (page: Page) => void;
  onSettings: () => void;
}): React.JSX.Element {
  const page = useAppStore(s => s.page);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const selected = settingsOpen ? null : primaryModule(page);
  return <nav className="desktop-rail" aria-label="主导航">
      {sidebarCollapsed && (page !== "notifications" || settingsOpen) && (
      <button type="button" className="desktop-rail-icon" title="展开模块列表" aria-label="展开模块列表"
        aria-controls="desktop-module-list" aria-expanded={false} onClick={toggleSidebar}>
        <UiIcon name="panel-left" size={16} />
      </button>
    )}
    <div className="desktop-rail-modules">
      {MODULES.map(({ page: destination, label, glyph }) => (
        <button key={destination} type="button" className="desktop-rail-module" title={label} aria-label={label}
          aria-current={selected === destination ? "page" : undefined} onClick={() => onNavigate(destination)}>
          <UiIcon name={glyph} size={19} accent={selected !== destination} />
        </button>
      ))}
    </div>
    <div className="desktop-rail-footer">
      <DesktopNotifications onOpen={() => onNavigate("notifications")} />
      <button type="button" className="desktop-rail-icon" title="用量统计" aria-label="用量统计"
        aria-current={selected === "usage" ? "page" : undefined} onClick={() => onNavigate("usage")}><UiIcon name="usage" size={17} accent={selected !== "usage"} /></button>
      <button type="button" className="desktop-rail-icon" title="设置" aria-label="设置" aria-current={settingsOpen ? "page" : undefined} onClick={onSettings}><UiIcon name="settings" size={16} accent={!settingsOpen} /></button>
    </div>
  </nav>;
}
