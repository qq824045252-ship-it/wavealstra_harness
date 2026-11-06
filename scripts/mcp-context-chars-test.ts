/**
 * mcp-context-chars-test.ts — MCP 元工具定义字符数（上下文用量弹窗 MCP 分类）的行为断言。
 *
 * 被测契约（用户最终在弹窗里看到的那一个数字的来源）：
 *   1) `mcpToolDefinitionChars(tools)` = Σ 每个元工具的 name + description + JSON.stringify(parameters)；
 *   2) `DurableMcp.contextFacts()` 返回 `{ chars, tools, servers }`，tools 与 `host.tools.length` 一致，
 *      servers 与已配置服务器数量一致；
 *   3) 服务器清单写在 `mcp_list_tools.description` 里 → servers 变化时 chars 精确按
 *      「换行 + name[: description]」增长，其余 4 个元工具定义完全不变；
 *   4) 无服务器时只算固定的 5 个元工具（1088 字符），不会因为是 0 个服务器就变成 0 ——
 *      这 5 个元工具始终注入，所以 MCP 分类不该再恒显示「—」。
 *
 * 口径说明：这里是字符数（JS UTF-16 code unit），不是 token；界面按 4 字符 ≈ 1 token 估算。
 * 只测纯函数与 `open()` 的本地配置投影，不连接任何服务器、不联网。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableMcp, mcpToolDefinitionChars } from "../src/main/agent/durable/DurableMcp";
import type {
  LoadedMcpConfig,
  McpOAuthCredentialStore,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

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
function eq<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

/** `open()` 只会把这些存起来；不会有任何网络/凭据访问。 */
const CREDENTIALS = {} as McpOAuthCredentialStore;
const MODELS = {} as ModelRuntime;

function loadedConfig(servers: Array<{ name: string; description?: string }>): LoadedMcpConfig {
  return {
    autoEnableCodemode: true,
    errors: [],
    servers: servers.map((server) => ({
      name: server.name,
      source: "mcp-context-chars-test",
      scope: "global" as const,
      config: {
        type: "stdio" as const,
        command: "node",
        args: [] as string[],
        ...(server.description ? { description: server.description } : {}),
      },
    })),
  } as unknown as LoadedMcpConfig;
}

function open(servers: Array<{ name: string; description?: string }>): Promise<DurableMcp> {
  return DurableMcp.open(loadedConfig(servers), CREDENTIALS, MODELS, process.cwd());
}

/** 每个元工具定义的分项字符数：name 长度 + description 长度 + 参数 schema 序列化长度。 */
function contribution(tool: { name: string; description?: string; parameters?: unknown }): number {
  return tool.name.length + (tool.description ?? "").length + JSON.stringify(tool.parameters ?? {}).length;
}

console.log("== 1. 纯函数：等于各定义串长之和（手算夹具）==");
{
  eq(mcpToolDefinitionChars([]), 0, "空数组 → 0 字符");

  const schema = '{"type":"object"}'; // 17 字符
  eq(schema.length, 17, "夹具 schema 字面量长度 17（与 JSON.stringify 无关）");
  const tool = { name: "ab", description: "cd", parameters: { type: "object" } };
  eq(
    mcpToolDefinitionChars([tool] as never),
    2 + 2 + 17,
    "name(2) + description(2) + \"{\\\"type\\\":\\\"object\\\"}\"(17) = 21",
  );

  const second = { name: "efg", description: "", parameters: { type: "object" } };
  eq(
    mcpToolDefinitionChars([tool, second] as never),
    21 + 3 + 0 + 17,
    "多个工具逐项累加（3 + 0 + 17 = 20，合计 41）",
  );

  // 没有 description / parameters 的真实注册形态：缺 description 记 0；缺 parameters 记 2（"{}"）
  const bare = { name: "x" };
  eq(mcpToolDefinitionChars([bare] as never), 1 + 0 + 2, "缺 description/parameters 时退化：1 + 0 + \"{}\"(2) = 3");
}

console.log("== 2. 无服务器：仍然只算固定的 5 个元工具（这正是弹窗 MCP 行有数字的原因）==");
const empty = await open([]);
{
  const facts = empty.contextFacts();
  const expected = empty.tools.reduce((n, tool) => n + contribution(tool), 0);
  eq(facts.tools, 5, "元工具个数 = 5");
  eq(facts.servers, 0, "已配置服务器个数 = 0");
  eq(facts.chars, expected, "contextFacts().chars === 各工具定义串长之和");
  eq(facts.chars, 1088, "无服务器时实测 1088 字符（>0，所以 MCP 分类不再是「—」）");
  assert(facts.chars > 0, `MCP 元工具始终注入 → chars > 0（实际 ${facts.chars}）`);

  const names = empty.tools.map((tool) => tool.name);
  eq(
    names,
    ["mcp_list_tools", "mcp_call_tool", "mcp_list_resources", "mcp_read_resource", "mcp_status"],
    "注入的正是 5 个固定元工具",
  );

  // 每个工具的分项：把「定义变化会改数字」固定在真实值上，避免描述被悄悄改小
  const perTool = empty.tools.map((tool) => [tool.name, contribution(tool)]);
  eq(
    perTool,
    [
      ["mcp_list_tools", 232],
      ["mcp_call_tool", 357],
      ["mcp_list_resources", 184],
      ["mcp_read_resource", 173],
      ["mcp_status", 142],
    ],
    "逐工具字符数（name + description + schema）",
  );

  const again = empty.contextFacts();
  eq(again, facts, "contextFacts() 是纯读：连续调用结果一致");
  eq(empty.tools.length, 5, "读取上下文事实不会增删工具定义");
}

console.log("== 3. 服务器清单长度随 servers 变化（写进 mcp_list_tools.description）==");
{
  const one = await open([{ name: "alpha" }]);
  const oneFacts = one.contextFacts();
  eq(oneFacts.servers, 1, "1 台服务器 → servers = 1");
  eq(oneFacts.tools, 5, "服务器数量不影响元工具个数");
  eq(
    oneFacts.chars,
    empty.contextFacts().chars + "alpha".length,
    "清单从空到 1 行：增量 = 服务器名长度（首行没有换行）",
  );
  eq(oneFacts.chars, 1093, "1 台无描述服务器 = 1088 + 5 = 1093 字符");

  const described = await open([{ name: "alpha", description: "第一台服务器" }]);
  const describedFacts = described.contextFacts();
  eq(
    describedFacts.chars,
    empty.contextFacts().chars + "alpha: 第一台服务器".length,
    "带描述：增量 = name + \": \" + description（中文按 UTF-16 字符计）",
  );

  const two = await open([{ name: "alpha" }, { name: "beta", description: "第二台服务器" }]);
  const twoFacts = two.contextFacts();
  eq(twoFacts.servers, 2, "2 台服务器 → servers = 2");
  eq(
    twoFacts.chars - oneFacts.chars,
    "\n".length + "beta: 第二台服务器".length,
    "新增一行 = 换行 + name + \": \" + description（13 字符）",
  );
  eq(twoFacts.chars, 1106, "2 台服务器（第二台带描述）= 1106 字符");

  // 只有 mcp_list_tools 的 description 变，其余 4 个元工具定义必须逐字节相同
  const others = (host: DurableMcp): string =>
    JSON.stringify(host.tools.filter((tool) => tool.name !== "mcp_list_tools").map((tool) => [tool.name, tool.description, tool.parameters]));
  eq(others(two), others(one), "服务器清单只改 mcp_list_tools，其余 4 个元工具定义不变");
  const listToolsDescription = (host: DurableMcp): string =>
    host.tools.find((tool) => tool.name === "mcp_list_tools")?.description ?? "";
  assert(
    listToolsDescription(two).includes("alpha") && listToolsDescription(two).includes("beta: 第二台服务器"),
    "mcp_list_tools.description 里确实带着服务器清单（含描述）",
  );
  assert(
    listToolsDescription(empty).endsWith("Configured servers:\n"),
    "无服务器时清单为空（描述仍以固定头部结尾）",
  );
}

console.log("== 4. 字符口径与工具数量自洽 ==");
{
  const hosts = [empty, await open([{ name: "solo" }]), await open([{ name: "a" }, { name: "b" }, { name: "c" }])];
  for (const host of hosts) {
    const facts = host.contextFacts();
    eq(facts.tools, host.tools.length, `tools 与 host.tools.length 一致（servers=${facts.servers}）`);
    eq(
      facts.chars,
      mcpToolDefinitionChars(host.tools),
      `chars 与纯函数一致（servers=${facts.servers}）`,
    );
    assert(
      facts.chars >= 1088,
      `任何服务器的宿主都不会低于固定 5 个元工具的下界（实际 ${facts.chars}）`,
    );
  }
}

console.log("== 5. inspectRuntimeContext：真实夹具里确实返回 mcpContext（弹窗拿到的就是它）==");
{
  // 隔离 HOME：AgentService 用 getMyBuddyDir() 装配 MCP 配置，绝不能读真实 ~/.mybuddy。
  const home = mkdtempSync(join(tmpdir(), "mybuddy-mcp-context-projection-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { createAgentDurableFixture } = await import("./agent-durable-fixture");
  const db = new AppDatabase(join(home, "app.db"));
  const taskId = "mcp-context-projection";
  db.upsertTask({ id: taskId, title: "MCP context projection", updatedAt: 1, welcomeMode: "coding" });
  const fixture = await createAgentDurableFixture(home, db);
  const { agent } = fixture;
  try {
    const before = agent.inspectRuntimeContext(taskId);
    eq(before.mcpContext, null, "bot 尚未打开 → mcpContext = null，且不会为统计去建 host/连接服务器");

    await fixture.prompt({
      taskId,
      text: "hello",
      userMessageId: "mcp-context-user",
      assistantMessageId: "mcp-context-answer",
      welcomeMode: "coding",
    });

    const after = agent.inspectRuntimeContext(taskId);
    eq(
      after.mcpContext,
      { chars: 1088, tools: 5, servers: 0 },
      "bot 打开后 DTO 带出实测元工具字符数（该夹具没有配置 MCP 服务器）",
    );
    assert((after.mcpContext?.chars ?? 0) > 0, `弹窗 MCP 行有真实数字（chars=${after.mcpContext?.chars}）`);
    eq(after.mcpContext?.tools, after.mcpContext ? 5 : null, "tools 字段 = 5 个元工具");
    eq(after.mcpContext?.servers, 0, "servers 字段 = 已配置服务器数");
    eq(
      agent.inspectRuntimeContext(taskId).mcpContext,
      after.mcpContext,
      "重复检视是只读投影：数字稳定，不会触发新的装配",
    );

    await agent.releaseDurableTask(taskId);
    eq(
      agent.inspectRuntimeContext(taskId).mcpContext,
      null,
      "bot 释放/退役后回到 null，不返回陈旧数字（渲染层据此显示「—」）",
    );
  } finally {
    await fixture.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
