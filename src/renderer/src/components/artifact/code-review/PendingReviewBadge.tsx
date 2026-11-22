import { useEffect, useState } from "react";
import type { CodeReviewChangedEvent } from "@shared/code-review";
import { useCodeReviewTaskId } from "./useCodeReviewTaskId";

export function usePendingReviewCount(): number {
  const taskId = useCodeReviewTaskId();
  const [snapshot, setSnapshot] = useState<CodeReviewChangedEvent>();

  useEffect(() => {
    setSnapshot(undefined);
    const api = window.api?.codeReview;
    if (!taskId || !api) return;

    let active = true;
    let receivedChange = false;
    const unsubscribe = api.onChanged(change => {
      if (!active || change.taskId !== taskId) return;
      receivedChange = true;
      setSnapshot(change);
    });
    void api.pendingCount(taskId).then(pendingCount => {
      if (active && !receivedChange) setSnapshot({ taskId, pendingCount });
    }).catch(() => {
      if (active && !receivedChange) setSnapshot(undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [taskId]);

  return snapshot && snapshot.taskId === taskId ? snapshot.pendingCount : 0;
}

export function PendingReviewBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span className="extension-tab-badge changes" data-testid="code-review-pending-badge" aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}
