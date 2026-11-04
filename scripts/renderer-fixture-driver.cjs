/**
 * Run the same renderer fixture assertions in Electron or, explicitly, Chromium
 * or LinkeDOM (--dom). DOM mode skips pixel/layout verification explicitly.
 *
 * The existing pnpm UI scripts keep using a real Electron BrowserWindow. A host
 * without a desktop can bundle that fixture and run its test with Node and
 * --chromium instead. Chromium results are labelled separately; they do not
 * validate Electron IPC, native dialogs, the desktop session, or a packaged app.
 * Playwright is needed only for the optional Chromium mode. Set
 * MYBUDDY_CHROMIUM_EXECUTABLE when using an already installed browser.
 */
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, basename, extname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeScreenshot } = require('./ui-capture.cjs');

function runRendererFixture({ name, width, height, timeoutMs = 60000 }, test) {
  const backend = process.argv.includes('--dom') ? 'dom' : process.argv.includes('--chromium') ? 'chromium' : 'electron';
  const output = join(__dirname, '../out/tests');
  const screenshots = [];
  const rendererErrors = [];
  const startedAt = new Date().toISOString();
  let fixture;
  let app;
  let close;
  let profile;
  let browserVersion;
  let failure;
  const watchdog = setTimeout(() => {
    console.error(`[${name}/${backend}] UI test exceeded ${timeoutMs}ms`);
    if (app) app.exit(1);
    else process.exit(1);
  }, timeoutMs);

  const screenshotPath = (file) => {
    const extension = extname(file);
    return join(dirname(file), `${basename(file, extension)}-${backend}${extension}`);
  };

  void (async () => {
    try {
      mkdirSync(output, { recursive: true });
      for (const extension of ['txt', 'html']) rmSync(join(output, `${name}-${backend}-failure.${extension}`), { force: true });
      rmSync(join(output, `${name}-failure-${backend}.png`), { force: true });
      if (backend === 'dom') {
        fixture = require('./renderer-fixture-dom.cjs').createDomFixture();
        browserVersion = 'LinkeDOM (DOM behaviour only; no browser or layout)';
      } else if (backend === 'chromium') {
        let chromium;
        try { ({ chromium } = require('playwright')); }
        catch (error) {
          throw new Error('Optional Chromium verification requires Playwright in this environment. The normal pnpm UI scripts use Electron and do not need it.', { cause: error });
        }
        const executablePath = process.env.MYBUDDY_CHROMIUM_EXECUTABLE;
        const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
        close = () => browser.close();
        browserVersion = browser.version();
        const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
        const page = await context.newPage();
        page.on('pageerror', (error) => rendererErrors.push(error.message));
        fixture = {
          backend,
          evaluate: (code) => page.evaluate(code),
          loadFile: (file) => page.goto(pathToFileURL(file).href),
          screenshot: async (file) => {
            const path = screenshotPath(file);
            await page.screenshot({ path, timeout: 5000 });
            screenshots.push(path);
            return true;
          },
        };
      } else {
        const electron = require('electron');
        app = electron.app;
        if (!app) throw new Error('Use the pnpm UI script for Electron, or node <test>.cjs --chromium for renderer-only verification.');
        profile = mkdtempSync(join(tmpdir(), `${name}-`));
        app.setPath('userData', profile);
        app.setPath('home', profile);
        await app.whenReady();
        browserVersion = `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`;
        const win = new electron.BrowserWindow({
          show: false, width, height,
          webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
        });
        close = async () => { if (!win.isDestroyed()) win.destroy(); };
        win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer exited: ${details.reason}`));
        fixture = {
          backend,
          evaluate: (code) => win.webContents.executeJavaScript(code),
          loadFile: (file) => win.loadFile(file),
          screenshot: async (file) => {
            const path = screenshotPath(file);
            const saved = await writeScreenshot(win, path, 5000);
            if (saved) screenshots.push(path);
            return saved;
          },
        };
      }

      console.log(`[${name}] ${backend} fixture: ${browserVersion}`);
      await test(fixture);
      if (rendererErrors.length) throw new Error(`Uncaught renderer errors: ${rendererErrors.join('; ')}`);
    } catch (error) {
      failure = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(failure);
      process.exitCode = 1;
      if (fixture) {
        try { await fixture.screenshot(join(output, `${name}-failure.png`)); } catch { /* Keep the original failure. */ }
        try {
          writeFileSync(join(output, `${name}-${backend}-failure.txt`), await fixture.evaluate('document.body.innerText'));
          writeFileSync(join(output, `${name}-${backend}-failure.html`), await fixture.evaluate('document.documentElement.outerHTML'));
        } catch { /* A crashed renderer may have no DOM left. */ }
      }
    } finally {
      clearTimeout(watchdog);
      writeFileSync(join(output, `${name}-${backend}-result.json`), JSON.stringify({
        name, backend, browserVersion, startedAt, finishedAt: new Date().toISOString(),
        status: failure ? 'failed' : 'passed', failure, rendererErrors, screenshots,
        scope: 'Renderer fixture with test IPC data; not packaged-app acceptance',
        unsupportedChecks: backend === 'dom' ? ['CSS layout and visibility', 'screenshots', 'native Electron'] : [],
      }, null, 2));
      if (close) await close();
      if (profile) {
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may retain a profile lock until Electron exits. */ }
      }
      if (app) app.exit(failure ? 1 : 0);
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (app) app.exit(1);
  });
}

module.exports = { runRendererFixture };
