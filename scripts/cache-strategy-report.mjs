// Read-only report of completed strategy experiments. No payloads/keys are emitted.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const root = join(process.cwd(), 'artifacts/cache-investigation/strategy-evaluation');
const sha = v => createHash('sha256').update(JSON.stringify(v) ?? 'undefined').digest('hex');
const reports = [];
for (const child of readdirSync(root, { withFileTypes: true })) {
  if (!child.isDirectory()) continue;
  const path = join(root, child.name, 'report.json');
  if (!existsSync(path)) continue;
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.live) reports.push({ path: child.name + '/report.json', report });
}
const wanted = new Set(reports.flatMap(({report}) => report.results.flatMap(r => r.calls.map(c => c.responseHash).filter(Boolean))));
const usage = new Map();
const usagePath = join(homedir(), '.config/magpie/usage.jsonl');
if (existsSync(usagePath)) for (const line of readFileSync(usagePath, 'utf8').split('\n')) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const key = sha(row.response_id);
  if (!wanted.has(key)) continue;
  const safe = { route: row.route_id, time: row.t, status: row.status, model: row.served ?? row.model,
    accountHash: row.providerAccount ? sha(row.providerAccount) : null,
    keyHash: row.providerKeyId ? sha(row.providerKeyId) : null,
    uncached: row.in, cacheRead: row.cache_read, cacheWrite: row.cache_write, output: row.out };
  const list = usage.get(key) ?? []; list.push(safe); usage.set(key, list);
}
const wantedRoutes = new Set([...usage.values()].flat().map(r => r.route));
const routes = new Map();
const dates = new Set([...usage.values()].flat().map(r => r.time?.slice(0,10)).filter(Boolean));
for (const date of dates) {
  const path = join(homedir(), '.config/magpie/routing', date + '.jsonl');
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!wantedRoutes.has(row.id)) continue;
    if (routes.has(row.id) && routes.get(row.id).seq > row.seq) continue;
    routes.set(row.id, { seq: row.seq, done: row.done, tryCount: row.tries?.length,
      tries: (row.tries ?? []).map(t => ({ accountHash: sha(t.id), status: t.status, asks: t.net?.asks, replan: Boolean(t.replan), again: Boolean(t.again) })) });
  }
}
const scenarios = [];
for (const {path,report} of reports) for (const result of report.results) {
  const calls = result.calls.filter(c => c.phase === 'task');
  const sum = key => calls.reduce((n,c) => n + (c.usage?.[key] ?? 0), 0);
  const total = sum('input') + sum('cacheRead') + sum('cacheWrite');
  const starts = calls.filter((c,i) => i === 0 || calls[i-1].turn !== c.turn);
  const transitions = starts.slice(1);
  const joined = calls.map(c => {
    const matches = usage.get(c.responseHash) ?? [];
    return { ordinal: c.ordinal, matchCount: matches.length,
      usage: matches.length === 1 ? matches[0] : null,
      route: matches.length === 1 ? routes.get(matches[0].route) ?? null : null };
  });
  scenarios.push({ strategy: result.strategy, repetition: result.repetition, path, error: result.error ?? null,
    calls: calls.length, correct: result.checks.filter(c => c.correct === true).length,
    tasks: result.checks.filter(c => 'correct' in c).length,
    prefixBreaks: calls.filter(c => c.wire && !c.wire.prefix).length,
    baseChanges: calls.filter(c => c.wire?.baseChanges?.length).length,
    input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'),
    hitRate: total ? sum('cacheRead') / total : null,
    memoryLookups: result.checks.reduce((n,c) => n+(c.memoryLookups ?? 0),0),
    sourceMarkerPersisted: result.checks.find(c => 'sourceMarkerPersisted' in c)?.sourceMarkerPersisted ?? result.checks.find(c => 'rawEvidencePersisted' in c)?.rawEvidencePersisted ?? null,
    starts: starts.map(c => ({ turn:c.turn, prefix:c.wire?.prefix, previousItems:c.wire?.previousItems,
      sharedItems:c.wire?.sharedItems, cacheRead:c.usage?.cacheRead, input:c.usage?.input,
      evidenceCopies:c.wire?.evidenceCopies, baseChanges:c.wire?.baseChanges })),
    transitionCacheRead: transitions.reduce((n,c)=>n+(c.usage?.cacheRead??0),0),
    transitionPrompt: transitions.reduce((n,c)=>n+(c.usage?.input??0)+(c.usage?.cacheRead??0)+(c.usage?.cacheWrite??0),0),
    gateway: joined,
  });
}
const summary = { generatedAt: new Date().toISOString(), scenarios, limits: [
  'Ratios include fresh file contents and warm-up; do not infer defect cost from 1-hitRate.',
  'Identical workload, agent-chosen tools and outputs differ. No controlled causal estimate of billing savings.',
  'Local payload observation does not see gateway-to-vendor changes or vendor cache placement.',
  'Marker persistence is not a privacy guarantee: derived facts can persist even without the marker.',
  'Unmatched/multiply matched response IDs are not evidence of shared routing or accounts.',
] };
writeFileSync(join(root,'summary.json'), JSON.stringify(summary,null,2));
for (const s of scenarios) console.log(JSON.stringify({ strategy:s.strategy, correct:`${s.correct}/${s.tasks}`, calls:s.calls,
  prefixBreaks:s.prefixBreaks, baseChanges:s.baseChanges, hit:Math.round(s.hitRate*1000)/10,
  lookups:s.memoryLookups, sourceMarkerPersisted:s.sourceMarkerPersisted,
  turnStarts:s.starts.map(x => ({t:x.turn,read:x.cacheRead,uncached:x.input,prefix:x.prefix})),
  gatewayMatched:s.gateway.filter(r=>r.matchCount===1).length, error:s.error }));
