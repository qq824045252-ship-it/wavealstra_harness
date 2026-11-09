import { useEffect, useState } from "react";
import type { BotDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";

/** Deliberately a future-delegation default, never an implicit mutation of live Works. */
export function BotWorkspaceAuthorization({ bot }: { bot: BotDto }): React.JSX.Element {
  const allowed = bot.authorization.allowedScopes.includes("workspace:write");
  const [enabled, setEnabled] = useState(allowed);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { setEnabled(allowed); setConfirmed(false); setMessage(""); }, [bot.botId, bot.updatedAt, allowed]);
  const save = async () => {
    if (!confirmed || busy || enabled === allowed) return;
    setBusy(true); setMessage("");
    try {
      if (!window.api) throw new Error("宿主未连接");
      const result = await window.api.botWork.updateWorkspaceAuthorization({ botId: bot.botId,
        expectedUpdatedAt: bot.updatedAt, allowWorkspaceFiles: enabled, confirmNewWorksOnly: true });
      if (!result.ok) { setMessage(result.message); return; }
      await useAppStore.getState().refreshBotWork();
      setConfirmed(false);
      setMessage(enabled ? "已允许新委托在其工作区创建、修改文件。已有事项授权未变化。" : "已关闭新委托的文件写授权。已有事项仍保留原授权，请在事项中暂停或取消。");
    } catch { setMessage("保存结果尚未确认，请刷新查看授权状态后重试。"); }
    finally { setBusy(false); }
  };
  return <section className="bot-archive-section" aria-label="新委托的工作区授权">
    <h3>新委托的工作区授权</h3>
    <p>当前：{allowed ? "允许创建、修改文件" : "只读"}。只作用于之后创建的事项，每个事项仍限于分配的工作区。</p>
    <label><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setConfirmed(false); setMessage(""); }} />允许创建、修改工作区文件</label>
    <p>不包含删除、Git 推送、外部发送、凭据或任意 shell。开启或关闭均不会改变已有事项的授权，也不会重跑旧审批。</p>
    {enabled !== allowed && <><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我确认仅更改新委托；已有事项需单独暂停、取消或按原审批处理</label>
      <button type="button" disabled={!confirmed || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存新委托授权"}</button></>}
    {message && <p role="status">{message}</p>}
  </section>;
}
