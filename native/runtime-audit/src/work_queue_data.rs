use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DELTA_LIMIT: i64 = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    user_id: String,
    include_closed: bool,
    cursor: Option<Cursor>,
}

#[derive(Deserialize, Serialize)]
struct Cursor {
    epoch: String,
    sequence: i64,
    scope: String,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Event {
    Upsert {
        sequence: i64,
        work_id: String,
    },
    Remove {
        sequence: i64,
        work_id: String,
        reason: &'static str,
    },
}

pub fn read(db: &mut Connection, query: Query) -> Result<Value> {
    let tx = db.transaction()?;
    let stream = tx
        .query_row(
            "SELECT epoch,sequence FROM work_projection_streams WHERE user_id=?1",
            [&query.user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((epoch, current_sequence)) = stream else {
        return Ok(json!({ "kind": "needsHost" }));
    };
    let scope = if query.include_closed { "all" } else { "open" };
    let Some(cursor) = query.cursor else {
        let mut statement = tx.prepare(
            "SELECT work_id FROM works WHERE user_id=?1 AND (?2 OR lifecycle!='closed')
             ORDER BY updated_at DESC,work_id",
        )?;
        let rows = statement.query_map(params![query.user_id, query.include_closed], |row| {
            row.get::<_, String>(0)
        })?;
        let mut work_ids = Vec::new();
        // Reserve the reply envelope and account for the largest JSON escape per ID byte.
        let mut bytes = 256_usize.saturating_add(epoch.len().saturating_mul(6));
        for row in rows {
            let id = row?;
            bytes = bytes.saturating_add(id.len().saturating_mul(6).saturating_add(3));
            if bytes >= MAX_REPLY_BYTES {
                return Ok(json!({ "kind": "needsHost" }));
            }
            work_ids.push(id);
        }
        return Ok(
            json!({ "kind": "snapshot", "cursor": { "epoch": epoch, "sequence": current_sequence, "scope": scope }, "workIds": work_ids }),
        );
    };
    if cursor.epoch != epoch
        || cursor.scope != scope
        || cursor.sequence > current_sequence
        || cursor.sequence < 0
    {
        return Ok(json!({ "kind": "resync_required" }));
    }
    let mut statement = tx.prepare(
        "SELECT e.sequence,e.work_id,w.lifecycle,CASE WHEN a.archived_at IS NOT NULL THEN a.deleted_at END
         FROM work_projection_events e
         LEFT JOIN works w ON w.work_id=e.work_id AND w.user_id=e.user_id
         LEFT JOIN work_record_archive a ON a.work_id=w.work_id
         WHERE e.user_id=?1 AND e.sequence>?2 ORDER BY e.sequence LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![query.user_id, cursor.sequence, DELTA_LIMIT],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        },
    )?;
    let mut events = Vec::new();
    let mut latest = cursor.sequence;
    for row in rows {
        let (sequence, work_id, lifecycle, deleted_at) = row?;
        if latest.checked_add(1) != Some(sequence) {
            return Ok(json!({ "kind": "resync_required" }));
        }
        latest = sequence;
        events.push(
            if lifecycle.is_none() || deleted_at.is_some_and(|at| at != 0) {
                Event::Remove {
                    sequence,
                    work_id,
                    reason: "removed",
                }
            } else if !query.include_closed && lifecycle.as_deref() == Some("closed") {
                Event::Remove {
                    sequence,
                    work_id,
                    reason: "closed",
                }
            } else {
                Event::Upsert { sequence, work_id }
            },
        );
    }
    if events.is_empty() && latest != current_sequence {
        return Ok(json!({ "kind": "resync_required" }));
    }
    Ok(
        json!({ "kind": "delta", "cursor": { "epoch": epoch, "sequence": latest, "scope": scope },
        "from": cursor.sequence, "events": events, "hasMore": latest < current_sequence }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkRead {
    user_id: String,
    work_id: String,
    semantic_card_key: String,
    read_at: i64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved { result: Value },
    Rejected { message: String },
}

pub fn mark_read(db: &mut Connection, request: MarkRead) -> Reply {
    match apply_mark(db, request) {
        Ok(result) => Reply::Saved { result },
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply_mark(db: &mut Connection, request: MarkRead) -> Result<Value> {
    let tx = db.transaction()?;
    let owns: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM works WHERE work_id=?1 AND user_id=?2)",
        params![request.work_id, request.user_id],
        |row| row.get(0),
    )?;
    if !owns {
        return Ok(json!({ "ok": false, "message": "找不到结果卡片" }));
    }
    let card = tx.query_row(
        "SELECT card_key,semantic_card_key,user_id FROM work_result_cards WHERE work_id=?1 AND (semantic_card_key=?2 OR card_key=?2)",
        params![request.work_id, request.semantic_card_key],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    ).optional()?;
    let Some((card_key, semantic_card_key, owner)) = card else {
        return Ok(json!({ "ok": false, "message": "找不到结果卡片" }));
    };
    if owner != request.user_id {
        return Ok(json!({ "ok": false, "message": "无权标记其他用户的结果卡片" }));
    }
    // The existing card trigger adds the Work journal event in this same transaction.
    let advanced = tx.execute(
        "UPDATE work_result_cards SET read_at=?1,read_by_user_id=?2,read_version=read_version+1
         WHERE card_key=?3 AND (read_at IS NULL OR read_at<?1)",
        params![request.read_at, request.user_id, card_key],
    )?;
    let (read_at, read_version) = tx.query_row(
        "SELECT read_at,read_version FROM work_result_cards WHERE card_key=?1",
        [&card_key],
        |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, i64>(1)?)),
    )?;
    tx.commit()?;
    Ok(
        json!({ "ok": true, "cardKey": card_key, "semanticCardKey": semantic_card_key,
        "readAt": read_at.unwrap_or(request.read_at), "readVersion": read_version, "replayed": advanced == 0 }),
    )
}
