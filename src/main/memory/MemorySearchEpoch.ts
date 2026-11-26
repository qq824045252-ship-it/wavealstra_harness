import type Database from "better-sqlite3";
import { DOTS_TASK_ID } from "../../shared/dots";
import type { MemorySearchScope } from "./MemorySearchScope";

/** SQLite owns invalidation across connections and transactions, including direct import and scope edits. */
export function ensureMemorySearchEpoch(db: Database.Database): void {
  if (db.readonly) return;
  db.exec("CREATE TABLE IF NOT EXISTS memory_search_epoch(id INTEGER PRIMARY KEY CHECK(id=1),text_version INTEGER NOT NULL,vector_version INTEGER NOT NULL); INSERT OR IGNORE INTO memory_search_epoch VALUES(1,0,0)");
  for (const [table, column, fields] of [
    ["memory_records","text_version","title,content,content_hash,kind,status,importance,updated_at,valid_from,valid_until"],
    ["memory_scopes","text_version","memory_id,scope_type,scope_id,binding"],
    ["memory_embeddings","vector_version","memory_id,embedding,dimension,content_hash,model_id,model_version"],
  ] as const) {
    for (const operation of ["INSERT","DELETE","UPDATE"] as const) {
      const event = operation === "UPDATE" ? "UPDATE OF "+fields : operation;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_search_${operation} AFTER ${event} ON ${table}
        BEGIN UPDATE memory_search_epoch SET ${column}=${column}+1 WHERE id=1; END`);
    }
  }
}

export function isDotsSearch(scope: MemorySearchScope): boolean {
  return scope.scopes.some(item => item.scopeType === "task" && item.scopeId === DOTS_TASK_ID);
}

export function searchEpoch(db: Database.Database, type: "text_version" | "vector_version"): number {
  return db.prepare(`SELECT ${type} FROM memory_search_epoch WHERE id=1`).pluck().get() as number;
}
