import { RuntimeLogger, resolveRuntimeLogsDir } from '../runtime-logging';
import { CacheRequestTracer, type CacheTraceBoundary, type CacheTraceRecord } from './CacheRequestTracer';

export { CacheRequestTracer, sessionTraceBoundary } from './CacheRequestTracer';
export type { CacheTraceBoundary, CacheTraceRecord, CacheTraceSink } from './CacheRequestTracer';

let logger: RuntimeLogger | undefined;
let tracer: CacheRequestTracer | undefined;
export type DiagnosticModel = { provider: string; id: string; api: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
const observers = new Set<(record: CacheTraceRecord, model: DiagnosticModel) => void>();
export function observeCacheRequestTraces(observer: (record: CacheTraceRecord, model: DiagnosticModel) => void): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

/** The host owns the rotating request log; diagnostics observers receive the same metadata. */
export function writeCacheRequestTrace(record: CacheTraceRecord): void {
  if (process.env.MYBUDDY_CACHE_TRACE === '0') return;
  try {
    logger ??= new RuntimeLogger({ dir: resolveRuntimeLogsDir(), prefix: 'cache-requests',
      onWriteError: () => { /* Never fall back to logging request contents or filesystem errors. */ } });
    logger.info('cache-trace', JSON.stringify(record));
  } catch { /* Observation cannot affect the model or worker lifecycle. */ }
}

export function startCacheRequestTrace(model: DiagnosticModel, sessionId?: string, boundary?: CacheTraceBoundary) {
  if (process.env.MYBUDDY_CACHE_TRACE === '0' && observers.size === 0) return;
  try {
    tracer ??= new CacheRequestTracer(record => writeCacheRequestTrace({ ...record, source: 'main' }));
    return tracer.start(model, sessionId, boundary, record => {
      for (const observe of observers) { try { observe(record, model); } catch { /* diagnostics cannot fail a model call */ } }
    });
  } catch { return; }
}
