//! Explicit in-transaction replacements for all 94 legacy SQLite triggers (`IN-02`).
//!
//! DuckDB 2.0.1 does not support `CREATE TRIGGER`. Domain write transactions call these
//! helpers explicitly inside the same DuckDB transaction after the base DML mutation so
//! projections, revisions, task board rollups, search postings, scope deltas, and payload
//! garbage collection remain strictly transactional with the primary write.

use crate::database::{DbError, local_day_from_ms};
use crate::memory_versioning::record_memory_change_in_tx;
use crate::search_postings::{
    SearchDocumentInput, delete_document_postings_in_tx, prepare_document_postings,
    publish_document_postings_in_tx,
};
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

static CHANGE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_change_id(prefix: &str, entity_id: &str, now_ms: i64) -> String {
    let seq = CHANGE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}:{entity_id}:{now_ms}:{seq}")
}

fn format_scope_key(scope_type: &str, scope_id: Option<&str>) -> String {
    match scope_id {
        Some(id) if !id.is_empty() => format!("{scope_type}:{id}"),
        _ => scope_type.to_owned(),
    }
}

// =========================================================================
// Family A: Work Projection Streams & Notification Identity (64 triggers)
// =========================================================================

pub fn touch_work_projection_for_user_in_tx(
    tx: &Connection,
    user_id: &str,
    work_id: &str,
) -> Result<i64, DbError> {
    tx.execute(
        "INSERT INTO work_projection_streams (user_id) VALUES (?1) ON CONFLICT (user_id) DO NOTHING",
        params![user_id],
    )?;
    tx.execute(
        "UPDATE work_projection_streams SET sequence = sequence + 1 WHERE user_id = ?1",
        params![user_id],
    )?;
    let seq: i64 = tx.query_row(
        "SELECT sequence FROM work_projection_streams WHERE user_id = ?1",
        params![user_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO work_projection_events (user_id, sequence, work_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id, sequence) DO UPDATE SET work_id = excluded.work_id",
        params![user_id, seq, work_id],
    )?;
    // Replaces `projection_event_retention` trigger
    tx.execute(
        "DELETE FROM work_projection_events WHERE user_id = ?1 AND sequence <= ?2",
        params![user_id, seq - 10_000],
    )?;
    Ok(seq)
}

pub fn touch_work_projection_for_work_in_tx(
    tx: &Connection,
    work_id: &str,
) -> Result<Option<i64>, DbError> {
    let user_id: Option<String> = tx
        .query_row(
            "SELECT user_id FROM works WHERE work_id = ?1",
            params![work_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(uid) = user_id else {
        return Ok(None);
    };
    Ok(Some(touch_work_projection_for_user_in_tx(tx, &uid, work_id)?))
}

pub fn touch_work_projection_for_notification_in_tx(
    tx: &Connection,
    notification_id: &str,
) -> Result<Option<i64>, DbError> {
    let work_id: Option<String> = tx
        .query_row(
            "SELECT work_id FROM work_notifications WHERE notification_id = ?1",
            params![notification_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(wid) = work_id else {
        return Ok(None);
    };
    touch_work_projection_for_work_in_tx(tx, &wid)
}

pub fn record_work_notification_identity_in_tx(
    tx: &Connection,
    notification_id: &str,
    work_id: &str,
) -> Result<(), DbError> {
    tx.execute(
        "INSERT INTO work_notification_identity (notification_id, input_snapshot_id, owner_epoch, sender_bot_id)
         SELECT ?1, input_snapshot_id, owner_epoch, owner_bot_id FROM works WHERE work_id = ?2
         ON CONFLICT (notification_id) DO NOTHING",
        params![notification_id, work_id],
    )?;
    Ok(())
}

// =========================================================================
// Family B: Memory Search Postings, Scope Version Deltas & Org Forget (10 triggers)
// =========================================================================

pub fn on_memory_record_changed_in_tx(
    tx: &Transaction<'_>,
    memory_id: &str,
    scopes: &[(String, Option<String>)],
    doc: Option<&SearchDocumentInput>,
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    if let Some(d) = doc {
        let postings = prepare_document_postings(d);
        let _ = publish_document_postings_in_tx(tx, d, &postings, now_ms)?;
    }
    for (scope_type, scope_id) in scopes {
        let scope_key = format_scope_key(scope_type, scope_id.as_deref());
        record_memory_change_in_tx(
            tx,
            &next_change_id("mem-upd", memory_id, now_ms),
            &scope_key,
            "memory",
            memory_id,
            operation_id,
            now_ms,
        )?;
    }
    Ok(())
}

pub fn on_memory_record_deleted_in_tx(
    tx: &Transaction<'_>,
    memory_id: &str,
    scopes: &[(String, Option<String>)],
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let doc_key = format!("memory:{memory_id}");
    delete_document_postings_in_tx(tx, &doc_key)?;

    for (scope_type, scope_id) in scopes {
        let scope_key = format_scope_key(scope_type, scope_id.as_deref());
        record_memory_change_in_tx(
            tx,
            &next_change_id("mem-del", memory_id, now_ms),
            &scope_key,
            "memory",
            memory_id,
            operation_id,
            now_ms,
        )?;
    }

    // Replaces `memory_organization_forget`: remove any org runs whose $.sourceIds contains memory_id
    let mut stmt = tx.prepare("SELECT id, state_json FROM memory_organization_runs")?;
    let mut rows = stmt.query([])?;
    let mut to_delete = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let state_json: String = row.get(1)?;
        if let Ok(val) = serde_json::from_str::<Value>(&state_json)
            && val["sourceIds"]
                .as_array()
                .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some(memory_id)))
        {
            to_delete.push(id);
        }
    }
    drop(rows);
    drop(stmt);
    for id in to_delete {
        tx.execute("DELETE FROM memory_organization_runs WHERE id = ?1", params![id])?;
    }
    Ok(())
}

pub fn on_memory_scope_changed_in_tx(
    tx: &Transaction<'_>,
    memory_id: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let scope_key = format_scope_key(scope_type, scope_id);
    record_memory_change_in_tx(
        tx,
        &next_change_id("mem-scope", memory_id, now_ms),
        &scope_key,
        "memory",
        memory_id,
        operation_id,
        now_ms,
    )?;
    Ok(())
}

pub fn on_memory_embedding_changed_in_tx(
    tx: &Transaction<'_>,
    memory_id: &str,
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let mut stmt = tx.prepare(
        "SELECT scope_type, scope_id FROM memory_scopes WHERE memory_id = ?1",
    )?;
    let mut rows = stmt.query(params![memory_id])?;
    let mut scopes = Vec::new();
    while let Some(row) = rows.next()? {
        scopes.push((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?));
    }
    drop(rows);
    drop(stmt);
    for (scope_type, scope_id) in scopes {
        let scope_key = format_scope_key(&scope_type, scope_id.as_deref());
        record_memory_change_in_tx(
            tx,
            &next_change_id("mem-vec", memory_id, now_ms),
            &scope_key,
            "vector",
            memory_id,
            operation_id,
            now_ms,
        )?;
    }
    Ok(())
}

// =========================================================================
// Family C: Task Board Day / Plan Rollup Triggers (8 triggers)
// =========================================================================

pub fn upsert_task_board_day_in_tx(
    tx: &Connection,
    id: &str,
    kind: &str,
    at_ms: i64,
    detail: &str,
) -> Result<(), DbError> {
    let day = local_day_from_ms(at_ms);
    let truncated: String = detail.chars().take(120).collect();
    tx.execute(
        "INSERT INTO task_board_days (id, kind, day, \"at\", detail)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id, kind, day) DO UPDATE SET
           \"at\" = excluded.\"at\",
           detail = excluded.detail
         WHERE excluded.\"at\" >= task_board_days.\"at\"",
        params![id, kind, day, at_ms, truncated],
    )?;
    Ok(())
}

pub fn on_task_ended_in_tx(tx: &Connection, task_id: &str, at_ms: i64) -> Result<(), DbError> {
    upsert_task_board_day_in_tx(tx, task_id, "result", at_ms, "")
}

pub fn on_task_deleted_in_tx(tx: &Connection, task_id: &str) -> Result<(), DbError> {
    tx.execute("DELETE FROM task_board_days WHERE id = ?1", params![task_id])?;
    tx.execute("DELETE FROM task_board_plans WHERE id = ?1", params![task_id])?;
    Ok(())
}

pub fn on_artifact_board_event_in_tx(
    tx: &Connection,
    task_id: &str,
    at_ms: i64,
    title: Option<&str>,
) -> Result<(), DbError> {
    upsert_task_board_day_in_tx(tx, task_id, "result", at_ms, title.unwrap_or(""))
}

pub fn on_interaction_answered_in_tx(
    tx: &Connection,
    task_id: &str,
    resolved_at_ms: i64,
    title: &str,
) -> Result<(), DbError> {
    upsert_task_board_day_in_tx(tx, task_id, "follow", resolved_at_ms, title)
}

pub fn on_bot_send_receipt_inserted_in_tx(
    tx: &Connection,
    user_id: &str,
    bot_id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    if user_id != "user-local-primary" {
        return Ok(());
    }
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT u.created_at, u.text
             FROM bot_send_receipts r
             JOIN bot_conversations c ON c.conversation_id = r.conversation_id
             JOIN bot_messages u ON u.message_id = r.user_message_id
             JOIN bot_messages a ON a.message_id = r.assistant_message_id
             WHERE r.user_id = ?1
               AND r.bot_id = ?2
               AND r.request_id = ?3
               AND c.user_id = r.user_id
               AND NOT starts_with(c.conversation_id, 'bot-inbox-')
               AND c.source_kind = 'user'
               AND c.ingress_kind = 'desktop'
               AND NOT EXISTS (SELECT 1 FROM bot_peer_inputs p WHERE p.assistant_message_id = a.message_id)",
            params![user_id, bot_id, request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((created_at, text)) = row {
        let board_id = format!("bot-request:{bot_id}:{request_id}");
        upsert_task_board_day_in_tx(tx, &board_id, "follow", created_at, &text)?;
    }
    Ok(())
}

pub fn on_bot_send_receipt_deleted_in_tx(
    tx: &Connection,
    bot_id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    let board_id = format!("bot-request:{bot_id}:{request_id}");
    tx.execute("DELETE FROM task_board_days WHERE id = ?1", params![board_id])?;
    tx.execute("DELETE FROM task_board_plans WHERE id = ?1", params![board_id])?;
    Ok(())
}

pub fn on_bot_peer_input_inserted_in_tx(
    tx: &Connection,
    assistant_message_id: &str,
) -> Result<(), DbError> {
    let mut stmt = tx.prepare(
        "SELECT bot_id, request_id FROM bot_send_receipts WHERE assistant_message_id = ?1",
    )?;
    let mut rows = stmt.query(params![assistant_message_id])?;
    let mut ids = Vec::new();
    while let Some(r) = rows.next()? {
        ids.push(format!("bot-request:{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?));
    }
    drop(rows);
    drop(stmt);
    for id in ids {
        tx.execute(
            "DELETE FROM task_board_days WHERE kind = 'follow' AND id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

pub fn on_bot_message_result_in_tx(
    tx: &Connection,
    assistant_message_id: &str,
    updated_at_ms: i64,
) -> Result<(), DbError> {
    let mut stmt = tx.prepare(
        "SELECT r.bot_id, r.request_id
         FROM bot_send_receipts r
         JOIN bot_conversations c ON c.conversation_id = r.conversation_id
         WHERE r.user_id = 'user-local-primary'
           AND c.user_id = r.user_id
           AND NOT starts_with(c.conversation_id, 'bot-inbox-')
           AND r.assistant_message_id = ?1",
    )?;
    let mut rows = stmt.query(params![assistant_message_id])?;
    let mut board_ids = Vec::new();
    while let Some(r) = rows.next()? {
        board_ids.push(format!("bot-request:{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?));
    }
    drop(rows);
    drop(stmt);
    for id in board_ids {
        upsert_task_board_day_in_tx(tx, &id, "result", updated_at_ms, "")?;
    }
    Ok(())
}

// =========================================================================
// Family D: Bot Message & Collaboration Revision Triggers (11 triggers)
// =========================================================================

pub fn bump_bot_message_revision_in_tx(tx: &Connection, message_id: &str) -> Result<(), DbError> {
    tx.execute(
        "INSERT INTO bot_message_revisions (message_id, revision) VALUES (?1, 1)
         ON CONFLICT (message_id) DO UPDATE SET revision = bot_message_revisions.revision + 1",
        params![message_id],
    )?;
    Ok(())
}

pub fn on_bot_collaboration_message_inserted_in_tx(
    tx: &Connection,
    message_id: &str,
) -> Result<(), DbError> {
    let next_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM bot_collaboration_message_order",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO bot_collaboration_message_order (sequence, message_id) VALUES (?1, ?2)
         ON CONFLICT (message_id) DO NOTHING",
        params![next_seq, message_id],
    )?;
    Ok(())
}

pub fn bump_bot_collaboration_source_revision_in_tx(
    tx: &Connection,
    collaboration_id: &str,
) -> Result<(), DbError> {
    tx.execute(
        "UPDATE bot_message_revisions
         SET revision = revision + 1
         WHERE message_id IN (
           SELECT user_message_id FROM bot_collaboration_requests WHERE collaboration_id = ?1
           UNION
           SELECT assistant_message_id FROM bot_collaboration_requests WHERE collaboration_id = ?1
         )",
        params![collaboration_id],
    )?;
    tx.execute(
        "UPDATE bot_conversations
         SET revision = revision + 1
         WHERE conversation_id IN (
           SELECT conversation_id FROM bot_collaboration_requests WHERE collaboration_id = ?1
         )",
        params![collaboration_id],
    )?;
    Ok(())
}

pub fn on_bot_collaboration_link_inserted_in_tx(
    tx: &Connection,
    conversation_id: &str,
    user_message_id: &str,
    assistant_message_id: &str,
) -> Result<(), DbError> {
    bump_bot_message_revision_in_tx(tx, user_message_id)?;
    bump_bot_message_revision_in_tx(tx, assistant_message_id)?;
    tx.execute(
        "UPDATE bot_conversations SET revision = revision + 1 WHERE conversation_id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

pub fn on_work_updated_touch_collaboration_in_tx(
    tx: &Connection,
    work_id: &str,
    updated_at: i64,
) -> Result<(), DbError> {
    tx.execute(
        "UPDATE bot_collaborations SET updated_at = GREATEST(updated_at, ?1) WHERE work_id = ?2",
        params![updated_at, work_id],
    )?;
    Ok(())
}

pub fn on_bot_peer_call_changed_in_tx(
    tx: &Connection,
    parent_message_id: &str,
) -> Result<(), DbError> {
    tx.execute(
        "UPDATE bot_message_revisions SET revision = revision + 1 WHERE message_id = ?1",
        params![parent_message_id],
    )?;
    tx.execute(
        "UPDATE bot_conversations
         SET revision = revision + 1
         WHERE conversation_id = (SELECT conversation_id FROM bot_messages WHERE message_id = ?1)",
        params![parent_message_id],
    )?;
    Ok(())
}

// =========================================================================
// Family E: Runtime Snapshot Payload GC Trigger (1 trigger)
// =========================================================================

pub fn cleanup_orphan_runtime_audit_payloads_in_tx(
    tx: &Connection,
    instructions_hash: Option<&str>,
    capabilities_hash: Option<&str>,
) -> Result<(), DbError> {
    for hash in [instructions_hash, capabilities_hash].into_iter().flatten() {
        tx.execute(
            "DELETE FROM runtime_audit_payloads
             WHERE hash = ?1
               AND NOT EXISTS (SELECT 1 FROM task_runtime_context_snapshots WHERE instructions_hash = ?1)
               AND NOT EXISTS (SELECT 1 FROM task_runtime_context_snapshots WHERE capabilities_hash = ?1)",
            params![hash],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{DuckDbEngine, DuckDbPoolConfig};
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-trig-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn explicit_trigger_effects_cover_all_five_trigger_families_in_duckdb() {
        let dir = temp_dir("all");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
        let tx = w.conn_mut().transaction().unwrap();

        // Family A: work projection + notification identity + bounded retention
        tx.execute(
            "INSERT INTO works (work_id, user_id, owner_bot_id, owner_epoch, title, authorization_json, active_intent_snapshot_id, input_snapshot_id, created_by, created_at, updated_at)
             VALUES ('w1', 'u1', 'bot1', 7, 'Title', '{}', 'intent1', 'snap1', 'user', 1, 1)",
            [],
        ).unwrap();
        let seq1 = touch_work_projection_for_work_in_tx(&tx, "w1").unwrap().unwrap();
        assert_eq!(seq1, 1);
        tx.execute(
            "INSERT INTO work_notifications (notification_id, work_id, semantic_key, kind, title, state_version, intent_revision, created_at)
             VALUES ('notif1', 'w1', 'sem1', 'result', 'Done', 1, 1, 1)",
            [],
        ).unwrap();
        record_work_notification_identity_in_tx(&tx, "notif1", "w1").unwrap();
        let owner_epoch: i64 = tx
            .query_row("SELECT owner_epoch FROM work_notification_identity WHERE notification_id = 'notif1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owner_epoch, 7);

        // Family B: memory search postings + scope deltas + memory_organization_forget
        tx.execute(
            "INSERT INTO memory_organization_runs (id, created_at, updated_at, state_json)
             VALUES ('org1', 1, 1, '{\"sourceIds\":[\"m1\",\"m2\"]}'), ('org2', 1, 1, '{\"sourceIds\":[\"m2\"]}')",
            [],
        ).unwrap();
        on_memory_record_changed_in_tx(
            &tx,
            "m1",
            &[("global".into(), None)],
            Some(&SearchDocumentInput {
                doc_key: "memory:m1".into(),
                domain: "memory".into(),
                scope: "global".into(),
                entity_id: "m1".into(),
                title: "DS3806 note".into(),
                body: "记忆索引".into(),
                content_revision: 1,
                content_hash: "h1".into(),
                metadata_json: None,
            }),
            "op-1",
            100,
        ).unwrap();
        on_memory_record_deleted_in_tx(&tx, "m1", &[("global".into(), None)], "op-2", 200).unwrap();
        let org1_exists: i64 = tx
            .query_row("SELECT COUNT(*) FROM memory_organization_runs WHERE id = 'org1'", [], |r| r.get(0))
            .unwrap();
        let org2_exists: i64 = tx
            .query_row("SELECT COUNT(*) FROM memory_organization_runs WHERE id = 'org2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(org1_exists, 0);
        assert_eq!(org2_exists, 1);

        // Family C: task_board_days / plans upsert & delete
        on_task_ended_in_tx(&tx, "t-board-1", 1_700_000_000_000).unwrap();
        let board_cnt: i64 = tx
            .query_row("SELECT COUNT(*) FROM task_board_days WHERE id = 't-board-1' AND kind = 'result'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(board_cnt, 1);
        on_task_deleted_in_tx(&tx, "t-board-1").unwrap();
        let board_after: i64 = tx
            .query_row("SELECT COUNT(*) FROM task_board_days WHERE id = 't-board-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(board_after, 0);

        // Family D: bot revisions & collaboration order
        bump_bot_message_revision_in_tx(&tx, "msg-1").unwrap();
        bump_bot_message_revision_in_tx(&tx, "msg-1").unwrap();
        let rev: i64 = tx
            .query_row("SELECT revision FROM bot_message_revisions WHERE message_id = 'msg-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rev, 2);
        on_bot_collaboration_message_inserted_in_tx(&tx, "cm-1").unwrap();
        let seq: i64 = tx
            .query_row("SELECT sequence FROM bot_collaboration_message_order WHERE message_id = 'cm-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seq, 1);

        // Family E: runtime_audit_payloads orphan cleanup
        tx.execute("INSERT INTO runtime_audit_payloads (hash, body) VALUES ('h-inst', 'body'), ('h-keep', 'keep')", []).unwrap();
        tx.execute(
            "INSERT INTO task_runtime_context_snapshots (id, task_id, user_message_id, assistant_message_id, created_at, welcome_mode, resolved_instructions_json, resolved_capabilities_json, instructions_hash)
             VALUES ('s-keep', 't1', 'u1', 'a1', 1, 'general', '[]', '[]', 'h-keep')",
            [],
        ).unwrap();
        cleanup_orphan_runtime_audit_payloads_in_tx(&tx, Some("h-inst"), Some("h-keep")).unwrap();
        let rem_inst: i64 = tx.query_row("SELECT COUNT(*) FROM runtime_audit_payloads WHERE hash = 'h-inst'", [], |r| r.get(0)).unwrap();
        let rem_keep: i64 = tx.query_row("SELECT COUNT(*) FROM runtime_audit_payloads WHERE hash = 'h-keep'", [], |r| r.get(0)).unwrap();
        assert_eq!(rem_inst, 0);
        assert_eq!(rem_keep, 1);

        tx.commit().unwrap();
        drop(w);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
