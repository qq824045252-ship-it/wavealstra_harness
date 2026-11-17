import { IconBot } from "./icons";
import "./BotAvatar.css";

/** Historical author identity has no avatar-management or execution connection. */
export function BotAvatar({ botId, name, className = "" }: {
  botId?: string; name: string; className?: string;
}) {
  return <span className={`bot-avatar bot-identity-avatar ${className}`} role="img" aria-label={`${name}的头像`} data-bot-id={botId}>
    <IconBot size={18} />
  </span>;
}
