import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';

const nativeRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const lockfile = nativeRequire('proper-lockfile');
const originalLock = lockfile.lockSync;
const root = mkdtempSync(join(tmpdir(), 'pi-settings-retry-'));
const agentDir = join(root, 'agent');
const settingsFile = join(agentDir, 'settings.json');
mkdirSync(agentDir);
writeFileSync(settingsFile, JSON.stringify({ enabledModels: ['fixture/allowed'] }));

function scenario({ code, syscall = 'mkdir', path = `${settingsFile}.lock`, failures, attempts, succeeds }) {
  let calls = 0;
  const failure = Object.assign(new Error('fixture lock failure'), { code, syscall, path });
  lockfile.lockSync = (file, options) => {
    if (file === settingsFile && ++calls <= failures) throw failure;
    return originalLock(file, options);
  };
  try {
    const settings = SettingsManager.create(root, agentDir);
    assert.equal(calls, attempts);
    const errors = settings.drainErrors();
    if (succeeds) {
      assert.deepEqual(errors, []);
      assert.deepEqual(settings.getEnabledModels(), ['fixture/allowed']);
    } else {
      assert.equal(errors.length, 1);
      assert.equal(errors[0].error, failure);
    }
  } finally {
    lockfile.lockSync = originalLock;
  }
}

try {
  const windows = process.platform === 'win32';
  scenario({ code: 'ELOCKED', failures: 2, attempts: 3, succeeds: true });
  scenario({ code: 'EPERM', failures: 2, attempts: windows ? 3 : 1, succeeds: windows });
  scenario({ code: 'EPERM', failures: Infinity, attempts: windows ? 10 : 1, succeeds: false });
  scenario({ code: 'EPERM', syscall: 'open', failures: Infinity, attempts: 1, succeeds: false });
  scenario({ code: 'EPERM', path: `${settingsFile}.other`, failures: Infinity, attempts: 1, succeeds: false });
  scenario({ code: 'EACCES', failures: Infinity, attempts: 1, succeeds: false });
  console.log('PASS native Pi settings: transient lock errors recover; persistent and unrelated access errors stay visible; retry bound preserved');
} finally {
  lockfile.lockSync = originalLock;
  assert(root.startsWith(join(tmpdir(), 'pi-settings-retry-')));
  rmSync(root, { recursive: true, force: true });
}
