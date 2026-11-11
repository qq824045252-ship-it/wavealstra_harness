/** Real Electron + production WorkspaceFilesView + real filesystem/backend A/B.
 * No product build, application profile/database, network, or external provider.
 * Run: env -u ELECTRON_RUN_AS_NODE node scripts/workspace-files-sort-desktop-test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/tests/workspace-files-sort-desktop');
const baselineRef = process.env.WORKSPACE_SORT_BASELINE || '';
const baseline = baselineRef
  ? { strategy: 'git-source', ref: baselineRef }
  : { strategy: 'current-source-with-guarded-original-localeCompare', replacements: 1 };

async function prepare() {
  const esbuild = require('esbuild');
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-sort-desktop-'));
  try {
    const home = path.join(temp, 'home');
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(home); fs.mkdirSync(workspace);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'junction');
    for (const folder of ['目录10', '目录2', 'alpha', '.hidden', 'node_modules']) {
      fs.mkdirSync(path.join(workspace, folder));
      for (const name of ['file10.txt', 'file2.txt', '中文3.md']) fs.writeFileSync(path.join(workspace, folder, name), `fixture:${folder}/${name}`);
    }
    for (const name of ['z10.txt', 'z2.txt', 'a.txt', 'A.txt', 'é.txt', 'é.txt', '中文10.md', '中文2.md', '.visible', '.mybuddy-task.json', 'private.tmp']) fs.writeFileSync(path.join(workspace, name), `fixture:${name}`);
    const source = 'src/main/workspace/WorkspaceService.ts';
    const current = fs.readFileSync(path.join(root, source), 'utf8');
    let original;
    if (baselineRef) {
      original = cp.execFileSync('git', ['show', `${baselineRef}:${source}`], { cwd: root, encoding: 'utf8' });
    } else {
      // Shallow CI checkouts and source archives need no Git history. Restore only
      // the old comparison call; keep the actual production traversal unchanged.
      const optimizedCall = 'compareWorkspaceFileNames(a.name, b.name)';
      assert.equal(current.split(optimizedCall).length - 1, 1, 'Expected exactly one optimized sort call');
      original = current.replace(optimizedCall, 'a.name.localeCompare(b.name, "zh-CN", { numeric: true })');
    }
    for (const [variant, contents] of [['baseline', original], ['optimized', current]]) {
      await esbuild.build({ stdin: { contents, resolveDir: path.dirname(path.join(root, source)), sourcefile: source, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(temp, `${variant}.cjs`) });
    }
    // A narrow store adapter keeps callbacks observable without starting the whole app.
    const store = path.join(temp, 'store.ts');
    fs.writeFileSync(store, `const state = { tasks: [{id:'fixture',cwd:${JSON.stringify(workspace)}}], activeTaskId:'fixture', spaces:[], page:'chat', panelMode:'workspace', extensionView:'workspace', setWorkspaceFilesCount(n){window.fixtureCount=n}, openWorkspaceFile(path,name){window.fixtureOpened.push({path,name})} }; window.fixtureOpened=[]; export const sizeLabel=()=>{throw Error("Unexpected artifact size action")}; export const useAppStore=Object.assign(selector=>selector(state),{getState:()=>state});`);
    await esbuild.build({ entryPoints: [path.join(__dirname, 'workspace-files-sort-desktop-fixture.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@/store/appStore': store, '@': path.join(root, 'src/renderer/src') }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, outfile: path.join(temp, 'renderer.js') });
    fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="renderer.css"><style>body{margin:0}#root{height:850px;width:700px}.workspace-files-view{height:100%}</style><div id="root"></div><script src="renderer.js"></script>');
    fs.writeFileSync(path.join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{listWorkspaceFiles:root=>ipcRenderer.invoke('fixture:list',root)});`);
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), WORKSPACE_SORT_TEMP: temp, WORKSPACE_SORT_BASELINE: baselineRef, NODE_PATH: path.join(root, 'node_modules') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(require('electron'), [__filename, '--electron'], { cwd: root, env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? 1 : code));
    });
    process.exitCode = code ?? 1;
  } finally {
    // Only this launcher's mkdtemp-owned tree; rm does not follow node_modules' symlink.
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function desktop() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const temp = process.env.WORKSPACE_SORT_TEMP;
  assert(temp, 'Only the isolated launcher may start this fixture');
  app.setPath('userData', path.join(temp, 'userData'));
  app.setPath('home', path.join(temp, 'home'));
  const report = { baseline, kind: 'actual-electron-production-component-filesystem-ab', versions: process.versions, tests: [], status: 'running' };
  let win;
  const timer = setTimeout(() => { console.error('Workspace sort desktop timed out'); app.exit(1); }, 90000);
  try {
    const modules = Object.fromEntries(['baseline','optimized'].map(variant => [variant, require(path.join(temp, `${variant}.cjs`))]));
    let variant = 'baseline', fail = false, calls = 0;
    const workspace = path.join(temp, 'workspace');
    ipcMain.handle('fixture:list', async (_event, requested) => {
      assert.equal(requested, workspace, 'Never list a live user workspace');
      calls++;
      return modules[variant].listWorkspaceFiles(fail ? path.join(temp, 'missing-directory') : requested);
    });
    await app.whenReady();
    win = new BrowserWindow({ show: true, width: 760, height: 920, webPreferences: { preload: path.join(temp, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
    // Deny network requests even if a future component import tries one.
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_details, callback) => { errors.push('Unexpected network request'); callback({ cancel: true }); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(code, label) {
      for (let n = 0; n < 150; n++) { if (await evaluate(code)) return; await delay(40); }
      throw Error('Timeout: ' + label);
    }
    const names = () => evaluate(`[...document.querySelectorAll('.ws-tree-name')].map(e=>e.textContent)`);
    const snapshot = () => evaluate(`({html:document.getElementById('root').innerHTML,opened:window.fixtureOpened,count:window.fixtureCount})`);
    async function clickName(name) {
      const point = await evaluate(`(()=>{const e=[...document.querySelectorAll('.ws-tree-row')].find(e=>e.querySelector('.ws-tree-name')?.textContent===${JSON.stringify(name)});if(!e)throw Error('Missing row');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await delay(80);
    }
    async function filter(text) {
      await evaluate(`(()=>{const e=document.querySelector('.artifacts-search-input');e.focus();e.select()})()`);
      if (text) win.webContents.insertText(text);
      else { win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'}); }
      await delay(100);
    }
    const results = {};
    for (variant of ['baseline', 'optimized']) {
      fail = false;
      await win.loadFile(path.join(temp, 'index.html'));
      await until(`document.querySelectorAll('.ws-tree-row').length>5 && !document.body.textContent.includes('正在读取')`, 'initial tree');
      const expected = await modules[variant].listWorkspaceFiles(workspace);
      assert.deepEqual(await names(), expected.map(node => node.name));
      assert.deepEqual(expected.filter(n => n.kind === 'folder').map(n => n.name), ['目录2', '目录10', 'alpha']);
      assert(!expected.some(n => ['.mybuddy-task.json','private.tmp','.hidden','node_modules'].includes(n.name)));
      const states = { initial: await snapshot() };
      await clickName('目录2');
      await until(`document.querySelectorAll('.ws-tree-row').length===${expected.length + 3}`, 'expanded folder');
      const expanded = await names();
      assert(expanded.indexOf('file2.txt') < expanded.indexOf('file10.txt'));
      states.expanded = await snapshot();
      await clickName('file2.txt');
      assert.deepEqual(await evaluate('window.fixtureOpened'), [{path:'目录2/file2.txt',name:'file2.txt'}]);
      assert.equal(await evaluate(`document.querySelector('.ws-tree-row.active .ws-tree-name').textContent`), 'file2.txt');
      states.selected = await snapshot();
      await filter('中文3');
      assert.deepEqual(await names(), ['目录2','中文3.md','目录10','中文3.md','alpha','中文3.md']);
      states.filtered = await snapshot();
      await filter('');
      assert.deepEqual(await names(), expanded);
      for (let n=0;n<3;n++) {
        const before = calls;
        await evaluate('window.workspaceSortFixture.refresh()');
        await until(`window.fixtureCount===${expected.length}`, 'refresh count');
        await delay(100); assert(calls > before);
        assert.deepEqual(await snapshot(), states.selected, 'Repeated refresh preserves DOM and selection');
      }
      fail = true;
      await evaluate('window.workspaceSortFixture.refresh()'); await delay(150);
      assert.deepEqual(await snapshot(), states.selected, 'Failed background refresh preserves tree');
      await evaluate('window.workspaceSortFixture.mount()');
      await until(`document.body.textContent.includes('ENOENT') && !document.body.textContent.includes('正在读取')`, 'filesystem error');
      states.error = await snapshot();
      assert.equal((await names()).length, 0);
      fail = false;
      await evaluate('window.workspaceSortFixture.mount()');
      await until(`document.querySelectorAll('.ws-tree-row').length===${expected.length} && !document.body.textContent.includes('ENOENT')`, 'recovery');
      states.recovered = await snapshot();
      assert.deepEqual(await names(), expected.map(node => node.name));
      await clickName('目录2'); await clickName('目录2');
      assert.deepEqual(await names(), expected.map(node => node.name), 'Folder collapse restores root');
      fs.writeFileSync(path.join(output, `${variant}.png`), (await win.webContents.capturePage()).toPNG());
      results[variant] = {tree:expected,states};
      report.tests.push(`${variant}: ordering, expansion/collapse, native pointer file open, native input filter, repeated refresh, failed refresh, filesystem error and remount recovery`);
    }
    assert.deepEqual(results.optimized, results.baseline, 'Backend content and every recorded DOM state must be identical');
    assert.deepEqual(errors, []);
    report.tests.push('Exact backend DTO and DOM/content/open-callback identity across baseline and optimized');
    report.calls = calls; report.results = results; report.status = 'passed';
    console.log('PASS workspace-files-sort-desktop: real Electron component + filesystem baseline/optimized equivalence');
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    clearTimeout(timer); if (win && !win.isDestroyed()) win.destroy(); app.exit(process.exitCode || 0);
  }
}
if (process.argv.includes('--electron')) void desktop();
else void prepare().catch(error => { console.error(error); process.exitCode = 1; });
