const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'mybuddy-memory-toolbar-')));
const root=path.resolve(__dirname,'..');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:800,useContentSize:true,webPreferences:{offscreen:true}});
 try{
  const source=fs.readFileSync(path.join(root,'src/renderer/src/components/settings/MemoryOrganizationPanel.tsx'),'utf8');
  const code=esbuild.transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
  const module={exports:{}};new Function('require','module','exports',code)(require,module,module.exports);
  global.window={api:{memory:{startOrganization(){throw Error('Never call real data');}}}};
  const heading=React.createElement('div',null,React.createElement('div',{className:'settings-section-title'},'记忆内容与来源'),React.createElement('div',{className:'settings-section-desc'},'默认查看有效记忆。原始对话、证据和历史版本保留，可随时追溯。'));
  const markup=renderToStaticMarkup(React.createElement(module.exports.default,{activeCount:182,heading,scopeName:()=>'',onOpen(){},onChanged:async()=>{}}));
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><div class="memory-tab">'+markup+'</div></body></html>'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/src/styles/global.css'),'utf8'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/src/components/settings/Memory.css'),'utf8'));
  const results=await win.webContents.executeJavaScript(`(()=>{
    const panel=document.querySelector('.memory-tab'),heading=document.querySelector('.memory-organization-heading'),copy=document.querySelector('.memory-organization-heading-copy'),button=heading.querySelector('button');const results=[];
    for(const zoom of [1,1.25,1.5])for(const width of [280,340,480,720,1000]){
      document.body.style.zoom=zoom;panel.style.width=width+'px';
      const p=panel.getBoundingClientRect(),h=heading.getBoundingClientRect(),c=copy.getBoundingClientRect(),b=button.getBoundingClientRect();
      results.push({width,zoom,overflow:panel.scrollWidth-panel.clientWidth,button:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},copy:{right:c.right,top:c.top,bottom:c.bottom},edge:{left:p.left,right:p.right},count:heading.querySelectorAll('button').length,height:h.height/zoom});
    }return results;
  })()`);
  for(const r of results){assert.equal(r.count,1);assert(r.overflow<=1,JSON.stringify(r));assert(r.button.left>=r.edge.left&&r.button.right<=r.edge.right+1,JSON.stringify(r));assert(r.button.left>=r.copy.right-1||r.button.top>=r.copy.bottom-1,JSON.stringify(r));if(r.width>=720)assert(r.button.left>=r.copy.right-1,'wide toolbar should stay beside title');}
  await win.webContents.executeJavaScript("document.body.style.zoom='1';document.querySelector('.memory-tab').style.width='720px';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(root,'out/tests/memory-organization-compact.png'),(await win.webContents.capturePage({x:0,y:0,width:740,height:130},{stayHidden:true,stayAwake:true})).toPNG());
  console.log('PASS compact memory toolbar production component/CSS: '+results.map(r=>r.width+'@'+r.zoom).join(', '));
 }finally{win.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1);});
