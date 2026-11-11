/** Real Electron renderer -> IPC -> synchronous main-thread SQLite, synthetic data only.
 * First run: node scripts/perf-work-list-search.mjs. Then:
 * env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs baseline
 * env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs candidate
 */
const {app,BrowserWindow,ipcMain}=require('electron');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const label=process.argv[2]||'candidate';assert(['baseline','candidate'].includes(label));
const out=path.resolve('out/diagnostics/work-search');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'work-search-ui-'));
app.setPath('userData',path.join(profile,'chromium'));
process.env.HOME=profile;process.env.USERPROFILE=profile;process.env.XDG_CONFIG_HOME=path.join(profile,'config');
const {fixture}=require(path.join(out,`${label}.cjs`));
let win,f;
app.whenReady().then(async()=>{try{
  f=fixture(path.join(profile,'fixture.db'));
  const reportRepeats=Number(process.env.WORK_SEARCH_REPORT_REPEATS||1000);
  assert(Number.isInteger(reportRepeats)&&reportRepeats>=1&&reportRepeats<=30000);
  if(reportRepeats!==1000)f.db.prepare('UPDATE work_deliverables SET summary=?').run('Long report content. '.repeat(reportRepeats)+'DeepReportTail');
  const calls=[];
  ipcMain.handle('work-search-query',(_event,request)=>{
    const start=performance.now();
    // Deliberately bypass page-result caching to measure first-query cost consistently.
    const result=f.db.transaction(()=>f.read(request))();
    calls.push({request,queryMs:performance.now()-start,filtered:result.filtered,page:result.page});return result;
  });
  const js=path.join(out,'ui-fixture.js');
  buildSync({stdin:{contents:`import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {BotWorkBrowser} from './src/renderer/src/components/pages/BotWorkBrowser';
    import {BotWorkNavigation} from './src/renderer/src/components/pages/BotWorkNavigation';
    import './src/renderer/src/components/pages/BotWorkspacePage.css';
    window.api={botWork:{queryWorks:request=>window.searchFixture.query(request)}};
    window.searchUiMetrics={frames:0,maxFrameGapMs:0,last:0};
    function frame(now){const m=window.searchUiMetrics;if(m.last)m.maxFrameGapMs=Math.max(m.maxFrameGapMs,now-m.last);m.last=now;m.frames++;requestAnimationFrame(frame)}requestAnimationFrame(frame);
    function Fixture(){const[view,setView]=useState('active');return <div className="bot-workspace"><BotWorkNavigation scope={{kind:'all'}} view={view} onChange={setView}/><BotWorkBrowser key={view} scope={{kind:'all'}} view={view} onOpenWork={()=>{}} onConversation={()=>{}}/></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:process.cwd(),loader:'tsx'},
    bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':path.resolve('src/renderer/src'),'@shared':path.resolve('src/shared')},outfile:js});
  fs.writeFileSync(path.join(profile,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('searchFixture',{query:request=>ipcRenderer.invoke('work-search-query',request)});`);
  fs.writeFileSync(path.join(profile,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(js.replace('.js','.css')).href}"><style>body{margin:0;font:14px system-ui;background:#fafafa;color:#222}*{box-sizing:border-box}:root{--surface-right:#fff;--fg:#222;--fg-secondary:#555;--border-default:#ddd;--border-subtle:#eee;--border-color:#ddd;--text-secondary:#555;--text-primary:#222;--bg-hover:#eee}#root{height:100vh;padding:16px}.bot-workspace{display:flex;flex-direction:column;height:100%}</style></head><body><div id="root"></div><script src="${pathToFileURL(js).href}"></script></body></html>`);
  win=new BrowserWindow({width:1040,height:820,show:true,webPreferences:{preload:path.join(profile,'preload.cjs'),contextIsolation:true}});
  const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});
  await win.loadFile(path.join(profile,'index.html'));
  const ev=text=>win.webContents.executeJavaScript(text);
  const until=async expr=>{const end=Date.now()+15000;while(!await ev(expr)){if(Date.now()>end)throw Error('timeout '+expr);await new Promise(r=>setTimeout(r,20));}};
  const ready=`!document.querySelector('.bot-work-list-summary')?.textContent.includes('正在读取')`;
  const search=text=>ev(`(()=>{const i=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click=text=>ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  await until(`document.querySelectorAll('.bot-work-card').length===24 && ${ready}`);
  assert(await ev(`document.querySelector('.bot-work-list-summary').textContent.includes('共 30000 件')`));
  const samples=[];
  for(const [term,count] of [['Synthetic',30000],['Synthetic 49999',1],['Synthetic DeepReportTail',250],['NoSuchTerm_测试',0]]){
    await ev('window.searchUiMetrics={frames:0,maxFrameGapMs:0,last:0}');const index=calls.length,start=performance.now();
    await search(term);
    await until(`document.querySelector('.bot-work-list-summary')?.textContent.includes('匹配 ${count} 件') && ${ready}`);
    samples.push({term,filtered:count,inputToResultsMs:performance.now()-start,renderer:await ev('window.searchUiMetrics'),ipcCalls:calls.slice(index)});
  }
  await click('查看全部事项');await until(`document.querySelectorAll('.bot-work-card').length===24 && ${ready}`);
  await ev(`[...document.querySelectorAll('.bot-work-filters button')].find(b=>b.firstElementChild.textContent==='已暂停').click()`);
  await until(`document.querySelector('.bot-work-list-summary').textContent.includes('匹配 10000 件') && ${ready}`);
  await click('下一页');await until(`document.querySelector('.bot-work-pagination')?.textContent.includes('第 2 / 417 页') && ${ready}`);
  assert(await ev(`[...document.querySelectorAll('.bot-status-badge')].every(x=>x.textContent==='已暂停')`));
  await click('重置筛选');await until(`document.querySelectorAll('.bot-work-card').length===24 && ${ready}`);
  await ev(`(()=>{const edit=value=>{const i=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,value);i.dispatchEvent(new Event('input',{bubbles:true}));};edit('NoSuchTerm_测试');setTimeout(()=>edit('Synthetic 49999'),280);})()`);
  await until(`document.querySelectorAll('.bot-work-card').length===1 && document.querySelector('.bot-work-card').dataset.workId==='work-49999' && ${ready}`);
  await new Promise(r=>setTimeout(r,500));assert.equal(await ev(`document.querySelector('.bot-work-card').dataset.workId`),'work-49999');
  assert(calls.every(call=>(call.request.pageSize??24)<=24),'bounded renderer page requests');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(out,`ui-${label}.png`),(await win.webContents.capturePage()).toPNG());
  const report={label,rows:50000,activeRows:30000,reportRepeats,contract:'Actual BotWorkBrowser + useWorkQueryPage + IPC + synchronous main SQLite; isolated synthetic fixture; 250ms production debounce; forced cold queries; not full product pnpm dev',samples,
    checks:['24-card initial page','status counts and page2','deep report search','no match and clear','rapid replacement keeps latest query','no renderer console errors'],calls};
  fs.writeFileSync(path.join(out,`ui-${label}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error);process.exitCode=1;}finally{if(win&&!win.isDestroyed())win.destroy();f?.app.close();app.exit(process.exitCode||0);}});
