const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");

const liveModel = process.argv.includes("--task-routing-live");
const spaceId = "task-routing-original-space";
const otherSpaceId = "task-routing-other-space";
const title = "华东批次验收K41";
const seed = `请在「华东验收」空间委派一个普通任务，任务名称设成「${title}」。只读取 初次证据.txt，回报登记总数。`;
const publish = "用 read 读取 最新记录.txt，回报文件里的追踪编号和缺件。只读取，不修改文件。";
const diagnose = `「华东验收」空间里的「${title}」到底缺什么？追踪编号是多少？只查询，不要重新执行。`;
const followUp = `请追问原任务「${title}」，在「华东验收」空间，读取 复核回执.txt，告诉我单号最后两位。不改文件。`;
const latestMarker = "QC-5817";
const missingDocument = "验收单第 3 页";
const resultTail = "73";
const front = request => request.tools?.some(tool => tool.function.name === "dots_action");
const currentText = request => JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "");
const tool = (name, args) => ({ tool: { name, arguments: args } });
const action = args => tool("dots_action", args);
const conclusion = text => tool("dots_task_end", { action: "complete", result: text, deliveryText: text });

function fixtureModel(request) {
  const text = currentText(request);
  const last = request.messages.at(-1);
  if (!front(request)) {
    if (text.includes("复核回执.txt")) return last.role === "tool" ? conclusion(`复核回执单号最后两位是 ${resultTail}。`)
      : tool("read", { path: "复核回执.txt" });
    if (text.includes(publish)) return last.role === "tool" ? `追踪编号 ${latestMarker}，缺${missingDocument}。` : tool("read", { path: "最新记录.txt" });
    if (text.includes(seed)) return last.role === "tool" ? conclusion("登记总数 18 件。") : tool("read", { path: "初次证据.txt" });
    throw new Error("Unexpected ordinary task request");
  }
  if (text.includes(seed)) return last.role === "tool" ? "已交办。" : action({ action: "delegate", spaceId, name: title, text: seed });
  if (text.includes(diagnose) || text.includes(followUp)) {
    if (last.role !== "tool") return text.includes(followUp)
      ? action({ action: "read_file", spaceId, path: "复核回执.txt", allowHandoff: false })
      : action({ action: "find_tasks", query: title });
    const result = JSON.parse(last.content);
    if (result.receipt) return "已在原任务追问。";
    if (result.foreground === "follow_up_required") return action({ action: "find_tasks", query: title });
    const inspection = result.inspection;
    assert(inspection?.executionDiagnostics, JSON.stringify(result));
    if (text.includes(diagnose)) {
      assert(JSON.stringify(inspection.messages).includes(latestMarker));
      return `追踪编号 ${latestMarker}，原任务缺${missingDocument}。`;
    }
    assert(inspection.latestOperationId, JSON.stringify(inspection));
    return action({ action: "follow_up", targetTaskId: inspection.id, operationId: inspection.latestOperationId, spaceId });
  }
  throw new Error("Unexpected Dots request");
}

function actionTrace(requests) {
  const trace = new Map();
  for (const request of requests.filter(front)) {
    const messages = request.messages.slice(request.messages.findLastIndex(message => message.role === "user") + 1);
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) if (call.function.name === "dots_action" && !trace.has(call.id)) {
        trace.set(call.id, { args: JSON.parse(call.function.arguments) });
      }
      if (message.role === "tool" && trace.has(message.tool_call_id)) {
        trace.get(message.tool_call_id).output = message.content;
      }
    }
  }
  return [...trace.values()];
}

function inspectionFor(trace, taskId) {
  for (const call of trace) {
    if (!call.output || !["find_tasks", "task"].includes(call.args.action)) continue;
    let output;
    try { output = JSON.parse(call.output); } catch { continue; }
    const result = call.args.action === "find_tasks" ? output.inspection : output;
    if (result?.id === taskId && result.executionDiagnostics) return result;
  }
}

run(async ({ evaluate, until, home, requests, report }) => {
  const api = (name, ...args) => evaluate(`window.api.${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  const workspace = join(home, "original"), other = join(home, "other");
  mkdirSync(workspace);
  mkdirSync(other);
  writeFileSync(join(workspace, "初次证据.txt"), "登记总数 18 件。\n");
  writeFileSync(join(workspace, "最新记录.txt"), `追踪编号 ${latestMarker}\n缺件 ${missingDocument}\n`);
  writeFileSync(join(workspace, "复核回执.txt"), `复核回执号 WX-490${resultTail}\n`);
  await api("db.upsertSpace", { id: spaceId, name: "华东验收", path: workspace });
  await api("db.upsertSpace", { id: otherSpaceId, name: "同名其他空间", path: other });
  await api("db.upsertTask", { id: "task-routing-decoy", title, spaceId: otherSpaceId, welcomeMode: "general", updatedAt: Date.now() });
  const { id: dotsId } = await api("dots.open");
  const send = async (taskId, id, text) => {
    const result = await api("agent.prompt", { taskId, userMessageId: id, assistantMessageId: `${id}-answer`, text });
    assert(result.receipt, JSON.stringify(result));
    const settled = await api("agent.waitForSubmission", result.receipt);
    assert.equal(settled.receipt?.status, "done", JSON.stringify(settled));
  };
  const jobs = id => api("dots.list", [id]);
  const history = id => api("agent.loadTaskHistory", id);
  const delivered = async id => (await history(dotsId)).messages.filter(message =>
    message.dotsDelivery?.sourceMessageId === id && ["conclusion", "question"].includes(message.dotsDelivery.kind));

  await send(dotsId, "routing-seed", seed);
  await until(async () => (await delivered("routing-seed")).length > 0, "original Dots task delivers");
  const [original] = await jobs("routing-seed");
  assert.equal((await delivered("routing-seed"))[0].dotsDelivery.kind, "conclusion");
  const originalTask = (await api("db.listTasks")).find(task => task.id === original.taskId);
  assert(originalTask, "the original native task is listed");
  if (originalTask.title !== title) await api("db.upsertTask", { ...originalTask, title });
  await send(original.taskId, "routing-fresh-native-evidence", publish);
  assert((await history(original.taskId)).messages.some(message => message.role === "assistant" && message.text.includes(latestMarker)));

  await evaluate(`document.querySelector('button[aria-label="任务看板"]').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('main[aria-label="任务看板"]'))`), "human task board opens");
  const board = await api("db.taskBoardPage", { view: "all", scope: spaceId });
  assert(board.rows.some(row => row.id === original.taskId));

  await api("dots.newConversation");
  const diagnosisStart = requests.length;
  await send(dotsId, "routing-diagnose", diagnose);
  const diagnosisTrace = actionTrace(requests.slice(diagnosisStart));
  const matchedName = diagnosisTrace.some(call => {
    if (call.args.action !== "find_tasks" || !call.args.query || !call.output) return false;
    try { return JSON.parse(call.output).tasks?.some(task => task.id === original.taskId && task.title === title); }
    catch { return false; }
  });
  assert(matchedName, JSON.stringify(diagnosisTrace.map(call => call.args)));
  const inspected = inspectionFor(diagnosisTrace, original.taskId);
  assert(inspected, "diagnosis has the original task's native execution records");
  assert(JSON.stringify(inspected).includes(latestMarker), "the performed lookup reads newly added evidence");
  assert.equal((await jobs("routing-diagnose")).length, 0, "diagnosis is read-only");
  const diagnosisAnswer = (await history(dotsId)).messages.findLast(message => message.role === "assistant" && !message.dotsDelivery)?.text;
  assert.match(diagnosisAnswer, new RegExp(latestMarker));
  assert.match(diagnosisAnswer, /验收单.{0,8}第\s*3\s*页|第\s*3\s*页.{0,8}验收单/);
  report.actualControlChecks.push({ scenario: "named-task-diagnosis", taskId: original.taskId,
    actions: diagnosisTrace.map(call => call.args.action), diagnosisAnswer, humanBoard: true });

  await api("dots.newConversation");
  const continuationStart = requests.length;
  await send(dotsId, "routing-follow-up", followUp);
  await until(async () => (await delivered("routing-follow-up")).length > 0, "the named follow-up delivers to its original Dots chat");
  const continuationTrace = actionTrace(requests.slice(continuationStart));
  const followIndex = continuationTrace.findIndex(call => call.args.action === "follow_up");
  assert(followIndex > 0 && inspectionFor(continuationTrace.slice(0, followIndex), original.taskId),
    "native task detail precedes original task follow-up");
  const continuations = await jobs("routing-follow-up");
  assert.deepEqual(continuations.map(job => job.taskId), [original.taskId]);
  const results = await delivered("routing-follow-up");
  assert.equal(results.length, 1);
  assert.equal(results[0].dotsDelivery.kind, "conclusion", results[0].text);
  assert.match(results[0].text, new RegExp(resultTail));
  assert(requests.slice(continuationStart).some(request => !front(request) && currentText(request).includes("复核回执.txt")
    && request.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(`WX-490${resultTail}`))));
  for (const request of requests.filter(front)) {
    const specification = request.tools.find(tool => tool.function.name === "dots_action").function;
    const schema = JSON.stringify(specification.parameters.properties.action);
    assert(schema.includes('"find_tasks"') && !schema.includes('"board"'), schema);
  }
  report.actualControlChecks.push({ scenario: "named-task-follow-up", taskId: original.taskId, originalOperationId: original.id,
    continuationOperationId: continuations[0].id, actions: continuationTrace.map(call => call.args.action), delivery: results[0].text });
}, {
  name: liveModel ? "dots-task-routing-live" : "dots-task-routing-desktop", liveModel, ...(liveModel ? {} : { fixtureModel }),
  watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 120000,
});
