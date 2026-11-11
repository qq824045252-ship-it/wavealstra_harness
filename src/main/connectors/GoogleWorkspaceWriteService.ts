import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GoogleCreateEventRequest, GoogleGetEventRequest, GoogleSendMailRequest, GoogleSentMail, GoogleUpdateEventRequest, GoogleWorkspaceWriteResult, GoogleWrittenEvent } from '../../shared/google-workspace-write';
import { discoverGoogleWorkspaceRuntime, type GoogleWorkspaceRuntime } from '../platform/google-workspace-runtime';
import { GOOGLE_WORKSPACE_BRIDGE } from './google-workspace-bridge';

type Action = 'sendMail' | 'createEvent' | 'updateEvent' | 'getEvent';
type Result = GoogleWorkspaceWriteResult<GoogleSentMail | GoogleWrittenEvent>;
type Failure = Extract<Result, { ok: false }>;
export type GwsWriteRunner = (action: Action, request: Record<string, unknown>, signal?: AbortSignal) => Promise<Result>;
const messages: Record<string, string> = {
  invalid_request: '参数无效；请检查明确的收件地址、时间和通知范围。', cli_missing: '未找到已有 gws Python 运行时。', unsupported_cli: '当前 gws 包装器格式不受支持。',
  conflict: '日程已被修改；请重新读取并确认后再提交。', permission_denied: '当前 Google 授权不足；不会自动扩权。', auth_required: 'Google 授权缺失或已过期；请自行检查已有 gws 授权。',
  unknown_outcome: '无法确定操作是否已完成。请先检查邮箱或日历，不要重复提交。', idempotency_conflict: '此操作编号已用于不同内容，请重新确认。',
  service_error: 'Google 操作失败，未取得有效回执。', invalid_response: 'Google 返回了无法验证的回执。', cancelled: '操作已取消。', timeout: 'Google 操作超时。'
};
function failure(code: Failure['error']['code'], outcome: Failure['error']['outcome'] = 'not_started'): Failure {
  return { ok: false, error: { code, outcome, message: messages[code] ?? messages.service_error, ...(outcome === 'unknown' ? { nextStep: messages.unknown_outcome } : {}) }, checkedAt: Date.now() };
}
export function createGoogleWorkspaceWriteRunner(discover: () => Promise<GoogleWorkspaceRuntime> = discoverGoogleWorkspaceRuntime, timeoutMs = 30_000): GwsWriteRunner {
  return async (action, request, signal) => {
    if (signal?.aborted) return failure('cancelled');
    let runtime: GoogleWorkspaceRuntime;
    try { runtime = await discover(); } catch (e) { return failure(e instanceof Error && e.message === 'unsupported_cli' ? 'unsupported_cli' : 'cli_missing'); }
    if (signal?.aborted) return failure('cancelled');
    return new Promise(resolve => {
      let spawned = false;
      const child = execFile(runtime.python, ['-c', GOOGLE_WORKSPACE_BRIDGE, runtime.module], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (error, stdout) => {
        const uncertain = spawned && action !== 'getEvent' ? 'unknown' : 'not_started';
        if (error) { resolve(failure(signal?.aborted ? 'cancelled' : error.killed ? 'timeout' : 'service_error', uncertain)); return; }
        try {
          const value = JSON.parse(stdout);
          if (value?.ok === true && value.data && typeof value.data.id === 'string' && value.data.id.length > 0 && value.data.id.length <= 256) {
            if (action !== 'sendMail' && (typeof value.data.etag !== 'string' || typeof value.data.start !== 'string' || typeof value.data.end !== 'string' || !Array.isArray(value.data.attendees))) throw new Error();
            resolve({ ok: true, data: value.data, checkedAt: Date.now() });
          } else if (value?.ok === false && value.error && ['not_started', 'failed', 'unknown'].includes(value.error.outcome) && Object.hasOwn(messages, value.error.code)) {
            resolve(failure(value.error.code, value.error.outcome));
          } else resolve(failure('invalid_response', uncertain));
        } catch { resolve(failure('invalid_response', uncertain)); }
      });
      child.once('spawn', () => { spawned = true; });
      child.stdin?.on('error', () => { /* exec callback reports process failure; do not replay. */ });
      child.stdin?.end(JSON.stringify({ action, request }));
    });
  };
}
function requiredText(value: unknown, max: number, allowEmpty = false, multiline = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || (multiline ? /[\x00\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error('invalid_request');
}
function emails(value: unknown, required = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 50 || (required && value.length === 0)) throw new Error('invalid_request');
  for (const address of value) {
    requiredText(address, 254);
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(address) || address.includes('..')) throw new Error('invalid_request');
  }
}
function validate(action: Action, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');
  const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const common = ['operationId', 'calendar', 'title', 'start', 'end', 'allDay', 'timeZone', 'description', 'location', 'attendees', 'notifyAttendees'];
  const allowed = action === 'sendMail' ? ['operationId', 'to', 'cc', 'subject', 'body'] : action === 'getEvent' ? ['calendar', 'id'] : action === 'createEvent' ? common : [...common, 'id', 'etag'];
  if (Object.keys(request).some(key => !allowed.includes(key)) || Buffer.byteLength(JSON.stringify(request)) > 240_000) throw new Error('invalid_request');
  if (action !== 'getEvent') { requiredText(request.operationId, 128); if (!/^[a-zA-Z0-9_-]{8,128}$/.test(request.operationId)) throw new Error('invalid_request'); }
  if (action === 'sendMail') {
    emails(request.to, true); if (request.cc !== undefined) emails(request.cc);
    if ((request.to as string[]).length + ((request.cc as string[] | undefined)?.length ?? 0) > 50) throw new Error('invalid_request');
    requiredText(request.subject, 998, true); requiredText(request.body, 100_000, true, true); return request;
  }
  request.calendar ??= 'primary'; requiredText(request.calendar, 320);
  if (action === 'getEvent' || action === 'updateEvent') { requiredText(request.id, 256); if (!/^[A-Za-z0-9_-]+$/.test(request.id)) throw new Error('invalid_request'); }
  if (action === 'updateEvent') {
    requiredText(request.etag, 256);
    if (!Object.keys(request).some(key => ['title', 'start', 'end', 'description', 'location', 'attendees', 'timeZone', 'allDay'].includes(key))) throw new Error('invalid_request');
  }
  if (action === 'createEvent') { requiredText(request.title, 2000); requiredText(request.start, 100); requiredText(request.end, 100); if (typeof request.allDay !== 'boolean') throw new Error('invalid_request'); }
  for (const [key, max] of [['title', 2000], ['start', 100], ['end', 100], ['location', 2000], ['timeZone', 100]] as const) if (request[key] !== undefined) requiredText(request[key], max, key === 'location');
  if (request.description !== undefined) requiredText(request.description, 8000, true, true);
  for (const key of ['allDay', 'notifyAttendees']) if (request[key] !== undefined && typeof request[key] !== 'boolean') throw new Error('invalid_request');
  if (request.attendees !== undefined) { emails(request.attendees); if (request.attendees.length && request.notifyAttendees !== true) throw new Error('invalid_request'); }
  return request;
}
function canonical(value: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))); }
interface Journal { hash: string; state: 'pending' | 'finished'; result?: Result }
/** Only ids, time boundaries and status survive restart. Never persist content or tokens. */
function minimal(result: Result): Result {
  if (!result.ok || !('etag' in result.data)) return result;
  const d = result.data;
  return { ...result, data: { id: d.id, etag: d.etag, calendar: d.calendar, operationId: d.operationId, start: d.start, end: d.end, allDay: d.allDay, title: '', attendees: [], receiptOnly: true } };
}
export class GoogleWorkspaceWriteService {
  constructor(private readonly options: { runner?: GwsWriteRunner; journalDirectory?: string } = {}) {}
  /** Host-only request identity. Never sourced from model/request JSON. Unknown
   * writes retain this exclusive claim across fresh operation IDs and restarts. */
  private async runScoped<T extends GoogleSentMail | GoogleWrittenEvent>(action: Action, input: unknown, signal?: AbortSignal, requestScope?: string): Promise<GoogleWorkspaceWriteResult<T>> {
    if (requestScope === undefined) return this.run<T>(action, input, signal);
    try { requiredText(requestScope, 1024); validate(action, input); } catch { return failure('invalid_request'); }
    if (signal?.aborted) return failure('cancelled');
    const directory = this.options.journalDirectory ?? join(homedir(), '.mybuddy', 'google-workspace-write-journal');
    const scopePath = join(directory, `scope-${createHash('sha256').update(requestScope).digest('hex')}.lock`);
    let claim: FileHandle | undefined;
    let owned = false;
    let openingClaim = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      openingClaim = true;
      claim = await open(scopePath, 'wx', 0o600); owned = true; openingClaim = false;
      await claim.writeFile('{"state":"pending"}'); await claim.sync(); await claim.close(); claim = undefined;
    } catch (error) {
      await claim?.close().catch(() => {});
      if (owned) await unlink(scopePath).catch(() => {});
      return openingClaim && (error as NodeJS.ErrnoException).code === 'EEXIST' ? failure('unknown_outcome', 'unknown') : failure('service_error', 'not_started');
    }
    let result: GoogleWorkspaceWriteResult<T>;
    try { result = await this.run<T>(action, input, signal); }
    catch { result = failure('unknown_outcome', 'unknown'); }
    if (result.ok || result.error.outcome !== 'unknown') {
      // Only this owner can release. Failure to remove is conservative: later
      // writes remain blocked, while this caller still receives its real receipt.
      await unlink(scopePath).catch(() => {});
    }
    return result;
  }
  private async run<T extends GoogleSentMail | GoogleWrittenEvent>(action: Action, input: unknown, signal?: AbortSignal): Promise<GoogleWorkspaceWriteResult<T>> {
    let request: Record<string, unknown>;
    try { request = validate(action, input); } catch { return failure('invalid_request'); }
    if (signal?.aborted) return failure('cancelled');
    const runner = this.options.runner ?? createGoogleWorkspaceWriteRunner();
    if (action === 'getEvent') {
      try { return await runner(action, request, signal) as GoogleWorkspaceWriteResult<T>; } catch { return failure('service_error'); }
    }
    const hash = createHash('sha256').update(canonical({ action, ...request })).digest('hex');
    const key = createHash('sha256').update(String(request.operationId)).digest('hex');
    const directory = this.options.journalDirectory ?? join(homedir(), '.mybuddy', 'google-workspace-write-journal');
    const path = join(directory, `${key}.json`);
    let handle: FileHandle | undefined;
    let retryLock: FileHandle | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { handle = await open(path, 'wx', 0o600); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let prior: Journal;
        try { prior = JSON.parse(await readFile(path, 'utf8')); } catch { return failure('unknown_outcome', 'unknown'); }
        if (prior.hash !== hash) return failure('idempotency_conflict');
        if (prior.state !== 'finished' || !prior.result) return failure('unknown_outcome', 'unknown');
        if (prior.result.ok || prior.result.error.outcome === 'unknown') return prior.result as GoogleWorkspaceWriteResult<T>;
        // A caller may explicitly retry a definite no-effect failure. A separate
        // exclusive claim closes the read/replace race; there is no auto retry.
        try { retryLock = await open(`${path}.retry`, 'wx', 0o600); }
        catch { return failure('unknown_outcome', 'unknown'); }
        const latest: Journal = JSON.parse(await readFile(path, 'utf8'));
        if (latest.hash !== hash || latest.state !== 'finished' || !latest.result || latest.result.ok || latest.result.error.outcome === 'unknown') {
          await retryLock.close(); retryLock = undefined; await unlink(`${path}.retry`);
          return (latest.hash !== hash ? failure('idempotency_conflict') : latest.result ?? failure('unknown_outcome', 'unknown')) as GoogleWorkspaceWriteResult<T>;
        }
        handle = await open(path, 'w', 0o600);
      }
      await handle.writeFile(JSON.stringify({ hash, state: 'pending' })); await handle.sync(); await handle.close(); handle = undefined;
      if (retryLock) { await retryLock.close(); retryLock = undefined; await unlink(`${path}.retry`); }
    } catch { await handle?.close().catch(() => {}); await retryLock?.close().catch(() => {}); return failure('service_error'); }
    let result: Result;
    try { result = await runner(action, request, signal); } catch { result = failure('unknown_outcome', 'unknown'); }
    // Pending records are deliberately never replayed, including process crashes.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ hash, state: 'finished', result: minimal(result) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } catch { await unlink(temporary).catch(() => {}); /* Preserve pending, not a replayable operation. */ }
    return result as GoogleWorkspaceWriteResult<T>;
  }
  sendMail(request: GoogleSendMailRequest, signal?: AbortSignal, requestScope?: string) { return this.runScoped<GoogleSentMail>('sendMail', request, signal, requestScope); }
  createEvent(request: GoogleCreateEventRequest, signal?: AbortSignal, requestScope?: string) { return this.runScoped<GoogleWrittenEvent>('createEvent', request, signal, requestScope); }
  updateEvent(request: GoogleUpdateEventRequest, signal?: AbortSignal, requestScope?: string) { return this.runScoped<GoogleWrittenEvent>('updateEvent', request, signal, requestScope); }
  getEvent(request: GoogleGetEventRequest, signal?: AbortSignal) { return this.run<GoogleWrittenEvent>('getEvent', request, signal); }
}
export const googleWorkspaceWriteService = new GoogleWorkspaceWriteService();
