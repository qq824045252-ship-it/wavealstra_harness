import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { McpServerDto } from "@shared/agent-ipc";
import type { Skill } from "@/types";

export function ExpertCapabilityFields({ skills, skillIds, mcpIds, connectorIds, onSkills, onMcp, onConnectors, disabled = false }: {
  skills: Skill[]; skillIds: string[]; mcpIds: string[]; connectorIds: string[];
  onSkills: (ids: string[]) => void; onMcp: (ids: string[]) => void; onConnectors: (ids: string[]) => void; disabled?: boolean;
}): React.JSX.Element {
  const connectors = useAppStore((s) => s.connectors);
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.api?.mcp?.listServers?.().then((rows) => { if (!cancelled) setServers(rows ?? []); }).catch((err) => { if (!cancelled) setError(`MCP 列表读取失败：${String(err)}`); });
    return () => { cancelled = true; };
  }, []);
  const toggle = (ids: string[], id: string): string[] => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
  const groups = [
    { title: "Skills", hint: "模板会保存所选技能的私有副本；任务专属修改保留当前专家私有技能，并可追加已安装技能。", ids: skillIds, change: onSkills, rows: skills.map((s) => ({ id: s.id, name: s.name })) },
    { title: "MCP", hint: "引用已配置的 MCP；仍受连接状态、场景策略和工具权限约束。", ids: mcpIds, change: onMcp, rows: servers.map((s) => ({ id: s.name, name: s.name })) },
    { title: "连接器", hint: "引用已安装连接器，不复制凭据；未授权的连接器需先完成配置。", ids: connectorIds, change: onConnectors, rows: connectors.map((c) => ({ id: c.id, name: c.name })) },
  ];
  return <div className="expert-capabilities">
    {groups.map((group) => {
      const rows = [...group.rows, ...group.ids.filter((id) => !group.rows.some((row) => row.id === id)).map((id) => ({ id, name: `${id}（当前绑定 / 未在列表中）` }))];
      return <fieldset key={group.title} disabled={disabled}>
        <legend>{group.title} · {group.ids.length}</legend>
        <p className="mcp-auth-hint">{group.hint}</p>
        <div className="expert-capability-list">{rows.length ? rows.map((row) => <label key={row.id}><input type="checkbox" checked={group.ids.includes(row.id)} onChange={() => group.change(toggle(group.ids, row.id))} /><span>{row.name}</span></label>) : <span className="mcp-auth-hint">暂无可选项</span>}</div>
      </fieldset>;
    })}
    {error && <div className="mcp-auth-error">{error}</div>}
  </div>;
}
