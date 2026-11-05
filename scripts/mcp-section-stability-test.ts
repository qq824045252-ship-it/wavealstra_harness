/**
 * MCP 系统提示段稳定性回归（离线，纯函数）。
 *
 * 约束：`mcp_servers` 系统提示段只由配置决定，不得随 MCP 连接状态变化。否则每次连接/重连都会
 * 改写系统提示前缀，让整段请求缓存失效。本用例把 `renderServersSection` 的输出钉在配置上：
 *
 * 1. 同一组服务器，connection 缺失 与 connection 带长 instructions（connected / failed）三种情况下，
 *    输出必须逐字节相同；
 * 2. 增加一台带 description 的服务器时输出必须变化（证明没有把段落过度冻结成常量）；
 * 3. 无 description 的服务器只有标题行，不得出现 undefined / null / 悬空冒号；
 * 4. 30 台服务器时整段不超过 4096 字符，且出现省略行，省略数与保留数之和等于服务器总数；
 * 5. 有 description 的服务器行包含其首行，多行描述只取首行。
 *
 * 走真实的 dist 文件（按真实路径动态加载，不复制实现），无网络、不读用户配置。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 被测实现：pi-coding-agent 内置 MCP 扩展。按 dist 真实路径加载，pnpm 依赖从该位置解析。 */
const MCP_EXTENSION_DIST = "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js";
/** 与实现一致的整段字符上限。 */
const MAX_SERVERS_SECTION_CHARS = 4096;

type Exposure = "codemode" | "deferred" | "direct" | "hidden";
type ServerEntry = {
  name: string;
  config: { description?: string; enabled?: boolean; exposure?: Exposure; toolExposure?: Record<string, Exposure> };
};
type ConnectionState = "connected" | "connecting" | "failed" | "needs-auth" | "disconnected";
type ServerConnection = {
  state: ConnectionState;
  instructions?: string;
  tools?: Array<{ name: string; description?: string }>;
  hasResources?: boolean;
};
type Server = { entry: ServerEntry; connection?: ServerConnection };
type RenderServersSection = (servers: readonly Server[]) => string | undefined;

type CaseResult = { name: string; status: "passed" } | { name: string; status: "failed"; error: string };
const checks: CaseResult[] = [];
const evidence: Array<{ label: string; value: string }> = [];

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const evidenceRow = (label: string, value: string): void => {
  evidence.push({ label, value });
  console.log("  · " + label + ": " + value);
};
const rows = (section: string): string[] => section.split("\n");
/** 服务器行（不含 intro 与省略行）。 */
const serverRows = (section: string): string[] => rows(section).filter((row) => row.startsWith("- mcp__"));
const clone = <T>(value: T): T => structuredClone(value);

/** 加载被测函数；缺失即视为用例环境损坏。 */
const loaded: { renderServersSection?: RenderServersSection } = await import(pathToFileURL(resolve(MCP_EXTENSION_DIST)).href);
const renderServersSection: RenderServersSection = (() => {
  const candidate = loaded.renderServersSection;
  if (typeof candidate !== "function") {
    console.error(`FAIL 环境: ${MCP_EXTENSION_DIST} 未导出 renderServersSection`);
    process.exitCode = 1;
    throw new Error("renderServersSection is not exported");
  }
  return candidate;
})();

/** 调用被测函数并把 undefined 变成显式失败，避免后续断言退化成 "undefined".includes。 */
function render(servers: readonly Server[]): string {
  const section = renderServersSection(servers);
  assert.equal(typeof section, "string", "该组服务器应产出一段 mcp_servers 文本");
  return section as string;
}

async function runCheck(name: string, body: () => void): Promise<void> {
  try {
    body();
    checks.push({ name, status: "passed" });
    console.log("PASS " + name);
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    checks.push({ name, status: "failed", error: detail });
    console.error("FAIL " + name + "\n" + detail);
  }
}

/** 基准服务器组：两台带 description、一台只有标题行（连接期曾经从 instructions 借描述的那类）。 */
const baseline: Server[] = [
  {
    entry: {
      name: "alpha-docs",
      config: { exposure: "codemode", description: "Read the project documentation\nSecond description line must never reach the section" },
    },
  },
  { entry: { name: "beta-notes", config: { exposure: "codemode" } } },
  { entry: { name: "gamma-index", config: { exposure: "deferred", description: "  Search the symbol index  " } } },
];

/** 连接期才会有的内容：长 instructions（多行）、工具清单、资源标记。 */
const longInstructions = Array.from(
  { length: 12 },
  (_unused, index) => `Instruction line ${index + 1}: reconnect details and per-connection prose must never reach the section`,
).join("\n");

const disconnected: Server[] = clone(baseline); // connection 字段整体缺失
const connected: Server[] = clone(baseline).map((server) => ({
  entry: server.entry,
  connection: {
    state: "connected",
    instructions: longInstructions,
    tools: [{ name: "search" }, { name: "read" }],
    hasResources: true,
  },
}));
const failedConnection: Server[] = clone(baseline).map((server) => ({
  entry: server.entry,
  connection: { state: "failed", instructions: longInstructions },
}));
const connecting: Server[] = clone(baseline).map((server) => ({
  entry: server.entry,
  connection: { state: "connecting" },
}));

const savedFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network is prohibited in this regression");
};

try {
  const cold = render(disconnected);

  await runCheck("connection 缺失与 connection 带长 instructions 输出逐字节相同", () => {
    const connectedSection = render(connected);
    assert.equal(connectedSection, cold, "MCP 系统提示段不得随连接状态变化");
    assert.equal(sha(connectedSection), sha(cold), "字节级不一致：段落被连接期状态污染");
    assert(!connectedSection.includes("Instruction line"), "连接期 instructions 不得出现在段内");
    // 连接状态本身（失败、连接中）同样不得影响段落。
    assert.equal(render(failedConnection), cold, "failed 状态不得改变 MCP 系统提示段");
    assert.equal(render(connecting), cold, "connecting 状态不得改变 MCP 系统提示段");
    // 纯函数：同一输入重复调用结果一致。
    assert.equal(render(disconnected), cold, "同一输入必须产出同一段落");
    evidenceRow("section-sha256", sha(cold));
    evidenceRow("connected-variant-sha256", sha(connectedSection));
    evidenceRow("section-length", String(cold.length));
  });

  await runCheck("新增带 description 的服务器时段落必须变化", () => {
    const extended: Server[] = [
      ...clone(baseline),
      { entry: { name: "delta-metrics", config: { exposure: "codemode", description: "Query the metrics service" } } },
    ];
    const changed = render(extended);
    assert.notEqual(changed, cold, "配置变化必须反映到段落，否则等于把段落冻结成常量");
    assert.equal(sha(changed) === sha(cold), false, "哈希必须变化");
    const deltaRow = serverRows(changed).find((row) => row.startsWith("- mcp__delta_metrics"));
    assert.equal(deltaRow, "- mcp__delta_metrics (codemode): Query the metrics service");
    // 既有服务器行不受新增影响，且仍按名称排序。
    assert.deepEqual(
      serverRows(changed).map((row) => /^- (mcp__\S+)/.exec(row)?.[1] ?? row),
      ["mcp__alpha_docs", "mcp__beta_notes", "mcp__delta_metrics", "mcp__gamma_index"],
      "多服务器必须按名称排序",
    );
    assert.deepEqual(
      serverRows(cold).map((row) => /^- (mcp__\S+)/.exec(row)?.[1] ?? row),
      ["mcp__alpha_docs", "mcp__beta_notes", "mcp__gamma_index"],
    );
    evidenceRow("config-change-delta-rows", String(serverRows(changed).length - serverRows(cold).length));
  });

  await runCheck("无 description 的服务器只有标题行，无 undefined/null/悬空冒号", () => {
    const section = render(clone(baseline));
    const bareRow = serverRows(section).find((row) => row.startsWith("- mcp__beta_notes"));
    assert.equal(bareRow, "- mcp__beta_notes (codemode)", "无描述时只应有标题行");
    assert(!bareRow.includes(":"), "无描述服务器不得出现悬空冒号");
    assert(!/\bundefined\b|\bnull\b|\bNaN\b/.test(section), "段落不得泄漏 undefined/null/NaN");
    assert(!/\s$/.test(bareRow), "行尾不得留空白");
    // 单服务器场景同样成立：intro + 一行标题。
    const single = render([{ entry: { name: "epsilon-tools", config: { exposure: "codemode" } } }]);
    assert.equal(rows(single).length, 2, "单服务器段落 = intro + 一行");
    assert.equal(rows(single)[1], "- mcp__epsilon_tools (codemode)");
    assert(!/\bundefined\b|\bnull\b/.test(single));
    evidenceRow("bare-server-row", bareRow);
    evidenceRow("single-server-rows", String(rows(single).length));
  });

  await runCheck("30 台服务器不超过 4096 字符且出现省略行", () => {
    const pad = "x".repeat(120);
    const many: Server[] = Array.from({ length: 30 }, (_unused, index) => ({
      entry: { name: `server-${String(index + 1).padStart(2, "0")}-${pad}`, config: { exposure: "codemode" } },
    }));
    const section = render(many);
    assert(section.length <= MAX_SERVERS_SECTION_CHARS, `整段 ${section.length} 字符超过上限`);
    const listed = serverRows(section).length;
    const omission = rows(section).find((row) => /more server/.test(row));
    assert(omission, "必须出现省略行");
    const omitted = Number(/- … (\d+) more servers?;/.exec(omission)?.[1] ?? Number.NaN);
    assert.equal(omitted + listed, 30, "保留数 + 省略数必须等于服务器总数");
    assert(listed < 30, "30 台长名称服务器不可能全部保留");
    assert.equal(rows(section).length, listed + 2, "段落 = intro + 服务器行 + 省略行");
    evidenceRow("budget-length", `${section.length}/${MAX_SERVERS_SECTION_CHARS}`);
    evidenceRow("budget-listed-omitted", `${listed} kept / ${omitted} omitted`);
    evidenceRow("budget-omission-row", omission);
  });

  await runCheck("description 首行进段，多行描述只取首行", () => {
    const section = render([
      {
        entry: {
          name: "zeta-plans",
          config: { exposure: "codemode", description: "  First sentence of the description  \nsecond line must be dropped" },
        },
      },
    ]);
    const row = serverRows(section).find((line) => line.startsWith("- mcp__zeta_plans"));
    assert(row, "带 description 的服务器行必须存在");
    assert(row.endsWith(": First sentence of the description"), "行内必须带 description 首行（已 trim）");
    assert.equal(row, "- mcp__zeta_plans (codemode): First sentence of the description");
    assert(!section.includes("second line must be dropped"), "多行描述只取首行");
    evidenceRow("described-server-row", row);
  });
} finally {
  globalThis.fetch = savedFetch;
}

const passed = checks.filter((item) => item.status === "passed").length;
const failed = checks.filter((item) => item.status === "failed").length;
console.log(JSON.stringify({ passed, failed, networkRequests: 0 }));
if (failed > 0) process.exitCode = 1;
