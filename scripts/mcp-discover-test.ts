/** 真实环境只读发现：验证能读到本机所有 MCP 来源（不写任何文件） */
import { McpConfigService } from "../src/main/mcp/McpConfigService";

const service = new McpConfigService();

console.log(`应用全局配置: ${service.getAppGlobalConfigPath()}`);
const d = service.discover();
console.log("=== 来源 ===");
for (const s of d.sources) {
  console.log(`  [${s.exists ? "有" : "无"}] ${s.label.padEnd(16)} ${s.serverCount} 个  ${s.path}`);
}
console.log("=== 兼容来源 ===");
for (const i of d.imports) {
  console.log(`  ${i.label.padEnd(14)} ${i.serverCount} 个  ${i.path}`);
}
console.log("=== 服务器 ===");
for (const s of service.listServers()) {
  console.log(
    `  ${s.name.padEnd(28)} ${s.transport.padEnd(8)} ${s.disabled ? "停用 " : "启用 "} ${s.installed ? "已安装 " : ""}${s.sourceId.padEnd(16)} ${s.endpoint.slice(0, 80)}`,
  );
}
