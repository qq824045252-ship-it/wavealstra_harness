use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

const DOTS_TASK_ID: &str = "mybuddy-dots";
const DELIVERY_ALLOWED: &str = "
    NOT EXISTS (SELECT 1 FROM core_dots_control_config WHERE key='runtime'
      AND json_extract_string(value_json,'$.paused')='true')
    AND NOT EXISTS (SELECT 1 FROM dots_proactive_pauses WHERE scope='')";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
    Pending,
    Archives { now: i64 },
    Notifications { since: i64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    delivery_key: String,
    source: String,
    text: String,
    queued_at: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Enqueue { items: Vec<Notice> },
    Confirm { delivery_key: String, message_id: String },
    Archive {
        delivery_key: String,
        message_id: String,
        workspace: String,
        archived_at: Option<i64>,
        retry_at: Option<i64>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    delivery_key: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Archive {
    delivery_key: String,
    message_id: String,
    source: String,
    text: String,
    workspace: String,
    queued_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notification {
    dedupe_key: String,
    source_id: String,
    title: String,
    body: Option<String>,
    created_at: i64,
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    Ok(match query {
        Query::Pending => {
            let mut stmt = db.prepare(&format!("SELECT delivery_key,text FROM dots_proactive_delivery
                WHERE message_id IS NULL AND {DELIVERY_ALLOWED}
                ORDER BY queued_at,delivery_key LIMIT 30"))?;
            let rows = stmt.query_map([], |row| {
                Ok(Pending { delivery_key: row.get(0)?, text: row.get(1)? })
            })?.collect::<duckdb::Result<Vec<_>>>()?;
            serde_json::to_value(rows)?
        }
        Query::Archives { now } => {
            let mut stmt = db.prepare(&format!("SELECT delivery_key,message_id,source,text,workspace,queued_at
                FROM dots_proactive_delivery WHERE workspace IS NOT NULL AND message_id IS NOT NULL
                AND archived_at IS NULL AND coalesce(archive_retry_at,0)<=? AND {DELIVERY_ALLOWED}
                ORDER BY queued_at,delivery_key LIMIT 30"))?;
            let rows = stmt.query_map([now], |row| {
                Ok(Archive {
                    delivery_key: row.get(0)?,
                    message_id: row.get(1)?,
                    source: row.get(2)?,
                    text: row.get(3)?,
                    workspace: row.get(4)?,
                    queued_at: row.get(5)?,
                })
            })?.collect::<duckdb::Result<Vec<_>>>()?;
            serde_json::to_value(rows)?
        }
        Query::Notifications { since } => {
            let mut stmt = db.prepare("SELECT dedupe_key,source_id,title,body,created_at FROM (
                SELECT dedupe_key,source_id,title,body,created_at FROM notifications
                WHERE task_id=? AND source_id IN ('dots-discovery','dots-google') AND dedupe_key IS NOT NULL
                AND dismissed_at IS NULL AND read_at IS NULL AND created_at>=?
                ORDER BY created_at DESC,dedupe_key DESC LIMIT 30
            ) ORDER BY created_at,dedupe_key")?;
            let rows = stmt.query_map(params![DOTS_TASK_ID, since], |row| {
                Ok(Notification {
                    dedupe_key: row.get(0)?,
                    source_id: row.get(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?.collect::<duckdb::Result<Vec<_>>>()?;
            serde_json::to_value(rows)?
        }
    })
}

fn confirm(db: &Connection, key: &str, message_id: &str) -> Result<&'static str> {
    let queued: Option<(String, Option<String>)> = db.query_row(
        "SELECT text,message_id FROM dots_proactive_delivery WHERE delivery_key=?",
        [key],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((text, saved)) = queued else { return Ok("missing"); };
    if let Some(saved) = saved {
        return Ok(if saved == message_id { "delivered" } else { "conflict" });
    }
    let directory: Option<String> = db.query_row(
        "SELECT directory FROM durable_bot_bindings WHERE task_id=? AND backend='pi-durable'",
        [DOTS_TASK_ID],
        |row| row.get(0),
    ).optional()?;
    let Some(directory) = directory else { return Ok("pending"); };
    let store = crate::durable::store_id_for_path(Path::new(&directory));
    let Some(receipt) = crate::pi_storage::dots_proactive_receipt(db, &store, key)? else {
        return Ok("pending");
    };
    if message_id != format!("durable-{}", receipt.entry_id) || text != receipt.text {
        return Ok("conflict");
    }
    db.execute("UPDATE dots_proactive_delivery SET message_id=?,workspace=? WHERE delivery_key=? AND message_id IS NULL",
        params![message_id, receipt.workspace, key])?;
    Ok("delivered")
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let status = match command {
        Command::Enqueue { items } => {
            let mut stmt = tx.prepare("INSERT INTO dots_proactive_delivery(delivery_key,source,text,queued_at)
                VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")?;
            for item in items {
                if item.delivery_key.trim().is_empty() || item.text.trim().is_empty() ||
                    !matches!(item.source.as_str(), "Google" | "RSS" | "Dream") {
                    return Err("Invalid Dots proactive notice".into());
                }
                stmt.execute(params![item.delivery_key, item.source, item.text, item.queued_at])?;
            }
            "saved"
        }
        Command::Confirm { delivery_key, message_id } => confirm(&tx, &delivery_key, &message_id)?,
        Command::Archive { delivery_key, message_id, workspace, archived_at, retry_at } => {
            let saved: Option<Option<i64>> = tx.query_row("SELECT archived_at FROM dots_proactive_delivery
                WHERE delivery_key=? AND message_id=? AND workspace=?", params![delivery_key, message_id, workspace],
                |row| row.get(0)).optional()?;
            if saved.is_none() {
                "conflict"
            } else {
                if saved == Some(None) {
                    match (archived_at, retry_at) {
                        (Some(at), None) => tx.execute("UPDATE dots_proactive_delivery SET archived_at=?,archive_retry_at=NULL
                            WHERE delivery_key=? AND archived_at IS NULL", params![at, delivery_key])?,
                        (None, Some(retry)) => tx.execute("UPDATE dots_proactive_delivery SET archive_retry_at=greatest(coalesce(archive_retry_at,0),?)
                            WHERE delivery_key=? AND archived_at IS NULL", params![retry, delivery_key])?,
                        _ => return Err("A Dots archive must record a completion or a retry".into()),
                    };
                }
                "saved"
            }
        }
    };
    crate::request_control::commit(tx)?;
    Ok(json!({ "status": status }))
}
