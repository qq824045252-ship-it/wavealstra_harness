import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Pi's image resize pipeline ships two unpackaged runtime assets:
 * - dist/utils/image-resize-worker.js : the worker_threads entry the main
 *   bundle loads via new URL("./image-resize-worker.js", import.meta-ish __filename).
 * - @silvia-odwyer/photon-node/photon_rs_bg.wasm : the WASM glue reads via
 *   path.join(__dirname, "photon_rs_bg.wasm") at require time.
 *
 * Main-bundle lookup is CJS (app package.json has no "type"), so the ESM worker
 * source is transpiled the same way codemode-worker.cjs is, while the WASM is
 * emitted byte-identical from the photon-node package.
 */

export const IMAGE_RESIZE_WORKER_FILE = 'image-resize-worker.js';
export const PHOTON_WASM_FILE = 'photon_rs_bg.wasm';

export async function buildPiImageResizeAssets(root) {
  const piRoot = realpathSync(join(root, 'node_modules/@earendil-works/pi-coding-agent'));
  const requirePi = createRequire(join(piRoot, 'package.json'));
  const result = await build({
    entryPoints: [join(piRoot, 'dist/utils/image-resize-worker.js')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
    outfile: IMAGE_RESIZE_WORKER_FILE, legalComments: 'none',
    // pi 的 photon.js 用 createRequire(import.meta.url)；CJS 输出没有 import.meta
    // （esbuild 只会留下 undefined）。用实体 define + banner 注入等效表达式，
    // 复用主包同款 pathToFileURL(__filename)，保证 out/main 上下文可析。
    define: { 'import.meta.url': '__pi_import_meta_url__' },
    banner: { js: 'var __pi_import_meta_url__ = require("url").pathToFileURL(__filename).href;' },
  });
  const wasmPath = join(dirname(requirePi.resolve('@silvia-odwyer/photon-node/package.json')), PHOTON_WASM_FILE);
  return [
    { type: 'asset', fileName: IMAGE_RESIZE_WORKER_FILE, source: result.outputFiles[0].text },
    { type: 'asset', fileName: PHOTON_WASM_FILE, source: readFileSync(wasmPath) },
  ];
}
