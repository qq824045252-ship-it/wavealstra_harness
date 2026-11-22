import ChatMarkdown from "./ChatMarkdown";
import ChatCalloutFrame from "./ChatCalloutFrame";

interface Props {
  variant: "warning" | "info";
  title?: string;
  text: string;
}

export default function CalloutBlock({ variant, title, text }: Props): React.JSX.Element {
  return <ChatCalloutFrame variant={variant} title={title}><ChatMarkdown text={text} streaming={false} /></ChatCalloutFrame>;
}
