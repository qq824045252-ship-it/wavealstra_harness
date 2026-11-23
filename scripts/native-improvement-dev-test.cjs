const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, report } = env;
  const { click, press, screenshot, fill } = routingControls(env);
  const taskId = "improve-desktop";
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  await until(() => evaluate("window.api.nativeImprovement.report().then(r=>r.runs.length>0)"), "automatic weekly review at startup");
  await api("db.upsertTask", { id: taskId, title: "范围调整验收", permissionMode: "auto", welcomeMode: "general", updatedAt: Date.now() });
  let n = 0;
  async function prompt(text, task = taskId) {
    n++;
    const res = await api("agent.prompt", { taskId:task,text,userMessageId:"user"+n,assistantMessageId:"reply"+n });
    assert.equal((await api("agent.waitForSubmission",res.receipt)).receipt.status,"done");
  }
  await prompt("制定完整规划，列出交付物和验收标准。");
  await prompt("实施范围收窄到原生会话。");
  await prompt("你漏了验收要求，请补齐。");
  const automation = 'section[aria-label="每周自我改进"]';
  await click("自动化", ".desktop-rail");
  await screenshot("automation-weekly-entry");
  await evaluate(`(() => {
    const section = document.querySelector(${JSON.stringify(automation)});
    window.weeklyReviewStatus = [];
    const observer = new MutationObserver(() => {
      const status = section.querySelector('[role="status"]')?.textContent;
      if (status) window.weeklyReviewStatus.push(status);
    });
    observer.observe(section, {subtree:true, childList:true, characterData:true});
  })()`);
  await click("立即复盘", automation);
  await until(() => evaluate("window.weeklyReviewStatus.length > 0"), "manual review shows progress from idle");
  const item = () => evaluate("window.api.nativeImprovement.report().then(r => r.items.find(i => i.hookId))");
  await until(async () => (await item())?.state === "watching", "published a scoped improvement");
  await click("查看周报", automation);
  const panel = ".weekly-review";
  const tab = label => click(label, ".review-nav");
  await tab("历史周报");
  await until(() => evaluate("document.querySelector('.review-facts')?.innerText.includes('适用交付任务') && document.querySelector('.review-facts')?.innerText.includes('未测量')"), "zero denominator remains unmeasured");
  await tab("改进发现");
  report.actualControlChecks.push("自动化入口可手动启动复盘，空闲开始也显示进度，并能打开当周统计分母与证据。");
  await prompt("范围限定为只读操作。");
  const h = await item();
  assert.equal(h.triggers,1);
  await click("立即复盘",".weekly-review");
  await press("[...document.querySelectorAll('.weekly-review summary')].find(e=>e.textContent.includes('收窄范围'))","open evidence");
  await until(() => evaluate("document.querySelector('.weekly-review').textContent.includes('检查触发 1 次')"),"observed trigger on screen");
  await press("[...document.querySelectorAll('.weekly-review summary')].find(e=>e.textContent.includes('原始来源'))","open original sources");
  await click("查看原始摘录",".weekly-review");
  await until(() => evaluate("Array.from(document.querySelectorAll('.weekly-review blockquote')).some(e=>e.textContent.includes('你漏了验收要求，请补齐。'))"),"original correction on screen");
  await screenshot("native-improvement");
  await click("停用这项改进",".weekly-review");
  await until(async () => (await item()).state === "disabled","disabled improvement");
  report.actualControlChecks.push("从原生轮次复盘，设置页启用任务范围的检查，后续请求触发，设置页显示证据并成功停用。");
  const roles = path.join(env.home,".mybuddy","agents");
  fs.mkdirSync(roles,{recursive:true});
  fs.writeFileSync(path.join(roles,"review-reader.md"),"---\nname: review-reader\ndescription: Read-only evidence fixture\ntools: read\n---\nReport the observed result.\n");
  await prompt("REVIEW_DISPATCH_CHILD");
  await click("立即复盘",".weekly-review");
  await tab("子代理交接");
  await until(() => evaluate("document.querySelector('.review-content')?.innerText.includes('review-reader')"), "closed child indexed");
  await press("[...document.querySelectorAll('.weekly-review summary')].find(e=>e.textContent.includes('review-reader'))","open child");
  await click("查看交接与结果",".weekly-review");
  await until(() => evaluate("[...document.querySelectorAll('.weekly-review blockquote')].some(e=>e.textContent.includes('CHILD_REVIEW_ANSWER'))"),"original child answer visible");
  const summary = await evaluate("window.api.nativeImprovement.report().then(r => r.children[0])");
  const detail = await evaluate("window.api.nativeImprovement.child(" + JSON.stringify(taskId) + "," + summary.conversation + ")");
  assert.equal(detail.child.status,"completed");
  assert(detail.parentReturnEntry && detail.parentSubmissions?.length);
  assert.equal(detail.diagnostics.inputTokens,17);
  assert.equal(detail.diagnostics.cacheReadTokens,3);
  assert.equal(detail.diagnostics.outputTokens,4);
  await screenshot("child-evidence");
  report.actualControlChecks.push("桌面派发一个原生子代理，设置页回读父提交、子代理回答和父返回回执，核对独立模型用量。");

  await api("agent.updateAppSettings", { memoryEnabled: true });
  const deliveryTask = "improve-delivery";
  const cwd = path.join(env.home, deliveryTask);
  fs.mkdirSync(cwd);
  await api("db.upsertTask", { id: deliveryTask, title: "文档交付验收", cwd, permissionMode: "auto", welcomeMode: "general", updatedAt: Date.now() });
  const delivery = "生成 report.md，必须包含章节「结论」和附件 evidence.csv。";
  await prompt(`UI_DELIVERY_CASE ${delivery}`, deliveryTask);
  await prompt("UI_DELIVERY_CORRECTION 你漏了附件 evidence.csv，请补齐。", deliveryTask);
  await click("立即复盘",".weekly-review");
  const getVersion = () => evaluate(`window.api.nativeImprovement.report().then(r=>r.versionEvidence.find(v=>v.source?.taskId===${JSON.stringify(deliveryTask)}))`);
  await until(async () => (await getVersion())?.active, "published five-asset delivery version");
  const version = await getVersion();
  assert.equal(version.assets.length,5);
  await prompt(`UI_DELIVERY_USE ${delivery}`, deliveryTask);
  await click("立即复盘",".weekly-review");
  await tab("改进发现");
  await until(() => evaluate("document.querySelector('[data-finding]')?.checkVisibility()"), "findings list ready");
  await screenshot("weekly-overview");
  const titles = await evaluate("Array.from(document.querySelectorAll('.review-record-name strong'), el => el.textContent)");
  assert(titles.some(name => name.includes("文档交付")));
  await fill('[aria-label="搜索改进发现"]', "文档交付");
  await until(() => evaluate("document.querySelectorAll('.review-content [data-finding]').length === 1"), "filter by finding title");
  await fill('[aria-label="搜索改进发现"]', "no-matching-finding");
  await until(() => evaluate("document.querySelector('.review-empty')?.innerText.includes('没有匹配')"), "empty search result");
  await fill('[aria-label="搜索改进发现"]', "");
  await tab("发布版本");
  const versionSummary = `document.querySelector('[data-version="${version.packageId}"] > summary')`;
  await press(versionSummary,"open delivery version");
  const release = `(${versionSummary}).parentNode`;
  await press(`[...(${release}).querySelectorAll('summary')].find(e=>e.textContent.includes('发布前回放'))`,"open release replays");
  await press(`[...(${release}).querySelectorAll('summary')].find(e=>e.textContent.includes('运行回执'))`,"open release usage receipts");
  await until(() => evaluate(`(${release}).innerText.includes('原契约漏项') && [...(${release}).querySelectorAll('tbody tr')].some(row=>row.innerText.includes('脚本／工具') && row.innerText.includes('已执行'))`),"replay and actual tool use visible");
  await screenshot("weekly-version-evidence");
  await tab("改进发现");
  await press("[...document.querySelectorAll('.weekly-review summary')].find(e=>e.textContent.includes('文档交付后仍需补齐明确要求'))","open delivery finding");
  await click("停用这项改进",panel);
  await until(async () => !(await getVersion()).active, "version disabled");
  await tab("发布版本");
  await until(() => evaluate(`/已停用|已撤回/.test((${versionSummary})?.textContent ?? '')`),"disabled state visible");
  await press(versionSummary, "open disabled version");
  await press(`[...(${release}).querySelectorAll('summary')].find(e=>e.textContent.includes('发布前回放'))`,"open retained replays");
  assert(await evaluate(`(${release}).innerText.includes('原契约漏项')`));
  await tab("改进发现");
  await env.rpc("Emulation.setDeviceMetricsOverride", {width: 830, height: 760, deviceScaleFactor: 1, mobile: false});
  await until(() => evaluate("document.querySelector('.weekly-review').clientWidth < 650"), "compact report width");
  const bounds = await evaluate("['.weekly-review','.review-nav','.review-stats','.review-list'].map(s=>{const e=document.querySelector(s); return [s,e.clientWidth,e.scrollWidth]})");
  assert(bounds.every(([,w,sw]) => sw<=w+1),JSON.stringify(bounds));
  await screenshot("weekly-overview-compact");
  await env.rpc("Emulation.setDeviceMetricsOverride", {width: 1440, height: 980, deviceScaleFactor: 1, mobile: false});
  await click("定时任务", ".review-crumb");
  await press("[...document.querySelectorAll('button.desktop-section-row')].find(e=>e.textContent.trim()==='每周复盘')", "open report from automation sidebar");
  await click("设置", ".desktop-rail");
  await press("[...document.querySelectorAll('button.settings-nav-btn')].find(e=>e.textContent.trim()==='自我改进')", "open report from settings sidebar");
  await until(() => evaluate("document.querySelector('.settings-modal .weekly-review [data-finding]')?.checkVisibility()"), "settings shows shared report");
  await evaluate("import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setTheme('light'))");
  await until(() => evaluate("document.documentElement.dataset.theme === 'light'"), "light palette active");
  await screenshot("weekly-settings-light");
  report.actualControlChecks.push("自动化和设置入口共享周报。名称筛选和无结果反馈可用，紧凑窗口无横向溢出，浅色主题可读。");
  report.actualControlChecks.push("真实交付遗漏发布五类资产，界面回读回放及原生工具实际执行，撤回版本后仍可核查。");
}, {name:"native-improvement", settings:{permissionMode:"auto",memoryEnabled:false},watchRenderer:false,
fixtureUsage: () => ({prompt_tokens:20,completion_tokens:4,total_tokens:24,prompt_tokens_details:{cached_tokens:3}}),
fixtureModel: request => {
  const last = request.messages.at(-1);
  const instructions = request.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
  if (instructions.includes('{"candidates":')) return '{"candidates":[]}';
  if (instructions.includes("你负责复盘 MyBuddy 原生任务")) {
    const evidence = JSON.parse(last.content).map(item => item.id).slice(0,3);
    return JSON.stringify({route:"资料不足",finding:"定位到用户反馈。",reason:"需要核对原始执行记录。",
      change:"核对现有检查。",acceptance:"完成前检查明确要求。",evidence});
  }
  const delivery = request.messages.findLastIndex(m => m.role === "user" && /UI_DELIVERY_(?:CASE|USE|CORRECTION)/.test(JSON.stringify(m)));
  if (delivery >= 0 && !JSON.stringify(request.messages[delivery]).includes("UI_DELIVERY_CORRECTION")) {
    const use = JSON.stringify(request.messages[delivery]).includes("UI_DELIVERY_USE");
    const results = request.messages.slice(delivery + 1).filter(m => m.role === "tool").length;
    if (!results) return {tool:{name:"write",arguments:{path:"report.md",content:"# 结论\n正文。\n"}}};
    if (use && results === 1) return {tool:{name:"write",arguments:{path:"evidence.csv",content:"row,value\n1,ok\n"}}};
    return "已完成。";
  }
  if (last.role === "user" && JSON.stringify(last).includes("REVIEW_DISPATCH_CHILD"))
    return {tool:{name:"subagent",arguments:{agent:"review-reader",task:"CHILD_REVIEW_TASK",model:"fixture/ui-fixture",isolation:"shared"}}};
  if (last.role === "user" && JSON.stringify(last).includes("CHILD_REVIEW_TASK")) return "CHILD_REVIEW_ANSWER";
  return "收到。";
}});
