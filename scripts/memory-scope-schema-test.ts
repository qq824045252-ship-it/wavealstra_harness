import { testLegacyWorkScopeOwnership } from "./memory-legacy-work-scopes-test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ensureExtendedMemoryScopes } from "../src/main/db/memory-scope-schema";
import { MEMORY_SCOPE_TYPES } from "../src/shared/memory-kernel";

/** Normal close/reopen migration, never a process crash or fault injection. */
export function testExtendedMemoryScopes(): void {
  testLegacyWorkScopeOwnership();
  const root = mkdtempSync(join(tmpdir(), "mybuddy-memory-scope-migration-"));
  const path = join(root, "app.db");
  const legacyTypes = ["global", "workspace", "project", "task", "bot"];
  let app: AppDatabase | undefined;
  try {
    app = new AppDatabase(path);
    app.connection.exec(`
      CREATE TABLE untouched_sentinel (value TEXT NOT NULL);
      INSERT INTO untouched_sentinel VALUES ('keep unrelated user data');
      INSERT INTO memory_records (id,kind,title,content,content_hash,created_at,updated_at)
        VALUES ('existing-atom','fact','existing title','existing content','existing-hash',100,101);
      INSERT INTO memory_evidence (id,memory_id,evidence_kind,ref_id,excerpt,created_at)
        VALUES ('existing-evidence','existing-atom','conversation','old-conversation','original evidence',100);
      DROP TABLE memory_scopes;
      CREATE TABLE memory_scopes (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','task','bot')),
        scope_id TEXT, binding TEXT NOT NULL DEFAULT 'owned' CHECK (binding IN ('owned','promoted')), created_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX uq_memory_scope_binding ON memory_scopes(memory_id,scope_type,COALESCE(scope_id,''),binding);
      CREATE INDEX idx_memory_scopes_lookup ON memory_scopes(scope_type,scope_id,memory_id);
    `);
    const insert = app.connection.prepare("INSERT INTO memory_scopes (id,memory_id,scope_type,scope_id,binding,created_at) VALUES (?, 'existing-atom', ?, ?, ?, 100)");
    for (const type of legacyTypes) insert.run(`old-${type}`, type, type === "global" ? null : `old-${type}-id`, type === "bot" ? "promoted" : "owned");
    const oldBindings = app.connection.prepare("SELECT * FROM memory_scopes ORDER BY id").all();
    const oldAtom = app.connection.prepare("SELECT * FROM memory_records WHERE id='existing-atom'").get();
    const oldEvidence = app.connection.prepare("SELECT * FROM memory_evidence WHERE id='existing-evidence'").get();
    app.close(); app = undefined;

    app = new AppDatabase(path);
    assert.equal(app.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(readdirSync(root).some(name => name.includes("discarded")), false, "compatible scope extension must not reset the database");
    assert.deepEqual(app.connection.prepare("SELECT * FROM memory_scopes ORDER BY id").all(), oldBindings, "all old IDs, ownership, binding and timestamps preserved");
    assert.deepEqual(app.connection.prepare("SELECT * FROM memory_records WHERE id='existing-atom'").get(), oldAtom);
    assert.deepEqual(app.connection.prepare("SELECT * FROM memory_evidence WHERE id='existing-evidence'").get(), oldEvidence);
    assert.equal((app.connection.prepare("SELECT value FROM untouched_sentinel").get() as { value: string }).value, "keep unrelated user data");
    const write = app.connection.prepare("INSERT INTO memory_scopes (id,memory_id,scope_type,scope_id,binding,created_at) VALUES (?, 'existing-atom', ?, ?, 'owned', 200)");
    for (const type of ["team", "conversation", "work"]) {
      assert(MEMORY_SCOPE_TYPES.includes(type as never));
      write.run(`new-${type}`, type, `${type}-id`);
      assert.throws(() => write.run(`invalid-null-${type}`, type, null), /CHECK/);
      assert.throws(() => write.run(`invalid-blank-${type}`, type, " "), /CHECK/);
      assert.throws(() => write.run(`duplicate-${type}`, type, `${type}-id`), /UNIQUE/);
    }
    assert.throws(() => write.run("unknown", "unknown_scope", "id"), /CHECK/);
    assert.throws(() => write.run("global-id", "global", "invalid"), /CHECK/);
    const allBindings = app.connection.prepare("SELECT * FROM memory_scopes ORDER BY id").all();
    ensureExtendedMemoryScopes(app.connection);
    assert.deepEqual(app.connection.prepare("SELECT * FROM memory_scopes ORDER BY id").all(), allBindings, "materialization is idempotent");
    app.close(); app = new AppDatabase(path);
    assert.deepEqual(app.connection.prepare("SELECT * FROM memory_scopes ORDER BY id").all(), allBindings, "second normal open preserves all bindings");
    assert.deepEqual(app.connection.pragma("foreign_key_check"), []);
    app.connection.prepare("DELETE FROM memory_records WHERE id='existing-atom'").run();
    assert.equal((app.connection.prepare("SELECT COUNT(*) n FROM memory_scopes").get() as { n: number }).n, 0, "FK cascade remains active after table replacement");
    console.log("Memory scope extension: legacy preservation, new scope constraints, idempotence and FK cascade passed");
  } finally {
    app?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
