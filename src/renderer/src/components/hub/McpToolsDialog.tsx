import { useCallback, useEffect, useState } from "react";
import type { McpServerToolsDto } from "@shared/agent-ipc";
import { MCP_EXPOSURE_LABELS } from "./McpConfigEditor";

export function McpToolsDialog({ name, toolCount, onClose }: { name: string; toolCount: number; onClose: () => void }): React.JSX.Element {
  const [tools, setTools] = useState<McpServerToolsDto["tools"]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await window.api?.mcp.serverTools(name);
      if (!result) throw new Error("MCP 接口尚未就绪");
      setTools(result.tools); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [name]);
  useEffect(() => { void load(); }, [load, toolCount]);
  const filtered = tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="modal-overlay" onClick={onClose}>
    <div className="mcp-config-modal" role="dialog" aria-modal="true" aria-label={`MCP 工具 ${name}`} onClick={event => event.stopPropagation()}>
      <div className="mcp-config-title">{name} · {tools.length} 个工具</div>
      <div className="mcp-config-body">
        <label>搜索工具<input aria-label="搜索工具" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {error && <div className="mcp-config-error" role="alert">{error}</div>}
        {!filtered.length && <p className="mcp-config-hint">暂无匹配工具。服务器连接完成后可刷新；隐藏的工具不会加入会话工具列表。</p>}
        {filtered.map(tool => <div key={tool.name}>
          <strong className="hub-card-path">{tool.name}</strong><p className="mcp-config-hint">{MCP_EXPOSURE_LABELS[tool.exposure] ?? tool.exposure}</p>
          <p>{tool.description}</p><details><summary>参数定义</summary><pre className="mcp-tool-schema">{JSON.stringify(tool.parameters, null, 2)}</pre></details>
        </div>)}
      </div>
      <div className="mcp-config-actions"><button type="button" className="btn" onClick={() => void load()}>刷新工具</button><button type="button" className="btn" onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}
