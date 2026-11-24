import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { projectVerificationWorkspace } from "../agent/pstack/PstackWorkspace";
import { whereFirst } from "../platform/apps";
import { directorySymlinkType, resolvedPathKey } from "../platform/paths";

const exec = promisify(execFile);
const launchTimeoutMs = 180_000;
const captureTimeoutMs = 20_000;
const screenshotLimit = 16 * 1024 * 1024;
const launchStages = [
  { marker: /$^/, label: "启动开发进程" },
  { marker: /electron preload scripts built successfully/u, label: "准备桌面开发代码" },
  { marker: /dev server running for the electron renderer process/u, label: "启动渲染服务" },
  { marker: /MYBUDDY_DOTS_PREVIEW:bootstrap/u, label: "启动隔离 Electron" },
  { marker: /MYBUDDY_DOTS_PREVIEW:electron-ready/u, label: "初始化 Electron" },
  { marker: /MYBUDDY_DOTS_PREVIEW:window-created/u, label: "创建预览窗口" },
  { marker: /MYBUDDY_DOTS_PREVIEW:page-ready/u, label: "加载预览页面" },
  { marker: /MYBUDDY_DOTS_PREVIEW:dots-ready/u, label: "进入 Dots 页面" },
];
const launchFailures = [
  { marker: /MyBuddy 数据目录已由另一宿主/u, label: "预览数据目录未取得独立租约" },
  { marker: /MyBuddy preview home is not isolated/u, label: "预览主目录的隔离检查失败" },
  { marker: /NODE_MODULE_VERSION|Module did not self-register/u, label: "工作树中的 Electron 原生依赖版本不匹配" },
  { marker: /Failed to write to output file:[^\r\n]*(?:Access is denied|EACCES|EPERM)/u, label: "开发工具无法写入本次预览的临时输出" },
  { marker: /EADDRINUSE/u, label: "渲染服务端口被占用" },
  { marker: /MYBUDDY_DOTS_PREVIEW:renderer-gone|GPU process isn't usable/u, label: "预览的 Chromium 渲染进程退出" },
  { marker: /MYBUDDY_DOTS_PREVIEW:load-failed/u, label: "预览窗口无法加载本地页面" },
  { marker: /ERR_MODULE_NOT_FOUND|Cannot find module/u, label: "工作树中的开发依赖缺失或失效" },
];

interface PreviewRequest {
  workspaceRoot: string;
  worktree?: string;
  beforeLaunch?: () => Promise<void>;
}

export interface DotsDesktopPreviewReceipt {
  id: string;
  title: string;
  checkout: string;
  branch: string | null;
  commit: string;
  dirty: boolean;
  workspaceFingerprint: string;
  capturedAt: number;
  screenshot: Buffer;
}

type Checkout = { root: string; branch: string | null };
type Version = { commit: string; dirty: boolean; fingerprint: string };
type Capture = Pick<DotsDesktopPreviewReceipt, "title" | "capturedAt" | "screenshot">;
type Session = {
  directory: string;
  checkout: string;
  version: Version;
  child: ChildProcess;
  exit: Promise<void>;
  startup: { stage: number; failure?: string; spawnFailed?: boolean };
};

async function git(directory: string, args: string[], signal?: AbortSignal) {
  const { stdout } = await exec("git", ["--no-optional-locks", "-C", directory, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 12_000, maxBuffer: 1024 * 1024, signal,
  });
  return stdout;
}

async function registeredCheckout(request: PreviewRequest, signal?: AbortSignal): Promise<Checkout> {
  const workspace = await realpath(request.workspaceRoot);
  const root = await realpath((await git(workspace, ["rev-parse", "--show-toplevel"], signal)).trim());
  if (resolvedPathKey(root) !== resolvedPathKey(workspace)) throw new Error("请指定绑定到 MyBuddy 仓库根目录的空间。");
  const rows = (await git(root, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0\0");
  const checkouts = rows.flatMap(row => {
    const fields = row.split("\0");
    const path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (!path || fields.some(field => field === "bare" || field.startsWith("prunable"))) return [];
    return [{ root: path, branch: fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18) ?? null }];
  });
  const selector = request.worktree?.trim();
  const selectedPath = selector && isAbsolute(selector) ? selector : undefined;
  const candidates = checkouts.filter(checkout => {
    if (selectedPath || !selector) return resolvedPathKey(checkout.root) === resolvedPathKey(selectedPath ?? root);
    return selector === checkout.branch || selector === basename(checkout.root) ||
      Boolean(checkout.branch && selector === `refs/heads/${checkout.branch}`);
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? "有多个工作树符合，请指定分支或完整路径。" : "在已授权仓库中找不到这个 Git 工作树。");
  const checkout = candidates[0];
  const canonical = await realpath(checkout.root);
  const commonDirectory = async (path: string) => resolvedPathKey(await realpath((await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim()));
  if (resolvedPathKey(canonical) !== resolvedPathKey(checkout.root) || await commonDirectory(canonical) !== await commonDirectory(root)) {
    throw new Error("目标已不属于这个 Git 仓库。");
  }
  const manifest: { name?: unknown; main?: unknown } = JSON.parse(await readFile(join(canonical, "package.json"), "utf8"));
  if (manifest.name !== "wavealstra_harness" || manifest.main !== "./out/main/index.js") {
    throw new Error("指定工作树不包含 MyBuddy 桌面项目。");
  }
  return { ...checkout, root: canonical };
}

async function checkoutVersion(checkout: Checkout, signal?: AbortSignal): Promise<Version> {
  const snapshot = await projectVerificationWorkspace(checkout.root, signal);
  const branch = (await git(checkout.root, ["rev-parse", "--symbolic-full-name", "HEAD"], signal)).trim();
  if (!snapshot.coverageComplete || resolvedPathKey(snapshot.root) !== resolvedPathKey(checkout.root) ||
      branch !== (checkout.branch ? `refs/heads/${checkout.branch}` : "HEAD")) {
    throw new Error("工作树输入发生变化或无法完整核对，暂无法确认预览版本。");
  }
  return { commit: snapshot.head, dirty: !snapshot.clean, fingerprint: snapshot.fingerprint };
}

function previewEnvironment(home: string): NodeJS.ProcessEnv {
  const desktopEnvironment = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|display|wayland_display|xdg_runtime_dir|xdg_session_type|dbus_session_bus_address|xauthority|lang|language|lc_[a-z_]+|tz|ssl_cert_file|ssl_cert_dir)$/i;
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => desktopEnvironment.test(key))),
    HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".mybuddy"),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    TMP: home, TEMP: home, TMPDIR: home,
  };
}

function previewBootstrap(checkout: string, directory: string): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { app, BrowserWindow } = require('electron');
const root = ${JSON.stringify(checkout)};
const directory = ${JSON.stringify(directory)};
const report = stage => process.stdout.write('MYBUDDY_DOTS_PREVIEW:' + stage + '\\n');
report('bootstrap');
if (homedir() !== directory) throw new Error('MyBuddy preview home is not isolated');
app.setAppPath(root);
app.setPath('userData', path.join(directory, 'user-data'));
app.once('ready', () => report('electron-ready'));
app.on('browser-window-created', (_event, window) => {
  report('window-created');
  window.webContents.once('dom-ready', () => report('page-ready'));
  window.webContents.on('render-process-gone', () => report('renderer-gone'));
  window.webContents.on('did-fail-load', (_load, code, _text, _url, mainFrame) => {
    if (mainFrame && code !== -3) report('load-failed');
  });
});
const parent = process.ppid;
const renderer = process.env.ELECTRON_RENDERER_URL;
let capturing = false;
let lastRequest;
let clickedRequest;
let dotsReported = false;
const file = name => path.join(directory, name);
const seekDots = "(() => { const row = document.querySelector('.sidebar-dots-entry button'); if (!row) return 'waiting'; if (row.getAttribute('aria-current') === 'true') return 'active'; row.click(); return 'clicked'; })()";
const isDots = "document.querySelector('.sidebar-dots-entry button')?.getAttribute('aria-current') === 'true'";
setInterval(async () => {
  try { process.kill(parent, 0); } catch { app.quit(); return; }
  if (fs.existsSync(file('close'))) { app.quit(); return; }
  if (capturing || !renderer || !fs.existsSync(file('request'))) return;
  const request = fs.readFileSync(file('request'), 'utf8');
  if (request === lastRequest || !/^[a-f0-9-]{36}$/.test(request)) return;
  const windows = BrowserWindow.getAllWindows().filter(window => window.isVisible() &&
    window.webContents.getURL().startsWith(renderer + '/'));
  if (windows.length !== 1) return;
  const window = windows[0];
  capturing = true;
  try {
    const ready = clickedRequest === request ? await window.webContents.executeJavaScript(isDots) : await window.webContents.executeJavaScript(seekDots);
    if (ready === 'clicked') clickedRequest = request;
    if (ready !== true && ready !== 'active') return;
    if (!dotsReported) { dotsReported = true; report('dots-ready'); }
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const screenshot = await window.webContents.capturePage();
    if (screenshot.isEmpty()) return;
    fs.writeFileSync(file('screenshot.png'), screenshot.toPNG());
    const receipt = { request, title: window.getTitle(), capturedAt: Date.now() };
    fs.writeFileSync(file('receipt-tmp'), JSON.stringify(receipt));
    fs.renameSync(file('receipt-tmp'), file(request));
    lastRequest = request;
  } catch { /* A loading or closed window supplies no evidence. */ }
  finally { capturing = false; }
}, 150).unref();
require(path.join(directory, 'dev-output', 'main', 'index.js'));
`;
}

async function eraseSession(directory: string): Promise<void> {
  const canonical = await realpath(directory);
  if (canonical !== directory || dirname(canonical) !== await realpath(tmpdir()) || !basename(canonical).startsWith("mybuddy-dots-preview-")) {
    throw new Error("预览目录与创建时不一致。");
  }
  await unlink(join(directory, "node_modules")).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 125 });
}

function trackStartupOutput(session: Session): void {
  for (const stream of [session.child.stdout, session.child.stderr]) {
    let tail = "";
    stream?.setEncoding("utf8").on("data", (chunk: string) => {
      const fragment = (tail + chunk).replace(/\x1b\[[0-9;]*m/gu, "");
      tail = fragment.slice(-512);
      for (let index = launchStages.length - 1; index > session.startup.stage; index--) {
        if (!launchStages[index].marker.test(fragment)) continue;
        session.startup.stage = index;
        break;
      }
      // Startup tools can print checkout data or environment details. Keep only predefined diagnoses.
      const failure = launchFailures.find(candidate => candidate.marker.test(fragment));
      if (failure) session.startup.failure = failure.label;
    });
  }
}

async function startPreview(checkout: Checkout, version: Version, request: PreviewRequest, signal?: AbortSignal): Promise<Session> {
  const cli = join(checkout.root, "node_modules", "electron-vite", "bin", "electron-vite.js");
  if (!(await stat(cli).catch(() => undefined))?.isFile()) throw new Error("该工作树没有现成的 MyBuddy 开发依赖。");
  const node = whereFirst("node");
  if (!node) throw new Error("系统路径中没有可用于开发预览的 Node.js。");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "mybuddy-dots-preview-"));
  try {
    const agent = join(directory, ".mybuddy");
    const bootstrap = join(directory, "bootstrap.cjs");
    const config = join(directory, "preview-vite.mjs");
    await mkdir(agent);
    await Promise.all([
      symlink(join(checkout.root, "node_modules"), join(directory, "node_modules"), directorySymlinkType()),
      writeFile(join(agent, "settings.json"), JSON.stringify({ closeToTray: false, memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false })),
      writeFile(bootstrap, previewBootstrap(checkout.root, directory)),
      writeFile(config, [
        `import config from ${JSON.stringify(relative(directory, join(checkout.root, "electron.vite.config.ts")).split(sep).join("/"))}`,
        'import { writeFileSync } from "node:fs"',
        `config.renderer.cacheDir = ${JSON.stringify(join(directory, "vite-cache"))}`,
        'const optimizeDeps = config.renderer.optimizeDeps ?? {}',
        'const esbuildOptions = optimizeDeps.esbuildOptions ?? {}',
        'const cacheWriter = { name: "write-preview-cache", setup(build) {',
        '  build.onEnd(result => {',
        '    for (const file of result.outputFiles ?? []) {',
        '      if (file.path !== "<stdout>") writeFileSync(file.path, file.contents)',
        '    }',
        '  })',
        '} }',
        'config.renderer.optimizeDeps = { ...optimizeDeps, esbuildOptions: { ...esbuildOptions, write: false, plugins: [...(esbuildOptions.plugins ?? []), cacheWriter] } }',
        'config.renderer.server = { ...config.renderer.server, host: "127.0.0.1", strictPort: false, hmr: false, watch: null }',
        "export default config",
      ].join("\n")),
    ]);
    await request.beforeLaunch?.();
    signal?.throwIfAborted();
    const child = spawn(node, [cli, "dev", "--outDir", join(directory, "dev-output"), "--entry", bootstrap, "--config", config], {
      cwd: checkout.root, env: previewEnvironment(directory), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
    const session: Session = { directory, checkout: checkout.root, version, child, exit, startup: { stage: 0 } };
    child.once("error", error => {
      session.startup.spawnFailed = true;
      session.startup.failure = (error as NodeJS.ErrnoException).code === "EACCES" ? "无法执行系统 Node.js" : "无法启动系统 Node.js";
    });
    trackStartupOutput(session);
    return session;
  } catch (error) {
    await eraseSession(directory).catch(() => {});
    throw error;
  }
}

function exited(session: Session): boolean {
  return session.startup.spawnFailed === true || session.child.exitCode !== null || session.child.signalCode !== null;
}

async function previewFailure(session: Session, message: string): Promise<Error> {
  if (exited(session)) await Promise.race([session.exit, delay(300, undefined, { ref: false })]);
  const checkoutPresent = await stat(session.checkout).then(info => info.isDirectory(), () => false);
  const stage = launchStages[session.startup.stage].label;
  const exit = session.child.signalCode ?? session.child.exitCode;
  const status = exit == null ? "" : `，退出状态 ${exit}`;
  const reason = checkoutPresent ? session.startup.failure : "启动后工作树目录已不可用";
  return new Error(`${message}已进行到${stage}${status}。${reason ? reason + "。" : ""}`);
}

async function stopPreview(session: Session): Promise<void> {
  if (!exited(session)) {
    await writeFile(join(session.directory, "close"), "").catch(() => {});
    await Promise.race([session.exit, delay(3_000, undefined, { ref: false })]);
    if (!exited(session)) session.child.kill("SIGTERM");
  }
  const stopped = await Promise.race([session.exit.then(() => true), delay(2_000, false, { ref: false })]);
  if (!stopped) { session.child.unref(); return; }
  await eraseSession(session.directory).catch(() => {});
}

async function capturePreview(session: Session, starting: boolean, signal?: AbortSignal): Promise<Capture> {
  signal?.throwIfAborted();
  const request = randomUUID();
  const receiptPath = join(session.directory, request);
  const requestFile = join(session.directory, "request");
  const temporary = join(session.directory, "request-tmp");
  await writeFile(temporary, request);
  await rename(temporary, requestFile);
  const deadline = Date.now() + (starting ? launchTimeoutMs : captureTimeoutMs);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (exited(session)) throw await previewFailure(session, "MyBuddy 预览进程已退出，没有取得窗口截图。");
    const receipt = await readFile(receiptPath, "utf8").catch(error => {
      if (error.code === "ENOENT" || error.code === "EBUSY") return undefined;
      throw error;
    });
    if (receipt) {
      const result: { request: string; title: string; capturedAt: number } = JSON.parse(receipt);
      const screenshotPath = join(session.directory, "screenshot.png");
      const info = await stat(screenshotPath);
      if (result.request !== request || info.size > screenshotLimit || info.size <= 8) throw new Error("无法确认 Dots 预览截图的来源。");
      const screenshot = await readFile(screenshotPath, { signal });
      if (!screenshot.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("预览窗口未返回有效的 PNG 截图。");
      await unlink(receiptPath);
      return { title: result.title, capturedAt: result.capturedAt, screenshot };
    }
    await delay(150, undefined, { signal });
  }
  throw await previewFailure(session, "未等到 MyBuddy 的 Dots 页面准备好，当前没有可核对的窗口截图。");
}

export class DotsDesktopPreview {
  private readonly sessions = new Map<string, Session>();
  private readonly running = new Map<string, Promise<DotsDesktopPreviewReceipt>>();
  private readonly shutdown = new AbortController();

  async open(request: PreviewRequest, signal?: AbortSignal): Promise<DotsDesktopPreviewReceipt> {
    const operation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    const checkout = await registeredCheckout(request, operation);
    const key = resolvedPathKey(checkout.root);
    operation.throwIfAborted();
    const existing = this.running.get(key);
    if (existing) {
      const receipt = await existing;
      operation.throwIfAborted();
      return receipt;
    }
    const pending = this.openCheckout(key, checkout, request, operation);
    this.running.set(key, pending);
    try { return await pending; }
    finally { this.running.delete(key); }
  }

  private async openCheckout(key: string, checkout: Checkout, request: PreviewRequest, signal: AbortSignal): Promise<DotsDesktopPreviewReceipt> {
    const version = await checkoutVersion(checkout, signal);
    let session = this.sessions.get(key);
    if (session && (exited(session) || session.version.fingerprint !== version.fingerprint)) {
      await stopPreview(session);
      this.sessions.delete(key);
      session = undefined;
    }
    const starting = !session;
    session ??= await startPreview(checkout, version, request, signal);
    this.sessions.set(key, session);
    try {
      const capture = await capturePreview(session, starting, signal);
      const after = await checkoutVersion(checkout, signal);
      if (after.fingerprint !== version.fingerprint) throw new Error("取图期间工作树发生变化，请重新打开预览核对。");
      return { id: basename(session.directory), checkout: checkout.root, branch: checkout.branch, commit: version.commit,
        dirty: version.dirty, workspaceFingerprint: version.fingerprint, ...capture };
    } catch (error) {
      if (starting || exited(session)) {
        this.sessions.delete(key);
        await stopPreview(session);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled(this.running.values());
    await Promise.allSettled([...this.sessions.values()].map(stopPreview));
    this.sessions.clear();
  }
}
