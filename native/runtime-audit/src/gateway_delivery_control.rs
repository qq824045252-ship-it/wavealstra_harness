use crate::Result;
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    ClaimExecution,
    ClaimReply {
        max_attempts: i64,
    },
    QueueReply {
        attempt: i64,
        text: String,
    },
    FinishExecution {
        attempt: i64,
        outcome: ExecutionOutcome,
    },
    FinishReply {
        attempt: i64,
        outcome: ReplyOutcome,
        reason: Option<String>,
        next_attempt_at: Option<i64>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionOutcome {
    Completed,
    Interrupted,
    Failed,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplyOutcome {
    Sent,
    Pending,
    Blocked,
    Failed,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Receipt {
    ClaimExecution { attempt: i64, generation: String },
    ClaimReply { attempt: i64, generation: String },
    Waiting { next_attempt_at: i64 },
    Applied,
    Sent,
    Unavailable,
    Stale,
    Invalid,
    Conflict,
    Integrity,
    Exhausted,
}

#[derive(Serialize)]
pub struct Outbox {
    delivery_id: String,
    reply_text: String,
    reply_hash: String,
    status: String,
    retry_count: i64,
    next_attempt_at: i64,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
    sent_at: Option<i64>,
}

pub fn read_outbox(db: &Connection, id: &str) -> Result<Option<Outbox>> {
    Ok(db.query_row(
        "SELECT delivery_id,reply_text,reply_hash,status,retry_count,next_attempt_at,last_error,created_at,updated_at,sent_at
         FROM gateway_outbox WHERE delivery_id=?",
        [id], |row| Ok(Outbox {
            delivery_id: row.get(0)?, reply_text: row.get(1)?, reply_hash: row.get(2)?, status: row.get(3)?,
            retry_count: row.get(4)?, next_attempt_at: row.get(5)?, last_error: row.get(6)?, created_at: row.get(7)?,
            updated_at: row.get(8)?, sent_at: row.get(9)?,
        }),
    ).optional()?)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_inbox_state(db: &Connection, id: &str) -> Result<Option<(String, i64, String)>> {
    Ok(db
        .query_row(
            "SELECT status,retry_count,receipt_mode FROM gateway_inbox WHERE delivery_id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

fn project_reply(db: &Connection, id: &str, receipt: Receipt, generation: &str) -> Result<Value> {
    match receipt {
        Receipt::ClaimExecution {
            attempt,
            generation: owner,
        } => {
            if owner == generation
                && read_inbox_state(db, id)?
                    .is_some_and(|(status, count, _)| status == "running" && count == attempt)
            {
                Ok(json!({ "status": "claimed", "attempt": attempt }))
            } else {
                Ok(serde_json::to_value(Receipt::Stale)?)
            }
        }
        Receipt::ClaimReply {
            attempt,
            generation: owner,
        } => {
            if owner == generation
                && let Some(row) = read_outbox(db, id)?
                && row.retry_count == attempt
                && row.status == "sending"
            {
                Ok(json!({ "status": "sending", "entry": row }))
            } else {
                Ok(serde_json::to_value(Receipt::Stale)?)
            }
        }
        other => Ok(serde_json::to_value(other)?),
    }
}

pub fn run(db: &mut Connection, id: &str, operation_id: &str, action: Action) -> Result<Value> {
    if id.is_empty() || id.len() > 200 || operation_id.is_empty() || operation_id.len() > 200 {
        return Ok(serde_json::to_value(Receipt::Invalid)?);
    }
    let tx = db.transaction()?;
    match run_in_tx(&tx, id, operation_id, action) {
        Ok(result) => {
            crate::request_control::commit(tx)?;
            Ok(result)
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            Err(error)
        }
    }
}

fn run_in_tx(tx: &Transaction<'_>, id: &str, operation_id: &str, action: Action) -> Result<Value> {
    let scope = format!("gateway-delivery:{id}");
    let fingerprint = digest(&serde_json::to_vec(&action)?);
    let generation = crate::business_protocol::current_core_generation();
    let prior: Option<(String, String)> = tx.query_row(
        "SELECT request_hash,result_json FROM operation_receipts WHERE caller_scope=? AND operation_id=? AND batch_index=0",
        params![scope, operation_id], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    if let Some((hash, result)) = prior {
        if fingerprint != hash {
            return Ok(serde_json::to_value(Receipt::Conflict)?);
        }
        return project_reply(tx, id, serde_json::from_str(&result)?, &generation);
    }
    let now = i64::try_from(crate::request_control::now_ms())?;
    let receipt = apply(tx, id, action, &generation, now)?;
    tx.execute(
        "INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
         VALUES (?,?,0,?,'committed',?,?)",
        params![scope, operation_id, fingerprint, serde_json::to_string(&receipt)?, now],
    )?;
    project_reply(tx, id, receipt, &generation)
}

fn apply(
    tx: &Transaction<'_>,
    id: &str,
    action: Action,
    generation: &str,
    now: i64,
) -> Result<Receipt> {
    match action {
        Action::ClaimExecution => {
            let changed = tx.execute(
                "UPDATE gateway_inbox SET status='running',retry_count=retry_count+1,last_error=NULL,updated_at=?2
                 WHERE delivery_id=?1 AND status IN ('pending','blocked') AND (retry_count=0 OR receipt_mode='pi-durable')
                   AND NOT EXISTS(SELECT 1 FROM gateway_outbox WHERE delivery_id=?1)", params![id, now],
            )?;
            if changed == 0 {
                return Ok(Receipt::Unavailable);
            }
            let (_, attempt, _) =
                read_inbox_state(tx, id)?.ok_or("claimed Gateway input missing")?;
            Ok(Receipt::ClaimExecution {
                attempt,
                generation: generation.to_owned(),
            })
        }
        Action::ClaimReply { max_attempts } => claim_reply(tx, id, max_attempts, generation, now),
        Action::QueueReply { attempt, text } => {
            if text.trim().is_empty() || text.len() > 512 * 1024 {
                return Ok(Receipt::Invalid);
            }
            let hash = digest(text.as_bytes());
            let Some((status, current, _)) = read_inbox_state(tx, id)? else {
                return Ok(Receipt::Stale);
            };
            if current != attempt || attempt < 1 {
                return Ok(Receipt::Stale);
            }
            if let Some(outbox) = read_outbox(tx, id)? {
                return Ok(if outbox.reply_hash == hash {
                    Receipt::Applied
                } else {
                    Receipt::Conflict
                });
            }
            if status != "running" {
                return Ok(Receipt::Stale);
            }
            tx.execute("INSERT INTO gateway_outbox(delivery_id,reply_text,reply_hash,status,created_at,updated_at)
                 VALUES (?1,?2,?3,'pending',?4,?4)", params![id, text, hash, now])?;
            tx.execute("UPDATE gateway_inbox SET status='reply_pending',last_error=NULL,updated_at=?2 WHERE delivery_id=?1", params![id, now])?;
            Ok(Receipt::Applied)
        }
        Action::FinishExecution { attempt, outcome } => {
            let Some((state, current, mode)) = read_inbox_state(tx, id)? else {
                return Ok(Receipt::Stale);
            };
            if state != "running" || current != attempt {
                return Ok(Receipt::Stale);
            }
            let (status, reason) = match outcome {
                ExecutionOutcome::Completed => ("completed", None),
                ExecutionOutcome::Failed if mode == "pi-durable" => {
                    ("blocked", Some("execution_failed"))
                }
                ExecutionOutcome::Interrupted if mode == "pi-durable" => {
                    ("pending", Some("connection_interrupted"))
                }
                _ => ("unknown", Some("native_recovery_unavailable")),
            };
            tx.execute("UPDATE gateway_inbox SET status=?2,last_error=?3,updated_at=?4 WHERE delivery_id=?1", params![id, status, reason, now])?;
            Ok(Receipt::Applied)
        }
        Action::FinishReply {
            attempt,
            outcome,
            reason,
            next_attempt_at,
        } => {
            let (outbox, inbox) = match outcome {
                ReplyOutcome::Sent => ("sent", "completed"),
                ReplyOutcome::Pending => ("pending", "reply_pending"),
                ReplyOutcome::Blocked => ("blocked", "reply_pending"),
                ReplyOutcome::Failed => ("failed", "reply_pending"),
                ReplyOutcome::Unknown => ("unknown", "unknown"),
            };
            let changed = tx.execute(
                "UPDATE gateway_outbox SET status=?3,last_error=?4,next_attempt_at=?5,updated_at=?6,
                     sent_at=CASE WHEN ?3='sent' THEN ?6 ELSE sent_at END
                 WHERE delivery_id=?1 AND retry_count=?2 AND status='sending'", params![id, attempt, outbox, reason, next_attempt_at.unwrap_or(0), now],
            )?;
            if changed == 0 {
                return Ok(Receipt::Stale);
            }
            tx.execute("UPDATE gateway_inbox SET status=?2,last_error=?3,updated_at=?4 WHERE delivery_id=?1", params![id, inbox, reason, now])?;
            Ok(Receipt::Applied)
        }
    }
}

fn claim_reply(
    tx: &Transaction<'_>,
    id: &str,
    max_attempts: i64,
    generation: &str,
    now: i64,
) -> Result<Receipt> {
    if max_attempts < 1 {
        return Ok(Receipt::Invalid);
    }
    let Some(row) = read_outbox(tx, id)? else {
        return Ok(Receipt::Unavailable);
    };
    if row.status == "sent" {
        return Ok(Receipt::Sent);
    }
    if !matches!(row.status.as_str(), "pending" | "blocked") {
        return Ok(Receipt::Unavailable);
    }
    if row.next_attempt_at > now {
        return Ok(Receipt::Waiting {
            next_attempt_at: row.next_attempt_at,
        });
    }
    let terminal = if digest(row.reply_text.as_bytes()) != row.reply_hash {
        Some((Receipt::Integrity, "reply_integrity_invalid"))
    } else if row.retry_count >= max_attempts {
        Some((Receipt::Exhausted, "retry_exhausted"))
    } else {
        None
    };
    if let Some((receipt, reason)) = terminal {
        tx.execute("UPDATE gateway_outbox SET status='failed',last_error=?2,updated_at=?3 WHERE delivery_id=?1", params![id, reason, now])?;
        tx.execute(
            "UPDATE gateway_inbox SET last_error=?2,updated_at=?3 WHERE delivery_id=?1",
            params![id, reason, now],
        )?;
        return Ok(receipt);
    }
    tx.execute("UPDATE gateway_outbox SET status='sending',retry_count=retry_count+1,last_error=NULL,updated_at=?2 WHERE delivery_id=?1", params![id, now])?;
    Ok(Receipt::ClaimReply {
        attempt: row.retry_count + 1,
        generation: generation.to_owned(),
    })
}

pub fn recover_interrupted(tx: &Connection, generation: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE gateway_outbox o SET status='unknown',last_error='send_interrupted',updated_at=?2 WHERE status='sending'
         AND NOT EXISTS (SELECT 1 FROM operation_receipts r WHERE r.caller_scope='gateway-delivery:' || o.delivery_id
             AND json_extract_string(r.result_json,'$.status')='claimReply'
             AND json_extract_string(r.result_json,'$.generation')=?1
             AND try_cast(json_extract(r.result_json,'$.attempt') AS BIGINT)=o.retry_count)", params![generation, now],
    )?;
    tx.execute(
        "UPDATE gateway_inbox SET status='unknown',last_error='send_interrupted',updated_at=?1
         WHERE status IN ('running','reply_pending') AND delivery_id IN (SELECT delivery_id FROM gateway_outbox WHERE status='unknown')", [now],
    )?;
    tx.execute(
        "UPDATE gateway_inbox i SET status=CASE WHEN receipt_mode='pi-durable' THEN 'pending' ELSE 'unknown' END,
            last_error=CASE WHEN receipt_mode='pi-durable' THEN 'native_receipt_recovery' ELSE 'native_recovery_unavailable' END,updated_at=?2
         WHERE status='running' AND NOT EXISTS (SELECT 1 FROM gateway_outbox o WHERE o.delivery_id=i.delivery_id)
         AND NOT EXISTS (SELECT 1 FROM operation_receipts r WHERE r.caller_scope='gateway-delivery:' || i.delivery_id
             AND json_extract_string(r.result_json,'$.status')='claimExecution'
             AND json_extract_string(r.result_json,'$.generation')=?1
             AND try_cast(json_extract(r.result_json,'$.attempt') AS BIGINT)=i.retry_count)", params![generation, now],
    )?;
    Ok(())
}
