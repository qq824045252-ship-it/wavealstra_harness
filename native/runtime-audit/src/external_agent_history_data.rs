use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{Connection, params};
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 64;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    started_at: i64,
    run_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    rows: Vec<HistoryRow>,
    next_cursor: Option<Cursor>,
}

#[derive(Serialize)]
struct HistoryRow {
    id: String,
    task_id: String,
    agent_id: String,
    agent_name: String,
    status: String,
    cwd: String,
    session_id: Option<String>,
    user_message_id: String,
    assistant_message_id: String,
    prompt: String,
    display_text: Option<String>,
    attachments_json: Option<String>,
    final_text: String,
    thinking_text: String,
    tools_json: String,
    started_at: i64,
    completed_at: Option<i64>,
    error: Option<String>,
    continued_from_run_id: Option<String>,
    continuation_mode: Option<String>,
    output_cursor: i64,
    artifact_refs_json: String,
    resume_supported: i64,
    cancel_supported: i64,
    cancellation_evidence: Option<String>,
    verification_status: String,
    recovery_state: String,
    recovery_message: Option<String>,
}

pub fn read(db: &Connection, task_id: &str, after: Option<Cursor>) -> Result<Page> {
    let mut statement = db.prepare(
        "SELECT id,task_id,agent_id,agent_name,status,cwd,session_id,user_message_id,assistant_message_id,
             prompt,display_text,attachments_json,final_text,thinking_text,tools_json,started_at,completed_at,
             error,continued_from_run_id,continuation_mode,output_cursor,artifact_refs_json,resume_supported,
             cancel_supported,cancellation_evidence,verification_status,recovery_state,recovery_message
         FROM external_agent_runs
         WHERE task_id=?1 AND (?2::BIGINT IS NULL OR started_at>?2 OR (started_at=?2 AND id>?3))
         ORDER BY started_at,id LIMIT ?4",
    )?;
    let mut records = statement.query(params![
        task_id,
        after.as_ref().map(|cursor| cursor.started_at),
        after.as_ref().map(|cursor| cursor.run_id.as_str()),
        PAGE_SIZE as i64 + 1
    ])?;
    let mut rows: Vec<HistoryRow> = Vec::new();
    // Leave space for the cursor, reply envelope and framing used by Core IPC.
    let mut bytes = 4096;
    let mut more = false;
    while let Some(row) = records.next()? {
        if rows.len() == PAGE_SIZE {
            more = true;
            break;
        }
        let record = HistoryRow {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            agent_id: row.get("agent_id")?,
            agent_name: row.get("agent_name")?,
            status: row.get("status")?,
            cwd: row.get("cwd")?,
            session_id: row.get("session_id")?,
            user_message_id: row.get("user_message_id")?,
            assistant_message_id: row.get("assistant_message_id")?,
            prompt: row.get("prompt")?,
            display_text: row.get("display_text")?,
            attachments_json: row.get("attachments_json")?,
            final_text: row.get("final_text")?,
            thinking_text: row.get("thinking_text")?,
            tools_json: row.get("tools_json")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            error: row.get("error")?,
            continued_from_run_id: row.get("continued_from_run_id")?,
            continuation_mode: row.get("continuation_mode")?,
            output_cursor: row.get("output_cursor")?,
            artifact_refs_json: row.get("artifact_refs_json")?,
            resume_supported: row.get("resume_supported")?,
            cancel_supported: row.get("cancel_supported")?,
            cancellation_evidence: row.get("cancellation_evidence")?,
            verification_status: row.get("verification_status")?,
            recovery_state: row.get("recovery_state")?,
            recovery_message: row.get("recovery_message")?,
        };
        bytes += serde_json::to_vec(&record)?.len() + 1;
        if bytes >= MAX_REPLY_BYTES {
            if rows.is_empty() {
                return Err("ACP 运行记录超出核心历史传输上限".into());
            }
            more = true;
            break;
        }
        rows.push(record);
    }
    let next_cursor = rows.last().filter(|_| more).map(|row| Cursor {
        started_at: row.started_at,
        run_id: row.id.clone(),
    });
    Ok(Page { rows, next_cursor })
}
