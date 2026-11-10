import type { WorkProjectionDto } from "@shared/bot-work";
import { IconArchive, IconBot, IconCheck, IconClock, IconMessageDashed } from "@/components/common/icons";
import { workMatchesView, type BotWorkspaceView } from "@/lib/botWorkspacePresentation";
const views: Array<{ id: BotWorkspaceView; label: string; icon: typeof IconBot }> = [
  { id: "conversation", label: "对话", icon: IconMessageDashed },
  { id: "active", label: "进行中", icon: IconClock },
  { id: "completed", label: "已完成", icon: IconCheck },
  { id: "closed", label: "其他记录", icon: IconArchive },
];
export function BotWorkNavigation({ works, view, allWorksLoaded, onChange }: {
  works: WorkProjectionDto[]; view: BotWorkspaceView; allWorksLoaded: boolean; onChange: (view: BotWorkspaceView) => void;
}): React.JSX.Element {
  return <nav className="bot-view-tabs" aria-label="对话与事项">
    {views.map(item => {
      const pending = (item.id === "closed" || item.id === "completed") && !allWorksLoaded;
      const count = item.id === "conversation" ? undefined : pending ? undefined : works.filter(work => workMatchesView(work, item.id)).length;
      return <button type="button" key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>
        <item.icon size={15} /><span>{item.label}</span>{count !== undefined && <span className="bot-tab-count">{count}</span>}
      </button>;
    })}
  </nav>;
}
