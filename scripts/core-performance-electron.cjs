const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))] || 0;
}
function summary(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values), n: values.length };
}
function virtualListHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;font:13px system-ui;background:#fff}#sc{height:720px;overflow:auto;position:relative}
  #spacer{position:relative;height:${5000 * 30}px}.row{position:absolute;left:0;right:0;height:30px;line-height:30px;border-bottom:1px solid #eee;padding:0 10px;box-sizing:border-box}
  </style></head><body><div id="sc"><div id="spacer"></div></div><script>
  const total=5000,rowH=30,overscan=8,sc=document.getElementById('sc'),sp=document.getElementById('spacer');
  function render(){const start=Math.max(0,Math.floor(sc.scrollTop/rowH)-overscan);const count=Math.min(total-start,Math.ceil(sc.clientHeight/rowH)+overscan*2);sp.textContent='';for(let i=0;i<count;i++){const idx=start+i,d=document.createElement('div');d.className='row';d.style.transform='translateY('+(idx*rowH)+'px)';d.textContent='Message '+idx+' · '+'content '.repeat((idx%8)+2);sp.appendChild(d);}}
  sc.addEventListener('scroll',render,{passive:true});render();
  window.__benchScroll=function(rounds){const samples=[];for(let i=0;i<rounds;i++){const t=performance.now();sc.scrollTop=((i*791)%total)*rowH;render();const row=sp.firstElementChild;if(row)row.getBoundingClientRect();samples.push(performance.now()-t);}return samples;};
  window.__rowCount=()=>sp.children.length;
  </script></body></html>`;
}

async function worker() {
  const { app, BrowserWindow, WebContentsView } = require('electron');
  const profileIndex = process.argv.indexOf('--profile');
  const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : mkdtempSync(join(tmpdir(), 'mybuddy-perf-electron-worker-'));
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  await app.whenReady();
  const processToAppReadyMs = process.uptime() * 1000;

  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false } });
  const loadStart = performance.now();
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(virtualListHtml()));
  const firstWindowLoadMs = performance.now() - loadStart;
  const processToFirstWindowMs = process.uptime() * 1000;
  const scrollSamples = await win.webContents.executeJavaScript('window.__benchScroll(200)', true);
  const visibleRows = await win.webContents.executeJavaScript('window.__rowCount()', true);
  if (!(visibleRows > 0 && visibleRows < 100)) throw new Error('virtual list did not stay bounded: ' + visibleRows);

  // Hidden host + two real WebContentsViews: native-surface/task handoff without showing UI.
  const host = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { backgroundThrottling: false } });
  await host.loadURL('about:blank');
  const a = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const b = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  a.setBounds({ x: 0, y: 0, width: 900, height: 650 }); b.setBounds({ x: 0, y: 0, width: 900, height: 650 });
  host.contentView.addChildView(a); host.contentView.addChildView(b);
  await Promise.all([a.webContents.loadURL('data:text/html,<body>A</body>'), b.webContents.loadURL('data:text/html,<body>B</body>')]);
  const switchSamples=[];
  for(let i=0;i<200;i++){
    const t=performance.now();
    a.setVisible((i&1)===0); b.setVisible((i&1)!==0);
    switchSamples.push(performance.now()-t);
  }

  const metrics = app.getAppMetrics();
  const workingSetMb = metrics.reduce((sum, metric) => sum + Number(metric.memory?.workingSetSize || 0), 0) / 1024;
  const result = {
    processToAppReadyMs,
    firstWindowLoadMs,
    processToFirstWindowMs,
    virtualScroll: summary(scrollSamples),
    surfaceSwitch: summary(switchSamples),
    visibleRows,
    processCount: metrics.length,
    workingSetMb,
  };
  console.log('PERF_JSON:' + JSON.stringify(result));
  try { a.webContents.close(); b.webContents.close(); } catch {}
  host.destroy(); win.destroy(); app.quit();
}

async function parent() {
  const electronExe = require('electron');
  const rounds = 5;
  const rows = [];
  for (let i=0;i<rounds;i++) {
    const profile = mkdtempSync(join(tmpdir(), `mybuddy-core-perf-electron-${i}-`));
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electronExe, [__filename, '--worker', '--profile', profile], { cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (result.status !== 0) throw new Error(`electron perf worker failed ${result.status}: ${result.stderr || result.stdout}`);
      const line = String(result.stdout).split(/\r?\n/).find((value) => value.startsWith('PERF_JSON:'));
      if (!line) throw new Error('electron perf worker produced no PERF_JSON: ' + result.stdout);
      rows.push(JSON.parse(line.slice('PERF_JSON:'.length)));
    } finally { rmSync(profile, { recursive: true, force: true }); }
  }
  const field = (key) => summary(rows.map((row) => row[key]));
  const nested = (group, key) => summary(rows.map((row) => row[group][key]));
  const report = {
    'electron.process-to-app-ready': field('processToAppReadyMs'),
    'electron.process-to-first-window': field('processToFirstWindowMs'),
    'electron.first-window-load': field('firstWindowLoadMs'),
    'electron.virtual-scroll-frame-p95': nested('virtualScroll', 'p95'),
    'electron.surface-switch-p95': nested('surfaceSwitch', 'p95'),
    'electron.working-set-mb': field('workingSetMb'),
  };
  console.log('=== MyBuddy E Electron performance baseline ===');
  for (const [name, metric] of Object.entries(report)) console.log(`${name}: p50=${metric.p50.toFixed(2)} p95=${metric.p95.toFixed(2)} min=${metric.min.toFixed(2)} max=${metric.max.toFixed(2)} n=${metric.n}`);
  console.log(JSON.stringify(report, null, 2));
  const budgets = {
    'electron.process-to-app-ready': 350,
    'electron.process-to-first-window': 800,
    'electron.first-window-load': 500,
    'electron.virtual-scroll-frame-p95': 6,
    'electron.surface-switch-p95': 3,
    'electron.working-set-mb': 850,
  };
  const failures = [];
  for (const [name, budget] of Object.entries(budgets)) {
    const value = report[name].p95;
    const ok = value <= budget;
    const unit = name.endsWith('-mb') ? 'MB' : 'ms';
    console.log(`budget ${ok ? 'PASS' : 'FAIL'}: ${name} p95=${value.toFixed(2)}${unit} <= ${budget}${unit}`);
    if (!ok) failures.push(`${name} ${value.toFixed(2)} > ${budget}`);
  }
  if (process.env.MYBUDDY_PERF_GATE === '1' && failures.length) throw new Error('Electron performance budget exceeded: ' + failures.join('; '));
}

if (process.argv.includes('--worker')) worker().catch((error) => { console.error(error); process.exitCode = 1; });
else parent().catch((error) => { console.error(error); process.exitCode = 1; });