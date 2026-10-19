/**
 * Gateway webhook 端口回退（直接测 webhook-port 模块，不拉 GatewayService 的重依赖）。
 *
 * 52140 曾硬编码，但落在 Windows 的 TCP 保留区间（Hyper-V/WSL 动态预留）内，
 * 绑定直接 EACCES 且原实现无回退 → 飞书/企微/微信 webhook 全部起不来。
 *
 * 验证：
 *  1. 候选端口表非空且不含已知保留端口
 *  2. 首选端口不可用时自动换下一个，而不是直接失败
 *  3. 返回的实际端口就是真正绑上的那个（UI 展示与实际一致）
 *  4. 全部端口不可用时明确抛错（不静默成功）
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_WEBHOOK_PORT,
  WEBHOOK_PORT_CANDIDATES,
  listenOnFirstAvailablePort,
} from "../src/main/gateway/webhook-port";

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function occupier(): Server {
  return createServer((_req, res) => { res.writeHead(200); res.end("occupied"); });
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = occupier();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

async function closeAll(servers: Server[]): Promise<void> {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
}

async function main(): Promise<void> {
  check(WEBHOOK_PORT_CANDIDATES.length > 0, "候选端口表非空");
  check(!WEBHOOK_PORT_CANDIDATES.includes(DEFAULT_WEBHOOK_PORT as never), "候选表不含历史首选端口本身");

  // 1. 首选与前两个候选都被占用 → 应落到第三个候选
  const held: Server[] = [];
  try {
    const blockedPorts = [DEFAULT_WEBHOOK_PORT, WEBHOOK_PORT_CANDIDATES[0]!, WEBHOOK_PORT_CANDIDATES[1]!];
    for (const port of blockedPorts) {
      try { held.push(await listen(port)); } catch { /* 已被系统占用同样算阻塞 */ }
    }
    const result = await listenOnFirstAvailablePort(() => occupier());
    check(result.port !== DEFAULT_WEBHOOK_PORT, `首选 ${DEFAULT_WEBHOOK_PORT} 不可用时自动切换（实际 ${result.port}）`);
    check(WEBHOOK_PORT_CANDIDATES.includes(result.port as never), "实际端口来自候选表");
    check(result.port === WEBHOOK_PORT_CANDIDATES[2], `跳过被占用的两个候选，落到 ${WEBHOOK_PORT_CANDIDATES[2]}`);
    check(result.server.listening, "返回的 server 确实在监听（端口与实际一致）");

    const probe = await fetch(`http://127.0.0.1:${result.port}/`);
    check(probe.status === 200, "该端口可正常响应请求");
    await new Promise<void>((r) => result.server.close(() => r()));
  } finally {
    await closeAll(held);
  }

  // 2. 全部端口不可用 → 必须抛错
  const all: Server[] = [];
  try {
    for (const port of [DEFAULT_WEBHOOK_PORT, ...WEBHOOK_PORT_CANDIDATES]) {
      try { all.push(await listen(port)); } catch { /* 忽略 */ }
    }
    let threw = false;
    try { await listenOnFirstAvailablePort(() => occupier()); } catch { threw = true; }
    check(threw, "全部端口不可用时明确抛错（不静默成功）");
  } finally {
    await closeAll(all);
  }

  // 3. 首选可用时直接用它（不回退）
  const direct = await listenOnFirstAvailablePort(() => occupier(), WEBHOOK_PORT_CANDIDATES[3]);
  check(direct.port === WEBHOOK_PORT_CANDIDATES[3], "首选可用时不回退");
  await new Promise<void>((r) => direct.server.close(() => r()));

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

void main();
