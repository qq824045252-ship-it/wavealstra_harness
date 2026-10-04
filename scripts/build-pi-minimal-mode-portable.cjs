/** Build one unique, non-installing Windows distribution; never overwrites installed MyBuddy. */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), os = require('node:os');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const stamp = new Date().toISOString().replace(/\D/g, ''), release = 'release-pi-minimal-mode-' + stamp;
const output = path.join(root, 'artifacts/pi-minimal-mode/build-' + stamp);
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const cleanReleaseRoot = path.join(localAppData, 'Programs', 'MyBuddy', 'portable', release);
const buildTempRoot = path.join(localAppData, 'Programs', 'MyBuddy', 'build-temp', stamp);
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(buildTempRoot, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', release, output, cleanReleaseRoot, steps: [], pid: process.pid };
const file = path.join(output, 'build.json');
const save = () => {
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'artifacts/pi-minimal-mode/build-latest.json'), JSON.stringify({
        report: file,
        output,
        release,
        cleanReleaseRoot,
        executable: report.executable,
        cleanExecutable: report.cleanExecutable,
    }, null, 2) + '\n');
};
function fingerprint() {
    const files = [];
    function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isSymbolicLink())
                continue;
            if (e.isDirectory())
                walk(f);
            else if (!f.includes(path.join('subagent', 'vendor')))
                files.push(f);
        }
    }
    for (const d of ['src', 'shared/src', 'app/remote/src', 'patches'])
        if (fs.existsSync(d))
            walk(d);
    for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'app/remote/package.json', 'shared/package.json', 'scripts/build-pi-codemode-assets.mjs', 'scripts/build-subagent-runtime.mjs', 'scripts/build-subagent-context.mjs'])
        if (fs.existsSync(f))
            files.push(f);
    files.sort();
    const h = crypto.createHash('sha256');
    for (const f of files)
        h.update(f).update(fs.readFileSync(f));
    return h.digest('hex');
}
async function run(name, command) {
    const row = { name, status: 'running', startedAt: new Date().toISOString() };
    report.steps.push(row);
    save();
    const fd = fs.openSync(path.join(output, name + '.log'), 'w'), env = { ...process.env };
    env.PATH = path.join(root, 'node_modules/.bin') + ';' + path.dirname(process.execPath) + ';' + (env.PATH || env.Path || '');
    env.TEMP = buildTempRoot;
    env.TMP = buildTempRoot;
    await new Promise((resolve, reject) => {
        const child = cp.spawn('C:/Program Files/Git/bin/bash.exe', ['--noprofile', '--norc', '-c', command], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
        row.pid = child.pid;
        save();
        let done = false;
        const timer = setTimeout(() => {
            row.timedOut = true;
            cp.spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }, 300000);
        function end(code, signal, error) {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            fs.closeSync(fd);
            Object.assign(row, { code, signal, error, finishedAt: new Date().toISOString(), status: code === 0 && !signal && !error && !row.timedOut ? 'passed' : 'failed' });
            save();
            console.log(row.status.toUpperCase() + ' ' + name);
            row.status === 'passed' ? resolve() : reject(Error(name + ' failed; see ' + path.join(output, name + '.log')));
        }
        child.once('error', e => end(null, null, e.message));
        child.once('close', (c, s) => end(c, s));
    });
}
function publishToCleanAcl(sourceDir) {
    const row = { name: 'clean-acl-publish', status: 'running', startedAt: new Date().toISOString() };
    report.steps.push(row);
    save();
    try {
        fs.rmSync(cleanReleaseRoot, { recursive: true, force: true });
        fs.mkdirSync(cleanReleaseRoot, { recursive: true });
        // Copy file contents into a directory outside the sandboxed repository so Windows
        // assigns normal destination ACLs instead of propagating the repository ACL.
        fs.cpSync(sourceDir, cleanReleaseRoot, { recursive: true, force: true, dereference: false });
        row.status = 'passed';
    }
    catch (error) {
        row.status = 'failed';
        row.error = error instanceof Error ? error.message : String(error);
        throw error;
    }
    finally {
        row.finishedAt = new Date().toISOString();
        save();
    }
}
async function smokePackagedApp(executable) {
    const row = { name: 'clean-portable-launch-smoke', status: 'running', startedAt: new Date().toISOString(), executable };
    report.steps.push(row);
    save();
    const logPath = path.join(output, 'clean-portable-launch-smoke.log');
    const fd = fs.openSync(logPath, 'w');
    const smokeUserData = path.join(os.tmpdir(), 'mybuddy-build-smoke-' + stamp);
    fs.rmSync(smokeUserData, { recursive: true, force: true });
    const env = {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_ENABLE_STACK_DUMPING: '1',
    };
    await new Promise((resolve, reject) => {
        let settled = false;
        const child = cp.spawn(executable, ['--enable-logging=stderr', '--user-data-dir=' + smokeUserData], {
            cwd: path.dirname(executable),
            env,
            stdio: ['ignore', fd, fd],
            windowsHide: true,
        });
        row.pid = child.pid;
        save();
        const finish = (ok, error) => {
            if (settled)
                return;
            settled = true;
            row.status = ok ? 'passed' : 'failed';
            row.error = error;
            row.finishedAt = new Date().toISOString();
            if (ok) {
                cp.spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            }
            fs.closeSync(fd);
            fs.rmSync(smokeUserData, { recursive: true, force: true });
            save();
            console.log(row.status.toUpperCase() + ' ' + row.name);
            ok ? resolve() : reject(Error(error + '; see ' + logPath));
        };
        child.once('error', error => finish(false, 'Packaged MyBuddy failed to launch: ' + error.message));
        child.once('exit', (code, signal) => finish(false, 'Packaged MyBuddy exited before smoke window (code=' + code + ', signal=' + signal + ')'));
        setTimeout(() => finish(true), 8000);
    });
}
(async () => {
    try {
        report.sourceFingerprint = fingerprint();
        save();
        await run('typecheck', 'pnpm run typecheck');
        await run('remote-typecheck', 'pnpm run remote:typecheck');
        await run('minimal-mode-contract', 'pnpm run test:minimal-coding-mode');
        await run('hidden-codemode-ui', 'pnpm run test:pi-codemode-ui');
        await run('mode-presets', 'pnpm run test:mode-preset');
        await run('codemode-auto-contract', 'pnpm run test:pi-codemode-auto');
        await run('codemode-native-integration', 'pnpm run test:pi-codemode-native');
        await run('host-boundary', 'pnpm run test:pi-host-boundary');
        await run('host-contract', 'pnpm run test:pi-host-control');
        await run('host-native', 'pnpm run test:pi-host-native');
        await run('native-control-contract', 'pnpm run test:pi-native-control');
        await run('native-lifecycle', 'pnpm run test:pi-native-lifecycle');
        await run('memory-races', 'pnpm run test:pi0992-memory-race');
        await run('memory-capsules', 'pnpm run test:pi0992-memory-capsule');
        await run('mcp-compat', 'pnpm run test:pi0992-mcp-config');
        await run('remote-build', 'pnpm run remote:build');
        await run('desktop-build', 'pnpm run build');
        if (fingerprint() !== report.sourceFingerprint)
            throw Error('Source changed during compilation; keep this result unverified and rebuild the latest working tree.');
        await run('portable-pack', 'pnpm exec electron-builder --dir --publish never --config.directories.output=' + release);
        const packedDir = path.join(root, release, 'win-unpacked');
        const exe = path.join(packedDir, 'MyBuddy.exe'), asar = path.join(packedDir, 'resources/app.asar');
        if (!fs.existsSync(exe) || !fs.existsSync(asar))
            throw Error('Packaged executable or app.asar is missing');
        report.executable = exe;
        report.asar = asar;
        report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
        publishToCleanAcl(packedDir);
        const cleanExe = path.join(cleanReleaseRoot, 'MyBuddy.exe');
        const cleanAsar = path.join(cleanReleaseRoot, 'resources/app.asar');
        if (!fs.existsSync(cleanExe) || !fs.existsSync(cleanAsar))
            throw Error('Clean-ACL portable executable or app.asar is missing');
        report.cleanExecutable = cleanExe;
        report.cleanAsar = cleanAsar;
        report.cleanExeSha256 = crypto.createHash('sha256').update(fs.readFileSync(cleanExe)).digest('hex');
        report.cleanAsarSha256 = crypto.createHash('sha256').update(fs.readFileSync(cleanAsar)).digest('hex');
        report.cleanMatchesPacked = report.cleanAsarSha256 === report.asarSha256;
        if (!report.cleanMatchesPacked)
            throw Error('Clean-ACL published app.asar differs from packaged source');
        await smokePackagedApp(cleanExe);
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
        console.log(JSON.stringify({ status: report.status, executable: report.executable, cleanExecutable: report.cleanExecutable, error: report.error, report: file }));
    }
})();
