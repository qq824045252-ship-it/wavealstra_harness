use crate::{Result, javascript_whitespace};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    id: String,
    task_id: String,
    session_id: Option<String>,
    user_message_id: Option<String>,
    assistant_message_id: Option<String>,
    user_text: String,
    assistant_text: String,
    captured_at: i64,
    metadata_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    entry_id: i64,
    turn: Option<Turn>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Capture {
    Turn {
        turn: Turn,
    },
    Durable {
        task_id: String,
        entries: Vec<Entry>,
    },
}

fn capture_turn(db: &Connection, turn: Turn) -> duckdb::Result<bool> {
    let user = turn.user_text.trim_matches(javascript_whitespace);
    let assistant = turn.assistant_text.trim_matches(javascript_whitespace);
    let mut hash = Sha256::new();
    hash.update(user);
    hash.update("\n␞\n");
    hash.update(assistant);
    let content_hash = format!("{:x}", hash.finalize());
    let existing: Option<String> = match turn.assistant_message_id.as_deref() {
        Some(id) if !id.is_empty() => db.query_row(
            "SELECT id FROM memory_turns WHERE assistant_message_id=?",
            [id],
            |row| row.get(0),
        ).optional()?,
        _ => db.query_row(
            "SELECT id FROM memory_turns WHERE task_id=? AND content_hash=? ORDER BY captured_at DESC LIMIT 1",
            params![turn.task_id, content_hash],
            |row| row.get(0),
        ).optional()?,
    };
    if let Some(id) = existing {
        // A lost reply may retry a write already committed by this request.
        return Ok(id == turn.id);
    }
    db.execute(
        "INSERT INTO memory_turns (
            id,task_id,session_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,
            captured_at,metadata_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?)",
        params![turn.id, turn.task_id, turn.session_id, turn.user_message_id, turn.assistant_message_id,
            user, assistant, content_hash, turn.captured_at, turn.metadata_json],
    )?;
    db.execute(
        "INSERT INTO memory_pipeline_state(task_id,captured_turns,turns_since_l1,updated_at)
         VALUES (?,1,1,?)
         ON CONFLICT(task_id) DO UPDATE SET captured_turns=captured_turns+1,
            turns_since_l1=turns_since_l1+1,updated_at=excluded.updated_at",
        params![turn.task_id, turn.captured_at],
    )?;
    Ok(true)
}

pub fn run(db: &mut Connection, capture: Capture) -> Result<usize> {
    let tx = db.transaction()?;
    let saved = match capture {
        Capture::Turn { turn } => usize::from(capture_turn(&tx, turn)?),
        Capture::Durable { task_id, entries } => {
            let prior: i64 = tx
                .query_row(
                    "SELECT entry_id FROM durable_bot_memory_projection WHERE task_id=?",
                    [&task_id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            let mut saved = 0;
            let mut through = prior;
            for entry in entries.into_iter().filter(|entry| entry.entry_id > prior) {
                through = through.max(entry.entry_id);
                if let Some(turn) = entry.turn {
                    if turn.task_id != task_id {
                        return Err("Memory turn does not belong to the projection task".into());
                    }
                    saved += usize::from(capture_turn(&tx, turn)?);
                }
            }
            if through > prior {
                tx.execute(
                    "INSERT INTO durable_bot_memory_projection(task_id,entry_id) VALUES (?,?)
                     ON CONFLICT(task_id) DO UPDATE SET entry_id=excluded.entry_id",
                    params![task_id, through],
                )?;
            }
            saved
        }
    };
    tx.commit()?;
    Ok(saved)
}
