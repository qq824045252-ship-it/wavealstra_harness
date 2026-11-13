// Node 24's built-in TypeScript transform: no bundler, emitted files, or caches.
// This runner covers .ts behavior tests only, not TSX or browser/layout tests.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const local = filename => filename.startsWith(root + sep) && !filename.includes(`${sep}node_modules${sep}`);
const file = filename => existsSync(filename) && statSync(filename).isFile();
registerHooks({
  resolve(specifier, context, nextResolve) {
    let filename;
    if (specifier === 'electron') filename = join(root, 'scripts', 'arch-electron-stub.ts');
    else if (specifier.startsWith('@/')) filename = join(root, 'src', 'renderer', 'src', specifier.slice(2));
    else if (specifier.startsWith('@shared/')) filename = join(root, 'src', 'shared', specifier.slice(8));
    else if (specifier.startsWith('file:')) filename = fileURLToPath(specifier);
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) filename = fileURLToPath(new URL(specifier, context.parentURL));
    if (filename && local(filename)) {
      const candidates = [filename, ...(filename.endsWith('.js') ? [filename.slice(0,-3)+'.ts'] : []), ...(extname(filename) ? [] : [filename + '.ts', filename + '.js', filename + '.mjs', join(filename, 'index.ts')])];
      const found = candidates.find(file);
      if (found) return { url:pathToFileURL(found).href, shortCircuit:true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const filename = fileURLToPath(url);
      if (local(filename) && filename.endsWith('.ts')) {
        return { format:'module', source:stripTypeScriptTypes(readFileSync(filename, 'utf8'), {mode:'transform',sourceUrl:url}), shortCircuit:true };
      }
    }
    return nextLoad(url, context);
  },
});
