use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{
    Connection, OptionalExt, params, params_from_iter, types::Value};
use serde_json::{Value as Json, json};

pub(crate) fn list(db: &Connection, status: Option<String>, limit: i64) -> Result<Json> {
    const COLUMNS: &str = "id,task_id,kind,title,content,scope_type,scope_id,confidence,importance,
        explicit,operation_hint,replaces,status,raw_json,created_at,resolved_at";
    let mut bindings = Vec::new();
    let filter = if let Some(status) = status.filter(|status| !status.is_empty()) {
        bindings.push(Value::Text(status));
        " WHERE status=?"
    } else {
        ""
    };
    bindings.push(Value::BigInt(limit));
    let mut statement = db.prepare(&format!(
        "SELECT {COLUMNS} FROM memory_candidates{filter} ORDER BY created_at DESC LIMIT ?"
    ))?;
    let mut rows = statement.query(params_from_iter(bindings))?;
    let mut candidates = Vec::new();
    let mut bytes = 128;
    while let Some(row) = rows.next()? {
        let candidate = json!({
            "id": row.get::<_, String>(0)?,
            "task_id": row.get::<_, String>(1)?,
            "kind": row.get::<_, String>(2)?,
            "title": row.get::<_, String>(3)?,
            "content": row.get::<_, String>(4)?,
            "scope_type": row.get::<_, String>(5)?,
            "scope_id": row.get::<_, Option<String>>(6)?,
            "confidence": row.get::<_, f64>(7)?,
            "importance": row.get::<_, f64>(8)?,
            "explicit": row.get::<_, i64>(9)?,
            "operation_hint": row.get::<_, String>(10)?,
            "replaces": row.get::<_, Option<String>>(11)?,
            "status": row.get::<_, String>(12)?,
            "raw_json": row.get::<_, Option<String>>(13)?,
            "created_at": row.get::<_, f64>(14)?,
            "resolved_at": row.get::<_, Option<f64>>(15)?,
        });
        bytes += serde_json::to_vec(&candidate)?.len() + 1;
        if bytes >= MAX_REPLY_BYTES {
            return Ok(Json::Null);
        }
        candidates.push(candidate);
    }
    Ok(json!({ "kind": "candidateList", "candidates": candidates }))
}

pub(crate) fn reject(db: &mut Connection, id: &str, at: i64) -> Result<()> {
    let tx = db.transaction()?;
    let affected = tx.execute(
        "UPDATE memory_candidates SET status='rejected', resolved_at=?2, resolved_memory_id=NULL
         WHERE id=?1 AND status IN ('pending','needs_review')",
        params![id, at],
    )?;
    if affected == 0 {
        let status = tx
            .query_row(
                "SELECT status FROM memory_candidates WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        return Err(match status {
            Some(status) => format!("候选已被处置：{status}"),
            None => format!("候选不存在：{id}"),
        }
        .into());
    }
    tx.commit()?;
    Ok(())
}
