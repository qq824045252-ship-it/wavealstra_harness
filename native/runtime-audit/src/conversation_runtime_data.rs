use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    TaskAccess { task_id: String },
    Snapshot { task_id: String, user_id: String },
    GoalActivityGeneration { task_id: String, user_id: String, conversation_id: String, generation_task_id: i64 },
    GoalActivityOwner { task_id: String, user_id: String, conversation_id: String, message_id: String },
    AuthoredGoalSkillAtPath { path_key: String },
}

pub fn read(db: &mut Connection, query: Query) -> Result<Value> {
    match query {
        Query::TaskAccess { task_id } => {
            let (exists, has_work_binding): (bool, bool) = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1),
                        EXISTS(SELECT 1 FROM work_execution_bindings WHERE task_id=?1)",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            Ok(json!({ "taskExists": exists, "hasWorkBinding": has_work_binding }))
        }
        Query::Snapshot { task_id, user_id } => snapshot(db, &task_id, &user_id),
        Query::GoalActivityGeneration { task_id, user_id, conversation_id, generation_task_id } => {
            let row: Option<(String, String, Option<String>)> = db.query_row(
                "SELECT g.work_id,g.metadata,g.outcome FROM conversation_goal_generations g
                 JOIN works w ON w.work_id=g.work_id AND w.user_id=?4
                 JOIN work_conversations c ON c.work_id=g.work_id AND c.conversation_id=g.task_id
                 WHERE g.task_id=?1 AND g.conversation_id=?2 AND g.generation_id=?3",
                params![task_id, conversation_id, generation_task_id, user_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional()?;
            row.map(|(work_id, encoded, outcome)| {
                let mut metadata: Value = serde_json::from_str(&encoded)?;
                metadata["taskId"] = task_id.into();
                metadata["conversationId"] = conversation_id.into();
                metadata["generationTaskId"] = generation_task_id.into();
                metadata["goalId"] = work_id.into();
                if let Some(outcome) = outcome { metadata["status"] = outcome.into(); }
                Ok(metadata)
            }).unwrap_or(Ok(Value::Null))
        }
        Query::GoalActivityOwner { task_id, user_id, conversation_id, message_id } => {
            let row: Option<(String, String)> = db.query_row(
                "SELECT g.work_id,g.metadata FROM conversation_goal_generations g
                 JOIN works w ON w.work_id=g.work_id AND w.user_id=?4
                 JOIN work_conversations c ON c.work_id=g.work_id AND c.conversation_id=g.task_id
                 WHERE g.task_id=?1 AND g.conversation_id=?2
                   AND EXISTS(SELECT 1 FROM json_each(g.metadata,'$.assistantMessageIds') j WHERE json_extract_string(j.value,'$')=?3)
                 ORDER BY g.generation_id DESC LIMIT 1",
                params![task_id, conversation_id, message_id, user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            row.map(|(work_id, encoded)| {
                let metadata: Value = serde_json::from_str(&encoded)?;
                Ok(json!({"goalId": work_id, "intentRevision": metadata["intentRevision"], "ownerEpoch": metadata["ownerEpoch"]}))
            }).unwrap_or(Ok(Value::Null))
        }
        Query::AuthoredGoalSkillAtPath { path_key } => {
            let found: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM conversation_goal_learned_skills WHERE json_extract_string(evidence_json,'$.pathKey')=?)",
                [path_key], |row| row.get(0),
            )?;
            Ok(found.into())
        }
    }
}

fn snapshot(db: &mut Connection, task_id: &str, user_id: &str) -> Result<Value> {
    let tx = db.transaction()?;
    let task_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?)",
        [task_id],
        |row| row.get(0),
    )?;
    if !task_exists {
        return Ok(Value::Null);
    }
    let interactions = records(&tx,
        "SELECT id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
                max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at
         FROM conversation_interactions WHERE task_id=? ORDER BY created_at,rowid", [task_id])?;
    let goals = goal_rows(&tx, task_id, user_id, None)?;
    Ok(json!({ "interactions": interactions, "goals": goals }))
}

pub(crate) fn goal_rows(
    db: &Connection,
    task_id: &str,
    user_id: &str,
    work_id: Option<&str>,
) -> Result<Vec<Value>> {
    records(db,
        "WITH linked AS (
            SELECT work_id FROM work_conversations WHERE conversation_id=?1
         ), bound AS (
            SELECT work_id FROM work_execution_bindings WHERE task_id=?1
            ORDER BY admitted_at DESC,rowid DESC LIMIT 1
         ), candidates AS (
            SELECT work_id FROM linked UNION SELECT work_id FROM bound
         )
         SELECT w.work_id,w.title,w.goal_description,w.criteria_json,w.lifecycle,w.closure_conclusion,w.closure_summary,
                w.progress_summary,w.state_version,w.intent_revision,w.owner_epoch,w.created_by,w.created_at,w.updated_at,w.closed_at,w.source_message_id,
                s.source_json,
                EXISTS(SELECT 1 FROM linked WHERE linked.work_id=w.work_id) AS linked,
                (w.lifecycle<>'closed' AND (NOT EXISTS(SELECT 1 FROM bound)
                    OR EXISTS(SELECT 1 FROM bound WHERE bound.work_id=w.work_id))) AS live,
                CASE WHEN w.lifecycle='active' THEN (SELECT b.reason FROM work_blockers b
                    WHERE b.work_id=w.work_id AND b.status='open' ORDER BY b.created_at,b.blocker_id LIMIT 1) END AS blocker,
                c.task_id AS continuation_task_id,c.state AS continuation_state,c.attempts,c.tokens_used,c.tokens_budget,
                c.attempt_serial AS continuation_attempt_serial,c.updated_at AS continuation_updated_at,
                c.intent_revision AS continuation_intent_revision,
                c.progress_stalls,c.defer_reason,c.deferred_at,c.last_continuation_at,
                lc.trigger AS check_trigger,lc.reason AS check_reason,lc.\"at\" AS check_at,
                lw.trigger AS wake_trigger,lw.\"at\" AS wake_at
         FROM candidates JOIN works w ON w.work_id=candidates.work_id AND w.user_id=?2
         LEFT JOIN conversation_goal_sources s ON s.work_id=w.work_id
         LEFT JOIN conversation_goal_continuations c ON c.work_id=w.work_id
         LEFT JOIN conversation_goal_last_check lc ON lc.work_id=c.work_id AND lc.task_id=c.task_id AND lc.intent_revision=c.intent_revision
         LEFT JOIN conversation_goal_last_wake lw ON lw.work_id=c.work_id AND lw.task_id=c.task_id AND lw.intent_revision=c.intent_revision
         WHERE (?3 IS NULL OR w.work_id=?3)
         ORDER BY w.created_at DESC,w.work_id", params![task_id,user_id,work_id])
}
