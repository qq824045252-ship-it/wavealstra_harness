import { useEffect, useRef, useState } from "react";
import type { BotDto } from "@shared/bot-work";
import { botRenameSchema } from "@shared/bot-create";
import { useAppStore } from "@/store/appStore";

export function BotRename({ bot }: { bot: BotDto }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState(bot.displayName);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(bot.updatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.close(); }, [bot.botId]);
  const save = async () => {
    if (inFlight.current) return;
    const parsed = botRenameSchema.safeParse({ botId: bot.botId, expectedUpdatedAt, displayName: draft });
    if (!parsed.success) { setError("请输入 1–80 字的名称，不能包含控制字符"); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (!window.api?.botWork.renameBot) throw new Error("重命名接口尚未就绪，请重启应用");
      const result = await window.api.botWork.renameBot(parsed.data);
      if (!result.ok) { setError(result.message); return; }
      useAppStore.setState(state => ({ botIdentities: state.botIdentities.map(item => item.botId === result.bot.botId ? result.bot : item) }));
      dialog.current?.close();
      await Promise.all([useAppStore.getState().refreshBotWork(useAppStore.getState().botWorkCursor?.scope === "all"), useAppStore.getState().refreshSpaces()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "名称保存失败，请重试"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <><button type="button" className="bot-rename-trigger" aria-label="重命名 Bot" onClick={() => {
    setDraft(bot.displayName); setExpectedUpdatedAt(bot.updatedAt); setError(""); dialog.current?.showModal();
  }}>重命名</button>
  <dialog ref={dialog} className="bot-rename-dialog" aria-label="重命名 Bot" onCancel={event => { if (inFlight.current) event.preventDefault(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>重命名 Bot</h2>
      <label>Bot 名称<input autoFocus aria-label="新的 Bot 名称" maxLength={80} value={draft} disabled={busy} onChange={event => {setDraft(event.target.value); setError("");}} /></label>
      <p>仅修改名称，对话、任务、记忆和配置保持不变。</p>
      {error && <p role="alert">{error}</p>}
      <div className="bot-rename-actions"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button><button type="submit" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "保存名称"}</button></div>
    </form>
  </dialog></>;
}
