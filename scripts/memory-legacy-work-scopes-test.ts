import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { attachReliableLegacyWorkScopes } from '../src/main/db/memory-scope-schema';
import { LOCAL_USER_ID } from '../src/shared/bot-work';
export function testLegacyWorkScopeOwnership() {
  let db=new Database(':memory:');
  try {
    attachReliableLegacyWorkScopes(db); // optional Work schema absent
    db.exec(`CREATE TABLE works(work_id TEXT PRIMARY KEY,user_id TEXT);
      CREATE TABLE work_execution_bindings(task_id TEXT,work_id TEXT);
      CREATE TABLE memory_scopes(id TEXT PRIMARY KEY,memory_id TEXT,scope_type TEXT,scope_id TEXT,binding TEXT,created_at INTEGER);
      CREATE UNIQUE INDEX uq_scope ON memory_scopes(memory_id,scope_type,scope_id,binding);`);
    for(const id of ['w1','w2']) db.prepare('INSERT INTO works VALUES(?,?)').run(id,LOCAL_USER_ID);
    db.prepare('INSERT INTO works VALUES(?,?)').run('foreign','other-user');
    for(const [task,work] of [['t1','w1'],['t1','w1'],['ambiguous','w1'],['ambiguous','w2'],['foreign-task','foreign'],['orphan','missing'],['t2','w2']])
      db.prepare('INSERT INTO work_execution_bindings VALUES(?,?)').run(task,work);
    for(const [id,task] of [['reliable','t1'],['ambiguous','ambiguous'],['foreign','foreign-task'],['orphan','orphan'],['unmapped','no-binding']])
      db.prepare("INSERT INTO memory_scopes VALUES(?,?,'task',?,'owned',123)").run(id,id,task);
    for(const task of ['t1','t2']) db.prepare("INSERT INTO memory_scopes VALUES(?,'conflict','task',?,'owned',123)").run('conflict-'+task,task);
    const before=db.prepare("SELECT * FROM memory_scopes WHERE scope_type='task' ORDER BY id").all();
    attachReliableLegacyWorkScopes(db);
    const migrated=db.prepare("SELECT * FROM memory_scopes WHERE scope_type='work'").all();
    assert.deepEqual(migrated,[{id:'work-migration:reliable',memory_id:'reliable',scope_type:'work',scope_id:'w1',binding:'owned',created_at:123}]);
    assert.deepEqual(db.prepare("SELECT * FROM memory_scopes WHERE scope_type='task' ORDER BY id").all(),before);
    attachReliableLegacyWorkScopes(db);
    assert.deepEqual(db.prepare("SELECT * FROM memory_scopes WHERE scope_type='work'").all(),migrated);
    db.prepare("DELETE FROM memory_scopes WHERE memory_id='reliable' AND scope_type='work'").run();
    const reopened = db.serialize(); db.close(); db = new Database(reopened);
    attachReliableLegacyWorkScopes(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_scopes WHERE scope_type='work'").get() as {n:number}).n,0,'detached migrated Work scope must not be restored on materialization');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_scopes WHERE memory_id='reliable' AND scope_type='task'").get() as {n:number}).n,1);
    // A source without a mapping was not marked complete and can migrate once reliable evidence arrives.
    db.prepare("INSERT INTO work_execution_bindings VALUES('no-binding','w1')").run();
    attachReliableLegacyWorkScopes(db);
    assert.equal((db.prepare("SELECT scope_id FROM memory_scopes WHERE memory_id='unmapped' AND scope_type='work'").get() as {scope_id:string}).scope_id,'w1');
    const cutoff=(db.prepare("SELECT updated_at FROM memory_capture_receipts WHERE source_key='migration:legacy-work-scopes:v1'").get() as {updated_at:number}).updated_at;
    db.prepare("INSERT INTO memory_scopes VALUES('future','future','task','t1','owned',?)").run(cutoff+1);
    attachReliableLegacyWorkScopes(db);
    assert.equal(db.prepare("SELECT 1 FROM memory_scopes WHERE memory_id='future' AND scope_type='work'").get(),undefined,'new explicit task-local memory must not be migrated');
    console.log('Legacy Work scope migration passed: unique ownership only, conflicts/foreign/missing excluded, original bindings retained, idempotence');
  } finally {db.close();}
}
