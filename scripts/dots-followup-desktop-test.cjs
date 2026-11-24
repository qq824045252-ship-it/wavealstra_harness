const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");

const liveModel = process.argv.includes("--followup-live");
const spaceId = "dots-followup-desktop-space";
const initial = "在「界面验收」空间交办界面核验。";
const liveInitial = "在「界面验收」空间委派一个普通任务，确认 MyBuddy 预览图标的验收口径。口径是：收到截图后查看图里有没有一个完整可辨的图标，并报告可见颜色和形状。第一轮只确认口径并交付结论，目前不用截图。后续补图都沿用这个口径。不改文件，不执行命令。";
const firstWorkerInput = "ACCEPTANCE_FIRST_PASS";
const inventedWorkerInput = "MODEL_MUST_NOT_ADD_THIS_REQUIREMENT";
const firstDelivery = "界面核验第一轮已完成。";
const nextDelivery = "已在原任务核对补发截图。";
const followup = "还是没看到效果啊，你追问下";
const supplement = "乱七八糟的";
const image = liveModel ? readFileSync(join(__dirname, "../build/icon-512.png")).toString("base64")
  : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jflsAAAAASUVORK5CYII=";
const attachmentName = "followup-proof.png";
const releaseFrontRun = Promise.withResolvers();
let originalTaskId;
let originalOperationId;
let heldFrontRequest = false;

const tool = (arguments_) => ({ tool: { name: "dots_action", arguments: arguments_ } });
const taskResult = (result) => JSON.stringify({ dotsState: "complete", result });
const input = request => request.messages.findLast(message => message.role === "user")?.content;
const prompt = request => JSON.stringify(input(request) ?? "");
const continueOriginal = () => tool({ action: "follow_up", targetTaskId: originalTaskId,
  operationId: originalOperationId, assignmentQuote: supplement, text: inventedWorkerInput });
const isForeground = request => request.tools?.some(tool => tool.function.name === "dots_action");

async function gateLiveResponse(request) {
  if (heldFrontRequest || !isForeground(request) || !prompt(request).includes(followup)) return;
  heldFrontRequest = true;
  await releaseFrontRun.promise;
}

async function fixtureModel(request) {
  const current = prompt(request);
  const last = request.messages.at(-1);
  if (!isForeground(request)) {
    if (current.includes(followup)) return taskResult(nextDelivery);
    if (current.includes(firstWorkerInput)) return taskResult(firstDelivery);
    return "完成。";
  }
  if (current.includes(supplement)) {
    if (last.role === "tool") {
      const lookup = JSON.parse(last.content);
      if (lookup.id === originalTaskId && !lookup.receipt) {
        assert.deepEqual(lookup.followUpCall, { action: "follow_up", targetTaskId: originalTaskId, operationId: originalOperationId });
        return continueOriginal();
      }
      return "原任务已接到补图。";
    }
    assert(JSON.stringify(request.messages).includes(followup), "the Dots model must see the earlier instruction alongside the supplement");
    return tool({ action: "task", targetTaskId: originalTaskId });
  }
  if (current.includes(followup)) {
    if (last.role === "tool") return "已收到。";
    if (!heldFrontRequest) {
      heldFrontRequest = true;
      await releaseFrontRun.promise;
    }
    return continueOriginal();
  }
  if (current.includes(initial) && last.role !== "tool") {
    return tool({ action: "delegate", spaceId, name: "界面核验", text: firstWorkerInput });
  }
  return "已安排。";
}

run(async ({ evaluate, until, home, requests, report }) => {
  const api = (name, ...args) => evaluate(`window.api.${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  const modelFile = join(home, ".mybuddy", "models.json");
  const config = JSON.parse(readFileSync(modelFile, "utf8"));
  if (liveModel) assert(config.providers.fixture.models[0].input.includes("image"), "the live model must accept images");
  else {
    config.providers.fixture.models[0].input.push("image");
    writeFileSync(modelFile, JSON.stringify(config));
    await api("agent.reloadModels");
  }

  const workspace = join(home, "scoped-workspace");
  const uploads = join(home, ".mybuddy", "uploads");
  mkdirSync(workspace);
  mkdirSync(uploads, { recursive: true });
  const imagePath = join(uploads, attachmentName);
  writeFileSync(imagePath, Buffer.from(image, "base64"));
  await api("db.upsertSpace", { id: spaceId, name: "界面验收", path: workspace });
  const { id: taskId } = await api("dots.open");
  const send = async (userMessageId, text, extra = {}) => {
    const result = await api("agent.prompt", {
      taskId, userMessageId, assistantMessageId: `${userMessageId}-answer`, text, ...extra,
    });
    assert(result.receipt, JSON.stringify(result));
    return result.receipt;
  };
  const jobs = (...sourceIds) => api("dots.list", sourceIds);
  const history = () => api("agent.loadTaskHistory", taskId);
  const deliveries = async (text) => (await history()).messages.filter(message => message.dotsDelivery?.kind === "conclusion" && message.text === text);
  const deliveryFor = async operationId => (await history()).messages.filter(message => message.dotsDelivery?.kind === "conclusion"
    && message.dotsDelivery.operationId === operationId);

  const seedId = "seed-interface-task";
  await send(seedId, liveModel ? liveInitial : initial);
  await until(async () => {
    if (!liveModel) return (await deliveries(firstDelivery)).length === 1;
    const [job] = await jobs(seedId);
    return job && (await deliveryFor(job.id)).length === 1;
  }, "original Dots task delivered");
  const [original] = await jobs(seedId);
  assert(original?.taskId, "original Dots operation ID and task ID should exist");
  originalTaskId = original.taskId;
  originalOperationId = original.id;

  const followupId = "request-original-follow-up";
  const supplementId = "attach-screenshot-during-follow-up";
  const first = await send(followupId, followup);
  let second;
  try {
    await until(() => heldFrontRequest, "first follow-up reaches the model before the attachment");
    second = await send(supplementId, supplement, {
      streamingBehavior: "steer", attachments: [{ name: attachmentName, path: imagePath }],
    });
  } finally {
    releaseFrontRun.resolve();
  }
  assert.equal((await api("agent.waitForSubmission", first)).receipt?.status, "done");
  assert.equal((await api("agent.waitForSubmission", second)).receipt?.status, "done");
  await until(async () => (await jobs(followupId, supplementId)).length === 1 || requests.some(request =>
    prompt(request).includes(supplement) && request.messages.at(-1)?.role === "tool"), "merged follow-up receives native tool outcome");
  const continuations = await jobs(followupId, supplementId);
  report.followupReplies = (await history()).messages.slice(-6).map(({ role, text }) => ({ role, text }));
  assert.equal(continuations.length, 1, "one native follow-up operation across both user inputs");
  const [continuation] = continuations;
  assert.equal(continuation.taskId, original.taskId, "reuse the existing task");
  assert.equal(continuation.sourceMessageId, followupId, "retain the instruction's origin when the image arrives separately");
  assert.notEqual(continuation.id, original.id, "a new operation must preserve the old receipt");
  const followupDeliveries = async () => liveModel ? (await history()).messages.filter(message =>
    message.dotsDelivery?.operationId === continuation.id && ["conclusion", "question"].includes(message.dotsDelivery.kind)) : deliveries(nextDelivery);
  await until(async () => (await followupDeliveries()).length > 0, "one follow-up delivery in the original Dots conversation");
  const workerRequests = requests.filter(request => !isForeground(request) && prompt(request).includes(followup));
  if (!liveModel) assert.equal(workerRequests.length, 1, "the worker should execute the follow-up once");
  const workerRequest = workerRequests.find(request => Array.isArray(input(request)) && input(request).some(part => part.type === "image_url"));
  assert(workerRequest, "the worker model must receive the attached image");
  const images = input(workerRequest).filter(part => part.type === "image_url");
  assert.deepEqual(images.map(part => part.image_url.url), [`data:image/png;base64,${image}`]);
  assert.match(prompt(workerRequest), new RegExp(supplement));
  assert.doesNotMatch(prompt(workerRequest), new RegExp(inventedWorkerInput));
  const followupResults = await followupDeliveries();
  report.actualControlChecks.push({ originalTaskId, operationId: continuation.id, workerRequests: workerRequests.length,
    attachmentCount: images.length, originalDeliveryCount: (await deliveryFor(original.id)).length,
    followupDeliveryCount: followupResults.length, followupDeliveryKind: followupResults[0]?.dotsDelivery.kind });
  assert.equal(followupResults.length, 1);
  assert.equal(followupResults[0].dotsDelivery.kind, "conclusion", followupResults[0].text);
}, { name: liveModel ? "dots-followup-live" : "dots-followup-desktop", liveModel, ...(liveModel ? { gateLiveResponse } : { fixtureModel }),
  watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 40000 });
