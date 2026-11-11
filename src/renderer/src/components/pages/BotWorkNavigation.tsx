import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkQueryRequest } from "@shared/bot-work-query";
import { useAppStore } from "@/store/appStore";
import { useWorkQueryPage } from "@/hooks/useWorkQueryPage";
import { IconArchive, IconBot, IconCheck, IconClock, IconMessageDashed } from "@/components/common/icons";
import { type BotWorkspaceView } from "@/lib/botWorkspacePresentation";
const views: Array<{ id: BotWorkspaceView; label: string; icon: typeof IconBot }> = [
  { id: "conversation", label: "对话", icon: IconMessageDashed },
  { id: "active", label: "进行中", icon: IconClock },
  { id: "completed", label: "已完成", icon: IconCheck },
  { id: "closed", label: "归档", icon: IconArchive },
];
export function BotWorkNavigation({ view, onChange, scope: explicitScope }: {
  scope?: WorkQueryRequest["scope"];
  works?: WorkProjectionDto[]; view: BotWorkspaceView; allWorksLoaded?: boolean; onChange: (view: BotWorkspaceView) => void;
}): React.JSX.Element {
  const botId = useAppStore(state => state.activeBotId);
  const teamId = useAppStore(state => state.activeTeam?.templateId);
  const scope: WorkQueryRequest["scope"] = explicitScope ?? (teamId ? { kind: "team", teamId } : { kind: "personal", botId: botId ?? "" });
  const { result } = useWorkQueryPage({ scope, view: "all", page: 1, pageSize: 1 });
  return <nav className="bot-view-tabs" aria-label="对话与事项">
    {views.map(item => {
      const count = item.id === "conversation" ? undefined : result?.viewCounts[item.id];
      return <button type="button" key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>
        <item.icon size={15} /><span>{item.label}</span>{count !== undefined && <span className="bot-tab-count">{count}</span>}
      </button>;
    })}
  </nav>;
}
