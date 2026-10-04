import { useEffect, useRef, useState } from "react";

type Action = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; dividerBefore?: boolean };

export function HubActionsMenu({ primary, actions }: { primary?: React.ReactNode; actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className={`hub-actions${open ? " hub-actions--open" : ""}`} ref={ref}>
      <div className="hub-actions-controls">
        {primary}
        <button
          type="button"
          className="btn hub-actions-more"
          onClick={() => setOpen((v) => !v)}
          aria-label="更多操作"
          aria-expanded={open}
        >
          ⋯
        </button>
      </div>
      {open && (
        <div className="hub-actions-menu">
          {actions.map((a, i) => (
            <div key={i}>
              {a.dividerBefore && <div className="hub-actions-divider" />}
              <button
                type="button"
                className={`hub-actions-item ${a.danger ? "danger" : ""}`}
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
              >
                {a.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
