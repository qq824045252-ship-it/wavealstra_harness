#!/usr/bin/env node
/**
 * Read-only audit of real prompt-cache behaviour from the local Magpie gateway log.
 *
 * Groups `~/.config/magpie/usage.jsonl` by session and reports, per session:
 *   - the per-request cache_read sequence
 *   - drops where the next request re-billed far more than the growing tail
 *   - model switches, and structural events from the matching Pi session JSONL
 *     (user turns, compaction, tool declaration changes) when the file is found
 *
 * Only counts, hashes and token numbers are printed; no prompt text, no session
 * ids in clear, no credentials.
 *
 *   node scripts/cache-usage-audit.mjs [days]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const days = Number(process.argv[2] ?? 7);
const usagePath = join(homedir(), ".config", "magpie", "usage.jsonl");
if (!existsSync(usagePath)) {
  console.log("SKIP: no magpie usage log");
  process.exit(0);
}
const since = Date.now() - days * 86_400_000;
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

const records = [];
for (const line of readFileSync(usagePath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const time = Date.parse(row.t);
  if (!Number.isFinite(time) || time < since) continue;
  if (row.status !== 200) continue;
  records.push({
    time,
    session: row.native_session ?? row.session ?? "",
    model: row.served ?? row.model ?? "",
    requestModel: row.req ?? "",
    input: row.in ?? 0,
    cacheRead: row.cache_read ?? 0,
    cacheWrite: row.cache_write ?? 0,
    output: row.out ?? 0,
    stop: row.stop ?? "",
    agent: row.agent ?? "",
    endpoint: row.ep ?? "",
    maskedMs: row.masking_ms ?? 0,
  });
}

const sessions = new Map();
for (const record of records) {
  if (!record.session) continue;
  if (!sessions.has(record.session)) sessions.set(record.session, []);
  sessions.get(record.session).push(record);
}

// Index local Pi session files by the session id embedded in the filename.
const sessionFiles = new Map();
for (const root of [join(homedir(), ".mybuddy", "sessions"), join(homedir(), ".pi", "agent", "sessions")]) {
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root)) {
    const path = join(root, dir);
    let files = [];
    try { files = readdirSync(path); } catch { continue; }
    for (const file of files) {
      const match = file.match(/_([0-9a-f-]{36})\.jsonl$/);
      if (match) sessionFiles.set(match[1], join(path, file));
    }
  }
}

function structure(file) {
  const events = { userTurns: 0, compaction: 0, toolDeclChanges: 0, images: 0, models: [] };
  let turn = 0;
  let declared = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "model_change") events.models.push(entry.modelId);
    if (entry.type === "compaction") events.compaction++;
    if (entry.type !== "message") { turn++; continue; }
    const message = entry.message;
    if (message.role === "user") { turn++; events.userTurns++; }
    if (Array.isArray(message.content)) {
      events.images += message.content.filter(part => part?.type === "image").length;
    }
    if (message.role === "system" && (message.toolsAdded || message.toolsRemoved)) {
      const names = [...(message.toolsAdded ?? []).map(tool => "+" + tool.name),
        ...(message.toolsRemoved ?? []).map(tool => "-" + tool.name)].sort().join(",");
      if (declared !== names) { events.toolDeclChanges++; declared = names; }
    }
  }
  void turn;
  return events;
}

function classify(requests) {
  // "Anchor reset": the read falls back to a low, previously seen anchor while
  // the prompt kept growing. That is what a re-anchored request-only context
  // supplement looks like from the provider's side.
  let resets = 0;
  let lost = 0;
  for (let i = 1; i < requests.length; i++) {
    const previous = requests[i - 1], current = requests[i];
    if (previous.total < 12000) continue;
    if (current.cacheRead <= previous.total * 0.35 && current.cacheRead < previous.cacheRead) {
      resets++;
      lost += previous.total - current.cacheRead;
    }
  }
  return { resets, lost };
}

const report = [];
for (const [session, rows] of sessions) {
  if (rows.length < 3) continue;
  rows.sort((a, b) => a.time - b.time);
  const requests = [];
  let previous = null;
  for (const row of rows) {
    const total = row.input + row.cacheRead + row.cacheWrite;
    // A continuation should read almost the whole previous prompt. The tolerance
    // covers the provider's 128-token block rounding and the fresh tail.
    const expected = previous ? previous.total : 0;
    const drop = expected > 2000 ? Math.max(0, expected - row.cacheRead - Math.max(512, expected * 0.08)) : 0;
    requests.push({
      index: requests.length + 1,
      time: new Date(row.time).toISOString(),
      model: hash(row.model),
      total,
      input: row.input,
      cacheRead: row.cacheRead,
      hit: total > 0 ? row.cacheRead / total : 0,
      drop,
      modelSwitched: previous ? previous.model !== row.model : false,
      maskedMs: row.maskedMs,
    });
    previous = { total, model: row.model };
  }
  const totalIn = requests.reduce((n, r) => n + r.input, 0);
  const totalRead = requests.reduce((n, r) => n + r.cacheRead, 0);
  const file = sessionFiles.get(session);
  report.push({
    session: hash(session),
    requests: requests.length,
    sender: rows[0].agent,
    model: rows.at(-1).model,
    endpoint: rows.at(-1).endpoint,
    hitRate: totalRead + totalIn > 0 ? totalRead / (totalRead + totalIn) : 0,
    drops: requests.filter(r => r.drop > 0).length,
    lostTokens: requests.reduce((n, r) => n + r.drop, 0),
    modelSwitches: requests.filter(r => r.modelSwitched).length,
    ...classify(requests),
    structure: file ? structure(file) : null,
    sequence: requests,
  });
}

report.sort((a, b) => b.lostTokens - a.lostTokens);
const withDrops = report.filter(row => row.drops > 0);

console.log(`window: last ${days} day(s); sessions with >=3 requests: ${report.length}`);
console.log(`sessions with a re-billed prefix: ${withDrops.length}`);
const totalLost = report.reduce((n, row) => n + row.lostTokens, 0);
const totalIn = report.reduce((n, row) => n + row.sequence.reduce((m, r) => m + r.input, 0), 0);
console.log(`re-billed prefix tokens: ${totalLost} across ${report.reduce((n, row) => n + row.sequence.length, 0)} requests`);
console.log(`aggregate hit rate: ${(report.reduce((n, row) => n + row.sequence.reduce((m, r) => m + r.cacheRead, 0), 0) / Math.max(1, report.reduce((n, row) => n + row.sequence.reduce((m, r) => m + r.total, 0), 0)) * 100).toFixed(1)}%`);
console.log("\ntop sessions by re-billed tokens:");
for (const row of withDrops.slice(0, 12)) {
  const events = row.structure;
  console.log(`- ${row.session} ${row.sender}/${row.endpoint} model=${row.model}` +
    ` reqs=${row.requests} hit=${(row.hitRate * 100).toFixed(0)}% drops=${row.drops} lost=${row.lostTokens}` +
    (events ? ` | turns=${events.userTurns} compact=${events.compaction} toolDecl=${events.toolDeclChanges}` +
      ` imgs=${events.images} models=${[...new Set(events.models)].length}` : " | no session file"));
  const preview = row.sequence.map(r => `${r.cacheRead}`).join(",");
  console.log(`  reads: ${preview}`);
}
for (const agent of ["mybuddy", "dsh", "pi"]) {
  const rows = report.filter(row => row.sender === agent);
  if (rows.length === 0) continue;
  const resets = rows.reduce((n, row) => n + row.resets, 0);
  const lost = rows.reduce((n, row) => n + row.lost, 0);
  const requests = rows.reduce((n, row) => n + row.requests, 0);
  const read = rows.reduce((n, row) => n + row.sequence.reduce((m, r) => m + r.cacheRead, 0), 0);
  const total = rows.reduce((n, row) => n + row.sequence.reduce((m, r) => m + r.total, 0), 0);
  console.log(`
${agent}: ${rows.length} sessions, ${requests} requests, hit ${(read / Math.max(1, total) * 100).toFixed(1)}%,` +
    ` anchor resets ${resets}, tokens re-billed by resets ${Math.round(lost)}`);
  console.log(`   sessions with resets: ${rows.filter(row => row.resets > 0).length}`);
}
void totalIn;

const outDir = join(process.cwd(), "artifacts", "cache-investigation", "boundary-scenarios");
mkdirSync(outDir, { recursive: true });
const compact = report.map(row => ({
  session: row.session, sender: row.sender, model: row.model, endpoint: row.endpoint,
  requests: row.requests, hitRate: Number(row.hitRate.toFixed(4)),
  drops: row.drops, lostTokens: Math.round(row.lostTokens), resets: row.resets,
  resetsLost: Math.round(row.lost), modelSwitches: row.modelSwitches, structure: row.structure,
  reads: row.sequence.map(r => r.cacheRead),
  totals: row.sequence.map(r => r.total),
}));
writeFileSync(join(outDir, "usage-audit.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), windowDays: days, sessions: compact }, null, 2));
console.log(`\nreport: ${join(outDir, "usage-audit.json")}`);
