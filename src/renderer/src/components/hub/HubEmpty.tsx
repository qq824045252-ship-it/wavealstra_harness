import { UiIcon } from "@mybuddy/shared/icons";
type Props = { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode };

export function HubEmpty({ icon = <UiIcon name="circle" size="1em" />, title, description, action }: Props) {
  return (
    <div className="hub-empty hub-empty--unified">
      <div className="hub-empty-icon">{icon}</div>
      <div className="hub-empty-title">{title}</div>
      {description && <div className="hub-empty-desc">{description}</div>}
      {action && <div className="hub-empty-action">{action}</div>}
    </div>
  );
}
