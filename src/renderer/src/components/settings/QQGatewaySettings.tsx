import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { GatewayQQQrLoginStateDto } from "@shared/agent-ipc";

const idle: GatewayQQQrLoginStateDto = { state: "idle", message: "尚未开始扫码授权" };
const pending = (state: GatewayQQQrLoginStateDto) => state.state === "waiting" || state.state === "binding";

/** Enrollment is user initiated. No credential fields or automatic start on mount. */
export default function QQGatewaySettings(): React.JSX.Element {
  const [state, setState] = useState(idle);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const mounted = useRef(false);
  const epoch = useRef(0);
  const requestBusy = useRef(false);
  const current = useRef(state);
  const apply = useCallback((next: GatewayQQQrLoginStateDto) => {
    current.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(async () => {
    const status = await window.api?.gateway?.status();
    if (mounted.current) setConnected(Boolean(status?.channels.find(channel => channel.id === "qq-default")?.connected));
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    return () => {
      mounted.current = false;
      epoch.current++;
      if (pending(current.current) && current.current.sessionId) {
        void window.api?.gateway?.qqQrCancel(current.current.sessionId).catch(() => {});
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
    const poll = async () => {
      try {
        const next = await window.api?.gateway?.qqQrState();
        if (disposed || !mounted.current || current.current.sessionId !== sessionId) return;
        if (next && next.sessionId !== sessionId) {
          apply({ state: "cancelled", sessionId, message: "扫码已由新请求替代或取消" });
          setApproved(false);
          return;
        }
        if (next?.sessionId === sessionId) {
          apply(next);
          if (!pending(next)) { setApproved(false); void refresh().catch(() => {}); return; }
        }
      } catch { /* Retry polling without exposing provider error details. */ }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
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
      const next = await window.api?.gateway?.qqQrStart(true);
      if (!next) throw new Error("unavailable");
      if (!mounted.current || epoch.current !== attempt) {
        if (next.sessionId) await window.api?.gateway?.qqQrCancel(next.sessionId);
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
      const next = await window.api?.gateway?.qqQrCancel(current.current.sessionId);
      if (mounted.current) apply(next ?? { state: "cancelled", message: "扫码已取消" });
    } catch { if (mounted.current) apply({ ...current.current, message: "取消状态未确认，请重试取消" }); }
    finally { if (mounted.current) { setBusy(false); setApproved(false); } }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await window.api?.gateway?.disconnect("qq-default");
      if (mounted.current) { apply({ state: "cancelled", message: "QQ 已断开；如需撤销平台授权，请在 QQ 官方平台管理" }); setApproved(false); }
      await refresh();
    } catch { if (mounted.current) apply({ state: "error", message: "断开未确认，请重试" }); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <section className="settings-section" aria-label="QQ 扫码授权">
    <div className="settings-section-card">
      <div className="settings-card-head"><span className="settings-card-title">QQ 扫码机器人</span><span className={`channel-status${connected ? " on" : ""}`}>{connected ? "已连接" : "未连接"}</span></div>
      <div className="settings-card-desc">使用手机 QQ 扫描官方授权二维码，接入 QQ 机器人；不是个人聊天账号托管，也不会导入个人聊天历史。仅允许扫码用户发给机器人的消息，暂不支持主动 Work 通知。</div>
      <label style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <input type="checkbox" aria-label="同意 QQ 持久访问授权" checked={approved} disabled={busy || pending(state)} onChange={event => setApproved(event.target.checked)} />
        <span>我同意申请 QQ 机器人凭据，并由此应用加密保存，用于持续接收和回复我的机器人消息；下次启动时可恢复连接。扫码后仍需在手机端确认。</span>
      </label>
      <div role="status">{state.message}</div>
      {qrImage && <img src={qrImage} width={224} height={224} alt="QQ 官方授权二维码" />}
      {state.state === "waiting" && !qrImage && <div>正在准备二维码…</div>}
      <div className="settings-card-footer">
        <button className="btn primary" disabled={!approved || busy || pending(state)} onClick={() => void start()}>开始扫码授权</button>
        <button className="btn" disabled={busy || !pending(state)} onClick={() => void cancel()}>取消扫码</button>
        <button className="btn" disabled={busy || pending(state) || !connected} onClick={() => void disconnect()}>断开 QQ</button>
      </div>
    </div>
  </section>;
}
