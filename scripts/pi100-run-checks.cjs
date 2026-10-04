/** Run bounded regression batches synchronously. Every result records this run, never reuses old reports. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const out=path.join(root,'artifacts/pi100-upgrade/checks');fs.mkdirSync(out,{recursive:true});
const names=process.argv.slice(2);if(!names.length)throw Error('Provide package script names');
const rows=[];
for(const name of names){
 if(!Object.hasOwn(require('../package.json').scripts,name))throw Error('Unknown script '+name);
 const label=name.replace(/[^\w.-]/g,'-'),file=path.join(out,label+'.log');
 const fd=fs.openSync(file,'w');const start=Date.now();
 const r=cp.spawnSync('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c','pnpm run '+name],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],timeout:105000});fs.closeSync(fd);
 const row={name,status:r.status===0?'passed':'failed',exitCode:r.status,error:r.error?.message,at:new Date(start).toISOString(),durationMs:Date.now()-start,log:file};rows.push(row);
 fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(row,null,2)+'\n');
 const text=fs.readFileSync(file,'utf8');console.log(JSON.stringify(row));console.log(text.split(/\r?\n/).slice(-8).join('\n'));
 if(r.status!==0)process.exitCode=1;
}
