import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import type { SingleResult } from "../src/main/capabilities/subagent/index";

const root = mkdtempSync(join(tmpdir(), "subagent-pstack-execution-"));
const agentDir = join(root, "agent");
const repository = join(root, "source");
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const calls: Array<{ model: string; body: string }> = [];
const spawns: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
let serverError: unknown;
const originalSpawn = childProcess.spawn;
let extension: typeof import("../src/main/capabilities/subagent/index") | undefined;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = JSON.parse(text);
    assert(body && typeof body === "object" && "model" in body && typeof body.model === "string");
    assert(request.url?.endsWith("/responses"));
    assert(["a", "b"].includes(body.model));
    calls.push({ model: body.model, body: text });
    if (text.includes("slow-response")) await new Promise(done => setTimeout(done, 1500));
    if (text.includes("revoke-allowlist")) {
      writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ allowedModels: [] }));
    }
    if (text.includes("provider-failure-fixture") && text.includes("function_call_output")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider-failure-fixture", type: "invalid_request_error" } }));
      return;
    }
    const completed = text.includes("function_call_output") || text.includes("parent-selection-only");
    const output = completed
      ? [{ type: "message", id: `msg_${calls.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Completed ${body.model}`, annotations: [] }] }]
      : [{ type: "function_call", id: `fc_${calls.length}`, call_id: `call_${calls.length}`, name: "write", arguments: JSON.stringify({ path: "shared.txt", content: `written-by-${body.model}\n` }) }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of output) {
      for (const type of ["response.output_item.added", "response.output_item.done"]) {
        response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
      }
    }
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${calls.length}`, model: body.model, status: "completed", output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch (error) {
    serverError = error;
    response.writeHead(500).end("{}");
  }
});
try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(repository);
  const models = ["a", "b"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 2048, thinkingLevelMap: { off: "none", high: "high" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", models } } }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "a", enabledModels: ["fixture/a", "fixture/b"], permissionMode: "auto" }));
  writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: fixture worker\ntools: write\n---\nWrite the requested fixture file, then report completion.\n");
  writeFileSync(join(repository, "shared.txt"), "source-content\n");
  const git = (...args: string[]) => childProcess.execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init");
  git("add", "shared.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const baseCommit = git("rev-parse", "HEAD");
  childProcess.spawn = new Proxy(originalSpawn, {
    apply(target, receiver, args) {
      const [command, argv, options] = args;
      if (Array.isArray(argv) && argv.some((arg) => String(arg).endsWith("worker-launcher.mjs"))) {
        spawns.push({ command, args: [...argv], cwd: String(options.cwd) });
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: {
      electron: { ipcMain: { handle() {}, removeHandler() {} }, BrowserWindow: { getAllWindows: () => [] } },
    },
  });
  interface ToolResult { isError?: boolean; content?: Array<{ text?: string }>; details?: { results: SingleResult[] } }
  interface Tool { name: string; execute: (id: string, args: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<ToolResult> }
  extension = await jiti.import<typeof import("../src/main/capabilities/subagent/index")>(resolve("src/main/capabilities/subagent/index.ts"));
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const native = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  extension.attachSubagentModelRuntime(native);
  const tools: Tool[] = [];
  extension.default({ registerTool: (tool: Tool) => tools.push(tool), on() {} });
  const tool = tools.find((entry) => entry.name === "subagent");
  assert(tool);
  const parentModel = native.getModels().find((model) => model.provider === "fixture" && model.id === "b");
  assert(parentModel);
  const ctx = { cwd: repository, model: parentModel, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "fixture-parent" } };
  const invoke = (args: unknown) => tool.execute("fixture-call", args, undefined, undefined, ctx);
  const text = (result: ToolResult) => result.content?.map((item) => item.text ?? "").join("\n") ?? "";
  const invalid = await invoke({ agent: "worker", task: "must not run", model: "fixture/missing", isolation: "worktree" });
  assert.equal(invalid.isError, true, text(invalid));
  assert.match(text(invalid), /unavailable|范围|不可用/);
  assert.equal(spawns.length, 0, "unknown explicit model must not spawn");
  assert.equal(calls.length, 0, "unknown explicit model must not call provider");
  assert(!existsSync(join(agentDir, "subagent-worktrees")), "unknown explicit model must not allocate a worktree");

  const unsupported = await invoke({ agent: "worker", task: "must not run", model: "fixture/a", reasoning: { budgetTokens: 500 }, isolation: "worktree" });
  assert.equal(unsupported.isError, true, text(unsupported));
  assert.match(text(unsupported), /reasoning.*losslessly/);
  assert.equal(spawns.length, 0, "unsupported explicit reasoning must not spawn");
  assert.equal(calls.length, 0, "unsupported explicit reasoning must not call provider");
  assert(!existsSync(join(agentDir, "subagent-worktrees")), "unsupported explicit reasoning must not allocate a worktree");

  const parallel = await invoke({ isolation: "auto", tasks: [
    { agent: "worker", task: "Write shared.txt for a", model: "fixture/a", reasoning: { effort: "high" } },
    { agent: "worker", task: "Write shared.txt for b", model: "fixture/b", reasoning: { effort: "high" } },
  ] });
  assert(!parallel.isError, text(parallel));
  assert.equal(serverError, undefined);
  assert.equal(parallel.details?.results.length, 2, text(parallel));
  assert(parallel.details);
  const results = parallel.details.results;
  const workdirs = new Set<string>();
  for (const [index, result] of results.entries()) {
    const id = index === 0 ? "a" : "b";
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.resolvedModel, `fixture/${id}`);
    assert.equal(result.model, id, "worker must report its actual model");
    assert.equal(result.resolvedThinking, "high");
    assert.equal(result.workspace?.kind, "worktree");
    assert(result.workspace?.kind === "worktree");
    workdirs.add(result.workspace.cwd);
    assert.equal(readFileSync(join(result.workspace.cwd, "shared.txt"), "utf8"), `written-by-${id}\n`);
    const receipt: unknown = JSON.parse(readFileSync(result.workspace.receiptPath, "utf8"));
    assert(receipt && typeof receipt === "object" && "state" in receipt && "baseCommit" in receipt);
    assert.equal(receipt.state, "ready");
    assert.equal(receipt.baseCommit, baseCommit);
    const worker = spawns.find((spawn) => spawn.cwd === result.workspace?.cwd);
    assert(worker, "actual child cwd must equal its retained worktree");
    assert.equal(worker.args[worker.args.indexOf("--model") + 1], `fixture/${id}`);
    assert.equal(worker.args[worker.args.indexOf("--thinking") + 1], "high");
    assert(worker.args.some((arg) => arg.endsWith("worker-launcher.mjs")));
    assert(calls.some((call) => call.model === id && call.body.includes('"effort":"high"')), "native provider request must carry high reasoning");
    assert(calls.some((call) => call.model === id && call.body.includes("function_call_output")), "real child must return write result to provider");
  }
  assert.equal(workdirs.size, 2);
  assert.equal(readFileSync(join(repository, "shared.txt"), "utf8"), "source-content\n");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(readdirSync(join(agentDir, "subagent-worktrees")).length, 2);

  const inherited = await invoke({ agent: "worker", task: "parent-selection-only", model: "inherit-parent", isolation: "shared" });
  assert(!inherited.isError, text(inherited));
  assert.equal(inherited.details?.results[0]?.status, "completed", text(inherited));
  assert.equal(inherited.details?.results[0]?.resolvedModel, "fixture/b");
  assert.equal(inherited.details?.results[0]?.model, "b");
  assert.equal(spawns.at(-1)?.cwd, repository);
  const topDefaults = await invoke({ model: "fixture/b", isolation: "shared", tasks: [
    { agent: "worker", task: "parent-selection-only" },
    { agent: "worker", task: "parent-selection-only", model: "fixture/a" },
  ] });
  assert(!topDefaults.isError, text(topDefaults));
  assert(topDefaults.details);
  assert.deepEqual(topDefaults.details.results.map((result) => result.resolvedModel), ["fixture/b", "fixture/a"]);
  assert.deepEqual(topDefaults.details.results.map((result) => result.model), ["b", "a"]);
  for (const result of topDefaults.details.results) {
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(result.workspace, { kind: "shared", cwd: repository });
  }
  assert.equal(readdirSync(join(agentDir, "subagent-worktrees")).length, 2, "top-level shared isolation must prevent parallel worktree allocation");

  const failed = await invoke({ agent: "worker", task: "Write shared.txt then provider-failure-fixture", model: "fixture/a", isolation: "worktree" });
  assert.equal(failed.isError, true, text(failed));
  const failedResult = failed.details?.results[0];
  assert(failedResult);
  assert.equal(failedResult.status, "failed", JSON.stringify(failedResult));
  assert.match(failedResult.errorMessage ?? text(failed), /provider-failure-fixture/);
  assert(failedResult.workspace?.kind === "worktree");
  assert.equal(readFileSync(join(failedResult.workspace.cwd, "shared.txt"), "utf8"), "written-by-a\n", "provider failure must retain the worker's completed write");
  const failedReceipt: unknown = JSON.parse(readFileSync(failedResult.workspace.receiptPath, "utf8"));
  assert(failedReceipt && typeof failedReceipt === "object" && "state" in failedReceipt && "baseCommit" in failedReceipt);
  assert.equal(failedReceipt.state, "ready", "execution failure must preserve the provisioning receipt");
  assert.equal(failedReceipt.baseCommit, baseCommit);
  assert(failedResult.subagentId);
  assert.equal(extension.getRuntime().get(failedResult.subagentId), undefined);
  assert.deepEqual(extension.getRuntime().listActive("fixture-parent"), []);
  assert.equal(extension.getRuntime().debugWorkerCount(failedResult.subagentId), 0);
  const active: unknown = JSON.parse(readFileSync(join(agentDir, "subagent", "active.json"), "utf8"));
  assert(active && typeof active === "object" && "instances" in active);
  assert.deepEqual(active.instances, [], "provider failure must clear the persisted active registry");
  assert.equal(readdirSync(join(agentDir, "subagent-worktrees")).length, 3);
  assert.equal(readFileSync(join(repository, "shared.txt"), "utf8"), "source-content\n");
  assert.equal(git("status", "--porcelain"), "");
  const activeRecord = extension.getRuntime().ensureSubagent({ scope: "fixture-parent", subagentId: "same/id", role: "worker", roleDescription: "collision fixture", roleSource: "user", project: failedResult.workspace.cwd, depth: 1 });
  const spawnCountBeforeCollision = spawns.length;
  for (const subagentId of ["same/id", "same-id"]) {
    const collision = await invoke({ agent: "worker", task: "parent-selection-only", subagentId, model: "fixture/a", isolation: "shared" });
    assert.equal(collision.isError, true, text(collision));
    assert.match(text(collision), /same-id.*已存在/);
    assert.equal(extension.getRuntime().get("same-id"), activeRecord);
    assert.equal(activeRecord.project, failedResult.workspace.cwd);
  }
  assert.equal(spawns.length, spawnCountBeforeCollision, "colliding IDs must not start a second worker");
  assert.equal(serverError, undefined);
  const policyPath = join(agentDir, "subagent.json");
  const restricted = { allowedModels: ["fixture/a"], roles: { fast: ["fixture/b", "fixture/a"], diverse: ["fixture/a", "fixture/b"] }, timeoutMs: 4000, timeoutPolicy: "fixed" };
  writeFileSync(policyPath, JSON.stringify(restricted));
  const spawnCount = spawns.length;
  for (const model of ["fixture/b", "inherit-parent", "auto"]) {
    const blocked = await invoke({ agent: "worker", task: "parent-selection-only", model, isolation: "shared" });
    assert(blocked.isError, text(blocked));
  }
  const blockedPanel = await invoke({ tasks: [1, 2].map(() => ({ agent: "worker", task: "parent-selection-only", model: "diverse" })), isolation: "shared" });
  assert(blockedPanel.isError, text(blockedPanel));
  assert.equal(spawns.length, spawnCount, "all disallowed sources must fail before spawn");
  const fixed = await invoke({ chain: [{ agent: "worker", task: "parent-selection-only slow-response", model: "fast" }], isolation: "shared", timeout_ms: 1000 });
  assert(!fixed.isError, text(fixed));
  assert.equal(fixed.details?.results[0].resolvedModel, "fixture/a");
  assert.equal(fixed.details?.results[0].timeoutMs, 4000);
  assert.equal(fixed.details?.results[0].timeoutSource, "settings");
  writeFileSync(policyPath, JSON.stringify({ ...restricted, timeoutPolicy: "allow-override" }));
  const overridden = await invoke({ agent: "worker", task: "parent-selection-only slow-response", model: "fast", isolation: "shared", timeout_ms: 1000 });
  assert.equal(overridden.details?.results[0].status, "timedout", text(overridden));
  assert.equal(overridden.details?.results[0].timeoutMs, 1000);
  assert.equal(overridden.details?.results[0].timeoutSource, "invocation");
  writeFileSync(policyPath, JSON.stringify(restricted));
  const beforeRevocation = calls.length;
  const revoked = await invoke({ agent: "worker", task: "revoke-allowlist", model: "fast", isolation: "shared" });
  assert(revoked.isError, text(revoked));
  assert.match(text(revoked), /blocked by Settings/);
  assert.equal(calls.length, beforeRevocation + 1, "worker must stop before another provider request after revocation");
  writeFileSync(policyPath, "{broken");
  await assert.rejects(() => invoke({ agent: "worker", task: "must not run", isolation: "shared" }), /JSON|position|property/);
  console.log("PASS registered workers: allowed models on all selection paths, fixed vs per-call limits, live revocation and malformed settings fail closed");
  console.log("PASS real registered subagent and Pi workers: strict rejection, model/reasoning selection, isolation defaults, retained success/failure work, registry cleanup, parent inheritance, normalized ID collision rejection");
} finally {
  extension?.getRuntime().shutdownAll();
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  assert(root.startsWith(join(tmpdir(), "subagent-pstack-execution-")));
  rmSync(root, { recursive: true, force: true });
}
