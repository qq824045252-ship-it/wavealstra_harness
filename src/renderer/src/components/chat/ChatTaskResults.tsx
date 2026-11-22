import { useMemo } from "react";
import type { Artifact, Task } from "@/types";
import { resolveTaskFileChanges } from "@/lib/taskFileChanges";
import { useAppStore } from "@/store/appStore";
import "./ChatReadability.css";

export default function ChatTaskResults({ task, visibleArtifacts, onOpen }: { task: Task; visibleArtifacts: Artifact[]; onOpen?: () => void }) {
  const showAllArtifacts = useAppStore(s => s.showAllArtifacts);
  const showAllChanges = useAppStore(s => s.showAllChanges);
  const hasChanges = useMemo(() => resolveTaskFileChanges(task.fileChanges, [], task.messages).length > 0,
    [task.fileChanges, task.messages]);
  return <>
    {visibleArtifacts.length > 0 && <button type="button" className="chat-reading-button" onClick={() => { showAllArtifacts(); onOpen?.(); }}>
      产物 ({visibleArtifacts.length})
    </button>}
    {hasChanges && <button type="button" className="chat-reading-button" onClick={() => { showAllChanges(); onOpen?.(); }}>审查变更</button>}
  </>;
}
