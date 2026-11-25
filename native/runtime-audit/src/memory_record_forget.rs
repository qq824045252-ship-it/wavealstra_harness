use super::Reply;
use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const DOTS_TASK_ID: &str = "mybuddy-dots";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawal {
    signature: String,
    pub(super) cutoff_at: i64,
    targets: Vec<Target>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    fingerprint: String,
    text_length: i64,
    value_fingerprint: String,
    guard_fingerprint: Option<String>,
    guard_length: Option<i64>,
}

fn source(db: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    db.prepare_cached(
        "SELECT json_object('id',m.id,'title',m.title,'content',m.content,
           'revisions',(SELECT json_group_array(json_object('title',title,'content',content))
             FROM (SELECT title,content FROM memory_revisions WHERE memory_id=m.id ORDER BY revision DESC)),
           'evidence',(SELECT json_group_array(json_object('excerpt',excerpt))
             FROM (SELECT excerpt FROM memory_evidence WHERE memory_id=m.id ORDER BY created_at,rowid)),
           'scopes',(SELECT json_group_array(json_object('scopeType',scope_type,'scopeId',scope_id))
             FROM (SELECT scope_type,scope_id FROM memory_scopes WHERE memory_id=m.id ORDER BY scope_type,scope_id,binding)))
         FROM memory_records m WHERE m.id=?1",
    )?
    .query_row([id], |row| row.get(0))
    .optional()
}

fn signature(source: Option<&str>) -> String {
    format!("{:x}", Sha256::digest(source.unwrap_or("null").as_bytes()))
}

pub(crate) fn snapshot(db: &Connection, id: &str) -> Result<Value> {
    let source = source(db, id)?;
    let json = source.as_deref().unwrap_or("null");
    if json.len() >= MAX_REPLY_BYTES - 256 {
        return Ok(Value::Null);
    }
    Ok(json!({
        "kind": "forgetSource",
        "signature": signature(source.as_deref()),
        "record": serde_json::from_str::<Value>(json)?,
    }))
}

pub(crate) fn apply(db: &mut Connection, id: &str, withdrawal: Withdrawal) -> Result<Reply> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !matches_snapshot(&tx, id, &withdrawal)? {
        return Ok(Reply::Stale);
    }
    let archived = tx
        .prepare_cached(
            "SELECT 1 FROM memory_scopes s JOIN projects p ON p.id=s.scope_id
         WHERE s.memory_id=?1 AND s.scope_type='project' AND p.archived=1",
        )?
        .exists([id])?;
    if archived {
        return Err("项目已归档（只读），不能修改其关联记忆".into());
    }
    let refresh_dots = tx
        .prepare_cached(
            "SELECT 1 FROM memory_scopes WHERE memory_id=?1 AND scope_type='task' AND scope_id=?2",
        )?
        .exists(params![id, DOTS_TASK_ID])?;
    persist_targets(&tx, id, &withdrawal, None)?;
    delete_dots_projections(&tx, id)?;
    invalidate_dependents(&tx, id, withdrawal.cutoff_at)?;
    hard_delete(&tx, id)?;
    tx.commit()?;
    Ok(Reply::Forgotten { refresh_dots })
}

pub(super) fn matches_snapshot(
    db: &Connection,
    id: &str,
    withdrawal: &Withdrawal,
) -> rusqlite::Result<bool> {
    Ok(signature(source(db, id)?.as_deref()) == withdrawal.signature)
}

pub(super) fn persist_targets(
    db: &Connection,
    id: &str,
    withdrawal: &Withdrawal,
    scope: Option<(&str, Option<&str>)>,
) -> rusqlite::Result<()> {
    let (scope_type, scope_id) = scope.map_or((None, None), |(kind, id)| (Some(kind), id));
    let mut put = db.prepare_cached(
        "INSERT INTO memory_forget_targets(scope_type,scope_id,fingerprint,text_length,cutoff_at,
             allowed_message_id,value_fingerprint,guard_fingerprint,guard_length)
         SELECT DISTINCT scope_type,COALESCE(scope_id,''),?2,?3,?4,NULL,?5,?6,?7
         FROM memory_scopes WHERE memory_id=?1 AND (?8 IS NULL OR (scope_type=?8 AND scope_id IS ?9))
         ON CONFLICT(scope_type,scope_id,fingerprint) DO UPDATE SET
             cutoff_at=excluded.cutoff_at,allowed_message_id=NULL
         WHERE excluded.cutoff_at>=cutoff_at",
    )?;
    for target in &withdrawal.targets {
        put.execute(params![
            id,
            target.fingerprint,
            target.text_length,
            withdrawal.cutoff_at,
            target.value_fingerprint,
            target.guard_fingerprint,
            target.guard_length,
            scope_type,
            scope_id,
        ])?;
    }
    Ok(())
}

pub(super) fn delete_dots_projections(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.prepare_cached(
        "DELETE FROM memory_core_profiles
         WHERE scope_type='task' AND scope_id=?2 AND EXISTS (
           SELECT 1 FROM json_each(source_scenario_ids_json) linked JOIN memory_scenarios scenario ON scenario.id=linked.value
           WHERE scenario.scope_type='task' AND scenario.scope_id=?2
             AND EXISTS (SELECT 1 FROM json_each(scenario.source_memory_ids_json) WHERE value=?1)
         )",
    )?.execute(params![id, DOTS_TASK_ID])?;
    db.prepare_cached(
        "DELETE FROM memory_scenarios
         WHERE scope_type='task' AND scope_id=?2
           AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) WHERE value=?1)",
    )?
    .execute(params![id, DOTS_TASK_ID])?;
    Ok(())
}

fn invalidate_dependents(db: &Connection, id: &str, now: i64) -> rusqlite::Result<()> {
    for table in ["memory_scenarios", "memory_core_profiles"] {
        db.prepare_cached(&format!(
            "UPDATE {table} AS target SET status='stale',updated_at=?2 WHERE status='active'
             AND EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=?1
                 AND s.scope_type IN ('global','workspace','project') AND s.scope_type=target.scope_type
                 AND s.scope_id IS target.scope_id)",
        ))?.execute(params![id, now])?;
    }
    invalidate_skills(db, id, now)?;
    db.prepare_cached(
        "UPDATE projects SET updated_at=MAX(updated_at+1,?2)
         WHERE id IN (SELECT scope_id FROM memory_scopes WHERE memory_id=?1 AND scope_type='project')",
    )?.execute(params![id, now])?;
    Ok(())
}

pub(super) fn invalidate_skills(db: &Connection, id: &str, now: i64) -> rusqlite::Result<()> {
    db.prepare_cached(
        "UPDATE memory_skill_candidates SET status='stale',updated_at=?2
         WHERE status IN ('draft','ready','materialized')
           AND EXISTS(SELECT 1 FROM memory_records WHERE id=?1 AND kind='procedure')
           AND EXISTS(SELECT 1 FROM json_each(source_memory_ids_json) WHERE value=?1)",
    )?
    .execute(params![id, now])?;
    Ok(())
}

pub(super) fn hard_delete(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.prepare_cached("DELETE FROM memory_candidates WHERE resolved_memory_id=?1")?
        .execute([id])?;
    // The writer enables foreign keys for the record's scopes, revisions, evidence, relations and embeddings.
    db.prepare_cached("DELETE FROM memory_records WHERE id=?1")?
        .execute([id])?;
    Ok(())
}
