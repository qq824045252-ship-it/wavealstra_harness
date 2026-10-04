import type { ReactNode } from "react";

type Density = "compact" | "normal" | "wide";

export function HubGrid({ children, density = "compact" }: { children: ReactNode; density?: Density }) {
  return <div className={`hub-grid hub-grid--${density}`}>{children}</div>;
}
