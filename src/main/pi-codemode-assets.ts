import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setEmbeddedQuickJSWasmPath, setCodemodeWorkerUrl } from '@earendil-works/pi-coding-agent';

/** Resolve packaged resources explicitly instead of depending on a bundled import.meta.url. */
export function configurePiCodemodeAssets(baseDir: string): boolean {
  const unpacked = baseDir.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
  const wasm = join(unpacked, 'quickjs.wasm');
  const worker = join(unpacked, 'codemode-worker.cjs');
  if (!existsSync(wasm) || !existsSync(worker)) {
    if (unpacked !== baseDir) throw new Error('Packaged Pi Codemode worker/WASM assets are missing');
    return false; // Source-level SDK tests use Pi's installed original assets.
  }
  setEmbeddedQuickJSWasmPath(wasm);
  setCodemodeWorkerUrl(pathToFileURL(worker));
  return true;
}
