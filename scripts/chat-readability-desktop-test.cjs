const assert = require("node:assert/strict");
const path = require("node:path");
const { run } = require(path.resolve("scripts/desktop-dev-harness.cjs"));
const { routingControls } = require(path.resolve("scripts/answer-routing-desktop-controls.cjs"));

const dots = process.argv.includes("--dots");
const id = dots ? "mybuddy-dots" : "chat-reading-test";
const source = "https://example.org/reference";
const quote = "This text belongs to the test source.";
const sample = "const answer = " + JSON.stringify("精确内容".repeat(35)) + ";\n";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const fence = (language, content) => "```" + language + "\n" + content + "\n```";
const reply = [
  "结论保留在正文。", "## 代码", fence("ts", sample.trimEnd()),
  "## 图片", `![第一张图注](<${png}>)\n\n![第二张图注](<${png}>)`,
  "## 操作说明", "1. 检查输入。\n2. 查看结果。\n\n- [x] 已核对输入。\n- [ ] 待核对结果。",
  "> [!WARNING]\n> 明示的约束。\n\n> 普通引文保持原样。",
  fence("mermaid", "flowchart LR\nInput[输入] --> Output[结果]"),
  fence("mermaid", "flowchart LR\nA[未闭合 --> B"),
  "## 文档和数据", '<!DOCTYPE html>\n<html><head><title>验收文档</title></head><body><h1>预览正文</h1></body></html>',
  fence("mybuddy-table", '{"title":"数量","columns":[{"label":"项目","type":"text"},{"label":"数量","type":"number","unit":"件"}],"rows":[["甲",12],["乙",2]]}'),
  fence("mybuddy-chart", '{"title":"趋势","type":"line","unit":"件","points":[{"label":"周一","value":12},{"label":"周二","value":null},{"label":"周三","value":2}]}'),
  `原文结论 [来源](<${source}> "mybuddy-cite: ${quote}")。`,
].join("\n\n");

function fixtureModel(request) {
  const userIndex = request.messages.findLastIndex(message => message.role === "user");
  const user = JSON.stringify(request.messages[userIndex]?.content);
  const tools = request.messages.slice(userIndex + 1).filter(message => message.role === "tool");
  if (user?.includes("产物和工具测试")) {
    if (tools.length === 0) return { tool: { name: "read", arguments: { path: "不存在的输入文件.txt" } } };
    if (tools.length === 1) return { tool: { name: "write", arguments: { path: "本轮交付.md", content: "# 真实交付\n\n本轮生成。\n" } } };
    if (tools.length === 2) return { tool: { name: "register_artifact", arguments: { path: "本轮交付.md" } } };
    return "本轮交付已完成。";
  }
  return user?.includes("阅读功能测试") ? reply : "简短回复。";
}

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { press, click, screenshot } = routingControls(env);
  const css = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const history = () => evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(id)}).then(result=>result.messages)`);
  if (dots) await click("MyBuddy Dots", ".sidebar-scroll");
  else {
    await evaluate(`window.api.db.upsertTask({id:"chat-reading-test",title:"阅读验证",welcomeMode:"general",updatedAt:Date.now()})`);
    await evaluate(`import('/src/store/appStore.ts').then(m=>{m.useAppStore.getState().initRuntime()})`);
    await press("[...document.querySelectorAll('.task-item-title')].find(el=>el.textContent==='阅读验证')", "打开普通任务");
  }

  const send = async (text, expected) => {
    await press(css("textarea.input-textarea"), "聊天输入");
    await rpc("Input.insertText", { text });
    await press(css('button[title="发送 (Enter)"]'), "发送任务");
    let message;
    await until(async () => {
      message = (await history()).findLast(m => m.role === "assistant" && m.text?.includes(expected));
      return Boolean(message);
    }, "回复落盘");
    await until(() => evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().tasks.find(t=>t.id===${JSON.stringify(id)})?.durable?.busy===false)`), "任务结束");
    return `#msg-${message.id}`;
  };

  await send("请只给一句简短回复。", "简短回复");
  const scope = await send(`阅读功能测试\n\n[验收来源](${source})\n> ${quote}`, "结论保留在正文");
  const inReply = selector => css(`${scope} ${selector}`);
  await press(inReply('button[aria-label="跳转到回复段落"]'), "打开回复段落");
  await click("文档和数据", ".chat-reading-popover:popover-open");
  assert.equal(await evaluate("document.activeElement.textContent.trim()"), "文档和数据");
  await press(inReply('.chat-code-actions button[aria-pressed="false"]'), "代码换行");
  assert.equal(await evaluate(`getComputedStyle(${inReply(".chat-code-wrap pre code")}).whiteSpace`), "pre-wrap");
  await click("查看完整代码", scope);
  assert.equal(await evaluate("document.querySelector('dialog[open] pre').textContent.trimEnd()"), sample.trimEnd());
  await click("关闭", "dialog[open]");
  await press(inReply('img[alt="第一张图注"]'), "打开多图预览");
  assert.equal(await evaluate("document.querySelector('dialog[open] img').alt"), "第一张图注");
  await click("下一张", "dialog[open]");
  assert.equal(await evaluate("document.querySelector('dialog[open] img').alt"), "第二张图注");
  await click("上一张", "dialog[open]");
  await click("关闭", "dialog[open]");
  assert.equal(await evaluate(`${inReply(".chat-image-caption")}.textContent`), "第一张图注");
  assert.match(await evaluate(`${inReply(".msg-callout.warning")}.textContent`), /注意.*明示的约束/s);
  assert.equal(await evaluate(`${inReply(".md-chat > .markstream-react blockquote:not(.chat-alert-body blockquote)")}?.textContent.includes('普通引文') ?? [...document.querySelectorAll(${JSON.stringify(scope + " blockquote")})].some(node=>node.textContent.includes('普通引文'))`), true);
  await until(() => evaluate(`Boolean(${inReply(".chat-mermaid img")}?.naturalWidth)`), "有效流程图确实绘制");
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(scope + ' .chat-mermaid img')}).length`), 1);
  assert.match(await evaluate(`${inReply(".assistant-card")}.textContent`), /未闭合 --> B/);
  await until(() => evaluate(`${inReply(".chat-preview-title")}?.textContent === '验收文档'`), "文档标题可读");
  await click("源码", `${scope} .chat-preview-switch`);
  assert.match(await evaluate(`${inReply(".msg-detail-code")}.textContent`), /<h1>预览正文<\/h1>/);
  await click("预览", `${scope} .chat-preview-switch`);
  assert.equal(await evaluate(`${inReply(".msg-detail-frame")}.title`), "验收文档");
  const copyTarget = dots ? inReply('button[aria-label="复制回复"]') : inReply('.msg-footer button[title="复制"]');
  await press(copyTarget, "复制整条回复");
  const copied = await evaluate("navigator.clipboard.readText()");
  assert.match(copied, /\| 甲 \| 12 \|/);
  assert.match(copied, /\| 周二 \| — \|/);
  assert.ok(copied.includes("[验收来源](<https://example.org/reference>)"));
  assert.doesNotMatch(copied, /mybuddy-(table|chart|cite)/);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(scope + " ol li")}).length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(scope + ' input[type="checkbox"]')}).length`), 2);
  report.actualControlChecks.push("段落跳转、完整代码与换行、双图图注和翻页、文档预览与源码、提示和列表、流程图及失败回退、可读复制");

  if (!dots) {
    assert.equal(await evaluate("[...document.querySelectorAll('.task-chat-header button')].some(button=>button.textContent.trim()==='审查变更')"), false);
    const delivered = await send("产物和工具测试。", "本轮交付已完成");
    await until(() => evaluate(`${css(delivered)}?.textContent.includes('本轮交付.md')`), "实际写入的文件跟随本轮消息");
    assert.equal(await evaluate("[...document.querySelectorAll('.task-chat-header button')].filter(button=>button.textContent.trim().startsWith('产物 (')).length"), 1);
    assert.equal(await evaluate("[...document.querySelectorAll('.task-chat-header button')].some(button=>button.textContent.trim()==='审查变更')"), true);
    assert.doesNotMatch(await evaluate("document.querySelector('.message-list').textContent"), /查看所有产物/);
    await press(css(`${delivered} .timeline-header`), "展开工具过程");
    await press(css(`${delivered} .tool-row--error .tool-row-header`), "展开失败工具");
    assert.match(await evaluate(`${css(`${delivered} .chat-tool-detail`)}.textContent`), /失败详情.*调用详情/s);
    report.actualControlChecks.push("真实写入产生本轮文件，标题栏提供唯一总入口，失败工具展开后分开显示结果和调用详情");
  }
  await screenshot("readability");
}, { name: dots ? "chat-readability-dots" : "chat-readability-main", fixtureModel,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } },
  watchRenderer: false, isolatedDependencyCache: true, rpcTimeoutMs: 120_000 });
