import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayStatusDto } from "@shared/agent-ipc";
import type { BotDto } from "@shared/bot-work";
import type { GatewayBotBinding } from "@shared/gateway-bot-binding";
import "./GatewayBotBindings.css";

type Notice = { kind: "success" | "error"; text: string };
type Draft = { channelId: string; botId: string; senders: string; editing: boolean; connectionRevision: string };
const parseSenders = (value: string) => [...new Set(value.split(/[,，\n]/).map(id => id.trim()).filter(Boolean))];

export default function GatewayBotBindings(): React.JSX.Element {
  const [channels, setChannels] = useState<GatewayStatusDto["channels"]>([]);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [bindings, setBindings] = useState<Record<string, GatewayBotBinding>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [recentSenders, setRecentSenders] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(false);
  const mutation = useRef(false);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setLoading(true);
    try {
      const api = window.api;
      if (!api) throw new Error("应用接口尚未就绪，请重新打开设置");
      const [status, availableBots, settings] = await Promise.all([
        api.gateway.status(), api.botWork.listBots(), api.agent.getAppSettings(),
      ]);
      if (!mounted.current || version !== refreshVersion.current) return;
      setChannels(status.channels);
      setBots(availableBots);
      setBindings(settings.gatewayBotBindings ?? {});
    } catch (error) {
      if (mounted.current && version === refreshVersion.current) setNotice({ kind: "error", text: String(error) });
    } finally {
      if (mounted.current && version === refreshVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let statusVersion = 0;
    const unsubscribe = window.api?.gateway.onEvent(event => {
      if (event.direction !== "system") return;
      const version = ++statusVersion;
      void window.api?.gateway.status().then(status => {
        if (mounted.current && version === statusVersion) setChannels(status.channels);
      }).catch(error => { if (mounted.current) setNotice({ kind: "error", text: String(error) }); });
    });
    return () => { mounted.current = false; refreshVersion.current++; unsubscribe?.(); };
  }, [refresh]);
  const channelId = draft?.channelId ?? "";
  const suggestionKey = channels.find(item => item.id === channelId)?.bindingConnectionKey;
  const suggestionRevision = channels.find(item => item.id === channelId)?.bindingRevision;
  useEffect(() => {
    let current = true;
    setRecentSenders([]);
    if (!channelId) return;
    const add = (id: string, name?: string) => setRecentSenders(prior =>
      prior.some(item => item.id === id) ? prior : [...prior, { id, name: name || id }].slice(-20));
    // Legacy message history has no receiving-account identity. Never suggest its senders.
    const unsubscribe = window.api?.gateway.onEvent(event => {
      if (current && suggestionKey && event.bindingConnectionKey === suggestionKey && event.channelId === channelId && event.direction === "in" && event.senderId) add(event.senderId, event.senderName);
    });
    return () => { current = false; unsubscribe?.(); };
  }, [channelId, suggestionKey, suggestionRevision, draft?.connectionRevision]);
  const configure = async (request: Parameters<NonNullable<typeof window.api>["gateway"]["configureBotBinding"]>[0]) => {
    if (mutation.current) return;
    mutation.current = true;
    refreshVersion.current++;
    setBusy(true);
    setNotice(null);
    try {
      const api = window.api;
      if (!api) throw new Error("应用接口尚未就绪，请重新打开设置");
      const next = await api.gateway.configureBotBinding(request);
      if (!mounted.current) return;
      setBindings(next);
      setDraft(null);
      setNotice({ kind: "success", text: request.action === "unbind" ? "已解除绑定，已有对话、任务和成果不受影响" : "绑定已保存，后续本人来信由所选 Bot 接待" });
    } catch (error) {
      if (mounted.current) setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      mutation.current = false;
      if (mounted.current) { setBusy(false); setLoading(false); }
    }
  };
  const edit = (id: string) => {
    const binding = bindings[id];
    const currentChannel = channels.find(item => item.id === id);
    const changedAccount = currentChannel?.bindingConnectionKey !== binding.connectionKey;
    setDraft({ channelId: id, botId: binding.botId, senders: changedAccount ? "" : binding.ownerSenderIds.join(", "), editing: true, connectionRevision: currentChannel?.bindingRevision ?? "" });
    setNotice(changedAccount ? { kind: "error", text: "渠道账号已变化，请重新选择本人账号后保存" } : null);
  };
  const unbound = channels.filter(channel => !bindings[channel.id]);
  const activeBots = bots.filter(bot => bot.status === "active");
  const channel = channels.find(item => item.id === channelId);
  const senderIds = parseSenders(draft?.senders ?? "");
  const identityChanged = Boolean(draft && (!draft.connectionRevision || draft.connectionRevision !== channel?.bindingRevision));
  const rows = Object.entries(bindings);
  const patchDraft = (patch: Partial<Draft>) => setDraft(prior => prior ? { ...prior, ...patch } : prior);
  return <section className="settings-section gateway-assistant-section" aria-label="渠道个人助理绑定">
    <div className="settings-section-card gateway-assistant-card">
      <header className="gateway-assistant-heading">
        <div><h3>渠道中的个人助理</h3><p>连接渠道后，绑定本人账号与接待 Bot。每个渠道使用一个个人 Bot。</p></div>
        <span className="gateway-assistant-status">{loading ? "读取中…" : `${rows.length} 个已保存绑定`}</span>
      </header>
      <div className="gateway-assistant-toolbar">
        <button className="btn" disabled={busy || loading || Boolean(draft)} onClick={() => void refresh()}>刷新绑定</button>
        <button className="btn" disabled={busy || loading || Boolean(draft) || !unbound.length} onClick={() => {
          const target = unbound.find(item => item.connected) ?? unbound[0];
          setDraft({ channelId: target?.id ?? "", botId: "", senders: "", editing: false, connectionRevision: target?.bindingRevision ?? "" });
          setNotice(null);
        }}>新增绑定</button>
      </div>
      {!loading && !rows.length && <p className="gateway-assistant-empty">尚未绑定个人助理。先连接渠道，再新增绑定。</p>}
      <ul className="gateway-assistant-list" aria-label="已保存的渠道绑定">
        {rows.map(([id, binding]) => {
          const item = channels.find(value => value.id === id);
          const bot = bots.find(value => value.botId === binding.botId);
          const accountChanged = Boolean(item?.bindingConnectionKey && item.bindingConnectionKey !== binding.connectionKey);
          return <li className="gateway-assistant-binding" key={id} data-channel-id={id}>
            <div className="gateway-assistant-binding-info">
              <strong>{item?.name ?? id}</strong>
              <span className={`gateway-assistant-status${item?.connected ? " connected" : ""}`}>{item?.connected ? accountChanged ? "账号已变化 · 需重新绑定" : "渠道已连接" : "渠道未连接"}</span>
              <p>接待 Bot：{bot?.displayName ?? binding.botId}{!bot || bot.status !== "active" ? "（不可用，请重新选择）" : ""}</p>
              <p>本人账号：<span className="gateway-assistant-owner-ids">{binding.ownerSenderIds.join("、")}</span></p>
              <p className="gateway-assistant-hint">{!item?.connected ? "绑定已保留，连接渠道后恢复；更换渠道账号需重新保存绑定。" : "更换渠道账号后需重新保存绑定，连接状态不代表身份匹配。"}</p>
            </div>
            <div className="gateway-assistant-actions">
              <button className="btn" disabled={busy || loading || Boolean(draft)} onClick={() => edit(id)}>编辑绑定</button>
              <button className="btn" disabled={busy || loading || Boolean(draft)} onClick={() => void configure({ action: "unbind", channelId: id })}>解除绑定</button>
            </div>
          </li>;
        })}
      </ul>
      {draft && <div className="gateway-assistant-editor" aria-label={draft.editing ? "编辑渠道绑定" : "新增渠道绑定"}>
        <h4>{draft.editing ? "编辑绑定" : "新增绑定"}</h4>
        {identityChanged && <div role="alert" className="gateway-assistant-notice error">渠道连接或账号已变化，旧账号选择不能保存。
          <button className="btn" disabled={busy || !channel?.bindingRevision} onClick={() => { patchDraft({ senders: "", connectionRevision: channel?.bindingRevision ?? "" }); setRecentSenders([]); }}>重新选择本人账号</button>
        </div>}
        <div className="gateway-assistant-fields">
          <label className="gateway-assistant-field"><span>渠道</span>
            <select disabled={busy || draft.editing} value={channelId} onChange={event => { patchDraft({ channelId: event.target.value, senders: "", connectionRevision: channels.find(item => item.id === event.target.value)?.bindingRevision ?? "" }); setNotice(null); }}>
              {(draft.editing ? [{ id: channelId, name: channel?.name ?? channelId, connected: channel?.connected }] : unbound).map(item => <option key={item.id} value={item.id}>{item.name}{item.connected ? " · 已连接" : " · 未连接"}</option>)}
            </select>
          </label>
          <label className="gateway-assistant-field"><span>接待你的 Bot</span>
            <select disabled={busy} value={draft.botId} onChange={event => patchDraft({ botId: event.target.value })}>
              <option value="">选择个人 Bot</option>
              {draft.botId && !activeBots.some(bot => bot.botId === draft.botId) && <option value={draft.botId} disabled>原 Bot 不可用，请重新选择</option>}
              {activeBots.map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
            </select>
          </label>
        </div>
        <div className="gateway-assistant-account">
          <label className="gateway-assistant-field"><span>你的渠道账号</span>
            <select disabled={busy || identityChanged || !recentSenders.length} value="" onChange={event => {
              if (event.target.value) patchDraft({ senders: [...new Set([...senderIds, event.target.value])].join(", ") });
            }}>
              <option value="">{recentSenders.length ? "从当前连接的新来信中选择自己" : "收到你的来信后，即可在这里选择"}</option>
              {recentSenders.map(sender => <option key={sender.id} value={sender.id}>{sender.name} · {sender.id}</option>)}
            </select>
          </label>
          {!recentSenders.length && <p className="gateway-assistant-hint">{channel?.connected ? "请先在渠道配置的允许名单中加入本人账号，再保持此页面打开并给当前机器人发一句话；只有当前连接的已授权新来信可选，旧历史不用于绑定。" : "请先连接渠道；现有绑定不会因断线被删除。"}</p>}
          {senderIds.length > 0 && <div className="gateway-assistant-accounts">{senderIds.map(id => <span className="gateway-assistant-account-chip" key={id} title={id}>
            <span>{recentSenders.find(sender => sender.id === id)?.name || id}</span>
            <button type="button" disabled={busy} aria-label={`移除账号 ${id}`} onClick={() => patchDraft({ senders: senderIds.filter(value => value !== id).join(", ") })}>×</button>
          </span>)}</div>}
          <details className="gateway-assistant-manual"><summary>手动填写账号 ID</summary>
            <label className="gateway-assistant-field"><span className="gateway-assistant-sr-only">你自己的平台用户 ID</span>
              <textarea disabled={busy || identityChanged} value={draft.senders} onChange={event => patchDraft({ senders: event.target.value })} placeholder="多个本人账号 ID 用逗号或换行分隔" />
            </label>
            <p className="gateway-assistant-hint">QQ 填发送者 openid，钉钉填员工 senderStaffId，Discord 填用户 ID。请勿填写群或机器人 ID。</p>
          </details>
        </div>
        <footer className="gateway-assistant-footer">
          <p>仅本人账号可接续私人记忆；群聊保持独立。</p>
          <div className="gateway-assistant-actions">
            <button className="btn" disabled={busy} onClick={() => { setDraft(null); setNotice(null); }}>取消</button>
            <button className="btn primary" disabled={busy || identityChanged || !channel?.connected || !activeBots.some(bot => bot.botId === draft.botId) || !senderIds.length || senderIds.length > 100 || senderIds.some(id => id.length > 512)} onClick={() => void configure({ action: "bind", channelId, botId: draft.botId, ownerSenderIds: senderIds, connectionRevision: draft.connectionRevision })}>{busy ? "保存中…" : "保存绑定"}</button>
          </div>
        </footer>
      </div>}
      {notice && <p role={notice.kind === "error" ? "alert" : "status"} className={`gateway-assistant-notice ${notice.kind}`}>{notice.text}</p>}
    </div>
  </section>;
}
