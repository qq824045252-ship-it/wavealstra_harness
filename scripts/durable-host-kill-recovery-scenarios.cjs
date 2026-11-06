/**
 * durable-host-kill-recovery-test 的场景编排（被主脚本 require）。
 *
 * 场景：
 *   baseline    无中断基准
 *   checkpoint  第一个检查点已确认落盘（文件字节正确 + 工具结果已提交）后强杀宿主
 *   effect      某次写入已实际完成、工具结果尚未被持久确认时强杀宿主
 *
 * 恢复一律走真实产品入口：同一个隔离 profile 重新启动宿主，由启动期
 * AgentService → durableBots.resumePersisted() 接管，不重新提交原任务、不补写产物。
 */
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const {
  fixtureProvider, makeProfile, makeDriver, durableFacts, durableSnapshot, durableTexts, leaseOwner, collectFiles, expectationFor,
  processFacts, descendants, killHostPid, fileFact, wait, now, sha, root, harness, reportRoot, packageArchive, TASK_PREFIX, FILES, CHECKPOINTS, contentFor,
} = require("./durable-host-kill-recovery-test.cjs");

const HISTORY_TIMEOUT_MS = Number(process.env.KILLRECON_HISTORY_TIMEOUT_MS || 60000);
const RECOVERY_TIMEOUT_MS = Number(process.env.KILLRECON_RECOVERY_TIMEOUT_MS || 90000);

const checks = () => [];
const add = (list, id, status, detail) => { list.push({ id, status, detail }); };

async function taskRow(driver, taskId) {
  const tasks = await driver.evaluate("window.api.db.listTasks()");
  return (tasks || []).find((task) => task.id === taskId);
}

async function historyLimited(driver, taskId) {
  return await Promise.race([
    driver.evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), HISTORY_TIMEOUT_MS)),
  ]);
}

async function launchPhase(profile, report, label, pids) {
  const driver = makeDriver();
  const host = await driver.launch(profile, label);
  pids.add(host.pid);
  report.hosts.push({
    label, ...host,
    descendants: descendants(host.pid).map((entry) => ({ pid: entry.pid, name: entry.name, cmd: String(entry.cmd || "").slice(0, 200) })),
  });
  return driver;
}

async function installTask(driver, taskId) {
  await driver.evaluate(`window.api.db.upsertTask({id:${JSON.stringify(taskId)},title:${JSON.stringify(taskId)},welcomeMode:'bot',modePresetId:'native',permissionMode:'auto',updatedAt:Date.now()})`);
  return await taskRow(driver, taskId);
}

/** cwd 由 Durable 在首次提交时绑定，必须从产品状态读，测试不得指定。 */
async function awaitCwd(driver, taskId) {
  let cwd;
  await driver.until(async () => {
    const task = await taskRow(driver, taskId);
    cwd = task?.cwd;
    return Boolean(cwd);
  }, "task cwd bound", 60000);
  return cwd;
}

async function submit(driver, taskId, label) {
  return await driver.evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:${JSON.stringify(`${TASK_PREFIX}_${label} 跑一遍完整流程`)},userMessageId:${JSON.stringify(`u-${label}`)},assistantMessageId:${JSON.stringify(`a-${label}`)},modePresetId:'native',permissionMode:'auto'})`);
}

function expectedWrites() {
  const map = {};
  for (let index = 1; index <= FILES; index += 1) map[`data/${String(index).padStart(2, "0")}.txt`] = 1;
  map["checkpoints.log"] = CHECKPOINTS.length;
  return map;
}

function checkpointStats(cwd) {
  const file = path.join(cwd, "checkpoints.log");
  if (!fs.existsSync(file)) return { exists: false };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return {
    exists: true,
    lines,
    duplicates: lines.filter((line, index) => lines.indexOf(line) !== index),
    expected: CHECKPOINTS.map((value) => `checkpoint ${String(value).padStart(2, "0")} files=${value}`),
  };
}

function verify(argument) {
  const { cwd, facts, preKillFiles, files, sessionDirBefore, texts, expectComplete } = argument;
  const list = checks();
  const rows = expectationFor(cwd);
  const actualByRel = new Map((files || []).map((file) => [path.relative(cwd, file.path).split(path.sep).join("/"), file]));

  const missing = rows.filter((row) => actualByRel.get(row.rel)?.sha256 !== row.sha256).map((row) => row.rel);
  add(list, "files.match", missing.length ? "FAIL" : "PASS", missing.length ? { mismatched: missing } : { checked: rows.length });

  const writes = facts.writeResults || {};
  const expected = expectedWrites();
  const duplicated = Object.entries(writes).filter(([key, count]) => count > (expected[key] ?? 1));
  const underrun = Object.entries(expected).filter(([key, count]) => (writes[key] ?? 0) < count && key !== "data/10.txt");
  add(list, "execution.noDuplicateWrite", duplicated.length ? "FAIL" : "PASS", { writeResults: writes, duplicated, underrun });
  add(list, "execution.singleSubagentCall", facts.subagentTools === 1 ? "PASS" : "FAIL", { subagentToolResults: facts.subagentTools });
  // 子代理工具结果必须与实际产出相符：文件全对但结果标签是 failed，就是终态不一致。
  const subagentFailed = (facts.subagentResults || []).filter((result) => result.isError);
  add(list, "recovery.subagentResultMatchesWork", subagentFailed.length ? "FAIL" : "PASS", { results: facts.subagentResults || [], failed: subagentFailed });
  if (argument.submissionsBefore !== undefined) {
    // 恢复期间不得新增 placed 输入：恢复是接管，不是重新提交原任务。
    const before = [...argument.submissionsBefore].sort();
    const after = [...(facts.placedSubmissions || [])].sort();
    add(list, "execution.noResubmissionDuringRecovery", JSON.stringify(before) === JSON.stringify(after) ? "PASS" : "FAIL", { before, after });
    add(list, "execution.singleParentSubmission", after.filter((id) => id.startsWith("1::")).length === 1 ? "PASS" : "FAIL", { parentInputs: after.filter((id) => id.startsWith("1::")) });
  }
  add(list, "recovery.userMessageCount", (facts.userMessages || 0) === 1 ? "PASS" : "FAIL", { userMessages: facts.userMessages });

  const checkpoints = checkpointStats(cwd);
  add(list, "checkpoints.integrity", checkpoints.exists && checkpoints.duplicates.length === 0 && JSON.stringify(checkpoints.lines) === JSON.stringify(checkpoints.expected) ? "PASS" : "FAIL", checkpoints);

  if (preKillFiles) {
    const afterByPath = new Map((files || []).map((file) => [file.path, file]));
    const cumulative = new Set(Object.entries(expectedWrites()).filter(([, count]) => count > 1).map(([key]) => key));
    const unstable = [];
    const prefixBroken = [];
    for (const file of preKillFiles) {
      const rel = path.relative(cwd, file.path).split(path.sep).join("/");
      const current = afterByPath.get(file.path);
      if (cumulative.has(rel)) {
        // 检查点文件按设计是"整篇重写累积内容"：只要求旧内容是新内容的字节前缀，不要求 mtime 不变。
        const before = fs.readFileSync(file.path, "utf8");
        const after = current ? fs.readFileSync(current.path, "utf8") : "";
        if (!after.startsWith(before)) prefixBroken.push({ path: rel, before: before.length, after: after.length });
        continue;
      }
      if (!current || current.sha256 !== file.sha256 || current.mtimeMs !== file.mtimeMs) {
        unstable.push({ path: rel, hashStable: current?.sha256 === file.sha256, mtimeStable: current?.mtimeMs === file.mtimeMs, beforeMtime: file.mtime, afterMtime: current?.mtime ?? null });
      }
    }
    add(list, "stability.confirmedFilesUnchanged", unstable.length ? "FAIL" : "PASS", { confirmed: preKillFiles.length, unstable, cumulativeFiles: [...cumulative] });
    add(list, "stability.cumulativeFilePrefixPreserved", prefixBroken.length ? "FAIL" : "PASS", { prefixBroken });
  }

  if (argument.conversationsBefore) {
    const after = new Set(facts.conversations || []);
    const lost = argument.conversationsBefore.filter((id) => !after.has(id));
    add(list, "identity.childConversation", lost.length ? "FAIL" : "PASS", { before: argument.conversationsBefore, after: [...after] });
  }
  const sessions = durableSnapshot(argument.agentDir).map((entry) => entry.session);
  if (sessionDirBefore) add(list, "identity.sessionDirectory", JSON.stringify(sessions) === JSON.stringify(sessionDirBefore) ? "PASS" : "FAIL", { before: sessionDirBefore, after: sessions });

  if (expectComplete) {
    const completed = (texts || []).some((text) => text.includes("KILLRECON_PARENT_DONE"));
    add(list, "recovery.parentCompleted", completed ? "PASS" : "FAIL", { textsTail: (texts || []).slice(-2) });
  }
  return list;
}

async function runBaseline(profile, report, fixture, pids) {
  const driver = await launchPhase(profile, report, "baseline", pids);
  try {
    const taskId = `${TASK_PREFIX}_baseline`;
    await installTask(driver, taskId);
    report.taskId = taskId;
    report.submission = await submit(driver, taskId, "BASELINE");
    const cwd = await awaitCwd(driver, taskId);
    report.cwd = cwd;
    report.completionMs = await driver.until(async () => {
      const value = await historyLimited(driver, taskId);
      if (value.timeout) return false;
      const done = durableTexts(profile.agentDir).some((text) => text.includes("KILLRECON_PARENT_DONE"));
      return Boolean(value.durable && !value.durable.busy) && done;
    }, "baseline completion", 240000);
    const history = await historyLimited(driver, taskId);
    report.task = await taskRow(driver, taskId);
    report.files = collectFiles(cwd);
    report.facts = durableFacts(profile.agentDir);
    report.durable = durableSnapshot(profile.agentDir);
    report.hostLog = readLogTail(profile, "baseline");
    report.agentLog = agentLogEvidence(profile);
    report.checks = verify({ cwd, facts: report.facts, files: report.files, texts: durableTexts(profile.agentDir), agentDir: profile.agentDir, expectComplete: true });
  } finally {
    report.finalTree = driver.pid ? descendants(driver.pid) : [];
    await driver.close();
  }
  add(report.checks = report.checks || [], "process.noLeftoverHost", report.hosts.every((host) => !processFacts(host.pid)) ? "PASS" : "FAIL", { hosts: report.hosts.map((host) => ({ pid: host.pid, label: host.label, alive: Boolean(processFacts(host.pid)) })) });
  add(report.checks, "process.noLeftoverWorker", (report.finalTree || []).filter((entry) => /node|worker/i.test(entry.name) && !/electron/i.test(entry.name)).length === 0 ? "PASS" : "FAIL", { descendantsBeforeClose: report.finalTree });
  report.status = report.checks.every((check) => check.status === "PASS") ? "passed" : "failed";
}

async function waitForWindow(profile, cwd, predicate, label, timeout = 180000) {
  const started = Date.now();
  for (;;) {
    const state = { at: now(), files: collectFiles(cwd), facts: durableFacts(profile.agentDir) };
    if (predicate(state)) return { state, waitedMs: Date.now() - started };
    if (Date.now() - started > timeout) throw new Error(`timeout waiting window: ${label}`);
    await wait(100);
  }
}

async function runKillScenario(kind, profile, report, fixture, pids) {
  const driver = await launchPhase(profile, report, kind, pids);
  const taskId = `${TASK_PREFIX}_${kind}`;
  let cwd;
  try {
    await installTask(driver, taskId);
    report.taskId = taskId;
    report.submission = await submit(driver, taskId, kind.toUpperCase());
    cwd = await awaitCwd(driver, taskId);
    report.cwd = cwd;

    const window = kind === "checkpoint"
      ? await waitForWindow(profile, cwd, (state) => {
        const checkpoint = state.files.find((file) => file.path.endsWith("checkpoints.log"));
        const committed = (state.facts.writeResults["checkpoints.log"] || 0) >= 1;
        return Boolean(checkpoint?.exists && committed && fs.readFileSync(checkpoint.path, "utf8").includes(`checkpoint ${String(CHECKPOINTS[0]).padStart(2, "0")} files=${CHECKPOINTS[0]}`));
      }, "first checkpoint committed")
      : await waitForWindow(profile, cwd, (state) => {
        const marker = state.files.find((file) => file.path.endsWith(".effect-10.done"));
        const target = state.files.find((file) => file.path.endsWith(path.join("data", "10.txt")));
        return Boolean(marker?.exists && target?.exists && target.sha256 === sha(contentFor(10)) && (state.facts.writeResults["data/10.txt"] || 0) === 0);
      }, "effect completed without committed tool result");

    report.sessionDirBefore = durableSnapshot(profile.agentDir).map((entry) => entry.session);
    // 判定窗口与真正强杀之间不能有时间漂移：动手前重新取一次现场，并记录两者间隔。
    report.hostBeforeKill = processFacts(driver.pid);
    report.leaseBeforeKill = leaseOwner(profile.agentDir);
    const killAtBefore = Date.now();
    const preKill = { files: collectFiles(cwd), facts: durableFacts(profile.agentDir) };
    report.killSnapshotLagMs = Date.now() - killAtBefore;
    report.window = {
      kind,
      observedAt: now(),
      waitedMs: window.waitedMs,
      commits: window.state.facts.commits,
      toolResults: window.state.facts.toolResults,
      writeResults: window.state.facts.writeResults,
      conversations: window.state.facts.conversations,
      providerRequests: fixture.requests.length,
      providerTail: fixture.requests.slice(-3),
      preKillToolResults: preKill.facts.toolResults,
      preKillWriteResults: preKill.facts.writeResults,
      inFlightPredicate: kind === "effect"
        ? "写入字节已正确落盘(.effect-10.done + data/10.txt 哈希一致)，且 durable 里没有任何该写入的工具结果；被强杀的函数仍在等待 .effect-10.allow 才会返回"
        : "checkpoints.log 字节已含第一个检查点，且 durable 已提交该写入的工具结果",
    };
    report.preKillFiles = preKill.files;
    report.preKillFacts = preKill.facts;
    report.kill = killHostPid(driver.pid, report.hosts.find((host) => host.pid === driver.pid)?.identity);
    report.killedAt = report.kill.at;
    report.kill.hostAliveAfterKill = processFacts(driver.pid);
    report.kill.descendantsAfterKill = descendants(driver.pid);
    report.kill.filesAfterKill = collectFiles(cwd);
    report.kill.interruptedResults = (preKill.facts.interruptedResults || []);
  } finally {
    await driver.close();
  }

  // ---- 恢复：同一隔离 profile、真实启动入口；不重新提交任务
  const revived = await launchPhase(profile, report, `${kind}-restart`, pids);
  try {
    report.leaseAfterRestart = leaseOwner(profile.agentDir);
    report.restartHostPid = revived.pid;
    const outcome = await (async () => {
      const started = Date.now();
      for (;;) {
        const value = await historyLimited(revived, taskId);
        if (value.timeout) return { timeout: true, waitedMs: Date.now() - started };
        const done = durableTexts(profile.agentDir).some((text) => text.includes("KILLRECON_PARENT_DONE"));
        if (done) return { done: true, waitedMs: Date.now() - started, history: value };
        if (Date.now() - started > RECOVERY_TIMEOUT_MS) return { done: false, waitedMs: Date.now() - started, history: value };
        await wait(300);
      }
    })();
    report.recovery = {
      completed: Boolean(outcome.done),
      waitedMs: outcome.waitedMs,
      timedOut: Boolean(outcome.timeout),
      durable: outcome.history?.durable ? { busy: outcome.history.durable.busy, queued: outcome.history.durable.queued, status: outcome.history.durable.status } : null,
      providerRequestsAfterRestart: fixture.requests.length - (report.window.providerRequests || 0),
      providerTail: fixture.requests.slice(-4),
    };
    report.task = await taskRow(revived, taskId);
    report.files = collectFiles(cwd);
    report.facts = durableFacts(profile.agentDir);
    report.durable = durableSnapshot(profile.agentDir);
    report.texts = durableTexts(profile.agentDir).slice(-4);
    report.hostRestartLog = readLogTail(profile, `${kind}-restart`);
    report.agentLog = agentLogEvidence(profile);
  } finally {
    report.descendantsAtEnd = revived.pid ? descendants(revived.pid) : [];
    await revived.close();
  }

  report.checks = verify({
    cwd, facts: report.facts, files: report.files, preKillFiles: report.preKillFiles,
    submissionsBefore: report.preKillFacts?.placedSubmissions, sessionDirBefore: report.sessionDirBefore, conversationsBefore: report.window?.conversations, texts: report.texts, agentDir: profile.agentDir, expectComplete: true,
  });
  add(report.checks, "process.noLeftoverHost", report.hosts.every((host) => !processFacts(host.pid)) ? "PASS" : "FAIL", { hosts: report.hosts.map((host) => ({ pid: host.pid, label: host.label, alive: Boolean(processFacts(host.pid)) })) });
  add(report.checks, "process.noLeftoverWorker", (report.descendantsAtEnd || []).filter((entry) => /node|worker/i.test(entry.name) && !/electron/i.test(entry.name)).length === 0 ? "PASS" : "FAIL", { descendants: report.descendantsAtEnd });
  report.status = report.checks.every((check) => check.status === "PASS") ? "passed" : "failed";
}

async function runScenario(which) {
  const scenarios = which === "all" ? ["baseline", "checkpoint", "effect"] : [which];
  const session = { startedAt: now(), node: process.version, hostExecutable: harness, gitHead: gitHead(), outMain: fileFact(path.join(root, "out", "main", "index.js")), packageArchive: packageArchive ? fileFact(packageArchive) : null, scenarios: {} };
  const pids = new Set();
  for (const scenario of scenarios) {
    const trace = path.join(reportRoot, scenario, "provider-trace.jsonl");
    fs.mkdirSync(path.dirname(trace), { recursive: true });
    if (fs.existsSync(trace)) fs.unlinkSync(trace);
    const fixture = fixtureProvider(scenario, trace);
    await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    const profile = makeProfile(scenario, fixture.server.address().port);
    const report = { scenario, status: "running", startedAt: now(), profile, hosts: [], requests: fixture.requests, isolation: isolationFacts(profile) };
    try {
      if (scenario === "baseline") await runBaseline(profile, report, fixture, pids);
      else await runKillScenario(scenario, profile, report, fixture, pids);
    } catch (error) {
      report.status = "failed";
      report.error = String(error && error.stack || error);
    } finally {
      report.requests = fixture.requests;
      report.finishedAt = now();
      report.files = report.files || (report.cwd ? collectFiles(report.cwd) : []);
      report.facts = report.facts || durableFacts(profile.agentDir);
      fs.writeFileSync(path.join(profile.out, "results.json"), JSON.stringify(report, null, 2));
      fixture.server.close();
      session.scenarios[scenario] = {
        status: report.status,
        out: path.join(profile.out, "results.json"),
        checks: (report.checks || []).map((check) => `${check.id}:${check.status}`),
        error: report.error?.split("\n")[0],
      };
    }
  }
  session.finishedAt = now();
  session.sandboxProcesses = [...pids].map((pid) => ({ pid, alive: Boolean(processFacts(pid)) }));
  const summaryPath = path.join(reportRoot, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(session, null, 2));
  console.log(JSON.stringify({ summary: summaryPath, scenarios: session.scenarios, sandboxProcesses: session.sandboxProcesses }, null, 1));
  process.exitCode = Object.values(session.scenarios).every((entry) => entry.status === "passed") ? 0 : 1;
}

function isolationFacts(profile) {
  return {
    profile: { home: profile.home, agentDir: profile.agentDir, workspace: profile.scratch },
    realProfileTouched: fs.existsSync(path.join(profile.agentDir, "subagent.json")) ? JSON.parse(fs.readFileSync(path.join(profile.agentDir, "subagent.json"), "utf8")) : null,
    envStripped: ["PI_CODING_AGENT_DIR→profile.agentDir", "ELECTRON_RENDERER_URL", "*_API_KEY|*_TOKEN|*_SECRET"],
  };
}

/** 宿主日志里与恢复相关的行（Durable 租约/重开/恢复），作为"走了真实恢复入口"的旁证。 */
function readLogTail(profile, label) {
  const file = path.join(profile.out, `host-${label}.log`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(String.fromCharCode(10)).filter((line) => /Durable|durable|lease|recover|resume|Session failed/i.test(line)).slice(-20);
}

/** 产品主进程日志（<agentDir>/logs/main-*.log）里与恢复相关的行。 */
function agentLogEvidence(profile) {
  const dir = path.join(profile.agentDir, "logs");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((name) => name.startsWith("main-")).sort();
  if (!files.length) return [];
  const text = fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8");
  return text.split(String.fromCharCode(10)).filter((line) => /Durable|recover|lease|resume|Session failed|恢复|租约/i.test(line)).slice(-15);
}

function gitHead() {
  try { return cp.execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
}

module.exports = { runScenario };
