/** Actual Electron renderer A/B. No product build, provider, private profile or virtualization. */
const {app,BrowserWindow,protocol}=require('electron'),{build}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const baseline=process.argv[2]||'277188267e72ba193e6484cc33c70fd5d479d2af';
const sourcePath='src/renderer/src/components/pages/BotWorkspacePage.tsx';
const sources={baseline:execFileSync('git',['show',baseline+':'+sourcePath],{encoding:'utf8'}),candidate:fs.readFileSync(sourcePath,'utf8')};
const out=path.resolve('out/diagnostics/history-render-final');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'history-render-'));app.setPath('userData',path.join(profile,'chromium'));
process.env.HOME=profile;process.env.USERPROFILE=profile;process.env.XDG_CONFIG_HOME=path.join(profile,'config');
const hash=text=>createHash('sha256').update(text).digest('hex');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let win;try{
  protocol.handle('mybuddy-artifact',()=>new Response('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml'}}));
  const reports={};
  for(const label of ['baseline','candidate']){
    const fixture=path.join(out,label+'.js');
    await build({entryPoints:['scripts/bot-conversation-concurrent-desktop-fixture.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',external:['@terrastruct/d2'],alias:{'@':path.resolve('src/renderer/src'),'@shared':path.resolve('src/shared')},loader:{'.woff':'file','.woff2':'file','.ttf':'file'},outfile:fixture,plugins:[{name:'fixture-and-counters',setup(b){
      b.onLoad({filter:/bot-conversation-concurrent-desktop-fixture\.tsx$/},a=>({contents:fs.readFileSync(a.path,'utf8').replace('createRoot(document.getElementById("root")!).render(<BotWorkspacePage />);',`import {Profiler} from 'react'; import {installHistoryRenderFixture,recordHistoryRender} from './perf-bot-history-render-fixture'; installHistoryRenderFixture(); createRoot(document.getElementById('root')!).render(<Profiler id="page" onRender={recordHistoryRender}><BotWorkspacePage/></Profiler>);`),loader:'tsx',resolveDir:path.dirname(a.path)}));
      b.onLoad({filter:/BotWorkspacePage\.tsx$/},a=>({contents:sources[label].replace('  const externalTask = useAppStore','  (window as any).messageRenderCount++;\n  const externalTask = useAppStore'),loader:'tsx',resolveDir:path.dirname(a.path)}));
    }}]});
    const html=path.join(profile,label+'.html');fs.writeFileSync(html,`<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(fixture.replace('.js','.css')).href}"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}#root,.bot-workspace{height:100vh}</style></head><body><div id="root"></div><script src="${pathToFileURL(fixture).href}"></script></body></html>`);
    win=new BrowserWindow({width:1050,height:820,show:true,webPreferences:{contextIsolation:true}});const errors=[];
    win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
    await win.loadFile(html);const ev=code=>win.webContents.executeJavaScript(code);await new Promise(resolve=>setTimeout(resolve,500));const rows=[],transcripts=[];
    for(const n of [100,500,1000]){
      rows.push(await ev(`window.historyPerf.seed(${n})`));const before=hash(await ev('window.historyPerf.transcript()'));transcripts.push({n,digest:before});
      for(let i=0;i<5;i++){
        const expected=await ev('window.historyPerf.beginTyping()');win.webContents.sendInputEvent({type:'char',keyCode:'x'});
        const row=await ev(`window.historyPerf.finishTyping(${JSON.stringify(expected)})`);rows.push(row);
        if(label==='candidate')assert.equal(row.messageRenders,0,'draft edits do not rerender history');
        assert.equal(hash(await ev('window.historyPerf.transcript()')),before,'typing preserves exact transcript DOM');
      }
      for(let i=0;i<5;i++)rows.push(await ev('window.historyPerf.stream()'));
      console.log(label,n,JSON.stringify(rows.slice(-11)));
    }
    await ev('window.historyPerf.rename()');await ev('window.historyPerf.subscriptionsAndLocalState()');assert.equal(errors.length,0,errors.join('\n'));
    fs.writeFileSync(path.join(out,label+'.png'),(await win.webContents.capturePage()).toPNG());
    reports[label]={rows,transcripts,errors};win.destroy();win=null;
  }
  assert.deepEqual(reports.candidate.transcripts,reports.baseline.transcripts,'baseline/candidate complete transcript DOM parity');
  fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify({baseline,sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,hash(v)])),contract:'Actual BotWorkspacePage/store/Markdown in Electron; synthetic loaded history, native char input, React development Profiler; controlled host polling disabled only in fixture. No IPC/database/provider or full-product startup timing.',...reports},null,2));
  console.log('PASS native typing, full transcript DOM parity, stream invalidation and rename');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
