import { execFile } from 'node:child_process';
import type { GoogleCalendarEvent, GoogleMailSummary, GoogleWorkspaceAccess, GoogleWorkspaceErrorCode, GoogleWorkspaceResult, GoogleWorkspaceStatus } from '../../shared/google-workspace';

export const GWS_TIME_ZONE = 'Asia/Shanghai';
export interface GwsCommandResult { stdout: string; stderr: string; code: number | string | null; killed?: boolean }
export type GwsRunner = (args: string[], signal?: AbortSignal) => Promise<GwsCommandResult>;
/** Fixed executable + argv; never a shell, marketplace command, token reader or login flow. */
export function createGwsRunner(options: { executable?: string; prefixArgs?: string[]; timeoutMs?: number; maxBuffer?: number } = {}): GwsRunner {
  return (args, signal) => new Promise(resolve => {
  execFile(options.executable ?? 'gws', [...options.prefixArgs ?? [], ...args], { encoding: 'utf8', timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxBuffer ?? 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
    resolve({ stdout, stderr, code: error ? (error as NodeJS.ErrnoException & { code?: string | number }).code ?? 1 : 0, killed: Boolean(error && 'killed' in error && error.killed) });
  });
  });
}
export const runGws = createGwsRunner();
class GwsError extends Error {
  constructor(readonly code: GoogleWorkspaceErrorCode, message: string, readonly nextStep?: string) { super(message); }
}
function fail(code: GoogleWorkspaceErrorCode, message: string, nextStep?: string): never { throw new GwsError(code, message, nextStep); }
function commandError(result: GwsCommandResult, signal?: AbortSignal): never {
  // Do not return raw stderr: providers may echo paths, credentials or mail content.
  const text = `${result.stdout}\n${result.stderr}`;
  if (signal?.aborted || result.code === 'ABORT_ERR') fail('cancelled', '查询已取消。');
  if (result.code === 'ENOENT') fail('cli_missing', '未找到可执行的 gws。', '请在系统中安装已有的 gws，并确认 MyBuddy 的 PATH 可以找到它。');
  if (/invalid_grant|expired or revoked|尚未授权|未授权|invalid credentials|unauthenticated|401\b/i.test(text)) fail('auth_required', 'Google 授权缺失、过期或已撤销。', '请自行使用 gws auth 重新授权，然后重试。MyBuddy 不会自动登录或增加权限。');
  if (/SERVICE_DISABLED|accessNotConfigured|未启用/i.test(text)) fail('api_disabled', 'Google API 尚未启用。', '请在当前 Google 项目中检查对应 API 的启用状态。');
  if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|permission.denied|403\b/i.test(text)) fail('permission_denied', '当前 Google 账号没有执行此读取所需的权限。', '请检查该账号和服务的权限；MyBuddy 不会自动扩权。');
  if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('invalid_response', 'gws 返回内容超过安全读取上限；未显示不完整结果。', '请缩小查询范围后重试。');
  if (result.killed || /ETIMEDOUT|timed out|TimeoutError/i.test(text)) fail('timeout', 'gws 查询超时，尚未确认服务是否可用。', '检查网络后重试；超时不等于账号已退出。');
  if (/invalid choice|unrecognized arguments|usage: gws/i.test(text)) fail('unsupported_cli', '此 gws 的命令格式不受当前适配器支持。', '当前适配器支持现有 Python gws 的 gmail search/read 与 cal agenda 命令。');
  fail('service_error', 'gws 查询失败，未取得有效的服务回执。', '请检查网络或在终端执行同一只读查询以诊断。');
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_response', 'gws 返回了无法识别的数据。'); return value as Record<string, unknown>; }
function text(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : ''; }
function requestObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request', '查询参数格式不正确。'); return value as Record<string, unknown>; }
function validText(value: unknown, name: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_request', `${name}为空、过长或包含控制字符。`); return value.trim(); }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('invalid_request', `数量必须是 ${min}–${max} 之间的整数。`); return value; }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function jsonArray(output: string): unknown[] { let data: unknown; try { data = JSON.parse(output); } catch { fail('invalid_response', 'gws 没有返回有效的 JSON。'); } if (!Array.isArray(data)) fail('invalid_response', 'gws 没有返回预期的列表。'); return data; }
export function parseMailSearch(output: string): GoogleMailSummary[] {
  if (output.trim() === '没有匹配的邮件。') return [];
  // The installed Python gws emits a four-line metadata block per result.
  const lines = output.trimEnd().split(/\r?\n/);
  if (!/^约 .+ 条匹配，显示前 \d+ 条：$/.test(lines.shift() ?? '')) fail('invalid_response', 'gws 邮件列表格式不受支持。');
  const messages: GoogleMailSummary[] = [];
  while (lines.length) {
    const [date, from, subject, id] = lines.splice(0, 4);
    const match = /^  id=([a-zA-Z0-9_-]{1,256})\s*(\(未读\))?\s*$/.exec(id ?? '');
    if (!date?.startsWith('- ') || !from?.startsWith('  发件: ') || !subject?.startsWith('  主题: ') || !match) fail('invalid_response', 'gws 邮件列表格式不受支持；未显示不完整内容。');
    messages.push({ id: match[1], date: date.slice(2, 100), from: from.slice(6, 1000), subject: subject.slice(6, 2000), unread: Boolean(match[2]) });
  }
  return messages;
}
export class GoogleWorkspaceService {
  constructor(private readonly runner: GwsRunner = runGws, private readonly now: () => number = Date.now) {}
  private async result<T>(action: () => Promise<T>): Promise<GoogleWorkspaceResult<T>> {
    try { return { ok: true, data: await action(), checkedAt: this.now() }; }
    catch (error) { const safe = error instanceof GwsError ? error : new GwsError('service_error', 'gws 查询失败，未取得有效的服务回执。'); return { ok: false, error: { code: safe.code, message: safe.message, ...(safe.nextStep ? { nextStep: safe.nextStep } : {}) }, checkedAt: this.now() }; }
  }
  private async run(args: string[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) fail('cancelled', '查询已取消。');
    const result = await this.runner(args, signal);
    if (result.code !== 0) commandError(result, signal);
    return result.stdout;
  }
  async status(signal?: AbortSignal): Promise<GoogleWorkspaceResult<GoogleWorkspaceStatus>> {
    return this.result(async () => {
      const help = await this.run(['--help'], signal);
      if (!/\bcal\b/.test(help) || !/\bgmail\b/.test(help)) fail('unsupported_cli', '此 gws 不支持当前邮箱和日历命令。');
      const from = new Intl.DateTimeFormat('en-CA', { timeZone: GWS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now());
      // Probe only the two requested services; unlike gws status, never scan all APIs.
      const mail = await this.result(async () => { jsonArray(await this.run(['gmail', 'search', '--limit', '1', '--json', '--', 'in:anywhere'], signal)); });
      const calendar = await this.listEvents({ from, days: 1 }, signal);
      const access = (value: GoogleWorkspaceResult<unknown>): GoogleWorkspaceAccess => value.ok ? { state: 'ready', message: '只读查询已验证（仅此时刻）' } : { state: value.error.code === 'auth_required' ? 'auth_required' : 'error', message: `${value.error.message}${value.error.nextStep ? ` ${value.error.nextStep}` : ''}` };
      return { cliAvailable: true, gmail: access(mail), calendar: access(calendar), checkedAt: this.now() };
    });
  }
  async searchMail(request: { query: string; limit?: number }, signal?: AbortSignal): Promise<GoogleWorkspaceResult<{ messages: GoogleMailSummary[]; limited: boolean }>> {
    return this.result(async () => {
      const req = requestObject(request), query = validText(req.query, '搜索条件', 1000), limit = integer(req.limit ?? 10, 1, 20);
      const messages = parseMailSearch(await this.run(['gmail', 'search', '--limit', String(limit), '--', query], signal));
      if (messages.length > limit) fail('invalid_response', 'gws 返回的邮件数量超过查询上限。');
      return { messages, limited: messages.length >= limit };
    });
  }
  async readMail(request: { id: string }, signal?: AbortSignal): Promise<GoogleWorkspaceResult<{ id: string; text: string; truncated: boolean }>> {
    return this.result(async () => {
      const id = validText(requestObject(request).id, '邮件 ID', 256);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('invalid_request', '邮件 ID 格式不正确。');
      const output = await this.run(['gmail', 'read', '--', id], signal);
      if (!output.startsWith('发件:') || !output.includes('\n主题:') || !output.includes('\n' + '-'.repeat(40) + '\n')) fail('invalid_response', 'gws 邮件正文格式不受支持。');
      const body = output.split('\n' + '-'.repeat(40) + '\n').slice(1).join('\n' + '-'.repeat(40) + '\n').replace(/\r?\n$/, '');
      return { id, text: output.slice(0, 16_000), truncated: [...body].length >= 4000 || output.length > 16_000 };
    });
  }
  async listEvents(request: { from: string; days: number; calendar?: string }, signal?: AbortSignal): Promise<GoogleWorkspaceResult<{ events: GoogleCalendarEvent[]; limited: boolean; timeZone: string }>> {
    return this.result(async () => {
      const req = requestObject(request), from = validText(req.from, '起始日期', 10), days = integer(req.days, 1, 31), calendar = validText(req.calendar ?? 'primary', '日历', 320);
      if (!validDate(from)) fail('invalid_request', '起始日期必须是有效的 YYYY-MM-DD 日期。');
      const rows = jsonArray(await this.run(['cal', 'agenda', '--from', from, '--days', String(days), '--calendar', calendar, '--json'], signal));
      if (rows.length > 100) fail('invalid_response', 'gws 返回的日程数量超过适配器上限。');
      const events = rows.map(value => {
        const item = object(value), start = object(item.start), end = object(item.end), allDay = typeof start.date === 'string';
        const startValue = text(allDay ? start.date : start.dateTime, 100), endValue = text(allDay ? end.date : end.dateTime, 100);
        const timedShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
        const validTimes = allDay
          ? validDate(startValue) && validDate(endValue) && !start.dateTime && !end.dateTime
          : timedShape.test(startValue) && timedShape.test(endValue) && !start.date && !end.date && validDate(startValue.slice(0, 10)) && validDate(endValue.slice(0, 10));
        if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || !validTimes || !(Date.parse(endValue) > Date.parse(startValue))) fail('invalid_response', 'gws 返回的日程缺少有效时间或 ID。');
        return { id: text(item.id, 256), title: text(item.summary, 2000) || '(无标题)', start: startValue, end: endValue, allDay,
          location: text(item.location, 2000) || undefined, description: text(item.description, 8000) || undefined,
          htmlLink: typeof item.htmlLink === 'string' && /^https:\/\/(calendar\.google\.com|www\.google\.com)\//.test(item.htmlLink) ? item.htmlLink : undefined };
      });
      return { events, limited: rows.length >= 100, timeZone: GWS_TIME_ZONE };
    });
  }
}
export const googleWorkspaceService = new GoogleWorkspaceService();
