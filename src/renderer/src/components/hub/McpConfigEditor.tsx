import { useEffect, useState } from "react";
import "./McpManager.css";

export const MCP_EXPOSURE_LABELS: Record<string, string> = {
  codemode: "Code Mode", deferred: "按需发现", direct: "直接提供", hidden: "隐藏工具",
};

const MAIN_FIELDS = new Set(["type", "command", "args", "url", "exposure", "timeout", "enabled", "disabled"]);

export function McpConfigEditor({ serverName, onClose, onSaved }: {
  serverName: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(serverName ?? "");
  const [transport, setTransport] = useState("http");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("[]");
  const [exposure, setExposure] = useState("codemode");
  const [timeout, setTimeoutValue] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [advanced, setAdvanced] = useState("{}");
  const [original, setOriginal] = useState<string | null>(null);
  const [loading, setLoading] = useState(serverName !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (serverName === null) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!window.api) throw new Error("MCP 配置接口尚未就绪");
        const config = await window.api.mcp.readServerConfig(serverName);
        if (cancelled) return;
        const entry = JSON.parse(config.entryText) as Record<string, unknown>;
        setOriginal(config.entryText);
        setTransport(entry.url ? "http" : "stdio");
        setEndpoint(String(entry.url ?? entry.command ?? ""));
        setArgs(JSON.stringify(entry.args ?? [], null, 2));
        setExposure(String(entry.exposure === "codemode-deferred" ? "codemode" : entry.exposure ?? (entry.directTools === true ? "direct" : "codemode")));
        setTimeoutValue(entry.timeout == null ? "" : String(entry.timeout));
        setEnabled(entry.enabled !== false && entry.disabled !== true);
        setAdvanced(JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !MAIN_FIELDS.has(key))), null, 2));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [serverName]);

  const save = async (): Promise<void> => {
    setError(""); setSaving(true);
    try {
      const extra = JSON.parse(advanced) as unknown;
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("高级配置必须是 JSON 对象");
      const entry: Record<string, unknown> = { ...extra };
      for (const key of MAIN_FIELDS) delete entry[key];
      entry.type = transport;
      if (transport === "http") entry.url = endpoint.trim();
      else { entry.command = endpoint.trim(); entry.args = JSON.parse(args); }
      entry.exposure = exposure;
      entry.enabled = enabled;
      if (timeout.trim()) entry.timeout = Number(timeout);
      if (!window.api) throw new Error("MCP 配置接口尚未就绪");
      const result = await window.api.mcp.saveServerConfig({ name: name.trim(), entryText: JSON.stringify(entry), expectedEntryText: original });
      if (!result.ok) throw new Error(result.error || "保存失败");
      await onSaved();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={() => { if (!saving) onClose(); }}>
      <form className="mcp-config-modal" role="dialog" aria-modal="true" aria-label={serverName ? `编辑 MCP ${serverName}` : "新增 MCP 服务器"}
        onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="mcp-config-title">{serverName ? `编辑 MCP · ${serverName}` : "新增 MCP 服务器"}</div>
        <div className="mcp-config-body">
          {loading ? <p>正在读取配置…</p> : <>
            <label>服务器名称<input aria-label="服务器名称" value={name} onChange={event => setName(event.target.value)} readOnly={serverName !== null} required placeholder="例如 local-tools" /></label>
            <label>连接方式<select aria-label="连接方式" value={transport} onChange={event => { setTransport(event.target.value); setEndpoint(""); }}>
              <option value="http">Streamable HTTP</option><option value="stdio">本地程序（stdio）</option>
            </select></label>
            <label>{transport === "http" ? "服务地址" : "执行程序"}<input aria-label={transport === "http" ? "服务地址" : "执行程序"} value={endpoint} onChange={event => setEndpoint(event.target.value)} required placeholder={transport === "http" ? "https://example.com/mcp" : "npx / uvx / 程序绝对路径"} /></label>
            {transport === "stdio" && <label>参数（JSON 数组）<textarea aria-label="参数（JSON 数组）" rows={3} value={args} onChange={event => setArgs(event.target.value)} spellCheck={false} placeholder={'["-y", "package-name"]'} /></label>}
            <div className="mcp-config-row">
              <label>工具提供方式<select aria-label="工具提供方式" value={exposure} onChange={event => setExposure(event.target.value)}>
                {Object.entries(MCP_EXPOSURE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <label>请求超时（秒）<input aria-label="请求超时（秒）" type="number" min="0.001" step="any" value={timeout} onChange={event => setTimeoutValue(event.target.value)} placeholder="60" /></label>
            </div>
            <p className="mcp-config-hint">Code Mode 在编码场景通过脚本调用，在办公、设计场景按需发现；直接提供会将工具加入模型上下文。隐藏工具仍保留服务器连接。</p>
            <label className="mcp-config-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用此服务器</label>
            <label>高级配置（JSON）<textarea aria-label="高级配置（JSON）" rows={7} value={advanced} onChange={event => setAdvanced(event.target.value)} spellCheck={false} /></label>
            <p className="mcp-config-hint">支持 env、cwd、headers、oauth、auth、description、toolExposure 和场景 modes。环境变量用 {"${变量名}"}；OAuth 参数在此配置，授权可在卡片中发起。</p>
          </>}
          {error && <div className="mcp-config-error" role="alert">{error}</div>}
        </div>
        <div className="mcp-config-actions">
          <span className="mcp-config-hint">保存后管理页刷新连接；任务在新建会话时使用新配置。</span>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || loading || (serverName !== null && original === null)}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}
