const {buildSync}=require('esbuild');const {spawnSync}=require('node:child_process');const path=require('node:path');
const root=path.resolve(__dirname,'..');process.chdir(root);
buildSync({entryPoints:['scripts/remote-client-regression-test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'out/tests/remote-client-regression-test.mjs'});
const r=spawnSync(process.execPath,['out/tests/remote-client-regression-test.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exitCode=r.status??1;
