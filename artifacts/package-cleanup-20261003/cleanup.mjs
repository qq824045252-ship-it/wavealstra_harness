import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';

// The user requested retaining one MyBuddy package. Resolve and verify every
// obsolete output here, in the same Git Bash / Node process that invokes FastCopy.
const repo = path.resolve('C:/Users/servi/Documents/GitHub/wavealstra_harness');
const portable = path.resolve('C:/Users/servi/AppData/Local/Programs/MyBuddy/portable');
const skillPackages = path.join(repo, 'artifacts/skill-learning-20261002');
const keep = path.join(portable, 'release-computer-use-browser-20261003-final');
const keptExe = path.join(keep, 'win-unpacked/MyBuddy.exe');
const keptAsar = path.join(keep, 'win-unpacked/resources/app.asar');
const expectedHash = 'b5628c521efca39389910ee32038c0280c742128ff3ae9bf114c593bd92d3adf';
const wrapper = 'C:/Users/servi/.mybuddy/skills/fastcopy-copy/scripts/fcopy.mjs';
const reportDir = path.join(repo, 'artifacts/package-cleanup-20261003');
const targets = [
  ...['release-computer-use-browser-20261003', 'release-electron4451-20261002001301583',
    'release-pi-native-core-20261002', 'release-skill-learning-20261002-1059',
    'release-skill-learning-20261002-1110', 'release-todo-plan-removal-20261002']
    .map(name => path.join(portable, name)),
  path.join(repo, 'release-next'),
  ...['verified-package', 'recovery-package', 'git-package-07a756a7',
    'final-package', 'accepted-package', 'package'].map(name => path.join(skillPackages, name)),
];
const normalized = value => path.resolve(value).toLowerCase();
const inside = (root, target) => {
  const rel = path.relative(normalized(root), normalized(target));
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function processes() {
  const code = `@(Get-CimInstance Win32_Process -Filter "Name='MyBuddy.exe'" |
    Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate) | ConvertTo-Json -Compress`;
  const result = cp.execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', code],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  return result ? [].concat(JSON.parse(result)) : [];
}

function inventory(root) {
  let files = 0, bytes = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      const stat = fs.lstatSync(item);
      assert(!stat.isSymbolicLink(), 'Unexpected link: ' + item);
      if (stat.isDirectory()) visit(item);
      else {
        assert(stat.isFile(), 'Unexpected file type: ' + item);
        files++; bytes += stat.size;
      }
    }
  }
  visit(root);
  return { path: root, files, bytes };
}

function checkTarget(target) {
  assert(fs.existsSync(target), 'Target missing: ' + target);
  const approvedRoot = inside(portable, target) ? portable
    : inside(skillPackages, target) ? skillPackages
      : normalized(target) === normalized(path.join(repo, 'release-next')) ? repo : null;
  assert(approvedRoot, 'Target outside approved package directories: ' + target);
  assert(inside(approvedRoot, target), 'Cannot delete a package root');
  assert(!inside(target, keep) && normalized(target) !== normalized(keep), 'Retained package overlap');
  assert.equal(normalized(fs.realpathSync(target)), normalized(target), 'Redirected package path');
  for (let current = target;; current = path.dirname(current)) {
    assert(!fs.lstatSync(current).isSymbolicLink(), 'Redirected ancestor: ' + current);
    if (normalized(current) === normalized(approvedRoot)) break;
  }
  assert([target, path.join(target, 'win-unpacked')]
    .some(layout => fs.existsSync(path.join(layout, 'resources/app.asar'))), 'Not an app package');
  if (inside(repo, target)) {
    const tracked = cp.execFileSync('git', ['ls-files', '--', path.relative(repo, target)],
      { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(tracked.trim(), '', 'Tracked source found in package');
  }
}

assert.equal(new Set(targets.map(normalized)).size, targets.length);
assert(fs.existsSync(keptExe));
assert.equal(hash(keptAsar), expectedHash);
for (const target of targets) checkTarget(target);
const before = processes();
for (const process of before)
  assert.equal(normalized(process.ExecutablePath), normalized(keptExe), 'An older package is running');
const report = {
  startedAt: new Date().toISOString(), status: 'prepared',
  kept: { directory: keep, executable: keptExe, asarSha256: expectedHash },
  beforeProcesses: before, packages: targets.map(inventory),
  deleted: [], releasedBytes: 0, logs: [],
};
const reportFile = path.join(reportDir, 'results.json');
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
save();
console.log(JSON.stringify({ stage: 'checked', deleteDirectories: targets.length,
  bytes: report.packages.reduce((sum, item) => sum + item.bytes, 0), keep }));

try {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    checkTarget(target); inventory(target);
    for (const process of processes())
      assert(!inside(target, process.ExecutablePath), 'Target became active');
    const log = path.join(reportDir, 'delete-' + String(i + 1).padStart(2, '0') + '.log');
    const result = cp.spawnSync(process.execPath,
      [wrapper, '--src', target, '--mode', 'delete', '--no-confirm-del', '--log-file', log],
      { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(log + '.stdout.txt', (result.stdout || '') + (result.stderr || ''));
    report.logs.push({ target, log, exitCode: result.status }); save();
    assert.equal(result.status, 0, 'FastCopy failed: ' + target + ' ' +
      (result.error?.message || result.stderr || ''));
    assert(!fs.existsSync(target), 'Package still exists after FastCopy: ' + target);
    report.deleted.push(target); report.releasedBytes += report.packages[i].bytes; save();
    console.log(JSON.stringify({ deleted: i + 1, total: targets.length, path: target }));
  }
  assert.equal(hash(keptAsar), expectedHash);
  assert.deepEqual(fs.readdirSync(portable), [path.basename(keep)]);
  report.afterProcesses = processes();
  for (const process of report.afterProcesses)
    assert.equal(normalized(process.ExecutablePath), normalized(keptExe));
  const main = before.find(process => process.ProcessId === 38672);
  if (main) report.originalMainStillRunning = report.afterProcesses.some(process =>
    process.ProcessId === main.ProcessId && process.CreationDate === main.CreationDate);
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, deletedDirectories: report.deleted.length,
    releasedBytes: report.releasedBytes, GiB: Number((report.releasedBytes / 1073741824).toFixed(2)),
    retainedHash: hash(keptAsar), originalMainStillRunning: report.originalMainStillRunning, reportFile }));
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  report.finishedAt = new Date().toISOString(); save(); throw error;
}
