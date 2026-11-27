use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const CURRENT_SCOPE: &str = "t.archived=0 AND t.space_id IS NOT DISTINCT FROM d.space_id
    AND s.path IS NOT DISTINCT FROM d.space_path
    AND (t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))
    AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
    AND NOT EXISTS (WITH RECURSIVE parents(id,parent_id,archived) AS (
        SELECT id,parent_id,archived FROM spaces WHERE id=t.space_id
        UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id
    ) SELECT 1 FROM parents WHERE archived<>0)";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
    Plan { operation_id: String },
    Latest { task_id: String },
    State { task_id: String, operation_id: String, child_operation_id: Option<String> },
    Retained { task_id: String, operation_id: String, source: String, allow_failed: bool },
    Prerequisite { task_id: String, operation_id: String, prerequisite_id: String },
    DependencyChain { task_id: String, operation_id: String },
    Question { task_id: String, interaction_id: String },
    Conclusion { task_id: String, operation_id: String },
    GoalContinuations { before_seq: Option<i64> },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    PutPlan { task_id: String, operation_id: String, plan: Value },
    AnchorAssignment { task_id: String, operation_id: String, expected_plan: Value, plan: Value },
    CaptureCommitBase { task_id: String, operation_id: String, commit_base: String, commit_start: Value },
    AdoptGoal { task_id: String, operation_id: String, prior_operation_id: String, now: i64, plan: Value },
}

impl Command {
    pub fn task_id(&self) -> &str {
        match self {
            Self::PutPlan { task_id, .. } | Self::AnchorAssignment { task_id, .. }
            | Self::CaptureCommitBase { task_id, .. } | Self::AdoptGoal { task_id, .. } => task_id,
        }
    }

    pub fn links_delegation(&self) -> bool { matches!(self, Self::AdoptGoal { .. }) }

    pub fn checks_dots_schedule(&self) -> bool {
        match self {
            Self::PutPlan { plan, .. } | Self::AnchorAssignment { plan, .. } | Self::AdoptGoal { plan, .. } =>
                plan["source"].as_str().and_then(crate::cron_scheduler::dots_run_id).is_some(),
            Self::CaptureCommitBase { .. } => false,
        }
    }
}

fn stored_plan(db: &Connection, operation: &str) -> Result<Option<Value>> {
    let raw = db.query_row("SELECT plan FROM dots_followup_plans WHERE operation_id=?", [operation],
        |row| row.get::<_, String>(0)).optional()?;
    Ok(raw.map(|raw| serde_json::from_str(&raw)).transpose()?)
}

fn state(db: &Connection, task: &str, operation: &str, child: Option<&str>) -> Result<Value> {
    let row = db.query_row(&format!("SELECT d.status, ({CURRENT_SCOPE}) AS same_scope,
        EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq
            AND newer.operation_id IS DISTINCT FROM ?3) AS replaced
        FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        WHERE d.operation_id=?2 AND d.task_id=?1"), params![task, operation, child],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?))).optional()?;
    let (exists, held) = db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1),
        EXISTS(SELECT 1 FROM dots_target_controls WHERE task_id=?1)", [task], |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?)))?;
    let current = row.as_ref().is_some_and(|(status, scope, replaced)| status != "superseded" && *scope && !replaced);
    Ok(json!({"current":current && !held,"held":held,"exists":exists,"replaced":row.as_ref().is_some_and(|row| row.2),
        "status":row.map(|row| row.0)}))
}

fn latest(db: &Connection, task: &str) -> Result<Value> {
    let row = db.query_row("SELECT d.operation_id,d.source_message_id,d.goal_id,p.plan FROM dots_delegations d
        LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id WHERE d.task_id=? ORDER BY d.seq DESC LIMIT 1", [task],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))).optional()?;
    Ok(match row {
        Some((id, source, goal, plan)) => json!({"operationId":id,"source":source,"goalId":goal,
            "plan": plan.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?}),
        None => Value::Null,
    })
}

fn retained(db: &Connection, task: &str, id: &str, source: &str, allow_failed: bool) -> Result<Value> {
    let row = db.query_row("SELECT d.status,d.files,p.plan FROM dots_delegations d
        LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id
        WHERE d.operation_id=?1 AND d.task_id=?2 AND d.source_message_id=?3 AND
          (d.status IN ('completed','superseded') OR (?4 AND d.status='failed') OR
            EXISTS(SELECT 1 FROM dots_dependency_waits w WHERE w.operation_id=d.operation_id))",
        params![id, task, source, allow_failed], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))).optional()?;
    Ok(match row {
        Some((status, files, plan)) => json!({"status":status,"files":serde_json::from_str::<Value>(&files)?,
            "plan":plan.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?}),
        None => Value::Null,
    })
}

fn dependency_chain(db: &Connection, task: &str, operation: &str) -> Result<Value> {
    let mut statement = db.prepare(&format!("SELECT d.operation_id,d.source_message_id,d.space_id,d.space_path,d.cwd,d.goal_id,
        d.status,d.text,d.supersedes,({CURRENT_SCOPE}) AS current_scope,v.sha,p.plan,e.settled,
        json_extract_string(try_cast(e.snapshot AS JSON),'$.delivered')
        FROM dots_delegations root JOIN dots_delegations d ON d.task_id=root.task_id AND d.seq>=root.seq
        JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        LEFT JOIN dots_verified_commits v ON v.operation_id=d.operation_id
        LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id
        LEFT JOIN LATERAL (SELECT settled,snapshot FROM dots_reply_events e WHERE e.operation_id=d.operation_id
            AND e.task_id=d.task_id AND e.status='completed' ORDER BY e.rowid DESC LIMIT 1) e ON true
        WHERE root.operation_id=?1 AND root.task_id=?2 ORDER BY d.seq"))?;
    let mut rows = statement.query(params![operation, task])?;
    let mut result = Vec::new();
    let mut bytes = 0;
    while let Some(row) = rows.next()? {
        let plan = row.get::<_, Option<String>>(11)?;
        let text = row.get::<_, String>(7)?;
        bytes += text.len() + plan.as_ref().map_or(0, String::len) + 4096;
        if bytes >= crate::MAX_REPLY_BYTES / 2 { return Err("Dots dependency lineage exceeds IPC limit".into()); }
        result.push(json!({"operation_id":row.get::<_, String>(0)?,"source_message_id":row.get::<_, String>(1)?,
            "space_id":row.get::<_, Option<String>>(2)?,"space_path":row.get::<_, Option<String>>(3)?,"cwd":row.get::<_, Option<String>>(4)?,
            "goal_id":row.get::<_, Option<String>>(5)?,"status":row.get::<_, String>(6)?,"text":text,"supersedes":row.get::<_, i64>(8)?,
            "current_scope":row.get::<_, bool>(9)?,"verified_commit":row.get::<_, Option<String>>(10)?,
            "plan":plan.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?,
            "settled":row.get::<_, Option<i64>>(12)?,"delivered":row.get::<_, Option<String>>(13)?}));
    }
    Ok(json!(result))
}

fn prerequisite(db: &Connection, task: &str, operation: &str, prerequisite: &str) -> Result<Value> {
    let row = db.query_row(&format!("SELECT d.task_id,d.title,d.status,d.text,c.state,v.sha,
        EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq
            AND newer.supersedes=1 AND newer.status<>'superseded')
        FROM dots_delegations own JOIN dots_delegations d ON d.operation_id=?3 AND d.seq<own.seq AND d.task_id<>own.task_id
          AND d.source_message_id=own.source_message_id AND d.space_id IS NOT DISTINCT FROM own.space_id
          AND d.space_path IS NOT DISTINCT FROM own.space_path
        JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        LEFT JOIN dots_target_controls c ON c.task_id=d.task_id LEFT JOIN dots_verified_commits v ON v.operation_id=d.operation_id
        WHERE own.task_id=?1 AND own.operation_id=?2 AND {CURRENT_SCOPE}"), params![task, operation, prerequisite],
        |r| Ok(json!({"taskId":r.get::<_, String>(0)?,"title":r.get::<_, String>(1)?,"status":r.get::<_, String>(2)?,
            "text":r.get::<_, String>(3)?,"control":r.get::<_, Option<String>>(4)?,"verifiedCommit":r.get::<_, Option<String>>(5)?,
            "replaced":i64::from(r.get::<_, bool>(6)?)}))).optional()?;
    Ok(row.unwrap_or(Value::Null))
}

fn conclusion(db: &Connection, task: &str, operation: &str) -> Result<Value> {
    let id = format!("dots-goal-close:{operation}");
    let row = db.query_row("SELECT coalesce(w.closure_summary,''),d.source_message_id,w.work_id,w.intent_revision,w.owner_epoch,
        w.input_snapshot_id,try_cast(json_extract_string(r.result_snapshot_json,'$.stateVersion') AS BIGINT),
        CAST(json_extract(r.result_snapshot_json,'$._controlResult.dotsGoalCompletion') AS VARCHAR)
        FROM dots_delegations d JOIN works w ON w.work_id=d.goal_id
        LEFT JOIN work_operation_receipts r ON r.work_id=w.work_id AND r.user_id=w.user_id AND r.operation_id=w.close_operation_id
            AND r.operation_type='closeWork'
        WHERE d.task_id=?1 AND d.operation_id=?2 AND w.close_operation_id=?3 AND w.lifecycle='closed' AND w.closure_conclusion='succeeded'",
        params![task, operation, id], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,r.get::<_, Option<String>>(5)?,r.get::<_, Option<i64>>(6)?,r.get::<_, Option<String>>(7)?))).optional()?;
    let Some((text, source, work, intent, owner, input, revision, packet)) = row else { return Ok(Value::Null); };
    let Some(packet) = packet else { return Ok(json!({"text":text})); };
    let packet: Value = serde_json::from_str(&packet)?;
    if packet["id"] != id || packet["taskId"] != task || packet["operationId"] != operation || packet["sourceMessageId"] != source
        || packet["workId"] != work || packet["intentRevision"] != intent || packet["ownerEpoch"] != owner
        || packet["inputSnapshotId"] != json!(input) || packet["stateVersion"] != json!(revision) { return Ok(Value::Null); }
    Ok(json!({"text":packet["text"],"completion":packet}))
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Plan { operation_id } => Ok(stored_plan(db, &operation_id)?.unwrap_or(Value::Null)),
        Query::Latest { task_id } => latest(db, &task_id),
        Query::State { task_id, operation_id, child_operation_id } => state(db, &task_id, &operation_id, child_operation_id.as_deref()),
        Query::Retained { task_id, operation_id, source, allow_failed } => retained(db, &task_id, &operation_id, &source, allow_failed),
        Query::Prerequisite { task_id, operation_id, prerequisite_id } => prerequisite(db, &task_id, &operation_id, &prerequisite_id),
        Query::DependencyChain { task_id, operation_id } => dependency_chain(db, &task_id, &operation_id),
        Query::Question { task_id, interaction_id } => {
            let title = db.query_row("SELECT title FROM conversation_interactions WHERE id=? AND task_id=? AND status='pending'",
                params![interaction_id,task_id], |row| row.get::<_, String>(0)).optional()?;
            Ok(json!(title))
        }
        Query::Conclusion { task_id, operation_id } => conclusion(db, &task_id, &operation_id),
        Query::GoalContinuations { before_seq } => {
            let mut stmt = db.prepare("SELECT d.seq,d.task_id,d.goal_id,d.operation_id,c.intent_revision,c.attempt_serial
                FROM dots_delegations d JOIN conversation_goal_continuations c ON c.work_id=d.goal_id
                WHERE (?1 IS NULL OR d.seq<?1) AND NOT EXISTS(SELECT 1 FROM dots_delegations n WHERE n.task_id=d.task_id AND n.seq>d.seq)
                ORDER BY d.seq DESC LIMIT 129")?;
            let mut cursor = stmt.query([before_seq])?;
            let mut rows = Vec::new();
            let mut last = None;
            while let Some(row) = cursor.next()? {
                if rows.len() == 128 { return Ok(json!({"rows":rows,"nextBeforeSeq":last})); }
                last = Some(row.get::<_, i64>(0)?);
                rows.push(json!({"taskId":row.get::<_, String>(1)?,"workId":row.get::<_, String>(2)?,"operationId":row.get::<_, String>(3)?,
                    "intentRevision":row.get::<_, i64>(4)?,"serial":row.get::<_, i64>(5)?}));
            }
            Ok(json!({"rows":rows,"nextBeforeSeq":null}))
        }
    }
}

fn valid_plan(plan: &Value, task: &str, operation: &str) -> bool {
    !task.is_empty() && !operation.is_empty() && plan["taskId"] == task && plan["request"]["taskId"] == task
        && plan["request"]["userMessageId"] == operation && plan["source"].as_str().is_some_and(|source| !source.is_empty())
}

fn automatic_id(task: &str, parent: &str) -> Result<String> {
    Ok(format!("dots-input-auto-{:x}", Sha256::digest(serde_json::to_vec(&[task,parent])?)))
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let reply = match command {
        Command::PutPlan { task_id, operation_id, plan } => {
            if !valid_plan(&plan, &task_id, &operation_id) { return Err("Invalid Dots follow-up identity".into()); }
            if !crate::cron_scheduler::dots_source_current(&tx, plan["source"].as_str().unwrap_or_default())? {
                return Ok(Value::Null);
            }
            let current = stored_plan(&tx, &operation_id)?;
            if let Some(ref saved) = current {
                if !valid_plan(saved, &task_id, &operation_id) || saved["source"] != plan["source"] || saved["parent"] != plan["parent"] {
                    return Err("Dots follow-up identity is already in use".into());
                }
            }
            let allowed = if operation_id.starts_with("dots-input-auto-") {
                if let Some(parent) = plan["parent"].as_str() {
                    automatic_id(&task_id, parent)? == operation_id
                        && state(&tx, &task_id, parent, Some(&operation_id))?["current"] == true
                        && stored_plan(&tx, parent)?.is_some_and(|saved| saved["source"] == plan["source"] && saved["taskId"] == task_id)
                } else { false }
            } else { true };
            if !allowed { Value::Null }
            else if let Some(saved) = current { saved }
            else {
                tx.execute("INSERT INTO dots_followup_plans VALUES(?,?)", params![operation_id, plan.to_string()])?;
                plan
            }
        }
        Command::AnchorAssignment { task_id, operation_id, expected_plan, plan } => {
            if !valid_plan(&plan, &task_id, &operation_id) || !valid_plan(&expected_plan, &task_id, &operation_id) {
                return Err("Invalid Dots assignment identity".into());
            }
            if !crate::cron_scheduler::dots_source_current(&tx, plan["source"].as_str().unwrap_or_default())? {
                return Ok(json!(false));
            }
            let current = stored_plan(&tx, &operation_id)?;
            if current.as_ref() == Some(&plan) { json!(true) }
            else if current.as_ref() != Some(&expected_plan) { json!(false) }
            else {
                tx.execute("UPDATE dots_followup_plans SET plan=?1 WHERE operation_id=?2", params![plan.to_string(), operation_id])?;
                json!(true)
            }
        }
        Command::CaptureCommitBase { task_id, operation_id, commit_base, commit_start } => {
            if !commit_start.is_object() || commit_start["head"] != commit_base { return Err("Invalid Dots commit base evidence".into()); }
            if let Some(mut saved) = stored_plan(&tx, &operation_id)? {
                if !valid_plan(&saved, &task_id, &operation_id) { return Err("Invalid Dots commit base identity".into()); }
                if saved["commitBase"].is_null() {
                    saved["commitBase"] = json!(commit_base);
                    saved["commitStart"] = commit_start;
                    tx.execute("UPDATE dots_followup_plans SET plan=?1 WHERE operation_id=?2",params![saved.to_string(),operation_id])?;
                }
                saved
            } else { Value::Null }
        }
        Command::AdoptGoal { task_id, operation_id, prior_operation_id, now, plan } => {
            if !valid_plan(&plan, &task_id, &operation_id) || plan["parent"] != prior_operation_id {
                return Err("Invalid Dots goal continuation identity".into());
            }
            let source = plan["source"].as_str().unwrap_or_default();
            if !crate::cron_scheduler::dots_source_current(&tx, source)? { return Ok(json!(false)); }
            let goal = plan["request"]["dotsGoalId"].as_str();
            let current = latest(&tx, &task_id)?;
            let accepted = if current["operationId"] == operation_id {
                current["source"] == source && current["goalId"] == json!(goal) && current["plan"]["parent"] == prior_operation_id
            } else if goal.is_some() && current["operationId"] == prior_operation_id && current["source"] == source
                && current["goalId"] == json!(goal) && current["plan"]["request"]["dotsGoalIntentRevision"] == plan["request"]["dotsGoalIntentRevision"]
                && state(&tx, &task_id, &prior_operation_id, None)?["current"] == true {
                let request = plan["request"].to_string();
                tx.execute("INSERT INTO dots_followup_plans VALUES(?,?) ON CONFLICT DO NOTHING", params![operation_id, plan.to_string()])?;
                crate::dots_delegation_data::link(&tx, crate::dots_delegation_data::Link { task_id: &task_id,
                    operation_id: &operation_id, source_message_id: source, now, supersedes: false, request_json: Some(&request), goal_id: goal })?;
                true
            } else { false };
            json!(accepted)
        }
    };
    crate::request_control::commit(tx)?;
    Ok(reply)
}
