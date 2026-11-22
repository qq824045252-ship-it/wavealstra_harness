import { useMemo } from "react";
import type { Artifact, Task } from "@/types";
import { resolveTaskFileChanges } from "@/lib/taskFileChanges";
import { useAppStore } from "@/store/appStore";
import "./ChatReadability.css";

export default function ChatTaskResults({ task, visibleArtifacts }: { task: Task; visibleArtifacts: Artifact[] }) {
  const showAllArtifacts = useAppStore(s => s.showAllArtifacts);
  const showAllChanges = useAppStore(s => s.showAllChanges);
  const hasChanges = useMemo(() => resolveTaskFileChanges(task.fileChanges, [], task.messages).length > 0,
    [task.fileChanges, task.messages]);
  return <>
    {visibleArtifacts.length > 0 && <button type="button" className="chat-reading-button" onClick={showAllArtifacts}>
      产物 ({visibleArtifacts.length})
    </button>}
    {hasChanges && <button type="button" className="chat-reading-button" onClick={showAllChanges}>审查变更</button>}
  </>;
}
