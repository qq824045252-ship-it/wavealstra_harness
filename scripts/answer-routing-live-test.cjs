const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");

run(async ({ evaluate, until, report, home, requests, restart }) => {
  const workspace = path.join(home, "周报验收资料");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "release.md"), "交付记录。蓝桥模块 RG-174 已提测，尚未上线。青禾模块 RG-285 已上线。");
  const spaceId = "routing-fixture";
  const fixture = { id: spaceId, name: "验收项目资料", path: workspace };
  await evaluate(`window.api.db.upsertSpace(${JSON.stringify(fixture)})`);
  const teaching = "写项目周报时先查任务目录的 release.md，核对两个模块的状态与编号，提测和上线须分别表述。";
  const question = "写项目周报。用两行汇报蓝桥和青禾各自的交付状态与记录编号。";
  report.comparison = [];
  const ask = async (arm, expectRoute) => {
    const id = "routing-" + arm;
    const task = { id, title: arm, welcomeMode: "general", spaceId, updatedAt: Date.now() };
    await evaluate(`window.api.db.upsertTask(${JSON.stringify(task)})`);
    const request = { taskId: id, spaceId, welcomeMode: "general", text: question, userMessageId: id + "-q", assistantMessageId: id + "-a" };
    const start = Date.now(), offset = requests.length;
    await evaluate(`(() => {
      window.routingRun = null;
      (async () => {
        const admission = await window.api.agent.prompt(${JSON.stringify(request)});
        if (admission.error || !admission.receipt) throw Error(JSON.stringify(admission));
        const done = await window.api.agent.waitForSubmission(admission.receipt);
        if (done.error) throw Error(JSON.stringify(done.error));
        const history = await window.api.agent.loadTaskHistory(${JSON.stringify(id)});
        return history.messages.filter(m => m.role === 'assistant').at(-1)?.text;
      })().then(text => window.routingRun = { text }, e => window.routingRun = { error: String(e) });
    })()`);
    await until(() => evaluate("!!window.routingRun"), arm);
    const result = await evaluate("window.routingRun");
    assert.ifError(result.error ? Error(result.error) : null);
    const calls = requests.slice(offset).filter(payload => payload.messages.some(message => message.role === "user" &&
      (message.content === question || (Array.isArray(message.content) && message.content.some(part => part.text === question)))));
    const uses = await evaluate(`window.api.answerRouting.history(${JSON.stringify({ taskId: id, inputId: request.userMessageId })})`);
    const lines = (result.text ?? "").split("\n");
    const grounded = lines.some(line => /蓝桥/.test(line) && /RG-174/i.test(line) && /提测/.test(line))
      && lines.some(line => /青禾/.test(line) && /RG-285/i.test(line) && /已上线|完成上线/.test(line));
    const modelTools = new Map();
    for (const request of calls) for (const message of request.messages) for (const tool of message.tool_calls ?? [])
      modelTools.set(tool.id, tool.function?.name);
    report.comparison.push({ arm, elapsedMs: Date.now() - start, providerRequests: calls.length,
      modelTools: [...modelTools.values()], grounded, answer: result.text, uses });
    assert.equal(uses.length, expectRoute ? 1 : 0);
    if (expectRoute) {
      assert.match(uses[0].detail, /已预读 release.md/);
      assert.match(JSON.stringify(calls[0]?.messages), /RG-174/);
      assert(grounded, "回答缺少验收资料中的编号或状态");
    }
  };
  await ask("baseline", false);
  const memory = await evaluate(`window.api.memory.create(${JSON.stringify({ title: "周报发布记录", content: teaching,
    scopeType: "global", kind: "procedure", sourceType: "manual", explicit: true })})`);
  await ask("memory", false);
  const draft = { title: "周报核查", include: ["项目周报"], exclude: ["翻译"], instruction: teaching,
    enabled: true, evidenceFile: "release.md", sourceMemoryId: memory.id, sourceHash: memory.contentHash, projectId: null };
  await evaluate(`window.api.answerRouting.save(${JSON.stringify(draft)})`);
  await ask("routed", true);
  await evaluate(`(() => {
    window.teachingResult = null;
    window.api.answerRouting.suggest("写交付周报时先核对发布记录").then(
      draft => window.teachingResult = {draft}, error => window.teachingResult = {error: String(error)});
  })()`);
  await until(() => evaluate("!!window.teachingResult"), "model-authored rule draft");
  const suggestion = await evaluate("window.teachingResult");
  assert.ifError(suggestion.error ? Error(suggestion.error) : null);
  assert.match(suggestion.draft.instruction, /发布/);
  assert(suggestion.draft.include.length);
  report.actualControlChecks.push("Natural-language teaching produced an editable draft through the configured model.");
  await restart();
  await evaluate(`import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setSettingsOpen(true,'answerRouting'))`);
  const openReply = "[...document.querySelectorAll('.answer-routing-row button')].find(b => b.textContent === '打开对话')";
  await until(() => evaluate(`!!(${openReply})`), "persisted use after restart");
  await evaluate(`(${openReply}).click()`);
  const teach = "[aria-label=教给调度器]";
  await until(() => evaluate(`!!document.querySelector('${teach}')`), "completed answer actions");
  await evaluate(`document.querySelector('${teach}').click()`);
  await until(() => evaluate("document.querySelector('.answer-rule-form')?.textContent.includes('本次采用「周报核查」')"),
    "this answer displays its own rule receipt");
  assert.match(await evaluate("document.querySelector('.answer-rule-form details').textContent"), /RG-174/);
  report.actualControlChecks.push("After restart, opened the original chat from rule history and verified teaching from that specific answer.");
}, { name: "answer-routing-live", liveModel: true, settings: { memoryEnabled: true } });
