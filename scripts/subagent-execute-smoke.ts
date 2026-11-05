/**
 * 回归：subagent 工具 execute 不得再抛 taskScope is not defined。
 * 用真实 jiti 加载 src/main/capabilities/subagent（仅用于测试隔离重载），写入最小 worker 角色后调用。
 */
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "subagent-exec-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

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

async function main(): Promise<void> {
  mkdirSync(join(sandbox, "agents"), { recursive: true });
  writeFileSync(
    join(sandbox, "agents", "worker.md"),
    "---\nname: worker\ndescription: test worker\n---\nYou are a test worker.\n",
    "utf-8",
  );

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: {
      electron: { ipcMain: { handle() {}, removeHandler() {} }, BrowserWindow: { getAllWindows: () => [] } },
    },
  });
  const subagentModule = (await jiti.import(join(process.cwd(), "src", "main", "capabilities", "subagent", "index"))) as {
    default: (pi: unknown) => void;
    attachSubagentModelRuntime: (runtime: unknown) => void;
    buildSubagentIdLine?: (result: { subagentId: string; displayName?: string }) => string;
  };
  const factory = subagentModule.default;

  const fakeModel = {
    id: "smoke-model",
    name: "Smoke Model",
    api: "openai-responses",
    provider: "smoke",
    baseUrl: "http://127.0.0.1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 1024,
  };
  subagentModule.attachSubagentModelRuntime({
    getAvailable: async () => [fakeModel],
    getModels: () => [fakeModel],
  });

  type ExecuteResult = {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    details?: { results?: Array<{ subagentId?: string; displayName?: string }> };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<ExecuteResult> }> = [];
  factory({
    registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<ExecuteResult> }) => tools.push(t),
    on: () => undefined,
  });
  const sub = tools.find((t) => t.name === "subagent");
  assert(Boolean(sub), "注册了 subagent 工具");
  if (!sub) {
    rmSync(sandbox, { recursive: true, force: true });
    process.exit(1);
  }

  const ctx = { cwd: sandbox, hasUI: false, ui: {} };
  const unknown = await sub.execute("c1", { agent: "nope", task: "x" }, undefined, undefined, ctx);
  const unknownText = unknown.content?.[0]?.text ?? "";
  assert(unknownText.includes("Unknown agent"), `未知角色仍拒绝（${unknownText.slice(0, 80)}）`);

  const def = await sub.execute("c2", { agent: "default", task: "ping" }, undefined, undefined, ctx);
  const defText = def.content?.[0]?.text ?? "";
  assert(!/taskScope is not defined/i.test(defText), `default 别名不再 ReferenceError（${defText.slice(0, 120)}）`);
  assert(!/Cannot find module/i.test(defText), "default worker 不得出现 Capability 模块路径错误");
  const autoName = def.details?.results?.[0]?.displayName ?? "";
  assert(autoName.length > 0 && /[\u4e00-\u9fff]/.test(autoName), `未传 displayName → 自动分配中文名（${autoName}）`);

  const worker = await sub.execute("c3", { agent: "worker", task: "ping" }, undefined, undefined, ctx);
  const workerText = worker.content?.[0]?.text ?? "";
  assert(!/taskScope is not defined/i.test(workerText), `worker 不再 ReferenceError（${workerText.slice(0, 120)}）`);
  assert(!/Cannot find module/i.test(workerText), "worker 不得出现 Capability 模块路径错误");

  // displayName：纯显示字段，结果文本通过 `> subagent-name:` 桥接到完成态列表。
  // 本用例没有可用默认模型 → 失败发生在 ensure 之前，不允许留下孤立名字行。
  const named = await sub.execute("c4", { agent: "worker", task: "ping", displayName: "皮卡丘" }, undefined, undefined, ctx);
  const namedText = named.content?.[0]?.text ?? "";
  assert(!namedText.includes("subagent-name"), "实例未创建时不输出孤立 displayName 标记");
  assert(named.details?.results?.[0]?.displayName === "皮卡丘", "显式 displayName 覆盖自动分配");
  const markerLine = subagentModule.buildSubagentIdLine?.({ subagentId: "pikachu-abc", displayName: "皮卡丘" }) ?? "";
  assert(
    markerLine.includes("> subagent-name: 皮卡丘") && markerLine.includes("> subagent: pikachu-abc"),
    `标记行同时携带名字与 id（${markerLine.slice(0, 80)}）`,
  );
  const noNameLine = subagentModule.buildSubagentIdLine?.({ subagentId: "pikachu-abc" }) ?? "";
  assert(!noNameLine.includes("subagent-name") && noNameLine.includes("> subagent: pikachu-abc"), "未传名字 → 不输出名字行");

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
