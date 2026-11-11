import { useState } from "react";
import type { MemoryScopeType } from "@shared/memory-kernel";
import MemoryKernelExplorer from "./MemoryKernelExplorer";
import "./Memory.css";

/** Lazy, scoped reuse of the existing editor; closed panels do not query memories. */
export default function ScopedMemoryPanel({ scopeType, scopeId, title }: {
  scopeType: MemoryScopeType; scopeId: string; title: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details className="bot-advanced" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{title}</summary>
    {open && <MemoryKernelExplorer key={scopeType + ":" + scopeId} fixedScope={{ scopeType, scopeId }} />}
  </details>;
}
