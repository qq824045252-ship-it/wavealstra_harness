import type { BotDto } from "@shared/bot-work";
import type { WorkTeamTemplateDto } from "@shared/bot-work-team";
import { BotAvatar } from "./BotAvatar";
import { IconUsers } from "./icons";
import "./BotTeamAvatar.css";

type TeamIdentity = Pick<WorkTeamTemplateDto, "name" | "ownerBotId" | "members">;
type MemberIdentity = Pick<BotDto, "botId" | "displayName">;

/** Owner first, then persisted member order; never reorder when an avatar changes. */
export function teamAvatarMembers(team: TeamIdentity, bots: readonly MemberIdentity[]) {
  const names = new Map(bots.map(bot => [bot.botId, bot.displayName]));
  const ids = [...new Set([team.ownerBotId, ...team.members.map(member => member.botId)].filter(Boolean))];
  return ids.map(botId => ({ botId, name: names.get(botId) ?? "不可用 Bot" }));
}

/** A bounded static mosaic: no animated images, timers, or team-specific persisted asset. */
export function BotTeamAvatar({ team, bots, className = "" }: {
  team: TeamIdentity;
  bots: readonly MemberIdentity[];
  className?: string;
}) {
  const members = teamAvatarMembers(team, bots);
  const shown = members.slice(0, 4);
  const label = `${team.name}的团队头像：${members.length ? members.map(member => member.name).join("、") : "暂无成员"}`;
  return <span className={`bot-team-avatar ${className}`} role="img" aria-label={label} title={label} data-member-count={members.length}>
    <span className="bot-team-avatar-grid" data-count={shown.length} aria-hidden="true">
      {shown.length ? shown.map(member => <BotAvatar key={member.botId} botId={member.botId} name={member.name} play={false} />) : <IconUsers size={18} />}
    </span>
  </span>;
}
