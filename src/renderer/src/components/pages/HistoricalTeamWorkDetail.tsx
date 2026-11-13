import { useBotWorkDetail } from "@/hooks/useBotWorkDetail";
import type { WorkProjectionDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";
import { BotWorkConversationDetail } from "./BotWorkConversationDetail";
import { BotTeamManagement } from "./BotTeamManagement";

/** Inspect the real historical team Work without creating a writable team conversation. */
export function HistoricalTeamWorkDetail({ snapshot, onBack }: {
  snapshot: WorkProjectionDto; onBack: () => void;
}): React.JSX.Element {
  const detail = useBotWorkDetail(snapshot.workId, "historical-team");
  const work = detail.work;
  return <BotWorkConversationDetail work={work} workId={snapshot.workId} loading={detail.loading} error={detail.error} conversationName={work?.team?.teamName ?? "历史事项"}
    ownerName={work?.team?.teamName ?? "历史事项"} includeClosed returnLabel="原视图" onBack={onBack}>
    {work && <BotTeamManagement key={work.workId} work={work} onChanged={() => { void useAppStore.getState().refreshBotWork(true); }} />}
  </BotWorkConversationDetail>;
}
