import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { normalizePstackSettings } from "../src/shared/pstack";
import { createPstackWorkflow, isPstackCheck } from "../src/main/agent/pstack/PstackWorkflow";
import { isPstackObservation } from "../src/main/agent/pstack/PstackObservationCommand";
import { WorkflowState } from "../src/main/agent/pstack/PstackState";
import { formatPstackBlock, formatStoredPstackReply } from "../src/main/agent/pstack/PstackBlockReport";

const rawBlock = String.raw`目录 C:\new\repo。\n已完成：验证通过。\n解除条件：\n1) 选择仓库。\n2) 再次验证。`;
const formattedBlock = formatPstackBlock(rawBlock);
assert.match(formattedBlock, /^## 工作流暂停\n/);
assert.ok(formattedBlock.includes("### 已完成\n\n验证通过。"));
assert.ok(formattedBlock.includes("1) 选择仓库。\n2) 再次验证。"));
assert.ok(formattedBlock.includes(String.raw`C:\new\repo`));
assert.equal(formatStoredPstackReply("pstack 工作流尚待继续。当前阻碍：" + rawBlock), formattedBlock);
assert.equal(formatStoredPstackReply(rawBlock), rawBlock);
const codeSample = ["```js", String.raw`const s = "。\n已完成：";`, "```"].join("\n");
assert.ok(formatPstackBlock(codeSample).includes(codeSample));
import { testInFlightOwners } from "./pstack-owner-monitor-fixture";
import { baselineWorkspace, branchReviewBase, measureWorkspace, missingFile, readPlanFile, reviewBaseline, reviewCommit, reviewScope, skillFileState } from "../src/main/agent/pstack/PstackWorkspace";
import { reviewIntent } from "../src/main/agent/pstack/PstackReviewIntent";
import { parseThermosVerdict } from "../src/main/agent/pstack/PstackDelegate";
import { observedReviewFiles, reviewTargets, validateInspections } from "../src/main/agent/pstack/PstackReviewEvidence";
import { currentVerificationEvidence, verificationOutcome } from "../src/main/agent/pstack/PstackVerificationEvidence";

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), "mybuddy-pstack-"));
const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://fixture.invalid",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
type Call = { name: string; arguments: Record<string, string | string[] | boolean | Record<string, string>> };
const work = (action: string, fields: Record<string, string | boolean> = {}): Call => ({ name: "pstack_workflow", arguments: { action, ...fields } });
const queue: Call[] = [];
let serial = 0, replies = 0, enabled = true;
const models = { getModel: () => model, getAuth: async () => undefined, streamSimple() {
  const stream = createAssistantMessageEventStream(), call = queue.shift();
  const base: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(), content: [],
    stopReason: call ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  base.content = call ? [{ type: "toolCall", id: "fixture-" + (++serial), ...call }] : [{ type: "text", text: "Fixture yielded." }];
  if (!call) replies++;
  queueMicrotask(() => { stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: base }); stream.end(); });
  return stream;
} } as unknown as DurableBotOptions["models"];

try {
  const repo = join(root, "repo"), cwd = join(root, "plain");
  await mkdir(repo); await mkdir(cwd);
  await writeFile(join(root, "plan.md"), "the configured plan");
  assert.equal((await readPlanFile(root, undefined, "plan.md")).text, "the configured plan");
  await assert.rejects(readPlanFile(root, "another.md", "plan.md"), /saved planPath/);
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { windowsHide: true });
  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "tracked.ts"), "a\nb\n");
  await writeFile(join(repo, "clean.ts"), "one\ntwo\n");
  await git("add", "."); await git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture");
  const divergence = await baselineWorkspace(repo);
  const tree = (await git("rev-parse","HEAD^{tree}")).stdout.trim();
  const fixtureCommit = async (name: string) => (await git("-c","user.name=fixture","-c","user.email=fixture@invalid",
    "commit-tree", tree, "-p", divergence.head, "-m", name)).stdout.trim();
  await git("update-ref","refs/heads/review-base",await fixtureCommit("base moved"));
  const topic = {...divergence,head:await fixtureCommit("topic changed")};
  assert.equal(await branchReviewBase(topic,"review-base"), divergence.head);
  assert.equal(await branchReviewBase(topic,""), divergence.head);
  await assert.rejects(branchReviewBase(topic,"missing-review-ref"));
  await writeFile(join(repo, "tracked.ts"), "prior change\nb\n");
  await writeFile(join(repo, "prior.ts"), "unrelated\n");
  const baseline = await baselineWorkspace(repo);
  assert.deepEqual((await measureWorkspace(baseline, 3)).paths, []);
  const priorReview = reviewScope(baseline, await reviewCommit(baseline, "HEAD"));
  const longRepo = join(root,"long-file");
  await mkdir(longRepo);
  const lines = Array.from({length:1250},(_,i) => "line-" + i);
  await writeFile(join(longRepo,"module.txt"),lines.join("\n"));
  const longBase = await baselineWorkspace(longRepo);
  lines[0] = "updated-first"; lines[1249] = "updated-last";
  await writeFile(join(longRepo,"module.txt"),lines.join("\n"));
  const farEdits = await measureWorkspace(longBase,1000);
  assert.equal(farEdits.changedLines,4, "Two distant replacements should count as two additions and two deletions.");
  assert.equal(farEdits.coverageComplete,true);
  const existing = await measureWorkspace(priorReview, 3);
  assert.deepEqual(existing.paths, ["prior.ts", "tracked.ts"], "existing work selected for review is separate from task-authored changes");
  assert.match((await reviewBaseline(priorReview, existing.paths)).originals["tracked.ts"], /Before:\na\nAfter:\nprior change/);
  await writeFile(join(repo, "tracked.ts"), "new change\nb\n");
  await writeFile(join(repo, "clean.ts"), "one\ntwo\nif (x) use();\n");
  await writeFile(join(repo, "added.ts"), "added\n");
  const delta = await measureWorkspace(baseline, 2);
  assert.deepEqual(delta.paths, ["added.ts", "clean.ts", "tracked.ts"]);
  assert.deepEqual(delta.unknown, []);
  assert.equal(delta.changedLines, 4); assert.equal(delta.largestCrossing, 3); assert.equal(delta.addedBranches, 1);
  assert.match((await reviewBaseline(baseline, delta.paths)).originals["tracked.ts"], /prior change/);
  for (const [request, review, merge] of [
    ["No remote writes, uploads or publication.", false, false],
    ["Code review isn't needed; 代码审查不必做。", false, false],
    ["Do not run a code review or merge the patch; 这次无需审查，也不要合并。", false, false],
    ["Read the `review` action and explain it.\n> Please review the patch", false, false],
    ["修复本地测试样例，严格看下质量，先不要合并", true, false],
    ["Please review target.cjs; do not merge.", true, false],
    ["This is the pre-merge check. Do not merge.", false, true],
    ["合入前先做独立复核，现阶段不要合入。", true, true],
  ] as const) assert.deepEqual(reviewIntent([request]), { review, merge }, request);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "revise", findings: [{ path: "a.ts", issue: "Missing case" }], checks: { types: { path: "a.ts", detail: "Unbounded input" } } }), ["types"]), false);
  const valid = '{"verdict":"pass","findings":[],"checks":{"types":"Inspected target.cjs:1"}}';
  assert.equal(parseThermosVerdict("## 结论\nVerified the target.\n" + valid, ["types"]), true);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "pass", findings: [], notes: ["Optional rename"], checks: { types: "a.ts:1 validates input" } }), ["types"]), true);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "pass", findings: ["Unresolved type leak"], checks: { types: "a.ts:1" } }), ["types"]), false);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "revise", findings: [], notes: ["Investigate"], checks: { types: "a.ts:1" } }), ["types"]), false);
  assert.throws(() => parseThermosVerdict(valid + "\n" + valid, ["types"]), /exactly one/);
  assert.throws(() => parseThermosVerdict(valid + "\nActually, revise this.", ["types"]), /trailing/);
  assert.throws(() => parseThermosVerdict('{"verdict":"pass","findings":[],"checks":{}}', ["types"]), /Missing criteria: types/);
  const signals = join(root, "signals");
  await mkdir(signals);
  await writeFile(join(signals, "photo.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 40]));
  const signalBase = await baselineWorkspace(signals);
  await writeFile(join(signals, "photo.png"), Buffer.alloc(526_000, 0));
  const imageDelta = await measureWorkspace(signalBase, 10);
  assert.deepEqual(imageDelta.paths, ["photo.png"]); assert.deepEqual(imageDelta.unknown, []); assert.equal(imageDelta.changedLines, 0);
  await writeFile(join(signals, "large.txt"), "a".repeat(526_000));
  assert((await measureWorkspace(signalBase, 10)).unknown.some(row => row.startsWith("large.txt")));
  await writeFile(join(signals, "rules.ts"), "function first(a) { if (a) return 1; }\nfunction second(b) { if (b) return 2; }\nfunction third(c) { if (c) return 3; }\n");
  assert.equal((await measureWorkspace(signalBase, 10)).addedBranches, 3);
  const externalRoot = join(root,"installed"), packageId="group-roles", skillDir=join(externalRoot,packageId);
  await mkdir(skillDir,{recursive:true});
  const file=join(skillDir,"SKILL.md"), project=await baselineWorkspace(cwd);
  await writeFile(file,"rule\n".repeat(200));
  const firstSkill=await skillFileState(externalRoot,packageId,true);
  assert.equal((await measureWorkspace(project,200,undefined,[{path:file,before:missingFile,current:firstSkill}])).changedLines,200);
  await writeFile(file,"rule\n".repeat(201));
  const nextSkill=await skillFileState(externalRoot,packageId,true);
  const created=await measureWorkspace(project,200,undefined,[{path:file,before:missingFile,current:nextSkill}]);
  const improved=await measureWorkspace(project,200,undefined,[{path:file,before:firstSkill,current:nextSkill}]);
  assert.deepEqual(created.paths,[file]);assert.equal(created.changedLines,201); assert.equal(improved.changedLines,1);assert.equal(improved.largestCrossing,201);
  assert.deepEqual((await measureWorkspace(project,200)).paths,[]);
  console.log("PASS explicit and negated bilingual intent, structured review findings, exact criteria, SHA-verified binary and scattered branch thresholds");
  for (const fake of ["echo passed", "exit 0", "pnpm test || true", "pnpm test --help", "node --test --test-name-pattern=never; true"])
    assert.equal(isPstackCheck(fake), false, fake);
  assert.equal(isPstackCheck("check-factory sample", "check-factory sample"), true);
  assert.equal(isPstackCheck("node check.cjs"), true);
  assert.equal(isPstackCheck("node scripts/verify-pixels.cjs"), true);
  await writeFile(join(cwd, "compare.cjs"), "console.log('A: 1, B: 2')");
  assert.equal(await isPstackObservation("prototype", "node compare.cjs", cwd), true);
  assert.equal(await isPstackObservation("feature", "node compare.cjs", cwd), false);
  for (const cmd of ["node ../compare.cjs", "node compare.cjs && echo ok", "node compare.cjs --help", "node missing.cjs"])
    assert.equal(await isPstackObservation("trace-forensics", cmd, cwd), false, cmd);
  assert.equal(isPstackCheck("node -e \"console.log('test')\""), false);
  console.log("PASS task-relative Git diff, pre-existing tracked and untracked work, native review baseline, check command admission");

  const incomplete = join(root, "incomplete-workspace");
  await mkdir(incomplete);
  const expectedFile = join(incomplete, "entry");
  await writeFile(expectedFile, "tracked");
  const incompleteBase = await baselineWorkspace(incomplete);
  await rm(expectedFile);
  await mkdir(expectedFile);
  const uncertainBefore = await measureWorkspace(incompleteBase, 1000);
  const uncertainAfter = await measureWorkspace(incompleteBase, 1000);
  assert.equal(uncertainBefore.fingerprint, uncertainAfter.fingerprint);
  assert.equal(uncertainBefore.coverageComplete, false);
  const unverified = verificationOutcome(uncertainBefore, uncertainAfter, 0, false, false, false);
  assert.equal(unverified.outcome, "workspace_unverified");
  assert.match("error" in unverified ? unverified.error : "", /entry: non-regular file/);

  const settings = normalizePstackSettings({});
  const host = createPstackWorkflow({ taskId: "pstack-fixture", cwd, settings: () => settings, active: () => enabled });
  const open = () => DurableBotRuntime.open({ directory: join(root, "store"), cwd, models, model: { provider: model.provider, modelId: model.id },
    toolMode: "native", instructions: () => "Fixture", tools: host.tools, foregroundHooks: host, onSnapshot: () => {} });
  let runtime = await open();
  const status = () => runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx);
  async function turn(input: string, id: string, calls: Call[]) {
    queue.push(...calls);
    const result = await (await runtime.submit(input, id)).wait(ctx);
    await runtime.conversation.waitForIdle(ctx);
    assert.equal(queue.length, 0, JSON.stringify(result));
    return result;
  }
  const skill = "principle-prove-it-works";
  try {
    const first = await turn("把空值情况也兼容一下", "run-1", [
      { name: "write", arguments: { path: "too-early", content: "blocked" } }, work("start", { skill }),
      work("advance", { stage: "apply", note: "Inspect project behavior" }), work("complete"), work("block", { note: "Awaiting fixture input" }),
    ]);
    assert.equal(first.status, "done", JSON.stringify(first));
    const initialHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 100), ctx);
    const initialResults = initialHistory.items.flatMap(e => e.model?.flatMap(m => m.role === "toolResult" ? [JSON.stringify(m.content).slice(0, 320)] : []) ?? []);
    assert.equal((await status())?.run?.phase, "blocked", JSON.stringify(initialResults));
    await assert.rejects(readFile(join(cwd, "too-early")), { code: "ENOENT" });
    const revision = (await status())!.run!.revision;
    await runtime.close(); runtime = await open();
    assert.equal((await status())?.run?.revision, revision, "same run survives production durable reopen");
    const thanks = await runtime.submit("做得挺好的，谢谢", "acknowledge-block");
    assert.equal(await runtime.reply(thanks), "Fixture yielded.", "a new acknowledgement gets its own reply");
    assert.equal((await status())?.run?.phase, "blocked", "acknowledgement does not clear the gate");
    const testFile = "const test=require('node:test'); test('works',()=>{});\n";
    const changingTest = "require('node:test')('passes while workspace changes',()=>require('node:fs').writeFileSync('overlap.txt','updated'));\n";
    const finished = await turn("继续", "run-2", [work("resume"),
      { name: "write", arguments: { path: "check.cjs", content: testFile } },
      work("complete"), work("verify", { shell: "bash", command: "echo passed" }), work("verify", { shell: "bash", command: "node --test" }),
      { name: "write", arguments: { path: "overlap.txt", content: "original" } },
      { name: "write", arguments: { path: "changing-check.cjs", content: changingTest } },
      work("verify", { shell: "bash", command: "node --test changing-check.cjs" }), work("status"), work("complete"),
      work("verify", { shell: "bash", command: "node --test check.cjs" }),
      { name: "write", arguments: { path: "check.cjs", content: testFile + "// changed since test\n" } }, work("complete"),
      work("verify", { shell: "bash", command: "node --test check.cjs" }), work("complete")]);
    assert.equal(finished.status, "done", JSON.stringify(finished));
    const completed = (await status())!.run!;
    assert.equal(completed.phase, "complete"); assert.equal(completed.verification?.passed, true);
    assert.match(completed.thermosOutcome ?? "", /Thermos 未触发/);
    const history = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 180), ctx);
    const errors = history.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" && m.isError ? m.content.flatMap(c => c.type === "text" ? [c.text] : []) : []));
    const confirmed = currentVerificationEvidence(completed, completed.verification!.fingerprint, history.items);
    assert.deepEqual(confirmed.map(r => [r.command, r.toolTaskId, r.exitCode]), [["node --test check.cjs", completed.verification!.toolTaskId, 0]]);
    assert(confirmed[0].output.includes("works"));
    assert.deepEqual(currentVerificationEvidence(completed, "changed-since-check", history.items), []);
    assert(errors.some(e => /No successful workspace observation/.test(e)), JSON.stringify(errors));
    assert.equal(errors.filter(e => /Current workspace needs/.test(e)).length, 2, JSON.stringify(errors));
    assert(errors.some(e => /single test\/check|run one check/i.test(e)), JSON.stringify(errors));
    assert(errors.some(e => e.includes("executed zero tests")), JSON.stringify(errors));
    const stale = errors.find(e => e.includes('"outcome": "workspace_changed"'));
    assert(stale, JSON.stringify(errors));
    const staleReceipt = JSON.parse(stale);
    assert.deepEqual({ passed: staleReceipt.passed, exitCode: staleReceipt.exitCode, unchanged: staleReceipt.unchanged, paths: staleReceipt.changedPaths },
      { passed: false, exitCode: 0, unchanged: false, paths: ["overlap.txt"] });
    const statusReply = history.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" && !m.isError ? m.content.flatMap(c => c.type === "text" ? [c.text] : []) : []))
      .find(e => e.includes('"verification"') && e.includes('"outcome": "workspace_changed"'));
    assert(statusReply?.includes('"exitCode": 0'), JSON.stringify(statusReply));
    assert(errors.some(e => e.includes("exited successfully") && e.includes("overlap.txt") && !e.startsWith("{")));
    console.log("PASS gate before first write, absent evidence, explicit block, durable reopen, real nested shell exit, stale verification, completion");
    const readTurn = await turn("Only inspect check.cjs. Do not change project files.", "run-3", [work("start", { skill }), { name: "read", arguments: { path: "check.cjs" } },
      { name: "pstack_workflow", arguments: { action: "decision", decision: { phase: "apply", decision: "Answer", why: "Read only", evidence: "check.cjs", result: "Inspected" } } },
      work("advance", { stage: "apply", note: "Read the actual test" }), work("complete")]);
    assert.equal(readTurn.status, "done", JSON.stringify(readTurn)); assert.notEqual((await status())!.run!.run, completed.run);
    const actual = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 250), ctx);
    const observations = observedReviewFiles(actual.items, cwd, cwd);
    assert(observations.some(o => o.tool === "read" && o.path === "check.cjs"));
    const targets = await reviewTargets(cwd, [], ["Inspect check.cjs."], actual.items);
    assert.deepEqual(targets, ["check.cjs"]);
    await validateInspections(cwd, targets, [{ child: 3, observations }]);
    await assert.rejects(validateInspections(cwd, targets, [{ child: 4, observations: [] }]), /without a successful native read/);
    await assert.rejects(validateInspections(cwd, targets, [{ child: 3, observations }, { child: 4, observations: [{ path: ".mybuddy-task.json", tool: "read", entry: 46 }] }]), /Reviewer 4/);
    assert(actual.items.some(e => e.model?.some(m => m.role === "assistant" && m.content.some(p => p.type === "text" && p.text.includes("Thermos 未触发")))));
    assert(actual.items.some(e => e.model?.some(m => m.role === "toolResult" && m.isError && m.content.some(p => p.type === "text" && p.text.includes("cannot append a workspace decision log")))));
    const advance = (stage: string) => work("advance", { stage, note: "Observed outcome: " + stage });
    const verification = work("verify", { shell: "bash", command: "node --test behavior.cjs" });
    const tddRun = await turn("通过行为测试修复当前错误。", "tdd", [work("start", { skill: "tdd" }), advance("repro"), advance("red"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=0;\n" } },
      { name: "write", arguments: { path: "behavior.cjs", content: "require('node:test')('expected value',()=>require('node:assert/strict').equal(require('./value.cjs'),1));\n" } },
      verification, advance("red"), advance("implement"), advance("green"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=1;\n" } },
      verification,
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=0;\n" } },
      advance("green"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=1;\n" } },
      advance("green"), advance("regression"), work("complete")]);
    assert.equal(tddRun.status, "done", JSON.stringify(tddRun));
    const tdd = (await status())!.run!;
    assert.equal(tdd.phase, "complete"); assert.equal(tdd.red?.exitCode, 1);
    assert.equal(tdd.red?.command, tdd.verification?.command);
    assert.notEqual(tdd.verification?.fingerprint, tdd.red?.fingerprint);
    const tddHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, minEntryId: tdd.first, order: "ascending" }, 120), ctx);
    assert(tddHistory.items.some(e => (e.model ?? []).some(message => message.role === "toolResult" && message.isError &&
      message.content.some(part => part.type === "text" && part.text.includes("successful check covers a different workspace version")))),
      "the green step must reject success evidence for the previous file content");
    console.log("PASS actual failing TDD assertion, missing red/green gates, repaired product returns green on same command");
    const before = replies;
    const unfinished = await turn("空值也算进去", "run-4", []);
    assert.notEqual(unfinished.status, "done", "Unverified early yields cannot silently settle a fresh input");
    assert.equal(replies - before, 3, "two native continuations, independent of message language");
    const nested = await turn("Investigate a new change", "nested-route", [work("start", { playbook: "feature" }), work("invoke", { skill: "how" }),
      work("advance", { stage: "trace", note: "Attempt to skip nested stages" }), work("advance", { stage: "trace::how::scope", note: "Bound the investigation" }),
      work("block", { note: "Need a second investigator" })]);
    assert.equal(nested.status, "done"); assert.equal((await status())!.run!.stage, 1);
    assert.deepEqual((await status())!.run!.invoked, [{ stage: "trace", skill: "how" }]);
    const readOnly = await turn("只调查标签是怎样去重的，在聊天中解释。", "readonly-investigation", [
      work("start", { playbook: "investigation", replace: true, note: "The user selected a new read-only investigation." }),
      { name: "write", arguments: { path: "unsolicited-report.md", content: "report" } },
      work("block", { note: "Awaiting the input sample." }),
    ]);
    assert.equal(readOnly.status, "done");
    await assert.rejects(readFile(join(cwd, "unsolicited-report.md")), { code: "ENOENT" });
    await turn("继续，检查本地文件。", "merge-gate", [work("resume"), { name: "bash", arguments: { command: "git merge fixture" } },
      work("review"), work("block", { note: "Approval needed to proceed with integration." })]);
    const latest = (await status())!.run!.first;
    const mergeHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, minEntryId: latest, order: "ascending" }, 140), ctx);
    const mergeMessages = mergeHistory.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" ? m.content.flatMap(p => p.type === "text" ? [p.text] : []) : []));
    assert(mergeMessages.some(s => s.includes('"pre-merge review"')), JSON.stringify(mergeMessages).slice(-5000));
    const originalCheck = await readFile(join(cwd, "check.cjs"), "utf8");
    await turn("Test the temporary revision and restore the original check.", "restored-snapshot", [
      work("start", { skill, replace: true, note: "Verify a temporary revision before restoring the baseline." }),
      { name: "write", arguments: { path: "check.cjs", content: originalCheck + "// temporary revision\n" } },
      work("verify", { shell: "bash", command: "node --test check.cjs" }),
      { name: "write", arguments: { path: "check.cjs", content: originalCheck } },
      advance("apply"), work("complete"), work("block", { note: "A check of the restored snapshot is still required." }),
    ]);
    assert.equal((await status())!.run!.verification?.passed, true, "the old revision passed its test");
    assert.equal((await status())!.run!.phase, "blocked", "restoring the baseline invalidates the previous success");
    enabled = false;
    assert.equal((await turn("Question", "run-5", [])).status, "done");
    console.log("PASS actual read receipt, independent next workflow, bounded native onYield and disabled task");
  } finally { await runtime.close(); }
  const originalEnv = { HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE, PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR };
  try {
    const home=join(root,"author-profile"), workspace=join(home,"work");
    await mkdir(workspace,{recursive:true});
    process.env.HOME=process.env.USERPROFILE=home;process.env.PI_CODING_AGENT_DIR=join(home,".mybuddy");
    const {getSkillsDir}=await import("../src/main/paths");
    const installs=getSkillsDir();assert.equal(installs,join(home,".mybuddy","plugins","skills"));
    for(const id of ["owned","unrelated"]) {
      await mkdir(join(installs,id));await writeFile(join(installs,id,"SKILL.md"),"unchanged\n".repeat(200));
    }
    const selected=join(installs,"owned","SKILL.md"),other=join(installs,"unrelated","SKILL.md");
    const cfg=normalizePstackSettings({});cfg.thermos.fileLines=200;
    const app=createPstackWorkflow({taskId:"assess-improve",cwd:workspace,settings:()=>cfg,active:()=>true});
    const assess=defineTool({name:"skill_authoring_assess",description:"Fixture: select the existing skill for improvement",replay:"safe",parameters:Type.Object({}),
      execute:async()=>({output:[{type:"text",text:"Assessed installed skill."}],details:{decision:"improve-existing",targetSkillId:"owned"}})});
    const openAuth=()=>DurableBotRuntime.open({directory:join(home,"store"),cwd:workspace,models,model:{provider:model.provider,modelId:model.id},toolMode:"native",
      instructions:()=>"Fixture",tools:[...app.tools,assess],foregroundHooks:app,onSnapshot:()=>{}});
    let auth=await openAuth();
    try {
      queue.push(work("start",{skill:"principle-prove-it-works"}),{name:"skill_authoring_assess",arguments:{}},work("block",{note:"Wait for the next edit."}));
      await(await auth.submit("Improve the selected installed skill.", "initial")).wait(ctx); await auth.close();
      await writeFile(selected,"unchanged\n".repeat(200)+"one new rule\n");
      await writeFile(other,"unrelated\n".repeat(450));
      auth=await openAuth();
      queue.push(work("resume"),work("review"),work("block",{note:"Ready for independent review."}));
      await(await auth.submit("Continue. An unrelated path is " + other, "continuation")).wait(ctx);
      const entries=await auth.harness.commit(tx=>tx.scanEntries({conversationId:auth.conversation.id,order:"ascending"},160),ctx);
      const results=entries.items.flatMap(e=>e.model?.flatMap(m=>m.role==="toolResult" && m.toolName==="pstack_workflow"?m.content.flatMap(p=>p.type==="text"?[p.text]:[]):[])??[]);
      const evidence=results.map(t=>{try{return JSON.parse(t)}catch{return null}}).find(x=>x?.authoredSkills);
      assert(evidence,JSON.stringify(results).slice(-2000));assert.deepEqual(evidence.paths,[selected]);assert.equal(evidence.changedLines,1);
      assert.equal(evidence.largestCrossing,201);assert.deepEqual(evidence.reasons,["file crossed 200 lines"]);
      console.log("PASS assessed installed skill uses its pre-edit fingerprint after durable reopen; unrelated files stay out of review");
    } finally {await auth.close();}
  } finally { for (const [key,value] of Object.entries(originalEnv)) if(value===undefined) delete process.env[key]; else process.env[key]=value; }
} finally { await rm(root, { recursive: true, force: true }); }
await testInFlightOwners();
