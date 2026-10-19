/**
 * Gateway webhook 端口选择。
 *
 * 背景：52140 曾硬编码在 GatewayService 里，但它落在 Windows 的 TCP 保留区间
 * （Hyper-V / WSL 动态预留；用 `netsh interface ipv4 show excludedportrange protocol=tcp`
 * 查看当前区间）。绑定这类端口会直接 EACCES，而且原实现没有回退，
 * 导致飞书 / 企微 / 微信的 webhook 全部起不来，只有 Telegram（长连接）不受影响。
 *
 * 这里把它抽成可独立测试的纯逻辑：按顺序尝试候选端口，返回第一个绑得上的。
 */
import { createServer, type Server } from "node:http";

/**
 * 候选端口，均已核对不在 Windows 的 TCP 保留区间内。
 * 注意 52140 / 52141 / 52170 当前都落在保留段内，不要再往回加。
 */
export const WEBHOOK_PORT_CANDIDATES = [52330, 52490, 39140, 39141] as const;

/** 首选端口（历史值），会先于候选表尝试；落在保留区间时会自动跳过 */
export const DEFAULT_WEBHOOK_PORT = 52140;

export interface WebhookListenResult {
  port: number;
  server: Server;
}

function listenOnce(factory: () => Server, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = factory();
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

/**
 * 依次尝试 preferred + candidates，返回第一个成功绑定的端口。
 * 全部失败时抛出最后一次错误——不静默成功，便于上层明确报告。
 */
export async function listenOnFirstAvailablePort(
  factory: () => Server,
  preferred: number = DEFAULT_WEBHOOK_PORT,
  candidates: readonly number[] = WEBHOOK_PORT_CANDIDATES,
): Promise<WebhookListenResult> {
  const ordered = [preferred, ...candidates].filter((port, index, all) => all.indexOf(port) === index);
  let lastError: Error | undefined;
  for (const port of ordered) {
    try {
      const server = await listenOnce(factory, port);
      return { port, server };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Gateway webhook 端口均不可用");
}
