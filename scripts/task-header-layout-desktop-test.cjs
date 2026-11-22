const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { run } = require(path.resolve("scripts/desktop-dev-harness.cjs"));
const { routingControls } = require(path.resolve("scripts/answer-routing-desktop-controls.cjs"));

const longChinese = "优化 MyBuddy 的对话调度界面，验证超长中文任务标题在桌面顶栏中能正常省略，并且任务操作仍然可以点击。".repeat(4);
const longToken = "TaskHeaderLayoutWithoutAnySpaces".repeat(7);

const cases = [
  { id: "header-layout-normal", label: "普通标题", title: "普通标题", long: false },
  { id: "header-layout-long-cn", label: "超长中文标题", title: longChinese, long: true },
  { id: "header-layout-long-token", label: "无空格长串", title: longToken, long: true },
];

const quick = process.env.TASK_HEADER_QUICK === "1";
const activeCases = quick ? [cases[1]] : cases;

const fixtureModel = () => "已收到，标题布局验证。";

run(async env => {
  const { evaluate, until, rpc, report, out } = env;
  const { press, openTopBarMenu } = routingControls(env);
  const capture = async name => {
    await rpc("Page.bringToFront");
    const frame = await rpc("Page.captureScreenshot", { format: "png" }, undefined, 15_000);
    fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(frame.data, "base64"));
  };
  const q = JSON.stringify;
  const sel = css => `document.querySelector(${q(css)})`;
  const api = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => q(value)).join(",")})`);
  const store = expression => evaluate(`import('/src/store/appStore.ts').then(m => { const s = m.useAppStore.getState(); return ${expression}; })`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const setViewport = async width => {
    await rpc("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(`window.innerWidth === ${width}`), `viewport ${width} rendered`);
    await sleep(250);
  };

  const probe = () => evaluate(`(() => {
    const header = document.querySelector('.desktop-topbar-content');
    const label = header.querySelector('.desktop-task-title-label');
    const h = header.getBoundingClientRect();
    const t = label.getBoundingClientRect();
    const actions = [...header.querySelectorAll(':scope > button, .desktop-topbar-anchor > button')]
      .filter(button => button.getBoundingClientRect().left >= t.left).map(inner => {
      const r = inner.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        name: inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.textContent.trim(),
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        visible: inner.checkVisibility(), disabled: inner.disabled,
        clickable: Boolean(hit && (inner === hit || inner.contains(hit))),
      };
    });
    return {
      fullWidthBody: Math.abs(document.querySelector('[data-desktop-main]').getBoundingClientRect().width - window.innerWidth) < 1,
      listClosed: document.querySelector('#desktop-module-list').hidden,
      header: { left: h.left, right: h.right, top: h.top, bottom: h.bottom, width: h.width, height: h.height },
      title: { left: t.left, right: t.right, top: t.top, bottom: t.bottom, width: t.width },
      wrap: getComputedStyle(header).flexWrap,
      clientWidth: label.clientWidth,
      scrollWidth: label.scrollWidth,
      overflowX: getComputedStyle(label).overflowX,
      textOverflow: getComputedStyle(label).textOverflow,
      fullText: label.textContent,
      titleAttr: label.getAttribute('title'),
      actions,
    };
  })()`);

  const assertHeader = (state, testCase, width) => {
    const context = `${testCase.label} @ ${width}px`;
    assert.equal(state.wrap, "nowrap", `${context}: header must stay on one row`);
    assert.equal(state.fullText, testCase.title, `${context}: full title stays in the DOM`);
    assert.ok(state.titleAttr && state.titleAttr.startsWith(testCase.title), `${context}: full title is available on hover`);
    assert.ok(state.fullWidthBody && state.listClosed, `${context}: the closed list must not occupy space`);
    for (const name of ['任务列表', '新建任务', '更多任务操作']) {
      assert(state.actions.some(action => action.name === name), `${context}: missing ${name}`);
    }
    const firstLeft = Math.min(...state.actions.map(action => action.left));
    for (const action of state.actions) {
      assert.ok(action.visible && !action.disabled, `${context}: ${action.name} must be visible and enabled ${JSON.stringify(action)}`);
      assert.ok(action.width >= 20 && action.height >= 20, `${context}: ${action.name} must keep a clickable box`);
      assert.ok(action.clickable, `${context}: ${action.name} must not be covered`);
      assert.ok(action.left >= state.header.left - 0.5 && action.right <= state.header.right + 0.5,
        `${context}: ${action.name} must stay inside the header horizontally`);
      assert.ok(action.top >= state.header.top - 0.5 && action.bottom <= state.header.bottom + 0.5,
        `${context}: ${action.name} must stay inside the header vertically`);
    }
    assert.ok(state.title.width > 0, `${context}: title must keep a visible box`);
    assert.ok(state.title.right <= firstLeft + 0.5, `${context}: title must end before the first action`);
    assert.equal(state.overflowX, "hidden", `${context}: title overflow must be hidden`);
    assert.equal(state.textOverflow, "ellipsis", `${context}: title must use an ellipsis`);
    if (testCase.long) assert.ok(state.scrollWidth > state.clientWidth + 1, `${context}: long title must be truncated ${JSON.stringify({ header: state.header, title: state.title, clientWidth: state.clientWidth, scrollWidth: state.scrollWidth })}`);
    else assert.ok(state.scrollWidth <= state.clientWidth + 1, `${context}: ordinary title must not be truncated ${JSON.stringify({ header: state.header, title: state.title, clientWidth: state.clientWidth, scrollWidth: state.scrollWidth })}`);
  };

  const openTask = async testCase => {
    await openTopBarMenu("desktop-module-list");
    await press(`[...document.querySelectorAll('.task-item-title')].find(el => el.textContent === ${q(testCase.title)})`, `打开${testCase.label}`);
    await until(() => evaluate(`document.querySelector('.desktop-task-title-label')?.textContent.trim() === ${q(testCase.title)}`), `${testCase.label} 标题已显示`);
  };

  const seedMessage = async testCase => {
    await press(sel("textarea.input-textarea"), `${testCase.label} 聊天输入`);
    await rpc("Input.insertText", { text: "标题布局验证" });
    await press(sel('button[title="发送 (Enter)"]'), `${testCase.label} 发送任务`);
    await until(async () => {
      const history = await api("agent.loadTaskHistory", testCase.id);
      return history.messages.some(message => message.role === "assistant" && message.text);
    }, `${testCase.label} 回复落盘`);
    // 首轮消息会把默认标题改成消息摘要；发送后再重命名回验收用的标题。
    await store(`m.useAppStore.getState().renameTask(${q(testCase.id)}, ${q(testCase.title)})`);
    await until(() => evaluate(`document.querySelector('.desktop-task-title-label')?.textContent.trim() === ${q(testCase.title)}`), `${testCase.label} 标题已恢复`);
    await evaluate(`import('/src/store/appStore.ts').then(m => {
      const s = m.useAppStore.getState();
      m.useAppStore.setState({ tasks: s.tasks.map(task => task.id === ${q(testCase.id)} ? {
        ...task,
        fileChanges: [{ id: 'header-layout-change', name: 'src/header-layout-fixture.ts', path: 'src/header-layout-fixture.ts', additions: 3, deletions: 1 }],
      } : task) });
    })`);
    await until(() => evaluate(`[...document.querySelectorAll('#desktop-task-actions .chat-reading-button')].some(button => button.textContent.trim() === '审查变更')`), `${testCase.label} 审查变更出现`);
  };

  const verifyTitleAccess = async testCase => {
    await evaluate(`(() => {
      const label = document.querySelector('.desktop-task-title-label');
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    })()`);
    await until(() => evaluate(`document.querySelector('.desktop-task-title-input')?.value === ${q(testCase.title)}`), `${testCase.label} 重命名显示完整任务名`);
    await evaluate(`document.querySelector('.desktop-task-title-input')?.blur()`);
    await until(() => evaluate(`Boolean(document.querySelector('.desktop-task-title-label'))`), `${testCase.label} 退出重命名`);
  };

  const settledProbe = async () => {
    await sleep(200);
    let previous = await probe();
    const samples = [[previous.header.width, previous.title.width]];
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(150);
      const current = await probe();
      samples.push([current.header.width, current.title.width]);
      if (Math.abs(current.header.width - previous.header.width) < 0.5 && Math.abs(current.title.width - previous.title.width) < 0.5) return current;
      previous = current;
    }
    throw Error("task header layout did not settle " + JSON.stringify(samples));
  };

  const taskAction = async label => {
    await openTopBarMenu("desktop-task-actions");
    await press(`[...document.querySelectorAll('#desktop-task-actions button')].find(button =>
      (button.getAttribute('aria-label') ?? button.textContent.trim()) === ${q(label)})`, label);
  };

  const closeSidePanel = async (testCase, label) => {
    await taskAction("关闭侧栏");
    await until(() => store(`s.panelOpen === false`), `${testCase.label} ${label} 已关闭`);
  };

  const verifyPanelOpened = async (testCase, width, label) => {
    await until(() => store(`s.panelOpen === true`), `${testCase.label} ${label} 打开`);
    assertHeader(await settledProbe(), testCase, width);
    await closeSidePanel(testCase, label);
    const restored = await settledProbe();
    assertHeader(restored, testCase, width);
  };

  const verifyAt = async (testCase, width, { click = false } = {}) => {
    await setViewport(width);
    await until(() => store(`s.panelOpen === false`), "起始状态侧栏关闭");
    let state = await settledProbe();
    assertHeader(state, testCase, width);
    if (click) {
      await taskAction("审查变更");
      await verifyPanelOpened(testCase, width, "审查变更");

      await taskAction("历史提问");
      await until(() => evaluate("Boolean(document.querySelector('.history-popup'))"), `${testCase.label} 历史提问弹窗`);
      await taskAction("历史提问");
      await until(() => evaluate("!document.querySelector('.history-popup')"), `${testCase.label} 历史提问关闭`);

      await taskAction("执行诊断");
      await until(() => evaluate("Boolean(document.querySelector('dialog.execution-diagnostics-dialog[open]'))"), `${testCase.label} 诊断弹窗`);
      await press(`[...document.querySelectorAll('dialog.execution-diagnostics-dialog[open] button')].find(button => button.getAttribute('aria-label') === '关闭执行诊断')`, `${testCase.label} 关闭诊断`);
      await until(() => evaluate("!document.querySelector('dialog.execution-diagnostics-dialog[open]')"), `${testCase.label} 诊断关闭`);

      await taskAction("打开概览");
      await verifyPanelOpened(testCase, width, "打开概览");
      state = await settledProbe();
      assertHeader(state, testCase, width);
    }
    await verifyTitleAccess(testCase);
    await capture(`${testCase.id}-${width}`);
    report.checks.push(`${testCase.label} ${width}px 标题省略、操作区可见可点`);
  };

  await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Layout assertions must not sample an in-flight width transition.
  await evaluate(`(() => { const style = document.createElement('style'); style.id = 'task-header-layout-no-motion'; style.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}'; document.head.append(style); })()`);
  for (const testCase of cases) {
    await api("db.upsertTask", { id: testCase.id, title: testCase.title, welcomeMode: "general", updatedAt: Date.now() });
  }
  await evaluate("import('/src/store/appStore.ts').then(m => m.useAppStore.getState().initRuntime())");
  await until(() => store(`s.tasks.filter(task => ['header-layout-normal','header-layout-long-cn','header-layout-long-token'].includes(task.id)).length === 3`), "标题验证任务已加载");

  for (const testCase of activeCases) {
    await openTask(testCase);
    await until(() => evaluate("Boolean(document.querySelector('textarea.input-textarea'))"), `${testCase.label} 输入框`);
    await seedMessage(testCase);
    await verifyAt(testCase, 1440, { click: true });
    await verifyAt(testCase, 960, { click: true });
    await setViewport(1100);
    if (!quick) await verifyAt(testCase, 1100);
  }

  report.actualControlChecks.push("普通标题、超长中文标题、无空格长串在 1440/1100/960px 下标题按剩余宽度省略，审查变更、历史提问、执行诊断、打开/关闭概览均实际点击生效且不遮挡");
  report.taskHeaderCases = activeCases.map(testCase => ({ id: testCase.id, label: testCase.label, length: testCase.title.length }));
  report.artifacts = out;
}, {
  name: "task-header-layout",
  fixtureModel,
  isolatedDependencyCache: true,
  watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } },
  rpcTimeoutMs: 100_000,
});
