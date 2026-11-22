/** Disposable, visible pnpm dev app. Never opens the user's profile or credentials. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), net = require('node:net'), http = require('node:http');
const {once} = require('node:events');
const {performance} = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});
});

const timestamp = () => performance.timeOrigin + performance.now();
const hasText = value => typeof value === 'string' && value.trim().length > 0;

function observeProviderRecord(data, arrival, timing, rawUsageAudit) {
  if (!data) return;
  if (data === '[DONE]') {
    timing.upstreamDoneAtMs ??= arrival;
    return;
  }
  let record;
  try {record = JSON.parse(data);} catch {return;}
  if (!record || typeof record !== 'object') return;
  if (record.model) timing.responseModel = record.model;
  if (record.usage) {
    timing.usage = record.usage;
    rawUsageAudit.push({requestIndex: timing.requestIndex, usage: record.usage});
  }
  if (record.error) timing.providerPayloadError = record.error;
  for (const choice of Array.isArray(record.choices) ? record.choices : []) {
    const delta = choice?.delta || choice?.message || {};
    const reasoning = hasText(delta.reasoning_content) || hasText(delta.reasoning) || hasText(delta.reasoning_text);
    const answer = hasText(delta.content);
    const tools = Array.isArray(delta.tool_calls) ? delta.tool_calls : delta.function_call ? [{function: delta.function_call}] : [];
    const tool = tools.some(call => hasText(call?.id) || hasText(call?.type) ||
      hasText(call?.function?.name) || hasText(call?.function?.arguments));
    const toolContent = tools.some(call => hasText(call?.function?.name) || hasText(call?.function?.arguments));
    if (reasoning || answer || tool) timing.firstDeltaAtMs ??= arrival;
    if (reasoning) timing.firstReasoningAtMs ??= arrival;
    if (answer) timing.firstAnswerAtMs ??= arrival;
    if (tool) timing.firstToolAtMs ??= arrival;
    if (toolContent) timing.firstToolContentAtMs ??= arrival;
  }
}

function createSseAudit(emit) {
  let pending = '', lines = [], skipLeadingLf = false;
  const consumeLine = (line, arrival) => {
    if (!line) {
      if (lines.length) emit(lines.join('\n'), arrival);
      lines = [];
    } else if (line === 'data' || line.startsWith('data:')) {
      lines.push(line.slice(5).replace(/^ /, ''));
    }
  };
  return (text, arrival, end = false) => {
    if (skipLeadingLf && text.length) {
      if (text[0] === '\n') text = text.slice(1);
      skipLeadingLf = false;
    }
    const unscanned = pending.length;
    pending += text;
    let start = 0;
    for (let i = unscanned; i < pending.length; i++) {
      if (pending[i] !== '\r' && pending[i] !== '\n') continue;
      consumeLine(pending.slice(start, i), arrival);
      if (pending[i] === '\r') {
        if (pending[i + 1] === '\n') i++;
        else if (i === pending.length - 1) skipLeadingLf = true;
      }
      start = i + 1;
    }
    pending = pending.slice(start);
    if (end) {
      if (pending) consumeLine(pending, arrival);
      consumeLine('', arrival);
    }
  };
}

exports.run = async (scenario, {name, liveModel = false, fixtureModel, fixtureModelIds = [], fixtureUsage, fixtureModelRates, settings = {}, seedHome, gateLiveResponse, rpcTimeoutMs = 20000, benchmark = false, watchRenderer = true, isolatedDependencyCache = false}) => {
  const out = path.join(root, 'out/diagnostics', name, new Date().toISOString().replace(/[:.]/g, '-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-dev-'));
  const agentDir = path.join(home, '.mybuddy'), userData = path.join(home, 'electron-profile');
  fs.mkdirSync(out, {recursive: true}); fs.mkdirSync(agentDir, {recursive: true});
  await seedHome?.(home);
  const report = {status: 'running', home, checks: [], actualControlChecks: [], seededPresentationFacts: [], rendererErrors: [],
    displayMode: benchmark ? 'hidden isolated Electron window' : 'visible Electron', inputMode: 'CDP', realCredentialsRead: false};
  const requests = [], rawUsageAudit = [], pending = new Map(), owned = new Set();
  const providerTimings = [], benchmarkJournal = [];
  let providerScope;
  if (benchmark) report.providerTimings = providerTimings;
  let child, socket, relay, log, sequence = 0;
  const until = async (fn, label) => {
    const deadline = Date.now() + 180000;
    while (!await fn()) {
      if (report.providerError) throw Error('Provider HTTP '+report.providerError.status+': '+report.providerError.body);
      if (report.transportError) throw Error(report.transportError);
      if (Date.now() > deadline) throw Error('Timeout: ' + label); await wait(150);
    }
  };
  const disconnect = connection => {
    if (socket === connection) socket = undefined;
    for (const [id, call] of pending) {
      if (call.connection !== connection) continue;
      pending.delete(id);
      clearTimeout(call.timer);
      call.reject(Error('CDP connection closed'));
    }
  };
  const rpc = (method, params = {}, sessionId, timeoutMs = rpcTimeoutMs) => new Promise((resolve, reject) => {
    const connection = socket;
    if (connection?.readyState !== WebSocket.OPEN) {
      reject(Error('CDP connection is not open'));
      return;
    }
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id); reject(Error('CDP timeout: ' + method));}, timeoutMs);
    pending.set(id, {connection, resolve, reject, timer});
    try {
      connection.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
  const evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const stop = async () => {
    const connection = socket;
    if (connection?.readyState === WebSocket.OPEN) await rpc('Browser.close', {}, undefined, 2000).catch(() => {});
    if (connection) {
      disconnect(connection);
      connection.close();
    }
    // Bootstrap records only our main PID; never signal renderers or other app instances.
    const identityFile = path.join(home, 'main-identity.json');
    if (fs.existsSync(identityFile)) {
      const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (identity.userData !== userData) throw Error('Isolated main identity mismatch');
      owned.add(identity.pid);
      await wait(500);
      try {
        process.kill(identity.pid, 0);
        let stillRunning = true;
        if (process.platform === 'linux') {
          const stat=fs.readFileSync('/proc/'+identity.pid+'/stat','utf8');
          if (stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19] !== identity.startTime) throw Error('Main PID was reused');
        } else if (process.platform === 'win32') {
          const lookup = [
            '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
            `$entry = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}' -ErrorAction Stop`,
            '@{ exists = ($null -ne $entry); commandLine = $entry.CommandLine } | ConvertTo-Json -Compress',
          ].join('\n');
          const readProcess = () => {
            const output = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', lookup],
              {encoding:'utf8',windowsHide:true});
            const result = JSON.parse(output.trim());
            if (typeof result?.exists !== 'boolean') throw Error('Could not verify isolated main process');
            return result;
          };
          let result = readProcess();
          // Windows may still list the exiting object after its command line becomes unavailable.
          for (let attempt = 0; attempt < 3 && result.exists
            && (result.commandLine == null || result.commandLine === ''); attempt++) {
            await wait(250);
            result = readProcess();
          }
          stillRunning = result.exists;
          if (stillRunning && (typeof result.commandLine !== 'string'
            || !result.commandLine.includes(path.join(home,'bootstrap.cjs')))) {
            throw Error('Main PID no longer belongs to this isolated bootstrap');
          }
        }
        if (stillRunning) process.kill(identity.pid, 'SIGTERM');
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
    let extraModels = fixtureModelIds.map(id => ({...model, id, name:id}));
    if (fixtureModel) {
      model = {...model, name: 'Deterministic test model', ...(fixtureModelRates ? {cost: fixtureModelRates} : {})};
      report.modelConfiguration = {kind: 'fixture'};
      relay = http.createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const request = JSON.parse(Buffer.concat(chunks));
          const requestIndex = requests.length;
          requests.push(request);
          const reply = await fixtureModel(request);
          if (reply?.fixtureFault === "disconnect") { req.socket.destroy(); return; }
          if (reply?.fixtureFault === "model-error") {
            res.writeHead(400, {"Content-Type":"application/json"}).end(JSON.stringify({error:{type:"invalid_request_error", message:reply.message}}));
            return;
          }
          const textChunks = Array.isArray(reply) ? reply : undefined;
          const tool = typeof reply === 'string' || textChunks ? undefined : reply.tool;
          const message = tool ? { role: 'assistant', tool_calls: [{ id: 'call-' + requests.length, type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: textChunks?.join('') ?? reply };
          const finishReason = tool ? 'tool_calls' : 'stop';
          const base = {id: 'fixture-' + requests.length, model: request.model, created: Math.floor(Date.now()/1000)};
          // Pass the raw provider envelope through the real transport and SDK. Null omits usage.
          const sample = await fixtureUsage?.(request, {requestIndex});
          const usage = sample === undefined ? {prompt_tokens: 20, completion_tokens: 4, total_tokens: 24} : sample;
          if (fixtureUsage) rawUsageAudit.push({requestIndex, usage});
          if (request.stream) {
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            const send = (choices, tokens) => res.write('data: ' + JSON.stringify({
              ...base, object: 'chat.completion.chunk', choices, ...(tokens ? {usage: tokens} : {}),
            }) + '\n\n');
            const delta = tool ? { ...message, tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : message;
            if (textChunks) {
              for (const [index, content] of textChunks.entries()) {
                send([{index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content }, finish_reason: null}]);
                await wait(400);
              }
            } else send([{index: 0, delta, finish_reason: null}]);
            send([{index: 0, delta: {}, finish_reason: finishReason}], usage);
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({...base, object: 'chat.completion', ...(usage === null ? {} : {usage}),
              choices: [{index: 0, message, finish_reason: finishReason}]}));
          }
        } catch (error) {
          const body = String(error);
          report.providerError = {status: 400, body};
          res.writeHead(400, {'Content-Type': 'application/json'}).end(JSON.stringify({error:{message:body}}));
        }
      });
      relay.listen(0, '127.0.0.1');
      await once(relay, 'listening');
      baseUrl = 'http://127.0.0.1:' + relay.address().port + '/v1';
    } else if (liveModel) {
      const upstream = process.env.MYBUDDY_LIVE_BASE_URL || 'http://127.0.0.1:3425/v1';
      const loaded = await require('./live-model-config.cjs').loadLiveModel(upstream, process.env.MYBUDDY_LIVE_MODEL || 'auto/deepseek-v4.1-flash');
      model = loaded.model; report.modelConfiguration = loaded.evidence;
      const foreground = process.env.MYBUDDY_DOTS_LIVE_FOREGROUND;
      if (foreground && foreground !== model.id) {
        const second = await require('./live-model-config.cjs').loadLiveModel(upstream, foreground);
        extraModels = [second.model];
        report.foregroundModelConfiguration = second.evidence;
      }
      if (benchmark) {
        const url = new URL(upstream);
        report.providerUpstream = url.origin + url.pathname;
      }
      relay = http.createServer(async (req, res) => {
        const timing = benchmark ? {sequence: providerTimings.length + 1, receivedAtMs: timestamp(),
          method: req.method, scope: providerScope, responseBytes: 0} : null;
        if (timing) providerTimings.push(timing);
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks), requestIndex = requests.length;
          if (timing) Object.assign(timing, {requestIndex, requestBytes: body.length, requestBodyAtMs: timestamp()});
          const request = JSON.parse(body); requests.push(request);
          const journalRecord = {at: Date.now(), body: request};
          if (timing) {
            benchmarkJournal.push(journalRecord);
            Object.assign(timing, {model: request.model, stream: Boolean(request.stream),
              messageCount: request.messages?.length, toolCount: request.tools?.length,
              maxOutputTokens: request.max_completion_tokens ?? request.max_tokens, reasoningEffort: request.reasoning_effort});
          } else {
            fs.appendFileSync(path.join(out, 'provider-requests.jsonl'), JSON.stringify(journalRecord) + '\n');
          }
          if (timing) timing.upstreamSentAtMs = timestamp();
          const response = await fetch(upstream.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer isolated-live-check'},
            body, signal: AbortSignal.timeout(240000),
          });
          await gateLiveResponse?.(request);
          const contentType = response.headers.get('content-type') || 'application/json';
          if (timing) Object.assign(timing, {upstreamHeadersAtMs: timestamp(), upstreamStatus: response.status, contentType});
          res.writeHead(response.status, {'content-type': contentType});
          const decoder = new TextDecoder(); let audit = '';
          const emit = timing && ((data, arrival) => observeProviderRecord(data, arrival, timing, rawUsageAudit));
          const sse = emit && /text\/event-stream/i.test(contentType) ? createSseAudit(emit) : null;
          for await (const chunk of response.body) {
            const arrival = timing && timestamp();
            if (timing) {
              timing.responseBytes += chunk.byteLength;
              if (chunk.byteLength) timing.upstreamFirstByteAtMs ??= arrival;
            }
            res.write(chunk);
            const decoded = decoder.decode(chunk, {stream: true});
            if (sse) sse(decoded, arrival);
            if (!sse || !response.ok) audit += decoded;
          }
          if (timing) timing.upstreamEndAtMs = timestamp();
          const remainder = decoder.decode();
          audit += remainder;
          res.end();
          if (sse) sse(remainder, timing.upstreamEndAtMs, true);
          else if (emit) emit(audit, timing.upstreamEndAtMs);
          else {
            const records = request.stream ? audit.split('\n').filter(line => line.startsWith('data: {')).map(line => line.slice(6)) : [audit];
            for (const record of records) {try {const usage = JSON.parse(record).usage; if (usage) rawUsageAudit.push({requestIndex, usage});} catch {}}
          }
          if (!response.ok) {
            if (timing) timing.error = 'HTTP ' + response.status;
            report.providerError = {status: response.status, body: audit};
          }
        } catch (error) {
          if (timing) Object.assign(timing, {error: String(error), upstreamEndAtMs: timestamp()});
          res.destroy(error); report.transportError = String(error);
        }
      });
      relay.listen(0, '127.0.0.1'); await once(relay, 'listening'); baseUrl = 'http://127.0.0.1:' + relay.address().port + '/v1';
    }
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {fixture: {
      api: 'openai-completions', baseUrl, apiKey: 'isolated-no-user-credentials', models: [model, ...extraModels],
    }}}));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({defaultProvider: 'fixture', defaultModel: model.id,
      enabledModels: [model, ...extraModels].map(m => 'fixture/' + m.id), memoryEnabled: false, memoryGatewayEnabled: false,
      remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly', ...settings}));
    const port = await freePort(), devOut = path.join(out, 'dev-output'), bootstrap = path.join(home, 'bootstrap.cjs');
    fs.writeFileSync(bootstrap, `const fs=require('node:fs');const r=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});const {app}=r('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(userData)});fs.writeFileSync(${JSON.stringify(path.join(home, 'main-identity.json'))},JSON.stringify({pid:process.pid,userData:${JSON.stringify(userData)},startTime:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].trim().split(/\\s+/)[19]:undefined}));require(${JSON.stringify(path.join(devOut, 'main/index.js'))});`);
    if (benchmark) {
      const bootstrapCode = fs.readFileSync(bootstrap, 'utf8');
      fs.writeFileSync(bootstrap, bootstrapCode.replace("const {app}=r('electron');",
        "const {app}=r('electron');app.on('browser-window-created',(_event,window)=>window.on('show',()=>window.hide()));"));
    }
    const env = {...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
      APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      REMOTE_DEBUGGING_PORT: String(port), ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'])};
    delete env.ELECTRON_RUN_AS_NODE;
    const pnpm = process.env.npm_execpath;
    if (!pnpm || !fs.existsSync(pnpm)) throw Error('Run the registered pnpm test script');
    const rendererConfig = (benchmark || !watchRenderer) ? path.join(home, 'isolated-electron-vite.mjs') : undefined;
    if (rendererConfig) {
      const baseConfig = path.relative(home, path.join(root, 'electron.vite.config.ts')).split(path.sep).join('/');
      fs.writeFileSync(rendererConfig, [
        'import config from ' + JSON.stringify(baseConfig),
        ...(isolatedDependencyCache ? [
          'import { writeFileSync } from "node:fs"',
          'config.renderer.cacheDir = ' + JSON.stringify(path.join(home, 'vite-cache')),
          // Some Windows environments allow Node to write the cache while denying direct writes by esbuild.exe.
          'config.renderer.optimizeDeps = { esbuildOptions: { write: false, plugins: [{',
          '  name: "write-isolated-cache",',
          '  setup(build) {',
          '    build.onEnd(result => {',
          '      for (const file of result.outputFiles ?? []) {',
          '        if (file.path !== "<stdout>") writeFileSync(file.path, file.contents)',
          '      }',
          '    })',
          '  }',
          '}] } }',
        ] : []),
        'config.renderer.server = { ...config.renderer.server, hmr: false, watch: null }',
        'export default config',
      ].join('\n'));
      report.rendererWatch = false;
      report.rendererHmr = false;
    }
    const launch = async () => {
      const args = ['dev', '--outDir', devOut, '--entry', bootstrap];
      if (rendererConfig) args.push('--config', rendererConfig);
      log = fs.openSync(path.join(out, 'dev.log'), 'a');
      const native = !/\.[cm]?js$/i.test(pnpm);
      child = cp.spawn(native ? pnpm : process.execPath, native ? args : [pnpm, ...args], {cwd: root, env, windowsHide: true, stdio: ['ignore', log, log]});
      fs.closeSync(log); log = undefined;
      let target;
      await until(async () => {
        if (child.exitCode !== null) throw Error('pnpm dev exited ' + child.exitCode);
        try {target = (await fetch('http://127.0.0.1:' + port + '/json/list', {signal: AbortSignal.timeout(2000)}).then(r => r.json())).find(t => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url)); return Boolean(target);} catch {return false;}
      }, 'dev renderer');
      const connection = new WebSocket(target.webSocketDebuggerUrl);
      socket = connection;
      connection.addEventListener('close', () => disconnect(connection), {once: true});
      await once(connection, 'open');
      connection.addEventListener('message', event => {
        if (socket !== connection) return;
        const value = JSON.parse(event.data);
        if (value.method === 'Runtime.exceptionThrown') report.rendererErrors.push(value.params);
        const call = pending.get(value.id); if (!call) return;
        pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(Error(JSON.stringify(value.error))) : call.resolve(value.result);
      });
      await rpc('Runtime.enable'); await rpc('Page.enable');
      await rpc('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      const ready = benchmark ? 'Boolean(window.api?.agent)' : 'Boolean(window.api?.agent && document.querySelector("[data-desktop-main]"))';
      await until(() => evaluate(ready), 'app and preload');
      await until(() => evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().models.length>0)`), 'initial store bootstrap');
      if (benchmark) report.rendererReadyAtMs = Date.now();
      if (!benchmark) await rpc('Page.bringToFront');
    };
    await launch();
    await scenario({evaluate, rpc, until, report, out, home, requests, rawUsageAudit, providerTimings,
      setProviderScope: scope => {providerScope = scope;},
      getOwnedElectronPids: () => fs.existsSync(path.join(home, 'main-identity.json')) ? [JSON.parse(fs.readFileSync(path.join(home, 'main-identity.json'))).pid] : [],
      restart: async (whileStopped) => {await stop(); await whileStopped?.(); await launch();}});
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
    if (socket?.readyState === WebSocket.OPEN) try {report.visibleText = await evaluate('document.body.innerText');const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failed-page.png'),Buffer.from(shot.data,'base64'));} catch {}
  } finally {
    await stop().catch(error => {report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1;});
    relay?.closeAllConnections(); relay?.close(); report.ownedMainPids = [...owned];
    if (benchmarkJournal.length) fs.writeFileSync(path.join(out, 'provider-requests.jsonl'),
      benchmarkJournal.map(record => JSON.stringify(record) + '\n').join(''));
    fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(requests));
    if (fixtureUsage) fs.writeFileSync(path.join(out, 'fixture-usage.json'), JSON.stringify(rawUsageAudit, null, 2));
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
