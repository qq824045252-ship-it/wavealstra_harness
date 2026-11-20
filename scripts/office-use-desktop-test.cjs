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
const assistantVerify = 'OFFICE_USE_VERIFY_RECEIPT';
const assistantEdit = 'OFFICE_USE_FREEZE_HEADER';
const assistantSkill = 'OFFICE_USE_READ_SKILL';
const assistantCreate = 'OFFICE_USE_CREATE_THREE_FILES';
const creation = [
  { path: '新建纪要.docx', content: { kind: 'word', title: '复核纪要', sections: [{
    heading: '结论', paragraphs: ['资料已备齐。'], bullets: ['复查票据'],
    table: { headers: ['事项', '状态'], rows: [['报销', '已核对']] },
  }] } },
  { path: '新建预算.xlsx', content: { kind: 'excel', sheets: [{ name: '预算', rows: [[4, 8, { formula: '=A1+B1' }]] }] } },
  { path: '新建简报.pptx', content: { kind: 'ppt', slides: [{ title: '预算简报', bullets: ['核实凭据'], notes: '重点检查报销。' }] } },
];
const created = [];
let selectionProposalId;
let structuralProposalId;
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
  const sendOfficePrompt = async text => {
    const request = { taskId: 'office-use-desktop', spaceId: 'office-use-space', modelId: 'fixture/ui-fixture', text, welcomeMode: 'working',
      userMessageId: text + '-user', assistantMessageId: text + '-assistant' };
    const completed = await evaluate(`window.api.agent.prompt(${JSON.stringify(request)}).then(result => result.receipt ? window.api.agent.waitForSubmission(result.receipt) : result)`);
    assert.equal(completed.error, undefined, JSON.stringify(completed));
    assert.equal(completed.receipt?.status, 'done');
  };
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
    const space = { id: 'office-use-space', name: 'Office acceptance workspace', path: ${JSON.stringify(workspace)}, createdAt: Date.now(), updatedAt: Date.now() };
    const task = { id: 'office-use-desktop', spaceId: space.id, title: 'Office Use acceptance', updatedAt: Date.now(),
      cwd: ${JSON.stringify(workspace)}, status: 'idle', welcomeMode: 'working', executionBackend: 'pi',
      messages: [{ id: 'seed', role: 'assistant', createdAt: Date.now(), blocks: [{type:'text', content:'Office acceptance'}] }] };
    await window.api.db.upsertSpace(space);
    await window.api.db.upsertTask(task);
    store.setState({ page: 'chat', activeTaskId: task.id, tasks: [task], spaces: [space], activeModelId: model.id,
      panelOpen: true, panelMode: 'overview', panelExpanded: true, draft: null });
    window.officeFixtureStore = store;
  })()`);

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
            engine: Boolean(frame.wordcraft || frame.gridcraft || frame.deckcraft),
            resources: frame.performance.getEntriesByType('resource').map(({name,responseStatus}) => ({name,responseStatus}))
          }));
        })()`);
        throw Error('Office editor: ' + state.status);
      }
      return state.ready && state.isolated;
    }, 'Office editor WASM ready');
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
  async function close(id = artifact) {
    await evaluate(`window.officeFixtureStore.getState().closeArtifactTab(${JSON.stringify(id)})`);
    await until(async () => !(await rpc('Target.getTargets')).targetInfos.some(info => info.targetId === previousTarget), 'Office view destroyed');
  }
  async function reopen() {
    await evaluate(`window.officeFixtureStore.getState().openArtifact(${JSON.stringify(artifact)})`);
    await attach();
  }

  await sendOfficePrompt(assistantSkill);
  await sendOfficePrompt(assistantCreate);
  assert.equal(created.length, creation.length);
  await evaluate("window.officeFixtureStore.getState().hydrateArtifacts('office-use-desktop')");
  for (const entry of created) {
    assert.equal(path.dirname(entry.path), fs.realpathSync(workspace));
    assert(fs.existsSync(entry.path));
    await evaluate(`window.officeFixtureStore.getState().openArtifact(${JSON.stringify(entry.artifactId)})`);
    await attach();
    const document = query => view(`window.officeDocument(${JSON.stringify(query)})`);
    const outline = await document({ action: 'inspect' });
    if (outline.kind === 'word') {
      assert(outline.items.some(item => item.preview === '资料已备齐。'));
      assert(outline.items.some(item => item.preview === '复查票据' && item.list));
      const table = outline.items.find(item => item.type === 'table');
      assert.deepEqual((await document({ action: 'read', target: { kind: 'word', blockIndex: table.blockIndex } })).items,
        [['事项', '状态'], ['报销', '已核对']]);
    }
    else if (outline.kind === 'excel') {
      const formula = await document({ action: 'read', target: { kind: 'excel', sheet: '预算', address: 'C1', values: 'formulas' } });
      assert.deepEqual(formula.items, [['=A1+B1']]);
      const value = await document({ action: 'read', target: { kind: 'excel', sheet: '预算', address: 'C1' } });
      assert.deepEqual(value.items, [[12]]);
    } else {
      assert.equal(outline.kind, 'ppt');
      const slide = await document({ action: 'read', target: { kind: 'ppt', slideIndex: 0 } });
      assert(slide.items.some(item => item.preview?.includes('预算简报')));
      assert.match(slide.notesPreview, /重点检查报销/);
    }
    await close(entry.artifactId);
  }
  report.checks.push('A task without an open document created three Office artifacts. All opened in their native editor with Chinese content, working formula or speaker notes. A duplicate filename was rejected');

  await evaluate(`(async () => {
    const store = window.officeFixtureStore;
    await store.getState().openWorkspaceFile(${JSON.stringify(filename)}, ${JSON.stringify(filename)});
    await store.getState().hydrateArtifacts('office-use-desktop');
  })()`);
  const artifact = await evaluate('window.officeFixtureStore.getState().activeArtifactId');
  assert.ok(artifact, 'the workspace action registered and opened the spreadsheet');
  report.checks.push('Workspace file opened through the production task store and artifact registration');

  await attach();
  await readA1(initial);
  await setField('instruction', instruction);
  const previousRequests = requests.length;
  await button('generate');
  await until(() => view("document.querySelector('#candidate').value === " + JSON.stringify(proposal)), 'AI proposal ready for review');
  assert.equal(requests.length, previousRequests + 1);
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
  await sendOfficePrompt(assistantOn);
  const receipt = id => view(`window.officeReviewStatus(${JSON.stringify(id)})`);
  assert.equal((await receipt(selectionProposalId)).status, 'awaiting-user-review');
  assert.equal(await view("document.querySelector('#candidate').value"), reviewedText);
  assert.equal(await view("document.querySelector('#label').textContent"), sourceSheet + ' · B6500');
  checkWorkbook(fs.readFileSync(file), replacement);
  await button('apply');
  await until(() => view("document.querySelector('#status').textContent === '草稿已保留'"), 'targeted proposal creates a draft only after confirmation');
  const applied = await receipt(selectionProposalId);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.verification, { matched: true, sheet: sourceSheet, address: 'B6500', errors: [] });
  checkWorkbook(fs.readFileSync(file), replacement);
  await view("frames[0].frames[0].gridcraft.execute('file.save', {})");
  await until(() => view("document.querySelector('#status').textContent === '已保存'"), 'targeted cross-sheet change saved');
  checkWorkbook(fs.readFileSync(file), replacement, reviewedText);
  await sendOfficePrompt(assistantVerify);
  await sendOfficePrompt(assistantEdit);
  assert.equal((await receipt(structuralProposalId)).status, 'awaiting-user-review');
  assert.equal(await view("document.querySelector('#candidate').readOnly"), true);
  await button('cancel');
  assert.equal((await receipt(structuralProposalId)).status, 'cancelled');
  report.checks.push('The live task observed a verified applied edit and then its saved receipt. A separate structural suggestion was cancelled without applying it');
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
    const officeTools = ['office_document_create', 'office_document_read', 'office_document_render',
      'office_edit_propose', 'office_review_status', 'office_selection_read', 'office_selection_propose'];
    const system = request.messages.filter(item => item.role === 'system').map(item => JSON.stringify(item.content)).join('\n');
    if (lastInput?.includes(assistantSkill)) {
      const folder = path.resolve(__dirname, '../vendor/craft-office/skill/office-use');
      const read = file => ({ tool: { name: 'read', arguments: { path: path.join(folder, file) } } });
      if (message.role === 'user') {
        assert.match(system, /office-use[/\\]+SKILL\.md/);
        return read('SKILL.md');
      }
      if (message.content.includes('references/excel.md')) return read('references/excel.md');
      assert.match(message.content, /GridCraft/);
      assert.match(message.content, /action:"evaluate"/);
      return '已读取 Excel 操作指南。';
    }
    if (lastInput?.includes(assistantCreate)) {
      assert(officeTools.every(name => tools.includes(name)));
      assert.match(system, /office-use[/\\]+SKILL\.md/);
      const userIndex = request.messages.lastIndexOf(userMessage);
      const toolResults = request.messages.slice(userIndex + 1).filter(item => item.role === 'tool');
      const step = toolResults.length;
      if (step && step <= creation.length) {
        const result = JSON.parse(message.content);
        assert.equal(result.status, 'created');
        assert.equal(result.name, creation[step - 1].path);
        assert(result.artifactId);
        created.push(result);
      }
      if (step > creation.length) {
        assert.match(message.content, /已有文件/);
        return '三份文件已创建。';
      }
      return { tool: { name: 'office_document_create', arguments: creation[step % creation.length] } };
    }
    if (lastInput?.includes(assistantOff)) {
      assert(officeTools.every(name => !tools.includes(name)));
      assert.doesNotMatch(system, /office-use[/\\]+SKILL\.md/);
      return 'Office Use is disabled.';
    }
    if (lastInput?.includes(assistantVerify)) {
      if (message.role === 'user') return { tool: { name: 'office_review_status', arguments: { proposalId: selectionProposalId } } };
      const receipt = JSON.parse(message.content);
      assert.equal(receipt.status, 'saved');
      assert.equal(receipt.verification.matched, true);
      assert.equal(receipt.verification.address, 'B6500');
      return '已复验并保存。';
    }
    if (lastInput?.includes(assistantEdit)) {
      if (message.role === 'user') return { tool: { name: 'office_edit_propose', arguments: {
        operation: { kind: 'excel', action: 'freezeTopRow', sheet: summarySheet },
      } } };
      const receipt = JSON.parse(message.content);
      assert.equal(receipt.status, 'awaiting-user-review');
      structuralProposalId = receipt.proposalId;
      return '已提交冻结表头提议。';
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
      assert.equal(result.status, 'awaiting-user-review');
      assert.match(result.proposalId, /^[0-9a-f-]{36}$/u);
      selectionProposalId = result.proposalId;
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
