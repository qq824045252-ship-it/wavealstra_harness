import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.cwd(),dest=process.env.BOT_AVATAR_PREVIEW_DIRECTORY || join(root,'out/tests/bot-avatar-preview');mkdirSync(dest,{recursive:true});
const manifest=JSON.parse(readFileSync(join(root,'src/shared/bot-avatar-manifest.json'),'utf8'));
mkdirSync(join(dest,'assets'),{recursive:true});
const images=Object.fromEntries(manifest.entries.map(entry=>[entry.id,Object.fromEntries(['poster','animation'].filter(k=>entry[k]).map(k=>{
 copyFileSync(join(root,'src/renderer/src/assets/bot-avatars',entry[k].file),join(dest,'assets',entry[k].file));
 return [k,`assets/${entry[k].file}`];
}))]));
const privateImages=Object.fromEntries(['poster','animation'].map(k=>[k,`data:image/${k==='poster'?'png':'gif'};base64,${readFileSync(join(root,'src/renderer/src/assets/bot-avatars',manifest.entries[0][k].file)).toString('base64')}`]));
const bootstrap=`globalThis.avatarPreviewImages=${JSON.stringify(images)};const privateImages=${JSON.stringify(privateImages)};
const storageKey='bot-avatar-acceptance-only';let snapshot=JSON.parse(localStorage.getItem(storageKey)||'null')||{selections:{},uploads:[],motion:true};
globalThis.avatarPreviewApi=async request=>{
 let image,importedId;
 if(request.kind==='set')snapshot.selections[request.botId]={assetId:request.assetId,revision:request.expectedRevision+1};
 if(request.kind==='motion')snapshot.motion=request.enabled;
 if(request.kind==='import'){importedId='upload:'+'a'.repeat(64);if(!snapshot.uploads.length)snapshot.uploads=[{id:importedId,label:'本地GIF（合成测试）',animated:true}];}
 if(request.kind==='remove'){snapshot.uploads=[];for(const choice of Object.values(snapshot.selections))if(choice.assetId===request.assetId){choice.assetId=null;choice.revision++;}}
 if(request.kind==='read')image=privateImages[request.variant==='animation'?'animation':'poster'];
 localStorage.setItem(storageKey,JSON.stringify(snapshot));return {ok:true,snapshot:structuredClone(snapshot),image,importedId};
};`;
const css=readFileSync(join(root,'out/tests/bot-avatar-ui-fixture.css'),'utf8');
copyFileSync(join(root,'out/tests/bot-avatar-ui-fixture.js'),join(dest,'fixture.js'));
writeFileSync(join(dest,'fixture.css'),css);
writeFileSync(join(dest,'preview.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot 头像 · 合成素材验收</title><link rel="stylesheet" href="fixture.css"><style>html,body{height:auto!important;min-height:100%;overflow:auto!important}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui}.avatar-fixture{max-width:1000px;margin:auto;padding:20px}.avatar-fixture-content{display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px}.avatar-fixture aside button{display:flex;align-items:center;gap:8px;margin:10px 0}.avatar-fixture header{display:flex;align-items:center;gap:8px;padding:14px 0}[data-testid=message],[data-testid=collaboration]{padding:12px;border:1px solid var(--border-subtle);border-radius:10px;margin:8px 0}[data-testid=many]{display:flex;gap:3px;flex-wrap:wrap}@media(max-width:600px){.avatar-fixture{padding:12px}.avatar-fixture-content{grid-template-columns:minmax(0,1fr)}.avatar-fixture aside{display:flex;gap:8px}}</style><div id="root"></div><script>${bootstrap}</script><script src="fixture.js"></script></html>`);
console.log(dest+'/preview.html');
