import type { ReactNode } from "react";

export function HubShell({ children }: { children: ReactNode }) {
  return <div className="hub-shell">{children}</div>;
}
