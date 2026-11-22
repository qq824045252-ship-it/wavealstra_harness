import { restoreAnswerProgress } from "./dots-memory-answer-checkpoint";
import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { DOTS_TASK_ID } from "../src/shared/dots";

let withheldChunks = 0;
const out = "out/tests";
const filename = join(out,"longmemeval_s_cleaned.json");
const origin = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json";
const expectedHash = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
mkdirSync(out,{recursive:true});
if (!existsSync(filename)) {
  const result = await fetch(origin);
  if (!result.ok) throw new Error(`Could not download LongMemEval-S: HTTP ${result.status}`);
  const bytes=Buffer.from(await result.arrayBuffer());
  if(createHash("sha256").update(bytes).digest("hex")!==expectedHash) throw new Error("Downloaded dataset hash mismatch");
  writeFileSync(filename,bytes);
}
const bytes=readFileSync(filename);
if(createHash("sha256").update(bytes).digest("hex")!==expectedHash) throw new Error("Dataset hash mismatch: "+filename);
type Item={question_id:string; question_type:string;question:string;question_date:string;answer:string|number; answer_session_ids:string[];
  haystack_session_ids:string[];haystack_dates:string[];haystack_sessions:Array<Array<{role:string;content:string}>>};
const corpus=JSON.parse(bytes.toString("utf8")) as Item[];
const group=(row:Item)=>row.question_id.endsWith("_abs") ? "abstention" : row.question_type;
const groups = [...new Set(corpus.map(group))].sort();
const bins=groups.map(name=>corpus.filter(row=>group(row)===name).sort((a,b)=>a.question_id.localeCompare(b.question_id)));
const sample:Item[]=[];
for(let round=0; sample.length<200; round++) for(const bin of bins) if(bin[round] && sample.length<200) sample.push(bin[round]!);
const mode = process.env.DOTS_MEMORY_EVAL_MODE ?? "lexical";
const pilot = ["answer-pilot", "answer-holdout", "answer-time-holdout", "answer-tool-holdout", "answer-fresh"].includes(mode);
const generated = pilot || mode === "answer-full";
if (!generated && !["lexical","semantic-pilot","semantic-full"].includes(mode)) throw new Error("Unknown DOTS_MEMORY_EVAL_MODE");
const semantic = mode.startsWith("semantic-");
if (semantic && process.env.DOTS_MEMORY_EVAL_MODEL_DIR) {
  const installed = resolve(process.env.DOTS_MEMORY_EVAL_MODEL_DIR);
  const isolated = join(homedir(), ".mybuddy", "models", "semantic", "bge-m3-int8-v1");
  if (!existsSync(join(installed,"manifest.json"))) throw new Error("Installed model manifest missing: "+installed);
  if (!existsSync(isolated)) { mkdirSync(dirname(isolated),{recursive:true}); symlinkSync(installed,isolated,"junction"); }
}
const pilotCases = ["single-session-user","abstention"].map(category => sample.find(item=>group(item)===category)!);
const timeHoldout=corpus.find(item=>item.question_id==="b46e15ed");
if (mode==="answer-time-holdout" && (!timeHoldout || sample.includes(timeHoldout))) throw new Error("Time holdout must be outside the 200 scored questions");
const toolHoldout = ["46a3abf7","4adc0475"].map(id=>corpus.find(item=>item.question_id===id)!);
if(mode==="answer-tool-holdout" && toolHoldout.some(item=>!item || sample.includes(item) || item.answer_session_ids.length<2)) throw new Error("Multi-source holdout is not independent");
// Select from unseen IDs only. Both the selection and its order are independent
// of the questions' wording, gold answers, sources and retrieval results.
const seenIds = new Set([...sample, ...toolHoldout, timeHoldout!].map(item => item.question_id));
const freshKey = (item: Item) => createHash("sha256").update("dots-recall-fresh-v1/" + item.question_id).digest("hex");
const fresh = bins.flatMap(bin => bin.filter(item => !seenIds.has(item.question_id))
  .sort((a,b) => freshKey(a).localeCompare(freshKey(b))).slice(0,3));
const selected = mode === "answer-fresh" ? fresh : mode === "answer-tool-holdout" ? toolHoldout : mode === "answer-time-holdout" ? [timeHoldout!] : mode === "answer-holdout" ? [...pilotCases,bins[groups.indexOf("abstention")]![1]!]
  : mode === "answer-pilot" ? pilotCases : mode === "semantic-pilot"
  ? ["multi-session","single-session-user"].map(category => sample.find(item => group(item)===category)!) : sample;
const firstQuestion = process.env.DOTS_MEMORY_ANSWER_FIRST;
if(mode==="answer-full" && firstQuestion) {
  const i = selected.findIndex(item=>item.question_id===firstQuestion);
  if(i<0) throw new Error("First question is not in the pinned sample");
  selected.unshift(...selected.splice(i,1));
}
let indexedVectors = 0;
const rows:Array<{id:string;category:string;sourceRecall:boolean;answerCovered:boolean;combined:boolean;returned:number;sourceCount:number}>=[];
const normalize=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
function report() {
  const summarize=(list:typeof rows)=>({ cases:list.length,completeGoldSources:list.filter(row=>row.sourceRecall).length,
    exactAnswerCoverage:list.filter(row=>row.answerCovered).length,combined:list.filter(row=>row.combined).length });
  const summary={ withheldSensitiveChunks:withheldChunks, mode, indexedVectors, source:origin,sha256:expectedHash,authors:"Di Wu et al., LongMemEval (ICLR 2025)",license:"MIT",
    sample: mode==="semantic-pilot" ? "First question by sorted ID from multi-session and single-session-user, with all original distractors." : "200 unique question IDs, round-robin across answer types and abstention, ordered by ID within each bin",
    route:(semantic ? "Canonical Dots local BGE-M3 hybrid search" : "Canonical Dots scoped lexical search") + " over all original session messages. Each message becomes source-linked chunks. The index sees role, date and original text only. No answer-session labels are used to construct or retrieve candidates.",
    metrics:"Top 5 retrieved source atoms. Sources require every gold session. Factual coverage requires the normalized gold answer to occur in retrieved gold-source text. Abstention requires zero hits. This is extractive retrieval with a strict literal judge; free-form generation, arithmetic and semantic equivalence are not graded.",
    total:summarize(rows),byCategory:Object.fromEntries(groups.map(name=>[name,summarize(rows.filter(row=>row.category===name))])),rows };
  writeFileSync(join(out,semantic ? `dots-memory-longmemeval-${mode}.json` : "dots-memory-longmemeval.json"),JSON.stringify(summary,null,2));
  return summary;
}
const generatedRows: Array<Record<string,unknown>> = [];
const suffix = process.env.DOTS_MEMORY_ANSWER_RUN;
if (generated && suffix && !/^[a-zA-Z0-9_-]{1,60}$/.test(suffix)) throw new Error("Invalid DOTS_MEMORY_ANSWER_RUN");
const reportStem = join(out,`dots-memory-longmemeval-${mode}${suffix ? "-"+suffix : ""}`);
const partition = process.env.DOTS_MEMORY_ANSWER_PART;
const mergeParts = process.env.DOTS_MEMORY_MERGE_PARTS;
if ((partition || mergeParts) && (mode !== "answer-full" || !suffix || (partition && mergeParts))) throw new Error("Partitions require a named full run");
if (partition && !/^[1-4]of[2-4]$/.test(partition)) throw new Error("Invalid partition, expected e.g. 1of3");
if (mergeParts && !/^[2-4]$/.test(mergeParts)) throw new Error("Unsupported partition count");
const [part, count] = partition?.split("of").map(Number) ?? [1,Number(mergeParts ?? 1)];
if (part! > count!) throw new Error("Partition exceeds partition count");
const partitionCases = (number: number) => selected.filter((_,index) => index % count! === number-1);
const assigned = partition ? partitionCases(part!) : selected;
const generatedPath = reportStem + (partition ? "-part"+partition : "") + ".json";
const pilotRun = randomUUID();
const immutablePilot = join(out,`dots-memory-longmemeval-${mode}-${pilotRun}.json`);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let conditions: Record<string,unknown> | undefined;
const resume = mode === "answer-full";
const lock = generated ? new Database(generatedPath+".lock.sqlite",{timeout:0}) : undefined;
if (lock) lock.exec("BEGIN EXCLUSIVE");
if (generated) {
  const {configuredAnswerModel} = await import("./dots-memory-generated-answer");
  const {modelId,selected:providerConfig,provider}=configuredAnswerModel();
  conditions = { dataset:expectedHash,questions:digest(JSON.stringify(selected.map(i=>i.question_id))),modelId,provider,
    providerConfig:digest(JSON.stringify(providerConfig)),declaredModelRevision:process.env.DOTS_MEMORY_MODEL_REVISION??null,
    bundle:digest(readFileSync(process.argv[1]!)),lockfile:digest(readFileSync("pnpm-lock.yaml")),node:process.version,platform:process.platform,architecture:process.arch,
    questionTime:"verbatim dataset question_date; no implied timezone",recallInput:"original user question in displayText, response protocol and time in model text",grading:"strict short-answer equality v2; source witnesses and optional L1 display label; free-form mismatches pending human review"};
  if (resume && existsSync(generatedPath)) {
    const prev=JSON.parse(readFileSync(generatedPath,"utf8"));
    generatedRows.push(...restoreAnswerProgress(prev,conditions,new Set(assigned.map(i=>i.question_id))));
  }
  if (mergeParts) {
    const merged = new Map<string, (typeof generatedRows)[number]>();
    for (let number=1; number<=count!; number++) {
      const key = number+"of"+count;
      const partial = JSON.parse(readFileSync(reportStem+"-part"+key+".json","utf8"));
      if (partial.partition !== key) throw new Error("Incorrect partition marker: "+key);
      const expected = new Set(partitionCases(number).map(item => item.question_id));
      const rows = restoreAnswerProgress(partial,conditions,expected);
      if (rows.length !== expected.size) throw new Error("Incomplete partition: "+key);
      for (const row of rows) merged.set(row.id,row);
    }
    if (merged.size !== selected.length) throw new Error("Incomplete full sample");
    generatedRows.splice(0,generatedRows.length,...selected.map(item => merged.get(item.question_id)!));
  }
}
const completedIds = new Set(generatedRows.map(row=>row.id));
if (generated && process.env.DOTS_MEMORY_ANSWER_INSPECT === "1") {
  console.log(JSON.stringify({mode,conditions,planned:assigned.length,completed:completedIds.size,remaining:assigned.length-completedIds.size,checkpoint:generatedPath,providerRequests:0}));
  lock?.close(); process.exit(0);
}
function atomicReport(path:string, data:string){
  const temp=path+"."+process.pid+".tmp";
  writeFileSync(temp,data,{flush:true});
  renameSync(temp,path);
}
function saveGenerated() {
  const json=JSON.stringify({conditions,pilotRun:pilot?pilotRun:undefined,source:origin,sha256:expectedHash,mode,selection:"same pinned independent questions, complete distractor conversations, opaque evidence handles; pilot selects first single-session-user and abstention by sorted question ID; answer-holdout adds the next sorted abstention; answer-time-holdout uses the preregistered unseen question b46e15ed; answer-tool-holdout uses preregistered unseen multi-session questions 46a3abf7 and 4adc0475",
    ...(mode==="answer-fresh" ? { selection:"Up to three previously unexamined questions in each category, chosen by seeded hash of opaque IDs after excluding the original 200 and all prior holdouts.", selectedIds:selected.map(item => item.question_id) } : {}),
    partition,
    scoring:"Answerable cases require a normalized exact short answer plus exact annotated source sessions backed by actual provider-visible memory versions. Abstention requires null and abstain=true; cited counterevidence must belong to annotated sessions. Other free-form answers require human adjudication.",
    byCategory:Object.fromEntries(groups.map(category=>{const rows=generatedRows.filter(row=>row.category===category);return [category,{cases:rows.length,strictFact:rows.filter(r=>r.factCorrect).length,freeformAwaitingReview:rows.filter(r=>r.requiresFactReview).length,source:rows.filter(r=>r.sourceCorrect).length,abstentionDecision:rows.filter(r=>r.abstentionCorrect).length,combined:rows.filter(r=>r.combined).length}]})),rows:generatedRows},null,2);
  atomicReport(generatedPath,json);
  if(pilot) atomicReport(immutablePilot,json);
}
if(generated) saveGenerated();
for(const item of assigned) {
  if(generated && completedIds.has(item.question_id)) continue;
  const db=new AppDatabase(":memory:");
  try {
    db.openDots();
    const memory=new MemoryService(db,{semantic:false});
    const lineage = new Map<string,string>();
    db.connection.transaction(()=>{
      for(const [session,turns] of item.haystack_sessions.entries()) for(const [turnIndex,turn] of turns.entries()){
        for(let start=0;start<turn.content.length;start+=1400){
          const chunk=turn.content.slice(start,start+1600);
          const refId=item.haystack_session_ids[session]!;
          try { const saved=memory.create({title:turn.role+" "+item.haystack_dates[session],content:chunk,kind:"fact",sourceType:"manual",
            scopeType:"task",scopeId:DOTS_TASK_ID,evidence:[{evidenceKind:"message",refId:generated ? createHash("sha256").update(refId).digest("hex") : refId,refTitle:`turn ${turnIndex+1}`}]}); if(generated) lineage.set(saved.id+"@"+memory.history(saved.id)[0]!.revision,refId); } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("疑似敏感秘密")) throw error;
            withheldChunks++;
          }
        }
      }
    })();
    if(generated){
      console.log("Dots real answer", item.question_id);
      const {realDotsAnswer} = await import("./dots-memory-generated-answer");
      try {
        const response = await realDotsAnswer(db,item.question,item.question_date,String(conditions?.providerConfig));
        let parsed: {answer?:unknown;citations?:unknown;abstain?:unknown} = {};
        try { parsed=JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/gi,"")); } catch {}
        const cites=Array.isArray(parsed.citations) ? parsed.citations.map(c=>typeof c==="string" ? c.trim().replace(/^\[?L1\s+([a-zA-Z0-9_-]+@\d+)\]?$/,"$1") : c) : [];
        const citationsValid=Array.isArray(parsed.citations) && cites.every(c=>typeof c==="string" && response.witnessed.includes(c) && lineage.has(c));
        const citedSessions=[...new Set(cites.map(c=>lineage.get(c)))];
        const citedPassages = cites.filter((c):c is string=>typeof c==="string"&&lineage.has(c)).map(reference=>{
          const record=memory.get(reference.split("@")[0]!);
          return {reference,session:lineage.get(reference),turn:record?.evidence[0]?.refTitle,text:[...(response.excerpts.get(reference) ?? [])].join("\n")};
        });
        const noAnswer=group(item)==="abstention";
        const abstentionCorrect=parsed.abstain===noAnswer;
        const factCorrect=noAnswer ? parsed.answer===null && parsed.abstain===true : typeof parsed.answer==="string" && normalize(parsed.answer)===normalize(String(item.answer));
        const sourceCorrect=citationsValid && citedSessions.every(s=>s!==undefined&&item.answer_session_ids.includes(s)) && (noAnswer || item.answer_session_ids.every(s=>citedSessions.includes(s)));
        const visiblePassages = [...response.excerpts].map(([reference,shown]) => ({reference,session:lineage.get(reference),shown:[...shown]}));
        generatedRows.push({id:item.question_id,category:group(item),model:response.modelId,dispatchedModel:response.attemptedModel,question:item.question,questionDate:item.question_date,actual:response.text,expected:item.answer,witnessed:response.witnessed,visiblePassages,requests:response.requests,tools:response.toolReceipts,citedSessions,citedPassages,expectedSessions:item.answer_session_ids,requiresFactReview:!noAnswer && !factCorrect && parsed.abstain===false,factCorrect,sourceCorrect,abstentionCorrect,combined:factCorrect&&sourceCorrect&&abstentionCorrect});
      } catch (error) {generatedRows.push({id:item.question_id,category:group(item),executionFailure:error instanceof Error ? error.message : "unknown failure"}); saveGenerated(); throw error;}
      saveGenerated(); continue;
    }
    const reader = semantic ? new MemoryService(db) : memory;
    if (semantic) {
      const size = db.connection.prepare("SELECT count(*) FROM memory_records WHERE status='active'").pluck().get() as number;
      let pending = size;
      while (pending > 0) {
        const progress = await reader.reindexSemantic(64);
        if (progress.issue || progress.failed || progress.pending >= pending) throw new Error("Semantic index failed: "+JSON.stringify(progress));
        pending = progress.pending;
        console.log(item.question_id, "persisted vectors", size - pending, "/", size);
      }
      indexedVectors += size;
    }
    const hits=await reader.searchHybrid({taskId:DOTS_TASK_ID,query:item.question,limit:5,statuses:["active"]}, reason=>{if(semantic) throw new Error("Semantic fallback: "+reason);});
    const sources=new Set(hits.flatMap(hit=>hit.memory.evidence.map(e=>e.refId)));
    const sourceRecall=item.answer_session_ids.every(id=>sources.has(id));
    const goldHits=hits.filter(hit=>hit.memory.evidence.some(e=>item.answer_session_ids.includes(e.refId)));
    const normalized=normalize(String(item.answer));
    const answerCovered=item.question_id.endsWith("_abs") ? hits.length===0 :
      normalized.length>0 && goldHits.some(hit=>(" "+normalize(hit.memory.content)+" ").includes(" "+normalized+" "));
    rows.push({id:item.question_id,category:group(item),sourceRecall,answerCovered,combined:group(item)==="abstention" ? answerCovered : sourceRecall&&answerCovered,returned:hits.length,sourceCount:item.answer_session_ids.length});
  } finally {db.close();}
  if(semantic || rows.length%20===0){console.log("LongMemEval-S",rows.length);report();}
}
if(generated) {
  saveGenerated();
  console.log(JSON.stringify({cases:generatedRows.length,combined:generatedRows.filter(r=>r.combined).length,report:generatedPath}));
  if(mode==="answer-full" && !partition && generatedRows.filter(r=>r.combined).length/generatedRows.length<.95) throw new Error("Independent generated-answer acceptance below 95%");
} else {
const final=report();
console.log(JSON.stringify({total:final.total,byCategory:final.byCategory}));
if(mode!=="semantic-pilot" && final.total.combined/final.total.cases<.95) throw new Error("Independent extractive fact/source coverage below 95%; see out/tests/dots-memory-longmemeval.json");

}

lock?.close();
