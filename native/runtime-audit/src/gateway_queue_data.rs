use crate::Result;
use duckdb::{params, Connection, OptionalExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Recovery {
        channel_id: String,
        account_key: Option<String>,
        session_key: Option<String>,
        cutoff: i64,
        limit: i64,
        retry_blocked: bool,
        continuations_only: bool,
    },
    Continuation {
        delivery_id: String,
    },
}

pub fn read(db: &mut Connection, query: Query) -> Result<Value> {
    let tx = db.transaction()?;
    let result = match query {
        Query::Recovery {
            channel_id,
            account_key,
            session_key,
            cutoff,
            limit,
            retry_blocked,
            continuations_only,
        } => {
            let mut counts = Map::new();
            let mut statement = tx.prepare("SELECT status,count(*) FROM gateway_inbox WHERE channel_id=? AND status!='completed' GROUP BY status")?;
            let mut rows = statement.query([&channel_id])?;
            while let Some(row) = rows.next()? {
                counts.insert(row.get(0)?, row.get::<_, i64>(1)?.into());
            }
            drop(rows);
            drop(statement);
            let mut pending = Vec::new();
            let mut truncated = false;
            let mut next_retry_at: Option<i64> = None;
            if let Some(key) = account_key {
                let mut statement = tx.prepare("SELECT i.* FROM gateway_inbox i LEFT JOIN gateway_outbox o USING (delivery_id)
                    WHERE i.channel_id=?1 AND i.account_key=?2 AND i.status IN ('pending','reply_pending')
                      AND (o.delivery_id IS NULL OR (o.status='pending' AND o.next_attempt_at<=?3) OR (?4 AND o.status='blocked'))
                      AND (NOT ?5 OR (o.delivery_id IS NOT NULL AND EXISTS(SELECT 1 FROM bot_gateway_continuations c WHERE c.delivery_id=i.delivery_id)))
                      AND (?6 IS NULL OR i.session_key=?6)
                    ORDER BY i.created_at,i.delivery_id LIMIT ?7")?;
                let page_size = limit.clamp(1, 1024) as usize;
                let mut rows = statement.query(params![
                    channel_id,
                    key,
                    cutoff,
                    retry_blocked,
                    continuations_only,
                    session_key,
                    page_size + 1
                ])?;
                let names = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
                let mut bytes = 4096;
                while let Some(row) = rows.next()? {
                    if pending.len() == page_size {
                        truncated = true;
                        break;
                    }
                    let mut entry = Map::new();
                    for (index, name) in names.iter().enumerate() {
                        entry.insert(
                            name.clone(),
                            crate::database::value_ref_to_json(row.get_ref(index)?)?,
                        );
                    }
                    let entry = Value::Object(entry);
                    bytes += serde_json::to_vec(&entry)?.len() + 1;
                    if bytes >= crate::MAX_REPLY_BYTES {
                        if pending.is_empty() {
                            return Err("stored Gateway entry exceeds IPC recovery limit".into());
                        }
                        truncated = true;
                        break;
                    }
                    pending.push(entry);
                }
                next_retry_at = tx.query_row("SELECT min(o.next_attempt_at) FROM gateway_outbox o JOIN gateway_inbox i USING (delivery_id)
                     WHERE i.channel_id=?1 AND i.account_key=?2 AND i.status='reply_pending' AND o.status='pending' AND o.next_attempt_at>?3
                       AND (NOT ?4 OR EXISTS(SELECT 1 FROM bot_gateway_continuations c WHERE c.delivery_id=i.delivery_id))
                       AND (?5 IS NULL OR i.session_key=?5)",
                    params![channel_id, key, cutoff, continuations_only, session_key], |row| row.get(0))?;
            }
            json!({ "kind":"recovery", "pending":pending, "counts":counts, "nextRetryAt":next_retry_at, "truncated":truncated })
        }
        Query::Continuation { delivery_id } => {
            let operation: Option<String> = tx
                .query_row(
                    "SELECT operation_id FROM bot_gateway_continuations WHERE delivery_id=?",
                    [delivery_id],
                    |row| row.get(0),
                )
                .optional()?;
            json!({ "kind":"continuation", "operationId":operation })
        }
    };
    tx.commit()?;
    Ok(result)
}
