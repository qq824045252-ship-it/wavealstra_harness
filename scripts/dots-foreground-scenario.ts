import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
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
  let phase: "audit" | "recipe" | "short" = "audit";
  let releaseWorker!: () => void;
  const workerGate = new Promise<void>(done => { releaseWorker = done; });
  const fixture = await createAgentDurableFixture(root, db, async transcript => {
    const names = getCurrentTools(transcript.messages).map(tool => tool.name);
    if (!names.includes("dots_action")) {
      if (!names.includes("read")) return [{ type: "text", text: '{"candidates":[]}' }];
      workerCalls++;
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
        path: phase === "audit" ? "ledger.txt" : "recipe.txt", offset, allowHandoff: phase === "audit" } });
    const list = { type: "toolCall" as const, id: "list-" + foregroundCalls, name: "dots_action",
      arguments: { action: "files", spaceId: space.id, allowHandoff: phase === "audit" } };
    if (phase === "recipe") return foregroundCalls === 1 ? [file(0)] : [list];
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
  });
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
    const ack = (await agent.loadTaskHistory(DOTS_TASK_ID)).messages.find(message => message.text.includes("已受理后续工作"));
    assert(ack?.text.includes("mybuddy://task/" + job.taskId));
    assert(delegations.list(["audit-ledger"]).length === 1);
    assert.equal(failLink, false);
    assert.equal(loseReceipt, false);
    assert.equal(db.listTasks().length, 1);
    const reads = new DotsForegroundReads(db.connection);
    const ledger = reads.state("audit-ledger");
    assert.equal(ledger.characters, 12_020);
    assert.equal(ledger.exhausted, true);
    assert(foregroundCalls <= 5, "a repeated read cannot keep a terminated tool round running");
    phase = "short";
    await ask("new-input", "现在回答一条独立的短问题。");
    assert(agent.isTaskBusy(job.taskId), "front handles a new input while the ordinary worker is still running");
    await agent.releaseDurableTask(DOTS_TASK_ID);
    assert.deepEqual(new DotsForegroundReads(db.connection).state("audit-ledger"), ledger);
    releaseWorker();

    phase = "recipe";
    foregroundCalls = 0;
    const cwd = agent.resolveTaskExecutionWorkspaceCwd(DOTS_TASK_ID);
    writeFileSync(join(cwd, "recipe-context.txt"), "synthetic recipe notes");
    const fallback = agent.answerRouting.list().find(rule => rule.id === defaultAnswerRuleId)!;
    const rule = agent.answerRouting.save({ title: "食谱临摹规则", include: ["食谱临摹"], exclude: [],
      instruction: "按本轮指定范围处理。", evidenceFile: "recipe-context.txt", enabled: true,
      projectId: null, sourceMemoryId: null,
      policy: { ...fallback.policy!, foregroundReadLimits: { characters: 2_000, sources: 3, calls: 3 } } });
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
    const recipe = reads.state("recipe-summary");
    assert.equal(recipe.calls, 3);
    assert.equal(recipe.reads[0].characters, "synthetic recipe notes".length);
    assert.equal(reads.state("recipe-revision").calls, 0);
    assert.equal(delegations.list(["recipe-summary"]).length, 0);
    assert((await agent.loadTaskHistory(DOTS_TASK_ID)).messages.some(message => message.text.includes("前台读取已达上限。当前输入未允许")));
    assert.equal(foregroundCalls, 2);
    const disabled = agent.answerRouting.save({ ...rule, enabled: false }, rule);
    agent.answerRouting.save({ ...disabled, enabled: true }, disabled);
    assert.throws(() => new DotsForegroundReads(db.connection).state("recipe-summary"), /已撤销/);
    console.log("PASS Dots foreground budget, parallel read arbitration, native handoff receipt, independent new input and declined handoff");
  } finally {
    releaseWorker();
    releaseRecipe();
    delegations.close();
    await delegations.drain();
    await fixture.close();
    db.close();
  }
}
