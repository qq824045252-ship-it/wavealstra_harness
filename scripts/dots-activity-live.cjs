const assert = require("node:assert/strict");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");

const busyMarker = "fixture-c3-held-response";
let responseHeldAt;
let releaseResponse;
const responseGate = new Promise(resolve => { releaseResponse = resolve; });
const gateLiveResponse = async request => {
  if (!JSON.stringify(request.messages?.at(-1)?.content).includes(busyMarker)) return;
  responseHeldAt = Date.now();
  await Promise.race([responseGate, wait(45_000, undefined, { ref: false })]);
};

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
  if (process.argv.includes("--parallel-activity-live")) {
    const first = "parallel-fixture-workers", second = "parallel-policy-check", revisionSource = "parallel-revision";
    const gate = join(home, "gates");
    const other = join(home, "活跃夹具");
    mkdirSync(other);
    writeFileSync(join(other, "temperature.txt"), "47\n");
    await api("db.upsertSpace", { id: "sp-active-fixture", name: "活跃夹具", path: other });
    const submit = (id, text) => api("agent.prompt", { taskId: dots, userMessageId: id, assistantMessageId: id + "-answer", text });
    const latest = async source => {
      const [jobs, tasks] = await Promise.all([api("dots.list", [source]), api("db.listTasks")]);
      const inSpace = id => jobs.find(job => tasks.some(task => task.id === job.taskId && task.spaceId === id));
      return [inSpace("sp-temperature-fixture"), inSpace("sp-active-fixture")];
    };
    try {
      const a = await submit(first, "同一轮并行两个 dots_action delegate，不查空间。事项一：sp-temperature-fixture 内用 mcp_read_resource 调用 server quiet_gate，uri fixture://temperature/gate，读完只交付 47。事项二：sp-active-fixture 内先用 mcp_read_resource 调用 server active_gate，uri fixture://temperature/gate。务必等首次工具结果，再读取其返回的新 URI，两次都读完才交付 94。均不要写文件、调用任意 Bash、登记产物或用 progress JSON，终态使用正常封套。");
      assert(a.receipt);
      let jobA, jobB;
      await until(async () => {
        [jobA, jobB] = await latest(first);
        return jobA?.activity?.phase === "start" && jobA.activity.tool === "mcp_read_resource" && existsSync(join(gate, "quiet.started"));
      }, "first native MCP resource read waits on gate");
      const initialA = jobA.activity.lastActivityAt;
      await until(() => existsSync(join(gate, "active-first.started")), "first B resource is blocked");
      writeFileSync(join(gate, "active-first.release"), "");
      const revision = (await api("answerRouting.list")).find(rule => rule.id === "dots-default-policy");
      let parallel;
      await until(async () => {
        [jobA, jobB] = await latest(first);
        if (jobA?.status === "completed") throw Error("quiet worker ended before release");
        if (jobA?.activity?.phase !== "start" || !jobB?.activity ||
            jobB.activity.lastActivityAt <= initialA || !existsSync(join(gate, "active.started"))) return false;
        const worker = await api("agent.loadTaskHistory", jobB.taskId);
        const read = worker.messages.flatMap(row => row.tools ?? []).find(tool => tool.tool === "mcp_read_resource" && tool.status === "success" && tool.output.includes("fixture://temperature/confirm"));
        if (!read) return false;
        parallel = { observedAt: Date.now(), first: jobA, second: jobB, secondCompletedRead: read };
        return true;
      }, "B returned a real read while A is still in the same gated native start");
      assert.equal(jobA.activity.lastActivityAt, initialA);
      assert.equal(jobA.activity.lastProgressAt, undefined);
      assert.equal(jobB.activity.lastProgressAt, undefined);
      assert.notEqual(jobA.taskId, jobB.taskId);
      const busySource = "parallel-policy-busy";
      const busy = await submit(busySource, busyMarker + "。这是单独的合成测试。请直接回答 3+4 的计算结果，不调用工具。");
      assert(busy.receipt);
      let busyTurnDone = false;
      const settled = api("agent.waitForSubmission", busy.receipt).then(result => {
        busyTurnDone = true;
        return result;
      });
      await until(() => Boolean(responseHeldAt), "real foreground provider response held");
      const countWorkerModels = () => requests.filter(request => !request.tools?.some(tool => tool.function.name === "dots_action")).length;
      const workerModelsBefore = countWorkerModels();
      const updated = await api("answerRouting.save", { ...revision, policy: { ...revision.policy,
        trackingPolicy: { ...revision.policy.trackingPolicy, heartbeatMs: 6_000 },
      } }, revision);
      const checkedAt = Date.now();
      const [duringA, duringB] = await latest(first);
      assert.equal(duringA.id, jobA.id);
      assert.equal(duringB.id, jobB.id);
      assert.equal(duringA.activity.lastActivityAt, initialA);
      assert.equal(countWorkerModels(), workerModelsBefore);
      const pendingKeys = () => {
        const db = new DatabaseSync(join(home, ".mybuddy", "app.db"), { readOnly: true, timeout: 1_000 });
        try {
          return db.prepare("SELECT event_key FROM dots_reply_events WHERE operation_id=? AND status='activity' AND settled=0").all(jobA.id)
            .map(row => row.event_key);
        } finally { db.close(); }
      };
      let pending;
      await until(async () => {
        assert.equal(busyTurnDone, false);
        if (Date.now() - responseHeldAt < 5_000) return false;
        pending = pendingKeys();
        return pending.length === 1;
      }, "heartbeat persisted but not delivered during foreground provider round");
      const beforeRelease = (await api("agent.loadTaskHistory", dots)).messages;
      assert(!beforeRelease.some(row => row.dotsDelivery?.deliveryKey === pending[0]));
      assert.equal(countWorkerModels(), workerModelsBefore);
      const releasedAt = Date.now();
      releaseResponse();
      assert.equal((await settled).receipt?.status, "done");
      let visibleAt;
      await until(async () => {
        const rows = (await api("agent.loadTaskHistory", dots)).messages;
        visibleAt = rows.find(row => row.dotsDelivery?.deliveryKey === pending[0])?.createdAt;
        return Number.isFinite(visibleAt);
      }, "same queued heartbeat returns at safe point");
      assert(visibleAt >= releasedAt);
      assert.equal(countWorkerModels(), workerModelsBefore);
      const [busyUse] = await api("answerRouting.history", { taskId: dots, inputId: busySource });
      assert.equal(busyUse.revision, revision.revision);
      const b = await submit(second, "这是一条独立问题，2+6 等于什么？请直接回答。");
      assert(b.receipt);
      const [firstUse] = await api("answerRouting.history", {taskId: dots, inputId: first});
      const [secondUse] = await api("answerRouting.history", {taskId: dots, inputId: second});
      assert.equal(firstUse.revision, revision.revision);
      assert.equal(firstUse.policy.trackingPolicy.heartbeatMs, 5_000);
      assert.equal(secondUse.revision, updated.revision);
      assert.equal(secondUse.policy.trackingPolicy.heartbeatMs, 6_000);
      report.parallel = { parallel, firstUse, secondUse, busyPolicy: {
        busyUse, responseHeldAt, checkedAt, releasedAt, visibleAt, eventKey: pending[0], workerModelsBefore,
        workerModelsAfter: countWorkerModels(),
      } };
      const changed = await submit(revisionSource, "请在同一轮用两个并行 dots_action steer 调用改向两个仍在运行的原任务，不要创建任务，也不要改动任何文件。" +
        "原任务 " + jobA.taskId + " 交付严格一行 JSON：{\"dotsState\":\"complete\",\"result\":\"QUIET_REVISED_47\"}。" +
        "原任务 " + jobB.taskId + " 交付严格一行 JSON：{\"dotsState\":\"complete\",\"result\":\"ACTIVE_REVISED_94\"}。");
      assert(changed.receipt);
      let newA, newB;
      await until(async () => {
        [newA,newB] = await latest(revisionSource);
        return newA && newB && newA.taskId === jobA.taskId && newB.taskId === jobB.taskId;
      }, "same two native tasks have linked revised operations");
      assert.notEqual(newA.id, jobA.id);
      assert.notEqual(newB.id, jobB.id);
      let receipts;
      await until(async () => {
        const foreground = (await api("agent.loadTaskHistory", dots)).messages;
        receipts = foreground.flatMap(row => row.tools ?? []).filter(tool => tool.tool === "dots_action")
          .flatMap(tool => { try { return [JSON.parse(tool.output ?? tool.detail)?.receipt]; } catch { return []; } })
          .filter(Boolean);
        return [newA, newB].every(revised => receipts.some(receipt => receipt.taskId === revised.taskId &&
          receipt.operationId === revised.id && Number.isSafeInteger(receipt.submissionId)));
      }, "same task revised native receipts");
      for (const key of ["quiet", "active"]) assert(!existsSync(join(gate, key + ".expired")), "receipt must precede resource expiry");
      report.parallel.revision = { acceptedAt: Date.now(), newA, newB,
        receipts: receipts.filter(receipt => [newA.id, newB.id].includes(receipt.operationId)) };
      for (const key of ["quiet", "active", "active-first"]) writeFileSync(join(gate, key + ".release"), "");
      let terminal, old;
      await until(async () => {
        const rows = (await api("agent.loadTaskHistory", dots)).messages;
        terminal = rows.filter(row => row.dotsDelivery?.kind === "conclusion" && row.dotsDelivery.sourceMessageId === revisionSource);
        old = rows.filter(row => [jobA.id, jobB.id].includes(row.dotsDelivery?.operationId) && row.createdAt > report.parallel.revision.acceptedAt);
        const question = rows.find(row => row.dotsDelivery?.kind === "question" && row.dotsDelivery.sourceMessageId === revisionSource);
        if (question) throw Error("Revised output did not satisfy existing Dots delivery validation: " + question.text);
        return terminal.length >= 2;
      }, "both revised operations return to the revision input");
      report.parallel.terminal = terminal.map(row => ({ source: row.dotsDelivery.sourceMessageId,
        taskId: row.dotsDelivery.taskId, id: row.dotsDelivery.deliveryKey, text: row.text, at: row.createdAt }));
      report.parallel.providerCalls = requests.map(request => request.tools?.some(tool => tool.function.name === "dots_action") ? "front" : "worker");
      assert.equal(terminal.length, 2);
      assert.equal(old.length, 0);
      assert.equal(terminal.find(row=>row.dotsDelivery.taskId===jobA.taskId)?.text.trim(),"QUIET_REVISED_47");
      assert.equal(terminal.find(row=>row.dotsDelivery.taskId===jobB.taskId)?.text.trim(),"ACTIVE_REVISED_94");
      const oldJobs = await latest(first);
      assert(oldJobs.every(job=>job?.status==="superseded"));
    } finally {
      releaseResponse();
      for (const key of ["quiet", "active", "active-first"]) writeFileSync(join(gate, key + ".release"), "");
    }
    return;
  }
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
}, { gateLiveResponse, seedHome: process.argv.includes("--parallel-activity-live") ? home => {
    const gate = join(home, "gates");
    const mcp = join(home, ".mybuddy", "plugins", "mcp");
    mkdirSync(gate);
    mkdirSync(mcp, { recursive: true });
    const config = Object.fromEntries(["quiet", "active"].map(id => [id + "_gate", {
      command: process.execPath,
      args: [join(__dirname, "dots-activity-gate-fixture.mjs"), gate, id],
      timeout: 180,
    }]));
    writeFileSync(join(mcp, "mcp.json"), JSON.stringify({ mcpServers: config }));
  } : undefined, name: process.argv.includes("--parallel-activity-live") ? "dots-parallel-activity-live" : "dots-activity-live", liveModel: true, isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 150_000 });
