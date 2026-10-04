import { useRef } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import { IconCheck, IconChevronDown } from "@/components/common/icons";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import { WELCOME_MODE_LABELS, WELCOME_MODES, type WelcomeMode } from "@shared/mode-profile";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export default function ModePicker({ open, onToggle, onClose }: Props): React.JSX.Element {
  const welcomeMode = useAppStore((state) => state.welcomeMode);
  const setWelcomeMode = useAppStore((state) => state.setWelcomeMode);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(open, onClose, anchorRef);

  const pick = (mode: WelcomeMode): void => {
    setWelcomeMode(mode);
    onClose();
  };

  return (
    <div className="input-popup-anchor workspace-picker-anchor" ref={anchorRef}>
      <button type="button" className="pill-select as-btn workspace-trigger" onClick={onToggle}>
        <WelcomeModeIcon mode={welcomeMode} size={13} />
        {WELCOME_MODE_LABELS[welcomeMode]}
        <IconChevronDown size={12} className={open ? "chevron-up" : ""} />
      </button>
      {open && (
        <div className="workspace-popup" onClick={(event) => event.stopPropagation()}>
          <div className="workspace-popup-list">
            {WELCOME_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`workspace-popup-item ${welcomeMode === mode ? "active" : ""}`}
                onClick={() => pick(mode)}
              >
                <WelcomeModeIcon mode={mode} size={15} />
                <span className="workspace-popup-name">{WELCOME_MODE_LABELS[mode]}</span>
                {welcomeMode === mode && <IconCheck size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
