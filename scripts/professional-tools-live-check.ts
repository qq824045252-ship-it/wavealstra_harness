/**
 * ProfessionalToolRuntime 真实 live-check（手工验收专用，不进普通 pnpm test）。
 *
 * 用法：
 *   pnpm test:professional-tools-live                      # 仅 status：penpot/blender/freecad
 *   pnpm test:professional-tools-live -- --blender-start   # Blender stopped → 自动启动 → 等待 9876 → connectMcp
 *   pnpm test:professional-tools-live -- --freecad-start   # FreeCAD stopped → 自动启动 → 等待 9875 → connectMcp
 *   pnpm test:professional-tools-live -- --penpot-start    # Penpot stopped → docker compose up → HTTP Ready
 *   pnpm test:professional-tools-live -- --blender-mcp-smoke  # 再对 Blender 做真实 MCP 最小读写（create/read/delete）
 *
 * 输出安全约束：只打印 provider / installed / ready / state / MCP 配置存在性；
 * 禁止打印 MCP endpoint、userToken、env secret、完整 mcp.json。
 */
import { spawn } from "node:child_process";
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
const BLENDER_START = want("--blender-start");
const FREECAD_START = want("--freecad-start");
const PENPOT_START = want("--penpot-start");
const BLENDER_MCP_SMOKE = want("--blender-mcp-smoke");

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

  if (BLENDER_MCP_SMOKE) {
    console.error("!! blender 已从受管专业工具删除，--blender-mcp-smoke 不再可用");
    process.exitCode = 1;
  }
}

/** 最小 stdio MCP 客户端：走 mcp.json 中 blender provider 完全相同的启动命令。 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function blenderServerCommand(): { command: string; args: string[]; env: Record<string, string> } {
  const config = readMcpConfig().blender;
  if (!config?.command) throw new Error("mcp.json 中没有 blender provider");
  // 只复用 command/env，不打印任何 secret（blender 无 token）。
  const serverArgs = argsOf(config) ?? [];
  const env = envOf(config);
  if (env.BLENDER_PATH && !existsSync(env.BLENDER_PATH)) {
    throw new Error(`BLENDER_PATH 不存在: ${env.BLENDER_PATH}`);
  }
  return { command: config.command, args: serverArgs, env };
}

function argsOf(config: Record<string, unknown>): string[] | null {
  const args = config.args;
  return Array.isArray(args) ? args.map(String) : null;
}

function envOf(config: Record<string, unknown>): Record<string, string> {
  const env = config.env;
  if (!env || typeof env !== "object") return {};
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

async function blenderMcpSmoke(): Promise<void> {
  const { command, args: serverArgs, env } = blenderServerCommand();
  console.log("== blender mcp smoke ==");
  const child = spawn(command, serverArgs, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let stderrTail = "";
  const pending = new Map<number, (result: { ok: boolean; data: unknown }) => void>();
  let nextId = 1;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = message as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) resolve({ ok: false, data: msg.error });
        else resolve({ ok: true, data: msg.result });
      }
    }
  });

  const request = (method: string, params: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      child.stdin?.write(JSON.stringify(payload) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`MCP 请求超时: ${method}`));
      }, 30_000);
    });

  const fail = (error: unknown): never => {
    child.kill();
    throw new Error(`${String(error)} — blender-mcp stderr: ${stderrTail.slice(-600)}`);
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mybuddy-live-check", version: "0.0.1" },
    });
    if (!init.ok) fail(`initialize 失败: ${JSON.stringify(init.data)}`);
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

    // 1) 只读：scene 概况
    const readBefore = await request("tools/call", {
      name: "get_objects_summary",
      arguments: {},
    });
    if (!readBefore.ok) fail(`get_objects_summary 失败: ${JSON.stringify(readBefore.data)}`);
    const beforeText = JSON.stringify(readBefore.data);
    const hadSmoke = beforeText.includes("MyBuddy_Runtime_Smoke");
    console.log(`  read scene: ok (contains smoke object: ${hadSmoke})`);

    // 2) 最小写入：创建测试对象（若上次残留则先清）
    if (hadSmoke) {
      const clean = await request("tools/call", {
        name: "execute_blender_code",
        arguments: {
          code: [
            "import bpy",
            "for obj in list(bpy.data.objects):",
            "    if obj.name == 'MyBuddy_Runtime_Smoke':",
            "        bpy.data.objects.remove(obj, do_unlink=True)",
            "result = {'cleaned': True}",
            "",
          ].join("\n"),
        },
      });
      if (!clean.ok) fail(`清理残留对象失败: ${JSON.stringify(clean.data)}`);
    }
    const create = await request("tools/call", {
      name: "execute_blender_code",
      arguments: {
        code: [
          "import bpy",
          // Blender 5.x 的 primitive_*_add 不再接受 name= 关键字，创建后改名。
          "bpy.ops.mesh.primitive_cube_add(size=2.0)",
          "bpy.context.object.name = 'MyBuddy_Runtime_Smoke'",
          "result = {'name': 'MyBuddy_Runtime_Smoke', 'type': 'MESH', 'exists': 'MyBuddy_Runtime_Smoke' in bpy.data.objects}",
          "",
        ].join("\n"),
      },
    });
    if (!create.ok) fail(`创建对象失败: ${JSON.stringify(create.data)}`);
    console.log(`  create: ok -> ${JSON.stringify(create.data)}`);

    // 3) 读回确认
    const readBack = await request("tools/call", {
      name: "get_objects_summary",
      arguments: {},
    });
    if (!readBack.ok) fail(`读回失败: ${JSON.stringify(readBack.data)}`);
    const found = JSON.stringify(readBack.data).includes("MyBuddy_Runtime_Smoke");
    console.log(`  read-back: ${found ? "ok (object present)" : "FAILED (object missing)"}`);

    // 4) 删除
    const remove = await request("tools/call", {
      name: "execute_blender_code",
      arguments: {
        code: [
          "import bpy",
          "removed = False",
          "for obj in list(bpy.data.objects):",
          "    if obj.name == 'MyBuddy_Runtime_Smoke':",
          "        bpy.data.objects.remove(obj, do_unlink=True)",
          "        removed = True",
          "result = {'removed': removed}",
          "",
        ].join("\n"),
      },
    });
    if (!remove.ok) fail(`删除对象失败: ${JSON.stringify(remove.data)}`);
    console.log(`  delete: ok -> ${JSON.stringify(remove.data)}`);

    // 5) 删除后确认
    const readAfter = await request("tools/call", {
      name: "get_objects_summary",
      arguments: {},
    });
    const gone = !JSON.stringify(readAfter.data).includes("MyBuddy_Runtime_Smoke");
    console.log(`  read-after-delete: ${gone ? "ok (clean)" : "WARNING (still present)"}`);

    const passed = found && gone;
    console.log(`== blender mcp smoke: ${passed ? "PASSED" : "FAILED"} ==`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(`!! blender mcp smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`!! live-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
