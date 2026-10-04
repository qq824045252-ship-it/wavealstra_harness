import { useEffect, useState, type ReactNode } from "react";

type Props = {
  id?: string;
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  description?: string;
  tags?: string[];
  status?: ReactNode;
  footer?: ReactNode;
  density?: "compact" | "normal";
  children?: ReactNode;
  highlight?: boolean;
  focused?: boolean;
  expansionCommand?: { sequence: number; expanded: boolean };
};

export function HubCard({ id, icon, title, meta, description, tags, status, footer, density = "compact", children, highlight, focused, expansionCommand }: Props) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (focused) setExpanded(true);
  }, [focused]);

  useEffect(() => {
    if (!expansionCommand || expansionCommand.sequence <= 0) return;
    setExpanded(expansionCommand.expanded);
  }, [expansionCommand?.sequence]);

  const toggleExpanded = (): void => setExpanded((value) => !value);

  return (
    <div id={id} className={`hub-card hub-card--${density}${highlight ? " hub-card--installed" : ""}${focused ? " hub-card--focused" : ""} ${expanded ? "hub-card--expanded" : "hub-card--collapsed"}`}>
      <div className="hub-card-head">
        <button
          type="button"
          className="hub-card-title-wrap hub-card-summary"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          title={expanded ? `收起 ${title}` : `展开 ${title}`}
        >
          {expanded && icon && <div className="hub-card-icon">{icon}</div>}
          <div className="hub-card-title-col">
            <div className="hub-card-title" title={title}>{title}</div>
            {expanded && meta && <div className="hub-card-meta">{meta}</div>}
          </div>
        </button>
        {expanded && status && <div className="hub-card-status">{status}</div>}
        <button
          type="button"
          className="hub-card-toggle"
          onClick={toggleExpanded}
          aria-label={expanded ? `收起 ${title}` : `展开 ${title}`}
          title={expanded ? "收起详情" : "展开详情"}
        >
          <span aria-hidden>{expanded ? "−" : "+"}</span>
        </button>
      </div>
      {expanded && (
        <>
          {description && <div className="hub-card-desc">{description}</div>}
          {tags && tags.length > 0 && (
            <div className="hub-card-tags">
              {tags.slice(0, 2).map((t) => (
                <span key={t} className="hub-card-tag">{t}</span>
              ))}
              {tags.length > 2 && <span className="hub-card-tag hub-card-tag--more">+{tags.length - 2}</span>}
            </div>
          )}
          {children}
          {footer && <div className="hub-card-footer">{footer}</div>}
        </>
      )}
    </div>
  );
}
