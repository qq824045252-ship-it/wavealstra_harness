import { useRef } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import type { PanelMode } from "@/store/appStore";
import { useAppStore } from "@/store/appStore";
import type { Artifact } from "@/types";
import { FileBadge } from "@/components/common/FileBadge";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  IconCheck,
  IconExpand,
  IconGlobe,
  IconList,
  IconPanel,
  IconX,
} from "@/components/common/icons";
import ExtensionFlyoutContent from "./ExtensionFlyoutContent";
import { EXTENSION_MODES, EXTENSION_MODE_LABEL } from "./extensionModes";

interface Props {
  tabs: Artifact[];
  activeId: string | undefined;
  onWiden: () => void;
  onOpenTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  wsSearch?: string;
}

export default function ExtensionTopBar({
  tabs,
  activeId,
  onWiden,
  onOpenTab,
  onCloseTab,
  wsSearch = "",
}: Props): React.JSX.Element {
  const panelMode = useAppStore((s) => s.panelMode);
  const extensionView = useAppStore((s) => s.extensionView);
  const extensionFlyoutOpen = useAppStore((s) => s.extensionFlyoutOpen);
  const extensionFlyoutPinned = useAppStore((s) => s.extensionFlyoutPinned);
  const toggleExtensionFlyout = useAppStore((s) => s.toggleExtensionFlyout);
  const closeExtensionFlyout = useAppStore((s) => s.closeExtensionFlyout);
  const closePanel = useAppStore((s) => s.closePanel);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const showOverview = useAppStore((s) => s.showOverview);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const showGadgets = useAppStore((s) => s.showGadgets);
  const showTerminal = useAppStore((s) => s.showTerminal);
  const showBrowser = useAppStore((s) => s.showBrowser);
  const showChanges = useAppStore((s) => s.showChanges);
  const extensionMenuOpen = useAppStore((s) => s.extensionMenuOpen);
  const setExtensionMenuOpen = useAppStore((s) => s.setExtensionMenuOpen);

  const flyoutAnchorRef = useRef<HTMLDivElement>(null);

  useDismissOnClickOutside(
    extensionFlyoutOpen && !extensionFlyoutPinned,
    closeExtensionFlyout,
    flyoutAnchorRef,
  );
  useDismissOnClickOutside(extensionMenuOpen, () => setExtensionMenuOpen(false), flyoutAnchorRef);

  const displayMode = panelMode === "file" ? extensionView : panelMode;
  const showTabs = tabs.length > 0;
  // Native browser/artifact views paint above DOM menus regardless of z-index.
  // The rendered overlay owns the blocker, including pinned and nested flyouts.
  useBlockNativeSurfaces(showTabs ? extensionFlyoutOpen : extensionMenuOpen);

  const pickMode = (mode: PanelMode): void => {
    if (mode === "overview") showOverview();
    else if (mode === "workspace") showWorkspace();
    else if (mode === "gadgets") showGadgets();
    else if (mode === "terminal") showTerminal();
    else if (mode === "browser") showBrowser();
    else if (mode === "changes") showChanges();
    setExtensionMenuOpen(false);
  };

  return (
    <div className="extension-top-bar">
      <div className="extension-top-left">
        <div className="extension-menu-anchor" ref={flyoutAnchorRef}>
          <button
            type="button"
            className={`icon-btn extension-menu-btn ${showTabs && extensionFlyoutOpen ? "active" : ""}`}
            title="菜单"
            onClick={() => {
              if (showTabs) toggleExtensionFlyout();
              else setExtensionMenuOpen(!extensionMenuOpen);
            }}
          >
            <IconList size={16} />
          </button>
          {extensionMenuOpen && !showTabs && (
            <div className="extension-mode-menu extension-top-menu" onClick={(e) => e.stopPropagation()}>
              {EXTENSION_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`extension-mode-item ${displayMode === mode ? "active" : ""}`}
                  onClick={() => pickMode(mode)}
                >
                  {EXTENSION_MODE_LABEL[mode]}
                  {displayMode === mode && <IconCheck size={14} />}
                </button>
              ))}
            </div>
          )}
          {showTabs && extensionFlyoutOpen && (
            <ExtensionFlyoutContent view={extensionView} wsSearch={wsSearch} />
          )}
        </div>
        {showTabs && (
          <div className="extension-top-tabs">
            {tabs.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                className={`extension-top-tab ${a.id === activeId ? "active" : ""}${canNativeDrag(a.path) ? " is-draggable" : ""}`}
                title={canNativeDrag(a.path) ? `${a.path}\n可拖到桌面或其它应用` : a.name}
                draggable={canNativeDrag(a.path)}
                onDragStart={(e) => {
                  if (!startNativeFileDrag(e, a.path)) e.preventDefault();
                }}
                onClick={() => onOpenTab(a.id)}
                onKeyDown={(e) => e.key === "Enter" && onOpenTab(a.id)}
              >
                {a.kind === "html" ? (
                  <IconGlobe size={13} className="extension-tab-globe" />
                ) : (
                  <FileBadge name={a.name} size={13} />
                )}
                <span className="extension-top-tab-name">{a.name}</span>
                <button
                  type="button"
                  className="extension-top-tab-close"
                  title="关闭标签"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(a.id);
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="extension-top-actions">
        <button
          type="button"
          className={`icon-btn ${panelExpanded ? "active" : ""}`}
          title={panelExpanded ? "还原宽度" : "展开"}
          onClick={onWiden}
        >
          <IconExpand size={15} />
        </button>
        <button type="button" className="icon-btn" title="关闭侧栏" onClick={closePanel}>
          <IconPanel size={15} />
        </button>
      </div>
    </div>
  );
}
