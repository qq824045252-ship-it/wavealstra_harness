/** Visible Electron coverage for the desktop shell, using a disposable user profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { run } = require('./desktop-dev-harness.cjs');

const routes = [
  ['MyBuddy', 'chat'], ['任务看板', 'task-board'], ['笔记', 'library'], ['项目', 'projects'],
  ['自动化', 'automation'], ['扩展', 'experts'], ['工作台', 'gadgets'],
  ['任务成果', 'files'], ['用量统计', 'usage'],
];

run(async ({ evaluate, rpc, until, report, out, home }) => {
  async function click(selector, label) {
    const expression = '(() => {const matches = [...document.querySelectorAll(' + JSON.stringify(selector) + ')]; return matches.find(node=>node.getClientRects().length' +
      (label == null ? '' : ' && (node.getAttribute("aria-label") || node.textContent.trim()) === ' + JSON.stringify(label)) + ');})()';
    await until(() => evaluate('Boolean(' + expression + ')'), label ?? selector);
    if (await evaluate('document.visibilityState === "hidden"')) {
      await evaluate('(() => {const node=' + expression + ';node.focus();node.click();})()');
      report.inputMode = 'CDP with DOM activation while Electron is occluded';
      return;
    }
    const point = await evaluate('(() => {const button=' + expression + ';button.scrollIntoView({block:"nearest"});const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()');
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await rpc('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    }
  }
  async function visible(selector) {
    await until(() => evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + ')?.getClientRects().length)'), selector);
  }
  async function metrics(width, height, deviceScaleFactor = 1) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    await until(() => evaluate('window.innerWidth === ' + width), 'visual viewport width');
  }
  async function screenshot(name) {
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  async function reloadDesktop() {
    const oldOrigin = await evaluate('performance.timeOrigin');
    await rpc('Page.reload');
    await until(() => evaluate('performance.timeOrigin !== ' + oldOrigin + ' && document.readyState === "complete" && !!document.querySelector(".desktop-rail")'), 'new desktop document mounted');
  }

  if (process.argv.includes('--task-board')) {
    await taskBoardCases();
    const taskId = await evaluate(`(async()=>{
      const {useAppStore}=await import('/src/store/appStore.ts');const state=useAppStore.getState();
      state.newTask(null);await useAppStore.getState().sendMessage('请核对报价单里的运输费用');
      return useAppStore.getState().activeTaskId;
    })()`);
    await until(()=>evaluate(`window.api.db.taskBoardPage({view:'recent'}).then(page=>page.rows.some(r=>r.id===${JSON.stringify(taskId)} && r.reason.includes('运输费用')))`),'accepted Pi input enters recent work');
    const question = '使用含税报价来核对运费吗？';
    const attentionRow = `window.api.db.taskBoardPage({view:'attention'}).then(page=>page.rows.find(r=>r.id===${JSON.stringify(taskId)} && r.interactionId))`;
    await until(()=>evaluate(attentionRow),'Pi is waiting for a real conversation interaction');
    const interactionId = (await evaluate(attentionRow)).interactionId;
    await click('.desktop-rail-module', '任务看板');
    await click('#desktop-module-list button','全部任务');
    await click('.task-board-views button','我的焦点');
    const questionCard = '.task-board-card[aria-label^="去回答："][title*="运输费用"]';
    await visible(questionCard);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(questionCard + ' .task-board-blocker')}).textContent`), question);
    await click(questionCard);
    await until(()=>evaluate(`document.activeElement?.dataset.interactionId===${JSON.stringify(interactionId)}`),'board focuses the exact question in the original task');
    await click(`[data-interaction-id="${interactionId}"] button`, '确认');
    await until(()=>evaluate(`window.api.conversationRuntime.snapshot(${JSON.stringify(taskId)}).then(s=>s.interactions.some(i=>i.id===${JSON.stringify(interactionId)} && i.status==='resolved'))`),'answering the original question resolves the runtime interaction');
    report.checks = ['bounded focus with 1000 history rows','independent status counts and controls','real Pi question opened and answered from the board','cross-day frequent visits','custom and saved date filters','history cursor','scheduling','cold read and pin'];
    assert.deepEqual(report.rendererErrors, []);
    console.log('PASS task board on the isolated desktop');
    return;
  }

  await metrics(1280, 800);
  for (const [mode, label] of [['general', '通用模式'], ['coding', '代码开发'], ['working', '日常办公'], ['general', '通用模式']]) {
    await until(async () => {
      if (await evaluate('document.querySelector(".hero")?.dataset.mode === ' + JSON.stringify(mode))) return true;
      await click('.hero-categories button', label);
      return false;
    }, label + ' selected');
    const state = await evaluate('({mode:document.querySelector(".hero")?.dataset.mode,selected:[...document.querySelectorAll(".hero-categories [aria-pressed=true]")].map(button=>button.textContent.trim())})');
    assert.deepEqual(state, { mode, selected: [label] });
  }
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await metrics(960, 640);
  assert.equal(await evaluate('document.querySelector(".hero")?.dataset.mode'), 'general');
  await metrics(1280, 800);

  assert.deepEqual(await evaluate('[...document.querySelectorAll(".desktop-rail-module, .desktop-rail-footer [aria-label=用量统计]")].map(button=>button.getAttribute("aria-label"))'), routes.map(([label]) => label));
  assert(await evaluate('[...document.querySelectorAll(".desktop-rail-module")].every(button => !button.textContent.trim() && button.title)'));
  assert(await evaluate('!document.querySelector(".desktop-rail [aria-label=全局搜索]") && !!document.querySelector(".desktop-section-heading [title=筛选]")'));
  assert(await evaluate('(() => {const overlay=navigator.windowControlsOverlay;const height=overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;return Math.abs(document.querySelector(".desktop-rail").getBoundingClientRect().top-height)<1;})()'), 'only the system window controls occupy the top inset');
  await until(() => evaluate('(() => {const overlay=navigator.windowControlsOverlay;const brand=document.querySelector(".desktop-titlebar-brand");return overlay?.visible ? brand.getBoundingClientRect().height>0 && brand.textContent.trim()==="MyBuddy" && brand.querySelector("img").naturalWidth>0 : brand.offsetHeight===0;})()'), 'title and icon occupy the system controls row only');
  assert(await evaluate('(() => {const active=document.querySelector(".desktop-rail-module[aria-current=page]");const style=getComputedStyle(active);return style.boxShadow==="none" && style.backgroundColor!=="rgba(0, 0, 0, 0)" && style.color===getComputedStyle(document.querySelector(".desktop-section-heading h2")).color;})()'), 'selected icon uses a neutral tile without an accent bar');
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,cancelable:true}))');
  assert(await evaluate('!document.querySelector(".search-modal")'), 'Ctrl+K does not reopen task search');
  assert(await evaluate('(() => {const side=document.querySelector(".desktop-task-tree");return !side.querySelector(".sidebar-section-count") && !side.innerText.includes("暂无独立任务") && side.innerText.includes("绑定本地文件夹") && getComputedStyle(side.querySelector(".sidebar-cta-btn")).borderTopWidth==="0px";})()'), 'empty task list puts actions in compact rows');
  await click('.sidebar-workspace-actions button', '新建工作空间');
  await visible('.workspace-create-dialog');
  await click('.workspace-create-dialog button', '取消');
  const db = new (require('better-sqlite3'))(path.join(home, '.mybuddy', 'app.db'), {fileMustExist:true});
  const notificationId = require('node:crypto').randomUUID();
  const runtimeId = require('node:crypto').randomUUID();
  try {
    const insert = db.prepare("INSERT INTO notifications(id,type,level,title,body,source_type,created_at,read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(notificationId, 'automation.completed', 'success', '导航验证通知', '日报自动化已完成', 'automation', Date.now(), null);
    insert.run(runtimeId, 'runtime.failed', 'error', '连接故障', '系统连接异常', 'runtime', Date.now() - 1, Date.now());
  } finally { db.close(); }
  await click('.notification-bell');
  await visible('.notifications-page');
  await visible('.notifications-open');
  const geometry = await evaluate('(() => {const box=document.querySelector(".notifications-page").getBoundingClientRect();const rail=document.querySelector(".desktop-rail").getBoundingClientRect();const main=document.querySelector("[data-desktop-main]").getBoundingClientRect();return {left:box.left-rail.right,top:box.top-rail.top,right:box.right-main.right,bottom:box.bottom-rail.bottom,moduleHidden:document.getElementById("desktop-module-list").hidden};})()');
  assert(geometry.moduleHidden && ['left', 'top', 'right', 'bottom'].every(edge => Math.abs(geometry[edge]) <= 1),
    'notification page fills main area beside the module rail: ' + JSON.stringify(geometry));
  await screenshot('notification-center');
  await click('.notifications-categories button', '系统');
  await until(() => evaluate('document.querySelector(".notifications-copy strong")?.textContent==="连接故障"'), 'system category shows only system notices');
  await click('.notifications-toolbar .notifications-control');
  await until(() => evaluate('document.querySelector(".notifications-empty")?.textContent.includes("没有符合条件")'), 'unread combines with category');
  await click('.notifications-categories button', '自动化');
  await click('[aria-label="搜索通知"]');
  await rpc('Input.insertText', { text: '日报' });
  await until(() => evaluate('document.querySelectorAll(".notifications-row").length===1 && document.querySelector(".notifications-type")?.textContent==="自动化完成"'), 'notification search includes body');
  await click('[aria-label="清空通知"]');
  await click('.notifications-feedback button', '取消');
  assert.equal(await evaluate('window.api.notification.list().then(items=>items.length)'), 2, 'cancel clear retains notifications');
  await click('[aria-label="阅读通知：导航验证通知"]');
  await visible('.notification-reading');
  await until(() => evaluate('!document.querySelector("button.notifications-open")'), 'unread row leaves the filtered list after reading');
  assert.equal(await evaluate('document.querySelector(".notification-reading").dataset.notificationId'), notificationId);
  await click('.notifications-categories button', '系统');
  assert.equal(await evaluate('document.querySelector(".notification-reading h2").textContent'), '导航验证通知', 'filter changes preserve the selected notification');
  await click('.notification-reading button', '关闭阅读');
  assert.equal(await evaluate('document.querySelector(".notification-reading") !== null'), false);
  await click('.notifications-toolbar .notifications-control');
  await click('.notifications-categories button', '自动化');
  await click('button.notifications-open');
  await until(() => evaluate('!document.querySelector(".notifications-page")'), 'notification leaves the page after activation');
  await until(() => evaluate('window.api.notification.unreadCount().then(n=>n===0)'), 'delivered notification read');
  await until(() => evaluate("import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().page==='automation')"), 'notification opens source');
  await evaluate('void (window.testModuleColumn = document.getElementById("desktop-module-list"))');
  for (const [label, page] of routes) {
    await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', label);
    await until(() => evaluate('document.querySelector(".desktop-rail [aria-current=page]")?.getAttribute("aria-label") === ' + JSON.stringify(label)), label + ' selected');
    await visible('#desktop-module-list h2');
    const actualPage = await evaluate("import('/src/store/appStore.ts').then(module=>module.useAppStore.getState().page)");
    assert.equal(actualPage, page);
    const layout = await evaluate('(() => {const column=document.getElementById("desktop-module-list");return {same:column===window.testModuleColumn,x:column.offsetLeft,width:column.offsetWidth,taskTree:!!column.querySelector(".desktop-task-tree")};})()');
    assert.deepEqual(layout, { same: true, x: 48, width: 200, taskTree: page === 'chat' }, label);
  }

  await click('#desktop-module-list .desktop-section-row', '30 天');
  await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', 'MyBuddy');
  await click('.desktop-task-tree .sidebar-cta-btn', '新建任务');
  await visible('.input-textarea');
  await evaluate('document.querySelector(".input-textarea").focus()');
  await rpc('Input.insertText', { text: '这段草稿要跨模块保留' });
  const draftAttachment = 'desktop-draft-fixture.txt';
  const attached = 'Array.from(document.querySelectorAll(".attach-chip-name")).some(chip=>chip.textContent===' + JSON.stringify(draftAttachment) + ')';
  await evaluate('(() => {const data=new DataTransfer();data.items.add(new File(["local fixture"],' + JSON.stringify(draftAttachment) + ',{type:"text/plain"}));document.querySelector(".input-textarea").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));})()');
  await until(() => evaluate(attached), 'draft attachment added through the composer');
  await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', '用量统计');
  assert.equal(await evaluate('document.querySelector("#desktop-module-list [aria-current=true]").textContent.trim()'), '30 天');
  await screenshot('usage');
  await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', 'MyBuddy');
  await until(() => evaluate('document.querySelector(".input-textarea")?.value === "这段草稿要跨模块保留"'), 'chat draft restored');
  assert(await evaluate(attached), 'the draft attachment survives navigation');
  await click('.desktop-task-tree .sidebar-cta-btn', '新建任务');
  await until(() => evaluate('document.querySelector(".input-textarea")?.value === ""'), 'new task has its own draft');
  assert.equal(await evaluate(attached), false);
  assert(await evaluate('document.querySelector(".input-textarea").offsetHeight <= 62'), 'empty composer fits two lines');
  await screenshot('chat');

  await click('.desktop-rail [aria-label="设置"]');
  await visible('.desktop-settings');
  await click('.settings-nav-btn', '工具能力');
  await click('[data-capability-id="web"] .capability-config-summary');
  await click('.settings-search-api > summary');
  await visible('.search-api-key-pools .ak-key-input');
  assert.equal(await evaluate('document.querySelector("#desktop-module-list h2").textContent'), '设置');
  const fixtureKey = 'isolated-search-key-pool-fixture';
  await click('[aria-label="Serper 新密钥"]');
  await rpc('Input.insertText', { text: fixtureKey });
  await click('.ak-card[aria-label="Serper"] .ak-add-btn', '添加');
  await until(() => evaluate('window.api.agent.getWebSearchConfig().then(config=>config.apiKeyPools?.serper?.[0] === ' + JSON.stringify(fixtureKey) + ')'), 'search key pool writes to the existing settings API');
  await click('.ak-card[aria-label="Serper"] [title="从池中删除"]');
  await until(() => evaluate('window.api.agent.getWebSearchConfig().then(config=>!config.apiKeyPools?.serper?.length)'), 'fixture key removed from pool');
  await screenshot('search-key-pools');

  await click('.settings-nav-btn', '系统设置');
  await visible('[aria-label="应用外观"]');
  await evaluate('(() => {const select=document.querySelector("[aria-label=应用外观]");select.value="light";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await until(() => evaluate('document.documentElement.dataset.theme === "light"'), 'theme switch remains available');
  await click('.desktop-rail-module', 'MyBuddy');
  await click('.desktop-section-heading [aria-label="收起模块列表"]');
  assert.equal(await evaluate('document.getElementById("desktop-module-list").offsetWidth'), 0);
  await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', 'MyBuddy');
  await click('.desktop-rail [aria-label="展开模块列表"]');
  assert.equal(await evaluate('document.getElementById("desktop-module-list").offsetWidth'), 200);

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<title>MyBuddy desktop local preview</title><h1>Local preview</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    await evaluate("import('/src/store/appStore.ts').then(({useAppStore}) => useAppStore.getState().setBrowserUrl(" + JSON.stringify(url) + '))');
    await visible('.browser-wcv-host');
    const tabExpression = 'window.api.browser.getTabs().then(({tabs})=>tabs.find(tab=>tab.url===' + JSON.stringify(url) + ' && tab.title==="MyBuddy desktop local preview")?.id)';
    await until(() => evaluate(tabExpression), 'native browser loaded the local fixture');
    const browserTabId = await evaluate(tabExpression);
    await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', '工作台');
    await visible('.gadget-page');
    assert.equal(await evaluate('Boolean(document.querySelector(".browser-wcv-host"))'), false);
    await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', 'MyBuddy');
    await visible('.browser-wcv-host');
    assert.equal(await evaluate(tabExpression), browserTabId, 'the same native tab is reused');
    await click('.notification-bell');
    await visible('.notifications-page');
    assert.equal(await evaluate('Boolean(document.querySelector(".browser-wcv-host"))'), false, 'notifications take over the native browser area');
    await click('[aria-label="返回上一模块"]');
    await until(() => evaluate('!document.querySelector(".notifications-page")'), 'return closes the notification page');
    await visible('.browser-wcv-host');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }

  await metrics(960, 640, 1.25);
  await click('.desktop-rail-module, .desktop-rail-footer [aria-label="用量统计"]', '笔记');
  await visible('#desktop-module-list h2');
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 960);
  await screenshot('notes-compact');
  await metrics(960, 640, 1.5);
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 960);
  await screenshot('notes-150-percent');

  const fixture = await evaluate(`(async () => {
    const { useAppStore } = await import('/src/store/appStore.ts');
    const { mapTaskRowToTask } = await import('/src/store/app/tasks/taskMapper.ts');
    const task = { id: 'result-categories-fixture', title: '月度交付', updatedAt: Date.now(), welcomeMode: 'general' };
    const space = { id: 'task-tree-layout-fixture', name: '交付空间', parentId: null, sortOrder: 1000, createdAt: Date.now() };
    const taskRows = [task,
      { ...task, id: 'task-tree-child-fixture', title: '空间内的任务', spaceId: space.id },
      { ...task, id: 'task-tree-pinned-fixture', title: '置顶任务布局', isFavorited: true },
    ];
    await window.api.db.upsertSpace(space);
    for (const row of taskRows) await window.api.db.upsertTask(row);
    const summary = await window.api.artifactDomain.register({
      taskId: task.id, kind: 'markdown', title: '月度总结.md', content: '# 月度总结',
    });
    const files = [
      ['code', '核对日志.log', 'verified'], ['code', '预算.csv', '名称,额度'],
      ['office', '汇报.pptx', 'fixture'], ['svg', '流程.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['html', '预览.html', '<h1>预览</h1>'], ['code', '交付.zip.part2', 'fixture'],
    ];
    for (const [kind, title, content] of files) {
      await window.api.artifactDomain.register({ taskId: task.id, kind, title, content });
    }
    const state = useAppStore.getState();
    const taskOptions = {
      enabledModelIds: new Set(state.models.map(model => model.id)),
      defaultModelId: state.defaultModelId, permissionModeDefault: state.permissionMode,
    };
    useAppStore.setState({
      tasks: [...state.tasks, ...taskRows.map(row => mapTaskRowToTask(row, taskOptions))],
      spaces: [...state.spaces, space],
      expandedSpaceIds: [...state.expandedSpaceIds, space.id],
    });
    return { summaryId: summary.id, names: [summary.title, ...files.map(file => file[1])] };
  })()`);
  await click('.desktop-rail-module', 'MyBuddy');
  assert.equal(await evaluate('document.querySelector(".desktop-section-heading h2").textContent'), 'MyBuddy');
  assert.equal(await evaluate('document.querySelector(".desktop-rail-module[aria-label=MyBuddy] svg")?.getAttribute("fill")'), 'currentColor');
  const taskRow = '.desktop-task-tree .task-item[title^="月度交付"]';
  const more = taskRow + ' [title="更多"]';
  const menu = '.task-context-menu-portal';
  const menuClosed = () => until(() => evaluate('!document.querySelector(".task-context-menu-portal")'), 'task menu closes');
  await visible(taskRow);
  const treeLayout = await evaluate(`(() => {
    const tree = document.querySelector('.desktop-task-tree');
    const left = selector => tree.querySelector(selector).getBoundingClientRect().left - tree.getBoundingClientRect().left;
    const toggle = tree.querySelector('.space-header[title="交付空间"] .space-chevron');
    return {
      independent: left('[title^="月度交付"] .task-item-title'),
      pinned: left('[title^="置顶任务布局"] .task-item-title'),
      folder: left('.space-name[title="交付空间"]'),
      child: left('[title^="空间内的任务"] .task-item-title'),
      taskIcon: left('[title^="月度交付"] .task-mode-icon'),
      folderIcon: left('.space-header[title="交付空间"] .space-icon'),
      toggleStart: left('.space-header[title="交付空间"] .space-chevron'),
      toggleWidth: toggle.getBoundingClientRect().width,
    };
  })()`);
  assert.equal(treeLayout.pinned, treeLayout.independent, 'pinned and independent tasks share a left edge');
  assert(treeLayout.folder >= 46 && treeLayout.folder <= 49 && Math.abs(treeLayout.independent - treeLayout.folder) < 1 &&
    Math.abs(treeLayout.taskIcon - treeLayout.folderIcon) < 1, 'top-level tasks use the folder alignment: ' + JSON.stringify(treeLayout));
  assert(treeLayout.toggleStart >= 7.5 && treeLayout.toggleWidth >= 18 &&
    treeLayout.toggleStart + treeLayout.toggleWidth <= treeLayout.folderIcon + 1, 'workspace toggle keeps an unobstructed hit area before its icon');
  assert(Math.abs(treeLayout.child - treeLayout.folder - 8) < 1, 'workspace tasks keep one level of indentation');
  await click('.space-chevron', '收起交付空间');
  await until(() => evaluate('!document.querySelector(\'[title^="空间内的任务"]\')'), 'workspace chevron collapses its tasks');
  await click('.space-chevron', '展开交付空间');
  await visible('[title^="空间内的任务"]');
  await screenshot('task-tree-alignment');
  const rowPoint = await evaluate('(() => {const rect=document.querySelector(' + JSON.stringify(taskRow) + ').getBoundingClientRect();return {x:rect.left+16,y:rect.top+rect.height/2};})()');
  const openTaskMenu = async () => {
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rowPoint });
    await click(more);
    await visible(menu);
  };
  await openTaskMenu();
  await click('.desktop-section-heading h2');
  await menuClosed();
  await openTaskMenu();
  await click(more);
  await menuClosed();
  await openTaskMenu();
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await menuClosed();
  await openTaskMenu();
  await evaluate("import('/src/store/appStore.ts').then(({useAppStore})=>useAppStore.getState().toggleSidebar())");
  await menuClosed();
  await click('.desktop-rail [aria-label="展开模块列表"]');
  await visible(taskRow);

  await click('.space-chevron', '收起交付空间');
  const filterToggle = '.task-filter-toggle';
  const taskSearch = '.task-filter-controls input[aria-label="搜索任务"]';
  await click(filterToggle);
  await until(() => evaluate(`document.activeElement?.matches(${JSON.stringify(taskSearch)})`), 'filter opens with the task search focused');
  await rpc('Input.insertText', { text: '  空间内  ' });
  const foundTask = '.task-item[title^="空间内的任务"]';
  await visible(foundTask);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".desktop-task-tree .task-item-title")].map(node => node.textContent)'), ['空间内的任务']);
  assert(await evaluate(`(() => {
    const controls = document.querySelector('.task-filter-controls').getBoundingClientRect();
    const row = document.querySelector(${JSON.stringify(foundTask)});
    const rect = row.getBoundingClientRect();
    return rect.top >= controls.bottom && row.contains(document.elementFromPoint(rect.x + 26, rect.y + rect.height / 2));
  })()`), 'live search results are visible and clickable below the filter controls');
  await evaluate('document.querySelector(\'.task-filter-controls select[aria-label="筛选状态"]\').focus()');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await until(() => evaluate('document.querySelector(".desktop-task-tree .sidebar-empty")?.textContent === "没有符合筛选条件的任务"'), 'title search combines with status filter');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await visible(foundTask);
  await screenshot('task-search-filter');
  await click(foundTask + " .task-mode-icon");
  await until(() => evaluate("import('/src/store/appStore.ts').then(({useAppStore})=>useAppStore.getState().activeTaskId==='task-tree-child-fixture')"), 'matching task opens normally');
  await click('.task-filter-controls button', '清除搜索');
  await until(() => evaluate('document.querySelector(\'.space-chevron[aria-label="展开交付空间"]\')?.getAttribute("aria-expanded") === "false" && !document.querySelector(\'[title^="空间内的任务"]\')'), 'clearing search restores the original collapsed workspace');
  await click(filterToggle);
  await visible(taskRow);

  const categoryButtons = '.desktop-results-categories button';
  const expectResults = async (names) => {
    const expected = [...names].sort();
    await until(async () => JSON.stringify(await evaluate(
      '[...document.querySelectorAll(".files-file-label")].map(node=>node.textContent.trim()).sort()'
    )) === JSON.stringify(expected), 'visible results: ' + expected.join(', '));
  };
  await click('.desktop-rail-module', '任务成果');
  await expectResults(fixture.names);
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 960);
  await screenshot('task-results-categories');
  for (const [label, names] of [
    ['文档', ['月度总结.md', '核对日志.log']], ['表格', ['预算.csv']],
    ['演示文稿', ['汇报.pptx']], ['图片', ['流程.svg']], ['网页', ['预览.html']], ['压缩包', ['交付.zip.part2']],
  ]) {
    await click(categoryButtons, label);
    await expectResults(names);
    assert.equal(await evaluate('document.querySelector(".desktop-results-categories [aria-pressed=true]").textContent.trim()'), label);
  }
  await click(categoryButtons, '文档');
  await click('[aria-label="搜索任务成果"]');
  await rpc('Input.insertText', { text: '月度总结' });
  await expectResults(['月度总结.md']);
  await click(categoryButtons, '表格');
  await visible('.desktop-results .desktop-secondary-empty');
  await expectResults([]);
  await click(categoryButtons, '全部');
  await expectResults(['月度总结.md']);
  await click('.files-file-row[title="月度总结.md"]');
  await until(() => evaluate(`import('/src/store/appStore.ts').then(({useAppStore}) => {
    const state = useAppStore.getState();
    return state.activeTaskId === 'result-categories-fixture' && state.activeArtifactId === ${JSON.stringify(fixture.summaryId)};
  })`), 'result opens in its source task');

  await taskBoardCases();
  assert.deepEqual(report.rendererErrors, []);
  report.checks = { modules: routes.map(([label]) => label), column: [48, 200], draftRestored: true, usageRangeRestored: true, embeddedSearchKeyPools: true, nativeTabRestored: true, resultCategoryButtons: true, taskMenuDismissal: true, fullPageNotifications: true, treeLayout, taskSearch: true };
  report.checks.taskBoard = ['persisted lanes', 'hidden archives', 'pending answer', 'workspace filter', 'title search', 'open source task', 'scoped draft', 'daily focus', 'due date edit and clear', 'persistent pins', 'unread results after restart'];
  console.log('PASS desktop routes, task board, compact task column, task menu dismissal, task result categories and full-page notifications');
  async function taskBoardCases() {
    await evaluate(`(async () => {
      const db = window.api.db;
      const spaceId = 'board-delivery';
      await db.upsertSpace({id: spaceId, name: '产品交付'});
      await db.upsertSpace({id: 'board-archive', name: '旧项目'});
      await db.upsertSpace({id: 'board-archive-child', parentId: 'board-archive', name: '旧项目资料'});
      const rows = [
        ['board-review', '核对交付清单中的缺失文件', 'failed', spaceId],
        ['board-plan', '整理下周访谈提纲', 'planning', spaceId],
        ['board-run', '汇总本周用户反馈', 'in_progress', spaceId],
        ['board-done', '发布十一月版本说明', 'completed', spaceId],
        ['board-stop', '整理上一版原型', 'stopped', spaceId],
        ['board-audit', '检查移动端页面布局', 'in_progress', spaceId],
        ['board-archived', '已归档的任务', 'completed', spaceId],
        ['board-hidden', '归档空间中的任务', 'failed', 'board-archive-child'],
      ];
      const today = new Date().setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      for (const [index, [id, title, status, owner]] of rows.entries()) {
        const dueAt = id === 'board-audit' ? today : ['board-review', 'board-stop'].includes(id) ? yesterday.getTime() : undefined;
        await db.upsertTask({id, title, status, spaceId: owner, dueAt, updatedAt: Date.now() - index * 3600000});
      }
      await db.archiveTask('board-archived', true);
      await db.archiveSpace('board-archive', true);
    })()`);
    const boardDb = new (require('better-sqlite3'))(path.join(home,'.mybuddy','app.db'));
    const dayOffset = (offset) => {const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+offset);return d.getTime();};
    try {
      boardDb.transaction(()=>{
        const insert=boardDb.prepare("INSERT INTO tasks(id,title,status,updated_at) VALUES(?,?,'completed',?)");
        for(let i=0;i<1000;i++) insert.run('board-bulk-'+i,'例行运行 '+i,dayOffset(-30)-i);
        boardDb.prepare("UPDATE tasks SET updated_at=? WHERE id='board-run'").run(dayOffset(-45));
        boardDb.prepare("INSERT INTO conversation_interactions(id,task_id,execution_id,assistant_message_id,kind,title,status,created_at) VALUES('board-question','board-run','board-exec','board-msg','short_text','请确认反馈范围','pending',?)").run(dayOffset(-45));
        const signal=boardDb.prepare("INSERT INTO task_board_days VALUES(?,?,date(?/1000,'unixepoch','localtime'),?,?)");
        for(const offset of [-35,-3]) signal.run('board-plan','follow',dayOffset(offset),dayOffset(offset),'补充访谈提纲');
        signal.run('board-done','visit',dayOffset(-3),dayOffset(-3),'');
      })();
    } finally {boardDb.close();}
    await reloadDesktop();
    await metrics(1360, 800);
    await click('.desktop-rail-module', '任务看板');
    await visible('.task-board-card[title="核对交付清单中的缺失文件"]');
    assert.ok(await evaluate('document.querySelectorAll(".task-board-card").length < 25'));
    assert.equal(await evaluate('document.querySelectorAll(\'.task-board-card[title*="归档"]\').length'), 0);
    assert.equal(await evaluate('document.querySelectorAll(\'.task-board-card[title*="例行运行"]\').length'), 0);
    await click('.task-board-views button', '全部');
    const waitingCard = '.task-board-lane[data-lane="attention"] [title="汇总本周用户反馈"]';
    const finishedLane = '.task-board-lane[data-lane="finished"]';
    await visible(waitingCard);
    const finishedBefore = await evaluate(`Array.from(document.querySelectorAll('${finishedLane} .task-board-card'), card=>card.title)`);
    const finishedCount = await evaluate(`document.querySelector('${finishedLane} .task-board-count').textContent`);
    assert.equal(finishedBefore.length, 10);
    assert.ok(Number(finishedCount) >= 1002);
    await click(`${finishedLane} .task-board-pagination button`, '下一页');
    await visible(waitingCard);
    await until(()=>evaluate(`document.querySelector('${finishedLane} .task-board-card') && document.querySelector('${finishedLane} footer span').textContent==='第 2 页'`),'next page in the finished lane');
    assert.equal(await evaluate(`document.querySelector('${finishedLane} .task-board-count').textContent`), finishedCount);
    assert.notEqual(await evaluate(`document.querySelector('${finishedLane} .task-board-card').title`), finishedBefore[0]);
    await click('.task-board-views button', '我的焦点');
    await click('#desktop-module-list button[title="产品交付"]');
    await visible('.task-board-focus [data-section="recent"] .task-board-card');
    await screenshot('task-board-focus');
    async function select(label,value) {
      await evaluate(`(() => {const el=document.querySelector('select[aria-label="'+${JSON.stringify(label)}+'"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event("change",{bubbles:true}));})()`);
    }
    const secondary={'今日关注':'today','未读结果':'unread','已置顶':'pinned'};
    async function boardView(label){
      if(secondary[label]) await select('更多视图',secondary[label]);
      else await click('.task-board-views button',label);
      await until(()=>evaluate('!document.querySelector(".task-board-empty[role=status]")'),'loaded '+label);
    }
    await boardView('最近在做');
    await visible('[title="整理下周访谈提纲"]');
    assert.equal(await evaluate('document.querySelectorAll(".task-board-card").length'),1);
    await boardView('按日期查');
    await select('日期依据','due');
    await select('日期范围','today');
    await visible('.task-board-card[title="检查移动端页面布局"]');
    await click('.task-board-date-filters button','保存此筛选');
    await select('日期范围','next');
    await select('已存筛选','0');
    await visible('.task-board-card[title="检查移动端页面布局"]');
    await select('日期依据','follow');
    await select('日期范围','custom');
    const oldDay = new Date(dayOffset(-35));
    const dateInput = [oldDay.getFullYear(),String(oldDay.getMonth()+1).padStart(2,'0'),String(oldDay.getDate()).padStart(2,'0')].join('-');
    await evaluate(`(() => {
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      for(const label of ['开始日期','结束日期']) {const el=document.querySelector('input[aria-label="'+label+'"]');set.call(el,${JSON.stringify(dateInput)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
    })()`);
    await visible('.task-board-card[title="整理下周访谈提纲"]');
    const previous=await evaluate(`window.api.db.taskBoardPage({view:"dates",dateKind:"follow",from:${dayOffset(-35)-1},until:${dayOffset(-35)+1},scope:"board-delivery"})`);
    assert.deepEqual(previous.rows.map(r=>r.id),['board-plan'],'a later follow-up preserves the earlier date');
    const bulk=await evaluate(`(async()=>{const q={view:'all',search:'例行运行'};const first=await window.api.db.taskBoardPage(q);const second=await window.api.db.taskBoardPage({...q,cursor:first.next});return [first.rows,second.rows].map(rows=>rows.map(r=>r.id))})()`);
    assert.equal(bulk[0].length,25);assert.equal(bulk[1].length,25);assert.equal(new Set(bulk.flat()).size,50);
    await boardView('全部');
    const laneSizes=()=>evaluate('[...document.querySelectorAll(".task-board-lane")].map(lane=>lane.querySelectorAll(".task-board-card").length)');
    await visible('.task-board-lane[data-lane="attention"] [title="汇总本周用户反馈"]');
    assert.deepEqual(await laneSizes(),[2,1,1,2],'the month-old pending question remains actionable');
    assert.equal(await evaluate('document.querySelector(\'.task-board-card[title="整理上一版原型"] .task-board-status\').textContent'), '已停止');
    await boardView('今日关注');
    assert.deepEqual(await laneSizes(), [2, 0, 1, 0], 'due today, overdue and waiting for a reply need attention; stopped work does not');
    await boardView('未读结果');
    assert.deepEqual(await laneSizes(), [1, 0, 0, 1], 'new failures and completed results are unread');
    await boardView('全部');
    const planTitle = '整理下周访谈提纲';
    const openPlanDate = () => click('[aria-label="设置截止日期：整理下周访谈提纲"]');
    const planRow = () => evaluate("window.api.db.listTasks().then(rows=>rows.find(row=>row.id==='board-plan'))");
    const originalPlan = await planRow();
    await openPlanDate();
    const deadline = await evaluate(`(() => {
      const el = document.querySelector('.task-board-date-dialog input');
      const date = new Date(); date.setHours(0, 0, 0, 0);
      el.valueAsDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return date.getTime();
    })()`);
    await click('.task-board-date-dialog button', '保存');
    await until(() => evaluate('!document.querySelector(".task-board-date-dialog")'), 'saved deadline editor closed');
    await until(async () => (await planRow()).dueAt === deadline, 'saving the deadline writes it to the task row');
    assert.equal((await planRow()).updatedAt, originalPlan.updatedAt, 'scheduling preserves task activity time');
    await click('[aria-label="置顶：整理下周访谈提纲"]');
    await until(async () => (await planRow()).isFavorited === true, 'pin persists');
    await boardView('已置顶');
    assert.deepEqual(await laneSizes(), [0, 1, 0, 0]);
    assert.equal(await evaluate('document.querySelector(".task-board-card strong").textContent'), planTitle);
    await boardView('今日关注');
    assert.deepEqual(await laneSizes(), [2, 1, 1, 0], 'editing the date updates the current board without reloading');
    await boardView('全部');
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 70 });
    await evaluate('document.hidden || Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.target?.closest("#desktop-module-list")).map(a => a.finished.catch(() => {}))),new Promise(resolve=>setTimeout(resolve,750))])');
    await screenshot('task-board');
    await metrics(960, 640);
    assert.equal(await evaluate('document.documentElement.scrollWidth'), 960);
    const boardInput = '.task-board-search input';
    await click(boardInput);
    await rpc('Input.insertText', { text: '没有这个标题' });
    await visible('.task-board-no-results');
    await click('.task-board-no-results button', '清除搜索');
    await click(boardInput);
    await rpc('Input.insertText', { text: '版本说明' });
    await visible('.task-board-card[title="发布十一月版本说明"]');
    assert.deepEqual(await laneSizes(), [0, 0, 0, 1]);
    await click('.task-board-card[title="发布十一月版本说明"]');
    await until(() => evaluate("import('/src/store/appStore.ts').then(({useAppStore})=>useAppStore.getState().page==='chat' && useAppStore.getState().activeTaskId==='board-done')"), 'card opens its original task');
    await click('.desktop-rail-module', '任务看板');
    assert.equal(await evaluate('document.querySelector(".task-board-search input").value'), '版本说明', 'returning restores the board filters');
    await click('.task-board-tools button', '新建任务');
    await until(() => evaluate("import('/src/store/appStore.ts').then(({useAppStore})=>useAppStore.getState().page==='chat' && useAppStore.getState().draft?.spaceId==='board-delivery')"), 'new draft belongs to the selected workspace');
    await reloadDesktop();
    await click('.desktop-rail-module', '任务看板');
    await click('#desktop-module-list button[title="产品交付"]');
    await boardView('经常关注');
    await visible('.task-board-card[title="发布十一月版本说明"]');
    assert.match(await evaluate('document.querySelector(".task-board-why").textContent'),/2 天/);
    await boardView('已置顶');
    await visible('.task-board-card[title="整理下周访谈提纲"] time[data-urgent="true"]');
    await openPlanDate();
    await click('.task-board-date-dialog button', '清除日期');
    await click('.task-board-date-dialog button', '取消');
    assert.equal((await planRow()).dueAt, deadline, 'cancel preserves the deadline');
    await openPlanDate();
    await click('.task-board-date-dialog button', '清除日期');
    await click('.task-board-date-dialog button', '保存');
    await until(() => evaluate('!document.querySelector(".task-board-date-dialog")'), 'cleared deadline editor closed');
    await until(async () => (await planRow()).dueAt == null, 'clearing is persisted');
    await boardView('未读结果');
    assert.deepEqual(await laneSizes(), [1, 0, 0, 0], 'reading a result acknowledges it across renderer restarts');
    await boardView('全部');
    await click('[aria-label="置顶：发布十一月版本说明"]');
    await until(() => evaluate("window.api.db.listTasks().then(rows=>rows.find(row=>row.id==='board-done')?.isFavorited)"), 'previously read task pinned with cold history');
    await boardView('未读结果');
    assert.deepEqual(await laneSizes(), [1, 0, 0, 0], 'pinning a read task with unloaded history does not create an unread result');

    // 每一栏都渲染 4 张卡；第 5 个起必须显式提示被折叠，且提示能展开完整列表。
    await evaluate(`(async()=>{for(const [i,id] of ['fresh-run-a','fresh-run-b','fresh-run-c','fresh-run-d','fresh-run-e'].entries())
      await window.api.db.upsertTask({id,title:'新执行 '+id,status:'in_progress',spaceId:'board-delivery',updatedAt:Date.now()+i});})()`);
    const reviewDb = new (require('better-sqlite3'))(path.join(home,'.mybuddy','app.db'));
    try {
      const insertReview = reviewDb.prepare(`INSERT OR REPLACE INTO task_code_review(
        task_id,target_key,root_entity,path,relative_path,id,status,before_present,before_stamp,after_present,after_stamp,additions,deletions,stats_available,restoring)
        VALUES(?,?,?,?,?,?,'pending',0,'missing',1,'after',1,0,1,0)`);
      for (const id of ['fresh-run-a','fresh-run-b','fresh-run-c','fresh-run-d','fresh-run-e','board-done'])
        insertReview.run(id, 'board-review-'+id, 'board-review', 'C:/board/'+id+'.txt', id+'.txt', 'board-review-'+id);
    } finally {reviewDb.close();}
    const runningPreview = await evaluate(`window.api.db.taskBoardPage({view:'running',preview:true,scope:'board-delivery'}).then(page=>({total:page.total,rows:page.rows.length}))`);
    assert.equal(runningPreview.rows, 4, 'the running preview stays bounded at four cards');
    assert.ok(runningPreview.total > 4, 'the running preview reports the real total');
    const reviewPreview = await evaluate(`window.api.db.taskBoardPage({view:'review',preview:true,scope:'board-delivery'}).then(page=>({total:page.total,rows:page.rows.length}))`);
    assert.equal(reviewPreview.rows, 4, 'the review preview stays bounded at four cards');
    assert.equal(reviewPreview.total, 6, 'six tasks carry pending changes');
    await reloadDesktop();
    await click('.desktop-rail-module', '任务看板');
    await click('#desktop-module-list button[title="产品交付"]');
    await click('.task-board-views button', '我的焦点');
    const column = (name) => `[data-section="${name}"]`;
    const columnCards = (name) => evaluate(`document.querySelectorAll('.task-board-focus ${column(name)} .task-board-card').length`);
    const columnCount = (name) => evaluate(`document.querySelector('${column(name)} .task-board-count')?.textContent`);
    const columnHint = (name) => evaluate(`document.querySelector('${column(name)} .task-board-folded')?.textContent ?? ""`);
    await visible(`.task-board-focus ${column('review')} .task-board-card`);
    assert.equal(await columnCards('review'), 4, '待审查的改动 renders four cards');
    assert.equal(await columnCount('review'), String(reviewPreview.total), 'the review column header shows the real total');
    assert.match(await columnHint('review'), /还有 \d+ 个被折叠/, 'the review column says how many cards are folded');
    await visible(`.task-board-focus ${column('running')} .task-board-card`);
    assert.equal(await columnCards('running'), 4, '正在执行 renders four cards instead of the old two');
    assert.equal(await columnCount('running'), String(runningPreview.total), 'the running column header shows the real total');
    assert.match(await columnHint('running'), /还有 \d+ 个被折叠/, 'the running column says how many cards are folded');
    await metrics(1360, 1200);
    await evaluate('document.querySelector(".task-board-focus")?.scrollTo?.(0,0)');
    await screenshot('task-board-focus-four-cards');
    await click(`${column('running')} .task-board-folded`);
    await until(
      () => evaluate(`document.querySelectorAll('.task-board-list .task-board-card').length===${runningPreview.total}`),
      'the folded hint opens the complete running list',
    );

    await evaluate(`(async () => {
      const db = window.api.db;
      await db.upsertSpace({id: 'board-recent-review', name: '交付审查'});
      await db.upsertSpace({id: 'board-recent-research', name: '市场调研'});
      const result = await db.createProject({name: '新版交付'});
      if (!result.ok) throw Error('Could not create the board test project');
      const rows = [
        ['recent-review', '核对上线要求', 'board-recent-review', result.project.id],
        ['recent-research', '整理市场数据', 'board-recent-research'],
        ['recent-delivery', '确认交付日期', 'board-delivery', result.project.id],
        ['recent-independent', '记录个人待办', null],
      ];
      for (const [id, title, spaceId, projectId] of rows)
        await db.upsertTask({id, title, spaceId, projectId, status: 'completed', updatedAt: Date.now()});
    })()`);
    const recentDb = new (require('better-sqlite3'))(path.join(home, '.mybuddy', 'app.db'));
    try {
      const note = recentDb.prepare("INSERT INTO task_board_days VALUES(?,'follow',date(?/1000,'unixepoch','localtime'),?,'测试跟进')");
      const time = Date.now();
      for (const [index, id] of ['recent-review', 'recent-research', 'recent-delivery', 'recent-independent'].entries()) {
        const at = time - index * 1000;
        note.run(id, at, at);
      }
    } finally { recentDb.close(); }
    await reloadDesktop();
    await click('.desktop-rail-module', '任务看板');
    await click('#desktop-module-list button', '全部任务');
    await boardView('我的焦点');
    const recent = '[data-section="recent"]';
    const grouping = (area) => evaluate(`[...document.querySelectorAll(${JSON.stringify(area + ' .task-board-recent-group')})]
      .map(group => [group.querySelector('h3').textContent, [...group.querySelectorAll('.task-board-card')].map(card => card.title)])`);
    const expected = [
      ['新版交付', ['核对上线要求', '确认交付日期']],
      ['市场调研', ['整理市场数据']],
      ['独立任务', ['记录个人待办']],
    ];
    await visible(recent + ' .task-board-card[title="核对上线要求"]');
    assert.deepEqual(await grouping(recent), expected);
    for (const width of [1090, 880, 540]) {
      await metrics(width, 620);
      const violations = await evaluate(`(() => {
        const lanes = [...document.querySelectorAll('.task-board-focus > .task-board-lane')];
        const bounds = lanes.map(lane => lane.getBoundingClientRect());
        return lanes.flatMap((lane, index) => {
          const box = bounds[index];
          const outside = [...lane.querySelectorAll('.task-board-item')].some(item => item.getBoundingClientRect().bottom > box.bottom + 1);
          const overlaps = bounds.slice(index + 1).some(next => box.left < next.right && next.left < box.right && box.top < next.bottom && next.top < box.bottom);
          return outside || overlaps ? [lane.dataset.section] : [];
        });
      })()`);
      assert.deepEqual(violations, [], `focus lane and card bounds are disjoint at ${width}px`);
    }
    await metrics(1090, 720);
    await screenshot('task-board-no-overlap');
    await boardView('最近在做');
    await visible('.task-board-list .task-board-card[title="核对上线要求"]');
    assert.deepEqual((await grouping('.task-board-list')).slice(0, 3), expected);
    await screenshot('task-board-recent-projects');
  }
}, { name: process.argv.includes('--task-board') ? 'task-board-desktop' : 'mode-navigation-desktop',
  watchRenderer: !process.argv.includes('--task-board'),
  fixtureModel: process.argv.includes('--task-board') ? (request) => {
    const lastUser = request.messages.findLastIndex(message => message.role === 'user');
    const asked = request.messages.slice(lastUser + 1).some(message => message.role === 'tool');
    if ((JSON.stringify(request.messages[lastUser]?.content) ?? '').includes('运输费用') && !asked) {
      return { tool: { name: 'request_user_input', arguments: { title: '使用含税报价来核对运费吗？', kind: 'confirm' } } };
    }
    return '已核对运输费用。';
  } : undefined });
