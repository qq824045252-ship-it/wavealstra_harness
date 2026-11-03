import { RuntimeLogger, resolveRuntimeLogsDir } from '../runtime-logging';
import { CacheRequestTracer, type CacheTraceBoundary, type CacheTraceRecord } from './CacheRequestTracer';

export { CacheRequestTracer, sessionTraceBoundary } from './CacheRequestTracer';
export type { CacheTraceBoundary, CacheTraceRecord, CacheTraceSink } from './CacheRequestTracer';

let logger: RuntimeLogger | undefined;
let tracer: CacheRequestTracer | undefined;

/** The host owns the one rotating log; workers send only keyed metadata over RPC. */
export function writeCacheRequestTrace(record: CacheTraceRecord): void {
  if (process.env.MYBUDDY_CACHE_TRACE === '0') return;
  try {
    logger ??= new RuntimeLogger({ dir: resolveRuntimeLogsDir(), prefix: 'cache-requests',
      onWriteError: () => { /* Never fall back to logging request contents or filesystem errors. */ } });
    logger.info('cache-trace', JSON.stringify(record));
  } catch { /* Observation cannot affect the model or worker lifecycle. */ }
}

export function startCacheRequestTrace(model: { provider: string; id: string; api: string }, sessionId?: string, boundary?: CacheTraceBoundary) {
  if (process.env.MYBUDDY_CACHE_TRACE === '0') return;
  try {
    tracer ??= new CacheRequestTracer(record => writeCacheRequestTrace({ ...record, source: 'main' }));
    return tracer.start(model, sessionId, boundary);
  } catch { return; }
}
