import { useEffect, useRef, useState, type ReactNode } from "react";
import { builtinBotAvatars, type BotAvatarCommand } from "@shared/bot-avatar";
import { avatarCommand, loadBotAvatars, useBotAvatars, useBotAvatarStore } from "@/lib/botAvatarStore";
import { BotAvatar } from "../common/BotAvatar";

export function BotAvatarSettings({botId,name,children,draftAssetId,onDraftSelect,disabled=false}:{botId?:string;name:string;children?:ReactNode;draftAssetId?:string|null;onDraftSelect?:(assetId:string|null)=>void;disabled?:boolean}) {
  const draft = Boolean(onDraftSelect);
  const snapshot = useBotAvatars();
  const [open,setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pickerEpoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pickerEpoch.current++; }; }, []);
  const close = () => { pickerEpoch.current++; dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [open]);
  const flight = useRef(false);
  const readError = useBotAvatarStore(state => state.error);
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [status,setStatus] = useState("");
  const selection = draft ? {assetId:draftAssetId ?? null,revision:0} : (botId ? snapshot?.selections[botId] : undefined) ?? {assetId:null,revision:0};
  async function change(request: BotAvatarCommand) {
    if (flight.current) return;
    const requestEpoch = pickerEpoch.current;
    flight.current=true;
    setBusy(true);setError("");setStatus("");
    try {
      const result = await avatarCommand(request);
      if (result.importedId) {
        // Read the latest appearance revision; execution settings have an independent revision.
        if (draft) { if (alive.current && pickerEpoch.current === requestEpoch && !disabled) { onDraftSelect?.(result.importedId); close(); } }
        else if (botId) { const latest = result.snapshot.selections[botId]?.revision ?? 0;
          await avatarCommand({kind:"set",botId,assetId:result.importedId,expectedRevision:latest}); }
      }
      if (!result.cancelled) setStatus(request.kind === "remove" ? "本地头像已移除，使用它的 Bot 已恢复默认头像" : "已保存到本机");
    } catch (cause) {setError(cause instanceof Error ? cause.message : "头像保存失败");await loadBotAvatars(true);}
    finally {flight.current=false;setBusy(false);}
  }
  const choose = (assetId:string|null) => { if (disabled) return; if (draft) { onDraftSelect?.(assetId); close(); } else if (botId) void change({kind:"set",botId,assetId,expectedRevision:selection.revision}); };
  function option(id:string|null,label:string) {
    return <button type="button" role="radio" tabIndex={selection.assetId===id ? 0 : -1} aria-checked={selection.assetId===id} aria-label={label} className="bot-avatar-choice" disabled={busy || !snapshot} onClick={() => choose(id)}>
      <BotAvatar name={name} assetId={id}/><span>{label}</span>
    </button>;
  }
  return <section className="bot-avatar-settings" aria-label="Bot 头像设置" aria-busy={busy}>
    <div className="bot-settings-profile">
      <button ref={trigger} type="button" className="bot-avatar-edit" aria-label={`更换${name}的头像`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}>
        <BotAvatar botId={botId} name={name} {...(draft ? {assetId:selection.assetId} : {})}/><span>更换头像</span>
      </button>
      <div className="bot-settings-profile-name"><h3>{name}</h3>{children}</div>
    </div>
    {open && <dialog ref={dialog} className="bot-avatar-picker" aria-label={`更换${name}的头像`} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onClose={() => {pickerEpoch.current++; setOpen(false); trigger.current?.focus();}}>
    <header className="bot-avatar-picker-heading"><h4>更换头像</h4><button type="button" aria-label="关闭头像选择器" onClick={close}>关闭</button></header><p>{draft ? "先选择头像，创建 Bot 时一并保存。导入图片会加入本机头像库；取消选择或取消创建不会删除已导入图片。" : "选择即保存。头像用于此 Bot 的列表、对话与协作记录。"}</p><p>{builtinBotAvatars.filter(asset=>asset.provenance === "original-approved").length} 款原创陪伴头像</p>
    <div className="bot-avatar-choices" role="radiogroup" aria-label="选择 Bot 头像" onKeyDown={event => {
      if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
      if (!buttons.length) return;
      event.preventDefault();
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next=event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (index+(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)+buttons.length)%buttons.length;
      buttons[next].focus();buttons[next].click();
    }}>
      {option(null,"默认头像")}
      {builtinBotAvatars.map(asset => <div key={asset.id}>{option(asset.id,asset.label)}</div>)}
      {snapshot?.uploads.map(asset => <div className="bot-avatar-local-row" key={asset.id}>{option(asset.id,asset.label)}
        {!draft && <button type="button" className="bot-avatar-remove" disabled={busy} aria-label={`移除${asset.label}`} onClick={() => void change({kind:"remove",assetId:asset.id})}>移除本地图片</button>}</div>)}
    </div>
    <div className="bot-avatar-controls"><button type="button" disabled={busy || !snapshot} onClick={() => void change({kind:"import"})}>添加本地头像</button>
      {!draft && <label><input type="checkbox" checked={snapshot?.motion ?? false} disabled={busy || !snapshot} onChange={event => void change({kind:"motion",enabled:event.target.checked})}/>播放标题头像动画</label>}
    </div>
    <p>本地图片仅保存在这台设备，不随聊天发送。支持 PNG / JPEG / GIF / 静态 WebP，最大 2 MB、2048 × 2048；静态图转成小尺寸 PNG，GIF 会保存循环图和静态首帧。GIF 最大 256 × 256、48 帧、10 秒、1 MB；最多保存 32 张。移除会使使用它的 Bot 恢复默认头像。</p>
    <p>列表、消息与协作记录使用静态头像；标题不可见、窗口在后台或系统开启减少动态效果时也使用静态图。</p>
    {builtinBotAvatars.some(asset => asset.provenance === "synthetic-test") && <p>当前内置图片为明确自制的合成测试素材，不代表正在制作的 99 个正式陪伴小兽。</p>}
    {(error || readError) && <p role="alert">{error || readError} <button type="button" disabled={busy} onClick={() => void loadBotAvatars(true)}>刷新头像</button></p>}
    <div className="bot-avatar-status" role="status">{busy ? "正在保存…" : status}</div>
    </dialog>}
  </section>;
}
