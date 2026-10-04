import type { ReactNode } from "react";

export function HubToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="hub-toolbar">
      <div className="hub-toolbar-left">{left}</div>
      <div className="hub-toolbar-right">{right}</div>
    </div>
  );
}
