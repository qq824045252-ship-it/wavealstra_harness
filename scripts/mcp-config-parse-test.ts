/**
 * McpConfigService 兼容来源容错测试（问题 4）。
 *
 * 覆盖：
 * - empty / 纯空白 opencode.json → 视为无配置（静默，不 warn，不产生服务器）；
 * - truncated / invalid JSON → 仅该兼容来源失败（跳过），打印简洁 warning
 *   （单字符串参数、不含整段 stack）；
 * - valid → 正常解析 local/remote 服务器；
 * - invalid 兼容来源绝不影响 MyBuddy 本地 mcp.json（本地服务器照常列出）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpConfigService } from "../src/main/mcp/McpConfigService";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const home = mkdtempSync(join(tmpdir(), "mcp-cfg-"));
const appGlobal = join(home, "mybuddy-mcp.json");
// 本地 MCP（始终有效）：baseline 服务器
writeFileSync(
  appGlobal,
  JSON.stringify({
    mcpServers: { "local-server": { command: "local", args: [] } },
  }),
  "utf8",
);

const opencodeDir = join(home, ".config", "opencode");
mkdirSync(opencodeDir, { recursive: true });
const opencodePath = join(opencodeDir, "opencode.json");
function writeOpencode(content: string): void {
  writeFileSync(opencodePath, content, "utf8");
}

interface WarnCapture {
  args: unknown[][];
  restore: () => void;
}
function captureWarn(): WarnCapture {
  const cap: WarnCapture = { args: [], restore: () => undefined };
  const orig = console.warn;
  cap.restore = () => {
    console.warn = orig;
  };
  console.warn = (...a: unknown[]) => {
    cap.args.push(a);
  };
  return cap;
}

const makeService = (): McpConfigService =>
  new McpConfigService({ appGlobalPath: appGlobal, homeDir: home });

console.log("== 1) empty / 纯空白 = 无配置（静默） ==");
{
  for (const content of ["", "   ", "\n\t  \n", "// 注释-only 占位文件"]) {
    writeOpencode(content);
    const cap = captureWarn();
    const svc = makeService();
    const servers = svc.listServers();
    cap.restore();
    const fromOpencode = servers.filter((s) => s.sourceId === "import:opencode");
    assert(fromOpencode.length === 0, `empty/whitespace（${JSON.stringify(content.slice(0, 12))}）→ 无 opencode 服务器`);
    assert(cap.args.length === 0, `empty/whitespace → 不打印 warning（warns=${cap.args.length}）`);
    assert(servers.some((s) => s.name === "local-server"), "本地 mcp.json 服务器不受影响");
  }
}

console.log("== 2) truncated / invalid → 仅该来源失败 + 简洁 warning ==");
{
  const cases: Array<[string, string]> = [
    ['{"mcp": {"svr": {"type": "local", "command": ["a"]', "truncated JSON"],
    ["{ not json at all", "完全非法"],
    ['{"mcp": {"svr": {"type": "local", "command": "notarray"}}', "结构非法（command 非数组）"],
  ];
  for (const [content, label] of cases) {
    writeOpencode(content);
    const cap = captureWarn();
    const svc = makeService();
    const servers = svc.listServers();
    cap.restore();
    const fromOpencode = servers.filter((s) => s.sourceId === "import:opencode");
    assert(fromOpencode.length === 0, `${label} → opencode 来源被跳过`);
    assert(cap.args.length === 1, `${label} → 恰 1 条 warning（${cap.args.length}）`);
    if (cap.args.length === 1) {
      const arg0 = cap.args[0][0];
      assert(typeof arg0 === "string" && arg0.includes("[McpConfig]"), `${label} → warning 为简洁字符串`);
      assert(cap.args[0].length === 1, `${label} → warning 单参数（无 error 对象 / 无整段 stack）`);
      assert(String(arg0).split("\n").length === 1, `${label} → 单行（无 stack 痕迹）`);
    }
    assert(servers.some((s) => s.name === "local-server"), `${label} → 本地 mcp.json 不受影响`);
  }
}

console.log("== 3) valid → 正常解析 ==");
{
  writeOpencode(
    JSON.stringify({
      mcp: {
        "remote-svr": { type: "remote", url: "https://example.com/mcp" },
        "local-svr": {
          type: "local",
          command: ["uvx", "my-server"],
          environment: { KEY: "v" },
          enabled: true,
        },
        "disabled-svr": { type: "local", command: ["x"], enabled: false },
      },
    }),
  );
  const cap = captureWarn();
  const svc = makeService();
  const servers = svc.listServers();
  cap.restore();
  assert(cap.args.length === 0, "valid → 无 warning");
  const fromOpencode = servers.filter((s) => s.sourceId === "import:opencode");
  assert(fromOpencode.length === 2, `valid → 2 个 opencode 服务器（${fromOpencode.map((s) => s.name).join(",")}）`);
  const local = fromOpencode.find((s) => s.name === "local-svr");
  assert(
    local?.transport === "command" && local?.endpoint === "uvx my-server",
    `local 服务器 command[0]=uvx 正确映射（${local?.transport}/${local?.endpoint}）`,
  );
  const remote = fromOpencode.find((s) => s.name === "remote-svr");
  assert(
    remote?.transport === "url" && remote?.endpoint === "https://example.com/mcp",
    `remote 服务器 url 正确映射（${remote?.transport}）`,
  );
  assert(servers.some((s) => s.name === "local-server"), "本地 mcp.json 服务器仍在");
}

rmSync(home, { recursive: true, force: true });
console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
