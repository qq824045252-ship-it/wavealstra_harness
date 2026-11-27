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
    GoalEvidence { task_id: String, user_id: String, goal_id: String },
    GoalActivityGenerations { task_id: String, user_id: String, goal_id: String, intent_revision: i64 },
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
        Query::GoalEvidence { task_id, user_id, goal_id } => goal_evidence(db, &task_id, &user_id, &goal_id),
        Query::GoalActivityGenerations { task_id, user_id, goal_id, intent_revision } => {
            let tx = db.transaction()?;
            let Some(goal) = scoped_goal(&tx, &task_id, &user_id, &goal_id)? else {
                return Ok(Value::Null);
            };
            Ok(json!(records(&tx,
                "SELECT conversation_id AS \"conversationId\",generation_id AS \"generationTaskId\"
                 FROM conversation_goal_generations WHERE work_id=?1 AND task_id=?2
                 AND try_cast(json_extract(metadata,'$.intentRevision') AS BIGINT)=?3 ORDER BY rowid",
                params![goal.id, task_id, intent_revision])?))
        }
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

struct ScopedGoal {
    id: String,
    owner_bot_id: String,
    intent_revision: i64,
    owner_epoch: i64,
    state_version: i64,
    input_snapshot_id: String,
    criteria_json: String,
}

fn scoped_goal(db: &Connection, task_id: &str, user_id: &str, goal_id: &str) -> Result<Option<ScopedGoal>> {
    Ok(db.query_row(
        "SELECT w.work_id,w.owner_bot_id,w.intent_revision,w.owner_epoch,w.state_version,w.input_snapshot_id,w.criteria_json
         FROM works w JOIN work_conversations c ON c.work_id=w.work_id AND c.conversation_id=?1
         JOIN tasks t ON t.id=c.conversation_id
         WHERE w.user_id=?2 AND w.work_id=?3 AND NOT EXISTS (
             SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed'
         )", params![task_id, user_id, goal_id], |row| Ok(ScopedGoal {
            id: row.get(0)?, owner_bot_id: row.get(1)?, intent_revision: row.get(2)?,
            owner_epoch: row.get(3)?, state_version: row.get(4)?, input_snapshot_id: row.get(5)?, criteria_json: row.get(6)?,
        }),
    ).optional()?)
}

// A Work can link several conversations. Only expose tasks in the requester's current workspace.
// For tasks without a space ID, an exact, explicitly recorded working directory is required.
pub(crate) const SCOPED_TASKS: &str = "WITH scoped_tasks AS (
    SELECT t.id FROM tasks requester JOIN tasks t ON (
        t.id=requester.id OR t.space_id=requester.space_id OR (
            t.space_id IS NULL AND requester.space_id IS NULL AND requester.cwd<>'' AND t.cwd=requester.cwd
        )
    ) WHERE requester.id=?1 AND NOT EXISTS (
        SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed'
    )
)";

const CURRENT_EXECUTIONS: &str = ", current_executions AS (
    SELECT b.* FROM work_execution_bindings b JOIN scoped_tasks t ON t.id=b.task_id
    JOIN works w ON w.work_id=b.work_id AND w.intent_revision=b.intent_revision
      AND w.owner_epoch=b.owner_epoch AND w.input_snapshot_id=b.input_snapshot_id
    WHERE b.work_id=?2 AND b.invalidated_at IS NULL AND b.status<>'invalidated'
), current_deliverables AS (
    SELECT d.* FROM work_deliverables d JOIN current_executions e ON e.binding_id=d.execution_id
      AND e.work_id=d.work_id AND e.intent_revision=d.intent_revision AND e.owner_epoch=d.owner_epoch
      AND e.input_snapshot_id=d.input_snapshot_id
)";

const OWNED_GENERATIONS: &str = ", owned_generations AS (
    SELECT g.task_id,g.conversation_id,g.generation_id,g.metadata,g.outcome,g.rowid AS sequence
    FROM conversation_goal_generations g JOIN scoped_tasks t ON t.id=g.task_id
    JOIN work_conversations c ON c.work_id=g.work_id AND c.conversation_id=g.task_id
    WHERE g.work_id=?2
), owned_auxiliary AS (
    SELECT a.* FROM conversation_goal_auxiliary_scopes a JOIN owned_generations g USING (task_id,conversation_id,generation_id)
)";

fn goal_evidence(db: &mut Connection, task_id: &str, user_id: &str, goal_id: &str) -> Result<Value> {
    let tx = db.transaction()?;
    let Some(goal) = scoped_goal(&tx, task_id, user_id, goal_id)? else {
        return Ok(Value::Null);
    };
    let evidence = work_evidence(&tx, task_id, user_id, &goal)?;
    let activity = |sql: &str| records(&tx, &format!("{SCOPED_TASKS}{OWNED_GENERATIONS} {sql}"), params![task_id, goal.id]);
    let generations = activity(
        "SELECT task_id AS \"taskId\",conversation_id AS \"conversationId\",generation_id AS \"generationTaskId\",metadata,outcome
         FROM owned_generations ORDER BY sequence",
    )?.into_iter().map(|row| generation_activity(goal_id, &row)).collect::<Result<Vec<_>>>()?;
    let learned_skills = activity(
        "SELECT s.evidence_json FROM conversation_goal_learned_skills s
         JOIN owned_generations g USING (task_id,conversation_id,generation_id) ORDER BY g.sequence,s.rowid",
    )?.into_iter().map(|row| {
        let mut entry = json_field(&row, "evidence_json")?;
        if let Some(object) = entry.as_object_mut() { object.remove("pathKey"); }
        Ok(entry)
    }).collect::<Result<Vec<_>>>()?;
    let auxiliary_scopes = activity(
        "SELECT task_id AS \"taskId\",execution_scope AS \"executionScope\",conversation_id AS \"conversationId\",
                generation_id AS \"generationTaskId\" FROM owned_auxiliary ORDER BY task_id,generation_id,execution_scope",
    )?;
    let diagnostic_requests = activity(
        "SELECT d.record_json FROM task_request_diagnostics d WHERE json_valid(d.record_json)
           AND json_extract_string(d.record_json,'$.taskId')=d.task_id AND (
             (json_extract_string(d.record_json,'$.sourceKind')='auxiliary' AND EXISTS (
                 SELECT 1 FROM owned_auxiliary a WHERE a.task_id=d.task_id
                   AND a.execution_scope=json_extract_string(d.record_json,'$.executionScope')
             )) OR (
                 json_extract_string(d.record_json,'$.sourceKind') IN ('main','subagent')
                 AND json_extract_string(d.record_json,'$.executionScope')=d.task_id AND EXISTS (
                     SELECT 1 FROM owned_generations g WHERE g.task_id=d.task_id
                       AND g.conversation_id=json_extract_string(d.record_json,'$.conversationId')
                       AND g.generation_id=try_cast(json_extract(d.record_json,'$.generationTaskId') AS BIGINT)
                 )
             )
           ) ORDER BY d.started_at,d.request_id",
    )?.iter().map(|row| json_field(row, "record_json")).collect::<Result<Vec<_>>>()?;
    let unattributed_auxiliary = activity(
        "SELECT count(*) AS count FROM task_request_diagnostics d WHERE json_valid(d.record_json)
           AND json_extract_string(d.record_json,'$.taskId')=d.task_id
           AND json_extract_string(d.record_json,'$.sourceKind')='auxiliary'
           AND EXISTS (SELECT 1 FROM owned_generations g WHERE g.task_id=d.task_id)
           AND NOT EXISTS (SELECT 1 FROM conversation_goal_auxiliary_scopes a WHERE a.task_id=d.task_id
               AND a.execution_scope=json_extract_string(d.record_json,'$.executionScope'))",
    )?;
    let saved_artifact_verifications = records(&tx,
        "SELECT artifact_id AS \"artifactId\",verified_at AS \"verifiedAt\"
         FROM conversation_goal_saved_artifact_verification WHERE work_id=?1 ORDER BY artifact_id", [goal_id])?;
    let invoked_skills = activity(
        "SELECT s.task_id AS \"taskId\",s.assistant_message_id AS \"assistantMessageId\",s.skill_id AS \"skillId\",
                s.candidate_id AS \"candidateId\",s.source_memory_ids_json AS \"sourceMemoryIds\",s.invoked_at AS \"invokedAt\",
                s.invocation_kind AS \"invocationKind\", (SELECT max(later.invoked_at) FROM memory_skill_effectiveness later
                    JOIN scoped_tasks t ON t.id=later.task_id WHERE later.skill_id=s.skill_id
                      AND later.candidate_id=s.candidate_id AND later.invoked_at>s.invoked_at) AS \"laterInvokedAt\"
         FROM memory_skill_effectiveness s WHERE s.invoked_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM owned_generations g, json_each(g.metadata,'$.assistantMessageIds') message
             WHERE g.task_id=s.task_id AND json_extract_string(message.value,'$')=s.assistant_message_id
         ) ORDER BY s.invoked_at,s.id",
    )?.into_iter().map(|row| decode_fields(row, &["sourceMemoryIds"])).collect::<Result<Vec<_>>>()?;
    Ok(json!({
        "evidence": evidence, "ownerEpoch": goal.owner_epoch, "stateVersion": goal.state_version,
        "generations": generations, "learnedSkills": learned_skills, "invokedSkills": invoked_skills,
        "auxiliaryScopes": auxiliary_scopes, "diagnosticRequests": diagnostic_requests,
        "unattributedAuxiliaryRequests": unattributed_auxiliary[0]["count"],
        "savedArtifactVerifications": saved_artifact_verifications,
    }))
}

fn generation_activity(goal_id: &str, row: &Value) -> Result<Value> {
    let metadata = json_field(row, "metadata")?;
    let mut generation = json!({
        "taskId": row["taskId"], "conversationId": row["conversationId"], "generationTaskId": row["generationTaskId"],
        "goalId": goal_id, "assistantMessageIds": metadata["assistantMessageIds"].as_array().cloned().unwrap_or_default(),
    });
    for field in ["intentRevision", "ownerEpoch", "parent", "child", "returned"] {
        if let Some(value) = metadata.get(field).filter(|value| !value.is_null()) { generation[field] = value.clone(); }
    }
    if !row["outcome"].is_null() { generation["status"] = row["outcome"].clone(); }
    Ok(generation)
}

fn work_evidence(db: &Connection, task_id: &str, user_id: &str, goal: &ScopedGoal) -> Result<Value> {
    let work = |sql: &str| records(db, &format!("{SCOPED_TASKS}{CURRENT_EXECUTIONS} {sql}"), params![task_id, goal.id]);
    let executions = work(
        "SELECT e.binding_id AS \"bindingId\",e.bot_id AS \"botId\",e.task_id AS \"taskId\",
                e.conversation_id AS \"conversationId\",e.status,m.value_json AS metrics
         FROM current_executions e LEFT JOIN work_execution_metrics m USING (binding_id,task_id,conversation_id)
         ORDER BY e.admitted_at,e.binding_id",
    )?.into_iter().map(|row| decode_fields(row, &["metrics"])).collect::<Result<Vec<_>>>()?;
    let deliverables = work(
        "SELECT d.deliverable_id AS \"deliverableId\",d.execution_id AS \"executionId\",d.summary,d.status,
                d.artifact_refs_json AS \"artifactRefs\" FROM current_deliverables d
         ORDER BY d.created_at,d.deliverable_id",
    )?.into_iter().map(|row| decode_fields(row, &["artifactRefs"])).collect::<Result<Vec<_>>>()?;
    let proof = work(
        "SELECT p.evidence_id AS \"evidenceId\",p.work_id AS \"workId\",p.deliverable_id AS \"deliverableId\",
                p.execution_id AS \"executionId\",p.criterion_ids_json AS \"criterionIds\",p.kind,p.provenance,
                p.source_ref AS \"sourceRef\",p.source_sha AS \"sourceSha\",p.input_snapshot_id AS \"inputSnapshotId\",
                p.environment,p.intent_revision AS \"intentRevision\",p.detail,p.recorded_at AS \"recordedAt\"
         FROM work_evidence p JOIN works w ON w.work_id=p.work_id AND w.intent_revision=p.intent_revision
            AND w.input_snapshot_id=p.input_snapshot_id
         WHERE p.work_id=?2 AND p.provenance<>'execution' AND (p.execution_id IS NULL OR EXISTS (
             SELECT 1 FROM current_executions e WHERE e.binding_id=p.execution_id
         )) AND (p.deliverable_id IS NULL OR EXISTS (
             SELECT 1 FROM current_deliverables d WHERE d.deliverable_id=p.deliverable_id
         )) ORDER BY p.recorded_at,p.evidence_id",
    )?.into_iter().map(|row| decode_fields(row, &["criterionIds"])).collect::<Result<Vec<_>>>()?;
    let criteria: Vec<Value> = serde_json::from_str(&goal.criteria_json)?;
    let verification: Vec<Value> = criteria.into_iter().filter_map(|criterion| {
        let id = criterion["id"].as_str()?;
        let required = criterion["requiredIntentRevision"].as_i64()?;
        if criterion["status"] != "satisfied" || criterion["verifiedIntentRevision"].as_i64() != Some(required) {
            return None;
        }
        let references = criterion["evidenceRefs"].as_array()?;
        let evidence: Vec<_> = proof.iter().filter(|item| references.contains(&item["evidenceId"])
            && item["criterionIds"].as_array().is_some_and(|ids| ids.contains(&criterion["id"]))).collect();
        (!evidence.is_empty()).then(|| json!({"criterionId": id, "evidence": evidence}))
    }).collect();
    let artifacts = work(
        "SELECT d.binding_id AS \"bindingId\",d.path,
               CASE WHEN regexp_full_match(json_extract_string(d.fingerprint_json,'$.digest'),'[a-f0-9]{64}')
                    THEN json_extract_string(d.fingerprint_json,'$.digest') END AS sha256
         FROM work_artifact_dependencies d JOIN current_executions e ON e.binding_id=d.binding_id AND e.work_id=d.work_id
         WHERE d.invalidated_at IS NULL ORDER BY e.admitted_at,d.rowid",
    )?.into_iter().map(|row| decode_fields(row, &[])).collect::<Result<Vec<_>>>()?;
    let schedules = records(db,
        "SELECT subscription_id AS \"subscriptionId\",source,next_wake_at AS \"nextWakeAt\",last_checked_at AS \"lastCheckedAt\",
                stopped_at AS \"stoppedAt\",stopped_reason AS \"stoppedReason\" FROM work_subscriptions
         WHERE work_id=?1 ORDER BY created_at,subscription_id", [&goal.id],
    )?.into_iter().map(|row| decode_fields(row, &[])).collect::<Result<Vec<_>>>()?;
    let mut result = json!({
        "ownerBotId": goal.owner_bot_id, "userId": user_id, "intentRevision": goal.intent_revision,
        "executions": executions, "deliverables": deliverables, "verification": verification,
        "artifacts": artifacts, "schedules": schedules,
    });
    if goal.input_snapshot_id != "snapshot:unbound" { result["inputSnapshotId"] = goal.input_snapshot_id.as_str().into(); }
    Ok(result)
}

fn json_field(row: &Value, field: &str) -> Result<Value> {
    Ok(serde_json::from_str(row[field].as_str().ok_or_else(|| format!("Missing stored JSON field {field}"))?)?)
}

fn decode_fields(mut row: Value, fields: &[&str]) -> Result<Value> {
    for &field in fields {
        if !row[field].is_null() { row[field] = json_field(&row, field)?; }
    }
    if let Some(object) = row.as_object_mut() { object.retain(|_, value| !value.is_null()); }
    Ok(row)
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
