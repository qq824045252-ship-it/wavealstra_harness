// Build: pnpm exec esbuild scripts/selection-comment-ui-test.tsx --bundle --platform=browser --format=iife --jsx=automatic --global-name=SelectionCommentTest --outfile=out/tests/selection-comment-ui.js --alias:@=./src/renderer/src --alias:@shared=./src/shared
// Run with ELECTRON_RUN_AS_NODE unset: pnpm exec electron scripts/selection-comment-ui-test.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mybuddy-selection-test-')));
const timeout = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 340, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  await win.webContents.insertCSS(readFileSync(join(__dirname, '../src/renderer/src/styles/global.css'), 'utf8'));
  const bundle = readFileSync(join(__dirname, '../out/tests/selection-comment-ui.js'), 'utf8');
  const outcome = await win.webContents.executeJavaScript(`try { ${bundle}\n JSON.stringify({results: SelectionCommentTest.run()}) } catch (error) { JSON.stringify({error: error.stack}) }`);
  const { results, error } = JSON.parse(outcome);
  if (error) throw new Error(error);
  for (const result of results) console.log('PASS', result);
  const screenshot = await win.webContents.capturePage();
  writeFileSync(join(__dirname, '../out/tests/selection-comment-ui.png'), screenshot.toPNG());
  win.destroy();
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
