import { build } from 'esbuild';
const alias={'@':process.cwd()+'/src/renderer/src','@shared':process.cwd()+'/src/shared','@/lib/monacoWorkerEntry?worker&inline':process.cwd()+'/scripts/wave5a-worker-stub.ts'};
await build({entryPoints:['scripts/saved-preview-desktop-fixture.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias,external:['@terrastruct/d2'],loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},outfile:'out/tests/saved-preview-fixture.js'});
await build({entryPoints:['scripts/saved-preview-desktop-test.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'out/tests/saved-preview-desktop.cjs'});
