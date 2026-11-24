const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");

const live = process.argv.includes("--responsibility-live");
const spaceId = "dots-responsibility-space";
const partialInput = "在「交付验收」空间委派一个普通任务，根据 units.txt 产出并交付「alpha.txt」和「beta.txt」。alpha.txt 只写第一行数字，beta.txt 只写两行合计。两份文件都要回到本对话。";
const partialAssignment = "根据 units.txt 产出并交付「alpha.txt」";
const recoveryInput = "在「交付验收」空间交办一次只读核对，读取 units.txt 并把两行合计回到本对话。";
const capabilityInput = "委派缺工具测试，必须使用不存在的工具 demo_unavailable_tool，再决定是否受理。";
const commitInput = "在「提交验收」空间委派一个普通任务，修改 note.txt 并做一次本地提交，把结果回到本对话。不要重跑已通过的同版本检查。";
const incompleteDelivery = "已完成全部交付。";
const finalDelivery = "两份文件已交付。";
const recoveredDelivery = "两行合计是 42。";
let completionRound = 0;
let recoveryRound = 0;
let originalHead;

const tool = (name, args) => ({ tool: { name, arguments: args } });
const done = (result, deliveryText = result) => JSON.stringify({ dotsState: "complete", result, delivery: { text: deliveryText } });
const lastUser = request => JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const finish = (deliveryText, proof = {}) => tool("dots_task_end", { action: "complete", result: deliveryText, deliveryText, ...proof });

function fixtureModel(request) {
  const text = lastUser(request);
  const foreground = request.tools?.some(entry => entry.function.name === "dots_action");
  if (foreground) {
    const result = request.messages.at(-1);
    if (text.includes(capabilityInput)) {
      if (result?.role === "tool") return "无法受理，缺少 demo_unavailable_tool。";
      return tool("dots_action", { action: "delegate", spaceId, text: capabilityInput,
        requiredCapabilities: [{ kind: "tool", id: "demo_unavailable_tool" }] });
    }
    if (result?.role === "tool") return "已交办。";
    if (text.includes(commitInput)) return tool("dots_action", { action: "delegate", spaceId: "dots-commit-space", text: commitInput });
    if (text.includes(partialInput)) return tool("dots_action", { action: "delegate", spaceId, text: partialAssignment,
      assignmentQuote: partialAssignment });
    if (text.includes(recoveryInput)) return tool("dots_action", { action: "delegate", spaceId, text: recoveryInput,
      requiredCapabilities: [{ kind: "tool", id: "read" }] });
    return "收到。";
  }
  if (text.includes(partialAssignment)) {
    switch (++completionRound) {
      case 1: return tool("write", { path: "alpha.txt", content: "18\n" });
      case 2: return tool("register_artifact", { path: "alpha.txt" });
      case 3: return done(incompleteDelivery);
      case 4:
        assert(text.includes("beta.txt 只写两行合计"), "corrective instructions must include the original omitted requirement");
        return tool("write", { path: "beta.txt", content: "42\n" });
      default: return finish(finalDelivery);
    }
  }
  if (text.includes(recoveryInput)) {
    recoveryRound++;
    if (recoveryRound === 1) return tool("read", { path: "units.txt" });
    if (!/继续原任务|补回本轮|本次恢复|原交办及限制/.test(text))
      return { fixtureFault: "model-error", status: 503, message: "temporary service unavailable" };
    return done(recoveredDelivery);
  }
  if (text.includes(commitInput)) {
    const messages = request.messages.slice(request.messages.findLastIndex(message => message.role === "user") + 1);
    const toolReplies = messages.filter(message => message.role === "tool");
    if (toolReplies.length === 0) return finish("错误旧提交。", { commitSha: originalHead });
    assert.match(toolReplies[0].content, /当前提交无法证明任务开始后新增了提交/);
    if (toolReplies.length === 1) return tool("write", { path: "note.txt", content: "new\n" });
    if (toolReplies.length === 2) return tool("bash", { command: "git add note.txt && git commit -m new-note && git rev-parse HEAD" });
    const commitSha = toolReplies.at(-1).content.match(/\b[0-9a-f]{40}\b/)?.[0];
    assert(commitSha, "the worker must make a real new commit");
    return finish("已完成新提交 " + commitSha, { commitSha });
  }
  return "已收到。";
}

run(async ({ evaluate, until, home, report, requests }) => {
  const api = (name, ...args) => evaluate("window.api." + name + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const workspace = join(home, "responsibility-workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "units.txt"), "18\n24\n");
  await api("db.upsertSpace", { id: spaceId, name: "交付验收", path: workspace });
  const { id: dotsId } = await api("dots.open");
  const send = async (id, text) => {
    const response = await api("agent.prompt", { taskId: dotsId, userMessageId: id, assistantMessageId: id + "-reply", text });
    assert(response.receipt, JSON.stringify(response));
  };
  const jobs = id => api("dots.list", [id]);
  const replies = async id => (await api("agent.loadTaskHistory", dotsId)).messages.filter(message =>
    message.dotsDelivery?.sourceMessageId === id && ["conclusion", "question"].includes(message.dotsDelivery.kind));
  const completionId = "desktop-completion-responsibility";
  await send(completionId, partialInput + (live
    ? " 所有操作仅限指定工作空间。需要给用户打开的文件请登记产物。直接完成原交办并交付。"
    : ""));
  await until(async () => (await replies(completionId)).length > 0, "both required deliverables reach the Dots origin");
  const outputs = await replies(completionId);
  assert.equal(outputs.length, 1, "only the actual result should reach the original conversation");
  assert.equal(outputs[0].dotsDelivery.kind, "conclusion", outputs[0].text);
  const artifacts = outputs[0].dotsDelivery.artifacts;
  assert.deepEqual(artifacts.map(item => item.name).sort(), ["alpha.txt", "beta.txt"]);
  const expected = { "alpha.txt": "18", "beta.txt": "42" };
  for (const artifact of artifacts) assert.equal(readFileSync(artifact.saved.snapshotPath, "utf8").trim(), expected[artifact.name]);
  const completionJobs = await jobs(completionId);
  assert.equal(new Set(completionJobs.map(job => job.taskId)).size, 1);
  if (!live) {
    assert.equal(outputs[0].text, finalDelivery);
    assert.equal(completionJobs.length, 2, "missing work resumes in the original task");
    assert.equal(completionRound, 5);
  }
  report.actualControlChecks.push({ scenario: "explicit-artifacts", jobs: completionJobs.length, delivery: outputs[0].text,
    actualContents: Object.fromEntries(artifacts.map(artifact => [artifact.name, readFileSync(artifact.saved.snapshotPath, "utf8").trim()])) });

  if (live) return;
  const recoveryId = "desktop-read-only-recovery";
  await send(recoveryId, recoveryInput);
  await until(async () => (await replies(recoveryId)).length > 0, "temporary failure after read recovers in the same task");
  const recovered = await replies(recoveryId);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].dotsDelivery.kind, "conclusion", recovered[0].text);
  assert.equal(recovered[0].text, recoveredDelivery);
  const recoveryJobs = await jobs(recoveryId);
  assert.equal(recoveryJobs.length, 2);
  assert.equal(new Set(recoveryJobs.map(job => job.taskId)).size, 1);
  assert(requests.some(request => lastUser(request).includes(recoveryInput) &&
    request.messages.some(message => message.role === "tool" && /18[\s\S]*24/.test(message.content))));
  report.actualControlChecks.push({ scenario: "read-then-transient-failure", workerRequests: recoveryRound, downstreamJobs: recoveryJobs.length,
    originalDelivery: recovered[0].text });

  const capabilityId = "desktop-missing-capability";
  await send(capabilityId, capabilityInput);
  await until(async () => (await api("agent.loadTaskHistory", dotsId)).messages.some(message =>
    message.role === "assistant" && message.text === "无法受理，缺少 demo_unavailable_tool。"), "missing capability is explained in the Dots conversation");
  const rejection = requests.filter(request => lastUser(request).includes(capabilityInput)).flatMap(request => request.messages)
    .find(message => message.role === "tool" && /缺少所需工具「demo_unavailable_tool」/.test(message.content));
  assert(rejection, "desktop should return the specific capability error via dots_action");
  assert((await jobs(capabilityId)).every(job => job.status === "failed"), "a missing capability must not leave a pending worker");
  report.actualControlChecks.push({ scenario: "missing-capability", originalReply: "无法受理，缺少 demo_unavailable_tool。" });

  const repo = join(home, "commit-workspace");
  mkdirSync(repo);
  writeFileSync(join(repo, "note.txt"), "old\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "MyBuddy Test");
  git(repo, "config", "user.email", "mybuddy-test@example.invalid");
  git(repo, "add", "note.txt");
  git(repo, "commit", "-m", "initial note");
  originalHead = git(repo, "rev-parse", "HEAD");
  await api("db.upsertSpace", { id: "dots-commit-space", name: "提交验收", path: repo });
  const commitId = "desktop-reject-existing-commit";
  await send(commitId, commitInput);
  await until(async () => (await replies(commitId)).length > 0, "a real new commit reaches the original conversation");
  const commitReplies = await replies(commitId);
  const commit = git(repo, "rev-parse", "HEAD");
  assert.notEqual(commit, originalHead);
  assert.equal(git(repo, "show", "HEAD:note.txt"), "new");
  assert.deepEqual(commitReplies.map(reply => [reply.dotsDelivery.kind, reply.text]), [["conclusion", "已完成新提交 " + commit]]);
  report.actualControlChecks.push({ scenario: "old-commit-rejected", newCommit: commit });
}, {
  name: live ? "dots-responsibility-live" : "dots-responsibility-desktop",
  liveModel: live, ...(live ? {} : { fixtureModel }), watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 40000,
});
