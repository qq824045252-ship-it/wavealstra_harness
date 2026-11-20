const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xlsx = require('xlsx');
const { run } = require('./desktop-dev-harness.cjs');

const initial = '请依据预算明细逐项复核报销凭据';
const neighbor = '邻近单元格保留原文';
const proposal = '请核对预算与报销凭据';
const replacement = '请核对预算明细及报销凭据';
const instruction = '精简所选单元格，保留核对预算和报销凭据的要求。';
const reviewedText = '请逐项核对预算及报销凭据';
const assistantOn = 'OFFICE_USE_AGENT_ENABLED';
const assistantOff = 'OFFICE_USE_AGENT_DISABLED';
const remoteCellText = '保留原始记录 6499';
const summarySheet = '财务明细';
const sourceSheet = '原始数据';

function checkWorkbook(input, expected, expectedRemoteCell = remoteCellText) {
  const workbook = xlsx.read(input);
  assert.deepEqual(workbook.SheetNames, [summarySheet, sourceSheet]);
  assert.equal(workbook.Sheets[summarySheet].A1.v, expected);
  assert.equal(workbook.Sheets[summarySheet].B1.v, neighbor);
  assert.equal(workbook.Sheets[sourceSheet].B6500.v, expectedRemoteCell);
}

run(async ({ evaluate, rpc, until, report, out, home, requests }) => {
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const officeRow = '[data-capability-id="office-use"]';
  await click('button[title="设置"]');
  await until(() => evaluate(`Boolean([...document.querySelectorAll('.settings-nav-btn')].find(node => node.textContent.trim() === '工具能力'))`), 'tool settings navigation');
  await evaluate(`[...document.querySelectorAll('.settings-nav-btn')].find(node => node.textContent.trim() === '工具能力').click()`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(officeRow)}))`), 'Office Use capability row');
  await evaluate(`document.querySelector(${JSON.stringify(officeRow)}).closest('details').open = true`);
  await click(officeRow + ' .capability-status-details > summary');
  await click(officeRow + ' .capability-check-btn');
  await until(async () => Boolean(await evaluate(`document.querySelector(${JSON.stringify(officeRow + ' .capability-check-result')})?.textContent`)), 'Office Use check result');
  const checked = await evaluate(`document.querySelector(${JSON.stringify(officeRow + ' .capability-check-result')}).textContent`);
  assert.match(checked, /本地资源校验通过：Word \(DOCX\)、Excel \(XLSX\)、PowerPoint \(PPTX\)/);
  assert.equal(requests.length, 0, 'checking Office Use does not invoke a model');
  for (const enabled of [false, true]) {
    await click(officeRow + ' .switch');
    await click('.capabilities-footer .btn.primary');
    await until(() => evaluate(`window.api.agent.getBuiltinCapabilities().then(s => s.config.officeUse.enabled === ${enabled})`), 'Office Use switch saved');
    await until(() => evaluate(`!document.querySelector('.capabilities-page .switch[aria-label="Office Use开关"]').disabled`), 'Office Use settings save complete');
  }
  await click('.settings-content-head .icon-btn');
  await until(() => evaluate('!document.querySelector(".settings-modal")'), 'settings closed');
  report.checks.push('Settings exposed Office Use, checked all three local engines without the fixture model, and persisted the switch in both directions');

  const workspace = path.join(home, 'office-workspace');
  fs.mkdirSync(workspace);
  const filename = '中文预算复核.xlsx';
  const file = path.join(workspace, filename);
  const drafts = path.join(home, '.mybuddy', 'office-drafts');
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([[initial, neighbor]]), summarySheet);
  const rows = Array.from({ length: 6500 }, (_, i) => [i, '保留原始记录 ' + i]);
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(rows), sourceSheet);
  const original = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(file, original);
  report.officeInputBytes = original.length;
  assert.ok(report.officeInputBytes > 500 * 1024, 'fixture exercises the former Office preview limit');

  await rpc('Emulation.clearDeviceMetricsOverride');
  await evaluate(`(async () => {
    const { useAppStore: store } = await import('/src/store/appStore.ts');
    const model = store.getState().models[0];
    const task = { id: 'office-use-desktop', title: 'Office Use acceptance', updatedAt: Date.now(),
      cwd: ${JSON.stringify(workspace)}, status: 'idle', welcomeMode: 'working', executionBackend: 'pi',
      messages: [{ id: 'seed', role: 'assistant', createdAt: Date.now(), blocks: [{type:'text', content:'Office acceptance'}] }] };
    await window.api.db.upsertTask(task);
    store.setState({ page: 'chat', activeTaskId: task.id, tasks: [task], activeModelId: model.id,
      panelOpen: true, panelMode: 'overview', panelExpanded: true, draft: null });
    window.officeFixtureStore = store;
    await store.getState().openWorkspaceFile(${JSON.stringify(filename)}, ${JSON.stringify(filename)});
    await store.getState().hydrateArtifacts(task.id);
  })()`);
  const artifact = await evaluate('window.officeFixtureStore.getState().activeArtifactId');
  assert.ok(artifact, 'the workspace action registered and opened the spreadsheet');
  report.checks.push('Workspace file opened through the production task store and artifact registration');

  let previousTarget;
  let session;
  async function view(expression) {
    const response = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }
  async function attach() {
    let target;
    await until(async () => {
      const { targetInfos } = await rpc('Target.getTargets');
      target = targetInfos.find(info => info.targetId !== previousTarget && /\/session\/[\w-]+\/$/.test(info.url));
      return Boolean(target);
    }, 'native Office WebContentsView');
    previousTarget = target.targetId;
    ({ sessionId: session } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    await rpc('Runtime.enable', {}, session);
    await rpc('Page.enable', {}, session);
    await until(async () => {
      const state = await view("document.getElementById('editor') && ({ready: document.getElementById('editor').getAttribute('aria-busy') === 'false', status: document.getElementById('status').textContent, isolated: crossOriginIsolated})");
      if (!state) return false;
      if (!state.ready && state.status !== '正在打开文档…') {
        report.officeFrameFailure = await view(`(() => {
          const editor = document.getElementById('editor').contentWindow;
          return [window, editor, editor.frames[0]].filter(Boolean).map(frame => ({
            url: frame.location.href, isolated: frame.crossOriginIsolated, state: frame.document.readyState,
            visible: frame.document.visibilityState, width: frame.innerWidth, height: frame.innerHeight,
            engine: Boolean(frame.gridcraft),
            loading: frame.document.getElementById('gridcraft_loading')?.textContent,
            resources: frame.performance.getEntriesByType('resource').map(({name,responseStatus}) => ({name,responseStatus}))
          }));
        })()`);
        throw Error('GridCraft: ' + state.status);
      }
      return state.ready && state.isolated;
    }, 'GridCraft WASM ready');
  }
  const snapshot = async name => {
    const { data } = await rpc('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data, 'base64'));
  };
  const button = id => view(`document.getElementById(${JSON.stringify(id)}).click(); true`);
  const setField = (id, value) => view(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  async function readA1(expected) {
    const api = "document.getElementById('editor').contentWindow.frames[0].gridcraft";
    await view(`${api}.request('ui.cell.click', { cell: 'A1' })`);
    await until(() => view(`${api}.docInspect().then(book => book.selection === 'A1')`), 'GridCraft selected A1');
    const glyphs = await view(`${api}.request('mybuddy.activeCellGlyphs', {})`);
    assert.deepEqual(glyphs, { text: expected, missing: '' });
    await view("window.officeSelection()");
    await until(() => view("!document.querySelector('#panel').hidden"), 'selected GridCraft cell');
    const selected = await view("document.querySelector('#original').value");
    assert.equal(selected, expected, 'The MyBuddy panel captured the active GridCraft cell');
  }
  async function close() {
    await evaluate(`window.officeFixtureStore.getState().closeArtifactTab(${JSON.stringify(artifact)})`);
    await until(async () => !(await rpc('Target.getTargets')).targetInfos.some(info => info.targetId === previousTarget), 'Office view destroyed');
  }
  async function reopen() {
    await evaluate(`window.officeFixtureStore.getState().openArtifact(${JSON.stringify(artifact)})`);
    await attach();
  }

  await attach();
  await readA1(initial);
  await setField('instruction', instruction);
  await button('generate');
  await until(() => view("document.querySelector('#candidate').value === " + JSON.stringify(proposal)), 'AI proposal ready for review');
  assert.equal(requests.length, 1);
  assert.deepEqual(fs.readFileSync(file), original);
  await snapshot('proposal');
  report.checks.push('The MyBuddy pane captured the Chinese GridCraft cell and showed the model relay response while the workspace file stayed byte-identical');

  await setField('candidate', replacement);
  await button('apply');
  await until(() => view("document.querySelector('#status').textContent === '草稿已保留'"), 'Office autosaved draft');
  const draftsNow = fs.readdirSync(drafts).filter(name => name.endsWith('.draft'));
  assert.equal(draftsNow.length, 1);
  const draft = fs.readFileSync(path.join(drafts, draftsNow[0])).subarray(64);
  checkWorkbook(draft, replacement);
  assert.deepEqual(fs.readFileSync(file), original);
  report.checks.push('Approved proposal edited A1 and created a binary XLSX draft; source bytes retained the original A1');

  await close();
  await reopen();
  assert.match(await view("document.querySelector('#status').textContent"), /已恢复草稿/);
  await readA1(replacement);
  await button('cancel');
  await view("frames[0].frames[0].gridcraft.execute('file.save', {})");
  await until(() => view("document.querySelector('#status').textContent === '已保存'"), 'Office saved original workbook');
  checkWorkbook(fs.readFileSync(file), replacement);
  assert.equal(fs.readdirSync(drafts).filter(name => name.endsWith('.draft')).length, 0);
  report.checks.push('Reopening recovered the unsaved edit, and Save wrote the confirmed replacement to the workspace workbook');

  await close();
  await reopen();
  await readA1(replacement);
  await snapshot('reopened');
  const sendOfficePrompt = async text => {
    const request = { taskId: 'office-use-desktop', modelId: 'fixture/ui-fixture', text, welcomeMode: 'working',
      userMessageId: text + '-user', assistantMessageId: text + '-assistant' };
    const completed = await evaluate(`window.api.agent.prompt(${JSON.stringify(request)}).then(result => result.receipt ? window.api.agent.waitForSubmission(result.receipt) : result)`);
    assert.equal(completed.error, undefined, JSON.stringify(completed));
    assert.equal(completed.receipt?.status, 'done');
  };
  await sendOfficePrompt(assistantOn);
  assert.equal(await view("document.querySelector('#candidate').value"), reviewedText);
  assert.equal(await view("document.querySelector('#label').textContent"), sourceSheet + ' · B6500');
  checkWorkbook(fs.readFileSync(file), replacement);
  await button('apply');
  await until(() => view("document.querySelector('#status').textContent === '草稿已保留'"), 'targeted proposal creates a draft only after confirmation');
  checkWorkbook(fs.readFileSync(file), replacement);
  await view("frames[0].frames[0].gridcraft.execute('file.save', {})");
  await until(() => view("document.querySelector('#status').textContent === '已保存'"), 'targeted cross-sheet change saved');
  checkWorkbook(fs.readFileSync(file), replacement, reviewedText);
  await evaluate(`(async () => {
    const { config, revision } = await window.api.agent.getBuiltinCapabilities();
    await window.api.agent.saveBuiltinCapabilitySettings({ config: { ...config, officeUse: { enabled: false } }, expectedRevision: revision });
  })()`);
  await sendOfficePrompt(assistantOff);
  assert.equal(await view("document.querySelector('#panel').hidden"), true);
  report.checks.push('The task inspected the workbook, found B6500 on another sheet, read it, and staged a targeted proposal without manual selection. Only confirmation and Save changed B6500 on disk. Disabling Office Use removed all Office tools from the next model request');
  await close();
  report.checks.push('A fresh GridCraft view rendered the saved Chinese text from the workspace workbook');
}, {
  name: 'office-use-desktop',
  settings: { permissionMode: 'default' },
  watchRenderer: false,
  fixtureModel(request) {
    const message = request.messages.at(-1);
    const userMessage = request.messages.findLast(item => item.role === 'user');
    const lastInput = JSON.stringify(userMessage?.content);
    const tools = request.tools?.map(entry => entry.function.name) ?? [];
    const officeTools = ['office_document_read', 'office_selection_read', 'office_selection_propose'];
    if (lastInput?.includes(assistantOff)) {
      assert(officeTools.every(name => !tools.includes(name)));
      return 'Office Use is disabled.';
    }
    if (lastInput?.includes(assistantOn)) {
      assert(officeTools.every(name => tools.includes(name)));
      const target = { kind: 'excel', sheet: sourceSheet, address: 'B6500' };
      if (message.role === 'user') return { tool: { name: 'office_document_read', arguments: { action: 'inspect' } } };
      assert.equal(message.role, 'tool');
      const result = JSON.parse(message.content);
      if (result.activeSheet) {
        assert.equal(result.activeSheet, summarySheet);
        assert(result.items.some(item => item.name === sourceSheet));
        return { tool: { name: 'office_document_read', arguments: { action: 'find', query: remoteCellText } } };
      }
      if (result.items?.[0]?.address) {
        assert.deepEqual(result.items, [{ sheet: sourceSheet, address: 'B6500', preview: remoteCellText }]);
        return { tool: { name: 'office_document_read', arguments: { action: 'read', target } } };
      }
      if (result.firstRow) {
        assert.deepEqual(result.items, [[remoteCellText]]);
        return { tool: { name: 'office_selection_read', arguments: { target } } };
      }
      if (result.captureId) {
        assert.equal(result.content, remoteCellText);
        assert.equal(result.target.sheet, sourceSheet);
        assert.equal(result.target.address, 'B6500');
        return { tool: { name: 'office_selection_propose', arguments: { captureId: result.captureId, text: reviewedText } } };
      }
      assert.deepEqual(result, { status: 'awaiting-user-review' });
      return '已提交改写建议。';
    }
    const data = JSON.parse(message.content);
    const selection = JSON.parse(data.officeSelection);
    assert.equal(data.instruction, instruction);
    assert.equal(selection.content, initial);
    assert.equal(selection.target.sheet, summarySheet);
    assert.equal(selection.target.address, 'A1');
    return proposal;
  },
});
