import { useEffect, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/appStore";
import { useBtwStore } from "@/store/btwStore";
import {
  generationSpeedInput, generationSpeedView, selectGenerationReply,
  type GenerationSpeedInput,
} from "@/lib/generationSpeed";
import "./GenerationSpeed.css";

/** The clock is local to this leaf; waiting never rerenders the composer or message list. */
export function GenerationSpeedDisplay(input: GenerationSpeedInput): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  const tooltipId = useId();
  useEffect(() => {
    if (!input.streaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [input.streaming, input.createdAt]);
  const view = generationSpeedView(input, now);
  if (!view) return null;
  return (
    <span className="generation-speed" tabIndex={0} aria-label={view.label} aria-describedby={tooltipId}>
      <span className="generation-speed-label">{view.label}</span>
      <span id={tooltipId} className="generation-speed-tooltip" role="tooltip">{view.detail}</span>
    </span>
  );
}

function MainGenerationSpeed({ taskId }: { taskId: string }): React.JSX.Element {
  const input = useAppStore(useShallow((s) => generationSpeedInput(
    selectGenerationReply(s.tasks.find((t) => t.id === taskId)?.messages ?? []),
  )));
  return <GenerationSpeedDisplay {...input} />;
}

function BtwGenerationSpeed({ taskId }: { taskId: string }): React.JSX.Element {
  const input = useBtwStore(useShallow((s) => generationSpeedInput(
    s.active && s.parentTaskId === taskId ? selectGenerationReply(s.messages) : undefined,
  )));
  return <GenerationSpeedDisplay {...input} />;
}

export default function GenerationSpeed({ taskId, btw }: { taskId: string; btw: boolean }): React.JSX.Element {
  return btw ? <BtwGenerationSpeed key={`btw:${taskId}`} taskId={taskId} />
    : <MainGenerationSpeed key={taskId} taskId={taskId} />;
}
