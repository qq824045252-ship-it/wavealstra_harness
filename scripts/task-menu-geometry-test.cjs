// Hidden, disposable Electron geometry fixture. Never uses the live app profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const {app, BrowserWindow} = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-menu-geometry-')));
const root = path.resolve(__dirname, '..');
app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, width: 1344, height: 821, useContentSize: true});
  try {
    const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/sidebar/TaskItem.tsx'), 'utf8');
    const start = source.indexOf('  const syncMenuPos = (): void => {');
    const end = source.indexOf('\n  useLayoutEffect(', start);
    assert(start >= 0 && end > start);
    const callback = esbuild.transformSync(source.slice(start, end), {loader: 'ts'}).code;
    const placement = esbuild.transformSync(fs.readFileSync(path.join(root, 'src/renderer/src/lib/placeFixedMenu.ts'), 'utf8'), {loader: 'ts', format: 'cjs'}).code;
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body><div id="anchor" style="position:fixed;left:169px;top:703px;width:20px;height:20px"></div><div id="menu" class="task-context-menu task-context-menu-portal"><button class="task-context-item">打开文件夹</button><button class="task-context-item">重命名</button><button class="task-context-item">AI 重命名</button><div class="task-context-sep"></div><button class="task-context-item danger">删除任务</button></div></body></html>'));
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/renderer/src/styles/global.css'), 'utf8'));
    const results = await window.webContents.executeJavaScript(`(() => {
      const module = {exports:{}}; const exports = module.exports;
      { ${placement} }
      const {placeFixedMenu, layoutRect, layoutViewportSize} = module.exports;
      const menuAnchorRef = {current:document.getElementById('anchor')};
      const menuPortalRef = {current:document.getElementById('menu')};
      const MENU_MIN_WIDTH=200, MENU_MAX_HEIGHT=420;
      const setMenuPos = p => Object.assign(menuPortalRef.current.style, {top:p.top+'px',left:p.left+'px',maxHeight:p.maxHeight+'px'});
      ${callback}
      const results=[];
      for (const zoom of [1, 0.85, 1.25]) {
        document.body.style.zoom=String(zoom);
        for (const top of [80, 703]) {
          menuAnchorRef.current.style.top=(top/zoom)+'px';
          syncMenuPos(); syncMenuPos();
          const a=menuAnchorRef.current.getBoundingClientRect(), m=menuPortalRef.current.getBoundingClientRect();
          results.push({zoom,top,height:m.height,gap:top===80 ? m.top-a.bottom : a.top-m.bottom});
        }
      }
      return results;
    })()`);
    for (const r of results) assert(Math.abs(r.gap - 4*r.zoom) < 1, JSON.stringify(r));
    console.log('PASS hidden Electron actual CSS geometry: ' + JSON.stringify(results));
  } finally {window.destroy(); app.quit();}
}).catch(error => {console.error(error); app.exit(1);});
