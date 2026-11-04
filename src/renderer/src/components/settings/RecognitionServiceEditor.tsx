import type { RecognitionServiceConfig } from "@shared/builtin-capabilities";
import { SettingsInput, SettingsSecretField } from "./SettingsPrimitives";

/** Retains the existing endpoint contract and privacy preference when editing an older service. */
export function RecognitionServiceEditor({ value, adapter, disabled, secret = "", clearCredential, credentialConfigured = false, sharedCredentialNote, effectiveDataPolicy, onAllowConversation, onChange, onCredentialChange }: {
  value?: RecognitionServiceConfig;
  adapter: RecognitionServiceConfig["adapter"];
  disabled?: boolean;
  secret?: string;
  clearCredential?: boolean;
  credentialConfigured?: boolean;
  sharedCredentialNote?: string;
  effectiveDataPolicy?: RecognitionServiceConfig["dataPolicy"];
  onAllowConversation?: () => void;
  onChange: (value: RecognitionServiceConfig) => void;
  onCredentialChange: (change: { secret?: string; clear?: boolean }) => void;
}): React.JSX.Element {
  const config = value ?? { adapter, endpoint: "", model: "", location: "local", dataPolicy: "allow-cloud", timeoutMs: 60000 };
  let locationLabel = "等待填写地址";
  try { locationLabel = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.endpoint).hostname) ? "本机地址" : "远程服务"; } catch { /* Save validation reports an invalid address. */ }
  const changeEndpoint = (endpoint: string): void => {
    let location = config.location;
    try { location = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname) ? "local" : config.location === "network" ? "network" : "cloud"; } catch { /* Keep the saved location until there is a valid address. */ }
    onChange({ ...config, endpoint, location });
  };
  return <fieldset className="recognition-service-editor" disabled={disabled}>
    <div className="capability-form-grid">
      <SettingsInput label="服务地址" type="url" value={config.endpoint} spellCheck={false} autoComplete="off" placeholder="完整请求地址" onChange={event => changeEndpoint(event.target.value)} />
      <SettingsInput label="模型" value={config.model} spellCheck={false} onChange={event => onChange({ ...config, model: event.target.value })} />
    </div>
    <SettingsSecretField value={secret} clear={clearCredential} configured={credentialConfigured} disabled={disabled} onChange={next => onCredentialChange({ secret: next, clear: false })} onClearChange={clear => onCredentialChange({ clear, secret: "" })} />
    {sharedCredentialNote && <p className="settings-row-desc">{sharedCredentialNote}</p>}
    <p className="settings-row-desc">{locationLabel} · 保留现有服务接口</p>
    {(effectiveDataPolicy ?? config.dataPolicy) === "local-only"
      ? <div className="capability-policy-note" role="note"><p>已保留“仅限本机”的限制。当前对话无法保证识别正文只在本机处理，因此暂不能调用此服务。</p>{onAllowConversation && <button type="button" className="btn" onClick={onAllowConversation}>允许识别正文用于当前对话</button>}</div>
      : <p className="settings-row-desc">识别正文会进入当前对话，并按当前模型设置处理。本机地址不代表后续处理也在本机。</p>}
    <details className="capability-options">
      <summary>连接选项</summary>
      <SettingsInput label="等待上限（秒）" type="number" min={1} value={config.timeoutMs / 1000 || ""} onChange={event => onChange({ ...config, timeoutMs: Number(event.target.value) * 1000 })} />
    </details>
  </fieldset>;
}
