const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

const liveModel = process.argv.includes("--bounded-live");
const spaceId = "dots-bounded-workspace";
const upstream = "甲项｜提供上游提交";
const downstream = "乙项｜验证后等待上游";
const upstreamQuote = "把甲项交给第一个任务，等我确认后提交上游文件。";
const downstreamQuote = "把乙项交给第二个任务，做完本地检查后等待甲项交付，再验收并汇报。";
const assignment = upstreamQuote + downstreamQuote;
const liveAssignment = "请在「本地验收工程」委派一个普通任务。修复 calc.cjs，让 double(21) 返回 42。只修改 calc.cjs。我授权在这个隔离仓库做一次本地提交。提交后用 project_verify 运行 test:fixture，报告真实 SHA 与结果，用 dots_task_end 单独结项。不要重跑已通过的同版本检查。所有文件和命令都限制在该隔离仓库，遇到问题如实回报，无需查看宿主程序源码。";
const marker = { upstream: "WORKER_UPSTREAM", downstream: "WORKER_DOWNSTREAM" };
const initialFiles = {
  ".gitignore": ".local/\n",
  "package.json": JSON.stringify({ name: "isolated-dots-acceptance", scripts: { "test:fixture": "node assert.cjs" } }) + "\n",
  "calc.cjs": "module.exports = n => n + 2;\n",
  "assert.cjs": [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "fs.mkdirSync('.local', { recursive: true });",
    "fs.appendFileSync('.local/checks', 'run\\n');",
    "assert.equal(require('./calc.cjs')(21), 42);",
    "console.log('double(21) = 42');",
  ].join("\n") + "\n",
};

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function prepareWorkspace(home) {
  const workspace = join(home, "local-verification-repo");
  mkdirSync(workspace);
  for (const [file, content] of Object.entries(initialFiles)) writeFileSync(join(workspace, file),
    file === "calc.cjs" && !liveModel ? "module.exports = n => n * 2;\n" : content);
  git(workspace, "init", "-b", "main");
  git(workspace, "config", "user.name", "MyBuddy Test");
  git(workspace, "config", "user.email", "mybuddy-test@example.invalid");
  git(workspace, "config", "core.autocrlf", "false");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "Isolated task fixture");
  return workspace;
}

const tool = (name, args) => ({ tool: { name, arguments: args } });
const check = () => tool("project_verify", { script: "test:fixture" });
const complete = (deliveryText, proof = {}) => tool("dots_task_end", {
  action: "complete", result: deliveryText, deliveryText, ...proof,
});
const latestInput = request => JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "");
const afterInput = request => request.messages.slice(request.messages.findLastIndex(message => message.role === "user") + 1);
const calls = (messages, name) => messages.filter(message => message.role === "assistant")
  .flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === name);

function fixtureModel(request) {
  const names = request.tools?.map(item => item.function.name) ?? [];
  const user = latestInput(request);
  const recent = afterInput(request);
  const answers = recent.filter(message => message.role === "tool");
  if (names.includes("dots_action") && user.includes(upstreamQuote)) {
    if (!answers.length) return tool("dots_action", {
      action: "delegate", spaceId, name: upstream, assignmentQuote: upstreamQuote, text: marker.upstream,
    });
    if (answers.length === 1) {
      const receipt = JSON.parse(answers[0].content);
      assert(receipt.operationId, "first delegate returned no operation ID");
      return tool("dots_action", { action: "delegate", spaceId, name: downstream, assignmentQuote: downstreamQuote,
        text: marker.downstream + " dependency=" + receipt.operationId });
    }
    return "已安排两项工作。";
  }
  if (user.includes(marker.upstream)) {
    if (!calls(recent, "request_user_input").length)
      return tool("request_user_input", { kind: "confirm", title: "确认生成上游版本" });
    if (!calls(recent, "write").length) return tool("write", { path: "upstream.txt", content: "upstream ready\n" });
    if (!calls(recent, "bash").length) return tool("bash", {
      command: "git add upstream.txt && git commit -m upstream-ready && git rev-parse HEAD",
    });
    const commitSha = answers.at(-1)?.content.match(/\b[0-9a-f]{40}\b/)?.[0];
    assert(commitSha, "worker did not get a real commit SHA");
    return complete("甲项已交付 " + commitSha, { commitSha });
  }
  if (user.includes(marker.downstream) && !user.includes("等待依赖前已完成的工作")) {
    if (calls(recent, "project_verify").length < 2) return check();
    assert.match(answers.at(-1)?.content ?? "", /"reused":true/, "second verification must reuse the actual first result");
    const dependencyOperationId = user.match(/dependency=([a-z0-9-]+)/)?.[1];
    assert(dependencyOperationId, "worker did not get the upstream operation ID");
    return tool("dots_task_end", { action: "wait", progress: "乙项初次检查已通过。", dependencyOperationId });
  }
  if (user.includes("等待依赖前已完成的工作") && user.includes("乙项初次检查已通过")) {
    assert.match(user, /verifiedCommit/);
    if (!answers.length) return complete("模拟误用旧验收", { checks: ["test:fixture"] });
    if (!calls(recent, "project_verify").length) {
      assert.match(answers.at(-1)?.content ?? "", /缺少通过的验收回执/);
      return check();
    }
    return complete("乙项已完成当前版本验收并收到甲项提交。", { checks: "[\"test:fixture\"]" });
  }
  return "完成。";
}

run(async env => {
  const { evaluate, rpc, until, home, requests, report } = env;
  const { click, press } = routingControls(env);
  const api = (method, ...args) => evaluate("window.api." + method + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const workspace = prepareWorkspace(home);
  const base = git(workspace, "rev-parse", "HEAD");
  const checkLog = join(workspace, ".local", "checks");
  const checkCount = () => existsSync(checkLog) ? readFileSync(checkLog, "utf8").trim().split("\n").length : 0;
  const rows = () => api("dots.activity");
  const find = async title => (await rows()).find(item => item.title === title);
  const history = id => api("agent.loadTaskHistory", id);
  const deliveries = async () => (await history("mybuddy-dots")).messages.filter(message => message.dotsDelivery?.kind === "conclusion");
  const openDots = () => click("MyBuddy Dots", ".sidebar-dots-entry");
  const send = async text => {
    await press("document.querySelector('textarea.input-textarea')", "Dots input");
    await rpc("Input.insertText", { text });
    await press("document.querySelector('button[title=\"发送 (Enter)\"]')", "send Dots task");
  };
  await until(() => evaluate("Boolean(window.api?.db && document.querySelector('.sidebar-scroll'))"), "live desktop preload");
  await api("db.upsertSpace", { id: spaceId, name: "本地验收工程", path: workspace });
  await openDots();
  await send(liveModel ? liveAssignment : assignment);

  if (liveModel) {
    await until(async () => (await deliveries()).length === 1, "real model Dots delivery");
    const commit = git(workspace, "rev-parse", "HEAD");
    assert.notEqual(commit, base);
    assert.equal(git(workspace, "rev-list", "--count", base + "..HEAD"), "1");
    assert.equal(git(workspace, "status", "--porcelain"), "");
    assert.equal(git(workspace, "diff", "--name-only", base, commit), "calc.cjs");
    assert.match((await deliveries())[0].text, new RegExp(commit.slice(0, 7)));
    assert(checkCount() >= 1, "registered script never ran");
    const activity = (await rows()).find(row => row.state === "delivered");
    const worker = await history(activity.taskId);
    const trace = JSON.stringify(worker.messages);
    assert.match(trace, /project_verify/);
    assert.match(trace, /dots_task_end/);
    assert.equal(worker.durable.busy, false);
    report.actualControlChecks.push({ commit, actualScriptRuns: checkCount(), delivery: (await deliveries())[0].text });
    return;
  }

  await until(async () => (await find(downstream))?.state === "dependency", "downstream parked in Dots");
  assert.equal(checkCount(), 1, "two identical checks ran more than once");
  assert.equal((await history((await find(downstream)).taskId)).durable.busy, false);
  const downstreamCount = () => requests.filter(request => latestInput(request).includes(marker.downstream)).length;
  const parkedRounds = downstreamCount();
  await env.restart();
  await until(async () => (await find(downstream))?.state === "dependency", "parked dependency survived restart");
  await delay(1300);
  assert.equal(downstreamCount(), parkedRounds, "waiting invoked the worker again");
  assert.equal(checkCount(), 1, "waiting reran project verification");
  const source = await find(upstream);
  const interaction = (await api("conversationRuntime.snapshot", source.taskId)).interactions.find(item => item.status === "pending");
  assert(interaction, "upstream confirmation must survive restart");
  assert.equal((await api("conversationRuntime.respondInteraction", { interactionId: interaction.id, answer: true })).ok, true);
  await until(async () => (await find(downstream))?.state === "delivered", "matching upstream commit woke the original downstream task");
  const delivered = (await deliveries()).filter(item => item.text.includes("乙项已完成"));
  assert.equal(delivered.length, 1);
  assert.equal(requests.filter(request => latestInput(request).includes("等待依赖前已完成的工作")).length, 3,
    "one continuation should reject stale proof, recheck once, then end");
  assert.equal(checkCount(), 2, "only the changed checkout should have executed a new test");
  assert.notEqual(git(workspace, "rev-parse", "HEAD"), base);
  report.actualControlChecks.push({ parkedRounds, actualScriptRuns: checkCount(), originalDeliveryCount: delivered.length,
    commit: git(workspace, "rev-parse", "HEAD") });
}, {
  name: liveModel ? "dots-bounded-live" : "dots-bounded-desktop",
  liveModel,
  ...(liveModel ? {} : { fixtureModel }),
  watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } },
  rpcTimeoutMs: 40000,
});
