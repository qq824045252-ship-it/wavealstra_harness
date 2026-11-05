import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--worker') {
  const [agentDir, cwd] = process.argv.slice(3);
  process.send({ ready: true });
  process.once('message', async () => {
    const errors = new Map();
    const samples = [];
    let reads = 0;
    const collect = (settings) => {
      for (const { error } of settings.drainErrors()) {
        const code = error.code ?? error.name;
        errors.set(code, (errors.get(code) ?? 0) + 1);
        if (samples.length < 3) samples.push({ code, message: error.message, stack: error.stack });
      }
    };
    const settings = SettingsManager.create(cwd, agentDir);
    collect(settings);
    const until = Date.now() + 4000;
    while (Date.now() < until) { await settings.reload(); collect(settings); reads++; }
    process.send({ reads, errors: Object.fromEntries(errors), samples });
    process.disconnect();
  });
} else {
  const root = mkdtempSync(join(tmpdir(), 'pi-settings-lock-probe-'));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ enabledModels: ['fixture/a'] }));
  try {
    for (const count of [1, 2]) {
      const children = Array.from({ length: count }, (_, i) => {
        const cwd = join(root, `worktree-${i}`); mkdirSync(cwd, { recursive: true });
        return spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', agentDir, cwd], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      });
      const results = children.map(child => new Promise((resolve, reject) => {
        let result;
        child.on('message', message => { if (!message.ready) result = message; });
        child.on('error', reject);
        child.on('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`probe exited ${code}`)));
      }));
      await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))));
      children.forEach(child => child.send({ go: true }));
      console.log(JSON.stringify({ readers: count, results: await Promise.all(results) }));
    }
  } finally {
    if (!root.startsWith(join(tmpdir(), 'pi-settings-lock-probe-'))) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
}
