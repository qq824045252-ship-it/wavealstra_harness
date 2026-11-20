import {
  IconBarChart, IconBook, IconClock, IconFile, IconFolderKanban, IconGrid,
  IconConversation, IconPanel, IconPuzzle, IconSettings, IconSparkles,
} from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import type { Page } from "@/types";
import DesktopNotifications from "./DesktopNotifications";

const MODULES = [
  { page: "chat", label: "MyBuddy", icon: IconConversation },
  { page: "library", label: "笔记", icon: IconBook },
  { page: "assistant", label: "助手", icon: IconSparkles },
  { page: "projects", label: "项目", icon: IconFolderKanban },
  { page: "automation", label: "自动化", icon: IconClock },
  { page: "experts", label: "扩展", icon: IconPuzzle },
  { page: "gadgets", label: "工作台", icon: IconGrid },
  { page: "files", label: "任务成果", icon: IconFile },
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
        <IconPanel size={16} />
      </button>
    )}
    <div className="desktop-rail-modules">
      {MODULES.map(({ page: destination, label, icon: Icon }) => (
        <button key={destination} type="button" className="desktop-rail-module" title={label} aria-label={label}
          aria-current={selected === destination ? "page" : undefined} onClick={() => onNavigate(destination)}>
          <Icon size={19} fill={destination === "chat" && selected === destination ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
    <div className="desktop-rail-footer">
      <button type="button" className="desktop-rail-icon" title="用量统计" aria-label="用量统计"
        aria-current={selected === "usage" ? "page" : undefined} onClick={() => onNavigate("usage")}><IconBarChart size={17} /></button>
      <DesktopNotifications onOpen={() => onNavigate("notifications")} />
      <button type="button" className="desktop-rail-icon" title="设置" aria-label="设置" aria-current={settingsOpen ? "page" : undefined} onClick={onSettings}><IconSettings size={16} /></button>
    </div>
  </nav>;
}
