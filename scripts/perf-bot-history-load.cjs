/**
 * Repeatable real-Electron history-load A/B, not a product build or startup benchmark.
 * TMPDIR=/home/vivion env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-bot-history-load.cjs
 * Optional: --baseline=<commit> --samples=12 --out=out/diagnostics/history-load-ab
 * Baseline reads the two changed host files with git show; renderer and all other sources are shared.
 * Times include statement-count instrumentation. UI = refresh through two animation frames, not startup/model latency.
 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url'), { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baseline = option('baseline', '3a892555a1105024d026d1c80f204fdd6b6e6591');
const samples = Number(option('samples', '12'));
assert(Number.isInteger(samples) && samples >= 2 && samples <= 100);
const out = path.resolve(repo, option('out', 'out/diagnostics/history-load-ab'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-history-load-'));
app.setPath('userData', path.join(root, 'chromium'));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.XDG_CONFIG_HOME = path.join(root, 'config');
protocol.registerSchemesAsPrivileged([{ scheme: 'mybuddy-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const changed = ['src/main/agent/work/BotConversationRepository.ts', 'src/main/agent/work/BotReportImageService.ts'];
const hash = source => createHash('sha256').update(source).digest('hex');
const summary = rows => Object.fromEntries(['historyMs', 'hydrationMs', 'mainMs', 'historyCpuMs', 'hydrationCpuMs', 'mainCpuMs', 'historySql', 'hydrationSql', 'totalMs', 'refreshMs', 'roundTripMs'].flatMap(key => {
  const values = rows.map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? [[key, { median: (values[Math.floor(values.length / 2)] + values[Math.floor((values.length - 1) / 2)]) / 2,
    p95: values[Math.ceil(values.length * .95) - 1], min: values[0], max: values.at(-1) }]] : [];
}));
let win, fixtures = {}, artifactProtocol;
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(out, { recursive: true });
    const baselineSources = Object.fromEntries(changed.map(file => [file, execFileSync('git', ['show', `${baseline}:${file}`], { cwd: repo, encoding: 'utf8' })]));
    const files = [...changed, 'src/main/agent/work/BotConversationService.ts', 'src/renderer/src/store/app/slices/botConversation.ts',
      'src/renderer/src/components/pages/BotWorkspacePage.tsx', 'scripts/bot-conversation-concurrent-desktop-fixture.tsx',
      'scripts/perf-bot-history-load.cjs', 'scripts/perf-bot-history-load-fixture.ts', 'scripts/perf-bot-history-load-renderer.ts'];
    const sources = { baselineCommit: git('rev-parse', baseline), head: git('rev-parse', 'HEAD'),
      candidate: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))])),
      baseline: Object.fromEntries(changed.map(file => [file, hash(baselineSources[file])])),
      diff: git('diff', '--', ...changed) };
    // Shared production sources must not differ from the baseline except for the explicitly compared files.
    const otherChanges = git('diff', baseline, '--name-only', '--', 'src').split('\n').filter(Boolean).filter(file => !changed.includes(file));
    assert.deepEqual(otherChanges, [], 'Baseline comparison requires unchanged shared production dependencies');
    const common = { bundle: true, platform: 'node', format: 'esm', packages: 'external', absWorkingDir: repo };
    await build({ ...common, entryPoints: ['scripts/perf-bot-history-load-fixture.ts'], outfile: path.join(out, 'fixture.mjs') });
    await build({ ...common, entryPoints: [changed[1]], outfile: path.join(out, 'baseline.mjs'), plugins: [{ name: 'baseline-git-source', setup(builder) {
      builder.onLoad({ filter: /Bot(?:ConversationRepository|ReportImageService)\.ts$/ }, args => {
        const relative = path.relative(repo, args.path).split(path.sep).join('/');
        assert(baselineSources[relative], `Unexpected baseline import ${relative}`);
        return { contents: baselineSources[relative], loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }] });
    const { fixture, ArtifactProtocol } = await import(pathToFileURL(path.join(out, 'fixture.mjs')).href);
    const { BotReportImageService } = await import(pathToFileURL(path.join(out, 'baseline.mjs')).href);
    fixtures = { ordinary: fixture(path.join(root, 'ordinary'), false, BotReportImageService), mixed: fixture(path.join(root, 'mixed'), true, BotReportImageService) };
    const report = { sources, environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model, samples },
      methodology: { diskMessagesPerScenario: 10000, rowsPerRequest: 100, mixedLatestPage: { ordinary: 75, feedbackNoImage: 15, feedbackWithImage: 10 },
        mainWarmupPairs: 2, uiWarmupPairs: 1, order: 'Alternating AB/BA pairs, same DB/Work/artifacts/renderer',
        coldCapture: 'One candidate-only first capture sample; no baseline cold-speedup claim',
        overhead: 'SQL execution/prepare counters; process.cpuUsage snapshots; IPC timing payload; renderer two-frame barrier. CPU is whole main-process user+system, not thread-specific. No product/model/provider/full-app startup.' },
      firstCapture: {}, main: [], ui: [], parity: { mainPairs: 0, uiPairs: 0, pagingPairs: 0 }, checks: {}, errors: [], warnings: [] };
    // First capture creates identical shared descriptors for subsequent A/B reads. It is not a cold A/B comparison.
    for (const scenario of ['ordinary', 'mixed']) {
      const cold = await fixtures[scenario].history('candidate');
      report.firstCapture[scenario] = cold.timing;
      const base = await fixtures[scenario].history('baseline');
      assert.deepEqual(base.history, cold.history, 'Complete first/cached DTO parity');
      const counts = { absent: 0, empty: 0, populated: 0 };
      for (const message of base.history.messages) {
        if (!Object.hasOwn(message, 'reportImages')) counts.absent++;
        else if (message.reportImages.artifacts.length === 0) counts.empty++;
        else counts.populated++;
      }
      assert.deepEqual(counts, scenario === 'mixed' ? { absent: 75, empty: 15, populated: 10 } : { absent: 100, empty: 0, populated: 0 });
      report.checks[scenario] = counts;
      for (let i = -2; i < samples; i++) {
        const pair = {};
        for (const variant of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          pair[variant] = await fixtures[scenario].history(variant);
          if (i >= 0) report.main.push({ scenario, variant, sample: i, ...pair[variant].timing });
        }
        assert.deepEqual(pair.candidate.history, pair.baseline.history, 'Complete main DTO parity');
        report.parity.mainPairs++;
      }
    }
    console.log('MAIN', JSON.stringify(Object.fromEntries(['ordinary', 'mixed'].map(scenario => [scenario, Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, summary(report.main.filter(row => row.scenario === scenario && row.variant === variant))]))]))));
    let protocolHits = 0;
    artifactProtocol = new ArtifactProtocol({ resolve: async () => { throw Error('Only image URLs expected'); } }, async (id, variant) => {
      protocolHits++;
      for (const f of Object.values(fixtures)) if (f.artifacts.get(id)) return f.artifacts.readImageVariant(id, variant);
      return null;
    });
    artifactProtocol.register();
    ipcMain.handle('history-load', (_event, { scenario, variant, request }) => fixtures[scenario].history(variant, request));
    fs.writeFileSync(path.join(root, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('historyLoadHost', { query: request => ipcRenderer.invoke('history-load', request) });`);
    const ui = path.join(out, 'ui.js');
    await build({ entryPoints: ['scripts/bot-conversation-concurrent-desktop-fixture.tsx'], absWorkingDir: repo, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, external: ['@terrastruct/d2'], alias: { '@': path.join(repo, 'src/renderer/src'), '@shared': path.join(repo, 'src/shared') },
      loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, outfile: ui, plugins: [{ name: 'history-load-renderer', setup(builder) {
        builder.onLoad({ filter: /bot-conversation-concurrent-desktop-fixture\.tsx$/ }, args => {
          const source = fs.readFileSync(args.path, 'utf8'), marker = 'createRoot(document.getElementById("root")!).render(<BotWorkspacePage />);';
          assert.equal(source.split(marker).length, 2, 'Page fixture mount marker changed');
          return { contents: source.replace(marker, `import { installHistoryLoadPerf } from './perf-bot-history-load-renderer';\ninstallHistoryLoadPerf();\n${marker}`), loader: 'tsx', resolveDir: path.dirname(args.path) };
        });
      } }] });
    fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file:; style-src file: 'unsafe-inline'; img-src file: data: blob: mybuddy-artifact:; font-src file:; connect-src mybuddy-artifact:"><link rel="stylesheet" href="${pathToFileURL(ui.replace('.js', '.css')).href}"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}#root,.bot-workspace{height:100vh}</style></head><body><div id="root"></div><script src="${pathToFileURL(ui).href}"></script></body></html>`);
    win = new BrowserWindow({ width: 1050, height: 820, show: true, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); else if (event.level === 'warning') report.warnings.push(event.message); });
    win.webContents.on('render-process-gone', (_event, details) => report.errors.push(`Renderer gone: ${JSON.stringify(details)}`));
    await win.loadFile(path.join(root, 'index.html'));
    const evaluate = source => win.webContents.executeJavaScript(source);
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const scenario of ['ordinary', 'mixed']) {
      for (let i = -1; i < samples; i++) {
        const pair = {};
        for (const variant of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const row = await evaluate(`historyLoadPerf.load(${JSON.stringify(variant)}, ${JSON.stringify(scenario)})`);
          pair[variant] = row.history; delete row.history;
          assert.equal(row.transport.length, 1, 'A refresh must make exactly one bounded IPC call');
          assert.equal(row.domMessages, 100, 'Actual DOM must contain the bounded page');
          if (i >= 0) report.ui.push({ sample: i, ...row });
        }
        assert.deepEqual(pair.candidate, pair.baseline, 'Complete renderer/store DTO parity'); report.parity.uiPairs++;
      }
      report.checks[`${scenario}Scroll`] = await evaluate('historyLoadPerf.scroll()');
      assert(report.checks[`${scenario}Scroll`].bottom > report.checks[`${scenario}Scroll`].top, 'Live DOM must scroll');
      if (scenario === 'mixed') {
        report.checks.images = await evaluate('historyLoadPerf.images()');
        assert.equal(report.checks.images.length, 10);
        assert(report.checks.images.every(image => image.width === 1 && image.height === 1 && image.src.startsWith('mybuddy-artifact:')));
      }
    }
    // 1,000 accumulated rows require ten actual 100-row requests, never a fake oversized API page.
    const accumulated = {};
    for (const variant of ['baseline', 'candidate']) {
      await evaluate(`historyLoadPerf.load(${JSON.stringify(variant)}, 'mixed')`);
      for (let i = 0; i < 9; i++) accumulated[variant] = await evaluate('historyLoadPerf.page()');
      assert.equal(accumulated[variant].messages, 1000); assert.equal(accumulated[variant].calls, 10);
    }
    assert.deepEqual(accumulated.baseline.history, accumulated.candidate.history, 'Complete accumulated 1,000-row store parity');
    report.parity.pagingPairs++; report.checks.accumulated = { messages: 1000, requests: 10, pageSize: 100 };
    report.checks.protocolHits = protocolHits;
    assert(protocolHits > 0, 'Real image protocol must be used');
    assert.deepEqual(report.errors, [], 'No renderer console errors');
    report.summary = Object.fromEntries(['ordinary', 'mixed'].map(scenario => [scenario, Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, {
      main: summary(report.main.filter(row => row.scenario === scenario && row.variant === variant)),
      ui: summary(report.ui.filter(row => row.scenario === scenario && row.variant === variant).map(row => ({ ...row, ...row.transport[0] }))),
    }]))]));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'mixed-1000.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS history-load A/B', JSON.stringify({ summary: report.summary, parity: report.parity, checks: report.checks, errors: report.errors, output: out }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    win?.destroy(); artifactProtocol?.unregister();
    for (const fixture of Object.values(fixtures)) fixture.app.close();
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
