const {buildSync}=require('esbuild');const {spawnSync}=require('node:child_process');const path=require('node:path');
const root=path.resolve(__dirname,'..');process.chdir(root);
buildSync({entryPoints:['scripts/remote-image-access-test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile:'out/tests/remote-image-access-test.mjs'});
const r=spawnSync(process.execPath,['out/tests/remote-image-access-test.mjs'],{cwd:root,encoding:'utf8',timeout:40000});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exitCode=r.status??1;
