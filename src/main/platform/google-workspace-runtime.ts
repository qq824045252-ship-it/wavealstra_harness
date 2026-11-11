import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
export interface GoogleWorkspaceRuntime { python: string; module: string }
/** Parse only the known two-line wrapper; never evaluate shell text. */
export function parseGwsWrapper(source: string): GoogleWorkspaceRuntime | undefined {
  const match = /^#!\/bin\/(?:sh|bash)\r?\nexec ("[^"\r\n$`]+"|'[^'\r\n]+'|[^\s"'\\$`;|&<>]+) ("[^"\r\n$`]+"|'[^'\r\n]+'|[^\s"'\\$`;|&<>]+) "\$@"\s*$/.exec(source);
  if (!match) return;
  const unquote = (s: string) => /^["']/.test(s) ? s.slice(1, -1) : s;
  const python = unquote(match[1]), module = unquote(match[2]);
  if (!isAbsolute(python) || !isAbsolute(module) || !/[/\\]python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(python) || !/[/\\]gws\.py$/.test(module)) return;
  return { python, module };
}
export async function discoverGoogleWorkspaceRuntime(): Promise<GoogleWorkspaceRuntime> {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    try {
      const wrapper = join(directory, 'gws'); await access(wrapper, constants.X_OK);
      if ((await stat(wrapper)).size > 8192) continue;
      const runtime = parseGwsWrapper(await readFile(wrapper, 'utf8'));
      if (!runtime) throw new Error('unsupported_cli');
      await access(runtime.python, constants.X_OK); await access(runtime.module, constants.R_OK); return runtime;
    } catch (error) { if (error instanceof Error && error.message === 'unsupported_cli') throw error; }
  }
  throw new Error('cli_missing');
}
