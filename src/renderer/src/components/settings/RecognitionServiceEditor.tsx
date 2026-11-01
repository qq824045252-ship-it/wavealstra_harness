import type { RecognitionServiceConfig } from "@shared/builtin-capabilities";

/** The same small editor is used for both deployed recognition contracts. Secrets use the existing keyring editor. */
export function RecognitionServiceEditor({ value, adapter, onChange }: {
  value?: RecognitionServiceConfig;
  adapter: RecognitionServiceConfig["adapter"];
  onChange: (value: RecognitionServiceConfig) => void;
}): React.JSX.Element {
  const config = value ?? { adapter, endpoint: "", model: "", location: "local", dataPolicy: "allow-cloud", timeoutMs: 60000 };
  const field = (key: "endpoint" | "model" | "credentialRef", label: string) => <label>{label}<input className="capability-field" value={config[key] ?? ""} onChange={e => onChange({ ...config, [key]: e.target.value })} /></label>;
  return <div className="capability-controls">
    {field("endpoint", "完整请求 URL")}{field("model", "模型")}{field("credentialRef", "Credential ID（密钥在下方凭据库设置）")}
    <label>部署位置<select value={config.location} onChange={e => onChange({ ...config, location: e.target.value as RecognitionServiceConfig["location"] })}>
      <option value="local">本机 loopback</option><option value="network">内网 HTTP</option><option value="cloud">云服务</option>
    </select></label>
    <label>数据策略<select value={config.dataPolicy} onChange={e => onChange({ ...config, dataPolicy: e.target.value as RecognitionServiceConfig["dataPolicy"] })}>
      <option value="allow-cloud">允许识别正文进入当前主模型（可能为云端）</option><option value="local-only">仅本机（当前 agent 工具会拒绝执行）</option>
    </select></label>
    <label>超时（毫秒）<input type="number" min="1" value={config.timeoutMs} onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} /></label>
    <small>{adapter === "http-asr" ? "multipart: file/model/language/prompt，返回 JSON text/language/segments；仅 PCM WAV ≤10 MiB、120 秒。" : "JSON image(base64)/model，返回 text/boxes；PNG/JPEG ≤10 MiB，坐标为输入像素。"} 检查不上传样本、不证明认证/模型就绪；实际试运行请在任务内显式调用工具。未接入麦克风。</small>
  </div>;
}
