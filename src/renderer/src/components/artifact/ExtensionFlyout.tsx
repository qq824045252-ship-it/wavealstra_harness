import { useAppStore } from "@/store/appStore";
import { IconPin } from "@/components/common/icons";
import ExtensionModeDropdown from "./ExtensionModeDropdown";

interface Props {
  children: React.ReactNode;
}

/** 从 ☰ 按钮下方弹出的卡片：概览与产物同一列层级 */
export default function ExtensionFlyout({ children }: Props): React.JSX.Element {
  const pinned = useAppStore((s) => s.extensionFlyoutPinned);
  const togglePinned = useAppStore((s) => s.toggleExtensionFlyoutPinned);

  return (
    <div className={`extension-flyout-card ${pinned ? "pinned" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="extension-flyout-head">
        <ExtensionModeDropdown variant="panel" />
        <button
          type="button"
          className={`extension-flyout-pin ${pinned ? "active" : ""}`}
          title={pinned ? "取消钉住" : "钉住"}
          onClick={(e) => {
            e.stopPropagation();
            togglePinned();
          }}
        >
          <IconPin size={14} />
        </button>
      </div>
      <div className="extension-panel-nav extension-flyout-nav">{children}</div>
    </div>
  );
}
