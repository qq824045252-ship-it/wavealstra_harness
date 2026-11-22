const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");

run(async ({ evaluate, until, home, report, requests }) => {
  const workspace = join(home, "温度夹具");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "temperature.txt"), "47\n");
  const api = (name, ...args) => evaluate("window.api." + name + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  await api("db.upsertSpace", { id: "sp-temperature-fixture", name: "温度夹具", path: workspace });
  const { id: dots } = await api("dots.open");
  const fallback = (await api("answerRouting.list")).find(rule => rule.id === "dots-default-policy");
  await api("answerRouting.save", { ...fallback, policy: { ...fallback.policy,
    trackingPolicy: { milestones: true, heartbeatMs: 5_000, silenceMs: 5_000 },
  } }, fallback);
  const source = "temperature-pure-tool-activity";
  const inputAt = Date.now();
  const request = await api("agent.prompt", { taskId: dots, userMessageId: source, assistantMessageId: "temperature-ack",
    text: "请在 sp-temperature-fixture 温度夹具空间委派普通任务。普通任务用一次 Bash 调用执行 sleep 8 && cat temperature.txt，不写文件、不登记产物，运行中只使用工具、无需 progress JSON。最终只回文件里的数字，按正常 Dots 交付封套提交。" });
  assert(request.receipt);
  let first, job, terminal;
  await until(async () => {
    job = (await api("dots.list", [source]))[0];
    const rows = (await api("agent.loadTaskHistory", dots)).messages.filter(row => row.dotsDelivery?.sourceMessageId === source);
    first = rows.find(row => row.dotsDelivery.kind === "progress");
    terminal = rows.find(row => ["conclusion", "question"].includes(row.dotsDelivery.kind));
    return Boolean(terminal);
  }, "temperature worker returns to its origin");
  const worker = (await api("agent.loadTaskHistory", job.taskId)).messages;
  const calls = requests.filter(request => request.tools?.some(tool => tool.function.name === "read"));
  const foreground = requests.filter(request => request.tools?.some(tool => tool.function.name === "dots_action"));
  report.activityOnly = { inputAt, job, firstReport: first?.createdAt, terminalReport: terminal.createdAt,
    text: terminal.text, firstText: first?.text, foregroundCalls: foreground.length, workerCalls: calls.length };
  assert(first, "native tool activity returned without a progress envelope");
  assert.match(first.text, /工具 bash/);
  assert.equal(job.activity.lastProgressAt, undefined);
  assert(!worker.some(row => row.dotsWorkerProgress));
  assert.equal(terminal.dotsDelivery.kind, "conclusion");
  assert.equal(terminal.text.trim(), "47");
}, { name: "dots-activity-live", liveModel: true, isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 150_000 });
