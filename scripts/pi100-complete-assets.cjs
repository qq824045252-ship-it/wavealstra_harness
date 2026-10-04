const fs=require('node:fs');
function edit(file,old,next){let s=fs.readFileSync(file,'utf8');if(!s.includes(old))throw Error('Missing asset anchor '+file);fs.writeFileSync(file,s.replace(old,next));}
edit('scripts/build-pi-codemode-assets.mjs',"import { readFileSync, realpathSync } from 'node:fs';","import { readFileSync, realpathSync, readdirSync } from 'node:fs';");
edit('scripts/build-pi-codemode-assets.mjs',"import { join } from 'node:path';","import { join } from 'node:path';\n\n/** Copy native reference files, including nested assets, with no developer-machine paths. */\nexport function piReferenceAssets(piRoot, prefix) {\n  const assets=[];\n  function walk(dir, relative='') {\n    for (const e of readdirSync(dir, {withFileTypes:true})) {\n      const name=relative+e.name, full=join(dir,e.name);\n      if(e.isDirectory()) walk(full,name+'/');\n      else if(e.isFile()) assets.push({type:'asset',fileName:prefix+name,source:readFileSync(full)});\n    }\n  }\n  walk(join(piRoot,'docs'));\n  return assets;\n}\n");
edit('scripts/build-pi-codemode-assets.mjs',"  return [\n", "  return [\n    ...piReferenceAssets(piRoot, 'pi-docs/'),\n");
edit('scripts/build-subagent-runtime.mjs',"import { join, relative } from 'node:path';","import { join, relative } from 'node:path';\nimport { piReferenceAssets } from './build-pi-codemode-assets.mjs';");
edit('scripts/build-subagent-runtime.mjs',"  return [...result.outputFiles.map", "  return [...piReferenceAssets(piRoot, prefix+'docs/'), ...result.outputFiles.map");
const file='scripts/pi100-rebase-host-patch.cjs';
edit(file,"  let patch = '';",`  const configPath = path.join(tmp, 'dist/config.js');
  const config = fs.readFileSync(configPath, 'utf8');
  const docsBody = 'export function getDocsPath() {\\n    return resolve(join(getPackageDir(), "docs"));\\n}';
  if (!config.includes(docsBody)) throw Error('Native docs path changed');
  fs.writeFileSync(configPath, config.replace(docsBody, 'export function getDocsPath() {\\n    // Embedded desktop bundles keep upstream reference docs beside their generated assets.\\n    const embedded = join(getPackageDir(), "out", "main", "pi-docs");\\n    return resolve(existsSync(join(embedded, "codemode.md")) ? embedded : join(getPackageDir(), "docs"));\\n}'));
  let patch = '';`);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.build.files=pkg.build.files.filter(x=>typeof x==='string'||x.from!=='node_modules/@earendil-works/pi-coding-agent/docs');
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
console.log('Embedded native references in desktop and child runtime; native package fallback retained.');
