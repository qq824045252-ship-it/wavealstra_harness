import { useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import type { PanelMode } from "@/store/appStore";
import { useAppStore } from "@/store/appStore";
import { IconCheck, IconChevronDown } from "@/components/common/icons";
import { EXTENSION_MODES, EXTENSION_MODE_LABEL } from "./extensionModes";

interface Props {
  /** 固定展示某一模式标签（浏览器侧栏等） */
  fixedMode?: PanelMode;
  /** 悬浮卡片 / 侧栏：与产物标题同一套按钮样式 */
  variant?: "default" | "panel";
}

export default function ExtensionModeDropdown({ fixedMode, variant = "default" }: Props): React.JSX.Element {
  const panelMode = useAppStore((s) => s.panelMode);
  const extensionView = useAppStore((s) => s.extensionView);
  const showOverview = useAppStore((s) => s.showOverview);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const showGadgets = useAppStore((s) => s.showGadgets);
  const showTerminal = useAppStore((s) => s.showTerminal);
  const showBrowser = useAppStore((s) => s.showBrowser);
  const showChanges = useAppStore((s) => s.showChanges);

  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useDismissOnClickOutside(open, () => setOpen(false), anchorRef);
  useBlockNativeSurfaces(open);

  const displayMode = fixedMode ?? (panelMode === "file" ? extensionView : panelMode);
  const label = EXTENSION_MODE_LABEL[displayMode];

  const pickMode = (mode: PanelMode): void => {
    if (mode === "overview") showOverview();
    else if (mode === "workspace") showWorkspace();
    else if (mode === "gadgets") showGadgets();
    else if (mode === "terminal") showTerminal();
    else if (mode === "browser") showBrowser();
    else if (mode === "changes") showChanges();
    setOpen(false);
  };

  const isPanel = variant === "panel";

  return (
    <div className={`extension-mode-section ${isPanel ? "extension-panel-mode" : ""}`} ref={anchorRef}>
      <button
        type="button"
        className={isPanel ? "extension-panel-header-btn" : "extension-mode-section-btn"}
        onClick={() => setOpen(!open)}
      >
        {label}
        <IconChevronDown size={13} className={open ? "chevron-up" : ""} />
      </button>
      {open && (
        <div className="extension-mode-menu" onClick={(e) => e.stopPropagation()}>
          {EXTENSION_MODES.map((mode) => {
            const selected = displayMode === mode;
            const text = EXTENSION_MODE_LABEL[mode];
            return (
              <button
                key={mode}
                type="button"
                className={`extension-mode-item ${selected ? "active" : ""}`}
                onClick={() => pickMode(mode)}
              >
                <span className="extension-mode-item-label" data-text={text}>
                  {text}
                </span>
                <span className={`extension-mode-check ${selected ? "" : "empty"}`} aria-hidden={!selected}>
                  <IconCheck size={14} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
