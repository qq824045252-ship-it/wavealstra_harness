/**
 * 任务级 Active Connector 芯片纯函数（F3，UI 与测试共用）。
 * 停用（enabled === false）的连接器不显示为 active（安装 ≠ active，停用 ≠ 引用）；
 * 重新启用后自动恢复显示（任务 connectorIds 不变，仅过滤展示）。
 */
import type { LocalConnectorDto } from "@shared/agent-ipc";

export function activeConnectorChips(
  connectors: LocalConnectorDto[],
  activeConnectorIds: string[],
): LocalConnectorDto[] {
  return connectors.filter(
    (c) => activeConnectorIds.includes(c.id) && c.enabled !== false,
  );
}
