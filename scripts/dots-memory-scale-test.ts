import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";
import { SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/SemanticModelManager";
import { projectMemoryContext, memoryProjectionQuery } from "../src/main/agent/MemoryContextProjection";
import { DOTS_TASK_ID } from "../src/shared/dots";

const root = mkdtempSync(join(tmpdir(), "dots-memory-scale-"));
const db = new AppDatabase(join(root, "app.db"));
const lexical = new MemoryService(db, { semantic: false });
const kernel = new MemoryService(db);
const embed = SemanticRuntime.prototype.embed;
const scope = { taskId: DOTS_TASK_ID, includeInherited: true, statuses: ["active" as const], limit: 10 };
const other = "private-unrelated-task";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (i: number, label: string) => hash(label + i).slice(0, 18);
type Case = { group: string; query: string; id?: string; content?: string; source?: string };
const cases: Case[] = [];
const vectors = new Map<string, number>();
const dimension = SEMANTIC_DIMENSION;
// Dense orthogonal Walsh vectors make every query dimension participate in scoring.
const testVector = (index: number) => Float32Array.from({length: dimension}, (_,axis) => {
  let n=(index+1)&axis, parity=0;
  while(n){parity^=1;n&=n-1;}
  return (parity ? -1 : 1)/Math.sqrt(dimension);
});
const reportPath = "out/tests/dots-memory-scale.json";
mkdirSync("out/tests", { recursive: true });
const cpustats = () => cpus().map(core => ({ ...core.times }));
const before = cpustats();
await delay(500);
const after = cpustats();
const busy = after.map((stat, i) => {
  const total = Object.values(stat).reduce((a,b) => a+b) - Object.values(before[i]!).reduce((a,b) => a+b);
  return total ? 1 - (stat.idle - before[i]!.idle) / total : 0;
});
const samples: Array<{ route: string; ms: number; firstTimerMs: number; correct: boolean; query: string }> = [];
const stages: Array<{ retrievalMs: number; projectionMs: number; withPersonalMs: number; withoutPersonalMs: number }> = [];
const comparePersonalViews = process.env.DOTS_SCALE_SPLIT === "1";
const quality: Array<{ group: string; correct: boolean; expected?: string; returned?: string }> = [];
const summary = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  const pick = (p: number) => +(sorted[Math.ceil(p*sorted.length)-1] ?? 0).toFixed(2);
  return { n: sorted.length, min: pick(0.001), p50: pick(.5), p95: pick(.95), max: pick(1) };
};
const counts = () => db.connection.prepare("SELECT (SELECT count(*) FROM memory_records) atoms,(SELECT count(*) FROM memory_embeddings) vectors,(SELECT count(*) FROM memory_fts) fts").get() as {atoms:number;vectors:number;fts:number};
const writeReport = () => {
  const routes = Object.fromEntries([...new Set(samples.map(r => r.route))].map(name => {
    const rows = samples.filter(r => r.route === name);
    return [name, { latencyMs: summary(rows.map(r => r.ms)), firstTimerMs: summary(rows.map(r => r.firstTimerMs)), incorrect: rows.filter(r => !r.correct).length }];
  }));
  const categories = Object.fromEntries([...new Set(quality.map(r => r.group))].map(name => {
    const rows = quality.filter(r => r.group === name);
    return [name, { total: rows.length, correct: rows.filter(r => r.correct).length }];
  }));
  const report = { machine: { cpu: cpus()[0]?.model, logicalCores: cpus().length, platform: platform(), release: release(), arch: arch(),
    node: process.version, ramGiB: totalmem() / 2**30, initialCpuBusyFraction: busy.reduce((a,b) => a+b)/busy.length },
    fixture: counts(), timedWorkload: "Same 20 cases per route, interleaved order, 6 English/Chinese ID-free questions, 3 negative lookups and 11 positive identifier queries. One warmup per route is excluded. Raw samples include each query.", dimension, embedding: "Controlled normalized query vectors; persisted SQLite vector index, scope checks and ranking run in full. Neural inference and network excluded.",
    qualityProvenance: "Deterministic generated cases with independent predicate checks on current fact text, evidence and visible scope. No externally annotated or model answer quality claim.",
    routes, categories, samples, quality,
    providerStages: stages.length ? {
      retrievalMs: summary(stages.map(row => row.retrievalMs)),
      projectionMs: summary(stages.map(row => row.projectionMs)),
      withPersonalViewsMs: summary(stages.map(row => row.withPersonalMs)),
      withoutPersonalViewsMs: summary(stages.map(row => row.withoutPersonalMs)),
    } : undefined };
  writeFileSync(reportPath, JSON.stringify(report,null,2));
  return report;
};
try {
  db.openDots();
  db.upsertTask({ id: other, title: "Unrelated", updatedAt: 1 });
  const putVector = db.connection.prepare("INSERT INTO memory_embeddings VALUES(?,?,?,?,?,?,?)");
  const put = (id:string, contentHash:string, vector:Float32Array) => putVector.run(id,SEMANTIC_MODEL_ID,SEMANTIC_MODEL_VERSION,contentHash,dimension,Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength),1);
  for (let i=0;i<200;i++) {
    const group = ["current-fact","corrected-fact","wrong-owner","forgotten","unanswerable"][i%5]!;
    const token=key(i,"query");
    const natural = [
      ["青铜阀门的维护周期是多久？","青铜阀门维护周期"],
      ["What is the glacier team's handover location?","Glacier team handover location"],
      ["空运记录要采用什么温标？","空运记录采用摄氏温标"],
      ["What is the otter team's dispatch colour?","Otter team dispatch color"],
      ["发票结算的时间安排是什么？","发票结算时间安排"],
      ["Which delivery channel does Aurora prefer?","Aurora delivery channel preference"],
    ];
    const phrase = i % 5 < 2 ? natural[Math.floor(i / 5)*2 + i%5] : undefined;
    const query = phrase?.[0] ?? (i%10===0 || i%10===1 ? "Which protocol uses marker "+token+"?" : token);
    const source = key(i,"source"), content = key(i,"fact");
    vectors.set(query,i);
    const entry: Case = { group, query };
    if (group !== "unanswerable") {
      const saved = lexical.create({ title: phrase?.[1] ?? query, content: group === "corrected-fact" ? "obsolete" : content, kind: "fact",
        scopeType: "task", scopeId: group === "wrong-owner" ? other : DOTS_TASK_ID, sourceType:"user", evidence:[{evidenceKind:"message",refId:source}] });
      const current = group === "corrected-fact" ? lexical.update({ id:saved.id,content }) : saved;
      put(current.id,current.contentHash,testVector(i));
      if (group === "forgotten") lexical.forget(current.id);
      if (group === "corrected-fact" || group === "current-fact") Object.assign(entry,{ id:current.id,content,source });
    }
    cases.push(entry);
  }
  const template = lexical.create({title:"reference",content:"technical reference",kind:"fact",scopeType:"global",sourceType:"manual"});
  const fill = db.connection.prepare(`INSERT INTO memory_records SELECT ?,kind,?,?,'active',importance,confidence,explicit,source_type,
    source_id,source_task_id,valid_from,valid_until,?,created_at,updated_at,last_recalled_at,recall_count,metadata_json FROM memory_records WHERE id=?`);
  const bind = db.connection.prepare("INSERT INTO memory_scopes VALUES(?,?,?,?,?,?)");
  const filler = new Float32Array(dimension);
  // Distinct normalized vectors, deterministic across runs; no per-query preloaded score or nearest-neighbor table.
  let state = 0x13fd3b;
  const random = () => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state/2**32-.5; };
  db.connection.transaction(() => {
    for (let i=0,n=100000-counts().atoms+1;i<n;i++) {
      const id = i ? "ref-"+String(i).padStart(6,"0") : template.id;
      const body = "Archived calibration record "+key(i,"location")+" with source series "+key(i,"series")+".";
      const stamp = i ? hash(body) : template.contentHash;
      if(i) {
        fill.run(id,"Calibration "+key(i,"part"),body,stamp,template.id);
        bind.run("bind-"+i,id,i%2 ? "task" : "global",i%2 ? DOTS_TASK_ID : null,"owned",1);
      }
      let norm=0;
      for (let d=0;d<dimension;d++) { const value=random(); filler[d]=value; norm+=value*value; }
      const inverse=1/Math.sqrt(norm);
      for (let d=0;d<dimension;d++) filler[d]=filler[d]!*inverse;
      put(id,stamp,filler);
    }
  })();
  assert.deepEqual(counts(),{atoms:100000,vectors:100000,fts:100000});
  console.log("Seeded",counts());
  let embeddings=0;
  SemanticRuntime.prototype.embed=async query => { embeddings++; return testVector(vectors.get(query)!); };
  const valid = (row: Case, hits: ReturnType<MemoryService["search"]>) => row.id ?
    hits[0]?.memory.id===row.id && hits[0].memory.content===row.content && hits[0].memory.evidence.some(e => e.refId===row.source)
    : hits.length===0;
  const positives=cases.filter(row=>row.id);
  const routes=["lexical","hybrid","dots-provider-projection"] as const;
  for(let cycle=-1;cycle<20;cycle++){
    const row=cycle>=0 && cycle<6 ? positives[cycle]! : cycle>=6 && cycle<=8 ? cases[cycle-4]! : positives[(Math.max(0,cycle)*13)%positives.length]!;
    for(let step=0;step<routes.length;step++){
      const route=routes[(step+Math.max(0,cycle))%routes.length]!;
      const request={...scope,query:row.query};
      await delay(5);
      const start=performance.now(), tick=delay(0).then(()=>performance.now()-start);
      let correct:boolean;
      let compareStages: (() => void) | undefined;
      if(route==="dots-provider-projection"){
        const selected=await kernel.searchHybrid(memoryProjectionQuery(request));
        const projectionStart = performance.now();
        const projected=projectMemoryContext(kernel,request,selected);
        const projectionMs = performance.now() - projectionStart;
        correct=row.id ? projected.blocks.some(block=>block.sources.some(src=>src.id===row.id)&&block.text.includes(row.content!)) : projected.blocks.length===0;
        if (comparePersonalViews && cycle >= 0) compareStages = () => {
          // Reuse the exact same evidence so the pair isolates foreground view selection.
          const getContextSources = kernel.cognition.getContextSources;
          const order = cycle % 2 ? [true, false] : [false, true];
          const timings = new Map<boolean, number>();
          const outputs = new Map<boolean, string>();
          try {
            for (const personal of order) {
              kernel.cognition.getContextSources = personal ? getContextSources : function (input) {
                return getContextSources.call(this, { ...input, taskId: undefined });
              };
              const started = performance.now();
              const variant = projectMemoryContext(kernel, { ...request, trackRecall: false }, selected);
              timings.set(personal, performance.now() - started);
              outputs.set(personal, variant.text);
            }
          } finally { kernel.cognition.getContextSources = getContextSources; }
          assert.equal(outputs.get(true), outputs.get(false), "this fixture does not seed user-backed personal views");
          stages.push({ retrievalMs: projectionStart - start, projectionMs, withPersonalMs: timings.get(true)!,
            withoutPersonalMs: timings.get(false)! });
        };
      } else correct=valid(row, await (route==="lexical" ? lexical : kernel).searchHybrid(request));
      const ms=performance.now()-start, firstTimerMs=await tick;
      compareStages?.();
      if(cycle>=0) samples.push({route,ms,firstTimerMs,correct,query:row.query});
      assert(correct,route+" missed "+row.query);
    }
    if(cycle%5===0 || cycle===19) console.log("Timed cycles",cycle+1,writeReport().routes);
  }
  for(const row of cases){
    const hits=await kernel.searchHybrid({...scope,query:row.query});
    quality.push({group:row.group,correct:valid(row,hits),expected:row.id,returned:hits[0]?.memory.id});
    if(quality.length%40===0){writeReport();console.log("Quality",quality.length);}
  }
  assert.equal(embeddings,242);
  const report=writeReport();
  console.log(JSON.stringify({routes:report.routes,categories:report.categories,providerStages:report.providerStages}));
  assert.equal(quality.filter(row=>!row.correct).length,0);
  assert(Object.values(report.routes).every(route=>route.latencyMs.p95<=1000),"100k local retrieval p95 exceeded 1s; see "+reportPath);
} finally {
  SemanticRuntime.prototype.embed=embed; db.close(); rmSync(root,{recursive:true,force:true});
}
