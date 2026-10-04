import { useState } from "react";
import PopupContextMenu from "@/components/common/PopupContextMenu";
import { IconMore } from "@/components/common/icons";

export type WorkspaceRowAction = {
  id: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  separatorBefore?: boolean;
};

export default function WorkspaceRowMenu({
  actions,
  disabled,
}: {
  actions: WorkspaceRowAction[];
  disabled?: boolean;
}): React.JSX.Element | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (actions.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className={`workspace-row-menu-btn${pos ? " is-open" : ""}`}
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPos((current) => (current ? null : { x: rect.right, y: rect.bottom }));
        }}
      >
        <IconMore size={16} />
      </button>
      {pos ? (
        <PopupContextMenu x={pos.x} y={pos.y} onClose={() => setPos(null)}>
          {actions.map((action) => (
            <div key={action.id}>
              {action.separatorBefore ? <div className="task-context-sep" /> : null}
              <button
                type="button"
                className={`task-context-item${action.danger ? " danger" : ""}`}
                disabled={action.disabled}
                title={action.title}
                onClick={() => {
                  if (action.disabled) return;
                  setPos(null);
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            </div>
          ))}
        </PopupContextMenu>
      ) : null}
    </>
  );
}
