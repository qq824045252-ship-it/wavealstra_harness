import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import GatewayConnectionPanel from "./GatewayConnectionPanel";
import type { GatewayWeixinQrLoginStateDto } from "@shared/agent-ipc";

const idle: GatewayWeixinQrLoginStateDto = { state: "idle", message: "尚未开始扫码授权" };
const pending = (state: GatewayWeixinQrLoginStateDto) => state.state === "waiting" || state.state === "binding";

/** Enrollment is user initiated. No credential fields or automatic start on mount. */
export default function WeixinGatewaySettings(): React.JSX.Element {
  const [state, setState] = useState(idle);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [known, setKnown] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const mounted = useRef(false);
  const statusEpoch = useRef(0);
  const epoch = useRef(0);
  const requestBusy = useRef(false);
  const current = useRef(state);
  const apply = useCallback((next: GatewayWeixinQrLoginStateDto) => {
    current.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++statusEpoch.current;
    try {
      const status = await window.api?.gateway?.status();
      const channel = status?.channels.find(channel => channel.id === "weixin-default");
      if (!channel) throw new Error("unavailable");
      if (mounted.current && request === statusEpoch.current) { setConnected(channel.connected); setKnown(true); }
    } catch { if (mounted.current && request === statusEpoch.current) setKnown(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const unsubscribe = window.api?.gateway?.onEvent?.(event => {
      if (event.channelId === "weixin-default" && event.direction === "system") void refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe?.();
      mounted.current = false;
      statusEpoch.current++;
      epoch.current++;
      if (pending(current.current) && current.current.sessionId) {
        void window.api?.gateway?.weixinQrCancel(current.current.sessionId).catch(() => {});
      }
    };
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    setQrImage("");
    if (state.qrUrl && state.state === "waiting") {
      void QRCode.toDataURL(state.qrUrl, { width: 224, margin: 2 }).then(image => {
        if (!disposed) setQrImage(image);
      }).catch(() => { if (!disposed) setQrImage(""); });
    }
    return () => { disposed = true; };
  }, [state.qrUrl, state.state]);

  useEffect(() => {
    if (!pending(state) || !state.sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const sessionId = state.sessionId;
    const pollEpoch = epoch.current;
    const poll = async () => {
      try {
        const next = await window.api?.gateway?.weixinQrState();
        if (disposed || !mounted.current || epoch.current !== pollEpoch || !pending(current.current) || current.current.sessionId !== sessionId) return;
        if (next && next.sessionId !== sessionId) {
          apply({ state: "cancelled", sessionId, message: "扫码已由新请求替代或取消" });
          setApproved(false);
          return;
        }
        if (next?.sessionId === sessionId) {
          apply(next);
          if (!pending(next)) { setApproved(false); if (next.state === "connected") setReauthorizing(false); void refresh(); return; }
        }
      } catch { /* Retry polling without exposing provider error details. */ }
      if (!disposed && epoch.current === pollEpoch) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [state.sessionId, state.state, apply, refresh]);

  const start = async () => {
    if (!approved || requestBusy.current || pending(current.current)) return;
    requestBusy.current = true;
    const attempt = ++epoch.current;
    setBusy(true);
    try {
      const next = await window.api?.gateway?.weixinQrStart(true);
      if (!next) throw new Error("unavailable");
      if (!mounted.current || epoch.current !== attempt) {
        if (next.sessionId) await window.api?.gateway?.weixinQrCancel(next.sessionId);
        return;
      }
      apply(next);
    } catch {
      if (mounted.current && epoch.current === attempt) apply({ state: "error", message: "扫码启动失败，请检查网络和系统凭据加密后重试" });
    } finally { requestBusy.current = false; if (mounted.current && epoch.current === attempt) setBusy(false); }
  };
  const cancel = async () => {
    ++epoch.current;
    setBusy(true);
    try {
      const next = await window.api?.gateway?.weixinQrCancel(current.current.sessionId);
      if (mounted.current) apply(next ?? { state: "cancelled", message: "扫码已取消" });
    } catch { if (mounted.current) apply({ ...current.current, message: "取消状态未确认，请重试取消" }); }
    finally { if (mounted.current) { setBusy(false); setApproved(false); } }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await window.api?.gateway?.disconnect("weixin-default");
      if (mounted.current) { apply({ state: "cancelled", message: "微信 已断开；如需撤销平台授权，请在 微信 官方平台管理" }); setApproved(false); }
      await refresh();
    } catch { if (mounted.current) apply({ state: "error", message: "断开未确认，请重试" }); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <section className="settings-section" aria-label="微信 扫码授权">
    <div className="settings-section-card">
      <div className="settings-card-head"><span className="settings-card-title">微信 扫码机器人</span><span className={`channel-status${known && connected ? " on" : ""}`}>{!known ? "状态未知" : connected ? "已连接" : "未连接"}</span></div>
      {state.state === "error" && connected && !reauthorizing && <div role="alert">{state.message}</div>}
      <GatewayConnectionPanel title="微信" connected={connected}>
      <div className="settings-card-desc">通过微信 iLink Bot 扫码接入，采用 Hermes 直接消息通道。只接受扫码用户的消息，不导入个人聊天历史。</div>
      {known && connected && !reauthorizing && <div role="status">已连接，后续启动将尝试恢复；无需重复扫码。</div>}
      {(!connected || reauthorizing) && <>
      <label style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <input type="checkbox" aria-label="同意 微信 持久访问授权" checked={approved} disabled={busy || pending(state)} onChange={event => setApproved(event.target.checked)} />
        <span>我同意申请 微信 机器人凭据，并由此应用加密保存，用于持续接收和回复我的机器人消息；下次启动时可恢复连接。扫码后仍需在手机端确认。</span>
      </label>
      <div role="status">{state.message}</div>
      {qrImage && <img src={qrImage} width={224} height={224} alt="微信 官方授权二维码" />}
      {state.state === "waiting" && !qrImage && <div>正在准备二维码…</div>}
      </>}
      <div className="settings-card-footer">
        {connected && !reauthorizing ? <button className="btn" disabled={busy} onClick={() => { setReauthorizing(true); setApproved(false); }}>重新授权</button>
          : <button className="btn primary" disabled={!known || !approved || busy || pending(state)} onClick={() => void start()}>开始扫码授权</button>}
        {pending(state) && <button className="btn" disabled={busy} onClick={() => void cancel()}>取消扫码</button>}
        {connected && <button className="btn" disabled={!known || busy || pending(state)} onClick={() => void disconnect()}>断开 微信</button>}
      </div>
      </GatewayConnectionPanel>
    </div>
  </section>;
}
