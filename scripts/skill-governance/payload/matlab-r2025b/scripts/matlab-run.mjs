import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

let temporary;
try {
  const {values:v}=parseArgs({options:{code:{type:'string'},script:{type:'string'},cwd:{type:'string'},'matlab-exe':{type:'string',default:'C:/Program Files/MATLAB/R2025b/bin/matlab.exe'},help:{type:'boolean'}}});
  if(v.help) console.log('node matlab-run.mjs (--code MATLAB_CODE | --script FILE.m) [--cwd DIRECTORY] [--matlab-exe PATH]');
  else {
    if((v.code!==undefined)===(v.script!==undefined)) throw Error('Supply exactly one of --code and --script');
    const cwd=fs.realpathSync(v.cwd || process.cwd());
    if(!fs.statSync(cwd).isDirectory()) throw Error('--cwd must be a directory');
    if(!fs.statSync(v['matlab-exe']).isFile()) throw Error('MATLAB executable not found');
    let script;
    if(v.script!==undefined) {
      script=fs.realpathSync(v.script);
      if(!fs.statSync(script).isFile()) throw Error('--script must be a file');
    } else {
      temporary=path.join(os.tmpdir(),`mybuddy_matlab_${randomUUID().replaceAll('-','_')}.m`);
      fs.writeFileSync(temporary,v.code,{encoding:'utf8',flag:'wx'});
      script=temporary;
    }
    const quote=s=>s.replaceAll('\\','/').replaceAll("'","''");
    const batch=`cd('${quote(cwd)}'); run('${quote(script)}');`;
    const child=spawn(v['matlab-exe'],['-batch',batch],{cwd,shell:false,stdio:'inherit',windowsHide:true});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code ?? 1));});
  }
} catch(error) { console.error(`[matlab-run] ${error.message}`);process.exitCode=2; }
finally { if(temporary) fs.rmSync(temporary,{force:true}); }
