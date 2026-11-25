import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeAuditReader } from "../src/main/platform/runtime-audit";

/** A deliberately stalled worker makes queue and correlation checks independent of disk speed. */
export async function checkHistoryTransport(directory: string): Promise<void> {
  const fixture = join(directory, "history-wire.cjs");
  writeFileSync(fixture, String.raw`
const lines = require("node:readline").createInterface({input:process.stdin});
const held = [];
const sessions = new Set();
function reply(req,data) {
  process.stdout.write(JSON.stringify({status:"ok",replyId:req.requestId,
    ...(req.operation==="historyRead" ? {historyRequestId:req.requestId} : {}),data})+"\n");
}
lines.on("line", line => {
  const req = JSON.parse(line);
  if(req.operation==="control") return reply(req,{requestId:req.targetRequestId,state:"running"});
  if(req.operation==="historyLaneSupported") return reply(req,true);
  if(req.operation==="snapshots") {
    if(req.taskId==="exit") return process.exit(1);
    if(req.taskId==="release") for(const item of held.splice(0).reverse()) reply(item,item.action==="open" || item.sql);
    return reply(req,{sessions:sessions.size});
  }
  if(req.operation!=="historyRead") throw Error("unexpected legacy dispatch");
  if(req.action==="open") {
    sessions.add(req.session);
    if(req.path==="stall") held.push(req);
    else reply(req,true);
  } else if(req.action==="close") {
    sessions.delete(req.session);
    reply(req,true);
  } else held.push(req);
});
`);
  const reader = new RuntimeAuditReader(process.execPath, fixture);
  try {
    const view = await reader.openDurable("fixture");
    assert.ok(view);
    const reads = Array.from({length:32}, (_, i) => view.select(String(i), [], true));
    assert.equal(await view.select("overflow", [], true), undefined);
    await reader.snapshots("release", 1);
    assert.deepEqual(await Promise.all(reads), reads.map((_, i) => String(i)));
    await view.close();

    // A late open owns a SQLite handle. Its reply must close that handle even
    // after the original caller has already taken its passive host fallback.
    assert.equal(await reader.openDurable("stall"), undefined);
    await reader.snapshots("release", 1);
    await delay(5);
    assert.deepEqual(await reader.snapshots("count", 1), {sessions:0});

    const prior = await reader.openDurable("fixture");
    assert.ok(prior);
    const interrupted = prior.select("waiting", [], true);
    await reader.snapshots("exit", 1);
    assert.equal(await interrupted, undefined);
    const replacement = await reader.openDurable("fixture");
    assert.ok(replacement);
    await prior.close();
    assert.deepEqual(await reader.snapshots("count", 1), {sessions:1});
    await replacement.close();
  } finally { await reader.close(); }
  console.log("PASS history transport correlates reversed replies, bounds backlog and cleans up late opens and retired sessions");
}
