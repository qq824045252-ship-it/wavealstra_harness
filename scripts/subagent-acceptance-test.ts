/**
 * 子代理验收脚本（v5 四场景 + 装载门禁）。
 *
 * 为什么单独一个脚本，而不是再往 durable-subagent-test.ts 里塞：
 * 1. durable-subagent-test 是「产品行为」的回归门（CI 每轮都跑）；本脚本是「这一轮验收」的
 *    可重复版本——它必须能在报告里落一份带指纹的结论，且默认无运行实例时明确拒绝出结论。
 * 2. v5 报告的四条「未修复」全部来自 10:33 的旧构建（修复 11:03 才提交）。把四个手测场景
 *    写成脚本，才能把「跑在哪个构建上」变成可检查的事实，而不是靠时间戳推断。
 *
 * 用法：
 *   node <bundle>             # headless（CI）：跑四场景，指纹照记，但不出部署结论
 *   node <bundle> --live      # 验收：要求 commit <= 构建 mtime <= 运行实例启动时间，否则 exit 2
 *   node <bundle> --report <path>
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { z } from "zod";
import { createDurableSubagentTools, resolveDurableExecutionCwd } from "../src/main/agent/durable/DurableSubagents";
import { guardSubagentWriteCall } from "../src/main/capabilities/subagent/write-conflict";
import { collectFingerprints, formatFingerprintBlock, validateFingerprints } from "./subagent-acceptance-fingerprint";

const execFileAsync = promisify(execFile);

type Mode = "live" | "headless";
const argv = process.argv.slice(2);
const mode: Mode = argv.includes("--headless") ? "headless" : argv.includes("--live") ? "live" : "headless";
const reportArg = argv[argv.indexOf("--report") + 1];
const reportPath = argv.includes("--report") && reportArg && !reportArg.startsWith("--")
  ? reportArg
  : join(process.cwd(), "out", "acceptance", `subagent-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);

/** 非 Git 工作目录是 v5 环境的关键前提：auto 隔离只有在「并行 + 可写 + >1 子任务」才触发。 */
const root = await mkdtemp(join(tmpdir(), "mybuddy-subagent-acceptance-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "agents"), { recursive: true });
await mkdir(cwd);
const inRepository = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
  .then(() => true).catch(() => false);
assert.equal(inRepository, false,
  `验收前提：工作目录必须在 Git 仓库之外（${cwd}）；auto 隔离的「降级为 shared」路径只在非 Git 目录可复现`);

/** D-2/N-2：fixture write 工具真正落盘过的文件（被拦截的写入不会进这里）。 */
let writtenFiles: Array<{ path: string; content: string }> = [];
const resetWritten = () => { writtenFiles = []; };
let slowRequests: Array<{ released: boolean; closedBeforeRelease: boolean }> = [];
/**
 * N-2 三写者：把三个子会话压在同一个 barrier 上，等它们都到齐再同时下发写入指令，
 * 否则「谁先写完并释放持有」会随调度抖动，场景不稳定。超过 10s 也放行，宁可断言失败也不要挂死。
 */
const makeBarrier = (required: number) => {
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= required) release();
    await Promise.race([allArrived, new Promise<void>(done => setTimeout(done, 10_000).unref())]);
  };
};
/** 只有 conflict 场景需要 barrier；其余场景是空等待。 */
let waitForSiblings: () => Promise<void> = async () => {};

const sse = (response: ServerResponse, items: unknown[]) => {
  if (response.destroyed || response.writableEnded) return;
  try {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of items) for (const type of ["response.output_item.added", "response.output_item.done"]) {
      response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
    }
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Date.now()}`,
      status: "completed", output: items, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch { /* 子会话超时后会主动断开请求，写入失败是预期的 */ }
};

/**
 * 每个验收场景交给父代理的 dispatch 参数，按 prompt 里的 ACCEPT= 标记区分。
 * 与 v5 手测一一对应：单任务 auto / 混合批次 / 同文件并发写 / timeout。
 */
const ACCEPT = "ACCEPT=";
const parentDispatch = (prompt: string): Record<string, unknown> => {
  const marker = prompt.slice(prompt.indexOf(ACCEPT) + ACCEPT.length).trim();
  const model = "fixture/child";
  if (marker.startsWith("single-auto")) return {
    agent: "writer", task: `${ACCEPT}single-auto WRITE:single/a.md=single-auto`, model };
  // D-5 + N-1：1 个 auto（非 Git 下预检必然失败）+ 2 个合法 shared，合法项必须照常执行。
  if (marker.startsWith("mixed")) return { tasks: [
    { agent: "writer", task: `${ACCEPT}mixed one WRITE:mixed/one.md=one`, model },
    { agent: "writer", task: `${ACCEPT}mixed two WRITE:mixed/two.md=two`, model, isolation: "shared" },
    { agent: "writer", task: `${ACCEPT}mixed three WRITE:mixed/three.md=three`, model, isolation: "shared" },
  ] };
  // N-2：三个分片同写一个文件，只允许一个落盘，其余两个标 blocked。
  if (marker.startsWith("conflict")) return { tasks: ["A", "B", "C"].map(content => ({
    agent: "writer", task: `${ACCEPT}conflict WRITE:conflict/same.md=${content}`, model, isolation: "shared" })) };
  // D-4：固定策略下 timeout_ms 必须被忽略且可见；allow-override 下必须真的超时。
  if (marker.startsWith("timeout")) return {
    agent: "writer", task: `${ACCEPT}timeout TIMEOUT_SLOW WRITE:timeout/survived.md=yes`, model,
    isolation: "shared", timeout_ms: 1_000 };
  throw new Error(`未知验收标记：${prompt}`);
};

const fixtureRequest = z.object({
  model: z.string(),
  input: z.array(z.union([
    z.object({ role: z.string(), content: z.union([
      z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]) }),
    z.object({ type: z.string() }),
  ])),
});

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = fixtureRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
    const model = body.model;
    const returned = body.input.some(item => "type" in item && item.type === "function_call_output");
    const prompt = body.input.flatMap(item => "role" in item && item.role === "user"
      ? typeof item.content === "string" ? [item.content] : item.content.flatMap(part => part.text ? [part.text] : [])
      : []).at(-1);
    assert(prompt, "fixture request must contain a user task");
    if (model === "parent") {
      sse(response, [returned
        ? { type: "message", id: "msg_parent_done", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "parent done", annotations: [] }] }
        : { type: "function_call", id: "fc_parent", call_id: "parent_call", name: "subagent",
            arguments: JSON.stringify(parentDispatch(prompt)) }]);
      return;
    }
    // 场景 3：三个子会话先到齐，再同时拿到 write 指令，写冲突才可稳定复现。
    if (!returned && prompt.includes(`${ACCEPT}conflict`)) await waitForSiblings();
    // 场景 4：把子会话请求挂住 3 秒，用来区分「1s 生效」与「1s 被忽略」。
    if (!returned && prompt.includes("TIMEOUT_SLOW")) {
      const pending = { released: false, closedBeforeRelease: false };
      slowRequests.push(pending);
      response.once("close", () => { pending.closedBeforeRelease = !pending.released; });
      await new Promise(done => setTimeout(done, 3_000));
      pending.released = true;
    }
    const write = /WRITE:([^\s=]+)=([^\s]+)/.exec(prompt);
    if (!returned && write) {
      sse(response, [{ type: "function_call", id: "fc_write", call_id: "write_call", name: "write",
        arguments: JSON.stringify({ path: write[1], content: write[2] }) }]);
      return;
    }
    sse(response, [{ type: "message", id: "msg_done", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `${model} done`, annotations: [] }] }]);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(JSON.stringify({ error: String(error) }));
    throw error;
  }
});

type ScenarioResult = { id: string; title: string; ok: boolean; evidence: string[]; note?: string; error?: string };
const results: ScenarioResult[] = [];

try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const models = ["parent", "child"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-only", models } } }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture",
    defaultModel: "parent", enabledModels: ["fixture/parent", "fixture/child"] }));
  // 与 v5 实测一致：固定策略 3600s（报告里的 "fixed policy (3600s settings)"）。
  const subagentSettings = (extra: Record<string, unknown> = {}) => JSON.stringify({
    maxConcurrency: 2, timeoutPolicy: "fixed", timeoutMs: 3_600_000, ...extra });
  await writeFile(join(agentDir, "subagent.json"), subagentSettings());
  await writeFile(join(agentDir, "agents", "writer.md"),
    "---\nname: writer\ndescription: fixture writer\ntools: write\n---\nWrite the file then answer.\n");

  const native = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  /**
   * fixture write：与产品 `write` 同名同形（{path, content}），并真实落盘。
   * 只有真正执行的写入会进 writtenFiles；被并行写冲突拦截的调用根本到不了这里。
   */
  const writeTool = defineTool({ name: "write", description: "Write a file", replay: "unsafe",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (args, api) => {
      assert.equal((await api.agent(ctx)).cwd, cwd, "shared 工作区的子会话必须落在原目录");
      const target = join(cwd, args.path);
      await mkdir(dirname(target), { recursive: true });
      writtenFiles.push({ path: target, content: args.content });
      await writeFile(target, args.content);
      return { output: [{ type: "text", text: `wrote ${args.path}` }] };
    } });

  const open = async (store: string) => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixture",
      tools: [writeTool, ...createDurableSubagentTools({ taskId: "test-task", cwd, models: native,
        permissionMode: () => "auto" })],
      // 与生产 AgentService 同一入口的写冲突钩子：guard 由 runChild 在并行 >1 worker 时注册。
      hooks: [hook(ToolTask, { beforeTool: (call, api) => guardSubagentWriteCall(call, api.conversationId, "test-task") })] }));
    const storage = await openNodeJsonlStorage(store, ctx, { fsync: true });
    return Harness.open(storage, { models: native, registry, env: async (target, context) => new NodeExecutionEnv({
      cwd: await resolveDurableExecutionCwd(target, context, cwd) }) }, ctx);
  };

  const runScenario = async (name: string, settings: Record<string, unknown> = {}) => {
    resetWritten();
    slowRequests = [];
    // 只有 conflict 场景需要 barrier：三个子会话到齐后同时下发写入，冲突才可稳定复现。
    waitForSiblings = name === "conflict" ? makeBarrier(3) : async () => {};
    await writeFile(join(agentDir, "subagent.json"), subagentSettings(settings));
    let scenarioHarness: Harness | undefined;
    const startedAt = Date.now();
    try {
      scenarioHarness = await open(join(root, `state-${name}`));
      const conversation = await scenarioHarness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
      const submission = await conversation.submit({ type: "input", content: `${ACCEPT}${name}`, requestId: `accept-${name}` }, ctx);
      assert.equal((await submission.wait(ctx)).status, "done", `${name}: 根任务必须以 done 结束`);
      const entries = await conversation.entries({}, 200, undefined, ctx);
      const toolResult = entries.items.flatMap(entry => entry.model ?? [])
        .find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert(toolResult?.role === "toolResult", `${name}: 缺少 subagent 工具结果`);
      const output = typeof toolResult.content === "string" ? toolResult.content
        : toolResult.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      const owned = (await scenarioHarness.commit(tx => tx.scanConversations({}, 250), ctx)).items.filter(item => item.owner);
      return { output, details: toolResult.details as { results?: Array<Record<string, unknown>> },
        isError: Boolean(toolResult.isError), children: owned.length, elapsed: Date.now() - startedAt,
        slowRequests: slowRequests.map(item => ({ ...item })) };
    } finally { await scenarioHarness?.close(ctx); }
  };

  const scenario = async (id: string, title: string, body: (evidence: string[]) => Promise<void>, note?: string) => {
    const evidence: string[] = [];
    try { await body(evidence); results.push({ id, title, ok: true, evidence, note }); }
    catch (error) {
      results.push({ id, title, ok: false, evidence, note,
        error: error instanceof Error ? error.message : String(error) });
    }
  };

  // ---- 场景 1（D-5）：非 Git 目录、单任务 isolation:auto → 降级 shared，写入原目录 --------------
  await scenario("single-auto", "D-5 单任务 auto（非 Git）", async evidence => {
    const run = await runScenario("single-auto");
    assert.equal(run.children, 1, "单任务必须真的派出一个子会话");
    assert.equal(run.isError, false, "单任务 auto 不得报错");
    assert.match(run.output, /Workspace: shared \(/, "必须显式说明工作区是 shared");
    assert.match(run.output, /isolation:auto does not isolate a single task; writes land in the original directory\./);
    assert.doesNotMatch(run.output, /Retained worktree:/, "单任务不得虚构 worktree");
    assert.equal(await readFile(join(cwd, "single/a.md"), "utf8"), "single-auto", "写入必须落在原目录");
    assert.equal(run.details.results?.[0]?.status, "completed");
    evidence.push(`header/note: ${/Workspace: shared \(/.test(run.output) ? "Workspace: shared" : "缺失"}`,
      `子会话数: ${run.children}，isError: ${run.isError}`,
      `落盘 single/a.md = ${await readFile(join(cwd, "single/a.md"), "utf8")}`);
  });

  // ---- 场景 2（D-5 + N-1）：混合批次，auto 项逐项 rejected，两个 shared 项照常执行 ------------
  await scenario("mixed", "N-1 混合批次（1 auto + 2 shared）", async evidence => {
    const run = await runScenario("mixed");
    assert.equal(run.children, 2, "只有合法项能创建子会话");
    assert.match(run.output, /^Parallel: 2\/3 succeeded \(1 rejected before start\)/,
      `批次头必须逐项计数：${run.output.slice(0, 240)}`);
    assert.match(run.output, /### \[writer\] rejected \(id: /, "被拒分片必须有自己的结果块");
    assert.match(run.output, /isolation:"shared"/, "拒绝理由必须给出可用替代");
    const one = await readFile(join(cwd, "mixed/two.md"), "utf8");
    const two = await readFile(join(cwd, "mixed/three.md"), "utf8");
    assert.equal(`${one}|${two}`, "two|three", "两个合法分片必须真的执行并落盘");
    await assert.rejects(readFile(join(cwd, "mixed/one.md"), "utf8"), { code: "ENOENT" }, "被拒分片不得执行");
    assert.equal(run.details.results?.length, 3, "被拒项仍要出现在 details 里");
    assert.equal(run.details.results?.filter(item => item.rejected).length, 1);
    evidence.push(`批次头: ${run.output.split("\n")[0]}`,
      `子会话数: ${run.children}（被拒项无子会话）`,
      `落盘: mixed/two.md=${one}，mixed/three.md=${two}；mixed/one.md 不存在（被拒项未执行）`,
      `rows: ${run.details.results?.length}，rejected: ${run.details.results?.filter(item => item.rejected).length}`);
  }, "残留陷阱：混合批次整体仍是 isError=true（任一项非 clean 完成），只看 isError 会误判为「整批失败」。");

  // ---- 场景 3（N-2）：三个分片同写一个文件 → 1/3 succeeded + 2 blocked -----------------------
  await scenario("conflict", "N-2 同文件并发写（3 写者）", async evidence => {
    const run = await runScenario("conflict", { maxConcurrency: 3 });
    assert.equal(run.children, 3);
    assert.match(run.output,
      /^Parallel: 1\/3 succeeded \(2 blocked by write conflict: parallel subagents must write different files\)/,
      `计数口径必须把被拦截的写入排除在 succeeded 之外：${run.output.slice(0, 300)}`);
    assert.equal((run.output.match(/### \[writer\] blocked \(id: /g) ?? []).length, 2, "两个被拦截分片必须标 blocked");
    assert.equal(writtenFiles.length, 1, "只有获胜分片的写入可以落盘");
    const landed = await readFile(join(cwd, "conflict/same.md"), "utf8");
    assert.match(landed, /^(A|B|C)$/, "终态内容必须是某一个分片的完整载荷，不能是混合体");
    const conflicts = run.details.results?.filter(item => Array.isArray(item.writeConflicts) && item.writeConflicts.length) ?? [];
    assert.equal(conflicts.length, 2, "机器可读标记 writeConflicts 必须出现在两个被拦截分片上");
    evidence.push(`批次头: ${run.output.split("\n")[0]}`,
      `blocked 结果块: ${(run.output.match(/### \[writer\] blocked/g) ?? []).length}`,
      `落盘次数: ${writtenFiles.length}，终态 conflict/same.md=${landed}`,
      `writeConflicts 标记数: ${conflicts.length}`);
  }, "残留陷阱：被拦截分片的 details.results[*].status 仍是 completed（设计如此），机器可读标记是 writeConflicts。");

  // ---- 场景 4a（D-4）：fixed 策略下 timeout_ms=1s 被忽略，3s 子会话照常跑完 -------------------
  await scenario("timeout-fixed", "D-4 timeout_ms 在 fixed 策略下被忽略", async evidence => {
    const run = await runScenario("timeout-fixed");
    assert.ok(run.elapsed >= 2_500, `固定策略不得因 timeout_ms=1000 截断 3s 子会话（实测 ${run.elapsed}ms）`);
    assert.equal(run.isError, false, "固定策略下任务必须正常完成");
    assert.match(run.output, /timeout_ms=1000 ignored: fixed policy \(3600s settings\)/);
    assert.match(run.output, /Run time limit: 3600s \(settings\)/, "真正生效的时限必须是 settings 的 3600s");
    assert.equal(await readFile(join(cwd, "timeout/survived.md"), "utf8"), "yes", "3s 后仍要写出结果");
    evidence.push(`耗时: ${run.elapsed}ms（> 2000ms 即证明 1s 覆盖被忽略）`,
      `诊断行: timeout_ms=1000 ignored: fixed policy (3600s settings)`,
      `生效时限: Run time limit: 3600s (settings)`,
      `落盘: timeout/survived.md=yes`);
  }, "判据提醒：v5 把「timeout_ms 必须生效」当验收标准，与默认 fixed 策略的设计相反；这一场景的正确期望是「忽略并可见」。");

  // ---- 场景 4b（D-4）：allow-override 下 timeout_ms=1s 生效，返回真实 timedout -----------------
  await scenario("timeout-override", "D-4 timeout_ms 在 allow-override 下生效", async evidence => {
    const run = await runScenario("timeout-override", { timeoutPolicy: "allow-override" });
    assert.equal(run.isError, true, "超时必须让结果是错误态");
    assert.match(run.output, /Run time limit: 1s \(invocation\)/);
    assert.match(run.output, /Subagent time limit reached/);
    assert.equal(run.details.results?.[0]?.status, "timedout", "子会话必须报告真实 timedout 状态");
    assert.equal(writtenFiles.length, 0, "超时子会话不得执行延迟返回的 write 指令");
    assert.ok(run.slowRequests.some(item => item.closedBeforeRelease), "子会话必须在延迟响应返回前取消请求");
    evidence.push(`总耗时: ${run.elapsed}ms（包含建会话和父任务收尾，不作为子会话时限判据）`,
      "延迟响应返回前请求已关闭，未执行任何写入",
      `limits: Run time limit: 1s (invocation)`,
      `status: ${String(run.details.results?.[0]?.status)}`);
  });

  // ---- 指纹与门禁 -----------------------------------------------------------------------------
  // 指纹锚定 check-out 根而不是当前 shell 目录：test:all 与手工运行通常从仓库根启动，
  // 但显式取 git toplevel 才能保证从子目录运行时不会退化成 commit-missing。
  const repoDir = await execFileAsync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"])
    .then(result => result.stdout.trim()).catch(() => process.cwd());
  const fingerprints = await collectFingerprints({ repoDir });
  const validation = validateFingerprints(fingerprints, mode);
  const failures = results.filter(item => !item.ok);

  const lines: string[] = [];
  lines.push("# 子代理验收报告（自动生成）", "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 模式：${mode === "live" ? "live（验收运行，门禁生效）" : "headless（无运行实例，不能作为部署结论）"}`,
    `- 工作目录：\`${cwd}\`（非 Git，场景前提）`, "", "## 指纹（装载门禁）", "",
    "```", formatFingerprintBlock(fingerprints, validation), "```", "", "## 四场景结果", "",
    "| # | 场景 | 判定 | 关键证据 |", "|---|---|---|---|");
  for (const item of results) {
    lines.push(`| ${item.id} | ${item.title} | ${item.ok ? "PASS" : "FAIL"} | ${item.evidence[0]?.replace(/\|/g, "\\|") ?? ""} |`);
  }
  lines.push("", "## 明细");
  for (const item of results) {
    lines.push("", `### ${item.id} · ${item.title} — ${item.ok ? "PASS" : "FAIL"}`);
    for (const line of item.evidence) lines.push(`- ${line}`);
    if (item.note) lines.push(`- 判据备忘：${item.note}`);
    if (item.error) lines.push(`- 失败原因：${item.error}`);
  }
  lines.push("", "## 结论", "");
  const verdict = failures.length
    ? "FAIL：场景断言失败，不得进入验收"
    : validation.verdictAllowed
      ? "VERDICT ALLOWED：指纹合法，四场景全部通过"
      : "VERDICT DENIED：指纹不满足「commit ≤ 构建 ≤ 运行实例启动」，本轮不能作为部署结论";
  lines.push(verdict, "", "> 判据备忘：混合批次整体 isError 仍为 true；被拦截分片的 details.status 仍为 completed。"
    + "这两项是当前设计，不要据此判「未修复」。");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${lines.join("\n")}\n`);

  for (const item of results) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id} ${item.title}`);
  console.log(formatFingerprintBlock(fingerprints, validation));
  console.log(`report: ${reportPath}`);
  console.log(`verdict: ${verdict}`);

  if (failures.length) throw new Error(`${failures.length} 个验收场景失败：${failures.map(item => item.id).join(", ")}`);
  // 门禁：结论只允许在网上真实运行实例上出；headless 或指纹不合法的运行不得给部署结论。
  if (mode === "live" && !validation.verdictAllowed) {
    process.exitCode = 2;
    throw new Error(`装载门禁拒绝出结论：${validation.problems.map(problem => problem.message).join("；")}`);
  }
  console.log("ALL PASS");
} finally {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
