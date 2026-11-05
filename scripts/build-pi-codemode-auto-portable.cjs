/** Build one unique, non-installing Windows distribution; never overwrites installed MyBuddy. */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const stamp = new Date().toISOString().replace(/\D/g, ''), release = 'release-pi-codemode-auto-' + stamp;
const output = path.join(root, 'artifacts/pi-codemode-auto/build-' + stamp);
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', release, output, steps: [], pid: process.pid };
const file = path.join(output, 'build.json');
const save = () => { fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); fs.writeFileSync(path.join(root, 'artifacts/pi-codemode-auto/build-latest.json'), JSON.stringify({ report: file, output, release }, null, 2) + '\n'); };
function fingerprint() { const files = []; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink())
        continue;
    if (e.isDirectory())
        walk(f);
    else if (!f.includes(path.join('subagent', 'vendor')))
        files.push(f);
} } for (const d of ['src', 'shared/src', 'app/remote/src', 'patches'])
    if (fs.existsSync(d))
        walk(d); for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'app/remote/package.json', 'shared/package.json', 'scripts/build-pi-codemode-assets.mjs', 'scripts/build-subagent-runtime.mjs'])
    if (fs.existsSync(f))
        files.push(f); files.sort(); const h = crypto.createHash('sha256'); for (const f of files)
    h.update(f).update(fs.readFileSync(f)); return h.digest('hex'); }
async function run(name, command) {
    const row = { name, status: 'running', startedAt: new Date().toISOString() };
    report.steps.push(row);
    save();
    const fd = fs.openSync(path.join(output, name + '.log'), 'w'), env = { ...process.env };
    env.PATH = path.join(root, 'node_modules/.bin') + ';' + path.dirname(process.execPath) + ';' + (env.PATH || env.Path || '');
    await new Promise((resolve, reject) => { const child = cp.spawn('C:/Program Files/Git/bin/bash.exe', ['--noprofile', '--norc', '-c', command], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true }); row.pid = child.pid; save(); let done = false; const timer = setTimeout(() => { row.timedOut = true; cp.spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }, 300000); function end(code, signal, error) { if (done)
        return; done = true; clearTimeout(timer); fs.closeSync(fd); Object.assign(row, { code, signal, error, finishedAt: new Date().toISOString(), status: code === 0 && !signal && !error && !row.timedOut ? 'passed' : 'failed' }); save(); console.log(row.status.toUpperCase() + ' ' + name); row.status === 'passed' ? resolve() : reject(Error(name + ' failed; see ' + path.join(output, name + '.log'))); } child.once('error', e => end(null, null, e.message)); child.once('close', (c, s) => end(c, s)); });
}
(async () => {
    try {
        report.sourceFingerprint = fingerprint();
        save();
        await run('typecheck', 'pnpm run typecheck');
        await run('remote-typecheck', 'pnpm run remote:typecheck');
        await run('codemode-auto-contract', 'pnpm run test:pi-codemode-auto');
        await run('codemode-native-integration', 'pnpm run test:pi-codemode-native');
        await run('host-boundary', 'pnpm run test:pi-host-boundary');
        await run('host-contract', 'pnpm run test:pi-host-control');
        await run('host-native', 'pnpm run test:pi-host-native');
        await run('native-control-contract', 'pnpm run test:pi-native-control');
        await run('native-lifecycle', 'pnpm run test:pi-native-lifecycle');
        await run('remote-build', 'pnpm run remote:build');
        await run('desktop-build', 'pnpm run build');
        if (fingerprint() !== report.sourceFingerprint)
            throw Error('Source changed during compilation; keep this result unverified and rebuild the latest working tree.');
        await run('portable-pack', 'pnpm exec electron-builder --dir --publish never --config.directories.output=' + release);
        const exe = path.join(root, release, 'win-unpacked/MyBuddy.exe'), asar = path.join(root, release, 'win-unpacked/resources/app.asar');
        if (!fs.existsSync(exe) || !fs.existsSync(asar))
            throw Error('Packaged executable or app.asar is missing');
        report.executable = exe;
        report.asar = asar;
        report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
        report.sourceUnchanged = fingerprint() === report.sourceFingerprint;
        if (!report.sourceUnchanged)
            throw Error('Source changed during packaging; validate this exact binary separately before claiming current-source coverage.');
        report.status = 'passed';
    }
    catch (e) {
        report.status = 'failed';
        report.error = e.message;
        process.exitCode = 1;
    }
    finally {
        report.finishedAt = new Date().toISOString();
        save();
        console.log(JSON.stringify({ status: report.status, executable: report.executable, error: report.error, report: file }));
    }
})();
