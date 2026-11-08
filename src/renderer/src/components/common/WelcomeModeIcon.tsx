import type { WelcomeMode } from "@shared/agent-ipc";
import { WELCOME_MODE_LABELS, resolveWelcomeMode } from "@shared/mode-profile";
import { Code2, FileText, LayoutGrid } from "lucide-react";

type Props = {
  mode?: WelcomeMode | null;
  size?: number;
  className?: string;
  /** 是否显示文字（默认仅图标） */
  showLabel?: boolean;
};

/** 三模式统一小图标：办公 / 编码 / 通用 */
export default function WelcomeModeIcon({
  mode,
  size = 14,
  className = "",
  showLabel = false,
}: Props): React.JSX.Element {
  const m: WelcomeMode = resolveWelcomeMode(mode);
  const label = WELCOME_MODE_LABELS[m];
  const title = mode ? label : `${label}（默认）`;

  const ModeIcon = m === "working" ? FileText : m === "general" ? LayoutGrid : Code2;

  return (
    <span
      className={`welcome-mode-icon welcome-mode-icon--${m} ${className}`.trim()}
      title={title}
      aria-label={title}
    >
      <ModeIcon size={size} strokeWidth={1.5} aria-hidden />
      {showLabel ? <span className="welcome-mode-icon-label">{label}</span> : null}
    </span>
  );
}
