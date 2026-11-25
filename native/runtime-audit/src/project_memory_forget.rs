use crate::Result;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawalTarget {
    fingerprint: String,
    text_length: i64,
    value_fingerprint: String,
    guard_fingerprint: Option<String>,
    guard_length: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawal {
    signature: String,
    pub cutoff_at: i64,
    targets: Vec<WithdrawalTarget>,
}

fn withdrawal_source(
    db: &Connection,
    project: &str,
    memory_id: Option<&str>,
) -> rusqlite::Result<String> {
    db.query_row(
        "SELECT json_group_array(json_object(
           'id', m.id, 'title', m.title, 'content', m.content,
           'revisions', json((SELECT json_group_array(json_object('title', r.title, 'content', r.content))
             FROM (SELECT title,content FROM memory_revisions WHERE memory_id=m.id ORDER BY revision DESC) r)),
           'evidence', json((SELECT json_group_array(json_object('excerpt', e.excerpt))
             FROM (SELECT excerpt FROM memory_evidence WHERE memory_id=m.id ORDER BY created_at,rowid) e))))
         FROM (SELECT id,title,content FROM memory_records
           WHERE id IN (SELECT memory_id FROM memory_scopes WHERE scope_type='project' AND scope_id=?1)
             AND (?2 IS NULL OR id=?2)
           ORDER BY id) m",
        params![project, memory_id],
        |row| row.get(0),
    )
}

fn signature(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

pub fn snapshot(db: &Connection, project: &str, memory_id: Option<&str>) -> Result<Value> {
    let source = withdrawal_source(db, project, memory_id)?;
    Ok(json!({
        "signature": signature(&source),
        "records": serde_json::from_str::<Value>(&source)?,
    }))
}

pub fn is_current(
    db: &Connection,
    project: &str,
    memory_id: Option<&str>,
    withdrawal: &Withdrawal,
) -> rusqlite::Result<bool> {
    Ok(signature(&withdrawal_source(db, project, memory_id)?) == withdrawal.signature)
}

pub fn invalidate_projections(db: &Connection, project: &str, now: i64) -> rusqlite::Result<()> {
    for table in ["memory_scenarios", "memory_core_profiles"] {
        db.execute(
            &format!(
                "UPDATE {table} SET status='stale',updated_at=?2
              WHERE scope_type='project' AND scope_id=?1 AND status='active'"
            ),
            params![project, now],
        )?;
    }
    Ok(())
}

pub fn detach(
    db: &Connection,
    project: &str,
    memory_id: Option<&str>,
    withdrawal: &Withdrawal,
) -> rusqlite::Result<()> {
    let mut put = db.prepare(
        "INSERT INTO memory_forget_targets(scope_type,scope_id,fingerprint,text_length,cutoff_at,
             allowed_message_id,value_fingerprint,guard_fingerprint,guard_length)
         VALUES ('project',?1,?2,?3,?4,NULL,?5,?6,?7)
         ON CONFLICT(scope_type,scope_id,fingerprint) DO UPDATE SET
           cutoff_at=excluded.cutoff_at,allowed_message_id=NULL
         WHERE excluded.cutoff_at>=cutoff_at",
    )?;
    for target in &withdrawal.targets {
        put.execute(params![
            project,
            target.fingerprint,
            target.text_length,
            withdrawal.cutoff_at,
            target.value_fingerprint,
            target.guard_fingerprint,
            target.guard_length
        ])?;
    }
    db.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS project_delete_memories(id TEXT PRIMARY KEY);
         DELETE FROM temp.project_delete_memories;",
    )?;
    if db.execute(
        "INSERT INTO temp.project_delete_memories SELECT DISTINCT memory_id
         FROM memory_scopes WHERE scope_type='project' AND scope_id=?1
           AND (?2 IS NULL OR memory_id=?2)",
        params![project, memory_id],
    )? == 0
    {
        return Ok(());
    }
    invalidate_projections(db, project, withdrawal.cutoff_at)?;
    db.execute(
        "UPDATE memory_skill_candidates SET status='stale',updated_at=?1
         WHERE status IN ('draft','ready','materialized')
           AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) j
               JOIN memory_records m ON m.id=j.value AND m.kind='procedure'
               JOIN temp.project_delete_memories d ON d.id=m.id)",
        [withdrawal.cutoff_at],
    )?;
    db.execute(
        "DELETE FROM memory_scopes WHERE scope_type='project' AND scope_id=?1
         AND memory_id IN (SELECT id FROM temp.project_delete_memories)",
        [project],
    )?;
    db.execute_batch(
        "DELETE FROM temp.project_delete_memories WHERE id IN
           (SELECT d.id FROM temp.project_delete_memories d JOIN memory_scopes s ON s.memory_id=d.id);
         DELETE FROM memory_candidates WHERE resolved_memory_id IN (SELECT id FROM temp.project_delete_memories);
         DELETE FROM memory_records WHERE id IN (SELECT id FROM temp.project_delete_memories);
         DELETE FROM temp.project_delete_memories;",
    )?;
    Ok(())
}
