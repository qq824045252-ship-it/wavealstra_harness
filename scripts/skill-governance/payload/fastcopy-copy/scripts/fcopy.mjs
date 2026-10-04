import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const modes = new Set(['force_copy','noexist_only','update','diff','exist_diff','exist_update','sync','sync_update','move','move_noexist','delete','verify','verify_read','verify_check']);
try {
  const { values: v } = parseArgs({options: {
    src:{type:'string'}, dst:{type:'string'}, mode:{type:'string',default:'force_copy'},
    include:{type:'string'}, exclude:{type:'string'}, 'log-file':{type:'string'},
    'no-confirm-del':{type:'boolean'}, help:{type:'boolean'},
  }});
  if(v.help) {
    console.log('node fcopy.mjs --src PATH [--dst PATH] [--mode force_copy] [--include GLOB] [--exclude GLOB] [--log-file PATH] [--no-confirm-del]');
  } else {
    const exe='C:/Users/servi/Documents/FastCopy/App/FastCopy64/fcp.exe';
    if(!existsSync(exe)) throw Error(`FastCopy executable not found: ${exe}`);
    if(!v.src || !existsSync(v.src)) throw Error('Existing --src is required');
    if(!modes.has(v.mode)) throw Error(`Invalid mode: ${v.mode}`);
    if(v.mode!=='delete' && !v.dst) throw Error('--dst is required unless mode is delete');
    if(v['no-confirm-del'] && v.mode!=='delete') throw Error('--no-confirm-del requires delete mode');
    const src=path.resolve(v.src), dst=v.dst ? path.resolve(v.dst) : null;
    if(['delete','move','move_noexist','sync','sync_update'].includes(v.mode)) {
      if(src===path.parse(src).root || (dst && dst===path.parse(dst).root)) throw Error('Destructive operations on drive roots are forbidden');
    }
    if(dst) {
      const relative=path.relative(src,dst);
      if(!relative || (statSync(src).isDirectory() && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))) throw Error('Destination must not equal or be inside source');
    }
    const args=[`/cmd=${v.mode}`];
    for(const [key,flag] of [['include','include'],['exclude','exclude'],['log-file','logfile']]) if(v[key]) args.push(`/${flag}=${v[key]}`);
    if(v['no-confirm-del']) args.push('/no_confirm_del');
    // FastCopy distinguishes a directory from its contents by a trailing separator.
    args.push(/[\\/]$/.test(v.src) ? src+path.sep : src);
    if(v.mode!=='delete') args.push(`/to=${dst}`);
    // Native spawn avoids MSYS conversion of /cmd and /to, and shell quoting.
    const child=spawn(exe,args,{shell:false,stdio:'inherit',windowsHide:true});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code ?? 1));});
    process.exitCode=code;
  }
} catch(error) { console.error(`[fcopy] ${error.message}`);process.exitCode=2; }
