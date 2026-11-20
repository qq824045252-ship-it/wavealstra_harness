const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-memory-header-')));
const root = path.resolve(__dirname, '..');
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,width:1200,height:800,useContentSize:true,webPreferences:{offscreen:true}});
 try {
  const source = fs.readFileSync(path.join(root,'src/renderer/src/components/settings/MemoryKernelExplorer.tsx'),'utf8');
  const title = source.indexOf('{selected.title}</div>');
  const start = source.lastIndexOf('<div ',source.lastIndexOf('<div ',title)-1);
  const end = source.indexOf('{selectedShared &&',title);
  assert(start>=0 && end>start);
  const markup = source.slice(start,end).trim();
  const compiled = esbuild.transformSync('module.exports = selected => ('+markup+');',{loader:'tsx',format:'cjs',jsxFactory:'React.createElement'}).code;
  const module = {exports:{}};
  new Function('module','React','busy','selectedShared','alreadyGlobal',compiled)(module,React,false,false,true);
  const html = renderToStaticMarkup(module.exports({id:'fixture',title:'修改 MyBuddy 模式预设 policy.json 的安全步骤',status:'active'}));
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><div class="memory-record-detail">'+html+'</div></body></html>'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/src/styles/global.css'),'utf8'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/src/components/settings/Memory.css'),'utf8'));
  const results=await win.webContents.executeJavaScript(`(() => {
    const panel=document.querySelector('.memory-record-detail'), header=panel.firstElementChild,title=header.firstElementChild;
    const output=[];
    for(const zoom of [1,1.25,1.5]) for(const width of [280,340,480,600]) {
      document.body.style.zoom=zoom; panel.style.width=width+'px';
      const p=panel.getBoundingClientRect(),t=title.getBoundingClientRect();
      const buttons=[...header.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
      output.push({zoom,width,titleWidth:t.width/zoom,headerWidth:header.getBoundingClientRect().width/zoom,titleHeight:t.height/zoom,overflow:panel.scrollWidth-panel.clientWidth,buttons,edge:{left:p.left,right:p.right},titleBottom:t.bottom});
    }
    return output;
  })()`);
  for(const r of results){
    assert(r.titleWidth>=r.headerWidth-1,'title must have a full readable row: '+JSON.stringify(r));
    assert(r.overflow<=1,'horizontal overflow: '+JSON.stringify(r));
    assert(r.buttons.length===3);
    for(const b of r.buttons){assert(b.left>=r.edge.left && b.right<=r.edge.right+1);assert(b.top>=r.titleBottom-1,'actions overlap title');}
  }
  await win.webContents.executeJavaScript("document.body.style.zoom='1';document.querySelector('.memory-record-detail').style.width='340px'");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshot = await win.webContents.capturePage({x:0,y:0,width:360,height:220},{stayHidden:true,stayAwake:true});
  fs.mkdirSync(path.join(root,'out/tests'),{recursive:true});
  fs.writeFileSync(path.join(root,'out/tests/memory-detail-header-geometry.png'),screenshot.toPNG());
  console.log('PASS Memory detail header actual production JSX/CSS geometry: '+results.map(r=>r.width+'@'+r.zoom+' title='+r.titleWidth.toFixed(1)).join(', '));
 } finally {win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
