const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");

const toolName = "dots_desktop_preview";
const spaceId = "dots-preview-desktop-space";
const liveModel = process.argv.includes("--desktop-preview-live");
const requestedBranch = process.argv.slice(2).find(arg => !arg.startsWith("--"));
const root = resolve(__dirname, "..");
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const git = (cwd, ...args) => execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
  encoding: "utf8", timeout: 10000, windowsHide: true,
}).trim();

function selectCheckout() {
  const candidates = git(root, "worktree", "list", "--porcelain", "-z").split("\0\0").flatMap(row => {
    const fields = row.split("\0");
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
    const directory = fields.find(field => field.startsWith("worktree "))?.slice("worktree ".length);
    if (!directory || !branch || requestedBranch && branch !== requestedBranch) return [];
    if (!existsSync(join(directory, "package.json")) || !existsSync(join(directory, "electron.vite.config.ts")) ||
      !existsSync(join(directory, "node_modules", "electron-vite", "bin", "electron-vite.js"))) return [];
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.name !== "wavealstra_harness" || manifest.main !== "./out/main/index.js") return [];
    const checkout = realpathSync(directory);
    return [{ branch, checkout, dirty: Boolean(git(checkout, "status", "--porcelain")) }];
  });
  const selected = candidates.find(item => !item.dirty && item.branch === "dots/impl-integration") ??
    candidates.find(item => !item.dirty) ?? candidates[0];
  assert(selected, requestedBranch ? `The registered worktree for ${requestedBranch} needs MyBuddy development dependencies` :
    "A registered MyBuddy worktree with existing development dependencies is needed");
  return selected;
}

function readToolResults(home, taskId) {
  const key = createHash("sha256").update(taskId).digest("hex");
  const file = join(home, ".mybuddy", "durable", key, "durable.sqlite");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    return db.prepare("SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'pi.tool-result' ORDER BY commit_seq").all()
      .flatMap(row => JSON.parse(row.record).model ?? [])
      .filter(message => message.toolName === toolName);
  } finally { db.close(); }
}

function fixtureModel(request) {
  const last = request.messages.at(-1);
  if (last.role === "tool") return "已收到预览工具回执。";
  assert(request.tools?.some(tool => tool.function.name === toolName), "desktop preview tool is exposed to Dots");
  return { tool: { name: toolName, arguments: { spaceId, worktree: branch } } };
}

const { branch, checkout, dirty } = selectCheckout();
const commit = git(checkout, "rev-parse", "HEAD");

run(async ({ evaluate, home, out, report, requests, getOwnedElectronPids }) => {
  const api = (name, ...args) => evaluate(`window.api.${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  await api("db.upsertSpace", { id: spaceId, name: "MyBuddy 验收", path: liveModel ? checkout : root });
  const { id: taskId } = await api("dots.open");
  const ordinaryTasks = async () => (await api("db.listTasks")).filter(task => task.id !== taskId).map(task => task.id).sort();
  const tasksBefore = liveModel ? await ordinaryTasks() : [];
  const ask = async (id, text) => {
    const result = await api("agent.prompt", { taskId, userMessageId: id, assistantMessageId: `${id}-answer`, text });
    assert(result.receipt, JSON.stringify(result));
    assert.equal((await api("agent.waitForSubmission", result.receipt)).receipt?.status, "done");
    const tools = readToolResults(home, taskId);
    assert(tools.length, "Durable settled the tool request");
    return tools.at(-1);
  };

  if (!liveModel) {
    const negated = await ask("preview-refused", "先不要启动 MyBuddy 工作树预览，只讨论。");
    const quoted = await ask("preview-example-only", "解释“打开 MyBuddy 工作树预览”是什么意思。");
    for (const refused of [negated, quoted]) {
      assert.equal(refused.isError, true, "a denied or quoted command may not launch a dev instance");
      assert.match(refused.content[0].text, /没有打开或查看桌面预览的用户指令/);
    }
    assert.equal((await api("artifactDomain.list", { taskId })).artifacts.length, 0, "rejected previews registered no screenshots");
  }

  const startedAt = Date.now();
  const prompt = liveModel
    ? `在「MyBuddy 验收」空间打开 ${branch} 工作树的 MyBuddy 预览。帮我实际看一下 Dots 窗口，告诉我提交号并附上截图。不要委派，不改代码。`
    : `帮我打开 MyBuddy 的 ${branch} 工作树预览并截图。`;
  const result = await ask("preview-launch", prompt);
  assert(!result.isError, JSON.stringify(result, null, 2));
  const receipt = result.details;
  assert(receipt?.artifactId, "the tool returns a registered screenshot artifact");
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.branch, branch);
  assert.equal(realpathSync(receipt.checkout), checkout);
  assert.equal(receipt.dirty, dirty);
  assert(receipt.capturedAt >= startedAt, "the screenshot must be captured after the request");
  assert.match(receipt.title, /MyBuddy/i);
  const { artifacts } = await api("artifactDomain.list", { taskId });
  assert(artifacts.some(item => item.id === receipt.artifactId && item.mimeType === "image/png"), "Dots owns the image artifact");
  const screenshot = readFileSync(receipt.imagePaths[0]);
  assert(screenshot.subarray(0, 8).equals(pngSignature));
  assert(screenshot.readUInt32BE(16) >= 300 && screenshot.readUInt32BE(20) >= 300, "preview is a real window-size screenshot");
  assert.match(receipt.id, /^mybuddy-dots-preview-/);
  const previewHome = join(realpathSync(tmpdir()), receipt.id);
  assert.notEqual(previewHome, home);
  assert(existsSync(join(previewHome, ".mybuddy", "app.db")), "the preview opened a separate MyBuddy database");
  assert(existsSync(join(previewHome, "user-data")), "the preview opened a separate Chromium profile");
  writeFileSync(join(out, "preview-window.png"), screenshot);
  let imageRequest;
  if (liveModel) {
    assert.equal(readToolResults(home, taskId).length, 1, "the real model opens the worktree exactly once");
    assert.deepEqual(await ordinaryTasks(), tasksBefore, "preview should not create an ordinary background task");
    const expectedImage = `data:image/png;base64,${screenshot.toString("base64")}`;
    imageRequest = requests.find(request => request.messages.some(message => Array.isArray(message.content) &&
      message.content.some(part => part.type === "image_url" && part.image_url.url === expectedImage)));
    assert(imageRequest, "the real model request after the tool must contain the exact screenshot bytes");
  }
  report.actualControlChecks.push({ checkout, branch, commit, dirty, previewHome, artifactId: receipt.artifactId,
    hostPids: getOwnedElectronPids(), ...(liveModel ? { actualPreviewCalls: 1, newOrdinaryTasks: 0,
      screenshotModel: imageRequest.model, screenshotBytes: screenshot.length } : { deniedRequests: 2 }),
    captureSize: [screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)] });
}, { name: liveModel ? "dots-preview-desktop-live" : "dots-preview-desktop", liveModel,
  ...(liveModel ? {} : { fixtureModel }), watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false },
    ...(liveModel ? { dotsSettings: { workspaceReading: false } } : {}) }, rpcTimeoutMs: 210000 });
