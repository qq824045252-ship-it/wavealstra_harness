import { useEffect, useState } from "react";
import { Code2 } from "lucide-react";
import type { McpStatusSnapshotDto, WelcomeMode } from "@shared/agent-ipc";
import { piCodeModeLabel, type PiCodeModeState } from "@shared/pi-code-mode";
import "./PiCodeModeChip.css";
import { useAppStore } from "@/store/appStore";

/** Read-only presentation. Scene selection configures Pi; this component never starts or controls it. */
export default function PiCodeModeChip({ taskId, welcomeMode }: {
  taskId?: string;
  welcomeMode?: WelcomeMode;
}): React.JSX.Element {
  const [observed, setObserved] = useState<{ taskId: string; state: PiCodeModeState | null } | null>(null);
  const botMode = useAppStore(s => {
    const task = s.tasks.find(t => t.id === taskId);
    const preset = task?.modePresetId ?? s.modePresetId;
    return task?.durable?.toolMode ?? (preset === "codemode" ? "codemode" : "native");
  });
  useEffect(() => {
    if (!taskId || welcomeMode === "bot") return;
    let disposed = false, eventRevision = 0;
    const apply = (snapshot: McpStatusSnapshotDto | null): void => {
      if (!disposed && (!snapshot || snapshot.sessionId === taskId)) {
        setObserved({ taskId, state: snapshot?.codeMode ?? null });
      }
    };
    // Subscribe before reading; a slow initial read must not overwrite a newer session event.
    const unsubscribe = window.api?.mcp?.onStatusEvent?.((snapshot) => {
      if (snapshot.sessionId !== taskId) return;
      eventRevision += 1;
      apply(snapshot);
    });
    const revision = eventRevision;
    void window.api?.mcp?.status?.(taskId).then((snapshot) => {
      if (revision === eventRevision) apply(snapshot);
    }).catch(() => { if (revision === eventRevision) apply(null); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [taskId, welcomeMode]);
  if (welcomeMode === "bot") return <span className="pi-codemode-chip" role="status" data-testid="pi-durable-status">
    <Code2 size={12} /><span>Pi Durable</span><span>{botMode === "codemode" ? "Code Mode" : "原生模式"}</span>
  </span>;
  const state = observed && observed.taskId === taskId ? observed.state : null;
  const label = piCodeModeLabel(welcomeMode, state);
  return (
    <span className={`pi-codemode-chip phase-${label.phase}`} role="status" aria-live="polite"
      data-testid="pi-codemode-status" data-state={label.phase} data-task-id={taskId ?? ""}
      title={label.title} aria-label={`Pi Code Mode，自动，${label.text}`}>
      <Code2 size={12} aria-hidden="true" />
      <span>Pi Code Mode</span>
      <span className="pi-codemode-chip-state">{label.text}</span>
      <span className="pi-codemode-chip-auto">自动</span>
    </span>
  );
}
