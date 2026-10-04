/** Deploy the exact accepted Pi-native portable to an idle user desktop, with data backup and rollback. */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.env.MYBUDDY_DEPLOY_REPORT_DIR || path.join(root, 'artifacts/pi-native-core-tools'));
const home = path.join(os.homedir(), '.mybuddy');
const dbPath = path.join(home, 'app.db');
const executable = path.resolve(process.env.MYBUDDY_DEPLOY_EXE || path.join(os.homedir(), 'AppData/Local/Programs/MyBuddy/portable/release-pi-native-core-20261002/win-unpacked/MyBuddy.exe'));
const asar = path.join(path.dirname(executable), 'resources/app.asar');
const expectedAsarSha256 = process.env.MYBUDDY_DEPLOY_ASAR_SHA256 || '96dcf9e9295a6c19607ea40eb6894ba22b683e57e6d54bfd10a8e4cd554c1922';
assert(/^[a-f0-9]{64}$/.test(expectedAsarSha256), 'Provide the exact accepted app.asar SHA-256');
const mode = process.argv[2], expectedPid = Number(process.argv[3]), expectedStart = Number(process.argv[4]);
assert(['--inspect', '--deploy', '--deploy-closed', '--finish', '--recover', '--verify-alive'].includes(mode), 'Provide a deployment operation followed by verified main PID and creation timestamp');
assert(Number.isInteger(expectedPid) && expectedPid > 0 && Number.isFinite(expectedStart) && expectedStart > 1e12);
process.chdir(root);

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const desktopHelperEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('MYBUDDY_DEPLOY_')));
const ps = code => cp.execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', env: desktopHelperEnv, windowsHide: true, timeout: 20000 }).trim();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processInfo(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  const json = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p){$g=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;[pscustomobject]@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;path=$p.ExecutablePath;startMs=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();isMain=($p.CommandLine -notmatch '--type=');mainWindowHandle=[long]$g.MainWindowHandle}|ConvertTo-Json -Compress}`);
  return json ? JSON.parse(json) : null;
}
function sameProcess(pid, startMs, expectedPath) {
  const current = processInfo(pid);
  assert(current && current.startMs === startMs && current.isMain && /MyBuddy\.exe$/i.test(current.path), 'Verified main-process identity changed');
  if (expectedPath) assert(samePath(current.path, expectedPath), 'Verified process executable changed');
  return current;
}
function assertOnlyUserMain(pid) {
  const json = ps(`@(Get-CimInstance Win32_Process -Filter "Name='MyBuddy.exe'"|Where-Object {$_.CommandLine -notmatch '--type='}|Select-Object -ExpandProperty ProcessId)|ConvertTo-Json -Compress`);
  const pids = json ? [].concat(JSON.parse(json)) : [];
  assert.deepEqual(pids, [pid], 'Another MyBuddy main instance remains; do not disturb another profile or active desktop');
}
function mainProcesses() {
  const json = ps(`@(Get-CimInstance Win32_Process -Filter "Name='MyBuddy.exe'"|Where-Object {$_.CommandLine -notmatch '--type='}|ForEach-Object {[pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;path=$_.ExecutablePath;startMs=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();isMain=$true}})|ConvertTo-Json -Compress`);
  return json ? [].concat(JSON.parse(json)) : [];
}
function idleCheck(startMs) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runningSinceStart = db.prepare("SELECT COUNT(*) AS count FROM task_runtime_context_snapshots WHERE status='running' AND started_at>=?").get(startMs).count;
    const unexpiredLeases = db.prepare('SELECT COUNT(*) AS count FROM task_run_leases WHERE expires_at>?').get(Date.now()).count;
    const hasExternal = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_agent_runs'").get();
    const activeExternalRuns = hasExternal ? db.prepare("SELECT COUNT(*) AS count FROM external_agent_runs WHERE status IN ('starting','working','blocked') AND started_at>=?").get(startMs).count : 0;
    const result = { at: new Date().toISOString(), runningSinceStart, unexpiredLeases, activeExternalRuns,
      active: runningSinceStart > 0 || unexpiredLeases > 0 || activeExternalRuns > 0 };
    assert(!result.active, 'Recorded live user work remains; no process will be terminated');
    return result;
  } finally { db.close(); }
}
async function remoteHealth() {
  try { return (await fetch('http://127.0.0.1:3352/healthz', { signal: AbortSignal.timeout(1500) })).status; }
  catch { return null; }
}
function childReadiness(pid) {
  return JSON.parse(ps(`$children=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}'|Where-Object {$_.Name -eq 'MyBuddy.exe'});[pscustomobject]@{childProcessCount=$children.Count;rendererCount=@($children|Where-Object {$_.CommandLine -match '--type=renderer'}).Count}|ConvertTo-Json -Compress`));
}
async function desktopReadiness(identity, requireVisible, previousRemoteHealth) {
  let result;
  for (let i = 0; i < 60; i++) {
    const current = sameProcess(identity.pid, identity.startMs, identity.path);
    const children = childReadiness(current.pid);
    result = { at: new Date().toISOString(), ...children, mainWindowHandle: current.mainWindowHandle,
      previousWindowVisible: requireVisible, remoteHealth: await remoteHealth() };
    if (children.rendererCount > 0 && (!requireVisible || current.mainWindowHandle > 0)
      && (previousRemoteHealth !== 200 || result.remoteHealth === 200)) {
      if (result.remoteHealth === 200) {
        try {
          const response = await fetch('http://127.0.0.1:3352/', { method: 'HEAD', signal: AbortSignal.timeout(1500) });
          result.remoteAppStatus = response.status;
          result.remoteAppContentType = response.headers.get('content-type');
          if (response.status !== 200 || !/text\/html/i.test(result.remoteAppContentType || '')) { await delay(300); continue; }
        } catch { await delay(300); continue; }
      }
      await delay(300);
      sameProcess(identity.pid, identity.startMs, identity.path);
      const stable = childReadiness(identity.pid);
      if (stable.rendererCount > 0) return { ...result, stableRendererCount: stable.rendererCount };
    }
    await delay(300);
  }
  throw new Error('Accepted desktop failed initialization readiness: ' + JSON.stringify(result));
}
function acceptedEvidence() {
  const desktopFile = path.resolve(process.env.MYBUDDY_DEPLOY_DESKTOP_REPORT || path.join(root, 'artifacts/pi-native-core/desktop-live/results.json'));
  const coreFile = path.resolve(process.env.MYBUDDY_DEPLOY_CORE_REPORT || path.join(root, 'artifacts/pi-native-core-tools/results.json'));
  const desktop = JSON.parse(fs.readFileSync(desktopFile, 'utf8'));
  const core = JSON.parse(fs.readFileSync(coreFile, 'utf8'));
  const suite = process.env.MYBUDDY_DEPLOY_DESKTOP_SUITE || 'pi-native-core';
  const suites = {
    'pi-native-core': { kind: 'pi-native-core-real-provider-packaged-electron', required: ['four-native-core-tools', 'native-nonzero-failure', 'native-running-command-cancellation'] },
    'computer-use-browser': { kind: 'computer-use-real-provider-packaged-electron', required: ['hidden-browser-screenshot-and-action', 'computer-stop-preserves-agent-task'] },
  };
  assert(Object.hasOwn(suites, suite), 'Unknown packaged desktop acceptance suite');
  assert.equal(desktop.status, 'passed');
  assert.equal(desktop.kind, suites[suite].kind);
  assert.deepEqual(desktop.rendererErrors, []);
  assert.equal(desktop.temporaryCredentialsRemoved, true);
  const required = suites[suite].required;
  assert.equal(desktop.tests.length, required.length);
  for (const name of required) assert(desktop.tests.some(test => test.name === name && test.status === 'passed'), 'Missing accepted desktop case: ' + name);
  assert(samePath(desktop.executable, executable), 'Desktop acceptance belongs to another portable');
  assert(!fs.existsSync(path.join(path.dirname(desktopFile), 'acceptance.lock')), 'Desktop acceptance has not finished cleaning up');
  assert.equal(core.passed, true); assert.equal(core.results.length, 16); assert(core.results.every(test => test.passed));
  assert.equal(core.hostCalls, 0);
  assert(core.results.some(test => test.name.startsWith('restored session uses native settings.defaultTools') && test.passed));
  assert(fs.existsSync(executable) && fs.existsSync(asar));
  const asarSha256 = hash(asar); assert.equal(asarSha256, desktop.asarSha256, 'Accepted app.asar changed');
  assert.equal(asarSha256, expectedAsarSha256, 'app.asar differs from the specifically approved build');
  return { desktopFile, coreFile, suite, desktopCases: desktop.tests.length, nativeCoreCases: core.results.length,
    asarSha256, observedModels: desktop.observedModels };
}
function shortcutInfo() {
  return JSON.parse(ps(`$w=New-Object -ComObject WScript.Shell;$items=@(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Desktop')) -Filter '*MyBuddy*.lnk');if($items.Count -ne 1){throw 'Expected exactly one existing MyBuddy shortcut'};$f=$items[0].FullName;$s=$w.CreateShortcut($f);[pscustomobject]@{path=$f;target=$s.TargetPath;workingDirectory=$s.WorkingDirectory;icon=$s.IconLocation}|ConvertTo-Json -Compress`));
}
function updateShortcut(shortcut) {
  ps(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${quote(shortcut)});$s.TargetPath=${quote(executable)};$s.WorkingDirectory=${quote(path.dirname(executable))};$s.IconLocation=${quote(executable + ',0')};$s.Save()`);
  const current = shortcutInfo();
  assert.equal(current.path, shortcut); assert(samePath(current.target, executable));
  assert(samePath(current.workingDirectory, path.dirname(executable)));
  return current;
}
async function stopIdleProcess(identity) {
  sameProcess(identity.pid, identity.startMs, identity.path); idleCheck(identity.startMs);
  ps(`$p=Get-Process -Id ${identity.pid} -ErrorAction Stop;$null=$p.CloseMainWindow()`);
  await delay(800);
  if (processInfo(identity.pid)) {
    sameProcess(identity.pid, identity.startMs, identity.path); idleCheck(identity.startMs);
    cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  }
  for (let i = 0; i < 40 && processInfo(identity.pid); i++) await delay(100);
  assert.equal(processInfo(identity.pid), null, 'Verified idle process did not stop');
}
async function startDesktop(target, onSpawn, requireVisible = false) {
  assert.deepEqual(mainProcesses(), [], 'A MyBuddy main instance already exists; do not launch or replace another instance');
  const shortcut = shortcutInfo();
  const launchTarget = samePath(shortcut.target, target) ? shortcut.path : target;
  // Shell dispatch launches the interactive application outside the helper lifecycle; verify persistence separately after this helper exits.
  ps(`$shell=New-Object -ComObject Shell.Application;$shell.ShellExecute(${quote(launchTarget)},'',${quote(path.dirname(target))},'open',${requireVisible ? 1 : 0})`);
  let current, reportedPid;
  for (let i = 0; i < 100; i++) {
    await delay(300);
    const mains = mainProcesses(); assert(mains.length <= 1, 'Multiple MyBuddy main instances appeared during launch');
    current = mains[0] ? processInfo(mains[0].pid) : null;
    if (current && !reportedPid) { assert(samePath(current.path, target)); reportedPid = current.pid; onSpawn?.(current.pid); }
    if (current && samePath(current.path, target) && current.isMain
      && (!requireVisible || current.mainWindowHandle > 0) && childReadiness(current.pid).rendererCount > 0) break;
  }
  assert(current && current.isMain && samePath(current.path, target)
    && (!requireVisible || current.mainWindowHandle > 0) && childReadiness(current.pid).rendererCount > 0,
    'Expected portable did not initialize its desktop renderer');
  const parentJson = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${current.parentPid}';if($p){[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath}|ConvertTo-Json -Compress}`);
  const parent = parentJson ? JSON.parse(parentJson) : null;
  current.launchParent = parent || { pid: current.parentPid, alive: false };
  return current;
}

const report = { at: new Date().toISOString(), status: 'preparing', runningInstanceChanged: false, executable };
function save() { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'deployment.json'), JSON.stringify(report, null, 2)); }
async function rollback() {
  const result = report.rollback = { startedAt: new Date().toISOString(), status: 'preparing' };
  try {
    if (mode === '--deploy-closed') {
      // ShellExecute does not return a uniquely owned child PID. Never terminate an app
      // that the user may have started concurrently after the empty-process check.
      if (report.shortcutChanged) {
        const shortcut = shortcutInfo();
        assert.equal(shortcut.path, report.previousShortcut.path);
        assert(samePath(shortcut.target, executable) || samePath(shortcut.target, report.previousShortcut.target), 'User changed the desktop entry; preserve it');
        fs.copyFileSync(report.shortcutBackup, report.previousShortcut.path);
      }
      const mains = mainProcesses();
      if (mains.length) {
        result.status = 'current-application-preserved'; result.processes = mains;
      } else {
        result.process = await startDesktop(report.previousProcess.path, undefined, report.previousProcess.mainWindowHandle > 0);
        result.status = 'previous-executable-and-shortcut-restored';
      }
      result.databaseRestored = false; result.finishedAt = new Date().toISOString(); return;
    }
    if (report.newPid) {
      const current = processInfo(report.newPid);
      if (current) {
        assert(samePath(current.path, executable) && current.isMain, 'New-process identity changed; automatic rollback refused');
        if (report.currentProcess) assert.equal(current.startMs, report.currentProcess.startMs);
        idleCheck(current.startMs); await stopIdleProcess(current);
      }
    }
    if (report.shortcutChanged) fs.copyFileSync(report.shortcutBackup, report.previousShortcut.path);
    if (report.previousProcess && !processInfo(report.previousProcess.pid)) {
      result.process = await startDesktop(report.previousProcess.path, undefined, report.previousProcess.mainWindowHandle > 0);
      assert(samePath(result.process.path, report.previousProcess.path));
    }
    if (report.previousRemoteHealth === 200) {
      for (let i = 0; i < 60; i++) {
        result.remoteHealth = await remoteHealth();
        if (result.remoteHealth === 200) break;
        await delay(300);
      }
      assert.equal(result.remoteHealth, 200, 'Previous remote endpoint did not recover during rollback');
    }
    result.status = 'previous-executable-and-shortcut-restored';
    result.databaseRestored = false; // Never overwrite user data; the consistent backup remains available.
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.status = 'blocked'; result.error = String(error);
  }
}
async function completeDeployment() {
  report.readiness = await desktopReadiness(report.currentProcess, report.previousProcess.mainWindowHandle > 0, report.expectedRemoteHealth ?? report.previousRemoteHealth);
  assert.equal(hash(asar), report.asarSha256);
  report.shortcutChanged = true; save();
  report.shortcut = updateShortcut(report.previousShortcut.path);
  report.remoteHealth = report.readiness.remoteHealth;
  report.currentProcess = sameProcess(report.newPid, report.currentProcess.startMs, executable);
  assertOnlyUserMain(report.newPid);
  assert.equal(hash(asar), report.asarSha256);
  report.status = 'deployed'; report.runningInstanceChanged = true; report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify(report, null, 2));
}
(async () => {
  try {
    if (mode === '--verify-alive') {
      Object.assign(report, JSON.parse(fs.readFileSync(path.join(out, 'deployment.json'), 'utf8')));
      assert.equal(report.status, 'deployed'); assert.equal(report.newPid, expectedPid);
      assert.equal(report.currentProcess.startMs, expectedStart);
      const elapsed = Date.now() - Date.parse(report.finishedAt);
      assert(elapsed >= 30000, 'Independent persistence verification must follow helper completion by at least 30 seconds');
      const current = sameProcess(expectedPid, expectedStart, executable); assertOnlyUserMain(expectedPid);
      const readiness = await desktopReadiness(current, report.previousProcess.mainWindowHandle > 0, report.expectedRemoteHealth ?? report.previousRemoteHealth);
      const parentJson = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${current.parentPid}';if($p){[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath}|ConvertTo-Json -Compress}`);
      const parent = parentJson ? JSON.parse(parentJson) : { pid: current.parentPid, alive: false };
      assert.equal(hash(asar), expectedAsarSha256); assert(samePath(shortcutInfo().target, executable));
      report.postHelperPersistence = { at: new Date().toISOString(), elapsedSinceCompletionMs: elapsed,
        currentProcess: current, launchParent: parent, readiness, passed: true }; save();
      console.log(JSON.stringify(report.postHelperPersistence, null, 2)); return;
    }
    if (mode === '--recover') {
      Object.assign(report, JSON.parse(fs.readFileSync(path.join(out, 'deployment.json'), 'utf8')));
      assert.equal(report.status, 'failed'); assert.equal(report.oldStopped, true);
      assert.equal(report.newPid, expectedPid); assert.equal(report.currentProcess.startMs, expectedStart);
      assert.equal(processInfo(expectedPid), null, 'The accepted instance remains alive; do not restart it');
      assert.deepEqual(mainProcesses(), []);
      assert(samePath(report.executable, executable)); assert.equal(report.asarSha256, expectedAsarSha256);
      report.acceptance = acceptedEvidence();
      report.beforeRecover = idleCheck(expectedStart);
      const checked = new DatabaseSync(report.backup, { readOnly: true });
      try { assert.equal(checked.prepare('PRAGMA quick_check').get().quick_check, 'ok'); } finally { checked.close(); }
      assert(fs.existsSync(report.shortcutBackup)); assert(samePath(shortcutInfo().target, executable));
      report.previousDeploymentFailure = { error: report.error, finishedAt: report.finishedAt };
      delete report.error; delete report.finishedAt; report.status = 'preparing'; save();
      report.launchMethod = 'Shell.Application.ShellExecute'; save();
      report.currentProcess = await startDesktop(executable, pid => { report.newPid = pid; save(); }, report.previousProcess.mainWindowHandle > 0);
      report.launchParent = report.currentProcess.launchParent;
      await completeDeployment(); return;
    }
    if (mode === '--finish') {
      Object.assign(report, JSON.parse(fs.readFileSync(path.join(out, 'deployment.json'), 'utf8')));
      assert(['preparing', 'failed'].includes(report.status)); assert.equal(report.oldStopped, true); assert.equal(report.newPid, expectedPid);
      assert(samePath(report.executable, executable)); assert.equal(report.asarSha256, expectedAsarSha256);
      assert.equal(processInfo(report.previousProcess.pid), null, 'Previous process restarted; do not adopt a competing instance');
      report.acceptance = acceptedEvidence();
      report.currentProcess = sameProcess(expectedPid, expectedStart, executable); assertOnlyUserMain(expectedPid);
      report.beforeFinish = idleCheck(expectedStart);
      assert(path.resolve(report.backup).toLowerCase().startsWith(path.join(home, 'backups', 'pi-native-core-').toLowerCase()));
      const checked = new DatabaseSync(report.backup, { readOnly: true });
      try { assert.equal(checked.prepare('PRAGMA quick_check').get().quick_check, 'ok'); } finally { checked.close(); }
      assert(fs.existsSync(report.shortcutBackup));
      const shortcut = shortcutInfo(); assert.equal(shortcut.path, report.previousShortcut.path);
      assert(samePath(shortcut.target, report.previousShortcut.target) || samePath(shortcut.target, executable));
      if (report.error) { report.resumedFailure = { error: report.error, finishedAt: report.finishedAt }; delete report.error; delete report.finishedAt; }
      report.launchMethod = 'Shell.Application.ShellExecute';
      report.launchParent = { pid: report.currentProcess.parentPid };
      report.status = 'preparing';
      report.resumedAfterReadinessCorrection = true; save();
      await completeDeployment(); return;
    }
    if (mode === '--deploy-closed') {
      assert.equal(processInfo(expectedPid), null, 'Previously observed instance is still alive; use normal idle deployment');
      assert.deepEqual(mainProcesses(), [], 'Another MyBuddy instance exists; do not launch a competing instance');
      const previousShortcut = shortcutInfo();
      assert(fs.existsSync(previousShortcut.target) && /MyBuddy\.exe$/i.test(previousShortcut.target), 'Previous desktop shortcut must remain available for rollback');
      report.previousInstanceAlreadyClosed = true;
      report.previousProcess = { pid: expectedPid, startMs: expectedStart, path: previousShortcut.target, isMain: true, mainWindowHandle: 0 };
    } else {
      report.previousProcess = sameProcess(expectedPid, expectedStart);
      assertOnlyUserMain(expectedPid);
    }
    report.beforeBackup = idleCheck(expectedStart);
    if (mode === '--inspect') {
      console.log(JSON.stringify({ status: 'idle', previousProcess: report.previousProcess, idle: report.beforeBackup }, null, 2)); return;
    }
    report.acceptance = acceptedEvidence(); report.asarSha256 = report.acceptance.asarSha256;
    assert(fs.existsSync(report.previousProcess.path), 'Previous executable must remain available for rollback');
    report.previousRemoteHealth = await remoteHealth(); report.previousShortcut = shortcutInfo();
    report.expectedRemoteHealth = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).remoteAccessEnabled ? 200 : report.previousRemoteHealth;
    save();
    const folder = path.join(home, 'backups', 'pi-native-core-' + new Date().toISOString().replace(/\D/g, ''));
    fs.mkdirSync(folder, { recursive: true });
    const destination = path.join(folder, 'app.db');
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try { await backup(source, destination); } finally { source.close(); }
    const checked = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(checked.prepare('PRAGMA quick_check').get().quick_check, 'ok'); } finally { checked.close(); }
    for (const name of ['settings.json', 'mcp.json']) if (fs.existsSync(path.join(home, name))) fs.copyFileSync(path.join(home, name), path.join(folder, name));
    report.backup = destination;
    report.shortcutBackup = path.join(folder, 'MyBuddy-before.lnk');
    fs.copyFileSync(report.previousShortcut.path, report.shortcutBackup);
    report.beforeClose = idleCheck(expectedStart);
    if (mode === '--deploy-closed') {
      assert.deepEqual(mainProcesses(), []); assert.equal(processInfo(expectedPid), null);
    } else {
      sameProcess(expectedPid, expectedStart, report.previousProcess.path); assertOnlyUserMain(expectedPid);
    }
    assert.equal(hash(asar), report.asarSha256); save();
    if (mode !== '--deploy-closed') {
      report.oldStopRequested = true; save();
      await stopIdleProcess(report.previousProcess);
    }
    report.oldStopped = true; save();
    report.currentProcess = await startDesktop(executable, pid => { report.newPid = pid; save(); }, report.previousProcess.mainWindowHandle > 0);
    report.launchParent = report.currentProcess.launchParent;
    await completeDeployment();
  } catch (error) {
    report.status = 'failed'; report.error = String(error);
    if (['--deploy', '--deploy-closed'].includes(mode) && (report.oldStopRequested || report.newPid || report.shortcutChanged)) await rollback();
    report.finishedAt = new Date().toISOString();
    if (mode !== '--inspect') save();
    console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
  }
})();
