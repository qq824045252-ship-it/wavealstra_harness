use crate::Result;
use duckdb::{params, Connection, OptionalExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const NO_ACTIVE_RECOVERY: &str =
    "NOT EXISTS(SELECT 1 FROM core_execution_runs x WHERE x.idempotency_key=d.operation_id
    AND NOT (x.status='paused' AND json_extract(x.payload_json,'$.dotsRecovery') IS NOT NULL
        AND coalesce(json_extract_string(x.result_json,'$.dotsRecoveryDeferred')='true',false)))";

const RECONCILE_SCOPE: &str = "t.archived=0 AND t.space_id IS NOT DISTINCT FROM d.space_id
    AND s.path IS NOT DISTINCT FROM d.space_path
    AND (t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))
    AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
    AND NOT EXISTS (WITH RECURSIVE parents(id,parent_id,archived) AS (
        SELECT id,parent_id,archived FROM spaces WHERE id=t.space_id
        UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id
    ) SELECT 1 FROM parents WHERE archived<>0)";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        source_ids: Option<Vec<String>>,
        space_ids: Option<Vec<String>>,
        after_seq: i64,
        limit: i64,
    },
    Recovery {
        after_seq: i64,
        limit: i64,
    },
    Current {
        task_id: String,
        operation_id: String,
        guard: RecoveryGuard,
    },
    Active {
        task_id: Option<String>,
        before_seq: Option<i64>,
        limit: i64,
    },
    Worker {
        task_id: String,
        operation_id: String,
        space_ids: Option<Vec<String>>,
        host_generation: Option<String>,
    },
    ActionData {
        #[serde(flatten)]
        query: ActionQuery,
    },
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ActionQuery {
    PendingInputs,
    ControlState { task_id: String },
    PausedTasks,
    ControlReceipt { operation_id: String, target_task_id: Option<String> },
    ControlBatch { id: String },
    ProactivePause { scope: String },
    IsProactivePaused { space_id: Option<String> },
    LatestDelegationMeta { task_id: String },
    DelegationReplay { operation_id: String, task_id: String },
    DelegationStatus { operation_id: String },
    DelegationActiveExists { operation_id: String, task_id: String },
    HasAnyDelegation { task_id: String },
    SourceLinks { source_message_id: String },
    TaskLinkCount { source_message_id: String },
    LatestStatusCheck { task_id: String, key: String, input_key: String },
    ContinuationTarget { source: String, task_id: String },
    OtherContinuationTargets { source: String, excluding_task_id: String },
    AutoWaitMatch { task_id: String, prerequisite_id: String },
    ScopeMatches { operation_id: String, task_id: String },
    UnsettledReplyOps,
    TerminalDeliveryReceipt { task_id: String, seq: i64 },
    PendingSteerCheck {
        task_id: String,
        goal_id: Option<String>,
        operation_id: Option<String>,
        continue_plan: bool,
        follow_up: bool,
    },
    BranchPersistenceCheck { child_task_id: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryGuard {
    pub sequence: i64,
    pub space_ids: Option<Vec<String>>,
    pub allow_automatic: bool,
}

pub struct Link<'a> {
    pub operation_id: &'a str,
    pub task_id: &'a str,
    pub source_message_id: &'a str,
    pub now: i64,
    pub supersedes: bool,
    pub request_json: Option<&'a str>,
    pub goal_id: Option<&'a str>,
}

pub fn link(db: &Connection, input: Link<'_>) -> Result<bool> {
    if !crate::cron_scheduler::dots_source_current(db, input.source_message_id)? {
        return Err("原定时跟进已暂停、取消或不可用".into());
    }
    let existing: Option<(String, String)> = db
        .query_row(
            "SELECT task_id,source_message_id FROM dots_delegations WHERE operation_id=?",
            [input.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((task, source)) = existing {
        if task != input.task_id || source != input.source_message_id {
            return Err("Dots 委派标识已被占用".into());
        }
        db.execute("INSERT INTO dots_followup_requests SELECT operation_id,request_json FROM dots_delegations
            WHERE operation_id=? AND request_json IS NOT NULL ON CONFLICT DO NOTHING", [input.operation_id])?;
        return Ok(false);
    }
    if input.operation_id.trim().is_empty()
        || input.source_message_id.trim().is_empty()
        || input.task_id == "mybuddy-dots"
        || input.task_id.trim().is_empty()
    {
        return Err("Dots 委派缺少有效来源或目标".into());
    }
    if let Some(raw) = input.request_json {
        let request: Value = serde_json::from_str(raw)?;
        if request["taskId"] != input.task_id || request["userMessageId"] != input.operation_id {
            return Err("委派请求身份不符".into());
        }
    }
    let changes = db.execute("INSERT INTO dots_delegations(seq,operation_id,task_id,source_message_id,title,created_at,updated_at,
        supersedes,request_json,space_id,space_path,cwd,goal_id)
        SELECT (SELECT coalesce(max(seq),0)+1 FROM dots_delegations),?1,t.id,?2,t.title,?3,?3,?4,?5,t.space_id,s.path,t.cwd,?6
        FROM tasks t LEFT JOIN spaces s ON s.id=t.space_id WHERE t.id=?7",
        params![input.operation_id,input.source_message_id,input.now,i64::from(input.supersedes),input.request_json,input.goal_id,input.task_id])?;
    if changes == 0 {
        return Err("Dots 委派的原任务不存在".into());
    }
    if let Some(request) = input.request_json {
        db.execute(
            "INSERT INTO dots_followup_requests VALUES(?,?) ON CONFLICT DO NOTHING",
            params![input.operation_id, request],
        )?;
    }
    Ok(true)
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::List {
            source_ids,
            space_ids,
            after_seq,
            limit,
        } => list(db, source_ids, space_ids, after_seq, limit),
        Query::Recovery { after_seq, limit } => candidates(db, after_seq, limit),
        Query::Current {
            task_id,
            operation_id,
            guard,
        } => {
            Ok(json!({"current": recovery_request(db, &task_id, &operation_id, &guard)?.is_some()}))
        }
        Query::Active { task_id, before_seq, limit } => active(db, task_id, before_seq, limit),
        Query::Worker { task_id, operation_id, space_ids, host_generation } => {
            worker(db, &task_id, &operation_id, space_ids.as_deref(), host_generation.as_deref())
        }
        Query::ActionData { query } => action_data(db, query),
    }
}

fn action_data(db: &Connection, query: ActionQuery) -> Result<Value> {
    use crate::sqlite_rows::records;
    match query {
        ActionQuery::PendingInputs => Ok(records(
            db,
            "SELECT task_id, operation_id FROM dots_target_controls WHERE starts_with(operation_id, 'dots-input-')",
            [],
        )?
        .into()),
        ActionQuery::ControlState { task_id } => Ok(records(
            db,
            "SELECT state, operation_id FROM dots_target_controls WHERE task_id = ?1",
            [&task_id],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::PausedTasks => Ok(records(
            db,
            "SELECT task_id FROM dots_target_controls WHERE state = 'paused'",
            [],
        )?
        .into()),
        ActionQuery::ControlReceipt {
            operation_id,
            target_task_id,
        } => {
            let row = match target_task_id {
                Some(tid) => records(
                    db,
                    "SELECT operation_id, target_task_id, outcome FROM dots_control_receipts WHERE operation_id = ?1 AND target_task_id = ?2",
                    params![operation_id, tid],
                )?,
                None => records(
                    db,
                    "SELECT operation_id, target_task_id, outcome FROM dots_control_receipts WHERE operation_id = ?1",
                    [&operation_id],
                )?,
            }
            .pop();
            Ok(row.unwrap_or(Value::Null))
        }
        ActionQuery::ControlBatch { id } => {
            let selection: Option<String> = db
                .query_row(
                    "SELECT selection FROM dots_control_batches WHERE id = ?1",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(json!({ "selection": selection }))
        }
        ActionQuery::ProactivePause { scope } => {
            let timer_ids: Option<String> = db
                .query_row(
                    "SELECT timer_ids FROM dots_proactive_pauses WHERE scope = ?1",
                    [&scope],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(json!({ "timerIds": timer_ids }))
        }
        ActionQuery::IsProactivePaused { space_id } => {
            let paused: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('', ?1))",
                [space_id.as_deref().unwrap_or("")],
                |r| r.get(0),
            )?;
            Ok(json!({ "paused": paused }))
        }
        ActionQuery::LatestDelegationMeta { task_id } => Ok(records(
            db,
            "SELECT operation_id, status, goal_id, source_message_id, seq
             FROM dots_delegations WHERE task_id = ?1 ORDER BY seq DESC LIMIT 1",
            [&task_id],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::DelegationReplay {
            operation_id,
            task_id,
        } => Ok(records(
            db,
            "SELECT status, request_json, text, goal_id
             FROM dots_delegations WHERE operation_id = ?1 AND task_id = ?2",
            params![operation_id, task_id],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::DelegationStatus { operation_id } => {
            let status: Option<String> = db
                .query_row(
                    "SELECT status FROM dots_delegations WHERE operation_id = ?1",
                    [&operation_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(json!({ "status": status }))
        }
        ActionQuery::DelegationActiveExists {
            operation_id,
            task_id,
        } => {
            let exists: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_delegations WHERE operation_id = ?1 AND task_id = ?2 AND status NOT IN ('failed','superseded'))",
                params![operation_id, task_id],
                |r| r.get(0),
            )?;
            Ok(json!({ "exists": exists }))
        }
        ActionQuery::HasAnyDelegation { task_id } => {
            let exists: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_delegations WHERE task_id = ?1)",
                [&task_id],
                |r| r.get(0),
            )?;
            Ok(json!({ "exists": exists }))
        }
        ActionQuery::SourceLinks { source_message_id } => Ok(records(
            db,
            "SELECT DISTINCT task_id FROM dots_delegations WHERE source_message_id = ?1",
            [&source_message_id],
        )?
        .into()),
        ActionQuery::TaskLinkCount { source_message_id } => Ok(records(
            db,
            "SELECT DISTINCT task_id FROM dots_delegations WHERE source_message_id = ?1 LIMIT 2",
            [&source_message_id],
        )?
        .into()),
        ActionQuery::LatestStatusCheck {
            task_id,
            key,
            input_key,
        } => {
            let latest = records(
                db,
                "SELECT d.operation_id, d.status, d.source_message_id,
                    EXISTS(SELECT 1 FROM dots_dependency_waits w WHERE w.operation_id = d.operation_id) AS has_wait
                 FROM dots_delegations d WHERE d.task_id = ?1 ORDER BY d.seq DESC LIMIT 1",
                [&task_id],
            )?
            .pop()
            .unwrap_or(Value::Null);
            let answered: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_control_receipts WHERE operation_id IN (?1, ?2) AND outcome = 'answered')",
                params![key, input_key],
                |r| r.get(0),
            )?;
            Ok(json!({ "latest": latest, "answered": answered }))
        }
        ActionQuery::ContinuationTarget { source, task_id } => Ok(records(
            db,
            "SELECT prior_operation_id, assignment_quote FROM dots_continuation_targets WHERE source = ?1 AND task_id = ?2",
            params![source, task_id],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::OtherContinuationTargets {
            source,
            excluding_task_id,
        } => Ok(records(
            db,
            "SELECT task_id, assignment_quote FROM dots_continuation_targets WHERE source = ?1 AND task_id IS DISTINCT FROM ?2",
            params![source, excluding_task_id],
        )?
        .into()),
        ActionQuery::AutoWaitMatch {
            task_id,
            prerequisite_id,
        } => {
            let matches: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_dependency_waits w JOIN dots_delegations d ON d.operation_id = w.operation_id WHERE d.task_id = ?1 AND w.prerequisite_id = ?2)",
                params![task_id, prerequisite_id],
                |r| r.get(0),
            )?;
            Ok(json!({ "matches": matches }))
        }
        ActionQuery::ScopeMatches {
            operation_id,
            task_id,
        } => Ok(records(
            db,
            "SELECT (t.space_id IS NOT DISTINCT FROM d.space_id
                     AND s.path IS NOT DISTINCT FROM d.space_path
                     AND (t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))) AS matches,
                    d.source_message_id,
                    (SELECT p.assignment FROM (SELECT json_extract_string(try_cast(plan AS JSON), '$.assignment') AS assignment FROM dots_followup_plans WHERE operation_id = d.operation_id) p) AS assignment
             FROM dots_delegations d
             JOIN tasks t ON t.id = d.task_id
             LEFT JOIN spaces s ON s.id = t.space_id
             WHERE d.operation_id = ?1 AND d.task_id = ?2",
            params![operation_id, task_id],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::UnsettledReplyOps => Ok(records(
            db,
            "SELECT DISTINCT operation_id FROM dots_reply_events WHERE settled = 0",
            [],
        )?
        .into()),
        ActionQuery::TerminalDeliveryReceipt { task_id, seq } => Ok(records(
            db,
            "SELECT json_extract_string(try_cast(snapshot AS JSON), '$.delivered') AS kind,
                    json_extract_string(try_cast(snapshot AS JSON), '$.summary') AS summary,
                    json_extract_string(try_cast(snapshot AS JSON), '$.deliveryKey') AS delivery_key
             FROM dots_reply_events r
             JOIN dots_delegations d ON d.operation_id = r.operation_id AND d.task_id = r.task_id
             WHERE r.task_id = ?1 AND d.seq = ?2 AND r.settled = 1
               AND (json_extract_string(try_cast(snapshot AS JSON), '$.delivered') IN ('question','conclusion')
                    OR (r.status IN ('completed','failed') AND json_extract_string(try_cast(snapshot AS JSON), '$.delivered') = 'progress'))
             ORDER BY r.rowid DESC LIMIT 1",
            params![task_id, seq],
        )?
        .pop()
        .unwrap_or(Value::Null)),
        ActionQuery::PendingSteerCheck {
            task_id,
            goal_id,
            operation_id,
            continue_plan,
            follow_up,
        } => {
            let prior = records(
                db,
                "SELECT d.operation_id,
                        json_extract_string(try_cast(p.plan AS JSON), '$.assignment') AS assignment,
                        d.text, d.status, d.goal_id
                 FROM dots_delegations d
                 LEFT JOIN dots_followup_plans p ON p.operation_id = d.operation_id
                 WHERE d.task_id = ?1
                 ORDER BY d.seq DESC LIMIT 1",
                [&task_id],
            )?
            .pop()
            .unwrap_or(Value::Null);
            let same_goal_exists: Option<String> = match goal_id.as_deref() {
                Some(gid) => db
                    .query_row(
                        "SELECT operation_id FROM dots_delegations WHERE goal_id = ?1 AND task_id = ?2 AND (status IN ('pending','active','blocked') OR ?3) ORDER BY seq DESC LIMIT 1",
                        params![gid, task_id, continue_plan && !follow_up],
                        |r| r.get(0),
                    )
                    .optional()?,
                None => None,
            };
            let op_exists = match operation_id.as_deref() {
                Some(op) => db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM dots_delegations WHERE operation_id = ?1)",
                    [op],
                    |r| r.get(0),
                )?,
                None => false,
            };
            Ok(json!({
                "prior": prior,
                "sameGoalOperationId": same_goal_exists,
                "operationExists": op_exists,
            }))
        }
        ActionQuery::BranchPersistenceCheck { child_task_id } => {
            let linked: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_delegations WHERE task_id = ?1)",
                [&child_task_id],
                |r| r.get(0),
            )?;
            let settled_reply: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_reply_events r JOIN dots_delegations d ON d.operation_id = r.operation_id AND d.task_id = r.task_id WHERE r.task_id = ?1 AND r.settled = 1)",
                [&child_task_id],
                |r| r.get(0),
            )?;
            Ok(json!({ "linked": linked, "settledReply": settled_reply }))
        }
    }
}

fn worker(db: &Connection, task: &str, operation: &str, space_ids: Option<&[String]>,
    host_generation: Option<&str>) -> Result<Value> {
    let spaces = space_ids.map(serde_json::to_string).transpose()?;
    let core_generation = crate::business_protocol::current_core_generation();
    let row = db.query_row("WITH RECURSIVE ancestors(id,parent_id,archived) AS (
           SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON s.id=t.space_id WHERE t.id=?1
           UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
       ), latest AS (SELECT * FROM dots_delegations WHERE task_id=?1 ORDER BY seq DESC LIMIT 1)
       SELECT d.source_message_id,t.space_id,t.cwd,
         t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path) AS same_cwd,
         EXISTS(SELECT 1 FROM durable_bot_bindings b WHERE b.task_id=t.id AND b.cwd=t.cwd) AS bound_cwd
       FROM latest d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
       WHERE d.operation_id=?2 AND d.goal_id IS NULL
         AND (d.status IN ('pending','running') OR (d.status='blocked' AND d.interaction_id IS NOT NULL))
         AND (?3 IS NULL OR t.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(?3)))
         AND t.id<>'mybuddy-dots' AND NOT starts_with(t.id,'gw-') AND NOT regexp_full_match(t.id,'gateway-chat-[a-f0-9]{64}')
         AND t.archived=0 AND t.external_agent_pin_json IS NULL
         AND NOT EXISTS(SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
         AND (t.space_id IS NULL OR EXISTS(SELECT 1 FROM ancestors WHERE parent_id IS NULL))
         AND NOT EXISTS(SELECT 1 FROM ancestors WHERE archived<>0 OR starts_with(id,'sp-gw-')
           OR starts_with(id,'bot-space-') OR starts_with(id,'bot-team-space-') OR starts_with(id,'bot-workspace-group-'))
         AND t.space_id IS NOT DISTINCT FROM d.space_id AND s.path IS NOT DISTINCT FROM d.space_path
         AND ((t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))
           OR (d.cwd IS NULL AND d.space_path IS NULL AND t.cwd IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ancestors a JOIN spaces u ON u.id=a.id WHERE u.path IS NOT NULL AND trim(u.path)<>'')))
         AND NOT EXISTS(SELECT 1 FROM dots_target_controls c WHERE c.task_id=t.id AND c.operation_id<>d.operation_id)
         AND (?4 IS NULL OR EXISTS(SELECT 1 FROM core_pi_hosts h WHERE h.host_generation=?4 AND h.core_generation=?5
           AND h.status IN ('bootstrapping','running') AND NOT EXISTS(SELECT 1 FROM core_pi_host_fences f WHERE f.host_generation=h.host_generation)))",
        params![task,operation,spaces,host_generation,core_generation], |row| Ok((row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,row.get::<_, Option<String>>(2)?,row.get::<_, bool>(3)?,row.get::<_, bool>(4)?)),
    ).optional()?;
    let Some((source, space_id, cwd, same_cwd, bound_cwd)) = row else { return Ok(Value::Null); };
    if !crate::cron_scheduler::dots_source_current(db, &source)? || (!same_cwd && !bound_cwd) {
        return Ok(Value::Null);
    }
    Ok(json!({"spaceId":space_id,"privateCwd":if same_cwd { None } else { cwd }}))
}

fn active(db: &Connection, task: Option<String>, before: Option<i64>, limit: i64) -> Result<Value> {
    let size = limit.clamp(1, 256) as usize;
    let mut stmt = db.prepare(&format!("SELECT d.seq,d.operation_id,d.task_id,d.source_message_id,d.title,d.goal_id,
        d.status,d.created_at,d.updated_at,EXISTS (SELECT 1 FROM dots_dependency_waits w WHERE w.operation_id=d.operation_id),
        rule.status,coalesce(json_extract(try_cast(rule.snapshot AS JSON),'$.policy.trackingPolicy'),
            json_extract(try_cast(default_rule.config AS JSON),'$.policy.trackingPolicy'))
        FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        LEFT JOIN answer_rule_turns rule ON rule.task_id='mybuddy-dots' AND rule.input_id=d.source_message_id
        LEFT JOIN answer_rules default_rule ON default_rule.id='dots-default-policy'
        WHERE d.status IN ('pending','running','blocked') AND (?1 IS NULL OR d.task_id=?1)
          AND (?2 IS NULL OR d.seq<?2) AND {RECONCILE_SCOPE} ORDER BY d.seq DESC LIMIT ?3"))?;
    let mut cursor = stmt.query(params![task, before, size + 1])?;
    let mut rows = Vec::new();
    let mut last = None;
    while let Some(row) = cursor.next()? {
        if rows.len() == size {
            return Ok(json!({"rows":rows,"nextBeforeSeq":last}));
        }
        let seq: i64 = row.get(0)?;
        let policy = row.get::<_, Option<String>>(11)?;
        let revoked = row.get::<_, Option<String>>(10)?.as_deref() == Some("revoked");
        rows.push(json!({"sequence":seq,"id":row.get::<_, String>(1)?,"taskId":row.get::<_, String>(2)?,
            "sourceMessageId":row.get::<_, String>(3)?,"title":row.get::<_, String>(4)?,"goalId":row.get::<_, Option<String>>(5)?,
            "status":row.get::<_, String>(6)?,"createdAt":row.get::<_, i64>(7)?,"updatedAt":row.get::<_, i64>(8)?,
            "waitingOnPrerequisite":row.get::<_, bool>(9)?,"trackingRevoked":revoked,
            "trackingPolicy":policy.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?}));
        last = Some(seq);
    }
    Ok(json!({"rows":rows,"nextBeforeSeq":null}))
}

pub fn reconcile_basis(db: &Connection, seq: i64, task: &str, operation: &str) -> Result<Option<(i64, i64, bool)>> {
    Ok(db.query_row(&format!("SELECT d.updated_at,d.created_at,d.supersedes=1 FROM dots_delegations d
        JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        WHERE d.seq=?1 AND d.task_id=?2 AND d.operation_id=?3 AND d.status IN ('pending','running','blocked')
          AND {RECONCILE_SCOPE}"), params![seq, task, operation], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?)
}

fn candidates(db: &Connection, after: i64, limit: i64) -> Result<Value> {
    let size = limit.clamp(1, 256) as usize;
    let mut stmt = db.prepare(&format!("SELECT seq,operation_id,task_id FROM dots_delegations d
        WHERE seq>? AND status='pending' AND request_json IS NOT NULL
          AND {NO_ACTIVE_RECOVERY}
          AND NOT EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id AND e.settled=1)
        ORDER BY seq LIMIT ?"))?;
    let mut cursor = stmt.query(params![after, size + 1])?;
    let mut rows = Vec::new();
    let mut last = None;
    while let Some(row) = cursor.next()? {
        if rows.len() == size {
            return Ok(json!({"rows":rows,"nextAfterSeq":last}));
        }
        let seq: i64 = row.get(0)?;
        rows.push(json!({"sequence":seq,"operationId":row.get::<_, String>(1)?,"taskId":row.get::<_, String>(2)?}));
        last = Some(seq);
    }
    Ok(json!({"rows":rows,"nextAfterSeq":null}))
}

fn list(
    db: &Connection,
    source_ids: Option<Vec<String>>,
    space_ids: Option<Vec<String>>,
    after: i64,
    limit: i64,
) -> Result<Value> {
    let size = limit.clamp(1, 256) as usize;
    let sources = source_ids
        .map(|ids| serde_json::to_string(&ids))
        .transpose()?;
    let spaces = space_ids
        .map(|ids| serde_json::to_string(&ids))
        .transpose()?;
    let mut stmt = db.prepare("SELECT d.seq,d.operation_id,d.task_id,d.title,d.source_message_id,d.status,d.text,d.files,
        d.created_at,d.updated_at,d.goal_id,d.interaction_id,EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id),
        a.\"at\",a.tool,a.phase,a.last_report_at,(SELECT max(p.\"at\") FROM dots_verified_progress p WHERE p.operation_id=d.operation_id),
        w.prerequisite_id,w.title,w.deadline_at FROM dots_delegations d JOIN tasks t ON t.id=d.task_id
        LEFT JOIN dots_tool_observations a USING(operation_id)
        LEFT JOIN dots_dependency_waits w ON w.operation_id=d.operation_id AND d.status='blocked'
          AND EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=w.operation_id AND e.status='blocked' AND e.settled=0)
        WHERE d.seq>?1 AND (?2 IS NULL OR d.source_message_id IN (SELECT json_extract_string(value,'$') FROM json_each(?2)))
          AND (?3 IS NULL OR t.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(?3)))
        ORDER BY d.seq LIMIT ?4")?;
    let mut cursor = stmt.query(params![after, sources, spaces, size + 1])?;
    let mut rows = Vec::new();
    let mut bytes = 4096;
    let mut last = None;
    while let Some(row) = cursor.next()? {
        if rows.len() == size {
            return Ok(json!({"rows":rows,"nextAfterSeq":last}));
        }
        let mut output = json!({
            "id":row.get::<_, String>(1)?,"taskId":row.get::<_, String>(2)?,"title":row.get::<_, String>(3)?,
            "sourceMessageId":row.get::<_, String>(4)?,"status":row.get::<_, String>(5)?,"text":row.get::<_, String>(6)?,
            "artifacts":serde_json::from_str::<Value>(&row.get::<_, String>(7)?)?,"createdAt":row.get::<_, i64>(8)?,"updatedAt":row.get::<_, i64>(9)?,
        });
        if let Some(goal) = row.get::<_, Option<String>>(10)? {
            output["goalId"] = json!(goal);
        }
        if let Some(interaction) = row.get::<_, Option<String>>(11)? {
            output["interactionId"] = json!(interaction);
        }
        if row.get::<_, bool>(12)? {
            output["proactiveReply"] = json!(true);
        }
        if let Some(at) = row.get::<_, Option<i64>>(13)? {
            let mut activity = json!({"lastActivityAt":at,"tool":row.get::<_, String>(14)?,"phase":row.get::<_, String>(15)?});
            if let Some(at) = row.get::<_, Option<i64>>(16)? {
                activity["lastReportAt"] = json!(at);
            }
            if let Some(at) = row.get::<_, Option<i64>>(17)? {
                activity["lastProgressAt"] = json!(at);
            }
            output["activity"] = activity;
        }
        if let Some(prerequisite) = row.get::<_, Option<String>>(18)? {
            output["dependencyWait"] = json!({"operationId":prerequisite,"title":row.get::<_, String>(19)?,"deadlineAt":row.get::<_, i64>(20)?});
        }
        bytes += serde_json::to_vec(&output)?.len() + 1;
        if bytes >= crate::MAX_REPLY_BYTES {
            if rows.is_empty() {
                return Err("Dots delegation exceeds IPC page limit".into());
            }
            return Ok(json!({"rows":rows,"nextAfterSeq":last}));
        }
        last = Some(row.get::<_, i64>(0)?);
        rows.push(output);
    }
    Ok(json!({"rows":rows,"nextAfterSeq":null}))
}

pub fn recovery_request(
    db: &Connection,
    task: &str,
    operation: &str,
    guard: &RecoveryGuard,
) -> Result<Option<Value>> {
    let spaces = guard
        .space_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let row: Option<(String, String, bool)> = db.query_row("WITH RECURSIVE ancestors(id,parent_id,archived) AS (
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON s.id=t.space_id WHERE t.id=?1
            UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
        )
        SELECT d.request_json,d.source_message_id,EXISTS(SELECT 1 FROM dots_proactive_pauses p WHERE p.scope IN ('',coalesce(t.space_id,'')))
        FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        WHERE d.task_id=?1 AND d.operation_id=?2 AND d.seq=?3 AND d.status='pending' AND d.request_json IS NOT NULL
          AND (?4 IS NULL OR t.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(?4)))
          AND t.id<>'mybuddy-dots' AND t.archived=0 AND t.external_agent_pin_json IS NULL
          AND NOT EXISTS(SELECT 1 FROM ancestors WHERE archived<>0)
          AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
          AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
          AND t.space_id IS NOT DISTINCT FROM d.space_id AND s.path IS NOT DISTINCT FROM d.space_path
          AND (t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))
          AND NOT EXISTS(SELECT 1 FROM dots_target_controls c WHERE c.task_id=t.id AND c.state IN ('paused','stopped') AND c.operation_id<>d.operation_id)
          AND NOT EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id AND e.settled=1)",
        params![task,operation,guard.sequence,spaces], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    let Some((raw, source, paused)) = row else {
        return Ok(None);
    };
    let request: Value = serde_json::from_str(&raw)?;
    if request["taskId"] != task || request["userMessageId"] != operation {
        return Ok(None);
    }
    let cron = crate::cron_scheduler::dots_run_id(&source).is_some();
    let automatic =
        !request["dotsFileWatch"].is_null() || operation.starts_with("dots-input-auto-") || cron;
    if automatic && (!guard.allow_automatic || paused) || !crate::cron_scheduler::dots_source_current(db, &source)? {
        return Ok(None);
    }
    Ok(Some(request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::CANONICAL_DUCKDB_SCHEMA_SQL;

    #[test]
    fn worker_authority_requires_current_operation_scope_and_live_host_generation() -> Result<()> {
        let db = Connection::open_in_memory()?;
        db.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL)?;
        db.execute_batch("INSERT INTO spaces(id,name,created_at,updated_at) VALUES('workspace','Workspace',1,1);
            INSERT INTO tasks(id,title,space_id,updated_at) VALUES('task','Task','workspace',1);
            INSERT INTO dots_delegations(seq,operation_id,task_id,source_message_id,title,status,created_at,updated_at,space_id)
                VALUES(1,'first','task','input','Task','blocked',1,1,'workspace');")?;
        db.execute("INSERT INTO core_pi_hosts(host_id,pid,core_generation,host_generation,storage_root,db_path,pi_version,
            status,started_at_ms,last_heartbeat_ms) VALUES('host',1,?,'live','root','db','test','running',1,1)",
            [crate::business_protocol::current_core_generation()])?;
        let spaces = ["workspace".into()];
        let active = || worker(&db, "task", "first", Some(&spaces), Some("live"));
        assert_eq!(active()?, Value::Null);
        db.execute("UPDATE dots_delegations SET interaction_id='needs-input' WHERE operation_id='first'", [])?;
        assert_eq!(active()?, json!({"spaceId":"workspace","privateCwd":null}));
        assert_eq!(worker(&db, "task", "first", Some(&[]), Some("live"))?, Value::Null);
        assert_eq!(worker(&db, "task", "first", None, Some("old"))?, Value::Null);
        db.execute("UPDATE tasks SET cwd='internal-task-directory' WHERE id='task'", [])?;
        assert_eq!(active()?, Value::Null);
        db.execute("INSERT INTO durable_bot_bindings(task_id,backend,directory,cwd)
            VALUES('task','pi-durable','store','internal-task-directory')", [])?;
        assert_eq!(active()?, json!({"spaceId":"workspace","privateCwd":"internal-task-directory"}));
        db.execute("INSERT INTO dots_target_controls VALUES('task','paused','next')", [])?;
        assert_eq!(active()?, Value::Null);
        db.execute("DELETE FROM dots_target_controls WHERE task_id='task'", [])?;
        db.execute("INSERT INTO core_pi_host_fences VALUES('live','lost lease',2)", [])?;
        assert_eq!(active()?, Value::Null);
        db.execute_batch("DELETE FROM core_pi_host_fences;
            INSERT INTO dots_delegations(seq,operation_id,task_id,source_message_id,title,status,created_at,updated_at,space_id)
                VALUES(2,'next','task','next-input','Task','running',2,2,'workspace');")?;
        assert_eq!(active()?, Value::Null);
        Ok(())
    }
}
