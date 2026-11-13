import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import GatewayConnectionPanel from "./GatewayConnectionPanel";
import { GATEWAY_SETUP_GUIDES, visibleGatewayFields } from "./gatewaySetupGuides";
function SettingsSection({children}:{children:ReactNode}):React.JSX.Element { return <section className="settings-section"><div className="settings-section-card">{children}</div></section>; }
function Row({label,desc,children}:{label:ReactNode;desc?:ReactNode;children?:ReactNode}):React.JSX.Element { return <div className="settings-row"><div><div className="settings-row-label">{label}</div>{desc && <div className="settings-row-desc">{desc}</div>}</div>{children}</div>; }
interface GatewayField {
  key: string;
  label: string;
  type?: "text" | "password" | "list";
  placeholder?: string;
}

const CHANNEL_COLORS: Record<string, string> = {
  "telegram-default": "#2AABEE",
  "feishu-default": "#3370FF",
  "wecom-default": "#0082EF",
  "wechat-default": "#07C160",
  "slack-default": "#4A154B",
  "dingtalk-default": "#0089FF",
  "discord-default": "#5865F2",
};

/** 通用通道配置块：彩色标识 + 状态圆点 + 表单 + 连接/断开 */
export default function GatewayBlock({
  channelId,
  title,
  desc,
  fields,
}: {
  channelId: string;
  title: string;
  desc: string;
  fields: GatewayField[];
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [allowUsers, setAllowUsers] = useState("");
  const [status, setStatus] = useState("");
  const [connected, setConnected] = useState(false);
  const [known, setKnown] = useState(false);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const statusEpoch = useRef(0);
  const dirty = useRef(0);
  const operationBusy = useRef(false);
  const fieldKeys = fields.map(f => f.key).join("|");
  const guide = GATEWAY_SETUP_GUIDES[channelId];
  const isSlack = channelId === "slack-default";
  const isDiscord = channelId === "discord-default";
  const requiresAllowUsers = isSlack || ["dingtalk-default", "discord-default"].includes(channelId)
    || (channelId === "feishu-default" && (values.transport === "websocket" || (!values.transport && !values.verificationToken)))
    || (channelId === "wecom-default" && (values.mode === "smart" || (!values.mode && Boolean(values.botId))));
  const [allowDirectMessages, setAllowDirectMessages] = useState(false);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const request = ++statusEpoch.current;
    const owner = lifecycle.current;
    try {
      const result = await window.api?.gateway?.status();
      const channel = result?.channels.find(c => c.id === channelId);
      if (!channel) throw new Error("状态不可用");
      if (!mounted.current || owner !== lifecycle.current || request !== statusEpoch.current) return;
      setStatus(channel.statusText ?? (channel.connected ? "已连接" : "未连接"));
      setConnected(channel.connected); setKnown(true);
    } catch {
      if (!mounted.current || owner !== lifecycle.current || request !== statusEpoch.current) return;
      setStatus("状态未知"); setKnown(false);
    }
  }, [channelId]);

  useEffect(() => {
    mounted.current = true;
    const owner = ++lifecycle.current;
    const edits = dirty.current;
    setConfigReady(false);
    void window.api?.gateway?.getChannelConfig(channelId).then(c => {
      if (!mounted.current || owner !== lifecycle.current) return;
      if (!c) throw new Error("配置不可用");
      setConfigReady(true);
      if (dirty.current !== edits) return;
      if (!c.hasConfig) {
        if (channelId === "feishu-default") setValues({ transport: "websocket" });
        if (channelId === "wecom-default") setValues({ mode: "smart" });
        return;
      }
      const values: Record<string,string> = {};
      for (const field of fields) {
        const raw = c.config[field.key];
        if (typeof raw === "string" && raw) values[field.key] = raw;
        if (field.type === "list" && Array.isArray(raw)) values[field.key] = raw.join(", ");
      }
      setValues(values);
      setAllowDirectMessages(c.config.allowDirectMessages === true);
      if (Array.isArray(c.config.allowUsers)) setAllowUsers(c.config.allowUsers.join(", "));
    }).catch(() => {
      if (!mounted.current || owner !== lifecycle.current) return;
      setConfigReady(false); setFormError("配置读取失败，请重新打开设置后重试");
    });
    void refreshStatus();
    const unsubscribe = window.api?.gateway?.onEvent(event => {
      if (event.channelId === channelId && event.direction === "system") void refreshStatus();
    });
    const timer = setInterval(() => void refreshStatus(), 5000);
    return () => { mounted.current = false; lifecycle.current++; statusEpoch.current++; clearInterval(timer); unsubscribe?.(); };
  // Field objects are presentational props; new arrays must not discard an in-progress edit.
  }, [channelId, fieldKeys, refreshStatus]);

  const connect = async (): Promise<void> => {
    if (operationBusy.current || !configReady) return;
    operationBusy.current = true;
    const owner = lifecycle.current;
    statusEpoch.current++;
    setBusy(true);
    setFormError("");
    setStatus("连接中…");
    try {
      const config: Record<string, unknown> = { ...values };
      for (const field of fields) {
        if (field.type === "list") config[field.key] = (values[field.key] ?? "").split(/[,，;；\s]+/).filter(Boolean);
      }
      if (isDiscord) config.allowDirectMessages = allowDirectMessages;
      config.allowUsers = allowUsers
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await window.api?.gateway?.connect(channelId, config);
      if (!mounted.current || owner !== lifecycle.current) return;
      setValues(v => ({ ...v, ...Object.fromEntries(fields.filter(f => f.type === "password").map(f => [f.key, "••••••"])) }));
      await refreshStatus();
    } catch (err) {
      if (mounted.current && owner === lifecycle.current) setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      operationBusy.current = false;
      if (mounted.current && owner === lifecycle.current) setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    const owner = lifecycle.current;
    statusEpoch.current++;
    setBusy(true);
    setFormError("");
    try {
      await window.api?.gateway?.disconnect(channelId);
      if (!mounted.current || owner !== lifecycle.current) return;
      await refreshStatus();
    } catch (err) {
      if (mounted.current && owner === lifecycle.current) setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      operationBusy.current = false;
      if (mounted.current && owner === lifecycle.current) setBusy(false);
    }
  };

  return (
    <SettingsSection>
      <div className="settings-card-head">
        <span className="channel-dot" style={{ background: CHANNEL_COLORS[channelId] }} />
        <span className="settings-card-title">{title}</span>
        <span className={`channel-status${known && connected ? " on" : ""}`}>{status || "未连接"}</span>
      </div>
      {formError && <div role="alert">{formError}</div>}
      <GatewayConnectionPanel title={title} connected={connected}>
      <div className="settings-card-desc">{desc}</div>
      {guide && <div className="settings-card-desc">
        <ol>{guide.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        <button type="button" className="btn" onClick={() => window.api?.browser?.openExternal?.(guide.url)}>{guide.title}</button>
      </div>}
      {visibleGatewayFields(channelId, values, fields).map((f) => (
        <Row key={f.key} label={f.label}>
          {f.key === "transport" || f.key === "mode" ? <select className="settings-input" aria-label={f.label}
            value={values[f.key] || (f.key === "transport" ? (values.verificationToken ? "webhook" : "websocket") : (values.botId ? "smart" : "callback"))}
            onChange={e => { dirty.current++; setValues(v => ({ ...v, [f.key]: e.target.value })); }}>
            {f.key === "transport" ? <><option value="websocket">WebSocket 长连接（推荐）</option><option value="webhook">Webhook 公网回调</option></>
              : <><option value="smart">Smart 智能机器人长连接（推荐）</option><option value="callback">Callback 自建应用回调</option></>}
          </select> : <input
            className="settings-input"
            type={f.type === "password" ? "password" : "text"}
            aria-label={f.label}
            autoComplete={f.type === "password" ? "new-password" : "off"}
            value={values[f.key] ?? ""}
            placeholder={f.placeholder ?? ""}
            onChange={(e) => { dirty.current++; setValues((v) => ({ ...v, [f.key]: e.target.value })); }}
          />}
        </Row>
      ))}
      {isDiscord && <Row label="允许 Discord 私聊" desc="默认关闭；打开后也仅允许下方用户 ID。">
        <input type="checkbox" aria-label="允许 Discord 私聊" checked={allowDirectMessages} onChange={e => { dirty.current++; setAllowDirectMessages(e.target.checked); }} />
      </Row>}
      <Row label="允许的用户" desc={isSlack ? "必填：允许触发机器人的 Slack Member ID，逗号分隔。" : requiresAllowUsers ? "必填：平台用户 ID（钉钉为员工 senderStaffId），逗号分隔。" : "只允许这些用户使用，逗号分隔；留空则谁都能用。"}>
        <input
          className="settings-input"
          aria-label={isSlack ? "允许的 Slack 用户" : undefined}
          value={allowUsers}
          placeholder={isSlack ? "U0123456789" : "user1, user2"}
          onChange={(e) => { dirty.current++; setAllowUsers(e.target.value); }}
        />
      </Row>
      <div className="settings-card-footer">
        <button className="btn primary" disabled={!known || !configReady || busy || (requiresAllowUsers && !allowUsers.trim()) || (isSlack && (!allowUsers.trim() || !values.appId?.trim() || !values.teamId?.trim() || !values.botToken?.trim() || !values.appToken?.trim()))} onClick={() => void connect()}>
          {connected ? "保存并重新连接" : "连接"}
        </button>
        {connected && <button className="btn" disabled={!known || busy} onClick={() => void disconnect()}>
          断开
        </button>}
      </div>
      </GatewayConnectionPanel>
    </SettingsSection>
  );
}
