/** Disposable, visible pnpm dev app. Never opens the user's profile or credentials. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), net = require('node:net'), http = require('node:http');
const {once} = require('node:events');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});
});

exports.run = async (scenario, {name, liveModel = false, settings = {}}) => {
  const out = path.join(root, 'out/diagnostics', name, new Date().toISOString().replace(/[:.]/g, '-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-dev-'));
  const agentDir = path.join(home, '.mybuddy'), userData = path.join(home, 'electron-profile');
  fs.mkdirSync(out, {recursive: true}); fs.mkdirSync(agentDir, {recursive: true});
  const report = {status: 'running', home, checks: [], actualControlChecks: [], seededPresentationFacts: [], rendererErrors: [],
    displayMode: 'visible Electron', inputMode: 'CDP', realCredentialsRead: false};
  const requests = [], rawUsageAudit = [], pending = new Map(), owned = new Set();
  let child, socket, relay, log, sequence = 0;
  const until = async (fn, label) => {
    const deadline = Date.now() + 180000;
    while (!await fn()) {
      if (report.providerError) throw Error('Provider HTTP '+report.providerError.status+': '+report.providerError.body);
      if (report.transportError) throw Error(report.transportError);
      if (Date.now() > deadline) throw Error('Timeout: ' + label); await wait(150);
    }
  };
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id); reject(Error('CDP timeout: ' + method));}, 20000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
  const evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const stop = async () => {
    if (socket?.readyState === WebSocket.OPEN) await rpc('Browser.close').catch(() => {});
    socket?.close(); socket = undefined;
    for (const call of pending.values()) {clearTimeout(call.timer); call.reject(Error('Dev app closed'));} pending.clear();
    // Bootstrap records only our main PID; never signal renderers or other app instances.
    const identityFile = path.join(home, 'main-identity.json');
    if (fs.existsSync(identityFile)) {
      const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (identity.userData !== userData) throw Error('Isolated main identity mismatch');
      owned.add(identity.pid);
      await wait(500);
      try {
        process.kill(identity.pid, 0);
        if (process.platform === 'linux') {
          const stat=fs.readFileSync('/proc/'+identity.pid+'/stat','utf8');
          if (stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19] !== identity.startTime) throw Error('Main PID was reused');
        } else if (process.platform === 'win32') {
          const command=cp.execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}').CommandLine`],{encoding:'utf8',windowsHide:true});
          if (!command.includes(path.join(home,'bootstrap.cjs'))) throw Error('Main PID no longer belongs to this isolated bootstrap');
        }
        process.kill(identity.pid, 'SIGTERM');
      } catch (error) {if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;}
    }
    if (child?.exitCode === null) {
      if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), wait(3000)]);
    }
  };
  try {
    let model = {id: 'ui-fixture', name: 'UI only (no model server)', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 4096, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
    let baseUrl = 'http://127.0.0.1:1/v1';
    if (liveModel) {
      const upstream = process.env.MYBUDDY_LIVE_BASE_URL || 'http://127.0.0.1:3425/v1';
      const loaded = await require('./live-model-config.cjs').loadLiveModel(upstream, process.env.MYBUDDY_LIVE_MODEL || 'auto/deepseek-v4.1-flash');
      model = loaded.model; report.modelConfiguration = loaded.evidence;
      relay = http.createServer(async (req, res) => {
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks), requestIndex = requests.length;
          const request = JSON.parse(body); requests.push(request);
          fs.appendFileSync(path.join(out, 'provider-requests.jsonl'), JSON.stringify({at: Date.now(), body: request}) + '\n');
          const response = await fetch(upstream.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer isolated-live-check'},
            body, signal: AbortSignal.timeout(240000),
          });
          res.writeHead(response.status, {'content-type': response.headers.get('content-type') || 'application/json'});
          const decoder = new TextDecoder(); let audit = '';
          for await (const chunk of response.body) {res.write(chunk); audit += decoder.decode(chunk, {stream: true});}
          audit += decoder.decode(); res.end();
          const records = request.stream ? audit.split('\n').filter(line => line.startsWith('data: {')).map(line => line.slice(6)) : [audit];
          for (const record of records) {try {const usage = JSON.parse(record).usage; if (usage) rawUsageAudit.push({requestIndex, usage});} catch {}}
          if (!response.ok) report.providerError = {status: response.status, body: audit};
        } catch (error) {res.destroy(error); report.transportError = String(error);}
      });
      relay.listen(0, '127.0.0.1'); await once(relay, 'listening'); baseUrl = 'http://127.0.0.1:' + relay.address().port + '/v1';
    }
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {fixture: {
      api: 'openai-completions', baseUrl, apiKey: 'isolated-no-user-credentials', models: [model],
    }}}));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({defaultProvider: 'fixture', defaultModel: model.id,
      enabledModels: ['fixture/' + model.id], memoryEnabled: false, memoryGatewayEnabled: false,
      remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly', ...settings}));
    const port = await freePort(), devOut = path.join(out, 'dev-output'), bootstrap = path.join(home, 'bootstrap.cjs');
    fs.writeFileSync(bootstrap, `const fs=require('node:fs');const r=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});const {app}=r('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(userData)});fs.writeFileSync(${JSON.stringify(path.join(home, 'main-identity.json'))},JSON.stringify({pid:process.pid,userData:${JSON.stringify(userData)},startTime:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].trim().split(/\\s+/)[19]:undefined}));require(${JSON.stringify(path.join(devOut, 'main/index.js'))});`);
    const env = {...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
      APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      REMOTE_DEBUGGING_PORT: String(port), ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'])};
    delete env.ELECTRON_RUN_AS_NODE;
    const pnpm = process.env.npm_execpath;
    if (!pnpm || !fs.existsSync(pnpm)) throw Error('Run the registered pnpm test script');
    const launch = async () => {
      const args = ['dev', '--outDir', devOut, '--entry', bootstrap];
      log = fs.openSync(path.join(out, 'dev.log'), 'a');
      const native = !/\.[cm]?js$/i.test(pnpm);
      child = cp.spawn(native ? pnpm : process.execPath, native ? args : [pnpm, ...args], {cwd: root, env, windowsHide: true, stdio: ['ignore', log, log]});
      fs.closeSync(log); log = undefined;
      let target;
      await until(async () => {
        if (child.exitCode !== null) throw Error('pnpm dev exited ' + child.exitCode);
        try {target = (await fetch('http://127.0.0.1:' + port + '/json/list', {signal: AbortSignal.timeout(2000)}).then(r => r.json())).find(t => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url)); return Boolean(target);} catch {return false;}
      }, 'dev renderer');
      socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
      socket.addEventListener('message', event => {
        const value = JSON.parse(event.data);
        if (value.method === 'Runtime.exceptionThrown') report.rendererErrors.push(value.params);
        const call = pending.get(value.id); if (!call) return;
        pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(Error(JSON.stringify(value.error))) : call.resolve(value.result);
      });
      await rpc('Runtime.enable'); await rpc('Page.enable');
      await rpc('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await until(() => evaluate('Boolean(window.api?.agent && document.querySelector(".sidebar-user-main"))'), 'app and preload');
      await until(() => evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().models.length>0)`), 'initial store bootstrap');
      await rpc('Page.bringToFront');
    };
    await launch();
    await scenario({evaluate, rpc, until, report, out, home, requests, rawUsageAudit,
      getOwnedElectronPids: () => fs.existsSync(path.join(home, 'main-identity.json')) ? [JSON.parse(fs.readFileSync(path.join(home, 'main-identity.json'))).pid] : [],
      restart: async () => {await stop(); await launch();}});
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
    if (socket?.readyState === WebSocket.OPEN) try {report.visibleText = await evaluate('document.body.innerText');const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failed-page.png'),Buffer.from(shot.data,'base64'));} catch {}
  } finally {
    await stop().catch(error => {report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1;});
    relay?.closeAllConnections(); relay?.close(); report.ownedMainPids = [...owned];
    fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(requests));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(name + ': ' + report.status + '; ' + path.join(out, 'report.json'));
    if (report.error) console.error(report.error);
  }
};

if (require.main === module) {
  const name = process.argv[2];
  if (!/^[a-z-]+$/.test(name || '')) throw Error('Pass a dev-checks scenario name');
  exports.run(require('./' + name + '-dev-checks.cjs'), {name});
}
