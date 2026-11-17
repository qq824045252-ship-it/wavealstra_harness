import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GadgetStorage } from '../src/main/gadget/GadgetStorage';
import { createGadgetCommandRunner } from '../src/main/platform/gadget-commands';
import { upgradePage } from '../examples/gadgets/calendar-sync/upgrade-page.mjs';
import type { GadgetSourceUpdateRequest } from '../src/shared/gadget-types';

const id=process.argv[2];
if(!/^gdt-[a-zA-Z0-9-]+$/.test(id||''))throw Error('Pass the explicit Gadget ID');
const root=path.join(os.homedir(),'.mybuddy','gadgets');
const storage=new GadgetStorage(root);
const output=path.join(process.cwd(),'out/diagnostics/calendar-sync-repair',id);
fs.mkdirSync(output,{recursive:true});
const template=path.join(process.cwd(),'examples/gadgets/calendar-sync');
const patchFile=path.join(output,'patch.json');
if(!process.argv.includes('--apply')){
  const source=storage.readSource(id);
  const html=source.files.find(file=>file.path===source.manifest.entry);
  const oldBackend=source.manifest.backend;
  if(!html||!oldBackend)throw Error('Expected an existing web Gadget with a backend');
  const api=source.files.find(file=>file.path===oldBackend.entry);
  if(!api)throw Error('Backend source missing');
  const prefix="import createCalendarBackend from './calendar-api.mjs';\n";
  let apiSource=api.content.replace(/\r\n/g,'\n');
  if(!apiSource.includes('./calendar-api.mjs')){
    if(!apiSource.includes('    actions: {'))throw Error('Backend changed; read it before patching');
    apiSource=prefix+apiSource.replace('    actions: {','    actions: {\n      ...createCalendarBackend(ctx).actions,');
  }
  const commands=`import {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nexport const createGadgetCommandRunner=${createGadgetCommandRunner.toString()};\n`;
  const patch:GadgetSourceUpdateRequest={gadgetId:id,expectedRevision:source.revision,
    backend:{...oldBackend,commands:[...new Set([...oldBackend.commands,'gws'])],timeoutMs:120_000},
    files:[{path:source.manifest.entry,content:upgradePage(html.content)},
      {path:oldBackend.entry,content:apiSource},
      {path:'server/calendar-api.mjs',content:fs.readFileSync(path.join(template,'server/api.mjs'),'utf8')},
      {path:'server/calendar.mjs',content:fs.readFileSync(path.join(template,'server/calendar.mjs'),'utf8')},
      {path:'server/commands.mjs',content:commands}],
  };
  fs.writeFileSync(path.join(output,`source-before-${source.revision}.json`),JSON.stringify(source),{flag:'wx',mode:0o600});
  fs.writeFileSync(patchFile,JSON.stringify(patch),{mode:0o600});
  console.log(JSON.stringify({prepared:true,gadgetId:id,revision:source.revision,files:patch.files.map(file=>file.path),output}));
} else {
  const input:unknown=JSON.parse(fs.readFileSync(patchFile,'utf8'));
  if(!input||typeof input!=='object'||!('gadgetId' in input)||input.gadgetId!==id)throw Error('Invalid prepared patch');
  // Prepared by this script, then independently verified in the real tool/GUI
  // fixture before activation. The storage owner enforces its source revision.
  const patch=input as GadgetSourceUpdateRequest;
  const saved=storage.updateSource(patch,()=>{});
  const {DatabaseSync}=require('node:sqlite') as typeof import('node:sqlite');
  const db=new DatabaseSync(path.join(os.homedir(),'.mybuddy/app.db'),{readOnly:true});
  const row=db.prepare('SELECT cwd FROM tasks WHERE id=(SELECT scope_id FROM gadgets WHERE id=?)').get(id);
  db.close();
  if(!row||typeof row.cwd!=='string')throw Error('Cannot locate the authoritative task workspace');
  const syncFile=path.join(row.cwd,'sync.mjs');
  if(fs.existsSync(syncFile))fs.copyFileSync(syncFile,path.join(output,`sync-before-${Date.now()}.mjs`));
  fs.copyFileSync(path.join(template,'sync.mjs'),syncFile);
  const report={applied:true,gadgetId:id,revision:saved.revision,syncFile,output};
  fs.writeFileSync(path.join(output,'activation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
