use crate::{Result, database::anon_placeholders};
use duckdb::{Connection, OptionalExt, params, params_from_iter};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn snapshot(db: &mut Connection, task_ids: Option<Vec<String>>) -> Result<Value> {
    let tx = db.transaction()?;
    let mut sql = "SELECT task_id,id,captured_at FROM memory_turns
        WHERE (extraction_state='processing' OR (extraction_state IN ('pending','failed') AND attempt_count<3))".to_owned();
    if let Some(ids) = task_ids.as_ref() {
        if ids.is_empty() {
            return Ok(json!({"taskIds":[],"capturedThrough":0,"sourceIdsByTask":{}}));
        }
        sql.push_str(&format!(" AND task_id IN ({})", anon_placeholders(ids.len())));
    }
    sql.push_str(" ORDER BY captured_at,rowid,task_id");
    let mut tasks = Vec::new();
    let mut max_time: i64 = 0;
    let mut source_ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    {
        let mut stmt = tx.prepare(&sql)?;
        let parameters = task_ids.as_deref().unwrap_or_default();
        let mut rows = stmt.query(params_from_iter(parameters))?;
        while let Some(row) = rows.next()? {
            let task: String = row.get(0)?;
            let sources = source_ids.entry(task.clone()).or_insert_with(|| {
                tasks.push(task);
                Vec::new()
            });
            sources.push(row.get(1)?);
            max_time = max_time.max(row.get::<_, i64>(2)?);
        }
    }
    tx.commit()?;
    Ok(cutoff(tasks, max_time, source_ids))
}

fn cutoff(task_ids: Vec<String>, max_time: i64, source_ids: BTreeMap<String, Vec<String>>) -> Value {
    json!({ "taskIds": task_ids, "capturedThrough": max_time, "sourceIdsByTask": source_ids })
}

pub fn retry(db: &mut Connection, user_id: &str, operation_id: &str) -> Result<Value> {
    let caller = format!("memory-extraction-retry:{user_id}");
    let tx = db.transaction()?;
    let previous: Option<String> = tx.query_row("SELECT result_json FROM operation_receipts
        WHERE caller_scope=?1 AND operation_id=?2 AND batch_index=0", params![caller, operation_id], |row| row.get(0)).optional()?;
    if let Some(previous) = previous {
        let result = serde_json::from_str(&previous)?;
        crate::request_control::commit(tx)?;
        return Ok(result);
    }
    let mut tasks = Vec::new();
    let mut max_time: i64 = 0;
    let mut source_ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut reset = 0;
    {
        let mut stmt = tx.prepare("SELECT m.id,m.task_id,m.captured_at FROM memory_turns m
            JOIN tasks t ON t.id=m.task_id LEFT JOIN task_execution_workspace_state w ON w.task_id=t.id
            LEFT JOIN projects p ON p.id=t.project_id
            WHERE m.extraction_state='failed' AND w.state IS DISTINCT FROM 'trashed' AND t.archived=0 AND t.id<>?1
              AND (nullif(t.project_id,'') IS NULL OR p.archived=0)
              AND NOT starts_with(t.id,'gateway-chat-') AND NOT starts_with(t.id,'gw-bot-')
              AND NOT starts_with(t.id,'bot-conversation-') AND NOT starts_with(t.id,'bot-peer-')
              AND NOT EXISTS(SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM gateway_dots_tasks g WHERE g.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM bot_conversations b WHERE b.conversation_id=t.id)
            ORDER BY m.task_id,m.captured_at,m.rowid")?;
        let rows = stmt.query_map([crate::DOTS_TASK_ID], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        let mut update = tx.prepare("UPDATE memory_turns SET extraction_state='pending',attempt_count=0,last_error=NULL
            WHERE id=? AND extraction_state='failed'")?;
        for (id, task, time) in rows {
            let changed = update.execute([&id])?;
            if changed == 0 { continue; }
            reset += changed;
            let sources = source_ids.entry(task.clone()).or_insert_with(|| {
                tasks.push(task);
                Vec::new()
            });
            sources.push(id);
            max_time = max_time.max(time);
        }
    }
    let mut result = cutoff(tasks, max_time, source_ids);
    result["reset"] = json!(reset);
    let now = i64::try_from(crate::request_control::now_ms())?;
    tx.execute("INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
        VALUES(?1,?2,0,'retryFailed','completed',?3,?4)", params![caller, operation_id, result.to_string(), now])?;
    crate::request_control::commit(tx)?;
    Ok(result)
}
