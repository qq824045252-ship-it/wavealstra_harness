/** Visible Electron coverage for the desktop shell, using a disposable user profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { run } = require('./desktop-dev-harness.cjs');

const routes = [
  ['MyBuddy', 'chat'], ['笔记', 'library'], ['项目', 'projects'],
  ['自动化', 'automation'], ['扩展', 'experts'], ['工作台', 'gadgets'],
  ['任务成果', 'files'], ['用量统计', 'usage'],
];

run(async ({ evaluate, rpc, until, report, out, home }) => {
  async function click(selector, label) {
    const expression = '(() => {const matches = [...document.querySelectorAll(' + JSON.stringify(selector) + ')]; return matches.find(node=>node.getClientRects().length' +
      (label == null ? '' : ' && (node.getAttribute("aria-label") || node.textContent.trim()) === ' + JSON.stringify(label)) + ');})()';
    await until(() => evaluate('Boolean(' + expression + ')'), label ?? selector);
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
  await click(foundTask);
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

  assert.deepEqual(report.rendererErrors, []);
  report.checks = { modules: routes.map(([label]) => label), column: [48, 200], draftRestored: true, usageRangeRestored: true, embeddedSearchKeyPools: true, nativeTabRestored: true, resultCategoryButtons: true, taskMenuDismissal: true, fullPageNotifications: true, treeLayout, taskSearch: true };
  console.log('PASS desktop routes, compact task column, task menu dismissal, task result categories and full-page notifications');
}, { name: 'mode-navigation-desktop' });
