import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CALENDAR = 'primary';
const STATE_FILE = 'calendar-sync.json';
export function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期必须为 YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) throw new Error('日期无效');
  return value;
}
export function addDays(value, days) {
  dateKey(value);
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
export function normalizeEvent(event) {
  return { id: event.id, summary: event.summary || '(无标题)',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay: Boolean(event.start?.date), location: event.location || '', meet: event.hangoutLink || null,
    htmlLink: event.htmlLink || null, recurring: Boolean(event.recurringEventId || event.recurrence),
    recurrence: event.recurrence || null, recurringEventId: event.recurringEventId || null,
    updated: event.updated || null, status: event.status || 'confirmed' };
}
export async function listPages(request, params, signal) {
  const events = [], seen = new Set();
  let pageToken, syncToken;
  do {
    signal?.throwIfAborted();
    const page = await request({ ...params, ...(pageToken ? { pageToken } : {}) });
    if (!page || typeof page !== 'object' || page.error || page.items !== undefined && !Array.isArray(page.items)) throw new Error('Google 日历返回无效数据');
    for (const event of page.items || []) {
      if (!event || typeof event.id !== 'string') throw new Error('Google 日历事件缺少 ID');
      events.push(event);
    }
    pageToken = page.nextPageToken;
    if (pageToken !== undefined && typeof pageToken !== 'string') throw new Error('Google 分页 token 无效');
    if (pageToken && seen.has(pageToken)) throw new Error('Google 日历分页重复，保留上次完整快照');
    if (pageToken) seen.add(pageToken);
    else syncToken = page.nextSyncToken;
  } while (pageToken);
  return { events, syncToken, pages: seen.size + 1 };
}
export async function synchronize(request, previous, { forceFull = false, signal } = {}) {
  const base = { calendarId: CALENDAR, singleEvents: false, showDeleted: true, maxResults: 2500 };
  const incremental = !forceFull && previous?.calendarId === CALENDAR && typeof previous.syncToken === 'string' && Array.isArray(previous.items);
  let mode = incremental ? 'incremental' : 'full', result;
  try { result = await listPages(request, { ...base, ...(incremental ? { syncToken: previous.syncToken } : {}) }, signal); }
  catch (error) {
    if (!incremental || Number(error.status ?? error.code) !== 410) throw error;
    mode = 'full-after-expiry';
    result = await listPages(request, base, signal);
  }
  if (typeof result.syncToken !== 'string' || !result.syncToken) throw new Error('完整分页未返回同步 token，保留旧快照');
  const items = new Map(mode === 'incremental' ? previous.items.map(item => [item.id, item]) : []);
  let removed = 0;
  for (const event of result.events) {
    if (event.status === 'cancelled') { items.delete(event.id); removed++; }
    else items.set(event.id, event);
  }
  signal?.throwIfAborted();
  const lastSuccessAt = new Date().toISOString();
  return { calendar: { calendarId: CALENDAR, singleEvents: false, syncToken: result.syncToken, items: [...items.values()], lastSuccessAt },
    events: [...items.values()].map(normalizeEvent),
    report: { scope: 'all', mode, pages: result.pages, fetched: result.events.length, removed, eventCount: items.size, lastSuccessAt } };
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 1), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function readSnapshot(sourcePath, dataPath) {
  const stored = readJson(path.join(dataPath, STATE_FILE), null);
  const snapshot = stored?.snapshot ?? readJson(path.join(sourcePath, 'data.json'), { events: [], tasks: [], tasklists: [], notes: [] });
  const error = readJson(path.join(dataPath, 'calendar-last-error.json'), null);
  return { ...snapshot, calendarSync: { ...snapshot.calendarSync, ...(error ? { error } : {}) } };
}
export async function syncSnapshot({ sourcePath, dataPath, request, forceFull, signal }) {
  fs.mkdirSync(dataPath, { recursive: true });
  const lockFile = path.join(dataPath, 'calendar-sync.lock');
  let lock;
  try { lock = fs.openSync(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(lockFile, null);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1) throw new Error('同步锁格式无效，请保留文件检查');
    try { process.kill(owner.pid, 0); throw Object.assign(new Error('已有日历同步正在执行'), { code: 'SYNC_BUSY' }); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(lockFile);
    lock = fs.openSync(lockFile, 'wx', 0o600);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  try {
    const envelope = readJson(path.join(dataPath, STATE_FILE), null);
    const previousSnapshot = envelope?.snapshot ?? readSnapshot(sourcePath, dataPath);
    const result = await synchronize(request, envelope?.calendar, { forceFull, signal });
    const dates = result.events.flatMap(event => [event.start, event.end]).filter(Boolean).map(date => date.slice(0, 10)).sort();
    const snapshot = { ...previousSnapshot, generatedAt: result.report.lastSuccessAt,
      range: dates.length ? { from: dates[0], to: dates.at(-1) } : null,
      events: result.events, calendarSync: result.report };
    signal?.throwIfAborted();
    // Calendar data and its token are one atomic commit. A failed page never
    // advances the token or clears the previous snapshot.
    atomic(path.join(dataPath, STATE_FILE), { calendar: result.calendar, snapshot });
    atomic(path.join(sourcePath, 'data.json'), snapshot);
    fs.rmSync(path.join(dataPath, 'calendar-last-error.json'), { force: true });
    return { snapshot, report: result.report };
  } catch (error) {
    atomic(path.join(dataPath, 'calendar-last-error.json'), { at: new Date().toISOString(), code: String(error.code ?? error.status ?? 'SYNC_FAILED'), message: '日历同步失败，已保留上次完整快照；请检查登录、网络或后台日志。' });
    throw error;
  } finally { fs.closeSync(lock); fs.rmSync(lockFile, { force: true }); }
}
export async function viewEvents(request, snapshot, from, to, signal) {
  dateKey(from); dateKey(to);
  if (from > to || to > addDays(from, 41)) throw new Error('显示窗口须为 1 至 42 天');
  if (!(snapshot.events || []).some(event => event.recurrence || event.recurringEventId)) return snapshot.events || [];
  const page = await listPages(request, { calendarId: CALENDAR, singleEvents: true, showDeleted: false,
    timeMin: `${from}T00:00:00+08:00`, timeMax: `${addDays(to, 1)}T00:00:00+08:00`, orderBy: 'startTime', maxResults: 2500 }, signal);
  return page.events.filter(event => event.status !== 'cancelled').map(normalizeEvent);
}
export async function gwsJson(exec, params) {
  const result = await exec('gws', { args: ['calendar', 'events', 'list', '--params', JSON.stringify(params)], timeoutMs: 45_000 });
  const text = (result.stdout || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Object.assign(new Error('gws 未返回有效 JSON；已保留上次完整快照'), { code: 'GWS_INVALID_JSON' }); }
  if (result.exitCode !== 0 || parsed.error) {
    throw Object.assign(new Error('gws 日历查询失败'), { status: Number(parsed.error?.code ?? parsed.error?.status), code: parsed.error?.code ?? 'GWS_FAILED' });
  }
  return parsed;
}
