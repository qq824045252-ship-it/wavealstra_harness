const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, report } = env;
  const { click, press, fill, screenshot } = routingControls(env);
  await click("MyBuddy Dots", ".sidebar-dots-entry");
  await until(() => evaluate("document.querySelector('.chat-header-title')?.textContent === 'MyBuddy Dots'"), "Dots 会话已就绪");
  await click("设置", ".desktop-rail");
  await press("[...document.querySelectorAll('button.settings-nav-btn')].find(b=>b.textContent.trim()==='Dots 设置')", "打开 Dots 设置");
  await click("常驻能力", ".dots-config nav");
  await until(() => evaluate("document.querySelector('.dots-google-account')?.innerText.includes('personal@example.test')"), "个人账号回执");
  assert.match(await evaluate("document.querySelectorAll('.dots-google-account')[1].innerText"), /company@example\.test/);

  await fill('select[aria-label="Google 日历检查方式"]', "daily");
  await fill('input[aria-label="Google 日历每日检查时间"]', "09:17");
  await click("保存日历设置", ".dots-config");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.google.calendar.dailyTime === '09:17')"), "日历固定时间已保存");
  await fill('input[aria-label="Gmail 邮箱轮询间隔（分钟）"]', "7");
  await click("保存邮箱设置", ".dots-config");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.google.gmail.intervalMinutes === 7)"), "邮箱轮询间隔已保存");
  const pair = await evaluate("window.api.agent.getAppSettings().then(r => [r.dotsSettings.google.gmail.mode, r.dotsSettings.google.calendar.mode, r.dotsSettings.google.calendar.dailyTime])");
  assert.deepEqual(pair, ["interval", "daily", "09:17"]);
  await screenshot("dots-google-settings");
  report.actualControlChecks.push("打开 Google 常驻能力，检查两个账号的反馈，并分别保存 Gmail 轮询与日历定时。");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.dots-resident-nav button')].map(button => button.textContent.trim())"),
    ["Google", "RSS", "Dream"]);
  await click("RSS", ".dots-resident-nav");
  await click("添加订阅", ".dots-config");
  await fill('input[aria-label="订阅地址"]', "https://feed.example.test/rss.xml");
  await fill('input[aria-label="订阅名称（可选）"]', "桌面 RSS 夹具");
  await fill('select[aria-label="推送方式"]', "new");
  await fill('input[aria-label="检查间隔（分钟）"]', "8");
  await click("保存订阅", ".dots-config");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.rss[0]?.schedule.mode === 'new')"), "RSS 推送规则已保存");
  assert.equal(await evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.rss[0].schedule.minutes)"), 8);
  await click("暂停", ".dots-discovery-row");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.rss[0]?.enabled === false)"), "RSS 已暂停");
  await screenshot("dots-rss-settings");
  await click("移除", ".dots-discovery-row");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.rss.length === 0)"), "RSS 已移除");
  await click("Dream", ".dots-resident-nav");
  await evaluate(`Promise.all([
    window.api.memory.create({ kind:"preference", title:"天文摄影", content:"喜欢夜空摄影技巧。", scopeType:"task", scopeId:"mybuddy-dots" }),
    window.api.memory.create({ kind:"preference", title:"隐私隔离夹具", content:"这项偏好不属于 Dots。", scopeType:"global" })
  ])`);
  await click("从记忆找标签", ".dots-config");
  await click("天文摄影", ".dots-config");
  assert.equal(await evaluate("document.querySelector('input[aria-label=兴趣标签]').value"), "天文摄影");
  assert.doesNotMatch(await evaluate("document.querySelector('.dots-config').innerText"), /隐私隔离夹具/);
  await click("取消", ".dots-config .dots-discovery-editor");
  await click("添加标签", ".dots-config");
  await fill('input[aria-label="兴趣标签"]', "工业自动化");
  await fill('input[aria-label="公开搜索关键词"]', "公开工业自动化项目");
  await click("保存标签", ".dots-config");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.dream.tags[0]?.name === '工业自动化')"), "Dream 标签已保存");
  await fill('input[aria-label="随机窗口开始"]', "22:00");
  await fill('input[aria-label="随机窗口结束"]', "01:00");
  await click("保存 Dream 设置", ".dots-config");
  await until(() => evaluate("window.api.agent.getAppSettings().then(r => r.dotsSettings.dream.schedule.windowEnd === '01:00')"), "Dream 跨午夜窗口已保存");
  await screenshot("dots-dream-settings");
  report.actualControlChecks.push("在同一真实 Electron 设置面板添加、暂停、移除 RSS，并保存 Dream 兴趣标签和跨午夜随机窗口。");
}, {
  name: "dots-google-settings-desktop", watchRenderer: false, isolatedDependencyCache: true,
  settings: { memoryEnabled: true, dotsSettings: { followupMode: "paused" } },
  seedHome(home) {
    for (const account of ["personal", "company"]) {
      const root = path.join(home, ".mybuddy", "dots", "google", account);
      fs.mkdirSync(path.join(root, "profile-fixture"), { recursive: true });
      fs.writeFileSync(path.join(root, "connection.json"), JSON.stringify({
        profile: "profile-fixture", email: account + "@example.test", checkedAt: Date.now(),
        access: { gmail: { ready: true }, calendar: { ready: true } },
      }));
    }
  },
}).catch(error => { console.error(error); process.exitCode = 1; });
