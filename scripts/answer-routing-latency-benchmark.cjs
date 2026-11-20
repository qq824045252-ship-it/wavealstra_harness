const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { run } = require("./desktop-dev-harness.cjs");

const originalQuestion = "写项目周报。用两行汇报蓝桥和青禾各自的交付状态与记录编号。";
const alternateQuestion = "帮我整理交付周报，列出蓝桥和青禾各自的编号和交付状态。";
const source = "交付记录。蓝桥模块 RG-174 已提测，尚未上线。青禾模块 RG-285 已上线。";
const teaching = "写项目周报或整理交付周报时，先读取任务目录的 release.md。区分已提测和尚未上线，列出状态和记录编号。翻译周报时跳过。资料缺失标为待核实。";
const instruction = "先读取任务目录的 release.md，再按已提测、尚未上线等状态区分，列出状态和记录编号；资料缺失或记录不全时停止给出确定结论，将缺失项标为“待核实”并说明需补充资料；若用户意图是翻译周报，则不按本规则执行。";
const sourceHash = createHash("sha256").update(source).digest("hex");
const arms = {
  baseline: { memoryEnabled: false, ruleEnabled: false },
  memory: { memoryEnabled: true, ruleEnabled: false },
  route: { memoryEnabled: false, ruleEnabled: true },
  both: { memoryEnabled: true, ruleEnabled: true },
};
const orders = [
  ["baseline", "memory", "both", "route"],
  ["memory", "route", "baseline", "both"],
  ["route", "both", "memory", "baseline"],
  ["both", "baseline", "route", "memory"],
  ["route", "memory", "baseline", "both"],
];

const messageText = message => Array.isArray(message.content)
  ? message.content.map(part => part.text ?? "").join("\n") : message.content ?? "";
const makesAnswer = (request, question) => request.messages.some(message => message.role === "user" &&
  (message.content === question || message.content?.some?.(part => part.text === question)));
const hasSource = message => messageText(message).includes(source);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedWorkspace = [{ name: "release.md", type: "file", bytes: Buffer.byteLength(source), sha256: sourceHash }];

async function workspaceInventory(workspace) {
  const entries = await fs.readdir(workspace, { withFileTypes: true });
  return Promise.all(entries.toSorted((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    if (!entry.isFile()) return { name: entry.name, type: entry.isDirectory() ? "directory" : "other" };
    const bytes = await fs.readFile(path.join(workspace, entry.name));
    return { name: entry.name, type: "file", bytes: bytes.length, sha256: hash(bytes) };
  }));
}

const resultFrom = answer => {
  const lines = answer?.replace(/[*_`]/g, "").split(/(?=蓝桥|青禾)/u) ?? [];
  const blue = lines.find(line => line.includes("蓝桥") && line.includes("RG-174"));
  const green = lines.find(line => line.includes("青禾") && line.includes("RG-285"));
  const offline = /(?:尚未|未|没有|并未|还没|暂未|未曾|未正式|未对外)(?:正式)?(?:上线|发布)/;
  const online = /已(?:经)?(?:正式)?(?:上线|发布)|完成上线/;
  return {
    blueCorrect: Boolean(blue && /提测|提交测试/.test(blue) && offline.test(blue) &&
      !online.test(blue.replace(offline, ""))),
    greenCorrect: Boolean(green && online.test(green) && !offline.test(green)),
  };
};

function turnPasses(turn) {
  const facts = resultFrom(turn.answer);
  return turn.completed && facts.blueCorrect && facts.greenCorrect && turn.routeCorrect && turn.providerRequests > 0 &&
    turn.memorySelected === turn.memoryEnabled && turn.memoryDelivered === turn.memoryEnabled &&
    turn.sourcePreRead === turn.ruleEnabled && (turn.sourcePreRead || turn.sourceViaTool) &&
    !turn.verificationError && !turn.workspaceError;
}

const timingRows = async out => (await fs.readFile(path.join(out, "dev.log"), "utf8"))
  .split(/\r?\n/).flatMap(line => {
    const prefix = "[AnswerRoutingTiming] ";
    const start = line.indexOf(prefix);
    if (start < 0) return [];
    try { return [JSON.parse(line.slice(start + prefix.length))]; } catch { return []; }
  });

async function ask(call, request) {
  // Both timestamps are taken in the renderer around the submission APIs.
  return call('(async request => { const start = performance.now(); const startedAtMs = Date.now();'
    + ' let result, receipt, error, admittedAtMs;'
    + ' try { const accepted = await window.api.agent.prompt(request); admittedAtMs = Date.now();'
    + ' receipt = accepted.receipt; if (!receipt) throw Error(JSON.stringify(accepted));'
    + ' result = await window.api.agent.waitForSubmission(receipt);'
    + ' } catch (e) { error = String(e); }'
    + ' const completedAtMs = Date.now();'
    + ' return {startedAtMs, admittedAtMs, completedAtMs, elapsedMs: performance.now() - start, result, receipt, error};'
    + ' })(' + JSON.stringify(request) + ')');
}

function verifyTurns(turns, roundNumbers) {
  const schedule = orders.flatMap((order, roundIndex) =>
    order.map((arm, positionIndex) => ({ round: roundIndex + 1, position: positionIndex + 1, arm })))
    .filter(({ round }) => !roundNumbers || roundNumbers.includes(round));
  assert.deepEqual(turns.map(({ round, position, arm }) => ({ round, position, arm })), schedule, "Benchmark schedule");
  const failures = [];
  const seen = new Set();
  const calls = [];
  for (const turn of turns) {
    const check = (ok, description) => { if (!ok) failures.push(turn.taskId + " " + description); };
    check(turnPasses(turn), "answer or fixture evidence check failed");
    const foreground = (turn.providerTimings ?? []).filter(entry => turn.providerRequestIndexes?.includes(entry.requestIndex));
    const phases = turn.timing ?? [];
    const projections = phases.filter(row => row.phase === "evidenceProjection");
    const select = phases.filter(row => row.phase === "memorySelection");
    const search = phases.filter(row => row.phase === "memorySearch");
    const match = phases.filter(row => row.phase === "ruleMatch");
    const read = phases.filter(row => row.phase === "readEvidence");
    check(foreground.length > 0 && foreground.length === turn.providerRequests, "missing foreground relay timing");
    check(!turn.ruleEnabled || turn.question === alternateQuestion || (foreground.length === 1 && turn.toolCalls.length === 0),
      "routed answer did not finish in one tool-free request");
    if (turn.workspaceBefore) {
      check(JSON.stringify(turn.workspaceBefore) === JSON.stringify(expectedWorkspace), "workspace did not start with the exact fixture");
      check(Array.isArray(turn.workspaceAfter) && turn.workspaceRestored === true, "workspace state or restore was not verified");
    }
    check(projections.length === foreground.length && select.length === 1 && search.length === Number(turn.memoryEnabled) &&
      match.length === Number(turn.ruleEnabled) && read.length === Number(turn.ruleEnabled), "missing or duplicate internal timing");
    check(phases.every(row => row.taskId === turn.taskId && row.conversationId &&
      Number.isFinite(row.generationTaskId) && Number.isFinite(row.elapsedMs) &&
      row.startedAtMs >= turn.startedAtMs && row.endedAtMs <= turn.completedAtMs &&
      row.endedAtMs >= row.startedAtMs), "invalid internal timing identity or clock order");
    for (const row of [...match, ...read]) {
      check(row.inputId === turn.inputId && row.generationTaskId === projections[0]?.generationTaskId,
        "routing timing did not join to the first foreground generation");
    }
    for (const [index, entry] of foreground.entries()) {
      const key = entry.requestIndex + "@" + entry.receivedAtMs;
      check(!seen.has(key) && entry.scope?.taskId === turn.taskId && entry.scope?.inputId === turn.inputId &&
        entry.scope?.round === turn.round && entry.scope?.arm === turn.arm && entry.upstreamStatus === 200 && !entry.error,
        "incorrect foreground relay identity or HTTP outcome");
      seen.add(key);
      const projection = projections[index];
      check(projection?.endedAtMs <= entry.upstreamSentAtMs &&
        entry.receivedAtMs >= turn.startedAtMs &&
        entry.upstreamSentAtMs <= entry.upstreamHeadersAtMs && entry.upstreamHeadersAtMs <= entry.upstreamFirstByteAtMs &&
        entry.upstreamFirstByteAtMs <= entry.firstDeltaAtMs && entry.firstDeltaAtMs <= entry.upstreamEndAtMs &&
        entry.firstDeltaAtMs <= turn.completedAtMs, "invalid foreground relay timing order");
    }
    check(Number.isFinite(foreground.at(-1)?.firstAnswerAtMs), "missing visible answer delta");
    calls.push(...(turn.providerTimings ?? []));
  }
  calls.sort((a, b) => a.upstreamSentAtMs - b.upstreamSentAtMs);
  for (let index = 1; index < calls.length; index++) {
    const previous = calls[index - 1], next = calls[index];
    if ((previous.upstreamDoneAtMs ?? previous.upstreamEndAtMs) > next.upstreamSentAtMs) {
      failures.push(next.scope?.taskId + " provider request overlapped with " + previous.scope?.taskId);
    }
  }
  assert.equal(failures.length, 0, "Benchmark verification failed\n" + failures.join("\n"));
}

async function benchmark(alternate, roundNumbers) {
  process.env.MYBUDDY_ANSWER_ROUTING_TIMINGS = "1";
  const question = alternate ? alternateQuestion : originalQuestion;
  await run(env => scenario(env, question, roundNumbers), {
    name: alternate ? "answer-routing-latency-alternate-clean" : "answer-routing-latency",
    liveModel: true, benchmark: true, rpcTimeoutMs: 240000,
    settings: { memoryEnabled: false },
  });
}

async function scenario({ evaluate, until, report, out, home, requests, providerTimings, setProviderScope }, question, roundNumbers) {
  const call = (method, ...args) => evaluate("window.api." + method + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const fixtureHome = path.resolve(home);
  const workspace = path.resolve(fixtureHome, "周报验收资料");
  const archive = path.resolve(fixtureHome, "benchmark-generated-workspaces");
  assert.equal(path.dirname(workspace), fixtureHome);
  assert.equal(path.dirname(archive), fixtureHome);
  const seedWorkspace = async () => {
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "release.md"), source);
  };
  await seedWorkspace();
  const spaceId = "routing-fixture";
  await call("db.upsertSpace", { id: spaceId, name: "验收空间", path: workspace });
  const project = await call("db.createProject", { name: "调度验收项目" });
  assert.equal(project.ok, true);
  const projectId = project.project.id;
  const memory = await call("memory.create", {
    title: "周报交付约束", content: teaching, scopeType: "global", kind: "procedure", sourceType: "manual", explicit: true,
  });
  assert.ok(memory.id);
  const ruleDraft = {
    title: "项目周报与交付周报整理规则", include: ["写项目周报", "整理交付周报"], exclude: ["翻译周报"],
    instruction, evidenceFile: "release.md", evidenceFailure: "mark-unverified", projectId, sourceMemoryId: null,
  };
  let rule = await call("answerRouting.save", { ...ruleDraft, enabled: false });
  const journal = path.join(out, "turns.jsonl");
  report.benchmark = {
    question, source, sourceHash, projectId, spaceId, memoryId: memory.id, ruleId: rule.id, arms, orders, roundNumbers, journal,
    start: "Renderer performance.now immediately before agent.prompt",
    end: "Renderer performance.now immediately after agent.waitForSubmission, before history and verification",
    turns: [],
  };
  console.log("Benchmark journal " + journal);
  function auditRequests(offset, requestPredicate) {
    return requests.flatMap((request, index) =>
      index >= offset && requestPredicate(request) ? [{ request, index }] : []);
  }
  for (const [roundIndex, order] of orders.entries()) {
    if (roundNumbers && !roundNumbers.includes(roundIndex + 1)) continue;
    for (const [positionIndex, arm] of order.entries()) {
      const round = roundIndex + 1;
      const position = positionIndex + 1;
      const taskId = "routing-bench-" + round + "-" + arm;
      const inputId = "q-" + taskId;
      const options = arms[arm];
      await call("agent.updateAppSettings", { memoryEnabled: options.memoryEnabled });
      if (rule.enabled !== options.ruleEnabled) {
        rule = await call("answerRouting.save", { ...ruleDraft, enabled: options.ruleEnabled },
          { id: rule.id, revision: rule.revision });
      }
      const preview = await call("answerRouting.preview", question, projectId);
      assert.equal(Boolean(preview), options.ruleEnabled);
      await call("db.upsertTask", { id: taskId, title: taskId, welcomeMode: "general", projectId, spaceId, updatedAt: Date.now() });
      const turn = { round, position, arm, taskId, inputId, question, ...options };
      turn.workspaceBefore = await workspaceInventory(workspace);
      assert.deepEqual(turn.workspaceBefore, expectedWorkspace, taskId + " fixture before prompt");
      const offset = requests.length;
      setProviderScope({ round, arm, taskId, inputId });
      console.log("Starting round " + round + " position " + position + " " + arm);
      let transportFailed = false;
      try {
        try {
          Object.assign(turn, await ask(evaluate, { taskId, spaceId, projectId, welcomeMode: "general", text: question,
            userMessageId: inputId, assistantMessageId: "a-" + taskId }));
        } catch (error) {
          transportFailed = true;
          throw error;
        }
        if (turn.receipt) {
          const history = await call("agent.loadTaskHistory", taskId);
          turn.answer = history.messages.filter(message => message.role === "assistant").at(-1)?.text;
          turn.durableOutcome = history.durable?.outcome;
          const uses = await call("answerRouting.history", { taskId, inputId });
          turn.ruleUses = uses;
          turn.routeCorrect = options.ruleEnabled
            ? uses.length === 1 && uses[0].routeStatus === "applied" && uses[0].evidence?.contentHash === sourceHash
              && uses[0].evidence?.status === "read" && uses[0].evidence?.reference === "release.md"
            : uses.length === 0;
        }
        const calls = auditRequests(offset, request => makesAnswer(request, question));
        turn.providerRequestIndexes = calls.map(({ index }) => index);
        turn.providerRequests = calls.length;
        turn.toolCalls = calls.at(-1)?.request.messages.flatMap(message =>
          (message.tool_calls ?? []).map(tool => ({ name: tool.function.name, arguments: tool.function.arguments }))) ?? [];
        turn.fileWriteToolCalls = turn.toolCalls.filter(tool => ["write", "edit", "apply_patch"].includes(tool.name));
        turn.memoryDelivered = Boolean(calls[0]?.request.messages.some(message =>
          message.role === "user" && messageText(message).includes("[L1 " + memory.id + "@")));
        turn.sourcePreRead = Boolean(calls[0]?.request.messages.some(message => message.role === "user" && hasSource(message)));
        turn.sourceViaTool = calls.some(({ request }) => request.messages.some(message => message.role === "tool" && hasSource(message)));
        Object.assign(turn, resultFrom(turn.answer));
        turn.completed = Boolean(turn.receipt && turn.result && !turn.result.error && !turn.result.queued && !turn.result.cancelled &&
          !turn.error && turn.durableOutcome === "completed" && turn.answer?.trim());
        turn.correct = turn.blueCorrect && turn.greenCorrect;
        turn.timing = (await timingRows(out)).filter(row => row.taskId === taskId);
        turn.memorySelected = turn.timing.some(row => row.phase === "memorySelection" && row.selectedMemoryIds?.includes(memory.id));
        turn.success = turnPasses(turn);
        if (options.memoryEnabled && turn.completed) {
          // The app may extract memory in the background. Keep its real requests but
          // drain the current turn before changing the settings and starting the next.
          await until(async () => {
            const captured = (await call("memory.turns", { taskId, limit: 5 })).at(-1);
            turn.backgroundExtractionState = captured?.extractionState;
            return captured && ["completed", "failed", "skipped"].includes(captured.extractionState);
          }, "memory background drain " + taskId);
        }
        const otherCalls = auditRequests(offset, request => !makesAnswer(request, question));
        turn.backgroundRequests = otherCalls.map(({ index }) => index);
        try {
          await until(() => providerTimings.filter(entry => entry.scope?.taskId === taskId)
            .every(entry => Number.isFinite(entry.upstreamEndAtMs) || entry.error), "provider transport drain " + taskId);
        } catch (error) {
          transportFailed = true;
          throw error;
        }
        turn.providerTimings = providerTimings.filter(entry =>
          turn.providerRequestIndexes.includes(entry.requestIndex) || turn.backgroundRequests.includes(entry.requestIndex));
      } catch (error) {
        turn.verificationError = String(error.stack || error);
        turn.success = false;
      } finally {
        try {
          if (!transportFailed) {
            turn.workspaceAfter = await workspaceInventory(workspace);
            turn.workspaceChanged = JSON.stringify(turn.workspaceAfter) !== JSON.stringify(expectedWorkspace);
            if (turn.workspaceChanged) {
              await fs.mkdir(archive, { recursive: true });
              const saved = path.resolve(archive, taskId);
              assert.equal(path.dirname(saved), archive);
              await fs.rename(workspace, saved);
              turn.preservedWorkspace = saved;
              await seedWorkspace();
            }
            const restored = await workspaceInventory(workspace);
            turn.workspaceRestored = JSON.stringify(restored) === JSON.stringify(expectedWorkspace);
          }
        } catch (error) {
          turn.workspaceError = String(error.stack || error);
          turn.success = false;
        }
        await fs.appendFile(journal, JSON.stringify(turn) + "\n");
        report.benchmark.turns.push(turn);
        setProviderScope(null);
        console.log(arm + " round " + round + ": " + (turn.elapsedMs?.toFixed(0) ?? "?") + " ms, " +
          (turn.providerRequests ?? "?") + " foreground calls, success=" + turn.success);
      }
      if (transportFailed) throw Error(taskId + " submission wait was interrupted; refusing to switch benchmark settings");
    }
  }
  verifyTurns(report.benchmark.turns, roundNumbers);
}

async function readJournal(file) {
  return (await fs.readFile(file, "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
}

async function main(args) {
  if (args.length === 0) return benchmark();
  if (args.length === 1 && args[0] === "--alternate") return benchmark(true);
  if (args[0] === "--alternate" && args[1] === "--round" && args.length === 3) {
    const rounds = [...new Set(args[2].split(",").map(Number))];
    assert(rounds.every(round => Number.isInteger(round) && round >= 1 && round <= orders.length), "Invalid replacement round");
    return benchmark(true, rounds);
  }
  assert(args.length >= 2 && args[0] === "--verify-journal",
    "Expected --alternate [--round N] or --verify-journal <turns.jsonl> [replacement-turns.jsonl]");
  let rows = await readJournal(args[1]);
  for (const file of args.slice(2)) {
    const replacement = await readJournal(file);
    const roundNumbers = [...new Set(replacement.map(turn => turn.round))];
    verifyTurns(replacement, roundNumbers);
    assert(replacement.every(turn => turn.question === rows[0]?.question), "Replacement question differs");
    rows = rows.filter(turn => !roundNumbers.includes(turn.round)).concat(replacement);
  }
  rows.sort((a, b) => a.round - b.round || a.position - b.position);
  verifyTurns(rows);
  console.log("Verified " + rows.length + " recorded benchmark turns.");
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
