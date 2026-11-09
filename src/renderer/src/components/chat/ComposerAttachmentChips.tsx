import type { Attachment } from "@/types";
import { FileBadge } from "@/components/common/FileBadge";
import { IconX } from "@/components/common/icons";

export function ComposerAttachmentChips({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (attachment: Attachment) => void }): React.JSX.Element {
  return <>{attachments.map(attachment => {
    const label = (attachment.name || attachment.path || "文件").split(/[/\\]/).pop() || "文件";
    const path = attachment.path?.trim() || "";
    const draggable = Boolean(path && window.api?.startNativeDrag);
    return <span key={path || attachment.name} className={`attach-chip file-chip${draggable ? " is-draggable" : ""}`} title={path || attachment.name} draggable={draggable}
      onDragStart={event => { event.preventDefault(); if (draggable) window.api?.startNativeDrag?.(path); }}>
      <FileBadge name={label} size={16} /><span className="attach-chip-name">{label}</span>
      {onRemove && <button type="button" className="attach-chip-x" aria-label={`移除文件 ${label}`} draggable={false} onClick={() => onRemove(attachment)}><IconX size={12} /></button>}
    </span>;
  })}</>;
}
