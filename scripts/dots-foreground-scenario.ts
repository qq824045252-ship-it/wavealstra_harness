import { fixtureTaskBoard } from "./fixtures/legacy-task-board-store";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { defaultAnswerRuleId } from "../src/shared/answer-routing";
import { createArtifactDomain } from "../src/main/artifact/ArtifactDomainSetup";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DotsActions } from "../src/main/dots/DotsActions";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";
import { DotsForegroundReads } from "../src/main/dots/DotsForegroundReads";
import { createAgentDurableFixture } from "./agent-durable-fixture";

export async function verifyForegroundScheduling(root: string) {
  mkdirSync(root, { recursive: true });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "ledger.txt"), "a".repeat(12_000) + "b".repeat(8_000));
  writeFileSync(join(workspace, "recipe.txt"), "apple pear kiwi");
  const db = new AppDatabase(join(root, "app.db"));
  const space = db.createSpace({ id: "sp-foreground", name: "Foreground fixtures", path: workspace });
  let foregroundCalls = 0;
  let workerCalls = 0;
  let phase: "audit" | "recipe" | "short" | "mixed" | "missing" | "race" = "audit";
  let materialId = "";
  let materialVersion = 0;
  let continuation: { targetTaskId: string; handoffOperationId: string } | undefined;
  let releaseWorker!: () => void;
  const workerGate = new Promise<void>(done => { releaseWorker = done; });
  let originalGateTaken = false;
  let originalStarted!: () => void;
  let releaseOriginal!: () => void;
  const originalRunning = new Promise<void>(done => { originalStarted = done; });
  const originalGate = new Promise<void>(done => { releaseOriginal = done; });
  const controlRevision = "改向后只核对最后一项。";
  const waitForControl = async (entered: Promise<void>, message: string) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), 10_000);
      })]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const fixture = await createAgentDurableFixture(root, db, async (transcript): Promise<AssistantMessage["content"]> => {
    const names = getCurrentTools(transcript.messages).map(tool => tool.name);
    if (!names.includes("dots_action")) {
      if (!names.includes("read")) return [{ type: "text", text: '{"candidates":[]}' }];
      workerCalls++;
      if (phase === "missing" && !originalGateTaken) {
        originalGateTaken = true;
        originalStarted();
        await originalGate;
        return [{ type: "toolCall", id: "worker-control-read", name: "read", arguments: { path: "recipe.txt" } }];
      }
      if (workerCalls === 1) {
        await workerGate;
        return [{ type: "toolCall", id: "worker-ledger", name: "read", arguments: { path: "ledger.txt" } }];
      }
      return [{ type: "text", text: '{"dotsState":"complete","result":"台账核对完成"}' }];
    }
    if (phase === "short") return [{ type: "text", text: "可以继续处理新的事项。" }];
    foregroundCalls++;
    const file = (offset: number) => ({ type: "toolCall" as const, id: "page-" + foregroundCalls + "-" + offset,
      name: "dots_action", arguments: { action: "read_file", spaceId: space.id,
        path: phase === "audit" || phase === "mixed" ? "ledger.txt" : "recipe.txt", offset, allowHandoff: phase === "audit" } });
    const list = { type: "toolCall" as const, id: "list-" + foregroundCalls, name: "dots_action",
      arguments: { action: "files", spaceId: space.id, allowHandoff: phase === "audit" } };
    if (phase === "recipe") return foregroundCalls === 1 ? [file(0)] : [list];
    if (phase === "mixed") {
      const operation: { type: "toolCall"; id: string; name: string; arguments: Record<string, string | number | boolean> } = foregroundCalls <= 2 ? file(foregroundCalls === 1 ? 0 : 12_000)
        : { type: "toolCall" as const, id: "mixed-material-" + foregroundCalls, name: "dots_action",
          arguments: { action: "read_material", itemId: materialId, ...(foregroundCalls === 4 && { version: materialVersion }), spaceId: space.id } };
      return [{ ...operation, arguments: { ...operation.arguments, ...continuation!, allowHandoff: true } }];
    }
    if (phase === "missing") return [{ ...file(0), arguments: { ...file(0).arguments, targetTaskId: continuation!.targetTaskId, allowHandoff: true } }];
    if (phase === "race") return [{ ...file(0), arguments: { ...file(0).arguments, ...continuation!, allowHandoff: true } }];
    return foregroundCalls === 1 ? [file(0)] : [file(12_000), list];
  });
  const { agent } = fixture;
  const domain = createArtifactDomain(db.connection);
  agent.setArtifactDomain(domain.service, domain.coordinator);
  const delegations = new DotsDelegations(db.connection, (task, operation) => agent.dotsSubmission(task, operation), () => {});
  let failLink = true;
  let loseReceipt = true;
  const send = agent.prompt.bind(agent);
  agent.prompt = async (...args) => {
    const accepted = await send(...args);
    if (args[0].dotsForegroundInputs && accepted.receipt && loseReceipt) {
      loseReceipt = false;
      throw new Error("fixture: interrupted after native admission");
    }
    return accepted;
  };
  const actions = new DotsActions(db, agent, {
    link: (...args) => {
      if (args[4].dotsForegroundInputs && failLink) {
        failLink = false;
        throw new Error("fixture: interrupted before linking the ordinary task");
      }
      delegations.link(...args);
    }, changed: () => delegations.refresh(),
    rememberOrigin: (source, origin) => delegations.rememberOrigin(source, origin),
    list: () => delegations.list(), failed: (...args) => delegations.failed(...args),
  }, fixtureTaskBoard(db.connection));
  let releaseRecipe!: () => void;
  let recipeReading!: () => void;
  const recipeGate = new Promise<void>(done => { releaseRecipe = done; });
  const recipeRead = new Promise<void>(done => { recipeReading = done; });
  const recipeInputs: string[][] = [];
  const read = actions.executeForegroundRead.bind(actions);
  actions.executeForegroundRead = async (...args) => {
    const result = await read(...args);
    if (phase === "recipe") {
      recipeInputs.push(args[1].map(input => input.id));
      if (recipeInputs.length === 1) { recipeReading(); await recipeGate; }
    }
    return result;
  };
  agent.setDotsActions(actions);
  const ask = (id: string, text: string) => fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: id, assistantMessageId: "reply-" + id, text });
  const policy = (limits: { characters: number; calls: number; sources: number }) => {
    const current = agent.answerRouting.list().find(rule => rule.id === defaultAnswerRuleId)!;
    agent.answerRouting.save({ ...current, policy: { ...current.policy!, foregroundReadLimits: limits } }, current);
  };

  try {
    db.openDots();
    policy({ characters: 12_020, sources: 2, calls: 4 });
    await ask("audit-ledger", "核对台账全文，当前空间内可以交给普通任务。");
    const [job] = delegations.list(["audit-ledger"]);
    assert(job, "the service creates the ordinary task without another delegate tool call");
    const receipt = (await agent.findSubmission(job.taskId, job.id))?.receipt;
    assert.equal(receipt?.taskId, job.taskId);
    assert.equal(receipt?.operationId, job.id);
    const ack = (await agent.loadTaskHistory(DOTS_TASK_ID)).messages.find(message => message.text.includes("结果会回到这里"));
    assert.equal(ack?.text, `我会在[后台任务](mybuddy://task/${job.taskId})继续处理，结果会回到这里。`);
    assert(delegations.list(["audit-ledger"]).length === 1);
    assert.equal(failLink, false);
    assert.equal(loseReceipt, false);
    assert.equal(db.listTasks().length, 1);
    const reads = new DotsForegroundReads(db.connection);
    const ledger = reads.state("audit-ledger");
    assert.equal(ledger.characters, 12_020);
    assert.equal(ledger.exhausted, true);
    assert(foregroundCalls <= 5, "a repeated read cannot keep a terminated tool round running");
    const callsBeforeQuery = fixture.requests.length;
    const queried = await actions.execute(DOTS_TASK_ID, "audit-ledger", { action: "task", targetTaskId: job.taskId });
    assert(queried && "id" in queried && queried.id === job.taskId);
    assert.equal(fixture.requests.length, callsBeforeQuery);
    assert.equal(db.listTasks().length, 1);
    const oldUse = agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "audit-ledger" })[0];
    policy({ characters: 1_000, sources: 2, calls: 2 });
    phase = "short";
    await ask("new-input", "现在回答一条独立的短问题。");
    const nextUse = agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "new-input" })[0];
    assert.equal(nextUse.revision, oldUse.revision + 1);
    assert.equal(nextUse.policy?.foregroundReadLimits.characters, 1_000);
    assert.equal(agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "audit-ledger" })[0].revision, oldUse.revision);
    assert(agent.isTaskBusy(job.taskId), "front handles a new input while the ordinary worker is still running");
    await agent.releaseDurableTask(DOTS_TASK_ID);
    assert.deepEqual(new DotsForegroundReads(db.connection).state("audit-ledger"), ledger);
    releaseWorker();

    phase = "recipe";
    foregroundCalls = 0;
    const cwd = agent.resolveTaskExecutionWorkspaceCwd(DOTS_TASK_ID);
    writeFileSync(join(cwd, "recipe-context.txt"), "synthetic recipe notes");
    policy({ characters: 2_000, sources: 3, calls: 3 });
    const rule = agent.answerRouting.save({ title: "食谱临摹规则", include: ["食谱临摹"], exclude: [],
      instruction: "按本轮指定范围处理。", evidenceFile: "recipe-context.txt", enabled: true,
      projectId: null, sourceMemoryId: null });
    const routing = agent.answerRouting.list().find(rule => rule.id === defaultAnswerRuleId)!;
    agent.answerRouting.save({ ...routing, policy: { ...routing.policy!, flow: { enabled: true, branches: [
      { id: "recipe-correction", title: "检查食材", checks: [{ id: "ingredients", operator: "all", phrases: ["只核对食材"] }],
        ruleId: rule.id, routeMode: "direct" },
    ] } } }, routing);
    const original = await agent.prompt({ taskId: DOTS_TASK_ID, userMessageId: "recipe-summary",
      assistantMessageId: "recipe-answer", text: "食谱临摹。只在当前对话阅读这份食谱。不要委派。" });
    assert(original.receipt);
    const reachable = await Promise.race([recipeRead.then(() => true), new Promise<boolean>(done => {
      const timer = setTimeout(() => done(false), 5000); timer.unref();
    })]);
    assert(reachable, "the first read was debited before the native tool result");
    const correction = await agent.prompt({ taskId: DOTS_TASK_ID, userMessageId: "recipe-revision",
      assistantMessageId: "recipe-adjustment", text: "改成只核对食材，仍然不要委派。", streamingBehavior: "steer" });
    assert(correction.receipt);
    releaseRecipe();
    assert.equal((await agent.waitForSubmission(original.receipt)).receipt?.status, "done");
    assert.equal((await agent.waitForSubmission(correction.receipt)).receipt?.status, "done");
    assert.deepEqual(recipeInputs, [["recipe-summary"], ["recipe-summary", "recipe-revision"]]);
    const [adjustment] = agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "recipe-revision" });
    assert.match(adjustment?.detail ?? "", /暂未自动预读.*流程采用「检查食材」/);
    assert.equal(adjustment.evidence?.status, "skipped");
    assert.equal(adjustment.policy?.routeMode, "direct");
    assert.match(JSON.stringify(fixture.requests.at(-1)?.input.messages), /只核对食材.*优先依据已有事实/s);
    const recipe = reads.state("recipe-summary");
    assert.equal(recipe.calls, 3);
    assert.equal(recipe.reads[0].characters, "synthetic recipe notes".length);
    assert.equal(reads.state("recipe-revision").calls, 0);
    assert.equal(delegations.list(["recipe-summary"]).length, 0);
    assert((await agent.loadTaskHistory(DOTS_TASK_ID)).messages.some(message => message.text === "这次留在当前对话处理。已取得的资料不足以完成请求。"));
    assert.equal(foregroundCalls, 2);
    const disabled = agent.answerRouting.save({ ...rule, enabled: false }, rule);
    agent.answerRouting.save({ ...disabled, enabled: true }, disabled);
    assert.throws(() => new DotsForegroundReads(db.connection).state("recipe-summary"), /已撤销/);
    const library = agent.dotsLibrary();
    const materials = library.ensureOwnedSpace({ type: "workspace", workspaceId: space.id });
    const note = library.createItem({ spaceId: materials.id, kind: "markdown", title: "台账佐证", content: "历史资料正文" });
    library.updateTextContent({ id: note.id, content: "当前资料正文" });
    materialId = note.id;
    materialVersion = library.listVersions(note.id)[0].version;
    policy({ characters: 30_000, calls: 5, sources: 3 });
    agent.answerRouting.save({ title: "跨入口账本", include: ["跨入口核验"], exclude: [],
      instruction: "核验台账。", evidenceFile: "recipe-context.txt", enabled: true,
      projectId: null, sourceMemoryId: null });
    continuation = { targetTaskId: job.taskId, handoffOperationId: job.id };
    phase = "mixed";
    foregroundCalls = 0;
    await ask("mixed-ledger", "跨入口核验，明确授权续办原任务 " + job.taskId + " 的原操作 " + job.id);
    const mixed = reads.state("mixed-ledger");
    assert.equal(mixed.calls, 5);
    assert.equal(mixed.characters, "synthetic recipe notes".length + 20_000 + "历史资料正文当前资料正文".length);
    assert.equal(mixed.exhausted, true);
    const [continued] = delegations.list(["mixed-ledger"]);
    assert.equal(continued?.taskId, job.taskId);
    assert(continued.id !== job.id);
    assert((await agent.findSubmission(job.taskId, continued.id))?.receipt);
    await agent.waitForSubmission((await agent.findSubmission(job.taskId, continued.id))!.receipt!);
    const received = (await agent.loadTaskHistory(job.taskId)).messages.find(row=>row.inputRequestId===continued.id);
    assert.match(received?.text ?? "", /前台取得的有界文件佐证/);
    assert.match(received?.text ?? "", /ledger\.txt/);
    assert.match(received?.text ?? "", /a{12000}/);
    policy({ characters: 20, calls: 1, sources: 1 });
    agent.answerRouting.save({ title: "缺失预读", include: ["缺档核验"], exclude: [], instruction: "核验食谱。",
      evidenceFile: "missing-note.txt", enabled: true, projectId: null, sourceMemoryId: null });
    phase = "missing";
    foregroundCalls = 0;
    await ask("missing-evidence", "缺档核验，授权移交。");
    assert.equal(agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "missing-evidence" })[0].evidence?.status, "not-found");
    assert.equal(reads.state("missing-evidence").calls, 1);
    assert.equal(reads.state("missing-evidence").exhausted, true);
    const [controlJob] = delegations.list(["missing-evidence"]);
    assert.equal(delegations.list(["missing-evidence"]).length, 1);
    assert.notEqual(controlJob.taskId, job.taskId);
    await waitForControl(originalRunning, "the worker from the exhausted input did not start");
    const budget = reads.state("missing-evidence");
    const taskCount = db.listTasks().length;
    const providerCalls = fixture.requests.length;
    const status = await actions.execute(DOTS_TASK_ID, "missing-evidence", { action: "task", targetTaskId: controlJob.taskId });
    assert("id" in status && status.id === controlJob.taskId);
    assert.equal(fixture.requests.length, providerCalls);
    const directive = { action: "steer", targetTaskId: controlJob.taskId, text: controlRevision } as const;
    const revisedControl = await actions.execute(DOTS_TASK_ID, "missing-evidence", directive);
    assert("receipt" in revisedControl && revisedControl.receipt);
    assert.equal(revisedControl.receipt.taskId, controlJob.taskId);
    assert.notEqual(revisedControl.receipt.operationId, controlJob.id);
    const beforeStop = await agent.findSubmission(controlJob.taskId, revisedControl.receipt.operationId);
    assert.equal(beforeStop?.receipt?.submissionId, revisedControl.receipt.submissionId);
    assert(delegations.list(["missing-evidence"]).some(row => row.id === controlJob.id && row.status === "superseded"));
    const stop = { action: "stop", targetTaskId: controlJob.taskId } as const;
    const stopped = await actions.execute(DOTS_TASK_ID, "missing-evidence", stop);
    assert("control" in stopped && ["idle", "stop_requested"].includes(stopped.control));
    releaseOriginal();
    const finalControl = await agent.waitForSubmission(revisedControl.receipt);
    assert.equal(finalControl.receipt?.status, "unanswered");
    const originalControl = await agent.findSubmission(controlJob.taskId, controlJob.id);
    assert.equal(originalControl?.receipt?.status, "unanswered");
    const stopAgain = await actions.execute(DOTS_TASK_ID, "missing-evidence", stop);
    assert("control" in stopAgain && stopAgain.control === stopped.control);
    assert.equal(db.listTasks().length, taskCount);
    assert.deepEqual(reads.state("missing-evidence"), budget);
    assert.equal(delegations.list(["missing-evidence"]).length, 2);
    assert(delegations.list(["missing-evidence"]).every(row => row.taskId === controlJob.taskId));
    console.log("PASS exhausted Dots input can query, redirect and stop its original worker without spending read budget or creating a task");
    continuation = { targetTaskId: job.taskId, handoffOperationId: continued.id };
    phase = "race";
    foregroundCalls = 0;
    const findSubmission = agent.findSubmission.bind(agent);
    let replaced = false;
    agent.findSubmission = async (...args) => {
      const result = await findSubmission(...args);
      if (args[0] === job.taskId && !replaced) {
        replaced = true;
        delegations.link(job.taskId, "racing-revision", "racing-source", true);
      }
      return result;
    };
    try {
      await ask("racing-handoff", "缺档核验，授权续办原任务 " + job.taskId + " 的原操作 " + continued.id);
    } finally { agent.findSubmission = findSubmission; }
    assert(replaced);
    assert.equal(delegations.list(["racing-handoff"]).length, 0);
    assert((await agent.loadTaskHistory(DOTS_TASK_ID)).messages.some(row => row.text.includes("原任务的交办已变化")));
    console.log("PASS one native ledger across pre-read, pages and current/historic material; failed pre-read stays bounded; explicit continuation carries excerpts and reuses task");
    console.log("PASS Dots foreground budget, parallel read arbitration, native handoff receipt, independent new input and declined handoff");
  } finally {
    releaseWorker();
    releaseRecipe();
    releaseOriginal();
    delegations.close();
    await delegations.drain();
    await fixture.close();
    db.close();
  }
}
