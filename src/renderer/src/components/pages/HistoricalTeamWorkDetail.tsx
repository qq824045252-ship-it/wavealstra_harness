import { useEffect, useRef } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";
import { BotWorkConversationDetail } from "./BotWorkConversationDetail";
import { BotTeamManagement } from "./BotTeamManagement";

/** Inspect the real historical team Work without creating a writable team conversation. */
export function HistoricalTeamWorkDetail({ snapshot, onBack }: {
  snapshot: WorkProjectionDto; onBack: () => void;
}): React.JSX.Element {
  const latest = useAppStore(state => state.botWorks.find(work => work.workId === snapshot.workId));
  const retained = useRef(snapshot);
  if (retained.current.workId !== snapshot.workId) retained.current = snapshot;
  if (latest && latest.stateVersion >= retained.current.stateVersion) retained.current = latest;
  const work = retained.current;
  useEffect(() => { void useAppStore.getState().refreshBotWork(true); }, [snapshot.workId]);
  return <BotWorkConversationDetail work={work} conversationName={work.team?.teamName ?? "历史团队"}
    ownerName={work.team?.teamName ?? "历史团队"} includeClosed returnLabel="原视图" onBack={onBack}>
    <BotTeamManagement key={work.workId} work={work} onChanged={() => { void useAppStore.getState().refreshBotWork(true); }} />
  </BotWorkConversationDetail>;
}
