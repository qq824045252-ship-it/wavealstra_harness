import {
  IconBarChart, IconBook, IconClock, IconKanban, IconFile, IconFolderKanban, IconGrid,
  IconConversation, IconPuzzle, IconSettings,
} from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import type { Page } from "@/types";

const MODULES = [
  { page: "chat", label: "对话", icon: IconConversation },
  { page: "task-board", label: "任务看板", icon: IconKanban },
  { page: "library", label: "笔记", icon: IconBook },
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

export default function DesktopModuleMenu({ onNavigate, onSettings }: {
  onNavigate: (page: Page) => void;
  onSettings: () => void;
}): React.JSX.Element {
  const page = useAppStore(s => s.page);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const selected = settingsOpen ? null : primaryModule(page);
  return <>
    {MODULES.map(({ page: destination, label, icon: Icon }) => (
      <button key={destination} type="button" className="desktop-section-row"
        aria-current={selected === destination ? "page" : undefined} onClick={() => onNavigate(destination)}>
        <Icon size={16} fill={destination === "chat" && selected === destination ? "currentColor" : "none"} />
        {label}
      </button>
    ))}
    <button type="button" className="desktop-section-row" aria-current={selected === "usage" ? "page" : undefined}
      onClick={() => onNavigate("usage")}><IconBarChart size={16} /> 用量统计</button>
    <button type="button" className="desktop-section-row" aria-current={settingsOpen ? "page" : undefined}
      onClick={onSettings}><IconSettings size={16} /> 设置</button>
  </>;
}
