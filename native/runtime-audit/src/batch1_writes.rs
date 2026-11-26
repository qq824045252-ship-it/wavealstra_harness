//! Rust-owned Batch 1 transactional writes (`Step 4 Stage 4.1`, `RC-09`/`RC-10`):
//! runtime epochs, Python project bindings, Pi Azure selection migration, execution
//! attempts, conversation interactions, loadout observations, goal activity & saved
//! artifact verification.

use crate::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    ClaimSnapshotEpoch,
    ClaimDiagnosticEpoch,
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
        status: String,
        answer_json: Option<String>,
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
        task_id: String,
        conversation_id: String,
        generation_id: i64,
        work_id: String,
        metadata_json: String,
    },
    GoalActivityRecordAuxiliaryScope {
        scope: String,
        task_id: String,
        conversation_id: String,
        generation_id: i64,
    },
    GoalActivitySettle {
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
        artifact_id: String,
        verified_at: i64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalToolReturn {
    native_conversation_id: i64,
    subagent_id: String,
    status: String,
    outcome: Option<String>,
}

fn interaction_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let out = match request {
        Request::ClaimSnapshotEpoch => {
            tx.execute(
                "INSERT OR IGNORE INTO runtime_snapshot_writer VALUES (1, 0, '', 0)",
                [],
            )?;
            let epoch: i64 = tx.query_row(
                "UPDATE runtime_snapshot_writer SET epoch=epoch+1, write_id='', result=0 WHERE id=1 RETURNING epoch",
                [],
                |row| row.get(0),
            )?;
            json!({ "epoch": epoch })
        }
        Request::ClaimDiagnosticEpoch => {
            tx.execute(
                "INSERT OR IGNORE INTO runtime_diagnostic_writer VALUES (1, 0, 0)",
                [],
            )?;
            let epoch: i64 = tx.query_row(
                "UPDATE runtime_diagnostic_writer SET epoch=epoch+1, sequence=0 WHERE id=1 RETURNING epoch",
                [],
                |row| row.get(0),
            )?;
            json!({ "epoch": epoch })
        }
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
        } => {
            tx.execute(
                "INSERT INTO execution_attempts
                 (id,task_id,execution_id,assistant_message_id,tool_call_id,target,status,record_json,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    id,
                    task_id,
                    execution_id,
                    assistant_message_id,
                    tool_call_id,
                    target,
                    status,
                    record_json,
                    created_at
                ],
            )?;
            json!({ "ok": true })
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
                    "SELECT status, record_json FROM execution_attempts WHERE id=?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((prior_status, _prior_json)) = current else {
                return Err("Durable execution attempt is missing".into());
            };
            if prior_status == "running" {
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
            } else if prior_status == "inconclusive" && allow_inconclusive_settle {
                tx.execute(
                    "UPDATE execution_attempts SET status=?1,record_json=?2,finished_at=?3 WHERE id=?4 AND status='inconclusive'",
                    params![status, record_json, finished_at, id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::ExecutionAttemptRecoverInterrupted { at } => {
            let mut stmt = tx.prepare("SELECT record_json FROM execution_attempts WHERE status='running'")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
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
            tx.execute(
                "INSERT INTO conversation_interactions
                 (id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
                  max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
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
            status,
            answer_json,
            resolved_at,
        } => {
            let changes = tx.execute(
                "UPDATE conversation_interactions
                 SET status=?1, answer_json=?2, version=version+1, resolved_at=?3
                 WHERE id=?4 AND status='pending'",
                params![status, answer_json, resolved_at, id],
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
            json!({ "row": row })
        }
        Request::InteractionExpireAllPending { resolved_at } => {
            let mut stmt = tx.prepare("SELECT id FROM conversation_interactions WHERE status='pending'")?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
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
        } => {
            tx.execute(
                "INSERT INTO agent_loadout_observations (
                   id,task_id,user_message_id,assistant_message_id,query_hash,context_json,
                   recommended_json,actual_json,matched_actual_json,not_selected_json,blocked_json,used_skill_ids_json,
                   outcome,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'[]','pending',?12,?12)
                 ON CONFLICT(task_id, assistant_message_id) DO UPDATE SET
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
                   updated_at=excluded.updated_at",
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
            task_id,
            conversation_id,
            generation_id,
            work_id,
            metadata_json,
        } => {
            let linked: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM work_conversations WHERE work_id=?1 AND conversation_id=?2",
                    params![work_id, task_id],
                    |r| r.get(0),
                )
                .optional()?;
            if linked.is_some() {
                tx.execute(
                    "INSERT OR IGNORE INTO conversation_goal_generations
                     (task_id, conversation_id, generation_id, work_id, metadata) VALUES (?1,?2,?3,?4,?5)",
                    params![task_id, conversation_id, generation_id, work_id, metadata_json],
                )?;
            }
            json!({ "ok": true })
        }
        Request::GoalActivityRecordAuxiliaryScope {
            scope,
            task_id,
            conversation_id,
            generation_id,
        } => {
            tx.execute(
                "INSERT OR IGNORE INTO conversation_goal_auxiliary_scopes(execution_scope,task_id,conversation_id,generation_id)
                 SELECT ?1,task_id,conversation_id,generation_id FROM conversation_goal_generations
                 WHERE task_id=?2 AND conversation_id=?3 AND generation_id=?4",
                params![scope, task_id, conversation_id, generation_id],
            )?;
            json!({ "ok": true })
        }
        Request::GoalActivitySettle {
            task_id,
            conversation_id,
            generation_id,
            outcome,
            message_id,
        } => {
            let row: Option<(String, String)> = tx
                .query_row(
                    "SELECT work_id, metadata FROM conversation_goal_generations WHERE task_id=?1 AND conversation_id=?2 AND generation_id=?3",
                    params![task_id, conversation_id, generation_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let mut owner = Value::Null;
            if let Some((goal_id, raw_meta)) = row {
                let mut meta: Value = serde_json::from_str(&raw_meta)?;
                if let Some(msg_id) = message_id
                    && let Some(obj) = meta.as_object_mut()
                {
                    let ids = obj
                        .entry("assistantMessageIds")
                        .or_insert_with(|| json!([]))
                        .as_array_mut();
                    if let Some(list) = ids
                        && !list.iter().any(|item| item.as_str() == Some(&msg_id))
                    {
                        list.push(Value::String(msg_id));
                    }
                }
                let intent_revision = meta["intentRevision"].as_i64().unwrap_or(0);
                let encoded = serde_json::to_string(&meta)?;
                tx.execute(
                    "UPDATE conversation_goal_generations SET outcome=COALESCE(outcome,?1), metadata=?2
                     WHERE task_id=?3 AND conversation_id=?4 AND generation_id=?5",
                    params![outcome, encoded, task_id, conversation_id, generation_id],
                )?;
                owner = json!({ "goalId": goal_id, "intentRevision": intent_revision });
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
                let mut stmt = tx.prepare(
                    "UPDATE conversation_goal_generations SET metadata=json_set(metadata,'$.returned',json(?1))
                     WHERE task_id=?2 AND conversation_id=?3 AND work_id=?4
                     AND json_extract(metadata,'$.child.id')=?5
                     AND json_extract(metadata,'$.parent.conversationId')=?6
                     AND json_extract(metadata,'$.parent.generationTaskId')=?7",
                )?;
                for item in results {
                    let returned = json!({
                        "status": item.status,
                        "outcome": item.outcome,
                        "toolCallId": tool_call_id,
                    });
                    stmt.execute(params![
                        serde_json::to_string(&returned)?,
                        task_id,
                        item.native_conversation_id.to_string(),
                        goal_id,
                        item.subagent_id,
                        parent_conversation_id,
                        parent_generation_id
                    ])?;
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
                    "INSERT OR IGNORE INTO conversation_goal_learned_skills VALUES (?1,?2,?3,?4,?5)",
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
            tx.execute(
                "UPDATE conversation_goal_learned_skills SET evidence_json=json_set(evidence_json,'$.laterInvokedAt',?1)
                 WHERE json_extract(evidence_json,'$.pathKey')=?2 AND json_extract(evidence_json,'$.installedFingerprint')=?3
                 AND json_extract(evidence_json,'$.createdAt')<=?1 AND json_extract(evidence_json,'$.laterInvokedAt') IS NULL",
                params![at, path_key, fingerprint],
            )?;
            json!({ "ok": true })
        }
        Request::GoalSavedArtifactConfirm {
            work_id,
            artifact_id,
            verified_at,
        } => {
            tx.execute(
                "INSERT OR IGNORE INTO conversation_goal_saved_artifact_verification VALUES (?1,?2,?3)",
                params![work_id, artifact_id, verified_at],
            )?;
            let stored: i64 = tx.query_row(
                "SELECT verified_at FROM conversation_goal_saved_artifact_verification WHERE work_id=?1 AND artifact_id=?2",
                params![work_id, artifact_id],
                |r| r.get(0),
            )?;
            json!({ "verifiedAt": stored })
        }
    };
    tx.commit()?;
    Ok(out)
}
