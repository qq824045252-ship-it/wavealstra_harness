import { useEffect, useState } from "react";
import type { AuthEventDto, AuthPromptRequestDto } from "@shared/agent-ipc";
import { isLoginCancelledMessage } from "@shared/provider-login";
import type { LoginProviderInfo, ModelListItem } from "./types";

interface ProviderAuthSectionProps {
  provider: LoginProviderInfo | null;
  pageBusy: boolean;
  refreshLoginProviders: () => Promise<void>;
  refreshSaved: () => Promise<void>;
  onLoginSuccess: (list: ModelListItem[], selectedModelId?: string) => void;
}

/** Provider-centered auth panel: only manages the provider selected in the left rail. */
export default function ProviderAuthSection({
  provider,
  pageBusy,
  refreshLoginProviders,
  refreshSaved,
  onLoginSuccess,
}: ProviderAuthSectionProps): React.JSX.Element {
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginLog, setLoginLog] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [authPrompt, setAuthPrompt] = useState<AuthPromptRequestDto | null>(null);
  const [authAnswer, setAuthAnswer] = useState("");
  const [loginTarget, setLoginTarget] = useState<{
    providerId: string;
    name: string;
    authType: "api_key" | "oauth";
  } | null>(null);
  const [deviceCode, setDeviceCode] = useState<Extract<AuthEventDto, { type: "device_code" }> | null>(null);

  useEffect(() => {
    const unsubPrompt = window.api?.agent?.onAuthPrompt?.((req) => {
      setAuthPrompt(req);
      setAuthAnswer("");
    });
    const unsubEvent = window.api?.agent?.onAuthEvent?.((ev) => {
      if (ev.type === "device_code") setDeviceCode(ev);
      const line =
        ev.type === "auth_url"
          ? `打开浏览器：${ev.url}${ev.instructions ? `（${ev.instructions}）` : ""}`
          : ev.type === "device_code"
            ? `验证码 ${ev.userCode} → ${ev.verificationUri}`
            : ev.message;
      setLoginLog((prev) => [...prev.slice(-30), line]);
    });
    return () => {
      unsubPrompt?.();
      unsubEvent?.();
    };
  }, []);

  useEffect(() => {
    setStatus("");
    setLoginLog([]);
    setAuthPrompt(null);
    setDeviceCode(null);
  }, [provider?.id]);


  const startLogin = async (authType: "api_key" | "oauth"): Promise<void> => {
    if (!provider) return;
    setLoginTarget({ providerId: provider.id, name: provider.name, authType });
    setLoginBusy(true);
    setLoginLog([`开始连接 ${provider.name}（${authType}）…`]);
    setAuthPrompt(null);
    setAuthAnswer("");
    setDeviceCode(null);
    setStatus("");
    try {
      const result = await window.api?.agent?.login?.({ providerId: provider.id, authType });
      if (result?.ok) {
        onLoginSuccess(result.models, result.selectedModelId);
        await refreshLoginProviders();
        await refreshSaved();
        setStatus(result.selectedModelId ? `已连接，并选用 ${result.selectedModelId}` : `已连接，可用模型 ${result.models.length} 个`);
      } else {
        const error = result?.error ?? "未知错误";
        const cancelled = isLoginCancelledMessage(error);
        setLoginLog((prev) => [...prev, cancelled ? "已取消" : `失败：${error}`]);
        setStatus(cancelled ? "已取消连接" : error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoginLog((prev) => [...prev, `错误：${message}`]);
      setStatus(message);
    } finally {
      setLoginBusy(false);
      setAuthPrompt(null);
      setLoginTarget(null);
      setDeviceCode(null);
    }
  };

  const submitAuthAnswer = async (): Promise<void> => {
    if (!authPrompt) return;
    const value = authPrompt.prompt.type === "select"
      ? authAnswer || authPrompt.prompt.options?.[0]?.id || ""
      : authAnswer;
    if (!value && authPrompt.prompt.type !== "select") return;
    await window.api?.agent?.authRespond?.(authPrompt.requestId, value);
    setAuthPrompt(null);
    setAuthAnswer("");
  };

  const cancelLogin = async (): Promise<void> => {
    await window.api?.agent?.authCancel?.(authPrompt?.requestId);
    setAuthPrompt(null);
    setDeviceCode(null);
  };

  const doLogout = async (): Promise<void> => {
    if (!provider) return;
    setStatus("");
    setLoginBusy(true);
    try {
      const result = await window.api?.agent?.logout?.(provider.id);
      const models = result?.models ?? [];
      onLoginSuccess(models);
      await refreshLoginProviders();
      await refreshSaved();
      setStatus(`已断开 ${provider.name}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginBusy(false);
    }
  };

  if (!provider) return <div className="models-provider-auth-empty">选择左侧 Provider 后配置认证。</div>;

  const canLogout = provider.loggedIn && provider.authSource === "stored";

  return (
    <div className="models-provider-auth-panel">
      <div className="models-provider-auth-line">
        <div>
          <div className="models-provider-auth-title">认证</div>
          <div className="models-provider-auth-sub">
            {provider.loggedIn
              ? `已连接${provider.credentialType ? ` · ${provider.credentialType}` : ""}${provider.authLabel ? ` · ${provider.authLabel}` : ""}`
              : "尚未连接；选择此 Provider 支持的认证方式。"}
          </div>
        </div>
        <div className="models-provider-auth-actions">
          {!provider.loggedIn && provider.authTypes.map((type) => (
            <button
              key={type}
              type="button"
              className="btn primary"
              disabled={pageBusy || loginBusy}
              onClick={() => void startLogin(type)}
            >
              {type === "oauth" ? "OAuth 登录" : "配置 API Key"}
            </button>
          ))}
          {canLogout && (
            <button type="button" className="btn" disabled={pageBusy || loginBusy} onClick={() => void doLogout()}>
              断开
            </button>
          )}
        </div>
      </div>

      {provider.loggedIn && !canLogout && provider.authSource && (
        <div className="models-provider-auth-note">凭证来自 {provider.authSource}，不能在此直接删除。</div>
      )}


      {(loginBusy || loginLog.length > 0) && (
        <div className="models-login-panel models-login-panel--compact">
          <div className="models-login-panel-head">
            <span>{loginTarget ? `连接中：${loginTarget.name}` : "认证日志"}</span>
            {loginBusy && <button type="button" className="btn" onClick={() => void cancelLogin()}>取消</button>}
          </div>
          <div className="models-login-log">
            {loginLog.map((line, index) => <div key={`${index}-${line.slice(0, 16)}`}>{line}</div>)}
          </div>
          {deviceCode && (
            <div className="models-login-prompt">
              <div className="models-login-prompt-msg">请在浏览器确认授权。验证码：<strong>{deviceCode.userCode}</strong></div>
              <div className="models-login-prompt-actions">
                <button type="button" className="btn" onClick={() => deviceCode.verificationUri && window.api?.browser?.openExternal?.(deviceCode.verificationUri)}>
                  打开浏览器
                </button>
              </div>
            </div>
          )}
          {authPrompt && (
            <div className="models-login-prompt">
              <div className="models-login-prompt-msg">{authPrompt.prompt.message}</div>
              {authPrompt.prompt.type === "select" ? (
                <select value={authAnswer || authPrompt.prompt.options?.[0]?.id || ""} onChange={(e) => setAuthAnswer(e.target.value)}>
                  {(authPrompt.prompt.options ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={authPrompt.prompt.type === "secret" ? "password" : "text"}
                  value={authAnswer}
                  placeholder={authPrompt.prompt.placeholder}
                  onChange={(e) => setAuthAnswer(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitAuthAnswer()}
                  autoFocus
                />
              )}
              <div className="models-login-prompt-actions">
                <button type="button" className="btn" onClick={() => void cancelLogin()}>取消</button>
                <button type="button" className="btn primary" onClick={() => void submitAuthAnswer()}>继续</button>
              </div>
            </div>
          )}
        </div>
      )}
      {status && <div className="memory-status">{status}</div>}
    </div>
  );
}
