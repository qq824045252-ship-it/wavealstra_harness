use crate::{
    Result,
    outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx},
    pi_storage,
};
use duckdb::{OptionalExt, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalFence {
    task_id: String,
    work_id: String,
    intent_revision: i64,
    state_version: i64,
    owner_epoch: i64,
    attempt_serial: i64,
    deferred_at: i64,
    continuation_updated_at: i64,
    defer_reason: String,
}

pub(crate) struct Placement {
    fence: GoalFence,
    conversation_id: i64,
    entry_id: i64,
    submission_id: i64,
    request_key: String,
}

fn input_marker(write: &Value) -> Option<(&Value, &Value)> {
    let entry = &write["value"];
    let input = &entry["data"]["mybuddyInput"];
    let marker = input.get("goalUserInput")?;
    if write["type"] != "entry"
        || entry["kind"] != "mybuddy.user"
        || !marker.is_object()
        || ["gatewayOrigin", "botRequestId", "goalContinuation"]
            .iter()
            .any(|key| !input[*key].is_null())
    {
        return None;
    }
    Some((entry, marker))
}

pub(crate) fn resource_task(write: &Value) -> Option<String> {
    let (_, marker) = input_marker(write)?;
    let encoded = marker["taskId"].as_str()?;
    String::from_utf16(&pi_storage::decode_pi_string(encoded)).ok()
}

/// Collect candidates before the Pi batch replaces its request index. Only an absent
/// request or the first placement of its own queued submission can change the ledger.
pub(crate) fn prepare(
    tx: &Transaction<'_>,
    store: &str,
    batch: &[Value],
) -> Result<Vec<Placement>> {
    if !batch.iter().any(|write| input_marker(write).is_some()) {
        return Ok(Vec::new());
    }
    let mut submissions = HashMap::new();
    for write in batch {
        let value = &write["value"];
        if write["type"] == "submission"
            && value["type"] == "input"
            && value["status"] == "placed"
            && let Some(entry_id) = value["entry"].as_i64()
        {
            submissions.insert(entry_id, value);
        }
    }
    let mut placements = Vec::new();
    for (entry, marker) in batch.iter().filter_map(input_marker) {
        let Some(entry_id) = entry["id"].as_i64() else {
            continue;
        };
        let Some(submission) = submissions.get(&entry_id) else {
            continue;
        };
        let Some(conversation_id) = entry["conversationId"].as_i64() else {
            continue;
        };
        let Some(submission_id) = submission["id"].as_i64() else {
            continue;
        };
        let Some(request_id) = submission["requestId"].as_str() else {
            continue;
        };
        if request_id.is_empty()
            || submission["conversationId"] != conversation_id
            || entry["data"]["mybuddyInput"]["inputRequestId"] != request_id
            || [
                "goal-continuation:",
                "dots-input-",
                "cron-",
                "regenerate:",
                "gateway-",
            ]
            .iter()
            .any(|prefix| request_id.starts_with(prefix))
        {
            continue;
        }
        let Ok(mut fence) = serde_json::from_value::<GoalFence>(marker.clone()) else {
            continue;
        };
        let Ok(task_id) = String::from_utf16(&pi_storage::decode_pi_string(&fence.task_id)) else {
            continue;
        };
        fence.task_id = task_id;
        if fence.task_id.is_empty()
            || fence.task_id == "mybuddy-dots"
            || !matches!(
                fence.defer_reason.as_str(),
                "user_interrupt"
                    | "turn_aborted"
                    | "run_failed"
                    | "restart"
                    | "no_progress"
                    | "manual_stop"
            )
        {
            continue;
        }
        let request_key = pi_storage::encode_indexed_str(request_id);
        let prior: Option<(i64, String)> = tx.query_row(
            "SELECT k.submission_id,s.status FROM durable_request_keys k JOIN durable_submissions s
                ON s.store_id=k.store_id AND s.id=k.submission_id
              WHERE k.store_id=?1 AND k.conversation_id=?2 AND k.request_id=?3",
            params![store, conversation_id, request_key],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if prior.is_some_and(|(prior_id, status)| prior_id != submission_id || status != "queued") {
            continue;
        }
        placements.push(Placement {
            fence,
            conversation_id,
            entry_id,
            submission_id,
            request_key,
        });
    }
    Ok(placements)
}

pub(crate) fn accept(
    tx: &Transaction<'_>,
    store: &str,
    incarnation: &str,
    host: &str,
    now: i64,
    placement: Placement,
) -> Result<()> {
    let Placement {
        fence,
        conversation_id,
        entry_id,
        submission_id,
        request_key,
    } = placement;
    let committed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM durable_submissions s JOIN durable_request_keys k
        ON k.store_id=s.store_id AND k.conversation_id=s.conversation_id AND k.submission_id=s.id
        WHERE s.store_id=?1 AND s.conversation_id=?2 AND s.id=?3 AND k.request_id=?4 AND s.status='placed'
          AND json_extract_string(s.record_json,'$.type')='input' AND try_cast(json_extract_string(s.record_json,'$.entry') AS BIGINT)=?5)",
        params![store, conversation_id, submission_id, request_key, entry_id], |row| row.get(0))?;
    if !committed {
        return Ok(());
    }
    if !pi_storage::is_goal_input_conversation(tx, store, conversation_id)? {
        return Ok(());
    }
    let authority: Option<(String, String)> = tx.query_row(
        "SELECT d.directory,w.user_id FROM tasks t JOIN durable_bot_bindings d ON d.task_id=t.id AND d.backend='pi-durable'
          JOIN work_conversations link ON link.conversation_id=t.id JOIN works w ON w.work_id=link.work_id
          WHERE t.id=?1 AND w.work_id=?2 AND w.lifecycle='active' AND t.archived=0
            AND t.external_agent_pin_json IS NULL
            AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state x WHERE x.task_id=t.id AND x.state='trashed')
            AND NOT EXISTS(WITH RECURSIVE parents(id,parent_id,archived) AS (
              SELECT id,parent_id,archived FROM spaces WHERE id=t.space_id
              UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id
            ) SELECT 1 FROM parents WHERE archived<>0)
            AND NOT EXISTS(SELECT 1 FROM work_conversations other JOIN works candidate USING(work_id)
                 WHERE other.conversation_id=t.id AND other.work_id<>w.work_id AND candidate.lifecycle<>'closed')
            AND w.intent_revision=?3 AND w.state_version=?4 AND w.owner_epoch=?5",
        params![fence.task_id, fence.work_id, fence.intent_revision, fence.state_version, fence.owner_epoch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((directory, user_id)) = authority else {
        return Ok(());
    };
    if crate::durable::store_id_for_path(Path::new(&directory)) != store {
        return Ok(());
    }

    let changed = tx.execute("UPDATE conversation_goal_continuations
        SET state='idle', defer_reason=NULL, deferred_at=NULL, progress_stalls=0, updated_at=greatest(updated_at+1,?1)
        WHERE work_id=?2 AND task_id=?3 AND intent_revision=?4 AND attempt_serial=?5 AND state='deferred'
          AND deferred_at=?6 AND updated_at=?7 AND defer_reason=?8",
        params![now, fence.work_id, fence.task_id, fence.intent_revision, fence.attempt_serial,
            fence.deferred_at, fence.continuation_updated_at, fence.defer_reason])?;
    if changed == 0 {
        return Ok(());
    }
    let event_id = format!(
        "goal-user-input:{}",
        json!([incarnation, conversation_id, submission_id, entry_id])
    );
    append_outbox_group_in_tx(tx,
        &OutboxGroupDraft { group_id: event_id.clone(), operation_id: event_id.clone(), batch_index: 0,
            entity_key: format!("work:{}", fence.work_id), entity_revision: None,
            previous_revision: None, depends_on_group_id: None, work_projection_user_id: Some(user_id) },
        &[OutboxEventDraft { event_id: event_id.clone(), owner_generation: host.into(), domain: "work".into(),
            kind: "work.goalContinuationCleared".into(), task_id: Some(fence.task_id.clone()),
            entity_id: fence.work_id.clone(), revision: fence.intent_revision, command_id: Some(event_id),
            payload_json: json!({"taskId":fence.task_id,"workId":fence.work_id,"intentRevision":fence.intent_revision,
                "attemptSerial":fence.attempt_serial,"state":"idle","reason":"user_message",
                "conversationId":conversation_id,"submissionId":submission_id,"entryId":entry_id}).to_string() }], now)?;
    Ok(())
}
