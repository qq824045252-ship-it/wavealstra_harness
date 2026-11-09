import { useEffect, useState } from "react";
import { DEFAULT_BOT_ID, type BotDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";

export function BotDeletion({ bot, onDeleted }: { bot: BotDto; onDeleted: () => void }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { setConfirm(false); setMessage(""); }, [bot.botId]);
  async function remove() {
    if (busy || !confirm) return;
    setBusy(true); setMessage("");
    try {
      if (!window.api) throw new Error("宿主未连接");
      const result = await window.api.botWork.deleteBot({ botId: bot.botId, expectedUpdatedAt: bot.updatedAt });
      if (!result.ok) { setMessage(result.message); return; }
      useAppStore.getState().forgetDeletedBot(bot.botId);
      await useAppStore.getState().refreshBotWork();
      useAppStore.getState().setPage("bot");
      onDeleted();
    } catch { setMessage("删除结果尚未确认，请刷新 Bot 列表核对后再试。"); }
    finally { setBusy(false); }
  }
  return <section className="bot-archive-section" aria-label="删除 Bot">
    <h3>删除 Bot</h3>
    {bot.botId === DEFAULT_BOT_ID ? <p>默认 MyBuddy 用来接手其他 Bot 的事项，不能删除。</p> : <>
      <p>永久删除此 Bot 及其对话。事项和成果留在应用中，由 MyBuddy 接手；磁盘文件不删除。没有回收站。</p>
      {confirm ? <div role="group" aria-label="确认删除 Bot"><p>确定删除“{bot.displayName}”及全部对话？</p>
        <button type="button" disabled={busy} onClick={() => void remove()}>{busy ? "删除中…" : "确认删除 Bot"}</button>
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>取消</button>
      </div> : <button type="button" disabled={busy} onClick={() => setConfirm(true)}>删除此 Bot</button>}
    </>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
