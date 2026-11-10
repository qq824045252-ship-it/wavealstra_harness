import { useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { canArchiveWork, isWorkArchived } from "@shared/bot-work-archive";
import { useAppStore } from "@/store/appStore";
import "./BotWorkArchive.css";

export function BotWorkArchiveActions({ work }: { work: WorkProjectionDto }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const perform = async (action: "archive" | "delete" | "restore") => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      if (!window.api) throw Error("桌面接口不可用，请重新打开应用");
      const result = await window.api.botWork.reviewControl({ kind: "manage_archive", request: { workId: work.workId, operationId: crypto.randomUUID(), action } });
      if (!result.ok) throw Error(result.message);
      setNotice(action === "delete" ? "已删除记录，可在归档的已删除记录中恢复；成果文件未删除。" : action === "restore" ? "已恢复到归档，不重新执行。" : "已归档，记录与成果仍可查看；不会自动重试。");
      await useAppStore.getState().refreshBotWork(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作未确认，请重试"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const archived = isWorkArchived(work), deleted = Boolean(work.archive?.deletedAt);
  if (!archived && !canArchiveWork(work)) return null;
  return <div className="bot-work-archive-actions" aria-label={`管理记录：${work.title}`}>
    {deleted ? <button type="button" disabled={busy} onClick={() => void perform("restore")}>恢复到归档</button>
      : archived ? <button type="button" disabled={busy} title="删除列表记录，可恢复；不会删除磁盘成果文件" onClick={() => void perform("delete")}>删除记录</button>
      : <button type="button" disabled={busy} title="移入归档，保留记录与成果；失败事项不再自动重试" onClick={() => void perform("archive")}>归档</button>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
