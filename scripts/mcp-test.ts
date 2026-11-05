/**
 * McpConfigService 功能冒烟测试（应用全局模式）
 * 注入 fake home + appGlobalPath，不触碰真实 ~/.mybuddy 与真实用户配置。
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpConfigService } from "../src/main/mcp/McpConfigService";
import type { DrawioMcpPayload } from "../src/shared/professional-tools";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), "mcp-test-"));
const fakeHome = join(base, "home");
const appGlobal = join(base, "mybuddy", "mcp.json");
mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
mkdirSync(join(fakeHome, ".codex"), { recursive: true });

// Cursor 风格（JSONC 注释 + 尾逗号）
writeFileSync(
  join(fakeHome, ".cursor", "mcp.json"),
  `{
  // ESP 官方
  "mcpServers": {
    "espressif-documentation": { "url": "https://mcp.espressif.com/docs", },
    "esp-component-registry": { "url": "https://components.espressif.com/mcp" },
  },
}`,
);
// Codex 风格（TOML）
writeFileSync(
  join(fakeHome, ".codex", "config.toml"),
  `model = "gpt-5"
[mcp_servers]
[mcp_servers.node_repl]
command = 'C:/tools/node_repl.exe'
args = []
startup_timeout_sec = 120
[mcp_servers.node_repl.env]
NODE_REPL_PIPE = "1000"
[mcp_servers.espressif-documentation]
url = "https://mcp.espressif.com/docs"
enabled = true
`,
);

const service = new McpConfigService({ appGlobalPath: appGlobal, homeDir: fakeHome });

console.log("\n[1] 发现");
{
  const d = service.discover();
  assert(d.appGlobalConfigPath === appGlobal, "应用全局路径正确");
  const pi = d.sources.find((s) => s.id === "pi-global");
  assert(!!pi && pi.path === appGlobal, "pi-global 来源指向应用全局");
  const cursor = d.imports.find((i) => i.kind === "cursor");
  assert(cursor?.serverCount === 2, "Cursor 兼容来源发现 2 个服务器");
  const codex = d.imports.find((i) => i.kind === "codex");
  assert(codex?.serverCount === 2, "Codex TOML 兼容来源发现 2 个服务器（TOML 解析）");
}

console.log("\n[2] 服务器列表（候选）");
{
  const servers = service.listServers();
  const esp = servers.find((s) => s.name === "espressif-documentation");
  assert(!!esp && esp.sourceId === "import:cursor", "espressif-documentation 候选来自 cursor（kind 顺序优先）");
  assert(esp?.installed === false, "候选未安装");
  const repl = servers.find((s) => s.name === "node_repl");
  assert(!!repl && repl.transport === "command", "node_repl TOML 候选解析为 command");
  assert(repl?.env.includes("NODE_REPL_PIPE") === true, "TOML 嵌套 env 表解析成功");
  assert(!existsSync(appGlobal), "尚未写入应用全局");
}

console.log("\n[3] 安装到 MyBuddy（应用全局）");
{
  const r = service.installServers(["espressif-documentation", "esp-component-registry"]);
  assert(r.ok === true, "安装成功");
  assert(r.added?.length === 2, "added 2 个");
  assert(r.path === appGlobal, "写入应用全局路径");
  const raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  assert(raw.mcpServers["esp-component-registry"]?.url === "https://components.espressif.com/mcp", "定义已写入");
  const servers = service.listServers();
  assert(servers.find((s) => s.name === "esp-component-registry")?.installed === true, "安装后 installed=true");
  const repl = servers.find((s) => s.name === "node_repl");
  assert(!!repl && repl.installed === false, "未安装的候选仍在候选区");
}

console.log("\n[4] 停用与启用");
{
  let r = service.setServerEnabled("espressif-documentation", false);
  assert(r.ok === true, "停用成功");
  assert(service.listServers().find((s) => s.name === "espressif-documentation")?.disabled === true, "停用后 disabled=true");

  r = service.setServerEnabled("espressif-documentation", true);
  assert(r.ok === true, "启用成功");
  assert(service.listServers().find((s) => s.name === "espressif-documentation")?.disabled === false, "启用后 disabled=false");

  r = service.setServerEnabled("ghost-server", false);
  assert(r.ok === false && (r.error ?? "").includes("尚未安装"), "未安装服务器停用被拒绝");
}

console.log("\n[5] 从 MyBuddy 移除");
{
  const r = service.removeServers(["espressif-documentation"]);
  assert(r.ok === true && r.removed?.includes("espressif-documentation") === true, "移除成功");
  const raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  assert(raw.mcpServers["espressif-documentation"] === undefined, "应用全局中定义已删除");
  assert(raw.mcpServers["esp-component-registry"] !== undefined, "未选中的服务器保留");
}

console.log("\n[6] 安装不存在的服务器");
{
  const r = service.installServers(["does-not-exist"]);
  assert(r.ok === false && (r.error ?? "").includes("未找到"), "未找到时报错");
}

console.log("\n[6.5] Draw.io（ensureDrawioServer）幂等 / 停用尊重 / 过期更新 / modes 隔离");
{
  const drawioPayload: DrawioMcpPayload = {
    command: "C:\\Program Files\\nodejs\\npx.cmd",
    args: ["@next-ai-drawio/mcp-server@latest"],
    env: { PORT: "6002" },
    port: 6002,
  };
  const installed = service.ensureDrawioServer(drawioPayload);
  assert(installed.ok === true && installed.added?.includes("drawio-ai") === true, "缺失时写入 drawio-ai 条目");
  let raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  const entry = raw.mcpServers["drawio-ai"];
  assert(entry?.command === drawioPayload.command, "条目 command = 解析后的 npx");
  assert(
    JSON.stringify(entry?.args) === JSON.stringify(drawioPayload.args),
    "条目 args = [@next-ai-drawio/mcp-server@latest]",
  );
  assert(entry?.env?.PORT === "6002", "条目 env 含 PORT=6002");
  assert(JSON.stringify(entry?.modes) === JSON.stringify(["working"]), "条目 modes=[working]（不泄漏到 coding/design）");
  assert(entry?.disabled !== true, "条目未停用");
  // 幂等：内容一致 => 不重写
  const again = service.ensureDrawioServer(drawioPayload);
  assert(again.ok === true && !again.added && !again.removed, "内容一致 => 幂等不重写");
  // 过期（command 变化，如 npx 解析结果更新）=> 重写，保留 modes
  const stalePayload: DrawioMcpPayload = {
    ...drawioPayload,
    command: "C:\\Users\\me\\AppData\\Roaming\\nvm\\npx.cmd",
  };
  const updated = service.ensureDrawioServer(stalePayload);
  assert(updated.ok === true && updated.removed?.includes("drawio-ai") === true, "过期条目被重写");
  raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  assert(
    raw.mcpServers["drawio-ai"]?.command === stalePayload.command,
    "重写后 command 指向新 npx",
  );
  assert(
    JSON.stringify(raw.mcpServers["drawio-ai"]?.modes) === JSON.stringify(["working"]),
    "重写保留 modes=[working]",
  );
  // 用户停用 => 尊重，不碰
  assert(service.setServerEnabled("drawio-ai", false).ok === true, "停用 drawio-ai 成功");
  const respect = service.ensureDrawioServer(stalePayload);
  assert(respect.ok === true, "停用状态下 ensure 不报错");
  raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  assert(raw.mcpServers["drawio-ai"]?.disabled === true, "用户显式停用不被自动恢复");
  assert(service.setServerEnabled("drawio-ai", true).ok === true, "重新启用 drawio-ai 成功");
  // payload 为 null（npx 未解析到）=> 不写、不破坏现有条目
  const noNpx = service.ensureDrawioServer(null);
  assert(noNpx.ok === false && (noNpx.error ?? "").includes("npx 未解析"), "npx 未解析 => 明确失败原因");
  raw = JSON.parse(readFileSync(appGlobal, "utf-8"));
  assert(raw.mcpServers["drawio-ai"] !== undefined, "null payload 不删除现有条目");
}

console.log("\n[7] 应用全局配置文件读写");
{
  const r = service.readAppConfig();
  assert(r.path === appGlobal && r.text.includes("esp-component-registry"), "读取应用全局内容");

  // JSONC 整体覆写
  const w = service.writeAppConfig(`{
  // 手动注释
  "mcpServers": {
    "custom": { "command": "npx", "args": ["-y", "custom-mcp"], },
  },
}`);
  assert(w.ok === true, "JSONC 整体覆写成功");
  const servers = service.listServers();
  assert(servers.find((s) => s.name === "custom")?.installed === true, "覆写后生效（JSONC 解析）");

  const bad = service.writeAppConfig("{ invalid json");
  assert(bad.ok === false, "非法 JSON 被拒绝");
}

console.log("\n全部通过 ✔");
