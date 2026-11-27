use super::Reply;
use crate::{DOTS_TASK_ID, MAX_REPLY_BYTES, Result};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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

fn source(db: &Connection, id: &str) -> duckdb::Result<Option<String>> {
    let base: Option<(String, String, String)> = db
        .prepare("SELECT id,title,content FROM memory_records WHERE id=?1")?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((id, title, content)) = base else {
        return Ok(None);
    };
    let mut r_stmt = db.prepare(
        "SELECT title,content FROM memory_revisions WHERE memory_id=?1 ORDER BY revision DESC",
    )?;
    let revisions: Vec<Value> = r_stmt
        .query_map([&id], |r| {
            Ok(json!({
                "title": r.get::<_, String>(0)?,
                "content": r.get::<_, String>(1)?,
            }))
        })?
        .collect::<duckdb::Result<_>>()?;
    let mut e_stmt = db.prepare(
        "SELECT excerpt FROM memory_evidence WHERE memory_id=?1 ORDER BY created_at,rowid",
    )?;
    let evidence: Vec<Value> = e_stmt
        .query_map([&id], |r| Ok(json!({ "excerpt": r.get::<_, Option<String>>(0)? })))?
        .collect::<duckdb::Result<_>>()?;
    let mut s_stmt = db.prepare(
        "SELECT scope_type,scope_id FROM memory_scopes WHERE memory_id=?1 ORDER BY scope_type,scope_id,binding",
    )?;
    let scopes: Vec<Value> = s_stmt
        .query_map([&id], |r| {
            Ok(json!({
                "scopeType": r.get::<_, String>(0)?,
                "scopeId": r.get::<_, Option<String>>(1)?,
            }))
        })?
        .collect::<duckdb::Result<_>>()?;
    Ok(Some(
        json!({
            "id": id,
            "title": title,
            "content": content,
            "revisions": revisions,
            "evidence": evidence,
            "scopes": scopes,
        })
        .to_string(),
    ))
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
    let tx = db.transaction()?;
    if !matches_snapshot(&tx, id, &withdrawal)? {
        return Ok(Reply::Stale);
    }
    let archived = tx
        .prepare(
            "SELECT 1 FROM memory_scopes s JOIN projects p ON p.id=s.scope_id
         WHERE s.memory_id=?1 AND s.scope_type='project' AND p.archived=1",
        )?
        .exists([id])?;
    if archived {
        return Err("项目已归档（只读），不能修改其关联记忆".into());
    }
    let refresh_dots = tx
        .prepare(
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
) -> duckdb::Result<bool> {
    Ok(signature(source(db, id)?.as_deref()) == withdrawal.signature)
}

pub(super) fn persist_targets(
    db: &Connection,
    id: &str,
    withdrawal: &Withdrawal,
    scope: Option<(&str, Option<&str>)>,
) -> duckdb::Result<()> {
    let (scope_type, scope_id) = scope.map_or((None, None), |(kind, id)| (Some(kind), id));
    let mut put = db.prepare(
        "INSERT INTO memory_forget_targets(scope_type,scope_id,fingerprint,text_length,cutoff_at,
             allowed_message_id,value_fingerprint,guard_fingerprint,guard_length)
         SELECT DISTINCT scope_type,COALESCE(scope_id,''),?2,?3,?4,NULL,?5,?6,?7
         FROM memory_scopes WHERE memory_id=?1 AND (?8 IS NULL OR (scope_type=?8 AND scope_id IS NOT DISTINCT FROM ?9))
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

pub(super) fn delete_dots_projections(db: &Connection, id: &str) -> duckdb::Result<()> {
    let scenario_ids: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT id, source_memory_ids_json FROM memory_scenarios WHERE scope_type='task' AND scope_id=?1",
        )?;
        let mut rows = stmt.query([DOTS_TASK_ID])?;
        let mut matched = Vec::new();
        while let Some(row) = rows.next()? {
            let sid: String = row.get(0)?;
            let raw: String = row.get(1)?;
            if serde_json::from_str::<Vec<String>>(&raw)
                .map(|v| v.iter().any(|x| x == id))
                .unwrap_or(false)
            {
                matched.push(sid);
            }
        }
        matched
    };
    if !scenario_ids.is_empty() {
        let profile_ids: Vec<String> = {
            let mut stmt = db.prepare(
                "SELECT id, source_scenario_ids_json FROM memory_core_profiles WHERE scope_type='task' AND scope_id=?1",
            )?;
            let mut rows = stmt.query([DOTS_TASK_ID])?;
            let mut matched = Vec::new();
            while let Some(row) = rows.next()? {
                let pid: String = row.get(0)?;
                let raw: String = row.get(1)?;
                if serde_json::from_str::<Vec<String>>(&raw)
                    .map(|v| v.iter().any(|x| scenario_ids.contains(x)))
                    .unwrap_or(false)
                {
                    matched.push(pid);
                }
            }
            matched
        };
        for pid in profile_ids {
            db.execute("DELETE FROM memory_core_profiles WHERE id=?1", [&pid])?;
        }
        for sid in scenario_ids {
            db.execute("DELETE FROM memory_scenarios WHERE id=?1", [&sid])?;
        }
    }
    Ok(())
}

fn invalidate_dependents(db: &Connection, id: &str, now: i64) -> duckdb::Result<()> {
    for table in ["memory_scenarios", "memory_core_profiles"] {
        db.prepare(&format!(
            "UPDATE {table} AS target SET status='stale',updated_at=?2 WHERE status='active'
             AND EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=?1
                 AND s.scope_type IN ('global','workspace','project') AND s.scope_type=target.scope_type
                 AND s.scope_id IS NOT DISTINCT FROM target.scope_id)",
        ))?.execute(params![id, now])?;
    }
    invalidate_skills(db, id, now)?;
    db.prepare(
        "UPDATE projects SET updated_at=GREATEST(updated_at+1, ?2)
         WHERE id IN (SELECT scope_id FROM memory_scopes WHERE memory_id=?1 AND scope_type='project')",
    )?.execute(params![id, now])?;
    Ok(())
}

pub(super) fn invalidate_skills(db: &Connection, id: &str, now: i64) -> duckdb::Result<()> {
    let is_procedure = db
        .prepare("SELECT 1 FROM memory_records WHERE id=?1 AND kind='procedure'")?
        .exists([id])?;
    if !is_procedure {
        return Ok(());
    }
    let skill_ids: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT id, source_memory_ids_json FROM memory_skill_candidates
             WHERE status IN ('draft','ready','materialized')",
        )?;
        let mut rows = stmt.query([])?;
        let mut matched = Vec::new();
        while let Some(row) = rows.next()? {
            let cid: String = row.get(0)?;
            let raw: String = row.get(1)?;
            if serde_json::from_str::<Vec<String>>(&raw)
                .map(|v| v.iter().any(|x| x == id))
                .unwrap_or(false)
            {
                matched.push(cid);
            }
        }
        matched
    };
    for cid in skill_ids {
        db.execute(
            "UPDATE memory_skill_candidates SET status='stale',updated_at=?2 WHERE id=?1",
            params![cid, now],
        )?;
    }
    Ok(())
}

pub(super) fn hard_delete(db: &duckdb::Transaction<'_>, id: &str) -> duckdb::Result<()> {
    let scopes: Vec<(String, Option<String>)> = {
        let mut stmt = db.prepare("SELECT scope_type, scope_id FROM memory_scopes WHERE memory_id=?1")?;
        stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<duckdb::Result<_>>()?
    };
    db.prepare("DELETE FROM memory_candidates WHERE resolved_memory_id=?1")?
        .execute([id])?;
    db.execute("UPDATE answer_rules SET source_id=NULL WHERE source_id=?1", [id])?;
    db.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", [id])?;
    db.execute("DELETE FROM memory_evidence WHERE memory_id=?1", [id])?;
    db.execute(
        "DELETE FROM memory_relations WHERE from_memory_id=?1 OR to_memory_id=?1",
        [id],
    )?;
    db.execute("DELETE FROM memory_revisions WHERE memory_id=?1", [id])?;
    db.execute("DELETE FROM memory_scopes WHERE memory_id=?1", [id])?;
    let _ = crate::trigger_effects::on_memory_record_deleted_in_tx(
        db,
        id,
        &scopes,
        "mem-forget",
        0,
    );
    db.prepare("DELETE FROM memory_records WHERE id=?1")?
        .execute([id])?;
    Ok(())
}
