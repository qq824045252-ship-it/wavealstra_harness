import { useEffect, useRef, useState, type ReactNode } from "react";

/** Connection state is independent from enrollment. A restored connection closes
 * configuration, but a user's explicit expansion survives routine status polls. */
export default function GatewayConnectionPanel({ title, connected, children }: {
  title: string; connected: boolean; children: ReactNode;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) setExpanded(false);
    wasConnected.current = connected;
  }, [connected]);
  const open = expanded;
  return <>
    <button type="button" className="btn" aria-expanded={open} aria-label={`${open ? "收起" : connected ? "管理" : "配置"}${title}`} onClick={() => setExpanded(value => !value)}>{open ? "收起" : connected ? "管理" : "配置"}</button>
    <div hidden={!open}>{children}</div>
  </>;
}
