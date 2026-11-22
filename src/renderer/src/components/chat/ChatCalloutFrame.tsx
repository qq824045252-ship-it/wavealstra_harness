import { IconAlert } from "@/components/common/icons";

export default function ChatCalloutFrame({ variant, title, children }: {
  variant: "info" | "warning";
  title?: string;
  children: React.ReactNode;
}) {
  return <div className={`msg-callout ${variant}`}>
    {variant === "warning" && <IconAlert size={16} className="msg-callout-icon" />}
    <div className="msg-callout-body">
      {title && <div className="msg-callout-title">{title}</div>}
      {children}
    </div>
  </div>;
}
