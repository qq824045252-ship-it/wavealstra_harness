// Real packaged-app startup with an empty profile; never touches live credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { verifyPackagedApp, formatReport } = require('./verify-packaged-app.cjs');
const appDir = path.resolve(process.argv[2] || 'release/win-unpacked');
const verification = verifyPackagedApp(appDir);
console.log(formatReport(appDir, verification));
assert(verification.ok, verification.errors.join('\n'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-officecli-packaged-'));
const userData = path.join(root, 'chromium');
const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), PI_CODING_AGENT_DIR: path.join(root, '.mybuddy') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(appDir, verification.facts.executable), [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', data => logs += data);
child.stderr.on('data', data => logs += data);
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
let socket;
async function main() {
  const plugin = await import(pathToFileURL(path.join(appDir, 'resources/magpie-agent-mybuddy/mybuddy.agent.js')).href);
  assert.deepEqual(plugin.agent.library, { skills: '~/.mybuddy/plugins/skills' });
  const deadline = Date.now() + 45000;
  let page;
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `packaged app exited: ${child.exitCode}\n${logs}`);
    try {
      const port = fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find(item => item.type === 'page' && /index.html/.test(item.url));
      if (page) break;
    } catch { /* wait for this isolated instance's renderer */ }
    await pause();
  }
  assert(page, `packaged renderer did not start\n${logs}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id); }
  };
  function evaluate(expression) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('packaged IPC timed out')); }, 10000);
      pending.set(id, result => { clearTimeout(timer); resolve(result); });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  let response;
  while (Date.now() < deadline) {
    response = await evaluate('(async () => window.api?.agent ? await window.api.agent.listSkills() : null)()');
    if (Array.isArray(response.result?.result?.value)) break;
    await pause();
  }
  const skills = response?.result?.result?.value;
  assert(Array.isArray(skills), JSON.stringify(response));
  const skill = skills.find(item => item.id === 'officecli');
  assert(skill?.enabled, 'fresh packaged app must expose the bundled skill through real IPC');
  assert(skill.filePath.startsWith(root), 'skill must be installed in the disposable profile');
  assert(fs.existsSync(path.join(path.dirname(skill.filePath), 'references/cli-operations.md')));
  const modeResponse = await evaluate('window.api.agent.getModeProfile("working")');
  const mode = modeResponse.result?.result?.value;
  assert.deepEqual(mode?.policy?.presets?.find(preset => preset.id === 'general-office')?.skillPolicy?.allow, ['officecli'], 'packaged general-office default must whitelist OfficeCLI');
  assert(logs.includes('[OfficeCLI] bundled binary=' + verification.facts.officecliBinary), 'main process must select the packaged binary');
  assert(logs.includes('[OfficeCLI] skill=created'), 'startup must seed the packaged skill');
  console.log('PASS real packaged startup, bundled binary selection, skill IPC, general-office whitelist and references');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  // Terminate only the main process this validator created.
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  fs.mkdirSync('out/diagnostics', { recursive: true });
  fs.writeFileSync('out/diagnostics/officecli-packaged-startup.log', logs);
  // Chromium may retain files for a moment during child shutdown; keep evidence on failure.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log(`Temporary profile retained: ${root}`); }
});
