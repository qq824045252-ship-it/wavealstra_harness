import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Copy native reference files, including nested assets, with no developer-machine paths. */
export function piReferenceAssets(piRoot, prefix) {
  const assets=[];
  function walk(dir, relative='') {
    for (const e of readdirSync(dir, {withFileTypes:true})) {
      const name=relative+e.name, full=join(dir,e.name);
      if(e.isDirectory()) walk(full,name+'/');
      else if(e.isFile()) assets.push({type:'asset',fileName:prefix+name,source:readFileSync(full)});
    }
  }
  walk(join(piRoot,'docs'));
  return assets;
}


/** Package Pi's original worker and WASM; never bundle another orchestration runtime. */
export async function buildPiCodemodeAssets(root) {
  const piRoot = realpathSync(join(root, 'node_modules/@earendil-works/pi-coding-agent'));
  const requirePi = createRequire(join(piRoot, 'package.json'));
  const result = await build({
    entryPoints: [join(piRoot, 'dist/extensions/codemode/worker.js')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
    outfile: 'codemode-worker.cjs', legalComments: 'none', metafile: true,
  });
  const missing = Object.values(result.metafile.outputs).flatMap(output => output.imports)
    .filter(item => item.external && !item.path.startsWith('node:') && !requirePi('node:module').isBuiltin(item.path));
  if (missing.length) throw new Error('Codemode worker has unpackaged dependencies: ' + missing.map(item => item.path).join(', '));
  return [
    ...piReferenceAssets(piRoot, 'pi-docs/'),
    { type: 'asset', fileName: 'codemode-worker.cjs', source: result.outputFiles[0].text },
    { type: 'asset', fileName: 'quickjs.wasm', source: readFileSync(requirePi.resolve('quickjs-wasi/quickjs.wasm')) },
  ];
}
