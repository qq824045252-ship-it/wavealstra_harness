import type { ReactNode } from "react";
import type { LibraryItemDto } from "@shared/library-ipc";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { IconFolderOpen } from "@/components/common/icons";

export default function LargeLibraryFileView({ item, access, onBack, onError, actions }: {
  item: LibraryItemDto;
  access: ScopedLibraryOperations;
  onBack?: () => void;
  onError: (cause: unknown) => void;
  actions?: ReactNode;
}): React.JSX.Element {
  const mib = item.sizeBytes / (1024 * 1024);
  const formattedSize = mib < 1024
    ? `${mib.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`
    : `${(mib / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GiB`;
  const searchStatus = item.kind === "markdown" || item.kind === "html" || item.kind === "csv"
    ? "可检索正文。"
    : item.kind === "office" || item.kind === "pdf"
      ? item.extractStatus === "extracted" ? "可检索已提取的正文。" : item.extractStatus === "pending" ? "正在提取正文供检索。" : null
      : null;
  return <article className="library-doc">
    <header className="library-doc-bar">
      <div className="library-doc-bar-left">
        {onBack && <button type="button" className="btn" onClick={onBack}>返回文档列表</button>}
        <strong>{item.title}</strong>
      </div>
      <div className="library-doc-bar-right">
        <button type="button" className="btn" title="在文件管理器中显示"
          onClick={() => void access.showInFolder(item.id).catch(onError)}><IconFolderOpen size={14} />打开位置</button>
        {actions}
      </div>
    </header>
    <div className="library-empty">
      <strong>大型资料</strong>
      <p>{item.filename} · <span title={`${item.sizeBytes.toLocaleString("zh-CN")} 字节`}>{formattedSize}</span></p>
      <p>{searchStatus}请通过「打开位置」访问原文件。</p>
    </div>
  </article>;
}
