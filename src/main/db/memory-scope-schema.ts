import type Database from "better-sqlite3";
import { LOCAL_USER_ID } from "../../shared/bot-work";

/**
 * Add durable assistant scopes in place. The application schema version stays
 * unchanged: bumping it without a complete migration would reset user data.
 * Only this leaf binding table is rebuilt; atoms, evidence, versions and source
 * history retain their IDs and content. No guessed ownership backfill occurs.
 */
export function ensureExtendedMemoryScopes(db: Database.Database): void {
  // No FK to memory_records: deletion must retain suppression provenance.
  db.exec(`CREATE TABLE IF NOT EXISTS memory_capture_receipts (
    source_key TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)), updated_at INTEGER NOT NULL
  )`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_scopes'").get() as { sql: string } | undefined;
  if (!row) return;
  if (["'team'", "'conversation'", "'work'"].every(token => row.sql.includes(token))) {
    attachReliableLegacyWorkScopes(db);
    return;
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE memory_scopes_expanded (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','task','bot','team','conversation','work')),
        scope_id TEXT, binding TEXT NOT NULL DEFAULT 'owned' CHECK (binding IN ('owned','promoted')), created_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      INSERT INTO memory_scopes_expanded (id,memory_id,scope_type,scope_id,binding,created_at)
        SELECT id,memory_id,scope_type,scope_id,binding,created_at FROM memory_scopes;
      DROP TABLE memory_scopes;
      ALTER TABLE memory_scopes_expanded RENAME TO memory_scopes;
      CREATE UNIQUE INDEX uq_memory_scope_binding ON memory_scopes(memory_id,scope_type,COALESCE(scope_id,''),binding);
      CREATE INDEX idx_memory_scopes_lookup ON memory_scopes(scope_type,scope_id,memory_id);
    `);
  })();
  attachReliableLegacyWorkScopes(db);
}

/** Add only proven ownership; retain original task bindings, atoms and evidence. */
export function attachReliableLegacyWorkScopes(db: Database.Database): void {
  for (const table of ['works', 'work_execution_bindings']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_capture_receipts (
    source_key TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)), updated_at INTEGER NOT NULL
  )`);
  db.transaction(() => {
    const candidates = db.prepare(`SELECT s.id,s.memory_id,mapping.work_id,s.created_at
      FROM memory_scopes s
      JOIN (SELECT task_id,MIN(work_id) AS work_id FROM work_execution_bindings
        GROUP BY task_id HAVING COUNT(DISTINCT work_id)=1) mapping ON mapping.task_id=s.scope_id
      JOIN works w ON w.work_id=mapping.work_id AND w.user_id=?
      WHERE s.scope_type='task'
        AND NOT EXISTS (SELECT 1 FROM memory_capture_receipts r WHERE r.source_key='legacy-work-scope:' || s.memory_id)
        AND NOT EXISTS (SELECT 1 FROM memory_scopes present WHERE present.memory_id=s.memory_id AND present.scope_type='work')
        AND NOT EXISTS (SELECT 1 FROM memory_scopes other
          JOIN work_execution_bindings ob ON ob.task_id=other.scope_id
          WHERE other.memory_id=s.memory_id AND other.scope_type='task' AND ob.work_id<>mapping.work_id)
      ORDER BY s.id`).all(LOCAL_USER_ID) as Array<{id:string;memory_id:string;work_id:string;created_at:number}>;
    const insert = db.prepare("INSERT OR IGNORE INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at) VALUES(?,?,'work',?,'owned',?)");
    const receipt = db.prepare("INSERT OR IGNORE INTO memory_capture_receipts(source_key,memory_id,content_hash,updated_at) VALUES(?,?,?,?)");
    for (const candidate of candidates) {
      if (insert.run(`work-migration:${candidate.id}`,candidate.memory_id,candidate.work_id,candidate.created_at).changes) {
        receipt.run(`legacy-work-scope:${candidate.memory_id}`,candidate.memory_id,candidate.work_id,Date.now());
      }
    }
  })();
}
