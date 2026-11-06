#!/usr/bin/env node
/**
 * 缓存前缀巡检（T01–T18）可复跑审计脚本 —— 只读日志，无网络访问、无凭据。
 *
 * 输入：`~/.mybuddy/logs/cache-requests-<YYYYMMDD>*.log`，每行形如
 *        `2026-11-05 16:43:19.306 INFO [cache-trace] {"version":1,...}`
 *      事件类型：request（stage=provider/http）、result、http-result，另有
 *      first-response / started / execution（本脚本只做计数，不参与判定）。
 *      判定只用 request / result / http-result 三类。
 *
 * 口径来自《缓存前缀异常测试_复核报告_20261106.md》第 131–169 行"三处规则改动"：
 *   1. 三类事件解析：request 按 (epoch, request, stage) 入表；result 取最后一条
 *      非 null hitRate；http-result 只取 status 判传输异常，不进命中率。
 *   2. pick(request)：http 记录存在且 items 非空 → http；否则 provider items
 *      非空 → provider；否则第一条。http 存在但 items 为空必须回退 provider。
 *   3. 前置过滤：request 缺 boundary 单独计数告警；result 最后一条 hitRate=null
 *      且无 usage 跳过；usage.input=0 的空记录排除；http-result status != 200
 *      或无 status 跳过并单独统计。
 *   4. T04 抖动：同 session 相邻两条 prefix=false 且 sharedItems=0，且
 *      delta(a) = -delta(b)、delta != 0 → 判 flapping，两边都进报告。
 *   5. T05 阈值：不用 hitRate<0.5；改用 prefix=false 且 sharedItems=0 且
 *      items[0].bytes 变化 != 0，按 items[0].role 分 developer/user 统计，
 *      hitRate 只用于排序与分档。
 *   6. T06 排除：op=prompt 且 (inputCount=1 或 items[0].role=user) → 排除；
 *      不用 fields 缺 model/tools 判。
 *   7. T10 取数：stage=http 优先，缺失或 items 为空时回退 provider。
 *   8. T18 判据：同 session 内 items[0].bytes / items[0].hash /
 *      fields.prompt_cache_key / affinityHash / endpointHash 全同而 cacheRead
 *      归零，排除 usage.input=0 后统计。
 *
 * 用法：
 *   node scripts/cache-prefix-audit.mjs                     # 全量复跑，写默认 facts.json
 *   node scripts/cache-prefix-audit.mjs --date 2026-11-05   # 只跑某天
 *   node scripts/cache-prefix-audit.mjs --cutoff 2026-11-06T09:34:32.023+08:00
 *   node scripts/cache-prefix-audit.mjs --json out/facts.json --selfcheck
 *   node scripts/cache-prefix-audit.mjs --dir /path/to/logs --mcp-json /path/to/mcp.json
 *
 * 退出码：0 全通过；1 --selfcheck 有硬失败；2 用法/输入错误。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DEFAULT_JSON = join(REPO_ROOT, 'artifacts', 'cache-investigation', 'prefix-audit-20261106', 'facts.json');
const DEFAULT_DIR = join(homedir(), '.mybuddy', 'logs');
const DEFAULT_MCP = join(homedir(), '.mybuddy', 'plugins', 'mcp', 'mcp.json');
const FILE_RE = /^cache-requests-(\d{8})(?:-(\d+))?\.log$/;
const TRACE_MARK = '[cache-trace] ';

// 报告快照时点：复核报告写于 11-06 09:34 左右，此后日志仍在追加。
// 用该 cutoff 可精确复现报告里的 "11-06 742/746 request 无 boundary"。
const REPORT_SNAPSHOT_CUTOFF = '2026-11-06T09:34:32.023+08:00';
const REPORT_SNAPSHOT_MS = Date.parse(REPORT_SNAPSHOT_CUTOFF);

// 在"实时全量"运行里再切一刀报告快照，便于同一次输出同时给出实时值与报告值。
// 注意：已用 --cutoff 读取时不再计算（此时事件已被裁掉，主快照即为该 cutoff 口径）。
function snapshotAtCutoff(loaded, cutoffMs) {
  if (!Number.isFinite(cutoffMs)) return null;
  const byDate = {};
  for (const row of loaded.requests) {
    if (row._at > cutoffMs) continue;
    const date = row._date;
    if (!byDate[date]) byDate[date] = { requestRows: 0, unique: new Set(), withBoundary: 0 };
    byDate[date].requestRows++;
    byDate[date].unique.add(row.request);
    if (isObj(row.boundary)) byDate[date].withBoundary++;
  }
  const out = {};
  for (const [date, item] of Object.entries(byDate)) {
    out[date] = {
      requestRows: item.requestRows,
      uniqueRequests: item.unique.size,
      requestRowsWithBoundary: item.withBoundary,
      requestRowsMissingBoundary: item.requestRows - item.withBoundary,
      uniqueRequestsMissingBoundary: item.unique.size - new Set(loaded.requests.filter(r => r._date === date && r._at <= cutoffMs && isObj(r.boundary)).map(r => r.request)).size,
    };
  }
  return out;
}

const USAGE = [
  '用法: node scripts/cache-prefix-audit.mjs [选项]',
  '',
  '  --dir <目录>       日志目录（默认 ~/.mybuddy/logs）',
  '  --json <路径>      facts.json 输出路径（默认 artifacts/cache-investigation/prefix-audit-20261106/facts.json）',
  '  --date <日期>      只审计指定日期，逗号分隔，如 2026-11-05,2026-11-06',
  '  --cutoff <ISO>     只保留 at <= cutoff 的事件（用于复现报告快照；例 ' + REPORT_SNAPSHOT_CUTOFF + '）',
  '  --mcp-json <路径>  只读解析 mcp.json 做 T15–T17（默认 ~/.mybuddy/plugins/mcp/mcp.json）',
  '  --selfcheck        逐条核对验收数字，硬失败时退出码 1',
  '  --quiet            只打印自检表',
  '  -h, --help         显示本帮助',
].join('\n');

function parseArgs(argv) {
  const opts = {
    dir: DEFAULT_DIR,
    json: DEFAULT_JSON,
    dates: null,
    cutoff: null,
    mcpJson: DEFAULT_MCP,
    selfcheck: false,
    quiet: false,
  };
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const need = () => {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${key} 需要一个参数值`);
      return value;
    };
    if (key === '--dir') opts.dir = resolve(need());
    else if (key === '--json') opts.json = resolve(need());
    else if (key === '--date') opts.dates = need().split(',').map(s => s.trim()).filter(Boolean);
    else if (key === '--cutoff') {
      const raw = need();
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) throw new Error(`--cutoff 无法解析: ${raw}`);
      opts.cutoff = { raw, ms };
    } else if (key === '--mcp-json') opts.mcpJson = resolve(need());
    else if (key === '--selfcheck') opts.selfcheck = true;
    else if (key === '--quiet') opts.quiet = true;
    else if (key === '-h' || key === '--help') { console.log(USAGE); process.exit(0); }
    else throw new Error(`未知参数: ${key}\n\n${USAGE}`);
  }
  return opts;
}

const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasItems = row => Array.isArray(row?.items) && row.items.length > 0;
const item0 = row => (hasItems(row) ? row.items[0] : null);
const pct = (value, digits = 3) => (typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'null');
const pct3 = value => (typeof value === 'number' && Number.isFinite(value) ? Number((value * 100).toFixed(3)) : null);
const hhmmss = text => (typeof text === 'string' && text.length >= 19 ? text.slice(11, 19) : String(text ?? ''));
const deltaMs = (a, b) => (typeof a === 'number' && typeof b === 'number' ? b - a : null);

// ---------------------------------------------------------------------------
// 1. 读取与解析
// ---------------------------------------------------------------------------

function readEvents(opts) {
  if (!existsSync(opts.dir)) throw new Error(`日志目录不存在: ${opts.dir}`);
  // --date 同时接受 2026-11-05 与 20261105
  const wantedDates = opts.dates ? opts.dates.map(d => d.replace(/-/g, '')) : null;
  const names = readdirSync(opts.dir)
    .filter(name => FILE_RE.test(name))
    .filter(name => !wantedDates || wantedDates.includes(FILE_RE.exec(name)[1]))
    .sort();
  if (!names.length) throw new Error(`没有匹配的 cache-requests-*.log: ${opts.dir}`);

  const files = [];
  const requests = [];
  const results = [];
  const httpResults = [];
  const otherCounts = new Map();
  let parseFailures = 0;
  let cutoffDropped = 0;

  for (const name of names) {
    const path = join(opts.dir, name);
    const stat = statSync(path);
    const raw = readFileSync(path, 'utf8');
    const fileStat = {
      name,
      bytes: stat.size,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      requestRows: 0,
      resultRows: 0,
      httpResultRows: 0,
      otherEventRows: 0,
      parseFailures: 0,
    };
    let lineNo = 0;
    for (const line of raw.split('\n')) {
      lineNo++;
      const mark = line.indexOf(TRACE_MARK);
      if (mark < 0) continue;
      const jsonStart = line.indexOf('{"version"', mark);
      if (jsonStart < 0) { parseFailures++; fileStat.parseFailures++; continue; }
      let obj;
      try {
        obj = JSON.parse(line.slice(jsonStart));
      } catch {
        parseFailures++;
        fileStat.parseFailures++;
        continue;
      }
      const meta = {
        _file: name,
        _line: lineNo,
        _ts: line.slice(0, 23),
        _date: line.slice(0, 10),
        _at: typeof obj.at === 'number' ? obj.at : Date.parse(line.slice(0, 23)),
      };
      if (opts.cutoff && meta._at > opts.cutoff.ms) { cutoffDropped++; continue; }
      const row = Object.assign({}, obj, meta);
      if (obj.event === 'request') { requests.push(row); fileStat.requestRows++; }
      else if (obj.event === 'result') { results.push(row); fileStat.resultRows++; }
      else if (obj.event === 'http-result') { httpResults.push(row); fileStat.httpResultRows++; }
      else { otherCounts.set(obj.event ?? '(none)', (otherCounts.get(obj.event ?? '(none)') ?? 0) + 1); fileStat.otherEventRows++; }
    }
    files.push(fileStat);
  }

  return { files, requests, results, httpResults, otherCounts: Object.fromEntries(otherCounts), parseFailures, cutoffDropped };
}

// ---------------------------------------------------------------------------
// 2. 事件索引：request 按 (epoch, request, stage) 入表；result 取最后非 null 命中率
// ---------------------------------------------------------------------------

function indexEvents(loaded) {
  const rowKey = row => `${row.epoch}|${row.request}|${row.stage}|${row.attempt ?? 0}`;
  const seen = new Set();
  const rows = [];
  const duplicateRows = [];
  for (const row of loaded.requests) {
    const key = rowKey(row);
    if (seen.has(key)) { duplicateRows.push(key); continue; }
    seen.add(key);
    rows.push(row);
  }

  const byRequest = new Map();
  for (const row of rows) {
    if (!byRequest.has(row.request)) byRequest.set(row.request, []);
    byRequest.get(row.request).push(row);
  }

  const resultsById = new Map();
  for (const row of loaded.results) {
    if (!resultsById.has(row.request)) resultsById.set(row.request, []);
    resultsById.get(row.request).push(row);
  }
  for (const list of resultsById.values()) list.sort((a, b) => a._at - b._at);

  const httpResultsById = new Map();
  for (const row of loaded.httpResults) {
    if (!httpResultsById.has(row.request)) httpResultsById.set(row.request, []);
    httpResultsById.get(row.request).push(row);
  }
  for (const list of httpResultsById.values()) list.sort((a, b) => a._at - b._at);

  return { rows, byRequest, resultsById, httpResultsById, duplicateRows };
}

// pick(request)：http 记录存在且 items 非空 → http；否则 provider items 非空 →
// provider；否则第一条。返回 { row, via }，via 记录取数来源便于核对 T10。
function pickRow(rows) {
  const httpRows = rows.filter(r => r.stage === 'http');
  const providerRows = rows.filter(r => r.stage === 'provider');
  const httpWithItems = httpRows.filter(hasItems);
  if (httpWithItems.length) return { row: httpWithItems.at(-1), via: 'http' };
  const providerWithItems = providerRows.filter(hasItems);
  if (providerWithItems.length) return { row: providerWithItems.at(-1), via: httpRows.length ? 'http-empty-items->provider' : 'provider' };
  const first = [...rows].sort((a, b) => a._at - b._at)[0];
  return { row: first, via: 'first-row' };
}

function buildViews(index) {
  const views = new Map();
  for (const [id, rawRows] of index.byRequest) {
    const rows = [...rawRows].sort((a, b) => a._at - b._at || (a.sequence ?? 0) - (b.sequence ?? 0));
    const pick = pickRow(rows);
    const boundary = rows.find(r => isObj(r.boundary))?.boundary ?? null;
    const previousRow = (pick.row.previous ? pick.row : rows.find(r => r.previous)) ?? null;
    const previous = previousRow?.previous ?? null;
    const firstDifference = previous?.firstDifference ?? null;
    const delta = firstDifference && firstDifference.index === 0 && isObj(firstDifference.old) && isObj(firstDifference.current)
      ? firstDifference.current.bytes - firstDifference.old.bytes
      : null;

    const resultRows = index.resultsById.get(id) ?? [];
    const lastResult = resultRows.at(-1) ?? null;
    const hitResult = [...resultRows].reverse().find(r => typeof r.hitRate === 'number') ?? null;
    const usage = lastResult?.usage ?? null;
    const httpResultRows = index.httpResultsById.get(id) ?? [];
    const lastHttpStatus = httpResultRows.at(-1)?.status;
    const httpRows = rows.filter(r => r.stage === 'http');
    const stages = [...new Set(rows.map(r => r.stage))].sort();
    const flags = [];
    if (!boundary) flags.push('missing-boundary');
    if (httpRows.length && !httpRows.some(hasItems)) flags.push('http-items-empty');
    if (!httpRows.length) flags.push('http-observation-missing');
    if (lastResult && usage && usage.input === 0) flags.push('empty-usage');
    if (!hitResult) flags.push('hitrate-null');
    if (httpResultRows.length && lastHttpStatus !== 200) flags.push('transport-anomaly');
    if (hitResult?.outcome && hitResult.outcome !== 'stop') flags.push(`outcome-${hitResult.outcome}`);

    const i0 = item0(pick.row);
    const view = {
      id,
      date: rows[0]._date,
      ts: rows[0]._ts,
      at: rows[0]._at,
      epoch: rows[0].epoch,
      sessionHash: rows[0].sessionHash,
      parentSessionHash: rows[0].parentSessionHash ?? null,
      source: rows[0].source ?? 'main',
      stageRows: rows.map(r => ({ stage: r.stage, attempt: r.attempt ?? 0, items: Array.isArray(r.items) ? r.items.length : 0, at: r._at, ts: r._ts })),
      stages,
      pickedStage: pick.row.stage,
      pickVia: pick.via,
      op: boundary?.operation ?? null,
      boundary,
      inputCount: pick.row.inputCount ?? null,
      inputCounts: [...new Set(rows.map(r => r.inputCount).filter(v => typeof v === 'number'))],
      items0: i0 ? { bytes: i0.bytes ?? null, hash: i0.hash ?? null, role: i0.role ?? null, kind: i0.kind ?? null } : null,
      promptCacheKey: pick.row.fields?.prompt_cache_key ?? null,
      affinityHash: pick.row.affinityHash ?? null,
      endpointHash: pick.row.endpointHash ?? null,
      previous: previous
        ? {
            request: previous.request ?? null,
            attempt: previous.attempt ?? null,
            inputCount: previous.inputCount ?? null,
            prefix: previous.prefix ?? null,
            sharedItems: previous.sharedItems ?? null,
            changedFields: previous.changedFields ?? [],
            firstDifferenceIndex: firstDifference?.index ?? null,
            delta,
            oldBytes: firstDifference?.old?.bytes ?? null,
            currentBytes: firstDifference?.current?.bytes ?? null,
            changedItemFields: firstDifference?.changedItemFields ?? null,
          }
        : null,
      hitRate: hitResult?.hitRate ?? null,
      hitRatePct: pct3(hitResult?.hitRate ?? null),
      outcome: hitResult?.outcome ?? null,
      usage: usage ? { input: usage.input ?? null, output: usage.output ?? null, cacheRead: usage.cacheRead ?? null, cacheWrite: usage.cacheWrite ?? null } : null,
      lastResultAt: lastResult?._at ?? null,
      lastResultTs: lastResult?._ts ?? null,
      httpStatus: httpResultRows.length ? lastHttpStatus ?? null : null,
      httpResultCount: httpResultRows.length,
      flags,
    };
    views.set(id, view);
  }
  return views;
}

// ---------------------------------------------------------------------------
// 3. 聚合
// ---------------------------------------------------------------------------

function snapshotByDate(loaded) {
  const fileDates = loaded.files
    .map(f => FILE_RE.exec(f.name)?.[1])
    .filter(Boolean)
    .map(d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  const dates = [...new Set([
    ...fileDates,
    ...loaded.requests.map(r => r._date),
    ...loaded.results.map(r => r._date),
    ...loaded.httpResults.map(r => r._date),
  ])].sort();

  const byDate = {};
  for (const date of dates) {
    const reqRows = loaded.requests.filter(r => r._date === date);
    const resRows = loaded.results.filter(r => r._date === date);
    const httpResRows = loaded.httpResults.filter(r => r._date === date);
    const unique = new Set(reqRows.map(r => r.request));
    const withBoundary = reqRows.filter(r => isObj(r.boundary));
    const opCounts = {};
    for (const row of reqRows) {
      const key = row.boundary?.operation ?? '(missing-boundary)';
      opCounts[key] = (opCounts[key] ?? 0) + 1;
    }
    const stageCounts = {};
    for (const row of reqRows) stageCounts[row.stage] = (stageCounts[row.stage] ?? 0) + 1;
    const digits = date.replace(/-/g, '');
    const dateFiles = loaded.files.filter(f => f.name.includes(digits));
    // 按 epoch 聚合：boundary 从哪个进程 epoch 起消失，是 11-06 缺口的关键证据
    const epochStats = new Map();
    for (const row of reqRows) {
      const key = row.epoch ?? '(none)';
      if (!epochStats.has(key)) epochStats.set(key, { epoch: key, requestRows: 0, withBoundary: 0, firstAt: row._at, lastAt: row._at, unique: new Set() });
      const item = epochStats.get(key);
      item.requestRows++;
      item.unique.add(row.request);
      if (isObj(row.boundary)) item.withBoundary++;
      item.firstAt = Math.min(item.firstAt, row._at);
      item.lastAt = Math.max(item.lastAt, row._at);
    }
    const epochs = [...epochStats.values()]
      .map(e => ({
        epoch: e.epoch,
        requestRows: e.requestRows,
        uniqueRequests: e.unique.size,
        requestRowsWithBoundary: e.withBoundary,
        firstTs: new Date(e.firstAt).toISOString(),
        lastTs: new Date(e.lastAt).toISOString(),
      }))
      .sort((a, b) => a.firstTs.localeCompare(b.firstTs));
    byDate[date] = {
      files: dateFiles.map(f => f.name),
      bytes: dateFiles.reduce((sum, f) => sum + f.bytes, 0),
      epochs,
      requestRows: reqRows.length,
      uniqueRequests: unique.size,
      resultRows: resRows.length,
      httpResultRows: httpResRows.length,
      requestRowsWithBoundary: withBoundary.length,
      uniqueRequestsWithBoundary: new Set(withBoundary.map(r => r.request)).size,
      requestRowsMissingBoundary: reqRows.length - withBoundary.length,
      uniqueRequestsMissingBoundary: unique.size - new Set(withBoundary.map(r => r.request)).size,
      opCounts,
      stageCounts,
      httpRowsWithEmptyItems: reqRows.filter(r => r.stage === 'http' && !hasItems(r)).length,
      emptyUsageResults: resRows.filter(r => r.usage && r.usage.input === 0).length,
      nullHitRateResults: resRows.filter(r => r.hitRate === null || r.hitRate === undefined).length,
    };
  }
  const totals = {
    files: loaded.files.length,
    bytes: loaded.files.reduce((sum, f) => sum + f.bytes, 0),
    requestRows: loaded.requests.length,
    uniqueRequests: new Set(loaded.requests.map(r => r.request)).size,
    resultRows: loaded.results.length,
    httpResultRows: loaded.httpResults.length,
    requestRowsMissingBoundary: loaded.requests.filter(r => !isObj(r.boundary)).length,
    parseFailures: loaded.parseFailures,
    cutoffDropped: loaded.cutoffDropped,
  };
  return { byDate, totals, dates };
}

// items[0].bytes 的直接变化：用 pick 行与 previous.request 的 pick 行对比。
// firstDifference 只有在 index=0 时才描述 items[0]；T07 这类 index=1 的变化要靠本函数。
function annotateItems0Delta(views) {
  for (const view of views.values()) {
    const prevView = view.previous?.request ? views.get(view.previous.request) : null;
    view.previousItems0Bytes = prevView?.items0?.bytes ?? null;
    view.previousItems0Role = prevView?.items0?.role ?? null;
    view.items0Delta = view.items0?.bytes != null && prevView?.items0?.bytes != null
      ? view.items0.bytes - prevView.items0.bytes
      : null;
  }
}

// 断裂事件 = prefix=false 且 sharedItems=0；items[0] 变化由 firstDifference 给出。
// 行级（每个 stage 各一条），请求级去重后用于 T01/T03/T04。
function collectBreakRows(index, views) {
  const rows = [];
  const anomalies = [];
  for (const row of index.rows) {
    const previous = row.previous;
    if (!isObj(previous) || previous.prefix !== false || previous.sharedItems !== 0) continue;
    const fd = previous.firstDifference;
    if (!fd || fd.index !== 0 || !isObj(fd.old) || !isObj(fd.current)) {
      anomalies.push({ request: row.request, ts: row._ts, stage: row.stage, op: row.boundary?.operation ?? null, reason: 'firstDifference 缺失或 index!=0' });
      continue;
    }
    const delta = fd.current.bytes - fd.old.bytes;
    const view = views.get(row.request);
    rows.push({
      request: row.request,
      date: row._date,
      ts: row._ts,
      at: row._at,
      epoch: row.epoch,
      stage: row.stage,
      op: row.boundary?.operation ?? null,
      sessionHash: row.sessionHash,
      inputCount: row.inputCount ?? null,
      role0: item0(row)?.role ?? null,
      i0Bytes: item0(row)?.bytes ?? null,
      oldBytes: fd.old.bytes,
      currentBytes: fd.current.bytes,
      oldHash: fd.old.hash ?? null,
      currentHash: fd.current.hash ?? null,
      changedItemFields: fd.changedItemFields ?? null,
      delta,
      items0Delta: view?.items0Delta ?? null,
      previousItems0Bytes: view?.previousItems0Bytes ?? null,
      hitRate: null,
      hitRatePct: null,
      usage: null,
    });
  }
  return { rows, anomalies };
}

function collectRecovery(index, breakRows, views) {
  const successorIndex = new Map();
  for (const row of index.rows) {
    const prev = row.previous?.request;
    if (!prev) continue;
    const key = `${row.epoch}|${row.stage}|${prev}`;
    if (!successorIndex.has(key)) successorIndex.set(key, []);
    successorIndex.get(key).push(row);
  }
  for (const list of successorIndex.values()) list.sort((a, b) => a._at - b._at);

  const byEvent = new Map();
  for (const row of breakRows) {
    if (!byEvent.has(row.request)) byEvent.set(row.request, { row, stages: new Set() });
    byEvent.get(row.request).stages.add(row.stage);
  }

  const recovery = [];
  for (const [id, { row, stages }] of byEvent) {
    const found = [];
    for (const stage of stages) {
      const list = successorIndex.get(`${row.epoch}|${stage}|${id}`) ?? [];
      for (const candidate of list) {
        const key = `${candidate.request}|${candidate.stage}`;
        if (found.some(f => f.key === key)) continue;
        found.push({
          key,
          request: candidate.request,
          ts: candidate._ts,
          at: candidate._at,
          stage: candidate.stage,
          op: candidate.boundary?.operation ?? null,
          sharedItems: candidate.previous?.sharedItems ?? null,
          prefix: candidate.previous?.prefix ?? null,
        });
      }
    }
    found.sort((a, b) => a.at - b.at);
    const next = found[0] ?? null;
    recovery.push({
      event: id,
      eventTs: row.ts,
      sessionHash: row.sessionHash,
      op: row.op,
      delta: row.delta,
      successor: next ? { request: next.request, ts: next.ts, stage: next.stage, op: next.op, gapMs: deltaMs(row.at, next.at) } : null,
      successorHitRate: next ? (views.get(next.request)?.hitRatePct ?? null) : null,
      successorHitRateRaw: next ? (views.get(next.request)?.hitRate ?? null) : null,
    });
  }
  return recovery;
}

// T04：同一 session 内"相邻两条"断裂事件的 ±delta 镜像。
function collectFlapping(breakRows, views) {
  const byRequest = new Map();
  for (const row of breakRows) if (!byRequest.has(row.request)) byRequest.set(row.request, row);
  const unique = [...byRequest.values()].sort((a, b) => a.at - b.at);
  const bySession = new Map();
  for (const row of unique) {
    const key = `${row.date}|${row.sessionHash}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }
  const pairs = [];
  for (const [key, list] of bySession) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (a.delta === 0 || b.delta === 0) continue;
      if (a.delta !== -b.delta) continue;
      pairs.push({
        session: key,
        a: { request: a.request, ts: a.ts, delta: a.delta, role: a.role0, hitRatePct: views.get(a.request)?.hitRatePct ?? null, op: a.op },
        b: { request: b.request, ts: b.ts, delta: b.delta, role: b.role0, hitRatePct: views.get(b.request)?.hitRatePct ?? null, op: b.op },
        gapMs: deltaMs(a.at, b.at),
      });
    }
  }
  return pairs;
}

function t06Excluded(row) {
  // op=prompt 且 (inputCount=1 或 items[0].role=user) → 排除
  return row.op === 'prompt' && (row.inputCount === 1 || row.role0 === 'user');
}

function buildChecks(ctx) {
  const { views, index, loaded, snapshot, breakRows, breakAnomalies, recovery, flapping, mcp } = ctx;
  const dates = snapshot.dates;
  const checks = {};

  // ---- 每个日期先算一遍基础集合 ----
  const byDate = {};
  for (const date of dates) {
    const dateViews = [...views.values()].filter(v => v.date === date);
    const breakEvents = new Map();
    for (const row of breakRows.filter(r => r.date === date)) {
      const view = views.get(row.request);
      if (!view) continue;
      if (!breakEvents.has(row.request)) {
        breakEvents.set(row.request, { request: row.request, ts: view.ts, op: row.op, role: row.role0, delta: row.delta, hitRatePct: view.hitRatePct, hitRate: view.hitRate, inputCount: view.inputCount, i0Bytes: row.i0Bytes, oldBytes: row.oldBytes, stages: new Set(), forced: view.flags.includes('transport-anomaly') || view.flags.includes('empty-usage') });
      }
      breakEvents.get(row.request).stages.add(row.stage);
    }
    const breakList = [...breakEvents.values()].map(e => ({ ...e, stages: [...e.stages].sort() }));
    const dateRows = snapshot.byDate[date];
    const missingBoundary = dateRows.requestRowsMissingBoundary;
    const opUnjudgeable = missingBoundary > 0;
    const verdictNote = opUnjudgeable
      ? `不可判（无 boundary）：${date} 有 ${missingBoundary}/${dateRows.requestRows} 条 request 缺 boundary，任何按 op 过滤的口径都不能代表全量`
      : '可判';

    // T05：prefix=false & sh=0 & items[0].bytes 变化 != 0（用行级计数）
    const t05Rows = breakRows.filter(r => r.date === date && r.delta !== 0);
    const t05Uniq = new Map();
    for (const row of t05Rows) if (!t05Uniq.has(row.request)) t05Uniq.set(row.request, row);
    const t05Roles = { developer: 0, user: 0, other: 0 };
    for (const row of t05Uniq.values()) t05Roles[row.role0 && t05Roles[row.role0] !== undefined ? row.role0 : 'other']++;
    const t05Bands = { 'hitRate=0': 0, '0<hitRate<0.5': 0, '0.5<=hitRate<0.9': 0, 'hitRate>=0.9': 0, 'hitRate=null': 0 };
    for (const row of t05Uniq.values()) {
      const hr = views.get(row.request)?.hitRate ?? null;
      if (hr === null) t05Bands['hitRate=null']++;
      else if (hr === 0) t05Bands['hitRate=0']++;
      else if (hr < 0.5) t05Bands['0<hitRate<0.5']++;
      else if (hr < 0.9) t05Bands['0.5<=hitRate<0.9']++;
      else t05Bands['hitRate>=0.9']++;
    }
    const t05Events = [...t05Uniq.values()]
      .map(row => ({
        request: row.request,
        ts: row.ts,
        op: row.op,
        role: row.role0,
        delta: row.delta,
        items0Delta: row.items0Delta,
        i0: `${row.oldBytes}→${row.currentBytes}`,
        hitRatePct: views.get(row.request)?.hitRatePct ?? null,
        rows: t05Rows.filter(r => r.request === row.request).length,
      }))
      .sort((a, b) => (a.hitRatePct ?? 0) - (b.hitRatePct ?? 0));

    // T01：T05 去掉 T06 排除项后按 op=stream 取（o=stream 天然排除 prompt 族）
    const t01 = breakList.filter(e => e.op === 'stream');
    const t01Roles = { developer: 0, user: 0, other: 0 };
    for (const e of t01) t01Roles[e.role && t01Roles[e.role] !== undefined ? e.role : 'other']++;

    // T02：+175 签名（items[0].bytes 恰好 +175）
    const t02 = t01
      .filter(e => e.delta === 175)
      .map(e => ({ request: e.request, ts: e.ts, time: hhmmss(e.ts), i0: `${e.oldBytes}→${e.i0Bytes}`, delta: e.delta, hitRatePct: e.hitRatePct }));

    // 11-06 等无 boundary 日期：不受 op 过滤影响的旁证（仅统计，不构成通过）
    const unboundBreak = breakList.filter(e => e.op === null);

    // T06：prompt 族误报排除
    const promptRows = index.rows.filter(r => r._date === date && r.boundary?.operation === 'prompt');
    const t06Candidates = breakList.filter(e => e.op === 'prompt');
    const t06Dropped = t06Candidates.filter(e => t06Excluded({ op: e.op, inputCount: e.inputCount, role0: e.role }));
    const t06Kept = t06Candidates.filter(e => !t06Dropped.includes(e));
    const altToolsMissing = promptRows.filter(r => isObj(r.fields) && !('tools' in r.fields));

    // T07：prefix=false 且 sharedItems=1
    const t07Rows = index.rows.filter(r => r._date === date && r.previous && r.previous.prefix === false && r.previous.sharedItems === 1);
    const t07Uniq = new Map();
    for (const row of t07Rows) if (!t07Uniq.has(row.request)) t07Uniq.set(row.request, row);
    const t07Events = [...t07Uniq.values()].map(row => {
      const fd = row.previous.firstDifference;
      const view = views.get(row.request);
      return {
        request: row.request,
        ts: row._ts,
        op: row.boundary?.operation ?? null,
        inputCount: row.inputCount ?? null,
        i0: item0(row)?.bytes ?? null,
        previousI0: view?.previousItems0Bytes ?? null,
        i0Delta: view?.items0Delta ?? null,
        firstDifferenceIndex: fd?.index ?? null,
        deltaAtFirstDiff: fd && isObj(fd.old) && isObj(fd.current) ? fd.current.bytes - fd.old.bytes : null,
        changedItemFields: fd?.changedItemFields ?? null,
        hitRatePct: view?.hitRatePct ?? null,
      };
    });
    const t07AllPrompt = t07Events.every(e => e.op === 'prompt');
    const t07AllIc2 = t07Events.every(e => e.inputCount === 2);
    // items[0] 4133→4133（delta 恒 0），变化发生在 items[1]
    const t07AllDelta0 = t07Events.every(e => e.i0Delta === 0 && e.previousI0 === 4133 && e.firstDifferenceIndex === 1);

    // T08：首请求（previous 缺失）
    // 口径分歧点：按"行"数、按"任一行为首"的唯一 request、还是按 pick 行（真正链首）。
    const firstRows = index.rows.filter(r => r._date === date && !r.previous);
    const firstUnique = new Set(firstRows.map(r => r.request));
    const firstProviderRows = firstRows.filter(r => r.stage === 'provider' && (r.attempt ?? 0) === 0);
    const firstHttpRows = firstRows.filter(r => r.stage === 'http');
    const zeroHitUnique = [...firstUnique].filter(id => views.get(id)?.hitRate === 0).length;
    const zeroHitProviderFirst = new Set(firstProviderRows.map(r => r.request));
    const zeroHitAmongProviderFirst = [...zeroHitProviderFirst].filter(id => views.get(id)?.hitRate === 0).length;
    const pickFirstIds = [...views.values()].filter(v => v.date === date && !v.previous).map(v => v.id);
    const t08 = {
      rowsWithMissingPrevious: firstRows.length,
      uniqueAnyRowFirst: firstUnique.size,
      providerFirstRows: firstProviderRows.length,
      providerFirstUnique: zeroHitProviderFirst.size,
      httpFirstRows: firstHttpRows.length,
      pickFirstUnique: pickFirstIds.length,
      hitRateZeroUnique: zeroHitUnique,
      hitRateZeroAmongProviderFirst: zeroHitAmongProviderFirst,
      hitRateZeroAmongPickFirst: pickFirstIds.filter(id => views.get(id)?.hitRate === 0).length,
      hitRateNullAmongAnyRowFirst: [...firstUnique].filter(id => views.get(id)?.hitRate === null).length,
      nonNullHitRateAmongAnyRowFirst: firstUnique.size - [...firstUnique].filter(id => views.get(id)?.hitRate === null).length,
    };

    // T09：hitRate=null 的 result；无 items 的 request 行
    const nullResults = [];
    for (const [id, list] of index.resultsById) {
      const last = list.at(-1);
      if (last._date !== date) continue;
      if (typeof last.hitRate === 'number') continue;
      const httpResultRows = index.httpResultsById.get(id) ?? [];
      const statuses = httpResultRows.map(r => r.status ?? null);
      const anomaly = httpResultRows.length > 0 && (statuses.at(-1) ?? null) !== 200;
      nullResults.push({
        request: id,
        ts: last._ts,
        outcome: last.outcome ?? null,
        statuses,
        hasHttpResult: httpResultRows.length > 0,
        transportAnomaly: anomaly,
        usage: last.usage ?? null,
        reportedUsagePresent: last.reportedUsage !== undefined,
      });
    }
    const noItemsRows = index.rows.filter(r => r._date === date && !hasItems(r));
    const noItemsByStage = {};
    for (const row of noItemsRows) noItemsByStage[row.stage] = (noItemsByStage[row.stage] ?? 0) + 1;
    const noItemsUnique = new Set(noItemsRows.map(r => r.request));

    // T10：取数来源统计（pick）
    const pickStats = {};
    for (const view of dateViews) pickStats[view.pickVia] = (pickStats[view.pickVia] ?? 0) + 1;
    const httpEmptyFallback = [];
    for (const view of dateViews) {
      if (!view.flags.includes('http-items-empty')) continue;
      httpEmptyFallback.push({
        request: view.id,
        ts: view.ts,
        httpRows: view.stageRows.filter(r => r.stage === 'http').map(r => r.items),
        pickedStage: view.pickedStage,
        pickVia: view.pickVia,
        i0Bytes: view.items0?.bytes ?? null,
        ok: view.pickVia !== 'first-row' && view.items0?.bytes != null,
      });
    }

    byDate[date] = {
      date,
      requestRows: dateRows.requestRows,
      uniqueRequests: dateRows.uniqueRequests,
      missingBoundaryRows: dateRows.requestRowsMissingBoundary,
      missingBoundaryUnique: dateRows.uniqueRequestsMissingBoundary,
      opCounts: dateRows.opCounts,
      verdictNote,
      opUnjudgeable,
      T01: { verdict: opUnjudgeable ? '不可判（无 boundary）' : '可判', unique: t01.length, roles: t01Roles, events: t01.map(e => ({ request: e.request, ts: e.ts, op: e.op, role: e.role, delta: e.delta, i0: `${e.oldBytes}→${e.i0Bytes}`, hitRatePct: e.hitRatePct, stages: e.stages })) },
      T02: { verdict: opUnjudgeable ? '不可判（无 boundary）' : '可判', count: t02.length, events: t02, unboundSupplement: unboundBreak.map(e => ({ request: e.request, ts: e.ts, op: e.op, delta: e.delta, i0: `${e.oldBytes}→${e.i0Bytes}`, hitRatePct: e.hitRatePct })) },
      T05: { rows: t05Rows.length, unique: t05Uniq.size, roles: t05Roles, bands: t05Bands, events: t05Events },
      T06: {
        promptRows: promptRows.length,
        promptUnique: new Set(promptRows.map(r => r.request)).size,
        ic1Rows: promptRows.filter(r => r.inputCount === 1).length,
        ic1Unique: new Set(promptRows.filter(r => r.inputCount === 1).map(r => r.request)).size,
        i0UserRows: promptRows.filter(r => item0(r)?.role === 'user').length,
        i0UserUnique: new Set(promptRows.filter(r => item0(r)?.role === 'user').map(r => r.request)).size,
        altToolsMissingRows: altToolsMissing.length,
        altToolsMissingUnique: new Set(altToolsMissing.map(r => r.request)).size,
        candidates: t06Candidates.map(e => ({ request: e.request, ts: e.ts, op: e.op, role: e.role, inputCount: e.inputCount, delta: e.delta })),
        excluded: t06Dropped.map(e => e.request),
        kept: t06Kept.map(e => e.request),
        // T05 的 9 条减去 T06 的 2 条误报 = 7 条，全部是 op=stream
        keptAfterExclusion: breakList.filter(e => !t06Dropped.includes(e)).map(e => ({ request: e.request, op: e.op, role: e.role, delta: e.delta })),
      },
      T07: { rows: t07Rows.length, unique: t07Uniq.size, allPrompt: t07AllPrompt, allIc2: t07AllIc2, allDeltaZeroAtFirstDiff: t07AllDelta0, events: t07Events },
      T08: {
        ...t08,
        // 兼容旧字段名
        rows: t08.rowsWithMissingPrevious,
        unique: t08.uniqueAnyRowFirst,
        providerRows: t08.providerFirstRows,
        providerUnique: t08.providerFirstUnique,
        httpRows: t08.httpFirstRows,
        // 逐请求的首请求行在 facts.requests 里（previous=null 且 pick 行为链首）
      },
      T09: {
        nullHitRateResults: nullResults.length,
        transportAnomalies: nullResults.filter(r => r.transportAnomaly).length,
        noHttpResult: nullResults.filter(r => !r.hasHttpResult).length,
        status200ButNoUsage: nullResults.filter(r => r.hasHttpResult && !r.transportAnomaly).length,
        emptyUsageResults: dateRows.emptyUsageResults,
        noItemsRows: noItemsRows.length,
        noItemsByStage,
        noItemsUnique: noItemsUnique.size,
        nullResults,
        noItemsRequests: [...noItemsUnique],
      },
      T10: {
        pickStats,
        httpEmptyFallback,
        httpEmptyFallbackOk: httpEmptyFallback.filter(x => x.ok).length,
        httpEmptyFallbackFailed: httpEmptyFallback.filter(x => !x.ok).map(x => x.request),
        baselineStages: Object.fromEntries(t01.map(e => [e.request, e.stages])),
      },
    };
  }

  checks.byDate = byDate;

  // ---- T03 恢复链（跨日期，仅 stream 断裂事件的后续命中率） ----
  const recoveryByEvent = new Map(recovery.map(r => [r.event, r]));
  const firstBreakRow = new Map();
  for (const row of breakRows) if (!firstBreakRow.has(row.request)) firstBreakRow.set(row.request, row);
  checks.T03 = {
    recovery: breakRows.length
      ? [...firstBreakRow.values()]
          .sort((a, b) => a.at - b.at)
          .map(row => {
            const base = recoveryByEvent.get(row.request) ?? null;
            const view = views.get(row.request);
            return {
              event: row.request,
              ts: row.ts,
              date: row.date,
              sessionHash: row.sessionHash,
              op: row.op,
              role: row.role0,
              delta: row.delta,
              hitRatePct: view?.hitRatePct ?? null,
              successor: base?.successor ?? null,
              successorHitRatePct: base?.successorHitRate ?? null,
              verdict: base?.successor ? '有后续' : '无后续',
            };
          })
      : [],
  };
  checks.T03.noFollowUp = checks.T03.recovery.filter(r => !r.successor);
  checks.T03.streamRecovery = checks.T03.recovery.filter(r => r.op === 'stream');
  checks.T03.promptRecovery = checks.T03.recovery.filter(r => r.op === 'prompt');
  checks.T03.unboundRecovery = checks.T03.recovery.filter(r => r.op === null);

  // ---- T04 flapping ----
  checks.T04 = { pairs: flapping, count: flapping.length };

  // ---- T18：同 session 内指纹全同而 cacheRead 归零 ----
  const fp = view => [
    view.items0?.bytes ?? null,
    view.items0?.hash ?? null,
    view.promptCacheKey ?? null,
    view.affinityHash ?? null,
    view.endpointHash ?? null,
  ];
  const sessions = new Map();
  for (const view of views.values()) {
    const key = `${view.epoch}|${view.sessionHash}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(view);
  }
  const t18Hits = [];
  const t18SkippedNoItems = [];
  const t18SkippedEmptyUsage = [];
  for (const [key, list] of sessions) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 1; i < list.length; i++) {
      const current = list[i];
      const previous = list[i - 1];
      const usage = current.usage;
      if (current.flags.includes('empty-usage')) { t18SkippedEmptyUsage.push(current.id); continue; }
      if (!usage || usage.cacheRead !== 0 || !(usage.input > 0)) continue;
      const a = fp(current), b = fp(previous);
      if (a[0] === null || b[0] === null) { t18SkippedNoItems.push(current.id); continue; }
      if (a.every((value, idx) => value !== null && value === b[idx])) {
        t18Hits.push({
          request: current.id,
          date: current.date,
          ts: current.ts,
          op: current.op,
          sessionHash: current.sessionHash,
          previousRequest: previous.id,
          previousTs: previous.ts,
          fingerprints: {
            items0Bytes: current.items0.bytes,
            items0Hash: current.items0.hash,
            promptCacheKey: current.promptCacheKey,
            affinityHash: current.affinityHash,
            endpointHash: current.endpointHash,
          },
          usage,
          hitRatePct: current.hitRatePct,
        });
      }
    }
  }
  checks.T18 = {
    hits: t18Hits,
    byDate: Object.fromEntries(dates.map(date => [date, t18Hits.filter(h => h.date === date).length])),
    skippedNoFingerprint: t18SkippedNoItems.length,
    skippedEmptyUsage: t18SkippedEmptyUsage.length,
  };

  // ---- T15–T17：mcp.json 只读结构检查（绝不输出 url/headers/env/描述正文） ----
  checks.mcp = mcp;

  return checks;
}

function auditMcpConfig(path) {
  if (!existsSync(path)) return { available: false, path, reason: 'mcp.json 不存在' };
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { available: false, path, reason: `mcp.json 解析失败: ${error.message}` };
  }
  const servers = isObj(config.mcpServers) ? config.mcpServers : {};
  const list = Object.entries(servers).map(([name, server]) => {
    const s = isObj(server) ? server : {};
    return {
      name,
      type: typeof s.type === 'string' ? s.type : 'stdio(隐式)',
      hasDescription: typeof s.description === 'string' && s.description.length > 0,
      descriptionBytes: typeof s.description === 'string' ? Buffer.byteLength(s.description, 'utf8') : 0,
      descriptionChars: typeof s.description === 'string' ? s.description.length : 0,
      hasModes: Array.isArray(s.modes),
      modes: Array.isArray(s.modes) ? s.modes : [],
      disabled: s.disabled === true,
    };
  });
  const workingEnabled = list.filter(s => s.modes.includes('working') && !s.disabled);
  const missingModes = list.filter(s => !s.hasModes).map(s => s.name);
  const disabled = list.filter(s => s.disabled).map(s => s.name);
  return {
    available: true,
    path,
    serverCount: list.length,
    servers: list,
    workingEnabled: workingEnabled.map(s => s.name),
    workingEnabledMissingDescription: workingEnabled.filter(s => !s.hasDescription).map(s => s.name),
    missingModes,
    disabledServers: disabled,
    T15: {
      verdict: workingEnabled.length > 0 && workingEnabled.every(s => s.hasDescription) ? '通过' : '不通过',
      rule: 'modes 含 working 且 disabled!=true 的服务器必须有 description',
      checked: workingEnabled.map(s => s.name),
      missingDescription: workingEnabled.filter(s => !s.hasDescription).map(s => s.name),
    },
    T16: {
      verdict: missingModes.length ? '缺口确认' : '通过',
      rule: '无 modes 字段的服务器单列复核（启用与否由会话场景白名单决定，不能只看本文件）',
      missingModes,
    },
    T17: {
      verdict: disabled.length ? '通过' : '不通过',
      rule: 'disabled=true 的服务器必须被 working 集合排除',
      disabled,
      excludedFromWorking: list.filter(s => s.disabled && s.modes.includes('working')).map(s => s.name),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. 自检（验收数字逐条核对；数字全部来自本轮解析结果，不手改）
// ---------------------------------------------------------------------------

function buildSelfCheck(ctx) {
  const { checks, snapshot, opts } = ctx;
  const d1105 = checks.byDate['2026-11-05'] ?? null;
  const d1106 = checks.byDate['2026-11-06'] ?? null;
  const s1105 = snapshot.byDate['2026-11-05'] ?? null;
  const s1106 = snapshot.byDate['2026-11-06'] ?? null;
  const checksOut = [];
  const add = (id, label, expected, actual, ok, strict = true, note = '') => checksOut.push({ id, label, expected, actual, ok, strict, note });

  if (s1105) {
    add('S01', '11-05 事件对账', 'request 2091 行 / 1134 唯一 / result 1133 / http-result 957',
      `request ${s1105.requestRows} 行 / ${s1105.uniqueRequests} 唯一 / result ${s1105.resultRows} / http-result ${s1105.httpResultRows}`,
      s1105.requestRows === 2091 && s1105.uniqueRequests === 1134 && s1105.resultRows === 1133 && s1105.httpResultRows === 957);
  }
  if (d1105) {
    add('S02', '11-05 全部 request 带 boundary', '0 条缺 boundary', `${d1105.missingBoundaryRows} 条缺 boundary`, d1105.missingBoundaryRows === 0);
    add('S03', 'T01 11-05 基线', '7（developer 5 / user 2）',
      `${d1105.T01.unique}（developer ${d1105.T01.roles.developer} / user ${d1105.T01.roles.user}）`,
      d1105.T01.unique === 7 && d1105.T01.roles.developer === 5 && d1105.T01.roles.user === 2);
    const t02 = d1105.T02.events;
    const t02ok = t02.length === 2
      && t02.every(e => e.delta === 175)
      && t02.some(e => e.request.startsWith('566393c3') && e.time === '12:18:40')
      && t02.some(e => e.request.startsWith('215c8360') && e.time === '15:04:18');
    add('S04', 'T02 +175 事件时间戳', '2 条：566393c3 12:18:40 / 215c8360 15:04:18',
      t02.map(e => `${e.request.slice(0, 8)} ${e.time} ${e.i0}`).join('；') || '无',
      t02ok);
    const t03 = checks.T03.recovery;
    const pick = id => t03.find(r => r.event.startsWith(id));
    const t03ok = ['566393c3:97.156', '215c8360:65.346', '6e8aaed3:94.698', '1a9e5385:99.241', '9a8cc082:86.287', '604f4eba:97.661']
      .every(spec => { const [id, value] = spec.split(':'); const row = pick(id); return row && String(row.successorHitRatePct) === value; });
    add('S05', 'T03 恢复命中率', '97.156 / 65.346 / 94.698（+ 补充 99.241 / 86.287 / 97.661）',
      ['566393c3', '215c8360', '6e8aaed3', '1a9e5385', '9a8cc082', '604f4eba'].map(id => `${id.slice(0, 8)}→${pick(id)?.successorHitRatePct ?? '无后续'}`).join('，'),
      t03ok);
    const noFollow = checks.T03.noFollowUp.map(r => r.event.slice(0, 8));
    add('S06', 'T03 无后续（b45b140e 会话）', '1edf5161 无后续（session b45b140e…）',
      noFollow.length ? noFollow.join(',') : '无', noFollow.some(id => id.startsWith('1edf5161')));
    const pair = checks.T04.pairs[0];
    add('S07', 'T04 ±14 抖动对（全库唯一）', '1 对：6e8aaed3(-14) → 604f4eba(+14)，约 8 秒',
      checks.T04.count === 0 ? '无' : `${checks.T04.count} 对：${checks.T04.pairs.map(p => `${p.a.request.slice(0, 8)}(${p.a.delta}) → ${p.b.request.slice(0, 8)}(${p.b.delta}) gap=${p.gapMs}ms`).join('；')}`,
      checks.T04.count === 1 && pair && pair.a.request.startsWith('6e8aaed3') && pair.b.request.startsWith('604f4eba') && pair.a.delta === -14 && pair.b.delta === 14);
    add('S08', 'T05 行/唯一数', '14 行 / 9 唯一',
      `${d1105.T05.rows} 行 / ${d1105.T05.unique} 唯一（developer ${d1105.T05.roles.developer} / user ${d1105.T05.roles.user}）`,
      d1105.T05.rows === 14 && d1105.T05.unique === 9);
    const hr = id => d1105.T05.events.find(e => e.request.startsWith(id))?.hitRatePct;
    add('S09', 'T05 命中率示例', '1a9e5385=50.28%、604f4eba=94.03%', `1a9e5385=${hr('1a9e5385')}%、604f4eba=${hr('604f4eba')}%`,
      Math.abs(hr('1a9e5385') - 50.284) < 0.01 && Math.abs(hr('604f4eba') - 94.033) < 0.01);
    const ex = d1105.T06.excluded.map(r => r.slice(0, 8)).sort();
    add('S10', 'T06 排除判据', '排除 d8043128、5b600690（op=prompt 且 ic=1/首条 user）',
      `排除 ${ex.join(',') || '无'}；候选 ${d1105.T06.candidates.length}`,
      ex.length === 2 && ex[0].startsWith('5b600690') && ex[1].startsWith('d8043128'));
    add('S11', 'T07 数量与形态', '14 唯一 / 28 行，全 op=prompt、ic=2、items[0] delta=0',
      `${d1105.T07.unique} 唯一 / ${d1105.T07.rows} 行，allPrompt=${d1105.T07.allPrompt} allIc2=${d1105.T07.allIc2} allDelta0=${d1105.T07.allDeltaZeroAtFirstDiff}`,
      d1105.T07.unique === 14 && d1105.T07.rows === 28 && d1105.T07.allPrompt && d1105.T07.allIc2 && d1105.T07.allDeltaZeroAtFirstDiff);
    add('S12', 'T08 首请求（三种口径）', 'pick 行链首 90 唯一 / previous 缺失行 159 / 任一行为首唯一 124 / hitRate=0 恰好 32',
      `pick 行链首 ${d1105.T08.pickFirstUnique} 唯一（provider 首行 ${d1105.T08.providerFirstUnique}）/ 行 ${d1105.T08.rowsWithMissingPrevious} / 任一行为首唯一 ${d1105.T08.uniqueAnyRowFirst} / hitRate=0 ${d1105.T08.hitRateZeroUnique}（pick 首子集 ${d1105.T08.hitRateZeroAmongPickFirst}）/ hitRate=null ${d1105.T08.hitRateNullAmongAnyRowFirst}（124-3=121 可解释原报告的 121，需补口径）`,
      d1105.T08.pickFirstUnique === 90 && d1105.T08.providerFirstUnique === 90 && d1105.T08.rowsWithMissingPrevious === 159
        && d1105.T08.hitRateZeroUnique === 32 && d1105.T08.hitRateZeroAmongPickFirst === 32);
    add('S13', 'T09 hitRate=null result', '14 条',
      `${d1105.T09.nullHitRateResults} 条（传输异常 ${d1105.T09.transportAnomalies} / 无 http-result ${d1105.T09.noHttpResult} / 200 但缺 usage ${d1105.T09.status200ButNoUsage}）`,
      d1105.T09.nullHitRateResults === 14 && d1105.T09.transportAnomalies === 4);
    add('S14', 'T09 无 items request', '80 行（provider 46 + http 34）/ 唯一 80',
      `${d1105.T09.noItemsRows} 行（${Object.entries(d1105.T09.noItemsByStage).map(([k, v]) => `${k} ${v}`).join(' + ')}）/ 唯一 ${d1105.T09.noItemsUnique}`,
      d1105.T09.noItemsRows === 80 && d1105.T09.noItemsByStage.provider === 46 && d1105.T09.noItemsByStage.http === 34);
    add('S15', 'T10 http items 为空必须回退 provider', '34/34 成功取到 items[0].bytes',
      `${d1105.T10.httpEmptyFallbackOk}/${d1105.T10.httpEmptyFallback.length} 成功${d1105.T10.httpEmptyFallbackFailed.length ? '，失败 ' + d1105.T10.httpEmptyFallbackFailed.join(',') : ''}`,
      d1105.T10.httpEmptyFallback.length === 34 && d1105.T10.httpEmptyFallbackOk === 34);
    add('S16', 'T10 1a9e5385 只有 provider 一条', 'stages=[provider]',
      `stages=[${(d1105.T10.baselineStages['1a9e5385-67bb-42f4-9a0e-e44ee965e586'] ?? []).join(',')}]`,
      JSON.stringify(d1105.T10.baselineStages['1a9e5385-67bb-42f4-9a0e-e44ee965e586']) === JSON.stringify(['provider']));
  }
  if (d1106) {
    const withBoundary = d1106.requestRows - d1106.missingBoundaryRows;
    const rs1106 = ctx.reportSnapshot?.['2026-11-06'] ?? null;
    const canVerifySnapshot = Boolean(rs1106);
    const snapshotRows = rs1106?.requestRows ?? d1106.requestRows;
    const snapshotMissing = rs1106?.requestRowsMissingBoundary ?? d1106.missingBoundaryRows;
    add('S17', '11-06 缺 boundary（报告快照 742/746）', '报告快照 742/746 行无 boundary；实时快照满足对账不变量',
      `实时 ${d1106.missingBoundaryRows}/${d1106.requestRows}（带 boundary ${withBoundary}）；报告快照（${REPORT_SNAPSHOT_CUTOFF}）${canVerifySnapshot ? `${snapshotMissing}/${snapshotRows}` : '未重算（--cutoff 早于报告时点）'}`,
      canVerifySnapshot
        ? snapshotRows === 746 && snapshotMissing === 742
          && withBoundary === 4 && d1106.missingBoundaryRows + withBoundary === d1106.requestRows
        : withBoundary === 4 && d1106.missingBoundaryRows + withBoundary === d1106.requestRows,
      canVerifySnapshot,
      '实时日志仍在追加，11-06 计数随时间增长；报告快照用固定 cutoff 重算，实时只校验"缺 boundary + 带 boundary = request 行数"');
    add('S18', '11-06 T01/T02 不可判', '两者均标"不可判（无 boundary）"',
      `T01=${d1106.T01.verdict} / T02=${d1106.T02.verdict}`,
      d1106.T01.verdict === '不可判（无 boundary）' && d1106.T02.verdict === '不可判（无 boundary）');
    const anom = d1106.T05.events.find(e => e.request.startsWith('3c4eefc4'));
    add('S19', '11-06 唯一异常 3c4eefc4 被报出', '09:10:31、+58（5140→5198）、hitRate 1.21%，不受 op 过滤影响',
      anom ? `${anom.ts.slice(11)}、${anom.delta >= 0 ? '+' : ''}${anom.delta}（${anom.i0}）、hitRate ${anom.hitRatePct}%、op=${anom.op}` : '未报出',
      Boolean(anom) && hhmmss(anom.ts) === '09:10:31' && anom.delta === 58 && Math.abs(anom.hitRatePct - 1.207) < 0.001);
    add('S20', '11-06 http items 为空', '0 行', `${(s1106?.httpRowsWithEmptyItems ?? 0)} 行`, (s1106?.httpRowsWithEmptyItems ?? 0) === 0);
  }
  const t18 = checks.T18;
  const t18Actual = `${['2026-11-05', '2026-11-06'].filter(d => snapshot.dates.includes(d)).map(d => `${d.slice(5)} ${t18.byDate[d] ?? 0} 条`).join('；')}${t18.hits.length ? '；命中 ' + t18.hits.map(h => `${h.request.slice(0, 8)} input=${h.usage.input}`).join('，') : ''}`;
  if (snapshot.dates.includes('2026-11-05')) {
    add('S21', 'T18 指纹全同但 cacheRead 归零', '11-05 命中 1 条（201c0806，input=30057）；11-06 为 0', t18Actual,
      t18.hits.length === 1 && t18.byDate['2026-11-05'] === 1 && (t18.byDate['2026-11-06'] ?? 0) === 0 && t18.hits[0]?.request.startsWith('201c0806') && t18.hits[0]?.usage.input === 30057);
  } else {
    add('S21', 'T18 指纹全同但 cacheRead 归零（仅 11-06）', '11-06 为 0 条', t18Actual, (t18.byDate['2026-11-06'] ?? 0) === 0, false, '本次未加载 11-05，只校验 11-06');
  }
  const mcp = checks.mcp;
  add('S22', 'T15/T16/T17 mcp.json 只读检查', '9 服务器 / 5 个 working 有 description / 缺 modes=rea,github / Remote disabled',
    mcp.available
      ? `${mcp.serverCount} 服务器 / working 有 description ${mcp.T15.checked.length} 个（缺 ${mcp.T15.missingDescription.length}）/ 缺 modes [${mcp.missingModes.join(',')}] / disabled [${mcp.disabledServers.join(',')}]`
      : `跳过：${mcp.reason}`,
    mcp.available && mcp.serverCount === 9 && mcp.T15.checked.length === 5 && mcp.T15.missingDescription.length === 0
      && JSON.stringify(mcp.missingModes) === JSON.stringify(['rea', 'github']) && mcp.disabledServers.length === 1);
  add('S23', '解析完整性', '无 JSON 解析失败行', `${snapshot.totals.parseFailures} 行解析失败`, snapshot.totals.parseFailures === 0);

  return checksOut;
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const loaded = readEvents(opts);
  const index = indexEvents(loaded);
  const views = buildViews(index);
  annotateItems0Delta(views);
  const snapshot = snapshotByDate(loaded);
  // 报告快照（11-06 09:34:32）：只有读取口径不早于该时点时才可重算
  const reportSnapshot = !opts.cutoff || opts.cutoff.ms >= REPORT_SNAPSHOT_MS ? snapshotAtCutoff(loaded, REPORT_SNAPSHOT_MS) : null;
  const { rows: breakRows, anomalies: breakAnomalies } = collectBreakRows(index, views);
  const recovery = collectRecovery(index, breakRows, views);
  const flapping = collectFlapping(breakRows, views);
  const mcp = auditMcpConfig(opts.mcpJson);
  const ctx = { views, index, loaded, snapshot, reportSnapshot, breakRows, breakAnomalies, recovery, flapping, mcp, opts };
  const checks = buildChecks(ctx);

  // 把断裂事件的 hitRate 回填（T05 展示需要）
  for (const row of breakRows) {
    const view = views.get(row.request);
    row.hitRate = view?.hitRate ?? null;
    row.hitRatePct = view?.hitRatePct ?? null;
    row.usage = view?.usage ?? null;
  }

  const requests = [...views.values()]
    .sort((a, b) => a.at - b.at)
    .map(view => ({
      id: view.id,
      date: view.date,
      ts: view.ts,
      at: view.at,
      epoch: view.epoch,
      sessionHash: view.sessionHash,
      parentSessionHash: view.parentSessionHash,
      source: view.source,
      op: view.op,
      opSource: view.op ? 'boundary.operation' : 'missing-boundary',
      stages: view.stages,
      stageRows: view.stageRows,
      pickedStage: view.pickedStage,
      pickVia: view.pickVia,
      inputCount: view.inputCount,
      inputCounts: view.inputCounts,
      items0Delta: view.items0Delta,
      previousItems0Bytes: view.previousItems0Bytes,
      items0: view.items0,
      promptCacheKey: view.promptCacheKey,
      affinityHash: view.affinityHash,
      endpointHash: view.endpointHash,
      previous: view.previous,
      hitRate: view.hitRate,
      hitRatePct: view.hitRatePct,
      usage: view.usage,
      outcome: view.outcome,
      httpStatus: view.httpStatus,
      httpResultCount: view.httpResultCount,
      flags: view.flags,
    }));

  ctx.checks = checks;
  const selfcheck = buildSelfCheck(ctx);
  const facts = {
    script: 'scripts/cache-prefix-audit.mjs',
    generatedAt: new Date().toISOString(),
    run: {
      command: ['node', 'scripts/cache-prefix-audit.mjs', ...process.argv.slice(2)].join(' '),
      node: process.version,
      dir: opts.dir,
      json: opts.json,
      dates: opts.dates,
      cutoff: opts.cutoff ? opts.cutoff.raw : null,
      cutoffMs: opts.cutoff ? opts.cutoff.ms : null,
      reportSnapshotCutoff: REPORT_SNAPSHOT_CUTOFF,
      mcpJson: opts.mcpJson,
      selfcheck: opts.selfcheck,
    },
    inputs: {
      files: loaded.files,
      otherEvents: loaded.otherCounts,
      duplicateRequestRows: index.duplicateRows.length,
      breakRowAnomalies: breakAnomalies,
    },
    snapshot,
    reportSnapshot: {
      cutoff: REPORT_SNAPSHOT_CUTOFF,
      cutoffMs: REPORT_SNAPSHOT_MS,
      byDate: reportSnapshot,
      note: '报告快照：复核报告成文时的日志规模（11-06 742/746 行无 boundary）。实时运行里由同一份读取结果按 at<=cutoff 重算；若 --cutoff 早于该时点则为 null。',
    },
    rules: [
      'request 按 (epoch, request, stage, attempt) 入表，重复键保留首次出现',
      'result 取最后一条非 null hitRate；命中率统计前排除 usage.input=0 的空记录',
      'http-result 只取 status 判传输异常（有 http-result 但 status!=200 记为 transport-anomaly），不进命中率',
      'pick：http items 非空优先 → provder items 非空 → 第一条；http items 为空必须回退 provider',
      '断裂事件 = previous.prefix=false 且 previous.sharedItems=0，delta 取 previous.firstDifference.current.bytes - old.bytes（index 必须为 0）',
      'T04：同 session 内相邻两条断裂事件 delta 互为相反数且非零 → flapping，两边都报',
      'T05：不使用 hitRate<0.5 阈值；按 items[0].role 分 developer/user，hitRate 仅用于排序与分档',
      'T06：op=prompt 且 (inputCount=1 或 items[0].role=user) → 排除；不用 fields 缺 model/tools 判',
      'T01/T02 依赖 op=stream；缺 boundary 的日期标"不可判（无 boundary）"而非通过',
      'T18：同 (epoch, session) 相邻两次请求的 items[0].bytes/items[0].hash/prompt_cache_key/affinityHash/endpointHash 全同且 cacheRead=0、input>0',
      '不同 epoch 的哈希不可比，T18 只在同一 epoch+sessionHash 内比较',
    ],
    checks,
    requests,
    breakEvents: breakRows,
    selfcheck,
    limits: [
      '真实日志只写 HMAC 哈希与字节数，不含明文；本脚本不还原内容，也不据此断言语义。',
      '不同进程 epoch 的哈希不可比；跨 epoch 的前缀/命中率不作等同比对。',
      'http-result 缺失、http items 为空、body 不可观测都是"未观测"，不能读成"没有变化"。',
      '11-06 日志仍在追加（Durable 路径无 boundary），11-06 的实时计数随运行时间增长；复现报告快照需 --cutoff。',
      '11-06 的 T01/T02 因缺 boundary 不可判，脚本只给不受 op 过滤影响的旁证（unboundSupplement）。',
      'T15–T17 只读 mcp.json 的结构字段（名称/type/modes/disabled/描述长度），不输出 url/headers/env 与描述正文。',
      '日志为本地采样，不含请求体明文，故 items[0] 变化只能归因到 role/字节数/哈希，不能归因到具体文案段落。',
    ],
  };

  mkdirSync(dirname(opts.json), { recursive: true });
  writeFileSync(opts.json, JSON.stringify(facts, null, 2) + '\n', 'utf8');

  printSummary({ opts, snapshot, checks, selfcheck, facts });
  const strictFailures = selfcheck.filter(c => c.strict && !c.ok);
  if (opts.selfcheck && strictFailures.length) process.exitCode = 1;
}

function printSummary({ opts, snapshot, checks, selfcheck, facts }) {
  if (!opts.quiet) {
    console.log('缓存前缀审计（只读）');
    console.log(`  日志目录: ${opts.dir}`);
    console.log(`  日期: ${snapshot.dates.join(', ')}  文件: ${snapshot.totals.files}  字节: ${snapshot.totals.bytes}`);
    console.log(`  cutoff: ${opts.cutoff ? opts.cutoff.raw : '(未设置，实时全量)'}`);
    console.log('');
    console.log('[事件对账]');
    for (const date of snapshot.dates) {
      const s = snapshot.byDate[date];
      console.log(`  ${date}: request ${s.requestRows} 行 / ${s.uniqueRequests} 唯一 | result ${s.resultRows} | http-result ${s.httpResultRows} | 缺 boundary ${s.requestRowsMissingBoundary} 行 / ${s.uniqueRequestsMissingBoundary} 唯一 | op ${JSON.stringify(s.opCounts)}`);
    }
    const rs = facts.reportSnapshot?.byDate?.['2026-11-06'];
    if (rs) console.log(`  报告快照(${facts.reportSnapshot.cutoff}) 11-06: request ${rs.requestRows} 行 / ${rs.uniqueRequests} 唯一 | 缺 boundary ${rs.requestRowsMissingBoundary} 行 | 带 boundary ${rs.requestRowsWithBoundary} 行`);
    console.log('');
    for (const date of snapshot.dates) {
      const d = checks.byDate[date];
      console.log(`[${date}] T01 ${d.T01.verdict}（唯一 ${d.T01.unique}：developer ${d.T01.roles.developer} / user ${d.T01.roles.user}）`);
      console.log(`[${date}] T02 ${d.T02.verdict}（+175 事件 ${d.T02.count}）`);
      console.log(`[${date}] T05 断裂事件 ${d.T05.rows} 行 / ${d.T05.unique} 唯一（developer ${d.T05.roles.developer} / user ${d.T05.roles.user}）分档 ${JSON.stringify(d.T05.bands)}`);
      console.log(`[${date}] T07 ${d.T07.unique} 唯一 / ${d.T07.rows} 行（allPrompt=${d.T07.allPrompt} allIc2=${d.T07.allIc2} delta0=${d.T07.allDeltaZeroAtFirstDiff}）`);
      console.log(`[${date}] T08 首请求 ${d.T08.providerUnique} 唯一(provider) / ${d.T08.rows} 行 / hitRate=0 ${d.T08.hitRateZeroUnique}`);
      console.log(`[${date}] T09 hitRate=null ${d.T09.nullHitRateResults} 条（传输异常 ${d.T09.transportAnomalies}）；无 items ${d.T09.noItemsRows} 行（${JSON.stringify(d.T09.noItemsByStage)}）`);
      console.log(`[${date}] T10 取数来源 ${JSON.stringify(d.T10.pickStats)}；http 空 items 回退 ${d.T10.httpEmptyFallbackOk}/${d.T10.httpEmptyFallback.length}`);
    }
    console.log('');
    console.log(`[T03] 恢复链 ${checks.T03.recovery.length} 条，无后续 ${checks.T03.noFollowUp.length} 条：${checks.T03.noFollowUp.map(r => r.event.slice(0, 8)).join(',') || '无'}`);
    console.log(`[T04] flapping ${checks.T04.count} 对${checks.T04.count ? '：' + checks.T04.pairs.map(p => `${p.a.request.slice(0, 8)}(${p.a.delta})→${p.b.request.slice(0, 8)}(${p.b.delta}) ${p.gapMs}ms`).join('；') : ''}`);
    console.log(`[T18] 命中 ${checks.T18.hits.length} 条：${checks.T18.hits.map(h => `${h.request.slice(0, 8)} input=${h.usage.input}`).join(',') || '无'}`);
    console.log(`[mcp] ${checks.mcp.available ? `${checks.mcp.serverCount} 服务器 / T15=${checks.mcp.T15.verdict} / T16=${checks.mcp.T16.verdict} (${checks.mcp.missingModes.join(',')}) / T17=${checks.mcp.T17.verdict}` : '跳过 ' + checks.mcp.reason}`);
    console.log('');
  }
  console.log('[自检]');
  let hardFail = 0;
  for (const item of selfcheck) {
    const tag = item.ok ? 'PASS' : 'FAIL';
    if (!item.ok && item.strict) hardFail++;
    console.log(`  ${tag} ${item.id} ${item.label}`);
    console.log(`        期望: ${item.expected}`);
    console.log(`        实际: ${item.actual}`);
    if (item.note) console.log(`        说明: ${item.note}`);
  }
  const soft = selfcheck.filter(c => !c.strict).length;
  console.log(`  合计 ${selfcheck.length} 项：通过 ${selfcheck.filter(c => c.ok).length}，硬失败 ${hardFail}，提示项 ${soft}`);
  console.log(`  facts.json -> ${opts.json}`);
  if (opts.selfcheck && hardFail) console.log(`  退出码 1（${hardFail} 项硬失败）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  }
}

export { pickRow, indexEvents, buildViews, snapshotByDate, collectBreakRows, collectFlapping, auditMcpConfig };
