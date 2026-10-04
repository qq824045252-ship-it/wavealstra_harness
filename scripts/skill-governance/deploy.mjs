// Maintenance-only deployment of reviewed files. Not part of the Skill runtime.
// node scripts/skill-governance/deploy.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const base=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
const root=fs.realpathSync(manifest.sourceRoot);
const hash=b=>createHash('sha256').update(b).digest('hex');
const resolveFile=(dir,rel)=>{
 if(path.isAbsolute(rel)||rel.split(/[\\/]/).some(p=>p==='..')||!rel.includes('/')) throw Error(`Invalid package path ${rel}`);
 const target=path.resolve(dir,rel);
 if(!target.startsWith(dir+path.sep)) throw Error(`Path outside root: ${rel}`);
 // Do not traverse nested links into unrelated directories.
 let parent=target;
 while(parent!==dir) {
  if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink()) throw Error(`Symlink in deployment path: ${rel}`);
  parent=path.dirname(parent);
 }
 return target;
};
const pending=[];
for(const item of manifest.files){
 const target=resolveFile(root,item.file), source=resolveFile(path.join(base,'payload'),item.file);
 const data=fs.readFileSync(source);
 if(hash(data)!==item.after) throw Error(`Payload hash mismatch: ${item.file}`);
 const before=fs.existsSync(target)?fs.readFileSync(target):null;
 const current=before?hash(before):null;
 if(current===item.after) continue;
 if(current!==item.before && (item.originalBefore===undefined || current!==item.originalBefore)) throw Error(`Installed file changed since review: ${item.file}`);
 pending.push({item,target,data,before,expectedBefore:current});
}
if(!process.argv.includes('--apply')) console.log(`Preflight passed: ${pending.length} files to apply; no writes.`);
else if(!pending.length) console.log('Already applied; all hashes match.');
else {
 const backup=path.join(path.dirname(root),'skill-governance-backups',new Date().toISOString().replace(/[:.]/g,'-'));
 fs.mkdirSync(backup,{recursive:true});
 const written=[];
 try {
  // Capture original bytes before the first write. Backup contains only reviewed files, no config.env.
  fs.writeFileSync(path.join(backup,'rollback.json'),JSON.stringify(pending.map(p=>({file:p.item.file,before:p.before?.toString('base64')??null,after:p.item.after})),null,2));
  for(const entry of pending){
   const current=fs.existsSync(entry.target)?hash(fs.readFileSync(entry.target)):null;
   if(current!==entry.expectedBefore) throw Error(`Concurrent edit: ${entry.item.file}`);
   fs.mkdirSync(path.dirname(entry.target),{recursive:true});
   const temp=entry.target+'.governance-'+randomUUID();
   try {fs.writeFileSync(temp,entry.data,{flag:'wx'});fs.renameSync(temp,entry.target);} finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
   written.push(entry);
  }
  for(const entry of written) if(hash(fs.readFileSync(entry.target))!==entry.item.after) throw Error(`Verification failed: ${entry.item.file}`);
  console.log(`Applied and verified ${written.length} files. Rollback bytes: ${backup}/rollback.json`);
 } catch(error){
  for(const entry of written.reverse()) {
   // Preserve a concurrent edit made after our write.
   if(hash(fs.readFileSync(entry.target))!==entry.item.after) continue;
   if(entry.before) fs.writeFileSync(entry.target,entry.before);else fs.unlinkSync(entry.target);
  }
  throw error;
 }
}
