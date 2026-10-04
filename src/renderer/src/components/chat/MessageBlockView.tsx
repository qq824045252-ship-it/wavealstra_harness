import { memo } from "react";
import type { MessageBlock } from "@/types";
import { splitCanvasDocuments } from "@/lib/canvasDocuments";
import ChatMarkdown from "./ChatMarkdown";
import ToolCallCard from "./ToolCallCard";
import FileRecordsTable from "./FileRecordsTable";
import DetailCard, {
  canvasKindFromCode,
  isRenderableCanvasCode,
} from "./DetailCard";
import CalloutBlock from "./CalloutBlock";

interface Props {
  block: MessageBlock;
  index: number;
  messageId?: string;
  streaming?: boolean;
  className?: string;
}

function MessageBlockView({
  block,
  index,
  messageId,
  streaming,
  className = "assistant-block",
}: Props): React.JSX.Element | null {
  // Older renderer messages may contain a retired plan block. Keep its content
  // readable as text without restoring the plan card or its state/actions.
  const legacyBlock = block as unknown as { type?: unknown; title?: unknown; items?: unknown };
  if (legacyBlock.type === "plan") {
    const title = typeof legacyBlock.title === "string" ? legacyBlock.title : "";
    const items = Array.isArray(legacyBlock.items) ? legacyBlock.items : [];
    const text = [title, ...items.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") return [];
      return [`• ${item.text}`];
    })].filter(Boolean).join("\n");
    return text ? <div key={index} className={className}><div className="streaming-plain-text">{text}</div></div> : null;
  }
  switch (block.type) {
    case "thinking":
      // 深度思考：独立纯文本 renderer（回归修复）。
      // 思考区容器 .assistant-reasoning.streaming 用 background-clip:text +
      // -webkit-text-fill-color:transparent 实现流式渐变——该机制只对**直接文本节点**
      // 生效；markstream 把文字放进深层 .text-node span 后透明继承到深层而背景 clip
      // 不跨层 → 思考正文不可见（标题/列表符号仍在）。thinking 是推理草稿，纯文本
      // 渲染完整文字 + 保留原流式渐变/折叠交互，不引入 markdown 解析成本。
      return (
        <div key={index} className={className}>
          <div className="streaming-plain-text">{block.text}</div>
        </div>
      );
    case "text": {
      // HTML/SVG/Canvas 一旦形成完整文档就渲染为详情卡；不要等 assistant_end
      // 再替换整棵正文树，避免定稿瞬间产生 480px 级别的行高突变。
      if (block.type === "text") {
        const segments = splitCanvasDocuments(block.text, isRenderableCanvasCode);
        const hasCanvas = segments.some((s) => s.kind === "canvas");
        if (hasCanvas) {
          return (
            <div key={index} className={className}>
              {segments.map((seg, i) => {
                if (seg.kind === "canvas") {
                  return (
                    <DetailCard
                      key={`canvas-${i}`}
                      title="展示详情"
                      content={seg.code}
                      contentKind={canvasKindFromCode(undefined, seg.code)}
                      messageId={messageId}
                    />
                  );
                }
                const t = seg.text.trim();
                if (!t) return null;
                return (
                  <ChatMarkdown key={`text-${i}`} text={seg.text} streaming={Boolean(streaming)} />
                );
              })}
            </div>
          );
        }
      }

      // 统一 ChatMarkdown：streaming ↔ settled 同一 renderer/同一 DOM 模型，
      // 不再「流式纯文本 div → settled react-markdown 全量重建」。
      return (
        <div key={index} className={className}>
          <ChatMarkdown text={block.text} streaming={Boolean(streaming)} />
        </div>
      );
    }
    case "tool":
      if (!messageId) return null;
      return <ToolCallCard key={index} messageId={messageId} toolCall={block.toolCall} />;
    case "file_table":
      return (
        <div key={index} className={className}>
          <FileRecordsTable title={block.title} rows={block.rows} />
        </div>
      );
    case "detail":
      return (
        <div key={index} className={className}>
          <DetailCard
            title={block.title}
            content={block.content}
            contentKind={block.contentKind}
            messageId={messageId}
          />
        </div>
      );
    case "callout":
      return (
        <div key={index} className={className}>
          <CalloutBlock variant={block.variant} title={block.title} text={block.text} />
        </div>
      );
    default:
      return null;
  }
}

export default memo(MessageBlockView);
