import { useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import FullAccessConfirmModal from "./FullAccessConfirmModal";
import { PERMISSION_HINT, PERMISSION_LABEL } from "./permissionCopy";
import { IconAlert, IconChevronDown, IconShield } from "@/components/common/icons";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** 权限变更后回调（如执行中收起临时条） */
  onAfterChange?: () => void;
  /**
   * 对话工具栏自适应：宽度足够时显示图标+文案+chevron，
   * 输入框偏窄时收成仅图标，避免长文案撑高/折行。
   * 首页 composer 内嵌条不要传此属性，始终完整展示。
   */
  compact?: boolean;
  /** 首页内嵌：完全访问用警示色，不抢主画布 */
  quiet?: boolean;
}

/**
 * 输入区权限控件（首页与对话共用）。
 * 触发器展示「默认权限 / 只读模式 / 允许完全访问」；
 * 开启完全访问需居中确认弹窗；开启后为警示样式。
 */
export default function HomePermissionPicker({
  open,
  onToggle,
  onClose,
  onAfterChange,
  compact = false,
  quiet = false,
}: Props): React.JSX.Element {
  const permissionMode = useAppStore((s) => s.permissionMode);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  // F2：显式权限标记 + 复位「跟随场景建议」
  const permissionExplicit = useAppStore((s) => s.permissionExplicit);
  const followSuggestedPermission = useAppStore((s) => s.followSuggestedPermission);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useDismissOnClickOutside(open && !confirmOpen, onClose, anchorRef);

  const fullAccess = permissionMode === "auto";
  const label = PERMISSION_LABEL[permissionMode];

  const applyFullAccessOff = (): void => {
    setPermissionMode("default");
    onAfterChange?.();
    onClose();
  };

  const onSwitchClick = (): void => {
    if (fullAccess) {
      applyFullAccessOff();
      return;
    }
    // 开启前二次确认（弹窗居中于软件窗口）
    setConfirmOpen(true);
  };

  return (
    <>
      <div className="input-popup-anchor home-perm-anchor" ref={anchorRef}>
        <button
          type="button"
          className={`pill-select as-btn home-perm-trigger ${compact ? "compact" : ""} ${fullAccess ? (quiet ? "caution" : "danger") : ""} ${open ? "open" : ""}`}
          onClick={onToggle}
          title={label}
          aria-label={label}
        >
          {fullAccess && !quiet ? <IconAlert size={13} /> : <IconShield size={13} />}
          <span className="home-perm-label">{label}</span>
          <IconChevronDown size={12} className={`home-perm-chevron ${open ? "chevron-up" : ""}`} />
        </button>
        {open && (
          <div className="home-perm-popup" onClick={(e) => e.stopPropagation()}>
            <p className="home-perm-hint">{PERMISSION_HINT[permissionMode]}</p>
            <div className="home-perm-row">
              <span>允许完全访问</span>
              <button
                type="button"
                className={`switch ${fullAccess ? "on danger" : ""}`}
                onClick={onSwitchClick}
                aria-checked={fullAccess}
                role="switch"
                aria-label="允许完全访问"
              />
            </div>
            {/* F2：复位为跟随 Tag/Mode 建议（清除本任务显式权限标记） */}
            <button
              type="button"
              className={`home-perm-follow ${!permissionExplicit ? "active" : ""}`}
              title={
                permissionExplicit
                  ? "清除本任务显式权限选择，改由 Tag/Mode 建议（可解析时）或系统默认决定"
                  : "当前未显式选择：权限由 Tag/Mode 建议或系统默认决定"
              }
              onClick={() => {
                void followSuggestedPermission().then(() => {
                  onAfterChange?.();
                  onClose();
                });
              }}
            >
              <IconShield size={12} />
              {permissionExplicit ? "跟随场景建议（Tag/Mode）" : "跟随场景建议 · 未显式选择"}
            </button>
          </div>
        )}
      </div>
      <FullAccessConfirmModal
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setPermissionMode("auto");
          setConfirmOpen(false);
          onAfterChange?.();
          onClose();
        }}
      />
    </>
  );
}
