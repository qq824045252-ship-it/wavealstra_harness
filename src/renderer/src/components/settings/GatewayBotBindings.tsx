import { useCallback, useEffect, useState } from "react";
import type { GatewayStatusDto } from "@shared/agent-ipc";
import type { BotDto } from "@shared/bot-work";
import type { GatewayBotBinding } from "@shared/gateway-bot-binding";
import "./GatewayBotBindings.css";

export default function GatewayBotBindings(): React.JSX.Element {
  const [channels, setChannels] = useState<GatewayStatusDto["channels"]>([]);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [bindings, setBindings] = useState<Record<string, GatewayBotBinding>>({});
  const [channelId, setChannelId] = useState("");
  const [botId, setBotId] = useState("");
  const [senders, setSenders] = useState("");
  const [recentSenders, setRecentSenders] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const refresh = useCallback(async () => {
    const api = window.api;
    if (!api) throw new Error("应用接口尚未就绪，请重新打开设置");
    const [status, availableBots, settings] = await Promise.all([
      api.gateway.status(), api.botWork.listBots(), api.agent.getAppSettings(),
    ]);
    setChannels(status.channels);
    setBots(availableBots.filter(bot => bot.status === "active"));
    setBindings(settings.gatewayBotBindings ?? {});
    setChannelId(prior => prior || status.channels.find(channel => channel.connected)?.id || status.channels[0]?.id || "");
  }, []);
  useEffect(() => {
    let current = true;
    void refresh().catch(error => { if (current) setNotice({ kind: "error", text: String(error) }); });
    const unsubscribe = window.api?.gateway.onEvent(event => {
      if (current && event.direction === "system") void window.api?.gateway.status()
        .then(status => { if (current) setChannels(status.channels); }).catch(() => {});
    });
    return () => { current = false; unsubscribe?.(); };
  }, [refresh]);
  useEffect(() => {
    const binding = bindings[channelId];
    setBotId(binding?.botId ?? "");
    setSenders(binding?.ownerSenderIds.join(", ") ?? "");
  }, [channelId, bindings]);
  useEffect(() => {
    let current = true;
    setRecentSenders([]);
    const add = (id: string, name?: string) => setRecentSenders(prior =>
      prior.some(item => item.id === id) ? prior : [...prior, { id, name: name || id }].slice(-20));
    void window.api?.gateway.listMessages({ channelId, limit: 50 }).then(messages => {
      if (current) for (const message of messages) if (message.direction === "in" && message.senderId) add(message.senderId, message.senderName);
    }).catch(() => {});
    const unsubscribe = window.api?.gateway.onEvent(event => {
      if (current && event.channelId === channelId && event.direction === "in" && event.senderId) add(event.senderId, event.senderName);
    });
    return () => { current = false; unsubscribe?.(); };
  }, [channelId]);
  const save = async (remove: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const api = window.api;
      if (!api) throw new Error("应用接口尚未就绪，请重新打开设置");
      const next = await api.gateway.configureBotBinding(remove
        ? { action: "unbind", channelId }
        : { action: "bind", channelId, botId, ownerSenderIds: senders.split(/[,，\n]/).map(value => value.trim()).filter(Boolean) });
      setBindings(next);
      setNotice({ kind: "success", text: remove ? "已解除绑定" : "绑定已保存，后续来信由所选 Bot 接待" });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const channel = channels.find(item => item.id === channelId);
  const senderIds = [...new Set(senders.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  const isBound = Boolean(bindings[channelId]);
  return <section className="settings-section gateway-assistant-section" aria-label="渠道个人助理绑定">
    <div className="settings-section-card gateway-assistant-card">
    <header className="gateway-assistant-heading">
      <div><h3>渠道中的个人助理</h3><p>选择由谁接待，以及哪个账号是你本人。</p></div>
      <span className={`gateway-assistant-status${channel?.connected ? " connected" : ""}`}>{channel?.connected ? isBound ? "已绑定" : "待绑定" : "未连接"}</span>
    </header>
    <div className="gateway-assistant-fields">
    <label className="gateway-assistant-field"><span>渠道</span>
      <select disabled={busy} value={channelId} onChange={event => { setChannelId(event.target.value); setNotice(null); }}>
        {channels.map(item => <option key={item.id} value={item.id}>{item.name}{item.connected ? " · 已连接" : " · 未连接"}</option>)}
      </select>
    </label>
    <label className="gateway-assistant-field"><span>接待你的 Bot</span>
      <select disabled={busy} value={botId} onChange={event => setBotId(event.target.value)}>
        <option value="">选择个人 Bot</option>
        {bots.map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
      </select>
    </label>
    </div>
    <div className="gateway-assistant-account">
    <label className="gateway-assistant-field"><span>你的渠道账号</span>
      <select disabled={busy || !recentSenders.length} value="" onChange={event => {
        const selected = event.target.value;
        if (selected) setSenders(prior => [...new Set([...prior.split(/[,，\n]/).map(value => value.trim()).filter(Boolean), selected])].join(", "));
      }}>
        <option value="">{recentSenders.length ? "从最近来信中选择自己" : "收到你的来信后，即可在这里选择"}</option>
        {recentSenders.map(sender => <option key={sender.id} value={sender.id}>{sender.name} · {sender.id}</option>)}
      </select>
    </label>
    {!recentSenders.length && <p className="gateway-assistant-hint">{channel?.connected ? "用自己的账号给机器人发一句话，再回来选择本人账号。" : "先连接上方的渠道，再完成账号绑定。"}</p>}
    {senderIds.length > 0 && <div className="gateway-assistant-accounts">{senderIds.map(id => <span className="gateway-assistant-account-chip" key={id} title={id}>
      <span>{recentSenders.find(sender => sender.id === id)?.name || `${id.slice(0, 7)}${id.length > 11 ? "…" + id.slice(-4) : ""}`}</span>
      <button type="button" disabled={busy} aria-label={`移除账号 ${id}`} onClick={() => setSenders(senderIds.filter(value => value !== id).join(", "))}>×</button>
    </span>)}</div>}
    <details className="gateway-assistant-manual"><summary>手动填写账号 ID</summary>
      <label className="gateway-assistant-field"><span className="gateway-assistant-sr-only">你自己的平台用户 ID</span>
        <input disabled={busy} value={senders} onChange={event => setSenders(event.target.value)} placeholder="多个本人账号 ID 用逗号分隔" />
      </label>
      <p className="gateway-assistant-hint">QQ 填发送者 openid，钉钉填员工 senderStaffId，Discord 填用户 ID。请勿填写群或机器人 ID。</p>
    </details>
    </div>
    <footer className="gateway-assistant-footer">
      <p>仅本人账号可接续私人记忆；群聊保持独立。</p>
      <div className="gateway-assistant-actions">
        {isBound && <button className="btn" disabled={busy} onClick={() => void save(true)}>解除绑定</button>}
        <button className="btn primary" disabled={busy || !channel?.connected || !botId || !senderIds.length} onClick={() => void save(false)}>{busy ? "保存中…" : "保存绑定"}</button>
      </div>
    </footer>
    {notice && <p role={notice.kind === "error" ? "alert" : "status"} className={`gateway-assistant-notice ${notice.kind}`}>{notice.text}</p>}
    </div>
  </section>;
}
