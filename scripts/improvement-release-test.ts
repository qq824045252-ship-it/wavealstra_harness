import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openDurablePassiveStorage } from "../src/main/agent/durable/DurableStorage";
import { NativeImprovementService } from "../src/main/agent/hooks/NativeImprovementService";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { createAgentDurableFixture } from "./agent-durable-fixture";
import type { ImprovementAssetKind, ImprovementPackage } from "../src/shared/native-improvement";

const worker = process.argv[2];
const root = worker ? process.argv[3]! : mkdtempSync(join(tmpdir(), "mybuddy-weekly-release-"));
process.env.HOME = process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
mkdirSync(join(root, ".mybuddy/plugins/mcp"), { recursive: true });
mkdirSync(join(root, ".mybuddy/agents"), { recursive: true });
writeFileSync(join(root, ".mybuddy/agents/release-writer.md"), [
  "---", "name: release-writer", "description: Write the requested document and attachment.",
  "tools: read, write", "---", "Complete the assigned document in the supplied working directory.",
].join("\n"));

type Content = AssistantMessage["content"];
type Spec = { document: string; heading: string; attachment: string };
const spec: Spec = { document: "report.md", heading: "结论", attachment: "evidence.csv" };
const variant: Spec = { document: "summary.md", heading: "结果", attachment: "numbers.csv" };
const childSpec: Spec = { document: "child-report.md", heading: "发现", attachment: "child-data.csv" };
const crashSpec: Spec = { document: "recovery.md", heading: "恢复结果", attachment: "recovery.csv" };
const requiredKinds: ImprovementAssetKind[] = ["convention", "hook", "memory", "skill", "tool"];
const request = (s: Spec) => `生成 ${s.document}，必须包含章节「${s.heading}」和附件 ${s.attachment}。`;
const correction = (s: Spec) => `你漏了章节「${s.heading}」和附件 ${s.attachment}，请补齐。`;
const complete = (s: Spec) => `# 数据报告\n\n## ${s.heading}\n\n完成核对。\n`;
const incomplete = "# 数据报告\n\n草稿。\n";
const attachment = "证据,状态\n样本,已核对\n";
const text = (value: string): Content => [{ type: "text", text: value }];
const call = (name: string, args: Record<string, string>): Content => [{ type: "toolCall", id: randomUUID(), name, arguments: args }];
const write = (path: string, content: string) => call("write", { path, content });
function body(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(v => v?.type === "text" ? v.text : "").join("\n");
}

// The fixture owns only the model boundary. It starts with a bad draft, then repairs
// exclusively on concrete feedback about a missing contract member.
function writer(s: Spec, options: { interrupt?: boolean; decline?: boolean; useKnowledge?: boolean } = {}) {
  let phase: "start" | "draft" | "document" | "attachment" = "start";
  return (input: TranscriptContext): Content => {
    const last = input.messages.findLast(m => m.timestamp !== 0)!;
    const message = body(last.content);
    if (phase === "start") {
      phase = "draft";
      return write(s.document, incomplete);
    }
    const currentNotes = body(input.messages.at(-1)?.content);
    const learned = currentNotes.includes("按本轮要求检查实际文件") &&
      currentNotes.includes("技能 weekly-delivery-check") && currentNotes.includes("在权限允许时继续补齐可修复的缺项") &&
      currentNotes.includes("该任务的用户曾指出先前明确的交付要求被遗漏");
    if (phase === "draft" && message.includes("交付检查还缺少") && message.includes(s.attachment) && !options.decline &&
        (!options.useKnowledge || learned)) {
      phase = "document";
      return write(s.document, complete(s));
    }
    if (phase === "document" && last.role === "toolResult" && last.toolName === "write" && !last.isError) {
      phase = "attachment";
      return write(s.attachment, attachment);
    }
    if (phase === "attachment" && options.interrupt && last.role === "toolResult" && !last.isError) {
      // Both mutations are committed and their native tool results are now visible
      // to the next provider request. Hang HERE and let the parent kill the process.
      writeFileSync(join(root, "repair-finished"), last.toolCallId, { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return text("已完成。");
  };
}

const db = new AppDatabase(join(root, "app.db"));
let respond: (input: TranscriptContext) => Content = () => text("本轮结束。");
const model = (input: TranscriptContext): Content => {
  if (getCurrentTools(input.messages).length) return respond(input);
  const preview = body(input.messages.at(-1)?.content);
  if (preview.startsWith('[{"id":')) {
    const rows: { id: number }[] = JSON.parse(preview);
    return text(JSON.stringify({ route: "执行检查", finding: "交付需要核验", reason: "依据当前原始记录",
      change: "对照原始约定", acceptance: "核对实际交付文件", evidence: rows.slice(0, 3).map(row => row.id) }));
  }
  return text('{"candidates":[]}');
};
type Fixture = Awaited<ReturnType<typeof createAgentDurableFixture>>;
let fixture: Fixture;
async function open() {
  fixture = await createAgentDurableFixture(root, db, model);
  await fixture.agent.updateAppSettings({ memoryEnabled: true, permissionMode: "auto", defaultModelId: "fixture/model" });
}
function ensureTask(taskId: string) {
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now(), modelId: "fixture/model", permissionMode: "auto", welcomeMode: "general" });
}
function binding(taskId: string) {
  const b = db.connection.prepare("SELECT cwd,directory FROM durable_bot_bindings WHERE task_id=?").get(taskId) as
    { cwd: string; directory: string } | undefined;
  assert(b, `missing durable binding for ${taskId}`);
  return b;
}
const prompt = (taskId: string, value: string) => fixture.prompt({
  taskId, text: value, userMessageId: randomUUID(), assistantMessageId: randomUUID(),
});
function verifyFiles(taskId: string, s: Spec) {
  const cwd = binding(taskId).cwd;
  assert.equal(readFileSync(join(cwd, s.document), "utf8"), complete(s));
  assert.equal(readFileSync(join(cwd, s.attachment), "utf8"), attachment);
}
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const main = "weekly-contract";
async function alreadyReleased(taskId = main): Promise<ImprovementPackage> {
  const p = (await fixture.agent.nativeImprovement.report()).packages.find(p => p.scope.id === taskId);
  assert(p, `no published package for ${taskId}`);
  return p;
}
async function seedFailure(taskId: string, s = spec) {
  respond = writer(s);
  await prompt(taskId, request(s));
  assert.equal(readFileSync(join(binding(taskId).cwd, s.document), "utf8"), incomplete);
  assert.equal(existsSync(join(binding(taskId).cwd, s.attachment)), false);
  respond = () => text("收到。");
  await prompt(taskId, correction(s));
}
const covered = new Set<number>();
function passed(id: number, name: string) {
  assert(!covered.has(id));
  covered.add(id);
  console.log(`PASS ${String(id).padStart(2, "0")} · ${name}`);
}

async function child(s?: Spec) {
  const marker = "分配给写作子代理，请直接交接。";
  const task = s ? request(s) : "读取 file-that-does-not-exist.txt，并回报实际读取结果。";
  const childWrite = s && writer(s, { useKnowledge: true });
  respond = input => {
    const last = input.messages.at(-1)!;
    if (last.role === "toolResult" && last.toolName === "subagent") {
      assert.equal(last.isError, false, body(last.content));
      return text("子代理已返回。");
    }
    if (last.role === "user" && body(last.content).includes(marker)) {
      return call("subagent", { agent: "release-writer", task, model: "fixture/model", isolation: "shared" });
    }
    if (childWrite) return childWrite(input);
    return last.role === "toolResult" ? text("输入文件不存在。") : call("read", { path: "file-that-does-not-exist.txt" });
  };
  await prompt(main, marker);
}
async function interact(s: Spec, taskId = main, decline = false) {
  respond = writer(s, { decline, useKnowledge: true });
  await prompt(taskId, request(s));
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function killAt(mode: "stage" | "repair", marker: string, args: string[]) {
  const child = fork(process.argv[1]!, [mode, root, ...args], { execArgv: [], silent: true });
  let log = "";
  child.stderr!.on("data", b => { log = (log + b).slice(-3500); });
  child.stdout!.on("data", b => { log = (log + b).slice(-3500); });
  const exit = new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("exit", () => done());
  });
  const deadline = Date.now() + 60_000;
  try {
    while (!existsSync(join(root, marker))) {
      if (child.exitCode !== null || child.signalCode || Date.now() >= deadline) throw Error(`worker didn't reach ${mode}: ${log}`);
      await pause(40);
    }
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}

async function nativeWrites(taskId: string, conversation: string, document: string) {
  const storage = await openDurablePassiveStorage(binding(taskId).directory, ctx);
  assert(storage);
  const writes = new Map<string, string>(), committed = new Set<string>();
  try {
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    do {
      const page = await storage.scanEntries({
        conversationId: Number(conversation) as import("@earendil-works/pi-durable").ConversationId, order: "ascending",
      }, 128, cursor, ctx);
      for (const entry of page.items) for (const message of entry.model ?? []) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall" && part.name === "write" && part.arguments.path === document)
            writes.set(part.id, String(part.arguments.content));
        } else if (message.role === "toolResult" && message.toolName === "write" && !message.isError) {
          committed.add(message.toolCallId);
        }
      }
      cursor = page.next;
    } while (cursor);
  } finally { await storage.close(ctx); }
  return [...writes].filter(([id]) => committed.has(id));
}
async function revised(id: string, addition: string) {
  const draft = await fixture.agent.nativeImprovement.packages.draft(id);
  assert(draft);
  return { ...draft, convention: draft.convention + "\n" + addition };
}
async function runWorker() {
  await open();
  if (worker === "stage") {
    const id = process.argv[4]!;
    const hash = await fixture.agent.nativeImprovement.packages.stage(await revised(id, "发布中断样本"));
    writeFileSync(join(root, "staged"), hash, { flag: "wx" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else if (worker === "repair") {
    respond = writer(crashSpec, { interrupt: true, useKnowledge: true });
    const admission = await fixture.agent.prompt({ taskId: main, text: request(crashSpec), modelId: "fixture/model",
      userMessageId: randomUUID(), assistantMessageId: randomUUID() });
    assert(admission.receipt);
    writeFileSync(join(root, "admission.json"), JSON.stringify(admission.receipt));
    await fixture.agent.waitForSubmission(admission.receipt);
    throw Error("The repair finished before the requested crash boundary");
  } else throw Error("Unknown fixture worker");
}

async function suite() {
  await open();
  const changed = "weekly-new-requirement", pending = "weekly-unused", unsuccessful = "weekly-corrected", outside = "weekly-other";
  for (const id of [main, changed, pending, unsuccessful, outside, "weekly-fork"]) ensureTask(id);
  await seedFailure(main);
  const afterFirst = await fixture.agent.loadTaskHistory(main);
  const mainConversation = String(afterFirst.durable!.conversationId);
  const correctionMessage = afterFirst.messages.find(m => m.role === "user" && m.text.includes(correction(spec)));
  assert(correctionMessage?.entryId);
  const forkAnchor = await fixture.agent.previewConversationBranch({
    sourceTaskId: main, entryId: correctionMessage.entryId, position: "after_reply", requestId: randomUUID(),
  });
  const forkDirectory = join(root, "fork-workspace");
  mkdirSync(forkDirectory);
  const forked = await fixture.agent.materializeConversationBranch(main, "weekly-fork", forkDirectory, forkAnchor);
  fixture.agent.commitConversationBranch("weekly-fork", forkDirectory, forked);
  await seedFailure(main);
  await child();
  respond = () => text("本轮结束。");
  let aged = false;
  for (let i = 0; i < 120; i++) {
    await prompt(main, "独立短问答 " + i);
    const visible = await fixture.agent.loadTaskHistory(main, undefined, "current");
    if (!visible.messages.some(m => m.role === "user" && m.text.includes(correction(spec)))) { aged = true; break; }
  }
  assert(aged, "source correction must actually be outside the current display window");
  await prompt(changed, request(spec));
  await prompt(changed, "现在调整要求，新增章节「限制」和附件 appendix.txt。");
  await seedFailure(pending);
  await seedFailure(unsuccessful);
  const service = fixture.agent.nativeImprovement;
  const [scan, parallel] = await Promise.all([service.review(), service.review()]);
  assert.deepEqual(scan.packages, parallel.packages);
  assert.deepEqual(scan.runs[0].issues, []);
  const initial = await alreadyReleased();
  assert.equal(initial.source.taskId, main);
  const item = scan.items.find(i => i.sources.some(s => s.entry === initial.source.entry && s.taskId === main));
  assert(item, "the published change must link back to its original inputs");
  const source = await service.source(item.key, initial.source.taskId, initial.source.conversationId, initial.source.entry);
  assert(source.some(e => e.content.some(c => c.text?.includes(correction(spec)))));
  assert(source.some(e => e.content.some(c => c.text?.includes(request(spec)))));
  const closed = scan.children.find(c => c.taskId === main && c.status === "completed");
  assert(closed);
  const origin = await service.child(main, closed.conversation);
  assert(origin.parentReturnEntry && origin.parentCallId);
  assert(origin.tools.some(t => t.name === "read" && t.status === "failed" && t.resultEntry));
  assert(origin.assignment.includes("file-that-does-not-exist.txt"));
  assert(!scan.packages.some(p => p.scope.id === "weekly-fork"));
  passed(1, "查回界面窗口外的纠正、已结束子代理的工具记录，分支没有重复计数");

  assert(!scan.packages.some(p => p.scope.id === changed));
  assert(!scan.items.some(i => i.sources.some(s => s.taskId === changed)));
  passed(2, "新增交付要求未计为原任务失败");
  assert.deepEqual(scan.packages.filter(p => p.scope.id === main).map(p => p.revision), [1]);
  assert.equal(item.count, 2, "two distinct grounded corrections should aggregate");
  assert.deepEqual(initial.assets.map(a => a.kind).sort(), requiredKinds);
  assert(initial.assets.every(a => /^[a-f\d]{64}$/.test(a.hash)));
  const rerun = await service.review();
  assert.deepEqual(rerun.packages, scan.packages);
  assert.equal(rerun.items.find(i => i.key === item.key)!.count, 2);
  passed(3, "两个独立来源聚到同一版本，同周重复运行没有新发布");

  await interact(spec);
  verifyFiles(main, spec);
  const uses = () => fixture.agent.nativeImprovement.packages.uses(initial.id, initial.revision);
  const events = new Set((await uses()).filter(u => u.actor === "main").map(u => u.kind + "/" + u.event));
  for (const expected of ["convention/applied", "skill/read", "memory/recalled", "tool/executed", "hook/feedback", "hook/passed"])
    assert(events.has(expected), `missing actual main use ${expected}: ${[...events]}`);
  passed(4, "原任务从缺章节和附件的草稿修复到独立核验通过，五类资产均有使用回执");
  await interact(variant);
  verifyFiles(main, variant);
  const count = (await uses()).length;
  respond = () => text("本次只答复问题。");
  await prompt(main, "如何生成 optional.md？不需要附件。");
  await prompt(outside, request(spec));
  assert.equal((await uses()).length, count);
  passed(5, "文件名、章节和附件变体通过，问句和其他作用域没有触发");

  await child(childSpec);
  verifyFiles(main, childSpec);
  const reviewChild = await service.review();
  const childRow = reviewChild.children.find(c => c.taskId === main && c.conversation !== closed.conversation);
  assert(childRow);
  const childOrigin = await service.child(main, childRow.conversation);
  assert(childOrigin.parentReturnEntry && childOrigin.parentCallId);
  for (const [name, expected] of [[childSpec.document, complete(childSpec)], [childSpec.attachment, attachment]]) {
    const childWrites = await nativeWrites(main, String(childRow.conversation), name);
    assert(childWrites.some(([, value]) => hex(value) === hex(expected)));
    assert.deepEqual(await nativeWrites(main, mainConversation, name), [], "parent must not repair the child's files");
  }
  const childUses = (await uses()).filter(u => u.actor === "subagent" && String(u.conversation) === String(childRow.conversation));
  assert.deepEqual([...new Set(childUses.map(u => u.kind))].sort(), requiredKinds);
  assert(childUses.every(u => u.task === main && u.run));
  // Give a second child a structurally complete file written by its parent in
  // this very submission. No amount of parent-side evidence proves child use.
  const parentFiles = { ...spec, document: "parent-produced.md", attachment: "parent-evidence.csv" };
  let parentStep = 0;
  respond = input => {
    if (parentStep === 0) { parentStep++; return write(parentFiles.document, complete(parentFiles)); }
    if (parentStep === 1) { parentStep++; return write(parentFiles.attachment, attachment); }
    if (parentStep === 2) {
      parentStep++;
      return call("subagent", { agent: "release-writer", task: request(parentFiles), model: "fixture/model", isolation: "shared" });
    }
    const last = input.messages.at(-1);
    return text(last?.role === "toolResult" && last.toolName === "subagent" ? "已核对交接状态。" : "已完成。");
  };
  await prompt(main, "准备交接样本，再交给子代理独立完成。");
  const peer = (await service.review()).children.find(c => c.taskId === main && c.conversation !== closed.conversation && c.conversation !== childRow.conversation);
  assert(peer);
  verifyFiles(main, parentFiles);
  assert.deepEqual(await nativeWrites(main, String(peer.conversation), parentFiles.document), []);
  const peerUses = (await uses()).filter(u => u.actor === "subagent" && String(u.conversation) === String(peer.conversation));
  assert(peerUses.some(u => u.kind === "tool" && u.event === "unknown"));
  assert(!peerUses.some(u => u.event === "passed" || u.event === "accepted"));
  passed(6, "子会话亲自写文件、读取技能并核验，父会话没有代写");
  const latestHistory = await fixture.agent.loadTaskHistory(main);
  assert.equal(String(latestHistory.durable!.conversationId), mainConversation);
  assert((await uses()).some(u => u.actor === "main" && String(u.conversation) === mainConversation));
  passed(7, "原已打开会话在下一次适用任务中使用新版本");

  // Do not share a live Durable writer with the two crash workers.
  await fixture.close();
  await killAt("stage", "staged", [initial.id]);
  await open();
  assert.deepEqual(await alreadyReleased(), initial);
  assert(readFileSync(join(root, "staged"), "utf8") !== initial.hash);
  passed(8, "暂存完成后杀死发布进程，重开后五项仍为原版");

  await fixture.close();
  await killAt("repair", "repair-finished", []);
  verifyFiles(main, crashSpec);
  respond = () => text("文件修复已完成。");
  await open();
  const receipt = JSON.parse(readFileSync(join(root, "admission.json"), "utf8"));
  assert.equal((await fixture.agent.waitForSubmission(receipt)).receipt?.status, "done");
  const beforeCrash = readFileSync(join(root, "repair-finished"), "utf8");
  assert.deepEqual(await nativeWrites(main, mainConversation, crashSpec.attachment), [[beforeCrash, attachment]]);
  assert.deepEqual((await nativeWrites(main, mainConversation, crashSpec.document)).map(([, value]) => value), [incomplete, complete(crashSpec)]);
  passed(9, "修复文件已落盘后杀死执行进程，原提交恢复且两笔修复均只执行一次");

  const activeService = fixture.agent.nativeImprovement;
  const releases = activeService.packages;
  const changes = ["图表须按文档中的顺序核对。", "附件须按当前明确清单核对。"];
  const submitted = changes.map(async change => releases.publish(await revised(initial.id, change), initial.generation));
  const raced = await Promise.allSettled(submitted);
  assert.equal(raced.filter(r => r.status === "fulfilled").length, 1);
  const refused = raced.find(r => r.status === "rejected");
  assert(refused?.status === "rejected" && /基础|过期|冲突|变化|stale|conflict/i.test(String(refused.reason)), String(refused));
  const winning = await alreadyReleased();
  assert.equal(winning.revision, initial.revision + 1);
  const losing = changes[raced.indexOf(refused)]!;
  assert(!(await releases.draft(initial.id))!.convention.includes(losing));
  await releases.publish(await revised(initial.id, losing), winning.generation);
  const stable = await alreadyReleased();
  const merged = await releases.draft(initial.id);
  assert(changes.every(change => merged!.convention.includes(change)));
  await interact({ ...variant, document: "stable.md", attachment: "stable.csv" });
  verifyFiles(main, { ...variant, document: "stable.md", attachment: "stable.csv" });
  passed(11, "并发提交同一基础版本只接受一份，两项改动合并重验后生效");

  const flawedDraft = await revised(initial.id, "验证可回退的候选版本。");
  const fragile = { ...variant, document: "regression.md", attachment: "variant-exception.csv" };
  // This flaw depends on a novel input absent from maintained replay cases.
  // Activation therefore passes the original, variant and negative controls.
  flawedDraft.hook = { ...flawedDraft.hook,
    script: 'if (JSON.stringify(event).includes("variant-exception.csv")) throw Error("variant-specific regression");\n' + flawedDraft.hook.script };
  await releases.publish(flawedDraft, stable.generation);
  const withdrawn = await alreadyReleased();
  respond = writer(fragile, { decline: true });
  const regression = await fixture.agent.prompt({ taskId: main, modelId: "fixture/model", text: request(fragile),
    userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  assert(regression.receipt);
  await fixture.agent.waitForSubmission(regression.receipt);
  const failures = (await releases.uses(initial.id, withdrawn.revision)).filter(r => r.kind === "hook" && r.event === "error");
  assert(failures.length, "the regressed version must actually execute and fail");
  assert.equal((await alreadyReleased()).hash, stable.hash);
  await assert.rejects(releases.stage({...flawedDraft,convention:flawedDraft.convention+" 再版。"}),/variant-specific regression/);
  const frozen = await releases.uses(initial.id, withdrawn.revision);
  const restoredMain = { ...variant, document: "restored.md", attachment: "restored.csv" };
  await interact(restoredMain);
  verifyFiles(main, restoredMain);
  const restoredChild = { ...childSpec, document: "restored-child.md", attachment: "restored-child.csv" };
  await child(restoredChild);
  verifyFiles(main, restoredChild);
  assert.deepEqual(await releases.uses(initial.id, withdrawn.revision), frozen);
  const restoredUses = await releases.uses(initial.id, stable.revision);
  for (const actor of ["main", "subagent"]) assert(restoredUses.some(r => r.actor === actor && r.kind === "hook" && r.event === "passed"));
  passed(10, "具体变体触发新版故障，回退后主、子会话均使用上一可用版本");

  // A header and an attachment exist, but the actual measurements requested by the
  // user are absent. A structural checker cannot award semantic acceptance.
  let turn = 0;
  respond = () => {
    if (++turn === 1) return write(variant.document, "# 报告\n## 结果\n待测。\n");
    if (turn === 2) return write(variant.attachment, "编号,读数\n");
    return text("已完成。");
  };
  await prompt(unsuccessful, request(variant) + "请在章节和附件中写入样本读数 7。");
  assert(!readFileSync(join(binding(unsuccessful).cwd, variant.attachment), "utf8").includes("7"));
  const observed = await activeService.review();
  const [unused, corrected] = await Promise.all([alreadyReleased(pending), alreadyReleased(unsuccessful)]);
  const weekStart = Date.parse(initial.week + "T00:00:00Z") + 7 * 86400000;
  const nextWeek = new Date(weekStart).toISOString().slice(0, 10);
  const weeklyReview = async (now: number) => {
    const weekly = new NativeImprovementService(db, fixture.agent.nativeHooks, join(root, ".mybuddy"),
      () => now, undefined, activeService.knowledge);
    try {
      const report = await weekly.review();
      assert.deepEqual(report.runs[0].issues, []);
      return report;
    } finally { await weekly.close(); }
  };
  const early = (await weeklyReview(weekStart)).outcomes;
  assert(early.some(r => r.week === nextWeek && r.packageId === corrected.id && r.state === "effective" && r.corrections === 0));
  // Advance only this isolated worker's clock while the user reads the files and
  // corrects the already-settled submission. All relevant timestamps come from Pi.
  const clock = Date.now, offset = weekStart + 60_000 - clock();
  let afterCorrection: number;
  try {
    Date.now = () => clock() + offset;
    respond = () => text("收到。");
    await prompt(unsuccessful, "你漏了章节「结果」和附件 numbers.csv 里的样本读数 7，请补齐。");
    afterCorrection = Date.now();
  } finally { Date.now = clock; }
  const outcomes = (await weeklyReview(afterCorrection)).outcomes;
  function outcome(p: ImprovementPackage) {
    const row = outcomes.find(r => r.week === nextWeek && r.packageId === p.id && r.revision === p.revision);
    assert(row, `missing next-week outcome for ${p.id}/${p.revision}: ${JSON.stringify(outcomes)}`);
    return row;
  }
  const good = outcome(initial);
  assert.equal(good.state, "effective");
  assert(good.opportunities > 0 && good.accepted > 0 && good.corrections === 0);
  assert.deepEqual(good.assets?.map(a => a.kind).sort(), requiredKinds);
  assert(good.assets!.every(a => a.state === "effective" && a.used > 0 && a.accepted > 0 && a.errors === 0));
  const bad = outcome(corrected);
  assert.equal(bad.state, "ineffective");
  assert(bad.opportunities > 0 && bad.corrections > 0);
  assert.equal(outcome(unused).state, "pending");
  assert.equal(outcome(unused).opportunities, 0);
  const untested = outcome(unused).assets!;
  assert.deepEqual(untested.map(a => a.kind).sort(), requiredKinds);
  assert(untested.every(a => a.state === "pending" && a.used === 0 && a.accepted === 0));
  assert.equal(outcome(withdrawn).state, "regressed");
  assert(outcome(withdrawn).errors > 0);
  assert.deepEqual((await weeklyReview(afterCorrection)).outcomes, outcomes);
  const quietStart = weekStart + 7 * 86400000, quietWeek = new Date(quietStart).toISOString().slice(0, 10);
  const quiet = (await weeklyReview(quietStart)).outcomes.find(r => r.week === quietWeek && r.packageId === initial.id && r.revision === initial.revision);
  assert(quiet && quiet.state === "pending" && quiet.opportunities === 0, "a past successful week cannot create a later opportunity");
  assert(observed.packages.some(p => p.id === unused.id));
  passed(12, "下一自然周按实际使用、纠正和故障区分有效、无效、待验证及失效");
  assert.deepEqual([...covered].sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10,11,12]);
}

try {
  if (worker) await runWorker();
  else await suite();
} finally {
  if (fixture!) await fixture.close();
  db.close();
  if (!worker && covered.size === 12) rmSync(root, { recursive: true, force: true });
  else if (!worker) console.error("Isolated acceptance evidence:", root);
}
