const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os');
const {createTwoFilesPatch}=require('diff');const root=path.resolve(__dirname,'..');process.chdir(root);
const upstream=path.join(root,'artifacts/pi0992-memory/upstream/pi-coding-agent/package'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi0992-host-rebase-'));
const files=['dist/config.d.ts','dist/config.js','dist/extensions/mcp/index.d.ts','dist/extensions/mcp/index.js','dist/index.d.ts','dist/index.js'];
try{
 fs.cpSync(upstream,tmp,{recursive:true});
 const old=path.join(root,'patches/@earendil-works__pi-coding-agent@0.99.1.patch');
 const result=cp.spawnSync('git',['apply','--include=dist/extensions/mcp/*',old],{cwd:tmp,encoding:'utf8',windowsHide:true,timeout:15000});
 if(result.status!==0)throw Error(result.stderr);
 function edit(file,fn){const p=path.join(tmp,file);fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8')));}
 edit('dist/config.js',s=>s.replace('let embeddedQuickJSWasmPath;','let embeddedQuickJSWasmPath;\nlet embeddedCodemodeWorkerUrl;\n/** Embedding host override; upstream worker selection is otherwise unchanged. */\nexport function setCodemodeWorkerUrl(url) { embeddedCodemodeWorkerUrl = url; }').replace('export function getCodemodeWorkerSpecifier() {','export function getCodemodeWorkerSpecifier() {\n    if (embeddedCodemodeWorkerUrl) return embeddedCodemodeWorkerUrl;'));
 edit('dist/config.d.ts',s=>s+'\n/** Host-supplied URL of the original bundled Codemode worker. */\nexport declare function setCodemodeWorkerUrl(url: URL): void;\n');
 edit('dist/index.d.ts',s=>s+'\nexport { setEmbeddedQuickJSWasmPath, setCodemodeWorkerUrl } from "./config.ts";\nexport { McpOAuthCredentialStore, type McpSignInPrompt } from "./extensions/mcp/oauth.ts";\nexport { FileAuthStorageBackend, InMemoryAuthStorageBackend, type AuthStorageBackend } from "./core/auth-storage.ts";\nexport type { McpHostController, McpHostSnapshot, McpHostServerStatus } from "./extensions/mcp/index.ts";\n');
 edit('dist/index.js',s=>s+'\nexport { setEmbeddedQuickJSWasmPath, setCodemodeWorkerUrl } from "./config.js";\nexport { McpOAuthCredentialStore } from "./extensions/mcp/oauth.js";\nexport { FileAuthStorageBackend, InMemoryAuthStorageBackend } from "./core/auth-storage.js";\n');
 let patch='';for(const file of files){const a=fs.readFileSync(path.join(upstream,file),'utf8'),b=fs.readFileSync(path.join(tmp,file),'utf8');if(a===b)throw Error('Expected patch missing '+file);patch+='diff --git a/'+file+' b/'+file+'\n'+createTwoFilesPatch('a/'+file,'b/'+file,a,b).split('\n').filter(l=>!l.startsWith('===')).join('\n');}
 fs.writeFileSync('patches/@earendil-works__pi-coding-agent@0.99.2.patch',patch);
 const script=path.join(root,'scripts/pi0992-upgrade.cjs');let text=fs.readFileSync(script,'utf8');text=text.replace('const patch=path.join(root,\'patches\',`@earendil-works__${name}@0.99.1.patch`);','const patch=path.join(root,\'patches\',`@earendil-works__${name}@0.99.2.patch`);');text=text.replace('fs.copyFileSync(patch,target);','if(patch!==target)fs.copyFileSync(patch,target);');text=text.replace("if(!verified[0].found)","if(verified.some(v=>!v.found))");fs.writeFileSync(script,text);
 console.log('REBASED: upstream getCodemodeWorkerSpecifier preserved; host URL override + existing MCP host API only.');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
