import { IconAlert } from "@/components/common/icons";
import ChatMarkdown from "./ChatMarkdown";

interface Props {
  variant: "warning" | "info";
  title?: string;
  text: string;
}

export default function CalloutBlock({ variant, title, text }: Props): React.JSX.Element {
  return (
    <div className={`msg-callout ${variant}`}>
      {variant === "warning" && <IconAlert size={16} className="msg-callout-icon" />}
      <div className="msg-callout-body">
        {title && <div className="msg-callout-title">{title}</div>}
        <ChatMarkdown text={text} streaming={false} />
      </div>
    </div>
  );
}
