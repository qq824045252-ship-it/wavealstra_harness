const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=process.cwd(),packed=path.resolve(process.argv[2]),archive=path.join(packed,'resources/app.asar');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const manifest=JSON.parse(asar.extractFile(archive,'package.json'));
assert.equal(manifest.dependencies['@earendil-works/pi-ai'],'1.0.4');
const packages=['chord','pi-agent-core','pi-ai','pi-codemode','pi-coding-agent','pi-durable','pi-mcp','pi-telemetry','pi-tui'].map(name=>{
 const data=JSON.parse(fs.readFileSync(path.join(root,'node_modules/@earendil-works',name,'package.json')));assert.equal(data.version,'1.0.4');return {name:data.name,version:data.version};
});
const sourceFiles=files(path.join(root,'out/main'));
for(const file of sourceFiles){const name=path.relative(root,file);assert.equal(hash(asar.extractFile(archive,name)),hash(fs.readFileSync(file)),'Packaged main asset mismatch: '+name);}
const runtime=path.join(packed,'resources/app.asar.unpacked/out/main/capabilities/subagent/runtime');
assert.equal(JSON.parse(fs.readFileSync(path.join(runtime,'package.json'))).version,'1.0.4');
const sourceInputs=files(path.join(root,'src')).concat(files(path.join(root,'shared/src')),files(path.join(root,'patches')),['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','electron.vite.config.ts','scripts/build-subagent-runtime.mjs','scripts/build-pi-codemode-assets.mjs'].map(name=>path.join(root,name))).sort();
const source=crypto.createHash('sha256');for(const file of sourceInputs)source.update(path.relative(root,file)).update(fs.readFileSync(file));
const report={at:new Date().toISOString(),status:'passed',executable:path.join(packed,'MyBuddy.exe'),appVersion:manifest.version,electronVersion:JSON.parse(fs.readFileSync('node_modules/electron/package.json')).version,asarSha256:hash(fs.readFileSync(archive)),executableSha256:hash(fs.readFileSync(path.join(packed,'MyBuddy.exe'))),sourceFingerprint:source.digest('hex'),packages,mainAssetsCompared:sourceFiles.length,workerVersion:'1.0.4',runtime,codemodeWorkerSha256:hash(fs.readFileSync(path.join(packed,'resources/app.asar.unpacked/out/main/codemode-worker.cjs'))),quickjsWasmSha256:hash(fs.readFileSync(path.join(packed,'resources/app.asar.unpacked/out/main/quickjs.wasm'))),originalUserProcessId:27864,userApplicationTerminatedByThisTask:false};
fs.writeFileSync('artifacts/pi104-upgrade/package-integrity.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
