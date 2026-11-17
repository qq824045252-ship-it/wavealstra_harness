import { gwsJson, readSnapshot, syncSnapshot, viewEvents } from './calendar.mjs';

export default function createBackend(ctx) {
  const request = params => gwsJson((command, options) => ctx.exec(command, options), params);
  return { actions: {
    ping: () => ({ ok: true, at: Date.now() }),
    'calendar.read': () => readSnapshot(ctx.sourcePath, ctx.dataPath),
    'calendar.sync': async input => {
      if (input != null && (typeof input !== 'object' || Array.isArray(input) || input.forceFull !== undefined && typeof input.forceFull !== 'boolean')) throw new Error('同步参数无效');
      const result = await syncSnapshot({ sourcePath: ctx.sourcePath, dataPath: ctx.dataPath,
        request, forceFull: input?.forceFull === true, signal: ctx.signal });
      return result.report;
    },
    'calendar.view': async input => {
      if (!input || typeof input.from !== 'string' || typeof input.to !== 'string') throw new Error('缺少显示日期窗口');
      const snapshot = readSnapshot(ctx.sourcePath, ctx.dataPath);
      return { events: await viewEvents(request, snapshot, input.from, input.to, ctx.signal) };
    },
  } };
}
