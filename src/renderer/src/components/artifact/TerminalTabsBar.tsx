import type React from "react";
import { useActiveTerminalTabs, useAppStore } from "@/store/appStore";
import type { TerminalSurface } from "@/store/app/types";
import { IconPlus, IconTerminal, IconX } from "@/components/common/icons";

export default function TerminalTabsBar({ surface = "panel" }: { surface?: TerminalSurface }): React.JSX.Element {
  const { tabs: terminalTabs, activeId: activeTerminalTabId } = useActiveTerminalTabs(surface);
  const createTerminalTab = useAppStore((s) => s.createTerminalTab);
  const closeTerminalTab = useAppStore((s) => s.closeTerminalTab);
  const setActiveTerminalTabId = useAppStore((s) => s.setActiveTerminalTabId);

  return (
    <div className="extension-terminal-subbar">
      <div className="extension-terminal-tabs">
        {terminalTabs.map((tab) => (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            className={`extension-terminal-tab ${activeTerminalTabId === tab.id ? "active" : ""}`}
            onClick={() => setActiveTerminalTabId(tab.id, surface)}
            onKeyDown={(e) => e.key === "Enter" && setActiveTerminalTabId(tab.id, surface)}
            title={tab.title}
          >
            <IconTerminal size={12} className="terminal-tab-icon" />
            <span className="terminal-tab-title">{tab.title}</span>
            <button
              type="button"
              className="terminal-tab-close"
              title="关闭终端"
              onClick={(e) => {
                e.stopPropagation();
                closeTerminalTab(tab.id, surface);
              }}
            >
              <IconX size={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="extension-tab-add-btn"
          title="新建终端"
          onClick={() => createTerminalTab(surface)}
        >
          <IconPlus size={12} />
          <span>新建终端</span>
        </button>
      </div>
    </div>
  );
}
