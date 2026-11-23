/** Run the current chat header on a visible Electron desktop with a disposable profile. */
const path = require('node:path');
const os = require('node:os');
const { readdirSync } = require('node:fs');
const { parseArgs } = require('node:util');
const { run } = require('./desktop-dev-harness.cjs');
const { assertDesktopCase, fingerprintFiles, verifyDesktopCases } = require('./desktop-verification.cjs');

const root = path.resolve(__dirname, '..');
const suite = 'desktop-task-title';
const titles = [
  ['normal', '普通标题'],
  ['chinese', '验证标题占用剩余宽度并保留任务操作。'.repeat(12)],
  ['token', 'TaskHeaderWithoutAnySpaces'.repeat(10)],
];
const cases = titles.flatMap(([id, title]) => [
  { id: `title-${id}-wide`, title, width: 1440, overview: false },
  // At 960px with the task list open, the overview takes over the entire chat area.
  { id: `title-${id}-narrow`, title, width: 1024, overview: true },
]);
const inputs = [
  'scripts/desktop-task-title-test.cjs', 'scripts/desktop-dev-harness.cjs', 'scripts/desktop-verification.cjs',
  'electron.vite.config.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json',
];

function fingerprintTitleInputs(projectRoot, environment) {
  const appInputs = ['src', 'patches'].flatMap(directory =>
    readdirSync(path.join(projectRoot, directory), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(projectRoot, path.join(entry.parentPath, entry.name))));
  return fingerprintFiles(projectRoot, [...inputs, ...appInputs], environment);
}

function measureHeader(headerSelector, titleSelector) {
  const header = document.querySelector(headerSelector);
  const title = header.querySelector(titleSelector);
  const box = header.getBoundingClientRect();
  const bounds = title.getBoundingClientRect();
  const style = getComputedStyle(title);
  const range = document.createRange();
  range.selectNodeContents(title);
  const needed = range.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const controls = [...header.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { name: button.getAttribute('aria-label') || button.title || button.textContent.trim(),
      withinHeader: rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
      clickable: !button.disabled && rect.width > 0 && rect.height > 0 && button.contains(hit) };
  });
  const following = [...header.children].slice([...header.children].indexOf(title.parentElement) + 1)
    .filter(node => !node.classList.contains('desktop-topbar-drag') && node.getBoundingClientRect().width > 0);
  const gap = Number.parseFloat(getComputedStyle(header).columnGap) || 0;
  const next = Math.min(box.right, ...following.map(node => node.getBoundingClientRect().left - gap));
  return { headerWidth: box.width, available: next - bounds.left, actual: bounds.width, needed,
    clipped: title.scrollWidth > title.clientWidth + 1, ellipsis: style.textOverflow === 'ellipsis' && style.overflowX === 'hidden',
    text: title.textContent, tooltip: title.title, controls };
}

async function verifyLayout(selected, { evaluate: evaluateInRenderer, rpc, until, report }) {
  const evaluate = async expression => {
    try {
      return await evaluateInRenderer(expression);
    } catch (error) {
      if (error.message === 'CDP timeout: Runtime.evaluate') report.timedOutRendererExpression = expression;
      throw error;
    }
  };
  const store = expression => evaluate(`import('/src/store/appStore.ts').then(m => ${expression})`);
  const topbar = await evaluate("Boolean(document.querySelector('.desktop-topbar-content'))");
  const headerSelector = topbar ? '.desktop-topbar-content' : '.task-chat-header';
  const titleSelector = topbar ? '.desktop-task-title-label' : '.chat-header-title > span';
  const titleLabel = `${headerSelector} ${titleSelector}`;
  const click = async expression => {
    const point = await evaluate(`(() => {
      const rect = (${expression}).getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const clickSelector = selector => click(`document.querySelector(${JSON.stringify(selector)})`);
  const clickAction = async name => {
    if (topbar && await evaluate("document.querySelector('#desktop-task-actions').hidden"))
      await clickSelector('[aria-controls="desktop-task-actions"]');
    const scope = topbar ? '#desktop-task-actions' : headerSelector;
    await click(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button =>
      [button.getAttribute('aria-label'), button.title, button.textContent.trim()].includes(${JSON.stringify(name)}))`);
  };
  const toggleOverview = open => clickAction(open ? '关闭侧栏' : '打开概览');
  const waitForPanel = open => until(() => evaluate(`document.querySelector('[data-desktop-main]').classList.contains('has-artifact-panel') === ${open}`), `overview ${open ? 'opened' : 'closed'}`);
  const taskId = await store(`(async () => {
    const state = m.useAppStore.getState();
    state.newTask(null);
    await state.sendMessage('请保存这条用于桌面标题验收的消息。');
    return m.useAppStore.getState().activeTaskId;
  })()`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(titleLabel)}))`), 'active task header');

  for (const testCase of selected) {
    const check = (assertion, condition, expected, observed) => assertDesktopCase(report, testCase.id, assertion, condition, { expected, observed });
    await rpc('Emulation.setDeviceMetricsOverride', { width: testCase.width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(`innerWidth === ${testCase.width}`), `${testCase.width}px viewport`);
    await store(`m.useAppStore.getState().renameTask(${JSON.stringify(taskId)}, ${JSON.stringify(testCase.title)})`);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(titleLabel)})?.textContent === ${JSON.stringify(testCase.title)}`), 'task title updated');
    const open = await evaluate("document.querySelector('[data-desktop-main]').classList.contains('has-artifact-panel')");
    if (open !== testCase.overview) await toggleOverview(open);
    await waitForPanel(testCase.overview);
    await evaluate('document.fonts.ready.then(() => true)');

    // The geometry read forces layout even when Electron throttles animation frames.
    const geometry = await evaluate(`(${measureHeader.toString()})(${JSON.stringify(headerSelector)}, ${JSON.stringify(titleSelector)})`);
    check('chat-header-visible', geometry.headerWidth > 0, 'chat and the selected overview state can coexist', geometry.headerWidth);
    const fits = geometry.needed <= geometry.available + 1;
    check('title-content', geometry.text === testCase.title && geometry.tooltip.startsWith(testCase.title),
      'full title in DOM and tooltip', { text: geometry.text, tooltip: geometry.tooltip });
    const fillsAvailableWidth = geometry.actual > 0 && Math.abs(geometry.actual - geometry.available) <= 1;
    check('title-fits-remaining-width', fillsAvailableWidth && (fits ? !geometry.clipped : geometry.clipped && geometry.ellipsis),
      fits ? 'complete title using the available width' : 'title using the available width, truncated with ellipsis', geometry);
    const controls = topbar ? ['任务列表', '新建任务', '更多任务操作'] : ['历史提问', '执行诊断', testCase.overview ? '关闭侧栏' : '打开概览'];
    for (const name of controls) {
      const control = geometry.controls.find(button => button.name === name);
      check(`control-${name}`, control?.clickable && control.withinHeader, 'visible, enabled and unobscured', control ?? 'missing');
    }

    await clickAction('历史提问');
    await until(() => evaluate("Boolean(document.querySelector('.history-popup'))"), 'history opens');
    await clickAction('历史提问');
    await clickAction('执行诊断');
    await until(() => evaluate("Boolean(document.querySelector('.execution-diagnostics-dialog[open]'))"), 'diagnostics opens');
    await clickSelector('button[aria-label="关闭执行诊断"]');
    await toggleOverview(testCase.overview);
    await waitForPanel(!testCase.overview);
    report.checks.push({ caseId: testCase.id, width: testCase.width, overview: testCase.overview, geometry });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, options: {
    case: { type: 'string' }, fresh: { type: 'boolean' }, list: { type: 'boolean' },
  } });
  if (values.list) {
    console.log(cases.map(testCase => testCase.id).join('\n'));
    return;
  }
  const selected = values.case ? cases.filter(testCase => testCase.id === values.case) : cases;
  if (!selected.length) throw new Error(`Unknown desktop case ${values.case}. Use --list.`);
  const result = await verifyDesktopCases({
    caseIds: selected.map(testCase => testCase.id),
    fingerprint: () => fingerprintTitleInputs(root, { platform: process.platform, arch: process.arch,
      release: os.release(), node: process.version, electron: require('electron/package.json').version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale }),
    receiptsDirectory: path.join(root, 'out/diagnostics', suite, 'assertion-failures'), fresh: values.fresh,
    run: inputsStillCurrent => run(context => verifyLayout(selected, context), { name: suite, watchRenderer: false, inputsStillCurrent,
      isolatedDependencyCache: true, fixtureModel: () => '标题验收的测试回复。' }),
  });
  console.log(`VERIFICATION_RESULT ${JSON.stringify(result)}`);
  if (result.outcome !== 'passed') process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { fingerprintTitleInputs, verifyLayout };
