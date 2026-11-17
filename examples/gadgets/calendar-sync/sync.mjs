import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const id = process.argv[2];
if (!id || !/^gdt-[a-zA-Z0-9-]+$/.test(id)) throw new Error('用法：node sync.mjs <gadgetId> [--full]；显示日期由页面单独设置');
if (process.argv.slice(3).some(arg => arg !== '--full')) throw new Error('同步不再接受天数或日期过滤；使用页面的日期窗口');
const root = path.join(os.homedir(), '.mybuddy', 'gadgets', id);
const { createGadgetCommandRunner } = await import(pathToFileURL(path.join(root, 'code/server/commands.mjs')).href);
const { gwsJson, syncSnapshot } = await import(pathToFileURL(path.join(root, 'code/server/calendar.mjs')).href);
const runner = createGadgetCommandRunner({ platform: process.platform, cwd: path.join(root, 'code'), allowedCommands: ['gws'],
  environment: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), nodeExecutable: process.execPath });
try {
  const result = await syncSnapshot({ sourcePath: path.join(root, 'code'), dataPath: path.join(root, 'data'),
    request: params => gwsJson((command, options) => runner.run(command, options), params), forceFull: process.argv.includes('--full') });
  console.log(JSON.stringify({ gadgetId: id, ...result.report, tasks: result.snapshot.tasks?.length ?? 0, notes: result.snapshot.notes?.length ?? 0 }));
} finally { await runner.dispose(); }
