import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { GatewayRegistrationProvider, GatewayRegistrationState } from "@shared/gateway-registration";
const gateway = () => { if (!window.api?.gateway) throw new Error("Gateway unavailable"); return window.api.gateway; };
const idle: GatewayRegistrationState = { state: "idle", message: "扫码创建机器人，或使用下方手工接入已有机器人" };
const active = (s: GatewayRegistrationState) => ["waiting", "configuration", "binding"].includes(s.state);
export function BusinessGatewayRegistration({ provider, onConnected }: { provider: GatewayRegistrationProvider; onConnected: () => void }): React.JSX.Element {
  const [state, setState] = useState(idle);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState("");
  const [corpId, setCorpId] = useState("");
  const [robotCode, setRobotCode] = useState("");
  const [users, setUsers] = useState("");
  const revision = useRef(0);
  const current = useRef(state); const epoch = useRef(0); const lock = useRef(false);
  const callback = useRef(onConnected); callback.current = onConnected;
  const apply = (s: GatewayRegistrationState) => { const previous = current.current; current.current = s; setState(s); if (s.state === "connected" && (previous.state !== "connected" || previous.sessionId !== s.sessionId)) callback.current(); };
  useEffect(() => {
    const generation = ++epoch.current;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || lock.current) return; inFlight = true; const request = revision.current;
      try { const next = await gateway().registrationState(provider); if (epoch.current === generation && revision.current === request && !lock.current) apply(next); } catch { /* retain current state; action errors remain visible */ }
      finally { inFlight = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { clearInterval(timer); ++epoch.current; const s = current.current; if (active(s) && s.sessionId) void gateway().registrationCancel(provider, s.sessionId).catch(() => {}); };
  }, [provider]);
  useEffect(() => { let live = true; setImage(""); if (state.state === "waiting" && state.qrUrl) void QRCode.toDataURL(state.qrUrl, { width: 240, margin: 2 }).then(url => { if (live) setImage(url); }).catch(() => { if (live) setImage(""); }); return () => { live = false; }; }, [state.state, state.qrUrl]);
  const run = async (action: "start" | "finish" | "cancel") => {
    if (lock.current && action !== "cancel") return; lock.current = true; const request = ++revision.current; setBusy(true); const generation = epoch.current;
    try {
      const next = action === "start" ? await gateway().registrationStart(provider, approved)
        : action === "cancel" ? await gateway().registrationCancel(provider, current.current.sessionId)
          : await gateway().registrationFinish(provider, current.current.sessionId!, { corpId: corpId.trim(), robotCode: robotCode.trim(), allowUsers: users.split(/[\s,，]+/).filter(Boolean) });
      if (generation === epoch.current && request === revision.current) apply(next);
      else if (action === "start" && active(next) && next.sessionId) await gateway().registrationCancel(provider, next.sessionId);
    } catch { if (generation === epoch.current && request === revision.current) setState(s => ({ ...s, message: "操作失败，请重试。未完成的扫码不会覆盖原有保存配置。" })); }
    finally { if (request === revision.current) { lock.current = false; if (generation === epoch.current) setBusy(false); } }
  };
  return <section aria-label={`${provider === "feishu" ? "飞书" : "钉钉"}扫码接入`}>
    <p>仅用于尚未配置的渠道。已有配置或连接不会被扫码创建替换，请使用现有机器人管理。</p>
    <p>{provider === "feishu" ? "仅支持中国大陆飞书。扫码在飞书官方创建机器人，本人身份默认加入允许名单。国际 Lark 请勿使用此入口。" : "使用钉钉官方创建流程，授权页面可能显示 openClaw 品牌。扫码后还需补全企业 ID、机器人编码及允许的用户。"}</p>
    {!active(state) && <><label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />同意在官方平台创建机器人，并在本机加密保存凭据用于持续连接</label><button type="button" disabled={!approved || busy} onClick={() => void run("start")}>扫码创建并接入</button></>}
    <p role="status">{state.message}</p>
    {image && <img src={image} width={240} height={240} alt="官方机器人创建二维码" />}
    {state.state === "waiting" && state.qrUrl && !image && <p>二维码图片未生成，请取消后重试；不会展示凭据或设备码。</p>}
    {state.state === "configuration" && <div>
      {state.missingFields?.includes("corpId") && <label>企业 Corp ID<input value={corpId} onChange={e => setCorpId(e.target.value)} autoComplete="off" /></label>}
      {state.missingFields?.includes("robotCode") && <label>机器人 Robot Code<input value={robotCode} onChange={e => setRobotCode(e.target.value)} autoComplete="off" /></label>}
      {state.missingFields?.includes("allowUsers") && <label>{provider === "feishu" ? "允许的用户 Open ID" : "允许的员工 User ID"}<input value={users} onChange={e => setUsers(e.target.value)} autoComplete="off" placeholder="多个 ID 用逗号分隔，不能留空" /></label>}
      <p>请从平台应用与组织管理页获取准确 ID。身份限制不会自动放宽；此补全会话十分钟后失效。</p>
      <button type="button" disabled={busy} onClick={() => void run("finish")}>完成配置并连接</button>
    </div>}
    {active(state) && <button type="button" onClick={() => void run("cancel")}>取消扫码接入</button>}
  </section>;
}
export default BusinessGatewayRegistration;
