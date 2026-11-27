use crate::Result;
use duckdb::{Connection, params};
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
) -> duckdb::Result<String> {
    let mut stmt = db.prepare(
        "SELECT id,title,content FROM memory_records
         WHERE id IN (SELECT memory_id FROM memory_scopes WHERE scope_type='project' AND scope_id=?1)
           AND (?2 IS NULL OR id=?2)
         ORDER BY id",
    )?;
    let mems: Vec<(String, String, String)> = stmt
        .query_map(params![project, memory_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    let mut rev_stmt = db.prepare(
        "SELECT title,content FROM memory_revisions WHERE memory_id=?1 ORDER BY revision DESC",
    )?;
    let mut ev_stmt = db.prepare(
        "SELECT excerpt FROM memory_evidence WHERE memory_id=?1 ORDER BY created_at,rowid",
    )?;
    let mut out = Vec::with_capacity(mems.len());
    for (id, title, content) in mems {
        let revisions: Vec<Value> = rev_stmt
            .query_map([&id], |r| {
                Ok(json!({
                    "title": r.get::<_, String>(0)?,
                    "content": r.get::<_, String>(1)?,
                }))
            })?
            .collect::<duckdb::Result<_>>()?;
        let evidence: Vec<Value> = ev_stmt
            .query_map([&id], |r| Ok(json!({ "excerpt": r.get::<_, Option<String>>(0)? })))?
            .collect::<duckdb::Result<_>>()?;
        out.push(json!({
            "id": id,
            "title": title,
            "content": content,
            "revisions": revisions,
            "evidence": evidence,
        }));
    }
    Ok(Value::Array(out).to_string())
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
) -> duckdb::Result<bool> {
    Ok(signature(&withdrawal_source(db, project, memory_id)?) == withdrawal.signature)
}

pub fn invalidate_projections(db: &Connection, project: &str, now: i64) -> duckdb::Result<()> {
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
) -> duckdb::Result<()> {
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
    let delete_ids: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT DISTINCT memory_id FROM memory_scopes
             WHERE scope_type='project' AND scope_id=?1 AND (?2 IS NULL OR memory_id=?2)",
        )?;
        stmt.query_map(params![project, memory_id], |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?
    };
    if delete_ids.is_empty() {
        return Ok(());
    }
    invalidate_projections(db, project, withdrawal.cutoff_at)?;
    let proc_set: std::collections::HashSet<String> = {
        let slots = crate::database::anon_placeholders(delete_ids.len());
        let mut stmt = db.prepare(&format!(
            "SELECT id FROM memory_records WHERE kind='procedure' AND id IN ({slots})"
        ))?;
        stmt.query_map(duckdb::params_from_iter(delete_ids.iter()), |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?
    };
    if !proc_set.is_empty() {
        let stale_candidates: Vec<String> = {
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
                    .map(|v| v.iter().any(|x| proc_set.contains(x)))
                    .unwrap_or(false)
                {
                    matched.push(cid);
                }
            }
            matched
        };
        for cid in stale_candidates {
            db.execute(
                "UPDATE memory_skill_candidates SET status='stale',updated_at=?2 WHERE id=?1",
                params![cid, withdrawal.cutoff_at],
            )?;
        }
    }
    {
        let slots = crate::database::anon_placeholders(delete_ids.len());
        let mut stmt = db.prepare(&format!(
            "DELETE FROM memory_scopes WHERE scope_type='project' AND scope_id=? AND memory_id IN ({slots})"
        ))?;
        let mut p: Vec<&dyn duckdb::ToSql> = vec![&project];
        for id in &delete_ids {
            p.push(id);
        }
        stmt.execute(duckdb::params_from_iter(p))?;
    }
    let orphan_ids: Vec<String> = {
        let slots = crate::database::anon_placeholders(delete_ids.len());
        let mut stmt = db.prepare(&format!(
            "SELECT id FROM memory_records WHERE id IN ({slots})
             AND NOT EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=memory_records.id)"
        ))?;
        stmt.query_map(duckdb::params_from_iter(delete_ids.iter()), |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?
    };
    if !orphan_ids.is_empty() {
        let slots = crate::database::anon_placeholders(orphan_ids.len());
        let doc_keys: Vec<String> = orphan_ids.iter().map(|id| format!("memory:{id}")).collect();
        let doc_slots = crate::database::anon_placeholders(doc_keys.len());
        db.execute(
            &format!("DELETE FROM search_postings WHERE doc_key IN ({doc_slots})"),
            duckdb::params_from_iter(doc_keys.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM search_documents WHERE doc_key IN ({doc_slots})"),
            duckdb::params_from_iter(doc_keys.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM memory_candidates WHERE resolved_memory_id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
        db.execute(
            &format!("UPDATE answer_rules SET source_id=NULL WHERE source_id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM memory_embeddings WHERE memory_id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM memory_evidence WHERE memory_id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
        let double_params: Vec<&String> = orphan_ids.iter().chain(orphan_ids.iter()).collect();
        db.execute(
            &format!(
                "DELETE FROM memory_relations WHERE from_memory_id IN ({slots}) OR to_memory_id IN ({slots})"
            ),
            duckdb::params_from_iter(double_params),
        )?;
        db.execute(
            &format!("DELETE FROM memory_revisions WHERE memory_id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM memory_records WHERE id IN ({slots})"),
            duckdb::params_from_iter(orphan_ids.iter()),
        )?;
    }
    Ok(())
}
