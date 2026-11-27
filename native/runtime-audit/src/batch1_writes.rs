//! Rust-owned Batch 1 transactional writes (`Step 4 Stage 4.1`, `RC-09`/`RC-10`):
//! runtime epochs, Python project bindings, Pi Azure selection migration, execution
//! attempts, conversation interactions, loadout observations, goal activity & saved
//! artifact verification.

use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[path = "goal_saved_artifact_verification.rs"]
pub(crate) mod goal_saved_artifact_verification;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    SavePythonBinding {
        dir_key: String,
        project_dir: String,
        python_path: String,
        python_version: Option<String>,
        manifest_path: Option<String>,
        bound_at: i64,
    },
    RemovePythonBinding {
        dir_key: String,
    },
    MigratePiAzureSelections,
    ExecutionAttemptInsert {
        id: String,
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        tool_call_id: String,
        target: String,
        status: String,
        record_json: String,
        created_at: i64,
        #[serde(default)]
        if_absent: bool,
    },
    ExecutionAttemptUpdate {
        id: String,
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        tool_call_id: String,
        target: String,
        status: String,
        record_json: String,
        finished_at: Option<i64>,
    },
    ExecutionAttemptSettleDurable {
        id: String,
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        tool_call_id: String,
        target: String,
        status: String,
        record_json: String,
        finished_at: Option<i64>,
        allow_inconclusive_settle: bool,
    },
    ExecutionAttemptRecoverInterrupted {
        at: i64,
    },
    InteractionInsert {
        id: String,
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        kind_name: String,
        title: String,
        description: Option<String>,
        options_json: String,
        min_selections: Option<i64>,
        max_selections: Option<i64>,
        allow_custom: i64,
        custom_placeholder: Option<String>,
        status: String,
        answer_json: Option<String>,
        version: i64,
        created_at: i64,
        resolved_at: Option<i64>,
    },
    InteractionDeleteFrom {
        task_id: String,
        created_at: i64,
    },
    InteractionSettle {
        id: String,
        task_id: String,
        status: String,
        answer_json: Option<String>,
        resolved_at: i64,
    },
    InteractionCancelExecution {
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        resolved_at: i64,
    },
    InteractionExpireAllPending {
        resolved_at: i64,
    },
    LoadoutRecordTurn {
        id: String,
        task_id: String,
        user_message_id: String,
        assistant_message_id: String,
        query_hash: String,
        context_json: String,
        recommended_json: String,
        actual_json: String,
        matched_actual_json: String,
        not_selected_json: String,
        blocked_json: String,
        at: i64,
        cutoff: i64,
        max_records: i64,
        #[serde(default)]
        if_absent: bool,
    },
    LoadoutMarkSkillUsed {
        task_id: String,
        assistant_message_id: String,
        skill_id: String,
        at: i64,
    },
    LoadoutMarkOutcome {
        task_id: String,
        assistant_message_id: String,
        outcome: String,
        at: i64,
    },
    LoadoutAbortPending {
        task_id: String,
        at: i64,
    },
    LoadoutClear {
        task_id: Option<String>,
    },
    GoalActivityAdmit {
        user_id: String,
        task_id: String,
        conversation_id: String,
        generation_id: i64,
        work_id: Option<String>,
        parent: Option<GoalGenerationIdentity>,
        metadata_json: String,
    },
    GoalActivityRecordAuxiliaryScope {
        scope: String,
        task_id: String,
        conversation_id: String,
        generation_id: i64,
    },
    GoalActivitySettle {
        user_id: String,
        task_id: String,
        conversation_id: String,
        generation_id: i64,
        outcome: String,
        message_id: Option<String>,
    },
    GoalActivityRecordTool {
        task_id: String,
        parent_conversation_id: String,
        parent_generation_id: i64,
        tool_call_id: String,
        results: Vec<GoalToolReturn>,
    },
    GoalActivityRecordSkill {
        task_id: String,
        conversation_id: String,
        generation_id: i64,
        key: String,
        evidence_json: String,
    },
    GoalActivityRecordAuthoredSkillRead {
        path_key: String,
        fingerprint: String,
        at: i64,
    },
    GoalSavedArtifactConfirm {
        work_id: String,
        task_id: String,
        user_id: String,
        artifact_id: String,
        expected_intent_revision: i64,
        source: goal_saved_artifact_verification::Source,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalGenerationIdentity {
    conversation_id: String,
    generation_task_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalToolReturn {
    native_conversation_id: i64,
    subagent_id: String,
    status: String,
    outcome: Option<String>,
}

fn interaction_row(row: &duckdb::Row<'_>) -> duckdb::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "task_id": row.get::<_, String>(1)?,
        "execution_id": row.get::<_, String>(2)?,
        "assistant_message_id": row.get::<_, String>(3)?,
        "kind": row.get::<_, String>(4)?,
        "title": row.get::<_, String>(5)?,
        "description": row.get::<_, Option<String>>(6)?,
        "options_json": row.get::<_, String>(7)?,
        "min_selections": row.get::<_, Option<i64>>(8)?,
        "max_selections": row.get::<_, Option<i64>>(9)?,
        "allow_custom": row.get::<_, i64>(10)?,
        "custom_placeholder": row.get::<_, Option<String>>(11)?,
        "status": row.get::<_, String>(12)?,
        "answer_json": row.get::<_, Option<String>>(13)?,
        "version": row.get::<_, i64>(14)?,
        "created_at": row.get::<_, i64>(15)?,
        "resolved_at": row.get::<_, Option<i64>>(16)?,
    }))
}

const SELECT_INTERACTION: &str = "SELECT id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at FROM conversation_interactions";

pub fn run(db: &mut Connection, request: Request) -> Result<Value> {
    let tx = db.transaction()?;
    let out = match request {
        Request::SavePythonBinding {
            dir_key,
            project_dir,
            python_path,
            python_version,
            manifest_path,
            bound_at,
        } => {
            tx.execute(
                "INSERT INTO python_project_bindings
                   (dir_key, project_dir, python_path, python_version, manifest_path, bound_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(dir_key) DO UPDATE SET
                   project_dir = excluded.project_dir,
                   python_path = excluded.python_path,
                   python_version = excluded.python_version,
                   manifest_path = excluded.manifest_path,
                   bound_at = excluded.bound_at",
                params![
                    dir_key,
                    project_dir,
                    python_path,
                    python_version,
                    manifest_path,
                    bound_at
                ],
            )?;
            json!({ "saved": true })
        }
        Request::RemovePythonBinding { dir_key } => {
            let changes = tx.execute(
                "DELETE FROM python_project_bindings WHERE dir_key = ?1",
                [dir_key],
            )?;
            json!({ "deleted": changes > 0 })
        }
        Request::MigratePiAzureSelections => {
            let legacy = "azure-openai-responses";
            let current = "azure";
            let start = (legacy.len() + 1) as i64;
            let prefix = format!("{legacy}/");
            let mut count = 0usize;
            for table in ["tasks", "cron_jobs"] {
                let sql = format!(
                    "UPDATE {table} SET model_id = ?1 || substr(model_id, ?2) WHERE substr(model_id, 1, ?2) = ?3"
                );
                count += tx.execute(&sql, params![current, start, prefix])?;
            }
            json!({ "selections": count })
        }
        Request::ExecutionAttemptInsert {
            id,
            task_id,
            execution_id,
            assistant_message_id,
            tool_call_id,
            target,
            status,
            record_json,
            created_at,
            if_absent,
        } => {
            const INSERT_ATTEMPT: &str = "INSERT INTO execution_attempts
                 (id,task_id,execution_id,assistant_message_id,tool_call_id,target,status,record_json,created_at)
                 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS(SELECT 1 FROM tasks WHERE id=?2)";
            let conflict = if if_absent { " ON CONFLICT(id) DO NOTHING" } else { "" };
            tx.execute(&format!("{INSERT_ATTEMPT}{conflict}"), params![
                id, task_id, execution_id, assistant_message_id, tool_call_id, target, status, record_json, created_at,
            ])?;
            let saved: String = tx.query_row(
                "SELECT record_json FROM execution_attempts WHERE id=?1 AND task_id=?2
                 AND execution_id=?3 AND assistant_message_id=?4 AND tool_call_id=?5 AND target=?6",
                params![id, task_id, execution_id, assistant_message_id, tool_call_id, target], |row| row.get(0),
            ).optional()?.ok_or("Execution attempt has no matching task and tool identity")?;
            if if_absent { json!({ "ok": true, "recordJson": saved }) } else { json!({ "ok": true }) }
        }
        Request::ExecutionAttemptUpdate {
            id,
            task_id,
            execution_id,
            assistant_message_id,
            tool_call_id,
            target,
            status,
            record_json,
            finished_at,
        } => {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM execution_attempts WHERE id=?1 AND task_id=?2 AND execution_id=?3 AND assistant_message_id=?4 AND tool_call_id=?5 AND target=?6 AND status='running'",
                    params![id, task_id, execution_id, assistant_message_id, tool_call_id, target],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err("Stale execution attempt update".into());
            }
            let changes = tx.execute(
                "UPDATE execution_attempts SET status=?1,record_json=?2,finished_at=?3
                 WHERE id=?4 AND task_id=?5 AND execution_id=?6 AND assistant_message_id=?7 AND status='running'",
                params![status, record_json, finished_at, id, task_id, execution_id, assistant_message_id],
            )?;
            if changes != 1 {
                return Err("Stale execution attempt update".into());
            }
            json!({ "ok": true })
        }
        Request::ExecutionAttemptSettleDurable {
            id,
            task_id,
            execution_id,
            assistant_message_id,
            tool_call_id,
            target,
            status,
            record_json,
            finished_at,
            allow_inconclusive_settle,
        } => {
            let current: Option<(String, String)> = tx
                .query_row(
                    "SELECT status, record_json FROM execution_attempts WHERE id=?1 AND task_id=?2
                     AND execution_id=?3 AND assistant_message_id=?4 AND tool_call_id=?5 AND target=?6",
                    params![id, task_id, execution_id, assistant_message_id, tool_call_id, target],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((prior_status, prior_json)) = current else {
                return Err("Durable execution attempt is missing".into());
            };
            let prior: Value = serde_json::from_str(&prior_json)?;
            let replacement: Value = serde_json::from_str(&record_json)?;
            if !prior["nativeReceipt"].is_null() && prior["nativeReceipt"] != replacement["nativeReceipt"] {
                return Err("Durable execution receipt cannot be replaced".into());
            }
            if prior_status == "running" || (prior_status == "inconclusive" && allow_inconclusive_settle
                && prior["causeCode"] == "application-restarted") {
                let changes = tx.execute(
                    "UPDATE execution_attempts SET status=?1,record_json=?2,finished_at=?3
                     WHERE id=?4 AND status=?5 AND record_json=?6",
                    params![status, record_json, finished_at, id, prior_status, prior_json],
                )?;
                if changes != 1 {
                    return Err("Stale execution attempt update".into());
                }
            }
            json!({ "ok": true })
        }
        Request::ExecutionAttemptRecoverInterrupted { at } => {
            let mut stmt = tx.prepare("SELECT record_json FROM execution_attempts WHERE status='running'")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()?;
            drop(stmt);
            let mut update = tx.prepare(
                "UPDATE execution_attempts SET status='inconclusive',record_json=?1,finished_at=?2
                 WHERE id=?3 AND task_id=?4 AND execution_id=?5 AND assistant_message_id=?6 AND status='running'",
            )?;
            let mut recovered = Vec::new();
            for raw in rows {
                let mut value: Value = serde_json::from_str(&raw)?;
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("status".into(), Value::String("inconclusive".into()));
                    obj.insert("phase".into(), Value::String("finished".into()));
                    obj.insert(
                        "causeCode".into(),
                        Value::String("application-restarted".into()),
                    );
                    obj.insert("recovery".into(), Value::String("recoverable".into()));
                    obj.insert("finishedAt".into(), json!(at));
                }
                let id = value["id"].as_str().unwrap_or_default().to_owned();
                let task_id = value["taskId"].as_str().unwrap_or_default().to_owned();
                let execution_id = value["executionId"].as_str().unwrap_or_default().to_owned();
                let assistant_message_id = value["assistantMessageId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let encoded = serde_json::to_string(&value)?;
                let changes = update.execute(params![
                    encoded,
                    at,
                    id,
                    task_id,
                    execution_id,
                    assistant_message_id
                ])?;
                if changes == 1 {
                    recovered.push(value);
                }
            }
            drop(update);
            json!({ "recovered": recovered })
        }
        Request::InteractionInsert {
            id,
            task_id,
            execution_id,
            assistant_message_id,
            kind_name,
            title,
            description,
            options_json,
            min_selections,
            max_selections,
            allow_custom,
            custom_placeholder,
            status,
            answer_json,
            version,
            created_at,
            resolved_at,
        } => {
            let inserted = tx.execute(
                "INSERT INTO conversation_interactions
                 (id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
                  max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at)
                 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17
                 WHERE EXISTS(SELECT 1 FROM tasks WHERE id=?2)
                   AND (?13<>'pending' OR NOT EXISTS(SELECT 1 FROM conversation_interactions WHERE execution_id=?3 AND status='pending'))",
                params![
                    id,
                    task_id,
                    execution_id,
                    assistant_message_id,
                    kind_name,
                    title,
                    description,
                    options_json,
                    min_selections,
                    max_selections,
                    allow_custom,
                    custom_placeholder,
                    status,
                    answer_json,
                    version,
                    created_at,
                    resolved_at
                ],
            )?;
            if inserted == 0 { return Ok(json!({ "row": null })); }
            let row = tx.query_row(
                &format!("{SELECT_INTERACTION} WHERE id=?1"),
                [&id],
                interaction_row,
            )?;
            json!({ "row": row })
        }
        Request::InteractionDeleteFrom {
            task_id,
            created_at,
        } => {
            let changes = tx.execute(
                "DELETE FROM conversation_interactions WHERE task_id=?1 AND created_at>=?2",
                params![task_id, created_at],
            )?;
            json!({ "changes": changes })
        }
        Request::InteractionSettle {
            id,
            task_id,
            status,
            answer_json,
            resolved_at,
        } => {
            let changes = tx.execute(
                "UPDATE conversation_interactions
                 SET status=?1, answer_json=?2, version=version+1, resolved_at=?3
                 WHERE id=?4 AND task_id=?5 AND status='pending'",
                params![status, answer_json, resolved_at, id, task_id],
            )?;
            let row = if changes > 0 {
                tx.query_row(
                    &format!("{SELECT_INTERACTION} WHERE id=?1"),
                    [&id],
                    interaction_row,
                )
                .optional()?
            } else {
                None
            };
            if let Some(title) = row.as_ref().filter(|_| status == "resolved").and_then(|row| row["title"].as_str()) {
                crate::trigger_effects::on_interaction_answered_in_tx(&tx, &task_id, resolved_at, title)?;
            }
            json!({ "row": row })
        }
        Request::InteractionCancelExecution { task_id, execution_id, assistant_message_id, resolved_at } => {
            let mut update = tx.prepare(
                "UPDATE conversation_interactions SET status='cancelled', version=version+1, resolved_at=?1
                 WHERE task_id=?2 AND execution_id=?3 AND assistant_message_id=?4 AND status='pending'
                 RETURNING id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
                 max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at",
            )?;
            let rows = update.query_map(params![resolved_at, task_id, execution_id, assistant_message_id], interaction_row)?
                .collect::<duckdb::Result<Vec<_>>>()?;
            json!({ "rows": rows })
        }
        Request::InteractionExpireAllPending { resolved_at } => {
            let mut stmt = tx.prepare("SELECT id FROM conversation_interactions WHERE status='pending'")?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()?;
            drop(stmt);
            tx.execute(
                "UPDATE conversation_interactions SET status='expired', version=version+1, resolved_at=?1 WHERE status='pending'",
                [resolved_at],
            )?;
            let mut rows = Vec::new();
            let mut select = tx.prepare(&format!("{SELECT_INTERACTION} WHERE id=?1"))?;
            for id in ids {
                if let Some(row) = select.query_row([&id], interaction_row).optional()? {
                    rows.push(row);
                }
            }
            drop(select);
            json!({ "rows": rows })
        }
        Request::LoadoutRecordTurn {
            id,
            task_id,
            user_message_id,
            assistant_message_id,
            query_hash,
            context_json,
            recommended_json,
            actual_json,
            matched_actual_json,
            not_selected_json,
            blocked_json,
            at,
            cutoff,
            max_records,
            if_absent,
        } => {
            let on_conflict = if if_absent {
                "DO NOTHING"
            } else {
                "DO UPDATE SET
                   user_message_id=excluded.user_message_id,
                   query_hash=excluded.query_hash,
                   context_json=excluded.context_json,
                   recommended_json=excluded.recommended_json,
                   actual_json=excluded.actual_json,
                   matched_actual_json=excluded.matched_actual_json,
                   not_selected_json=excluded.not_selected_json,
                   blocked_json=excluded.blocked_json,
                   used_skill_ids_json='[]',
                   outcome='pending',
                   completed_at=NULL,
                   created_at=excluded.created_at,
                   updated_at=excluded.updated_at"
            };
            let changed = tx.execute(
                &format!("INSERT INTO agent_loadout_observations (
                   id,task_id,user_message_id,assistant_message_id,query_hash,context_json,
                   recommended_json,actual_json,matched_actual_json,not_selected_json,blocked_json,used_skill_ids_json,
                   outcome,created_at,updated_at
                 ) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'[]','pending',?12,?12
                   WHERE EXISTS (SELECT 1 FROM tasks WHERE id=?2)
                 ON CONFLICT(task_id, assistant_message_id) {on_conflict}"),
                params![
                    id,
                    task_id,
                    user_message_id,
                    assistant_message_id,
                    query_hash,
                    context_json,
                    recommended_json,
                    actual_json,
                    matched_actual_json,
                    not_selected_json,
                    blocked_json,
                    at
                ],
            )?;
            if changed > 0 {
                tx.execute(
                    "DELETE FROM agent_loadout_observations WHERE task_id=?1 AND created_at<?2",
                    params![task_id, cutoff],
                )?;
                tx.execute(
                    "DELETE FROM agent_loadout_observations
                     WHERE task_id=?1 AND id NOT IN (
                       SELECT id FROM agent_loadout_observations WHERE task_id=?1
                       ORDER BY created_at DESC,rowid DESC LIMIT ?2
                     )",
                    params![task_id, max_records],
                )?;
            }
            json!({ "ok": true })
        }
        Request::LoadoutMarkSkillUsed {
            task_id,
            assistant_message_id,
            skill_id,
            at,
        } => {
            let current: Option<String> = tx
                .query_row(
                    "SELECT used_skill_ids_json FROM agent_loadout_observations WHERE task_id=?1 AND assistant_message_id=?2",
                    params![task_id, assistant_message_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(raw) = current {
                let existing: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                let mut seen = HashSet::new();
                let mut next = Vec::new();
                for item in existing.into_iter().chain(std::iter::once(skill_id)) {
                    if !item.is_empty() && seen.insert(item.clone()) {
                        next.push(item);
                    }
                }
                let encoded = serde_json::to_string(&next)?;
                tx.execute(
                    "UPDATE agent_loadout_observations SET used_skill_ids_json=?1,updated_at=?2 WHERE task_id=?3 AND assistant_message_id=?4",
                    params![encoded, at, task_id, assistant_message_id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::LoadoutMarkOutcome {
            task_id,
            assistant_message_id,
            outcome,
            at,
        } => {
            tx.execute(
                "UPDATE agent_loadout_observations SET outcome=?1,completed_at=?2,updated_at=?2
                 WHERE task_id=?3 AND assistant_message_id=?4 AND outcome='pending'",
                params![outcome, at, task_id, assistant_message_id],
            )?;
            json!({ "ok": true })
        }
        Request::LoadoutAbortPending { task_id, at } => {
            tx.execute(
                "UPDATE agent_loadout_observations SET outcome='aborted',completed_at=?1,updated_at=?1
                 WHERE task_id=?2 AND outcome='pending'",
                params![at, task_id],
            )?;
            json!({ "ok": true })
        }
        Request::LoadoutClear { task_id } => {
            let changes = if let Some(id) = task_id {
                tx.execute("DELETE FROM agent_loadout_observations WHERE task_id=?1", [id])?
            } else {
                tx.execute("DELETE FROM agent_loadout_observations", [])?
            };
            json!({ "changes": changes })
        }
        Request::GoalActivityAdmit {
            user_id,
            task_id,
            conversation_id,
            generation_id,
            work_id,
            parent,
            metadata_json,
        } => {
            let mut metadata: Value = serde_json::from_str(&metadata_json)?;
            if !metadata.is_object() {
                return Err("Goal generation metadata must be an object".into());
            }
            let work_id = if let Some(parent) = parent {
                let previous: Option<(String, String)> = tx.query_row(
                    "SELECT g.work_id,g.metadata FROM conversation_goal_generations g
                     JOIN works w ON w.work_id=g.work_id AND w.user_id=?4
                     WHERE g.task_id=?1 AND g.conversation_id=?2 AND g.generation_id=?3",
                    params![task_id, parent.conversation_id, parent.generation_task_id, user_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ).optional()?;
                previous.map(|(id, encoded)| -> Result<String> {
                    let parent_metadata: Value = serde_json::from_str(&encoded)?;
                    metadata["intentRevision"] = parent_metadata["intentRevision"].clone();
                    metadata["ownerEpoch"] = parent_metadata["ownerEpoch"].clone();
                    metadata["assistantMessageIds"] = json!([]);
                    metadata["parent"] = json!({ "conversationId": parent.conversation_id, "generationTaskId": parent.generation_task_id });
                    Ok(id)
                }).transpose()?
            } else {
                work_id
            };
            if let (Some(work_id), Some(intent), Some(epoch)) = (work_id, metadata["intentRevision"].as_i64(), metadata["ownerEpoch"].as_i64()) {
                let changes = tx.execute(
                    "INSERT INTO conversation_goal_generations
                     (task_id, conversation_id, generation_id, work_id, metadata)
                     SELECT ?1,?2,?3,w.work_id,?5 FROM works w
                     JOIN work_conversations c ON c.work_id=w.work_id AND c.conversation_id=?1
                     JOIN tasks t ON t.id=c.conversation_id
                     WHERE w.work_id=?4 AND w.user_id=?6 AND w.intent_revision=?7 AND w.owner_epoch=?8 AND w.lifecycle='active'
                     ON CONFLICT DO NOTHING",
                    params![task_id, conversation_id, generation_id, work_id, serde_json::to_string(&metadata)?, user_id, intent, epoch],
                )?;
                json!({ "ok": true, "admitted": changes > 0 })
            } else {
                json!({ "ok": true, "admitted": false })
            }
        }
        Request::GoalActivityRecordAuxiliaryScope {
            scope,
            task_id,
            conversation_id,
            generation_id,
        } => {
            tx.execute(
                "INSERT INTO conversation_goal_auxiliary_scopes(execution_scope,task_id,conversation_id,generation_id)
                 SELECT ?1,task_id,conversation_id,generation_id FROM conversation_goal_generations
                 WHERE task_id=?2 AND conversation_id=?3 AND generation_id=?4
                 ON CONFLICT DO NOTHING",
                params![scope, task_id, conversation_id, generation_id],
            )?;
            json!({ "ok": true })
        }
        Request::GoalActivitySettle {
            user_id,
            task_id,
            conversation_id,
            generation_id,
            outcome,
            message_id,
        } => {
            let row: Option<(String, String, i64, i64)> = tx
                .query_row(
                    "SELECT g.work_id,g.metadata,w.intent_revision,w.owner_epoch FROM conversation_goal_generations g
                     JOIN works w ON w.work_id=g.work_id AND w.user_id=?4
                     JOIN work_conversations c ON c.work_id=g.work_id AND c.conversation_id=g.task_id
                     WHERE g.task_id=?1 AND g.conversation_id=?2 AND g.generation_id=?3",
                    params![task_id, conversation_id, generation_id, user_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let mut owner = Value::Null;
            if let Some((goal_id, raw_meta, intent_revision, owner_epoch)) = row {
                let mut meta: Value = serde_json::from_str(&raw_meta)?;
                if meta["intentRevision"].as_i64() == Some(intent_revision)
                    && meta["ownerEpoch"].as_i64() == Some(owner_epoch)
                {
                    if let Some(msg_id) = message_id
                        && let Some(obj) = meta.as_object_mut()
                    {
                        let ids = obj.entry("assistantMessageIds").or_insert_with(|| json!([])).as_array_mut();
                        if let Some(list) = ids
                            && !list.iter().any(|item| item.as_str() == Some(&msg_id))
                        {
                            list.push(Value::String(msg_id));
                        }
                    }
                    let encoded = serde_json::to_string(&meta)?;
                    tx.execute(
                        "UPDATE conversation_goal_generations SET outcome=COALESCE(outcome,?1), metadata=?2
                         WHERE task_id=?3 AND conversation_id=?4 AND generation_id=?5",
                        params![outcome, encoded, task_id, conversation_id, generation_id],
                    )?;
                    owner = json!({ "goalId": goal_id, "intentRevision": intent_revision, "ownerEpoch": owner_epoch });
                }
            }
            json!({ "owner": owner })
        }
        Request::GoalActivityRecordTool {
            task_id,
            parent_conversation_id,
            parent_generation_id,
            tool_call_id,
            results,
        } => {
            let goal_id: Option<String> = tx
                .query_row(
                    "SELECT work_id FROM conversation_goal_generations WHERE task_id=?1 AND conversation_id=?2 AND generation_id=?3",
                    params![task_id, parent_conversation_id, parent_generation_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(goal_id) = goal_id {
                let mut select = tx.prepare(
                    "SELECT generation_id, metadata FROM conversation_goal_generations
                     WHERE task_id=?1 AND conversation_id=?2 AND work_id=?3
                     AND json_extract_string(metadata,'$.child.id')=?4
                     AND json_extract_string(metadata,'$.parent.conversationId')=?5
                     AND json_extract_string(metadata,'$.parent.generationTaskId')=?6",
                )?;
                let mut update = tx.prepare(
                    "UPDATE conversation_goal_generations SET metadata=?1
                     WHERE task_id=?2 AND conversation_id=?3 AND generation_id=?4",
                )?;
                for item in results {
                    let returned = json!({
                        "status": item.status,
                        "outcome": item.outcome,
                        "toolCallId": tool_call_id,
                    });
                    let conv_id = item.native_conversation_id.to_string();
                    let matches: Vec<(i64, String)> = select
                        .query_map(
                            params![
                                task_id,
                                conv_id,
                                goal_id,
                                item.subagent_id,
                                parent_conversation_id,
                                parent_generation_id
                            ],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )?
                        .collect::<duckdb::Result<_>>()?;
                    for (gen_id, meta_raw) in matches {
                        let patched = crate::database::patch_json_fields(
                            &meta_raw,
                            &[("returned", returned.clone())],
                        );
                        update.execute(params![patched, task_id, conv_id, gen_id])?;
                    }
                }
            }
            json!({ "ok": true })
        }
        Request::GoalActivityRecordSkill {
            task_id,
            conversation_id,
            generation_id,
            key,
            evidence_json,
        } => {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM conversation_goal_generations WHERE task_id=?1 AND conversation_id=?2 AND generation_id=?3",
                    params![task_id, conversation_id, generation_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                tx.execute(
                    "INSERT INTO conversation_goal_learned_skills VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
                    params![task_id, conversation_id, generation_id, key, evidence_json],
                )?;
            }
            json!({ "ok": true })
        }
        Request::GoalActivityRecordAuthoredSkillRead {
            path_key,
            fingerprint,
            at,
        } => {
            let matching: Vec<(String, String, i64, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT task_id, conversation_id, generation_id, skill_key, evidence_json
                     FROM conversation_goal_learned_skills
                     WHERE json_extract_string(evidence_json,'$.pathKey')=?1
                       AND json_extract_string(evidence_json,'$.installedFingerprint')=?2
                       AND TRY_CAST(json_extract(evidence_json,'$.createdAt') AS BIGINT)<=?3
                       AND json_extract(evidence_json,'$.laterInvokedAt') IS NULL",
                )?;
                stmt.query_map(params![path_key, fingerprint, at], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<duckdb::Result<_>>()?
            };
            let mut upd = tx.prepare(
                "UPDATE conversation_goal_learned_skills SET evidence_json=?1
                 WHERE task_id=?2 AND conversation_id=?3 AND generation_id=?4 AND skill_key=?5",
            )?;
            for (tid, cid, gid, key, raw) in matching {
                let patched =
                    crate::database::patch_json_fields(&raw, &[("laterInvokedAt", json!(at))]);
                upd.execute(params![patched, tid, cid, gid, key])?;
            }
            json!({ "ok": true })
        }
        Request::GoalSavedArtifactConfirm {
            work_id,
            task_id,
            user_id,
            artifact_id,
            expected_intent_revision,
            source,
        } => goal_saved_artifact_verification::confirm(
            &tx, &work_id, &task_id, &user_id, &artifact_id, expected_intent_revision, &source,
        )?,
    };
    crate::request_control::commit(tx)?;
    Ok(out)
}
