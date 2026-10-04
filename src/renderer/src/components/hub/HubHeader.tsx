type Props = {
  title: string;
  description?: string;
  count?: number;
  action?: React.ReactNode;
};

export function HubHeader({ title, description, count, action }: Props) {
  return (
    <div className="hub-header">
      <div className="hub-header-main">
        <div className="hub-header-title-row">
          <h2 className="hub-header-title">{title}</h2>
          {typeof count === "number" && <span className="hub-header-count">{count}</span>}
        </div>
        {description && <div className="hub-header-desc">{description}</div>}
      </div>
      {action && <div className="hub-header-action">{action}</div>}
    </div>
  );
}
