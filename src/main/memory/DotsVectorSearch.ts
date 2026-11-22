import type Database from "better-sqlite3";
import { setImmediate as yieldThread } from "node:timers/promises";
import { SEMANTIC_DIMENSION as dim, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../retrieval/SemanticModelManager";
import { searchEpoch } from "./MemorySearchEpoch";
import { memorySearchWhere, type MemorySearchScope } from "./MemorySearchScope";
import type { MemorySemanticHit } from "./MemorySemanticProvider";

interface Block { ids: string[]; scales: Float64Array; values: Int8Array }
const indexes = new WeakMap<Database.Database, { version: number; blocks: Block[] }>();
const building = new WeakMap<Database.Database, Promise<{version:number;blocks:Block[]}|undefined>>();
const tooLarge = new WeakMap<Database.Database,number>();
const blockSize = 128;
const maxVectors = 131072;

async function build(db: Database.Database, version: number) {
  const rows = db.prepare(`SELECT memory_id,embedding FROM memory_embeddings WHERE model_id=? AND model_version=?
    AND dimension=? AND length(embedding)=? AND memory_id>? ORDER BY memory_id LIMIT ${blockSize}`);
  let cursor = "", count = 0;
  const blocks: Block[] = [];
  while (db.open) {
    const page = rows.all(SEMANTIC_MODEL_ID,SEMANTIC_MODEL_VERSION,dim,dim*4,cursor) as Array<{memory_id:string;embedding:Buffer}>;
    if (!page.length) break;
    count += page.length;
    if (count > maxVectors) { tooLarge.set(db,version); return; }
    const block: Block = {ids:[],scales:new Float64Array(page.length),values:new Int8Array(page.length*dim)};
    page.forEach((row,index) => {
      block.ids.push(row.memory_id);
      const vector = new Float32Array(row.embedding.buffer,row.embedding.byteOffset,dim);
      let largest=0;
      for (let i=0;i<dim;i++) largest=Math.max(largest,Math.abs(vector[i]!));
      const scale=largest/127;
      block.scales[index]=scale;
      if (scale>0) for(let i=0;i<dim;i++) block.values[index*dim+i]=Math.round(vector[i]!/scale);
    });
    blocks.push(block);
    cursor=page.at(-1)!.memory_id;
    await yieldThread();
  }
  if (!db.open || searchEpoch(db,"vector_version") !== version) return;
  const value = {version,blocks};
  indexes.set(db,value);
  return value;
}

/** Quantization only supplies an upper bound. SQLite verifies scope and the original float32 score before every accepted result. */
export async function searchDotsVectors(db: Database.Database, query: Float32Array, scope: MemorySearchScope,
  accept: (id:string,hash:string)=>boolean, keep:number, threshold:number):Promise<MemorySemanticHit[]|undefined> {
  if (query.length !== dim) return;
  const version = searchEpoch(db,"vector_version");
  let index=indexes.get(db);
  if ((!index || index.version !== version) && !building.has(db) && tooLarge.get(db) !== version) {
    const pending = build(db,version);
    building.set(db,pending);
    try { index=await pending; } finally { building.delete(db); }
  }
  if (!index || index.version !== version) return;
  const where=memorySearchWhere(scope);
  const read=db.prepare(`SELECT e.embedding,e.content_hash FROM memory_embeddings e JOIN memory_records m ON m.id=e.memory_id
    WHERE e.memory_id=? AND e.model_id=? AND e.model_version=? AND e.dimension=? AND length(e.embedding)=?
    AND m.content_hash=e.content_hash AND ${where.sql}`);
  const hits:MemorySemanticHit[]=[];
  let queryAbs=0;
  for(const value of query) queryAbs+=Math.abs(value);
  let started=performance.now();
  for(const block of index.blocks){
    for(let j=0;j<block.ids.length;j++){
      let dot=0;
      const offset=j*dim;
      for(let i=0;i<dim;i++) dot+=query[i]!*block.values[offset+i]!;
      const scale=block.scales[j]!;
      // |q·(v-vq)| <= ||q||1 * scale/2. Include floating-point accumulation error in the outward bound.
      const bound=dot*scale+(0.500001*queryAbs+1e-9)*scale;
      if(bound < (hits.length===keep ? hits.at(-1)!.score : threshold)) continue;
      const id=block.ids[j]!;
      const row=read.get(id,SEMANTIC_MODEL_ID,SEMANTIC_MODEL_VERSION,dim,dim*4,...where.args) as {embedding:Buffer;content_hash:string}|undefined;
      if (!row) continue;
      const original=new Float32Array(row.embedding.buffer,row.embedding.byteOffset,dim);
      let score=0;
      for(let i=0;i<dim;i++) score+=query[i]!*original[i]!;
      if (!Number.isFinite(score) || score<threshold || !accept(id,row.content_hash)) continue;
      hits.push({memoryId:id,contentHash:row.content_hash,score});
      hits.sort((a,b)=>b.score-a.score || a.memoryId.localeCompare(b.memoryId));
      if(hits.length>keep) hits.pop();
    }
    if(performance.now()-started>4){await yieldThread(); if(!db.open)return []; started=performance.now();}
  }
  if (version!==searchEpoch(db,"vector_version")) return;
  const current=memorySearchWhere(scope);
  const exists=db.prepare(`SELECT 1 FROM memory_records m WHERE m.id=? AND m.content_hash=? AND ${current.sql}`);
  return hits.filter(hit=>Boolean(exists.get(hit.memoryId,hit.contentHash,...current.args)) && accept(hit.memoryId,hit.contentHash));
}
