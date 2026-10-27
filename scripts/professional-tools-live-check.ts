/**
 * ProfessionalToolRuntime 真实 live-check（手工验收专用，不进普通 pnpm test）。
 *
 * 用法：
 *   pnpm test:professional-tools-live                      # 仅 status：penpot
 *   pnpm test:professional-tools-live -- --penpot-start    # Penpot stopped → docker compose up → HTTP Ready
 *
 * 说明：Blender / FreeCAD 已从受管专业工具退役（不再内置、不再托管），因此
 * `--blender-start / --freecad-start / --blender-mcp-smoke` 一并删除。
 *
 * 输出安全约束：只打印 provider / installed / ready / state / MCP 配置存在性；
 * 禁止打印 MCP endpoint、userToken、env secret、完整 mcp.json。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProfessionalToolRuntimeService } from "../src/main/professional-tools/ProfessionalToolRuntime";
import {
  PROFESSIONAL_TOOL_PROVIDER_IDS,
  type ProfessionalToolProviderId,
  type ProfessionalToolStatusDto,
} from "../src/shared/professional-tools";

const args = process.argv.slice(2);
const want = (flag: string): boolean => args.includes(flag);
const PENPOT_START = want("--penpot-start");

function readMcpConfig(): Record<string, { command?: string; url?: string; disabled?: boolean }> {
  const path = join(homedir(), ".mybuddy", "mcp.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, unknown> };
    return (parsed.mcpServers ?? {}) as Record<string, { command?: string; url?: string; disabled?: boolean }>;
  } catch {
    return {};
  }
}

/** 与 main 装配一致的 provider gate：mcp.json 中存在且未禁用。 */
function providerEnabled(providerId: ProfessionalToolProviderId): boolean {
  const server = readMcpConfig()[providerId];
  return Boolean(server && !server.disabled);
}

const service = new ProfessionalToolRuntimeService({
  providerEnabled,
  readyTimeoutMs: 90_000,
  readyPollMs: 500,
});

function printStatus(status: ProfessionalToolStatusDto, mcpEnabled: boolean): void {
  console.log(
    `${status.providerId}\tinstalled=${status.installed}\tready=${status.ready}\tstate=${status.state}\tmcp=${mcpEnabled ? "enabled" : "disabled"}`,
  );
}

async function main(): Promise<void> {
  const servers = readMcpConfig();
  console.log("== live status ==");
  const statuses = new Map<ProfessionalToolProviderId, ProfessionalToolStatusDto>();
  for (const providerId of PROFESSIONAL_TOOL_PROVIDER_IDS) {
    const status = await service.status(providerId);
    statuses.set(providerId, status);
    printStatus(status, Boolean(servers[providerId] && !servers[providerId].disabled));
  }

  for (const [flag, providerId, label] of [
    [PENPOT_START, "penpot", "Penpot"],
  ] as const) {
    if (!flag) continue;
    const before = statuses.get(providerId);
    if (before?.ready) {
      console.log(`== ${label}: already ready, skip start ==`);
      continue;
    }
    console.log(`== ${label}: starting via ProfessionalToolRuntime ==`);
    const result = await service.prepareForProvider(providerId);
    printStatus(result.status, providerEnabled(providerId));
    if (!result.ok) {
      console.error(`!! ${label} prepare failed: ${result.error ?? result.status.detail ?? "unknown"}`);
      process.exitCode = 1;
    } else {
      console.log(`== ${label}: prepare ok ==`);
    }
  }
}

main().catch((error) => {
  console.error(`!! live-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
