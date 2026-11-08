import { useEffect, useRef, useState } from "react";
import { botCreateRequestSchema, type BotCreateRequest } from "@shared/bot-create";
import type { BotDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";
import { IconBot, IconCheck, IconX } from "@/components/common/icons";

const pendingKey = "mybuddy.pending-bot-creation";

function readPending(): BotCreateRequest | null {
  try {
    const result = botCreateRequestSchema.safeParse(JSON.parse(localStorage.getItem(pendingKey) ?? "null"));
    return result.success ? result.data : null;
  } catch { return null; }
}

function forgetPending(requestId: string): void {
  try { if (readPending()?.requestId === requestId) localStorage.removeItem(pendingKey); } catch { /* A replay is safe if storage cannot be cleared. */ }
}

/** Creating an identity never sends a message or starts a Task/Work. */
export function BotCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(readPending);
  const [name, setName] = useState(() => pending?.displayName ?? "");
  const [responsibility, setResponsibility] = useState(() => pending?.responsibilitySummary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<BotDto | null>(null);
  const inFlight = useRef(false);
  const intentEpoch = useRef(0);
  const openRef = useRef(open);
  const mounted = useRef(true);
  const previousOpen = useRef(open);
  if (previousOpen.current !== open) { intentEpoch.current += 1; previousOpen.current = open; }
  openRef.current = open;
  const bots = useAppStore(state => state.botIdentities);
  const duplicateName = bots.some(bot => bot.displayName.toLocaleLowerCase() === name.trim().toLocaleLowerCase());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; intentEpoch.current += 1; };
  }, []);
  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (state.page !== previous.page || state.activeBotId !== previous.activeBotId
      || state.selectedWorkId !== previous.selectedWorkId || state.activeTaskId !== previous.activeTaskId) {
      // A -> B -> A is still newer user navigation. Do not compare only final values.
      intentEpoch.current += 1;
    }
  }), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) { dialog?.showModal(); if (!nameRef.current?.disabled) nameRef.current?.focus(); }
    else if (!open && dialog?.open) dialog.close();
  }, [open]);

  const close = () => { intentEpoch.current += 1; openRef.current = false; onClose(); };
  const reset = () => { setPending(null); setName(""); setResponsibility(""); setCreated(null); setError(""); };
  const openBot = (bot: BotDto) => {
    const state = useAppStore.getState();
    state.setActiveBotId(bot.botId);
    state.setPage("bot");
    reset(); close();
  };
  const submit = async () => {
    if (inFlight.current || (!pending && (!name.trim() || duplicateName))) return;
    const request = pending ?? { requestId: crypto.randomUUID(), displayName: name.trim(), responsibilitySummary: responsibility.trim() };
    const parsed = botCreateRequestSchema.safeParse(request);
    if (!parsed.success) { setError("请填写 1–80 字的名称，职责说明最多 2000 字。"); return; }
    // Save before dispatch. Reloads and lost acknowledgements retry the same identity.
    try { localStorage.setItem(pendingKey, JSON.stringify(parsed.data)); }
    catch { setError("无法保存创建请求，请检查本地存储后重试。尚未创建 Bot。"); return; }
    setPending(parsed.data); setError(""); setBusy(true); inFlight.current = true;
    const epoch = intentEpoch.current;
    try {
      const result = await useAppStore.getState().createBot(parsed.data);
      if (result.ok) {
        forgetPending(parsed.data.requestId);
        if (!mounted.current) return;
        setPending(null); setCreated(result.bot);
        if (openRef.current && intentEpoch.current === epoch) openBot(result.bot);
      } else {
        // A storage error or lost host/window authority cannot prove that an earlier
        // attempt did not commit. Retain its identity until it can be reconciled.
        const definitiveFailure = result.code === "invalid_request" || result.code === "duplicate_name" || result.code === "request_conflict";
        if (definitiveFailure) forgetPending(parsed.data.requestId);
        if (!mounted.current) return;
        if (definitiveFailure) setPending(null);
        setError(result.message);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "尚未确认创建结果，请按原请求重试。");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <dialog ref={dialogRef} className="bot-create-dialog" aria-labelledby="bot-create-title" aria-describedby="bot-create-intro"
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDownCapture={event => {
      if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") close();
    }}>
    <header className="bot-create-header"><span className="bot-avatar" aria-hidden="true"><IconBot size={20} /></span>
      <div><h2 id="bot-create-title">新建 Bot</h2><p id="bot-create-intro">一个有自己职责的长期助理</p></div>
      <button type="button" className="icon-btn" aria-label="关闭新建 Bot" onClick={close}><IconX size={18} /></button>
    </header>
    {created ? <section className="bot-create-success" aria-live="polite"><IconCheck size={28} /><h3>已创建 {created.displayName}</h3>
      <p>它已出现在「我的 Bot」中。你可以打开对话，或继续创建其他 Bot。</p>
      <div className="bot-create-actions"><button type="button" onClick={reset}>再创建一个</button><button type="button" className="bot-create-primary" onClick={() => openBot(created)}>打开 Bot</button></div>
    </section> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>为它起个名字，说明主要负责什么。对话、事项与私人记忆会按 Bot 分开。</p>
      <label htmlFor="bot-create-name">名称 <span>必填</span></label>
      <input ref={nameRef} id="bot-create-name" name="displayName" value={name} onChange={event => { setName(event.target.value); setError(""); }}
        maxLength={80} required disabled={Boolean(pending)} placeholder="例如：学习搭档" autoComplete="off" />
      {!pending && duplicateName && <p className="bot-create-error" role="status">这个名称已经在使用，请换一个名称。</p>}
      <label htmlFor="bot-create-responsibility">主要职责 <span>选填</span></label>
      <textarea id="bot-create-responsibility" name="responsibilitySummary" value={responsibility} onChange={event => { setResponsibility(event.target.value); setError(""); }}
        maxLength={2000} disabled={Boolean(pending)} placeholder="例如：帮我拆解学习目标、整理材料，按我确认的计划跟进。" rows={4} />
      <p className="bot-create-boundary">默认使用基础协调能力。创建不会自动执行任务、连接外部服务或扩大操作权限。</p>
      {error && <p className="bot-create-error" role="alert">{error}</p>}
      {pending && <p className="bot-create-pending" role="status">{busy ? "正在创建。关闭窗口不会撤销已提交的请求。" : "上次创建结果尚未确认。重试会核对原请求，不会重复创建。"}</p>}
      <footer className="bot-create-actions"><button type="button" onClick={close}>{pending ? "关闭" : "取消"}</button>
        <button type="submit" className="bot-create-primary" disabled={busy || (!pending && (!name.trim() || duplicateName))}>{busy ? "正在创建…" : pending ? "核对并重试" : "创建 Bot"}</button>
      </footer>
    </form>}
  </dialog>;
}
