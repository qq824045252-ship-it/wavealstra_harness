use super::{MAX_CRITERIA, MAX_TOKEN_BUDGET, hash, read_goal, rejected};
use crate::Result;
use crate::business_protocol::{ClientContext, current_core_generation};
use crate::outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx};
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalMutation {
    pub user_id: String,
    pub task_id: String,
    pub goal_id: String,
    pub expected_state_version: i64,
    pub expected_intent_revision: i64,
    pub expected_owner_epoch: i64,
    title: Option<String>,
    description: Option<String>,
    progress_summary: Option<String>,
    status: Option<GoalStatus>,
    criteria: Option<Vec<CriterionInput>>,
    criterion_updates: Option<Vec<CriterionUpdate>>,
    #[serde(
        default,
        deserialize_with = "provided_budget",
        skip_serializing_if = "Option::is_none"
    )]
    token_budget: Option<Option<i64>>,
    default_token_budget: Option<i64>,
}

fn provided_budget<'de, D: Deserializer<'de>>(
    input: D,
) -> std::result::Result<Option<Option<i64>>, D::Error> {
    Option::deserialize(input).map(Some)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Achieved,
    Cancelled,
}

type Criterion = Map<String, Value>;

#[derive(Deserialize, Serialize)]
struct CriterionInput {
    id: Option<String>,
    text: String,
}

#[derive(Deserialize, Serialize)]
struct CriterionUpdate {
    id: String,
    text: Option<String>,
    status: Option<CriterionStatus>,
    evidence: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CriterionStatus {
    Pending,
    Met,
    NotMet,
    Waived,
}

struct Goal {
    state_version: i64,
    intent_revision: i64,
    owner_epoch: i64,
    source_version: i64,
    title: String,
    description: Option<String>,
    progress: Option<String>,
    criteria: Vec<Criterion>,
    snapshot: String,
    input_snapshot: String,
    lifecycle: String,
    mode: String,
    ledger_state: String,
    ledger_reason: Option<String>,
    ledger_deferred_at: Option<i64>,
    budget: Option<i64>,
    tokens_used: i64,
    updated_at: i64,
}

pub fn mutate(
    db: &mut Connection,
    operation_id: &str,
    mutation: GoalMutation,
    client: &ClientContext,
) -> Result<Value> {
    if client.role != "ui" {
        return Ok(rejected("not_found", "此入口只接受桌面对话的用户操作"));
    }
    if operation_id.trim().is_empty()
        || operation_id.len() > 200
        || [&mutation.user_id, &mutation.task_id, &mutation.goal_id]
            .iter()
            .any(|value| value.trim().is_empty())
        || [
            mutation.expected_state_version,
            mutation.expected_intent_revision,
            mutation.expected_owner_epoch,
        ]
        .iter()
        .any(|&revision| revision < 1)
        || [
            mutation.token_budget.flatten(),
            mutation.default_token_budget,
        ]
        .into_iter()
        .flatten()
        .any(|budget| !(1..=MAX_TOKEN_BUDGET).contains(&budget))
    {
        return Ok(rejected(
            "invalid_request",
            "Goal 操作、目标版本或 Token 预算无效",
        ));
    }
    let tx = db.transaction()?;
    match mutate_in_tx(&tx, operation_id, &mutation) {
        Ok(reply) => {
            crate::request_control::commit(tx)?;
            Ok(reply)
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            Err(error)
        }
    }
}

fn mutate_in_tx(
    tx: &Transaction<'_>,
    operation_id: &str,
    mutation: &GoalMutation,
) -> Result<Value> {
    let caller = format!("conversation-goal:{}", mutation.user_id);
    let fingerprint = hash(&serde_json::to_vec(&("mutateConversationGoal", mutation))?);
    let prior: Option<(String, String)> = tx.query_row(
        "SELECT request_hash,result_json FROM operation_receipts WHERE caller_scope=?1 AND operation_id=?2 AND batch_index=0",
        params![caller, operation_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((saved_hash, encoded)) = prior {
        if fingerprint != saved_hash {
            return Ok(rejected("conflict", "该操作身份已用于另一项 Goal 请求"));
        }
        let mut reply: Value = serde_json::from_str(&encoded)?;
        if reply["ok"] == true {
            reply["replayed"] = true.into();
        }
        return Ok(reply);
    }
    let now = i64::try_from(crate::request_control::now_ms())?;
    let reply = apply_mutation(tx, operation_id, mutation, now)?;
    tx.execute(
        "INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
         VALUES (?1,?2,0,?3,'committed',?4,?5)",
        params![caller, operation_id, fingerprint, serde_json::to_string(&reply)?, now],
    )?;
    Ok(reply)
}

fn read_authority(tx: &Connection, m: &GoalMutation) -> Result<Option<Goal>> {
    let mut stmt = tx.prepare(
        "SELECT w.state_version,w.intent_revision,w.owner_epoch,w.source_version,w.title,w.goal_description,
                w.progress_summary,w.criteria_json,w.active_intent_snapshot_id,w.input_snapshot_id,w.lifecycle,w.mode,
                c.state,c.defer_reason,c.deferred_at,c.tokens_budget,c.tokens_used,greatest(w.updated_at,c.updated_at)
         FROM works w JOIN work_conversations l ON l.work_id=w.work_id AND l.channel_type='desktop'
         JOIN tasks t ON t.id=l.conversation_id
         JOIN conversation_goal_continuations c ON c.work_id=w.work_id AND c.task_id=t.id AND c.intent_revision=w.intent_revision
         WHERE w.user_id=?1 AND t.id=?2 AND w.work_id=?3
           AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
           AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed')",
    )?;
    let mut rows = stmt.query(params![m.user_id, m.task_id, m.goal_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(Goal {
        state_version: row.get(0)?,
        intent_revision: row.get(1)?,
        owner_epoch: row.get(2)?,
        source_version: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        progress: row.get(6)?,
        criteria: serde_json::from_str(&row.get::<_, String>(7)?)?,
        snapshot: row.get(8)?,
        input_snapshot: row.get(9)?,
        lifecycle: row.get(10)?,
        mode: row.get(11)?,
        ledger_state: row.get(12)?,
        ledger_reason: row.get(13)?,
        ledger_deferred_at: row.get(14)?,
        budget: row.get(15)?,
        tokens_used: row.get(16)?,
        updated_at: row.get(17)?,
    }))
}

fn limited(text: &str, length: usize) -> String {
    text.trim().chars().take(length).collect()
}

fn text_or_none(text: &str, length: usize) -> Option<String> {
    let text = limited(text, length);
    (!text.is_empty()).then_some(text)
}

fn apply_mutation(
    tx: &Transaction<'_>,
    operation_id: &str,
    m: &GoalMutation,
    now: i64,
) -> Result<Value> {
    let Some(goal) = read_authority(tx, m)? else {
        return Ok(rejected("not_found", "找不到当前对话中的 Goal"));
    };
    if (goal.state_version, goal.intent_revision, goal.owner_epoch)
        != (
            m.expected_state_version,
            m.expected_intent_revision,
            m.expected_owner_epoch,
        )
    {
        return Ok(rejected("conflict", "Goal 已变化，请刷新后重试"));
    }
    if matches!(goal.lifecycle.as_str(), "closed" | "closing") {
        return Ok(rejected("conflict", "Goal 已结束或正在结算"));
    }

    let title = m
        .title
        .as_ref()
        .map_or_else(|| goal.title.clone(), |text| limited(text, 240));
    if title.is_empty() {
        return Ok(rejected("invalid_request", "Goal 标题不能为空"));
    }
    let description = m
        .description
        .as_ref()
        .map_or_else(|| goal.description.clone(), |text| text_or_none(text, 2000));
    let progress = m
        .progress_summary
        .as_ref()
        .and_then(|text| text_or_none(text, 2000))
        .or_else(|| goal.progress.clone());
    let change_id = hash(&serde_json::to_vec(&[
        m.user_id.as_str(),
        m.goal_id.as_str(),
        operation_id,
    ])?);
    let mut criteria = match criteria_definitions(m, &goal.criteria, &change_id) {
        Ok(criteria) => criteria,
        Err(message) => return Ok(rejected("invalid_request", message)),
    };
    let requirement_changed =
        title != goal.title || description != goal.description || criteria != goal.criteria;
    let attestations = m.criterion_updates.as_deref().unwrap_or_default();
    if requirement_changed && attestations.iter().any(|update| update.status.is_some()) {
        return Ok(rejected(
            "conflict",
            "保存新的目标要求后，请按当前要求重新确认验收",
        ));
    }
    let intent = if requirement_changed {
        goal.intent_revision + 1
    } else {
        goal.intent_revision
    };
    if requirement_changed {
        for criterion in &mut criteria {
            reset_criterion(criterion, intent);
        }
    }
    let mut evidence = Vec::new();
    for update in attestations.iter().filter(|update| update.status.is_some()) {
        let criterion = criteria
            .iter_mut()
            .find(|criterion| {
                criterion.get("id").and_then(Value::as_str) == Some(update.id.as_str())
            })
            .expect("criterion updates were scoped during definition validation");
        if let Err(message) = attest_criterion(
            criterion,
            update,
            &m.user_id,
            intent,
            &change_id,
            &mut evidence,
        ) {
            return Ok(rejected("invalid_request", message));
        }
    }

    let budget = m.token_budget.unwrap_or(goal.budget);
    let now = now.max(goal.updated_at + 1);
    let (lifecycle, conclusion, event) = match m.status {
        Some(GoalStatus::Blocked) => {
            return Ok(rejected("invalid_request", "阻塞状态由实际未解决事项决定"));
        }
        Some(GoalStatus::Achieved) => {
            if goal.lifecycle != "active" || goal.mode != "once" || requirement_changed {
                return Ok(rejected(
                    "conflict",
                    "只有当前进行中的一次性 Goal 可以验收完成",
                ));
            }
            if criteria
                .iter()
                .any(|criterion| !criterion_resolved(criterion, intent))
            {
                return Ok(rejected("conflict", "还有验收条件未按当前目标要求确认"));
            }
            if goal.ledger_state == "igniting" || has_unsettled_work(tx, &m.goal_id, true)? {
                return Ok(rejected(
                    "conflict",
                    "仍有在途执行、未覆盖缺口或未核对的外部效果",
                ));
            }
            stop_pending_work(tx, &m.goal_id, now)?;
            ("closed", Some("succeeded"), "work.closed")
        }
        Some(GoalStatus::Cancelled) => {
            if requirement_changed || !attestations.is_empty() {
                return Ok(rejected("invalid_request", "请分别提交 Goal 编辑与取消"));
            }
            stop_pending_work(tx, &m.goal_id, now)?;
            if has_unsettled_work(tx, &m.goal_id, false)? {
                ("closing", Some("cancelled"), "work.cancel_requested")
            } else {
                ("closed", Some("cancelled"), "work.closed")
            }
        }
        Some(GoalStatus::Paused) if goal.lifecycle == "active" => ("paused", None, "work.paused"),
        Some(GoalStatus::Active) if goal.lifecycle == "paused" => ("active", None, "work.resumed"),
        _ => (goal.lifecycle.as_str(), None, "work.amended"),
    };
    if lifecycle == goal.lifecycle
        && !requirement_changed
        && progress == goal.progress
        && budget == goal.budget
        && criteria == goal.criteria
    {
        return read_goal(tx, &m.task_id, &m.user_id, &m.goal_id, false);
    }

    let revision = goal.state_version + 1;
    let encoded_criteria = serde_json::to_string(&criteria)?;
    let snapshot = if requirement_changed {
        advance_intent(
            tx,
            m,
            &goal,
            intent,
            &title,
            description.as_deref(),
            &encoded_criteria,
            now,
        )?
    } else {
        goal.snapshot.clone()
    };
    if !evidence.is_empty() {
        tx.execute(
            "INSERT INTO work_evidence(evidence_id,work_id,criterion_ids_json,kind,provenance,source_ref,input_snapshot_id,intent_revision,detail,recorded_at)
             VALUES (?1,?2,?3,'user_attestation','user',?4,?5,?6,?7,?8)",
            params![format!("evidence-{change_id}"), m.goal_id, serde_json::to_string(&evidence)?,
                format!("user-attestation:{operation_id}"), goal.input_snapshot, intent,
                evidence_detail(m), now],
        )?;
    }
    let changed = tx.execute(
        "UPDATE works SET title=?1,goal_description=?2,progress_summary=?3,criteria_json=?4,lifecycle=?5,
             state_version=?6,intent_revision=?7,active_intent_snapshot_id=?8,updated_at=?9,
             accepted_deliverable_ids_json=CASE WHEN ?7<>?10 THEN '[]' ELSE accepted_deliverable_ids_json END,
             closure_conclusion=CASE WHEN ?5='closed' THEN ?11 ELSE closure_conclusion END,
             pending_conclusion=CASE WHEN ?5='closing' THEN ?11 ELSE NULL END,
             closure_summary=CASE WHEN ?11 IS NOT NULL THEN coalesce(?3,closure_summary) ELSE closure_summary END,
             closed_at=CASE WHEN ?5='closed' THEN ?9 ELSE closed_at END,
             cancel_requested_at=CASE WHEN ?11='cancelled' THEN ?9 ELSE cancel_requested_at END,
             close_operation_id=CASE WHEN ?11 IS NOT NULL THEN ?12 ELSE close_operation_id END
         WHERE work_id=?13 AND user_id=?14 AND state_version=?15 AND intent_revision=?10 AND owner_epoch=?16",
        params![title, description, progress, encoded_criteria, lifecycle, revision, intent, snapshot, now,
            goal.intent_revision, conclusion, operation_id, m.goal_id, m.user_id, goal.state_version, goal.owner_epoch],
    )?;
    if changed != 1 {
        return Err("Goal authority changed during its mutation".into());
    }
    update_ledger(tx, m, &goal, intent, lifecycle, budget, now)?;
    publish_change(
        tx,
        m,
        operation_id,
        &change_id,
        lifecycle,
        conclusion,
        event,
        intent,
        revision,
        now,
    )?;
    read_goal(tx, &m.task_id, &m.user_id, &m.goal_id, false)
}

fn criteria_definitions(
    m: &GoalMutation,
    current: &[Criterion],
    operation_hash: &str,
) -> std::result::Result<Vec<Criterion>, &'static str> {
    let mut criteria = current.to_vec();
    if let Some(inputs) = &m.criteria {
        if inputs.len() > MAX_CRITERIA {
            return Err("验收条件超出数量上限");
        }
        criteria.clear();
        let mut seen = HashSet::new();
        for (index, input) in inputs.iter().enumerate() {
            let text = text_or_none(&input.text, 500).ok_or("验收条件不能为空")?;
            let mut criterion = if let Some(id) = &input.id {
                if !seen.insert(id) {
                    return Err("验收条件不能重复");
                }
                current
                    .iter()
                    .find(|criterion| {
                        criterion.get("id").and_then(Value::as_str) == Some(id.as_str())
                    })
                    .cloned()
                    .ok_or("找不到需要编辑的验收条件")?
            } else {
                Map::from_iter([
                    (
                        "id".into(),
                        format!("criterion-{operation_hash}-{index}").into(),
                    ),
                    ("requiresRealEnvironmentCheck".into(), false.into()),
                ])
            };
            criterion.insert("text".into(), text.into());
            criteria.push(criterion);
        }
    }
    let mut seen = HashSet::new();
    for update in m.criterion_updates.as_deref().unwrap_or_default() {
        if !seen.insert(&update.id) {
            return Err("验收条件不能重复更新");
        }
        let criterion = criteria
            .iter_mut()
            .find(|criterion| {
                criterion.get("id").and_then(Value::as_str) == Some(update.id.as_str())
            })
            .ok_or("找不到需要更新的验收条件")?;
        if let Some(text) = &update.text {
            let text = text_or_none(text, 500).ok_or("验收条件不能为空")?;
            criterion.insert("text".into(), text.into());
        }
    }
    Ok(criteria)
}

fn reset_criterion(criterion: &mut Criterion, intent: i64) {
    criterion.insert("status".into(), "pending".into());
    criterion.insert("requiredIntentRevision".into(), intent.into());
    criterion.insert("evidenceRefs".into(), json!([]));
    for field in ["verifiedIntentRevision", "waivedReason", "waivedByUserId"] {
        criterion.remove(field);
    }
}

fn attest_criterion(
    criterion: &mut Criterion,
    update: &CriterionUpdate,
    user_id: &str,
    intent: i64,
    operation_hash: &str,
    evidence: &mut Vec<String>,
) -> std::result::Result<(), &'static str> {
    let status = update
        .status
        .expect("only attestations with a status are applied");
    criterion.remove("origin");
    match status {
        CriterionStatus::Pending => reset_criterion(criterion, intent),
        CriterionStatus::Waived => {
            let reason = update
                .evidence
                .as_ref()
                .and_then(|text| text_or_none(text, 1000))
                .ok_or("豁免验收条件必须记录原因")?;
            reset_criterion(criterion, intent);
            criterion.insert("status".into(), "waived".into());
            criterion.insert("waivedReason".into(), reason.into());
            criterion.insert("waivedByUserId".into(), user_id.into());
        }
        CriterionStatus::Met | CriterionStatus::NotMet => {
            if matches!(status, CriterionStatus::Met)
                && (criterion
                    .get("requiresRealEnvironmentCheck")
                    .and_then(Value::as_bool)
                    == Some(true)
                    || criterion
                        .get("requiredEnvironment")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty()))
            {
                return Err("此验收条件需要能核对环境与版本的实测证据");
            }
            criterion.remove("waivedReason");
            criterion.remove("waivedByUserId");
            let status = if matches!(status, CriterionStatus::Met) {
                "satisfied"
            } else {
                "failed"
            };
            criterion.insert("status".into(), status.into());
            criterion.insert("requiredIntentRevision".into(), intent.into());
            criterion.insert("verifiedIntentRevision".into(), intent.into());
            let mut refs = criterion
                .remove("evidenceRefs")
                .and_then(|value| match value {
                    Value::Array(refs) => Some(refs),
                    _ => None,
                })
                .unwrap_or_default();
            refs.push(format!("evidence-{operation_hash}").into());
            criterion.insert("evidenceRefs".into(), refs.into());
            evidence.push(update.id.clone());
        }
    }
    Ok(())
}

fn criterion_resolved(criterion: &Criterion, intent: i64) -> bool {
    if criterion.get("origin").and_then(Value::as_str) == Some("assistant_proposal") {
        return true;
    }
    match criterion.get("status").and_then(Value::as_str) {
        Some("waived") => true,
        Some("satisfied") => ["requiredIntentRevision", "verifiedIntentRevision"]
            .iter()
            .all(|field| criterion.get(*field).and_then(Value::as_i64) == Some(intent)),
        _ => false,
    }
}

fn evidence_detail(m: &GoalMutation) -> Option<String> {
    if let Some(progress) = m
        .progress_summary
        .as_ref()
        .and_then(|text| text_or_none(text, 2000))
    {
        return Some(progress);
    }
    let notes: Vec<_> = m
        .criterion_updates
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|update| update.evidence.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect();
    text_or_none(&notes.join("；"), 2000)
}

fn stop_pending_work(tx: &Connection, work_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE work_subscriptions SET stopped_at=?1,stopped_reason='work_closed' WHERE work_id=?2 AND stopped_at IS NULL",
        params![now, work_id],
    )?;
    tx.execute(
        "UPDATE work_dispatch_requests SET state='cancelled',error=coalesce(error,'work_closed') WHERE work_id=?1 AND state='pending'",
        [work_id],
    )?;
    tx.execute(
        "UPDATE work_execution_bindings SET status='stopped',settled_at=?1 WHERE work_id=?2
           AND status='pending' AND attempt_id IS NULL AND submission_receipt IS NULL",
        params![now, work_id],
    )?;
    Ok(())
}

fn has_unsettled_work(tx: &Connection, work_id: &str, for_achievement: bool) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_execution_bindings WHERE work_id=?1 AND status IN ('pending','submitted','running','unknown'))
          OR EXISTS(SELECT 1 FROM work_action_admissions WHERE work_id=?1 AND state IN ('admitted','unknown'))
          OR EXISTS(SELECT 1 FROM work_blockers WHERE work_id=?1 AND status='open' AND (?2 OR kind='external_effect'))
          OR (?2 AND EXISTS(SELECT 1 FROM work_continuation_plans WHERE work_id=?1 AND state IN ('pending','dispatched') AND json_array_length(gap_items_json)>0))
          OR EXISTS(SELECT 1 FROM core_execution_runs WHERE json_extract_string(payload_json,'$.workId')=?1
                    AND status IN ('queued','waiting_executor','dispatching','running','pause_requested','cancel_requested'))",
        params![work_id, for_achievement], |row| row.get(0),
    )?)
}

fn advance_intent(
    tx: &Connection,
    m: &GoalMutation,
    goal: &Goal,
    intent: i64,
    title: &str,
    description: Option<&str>,
    criteria: &str,
    now: i64,
) -> Result<String> {
    let snapshot = format!("snap-{}-r{intent}-s{}", m.goal_id, goal.source_version);
    let inserted = tx.execute(
        "INSERT INTO work_intent_snapshots(snapshot_id,work_id,intent_revision,source_version,title,goal_description,
              constraints_json,criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,goal_sources_json,
              created_by,source_message_id,created_at)
         SELECT ?1,w.work_id,?2,w.source_version,?3,?4,w.constraints_json,?5,w.authorization_json,
                s.expert_snapshot_json,w.input_snapshot_id,w.goal_sources_json,'user',w.source_message_id,?6
         FROM works w JOIN work_intent_snapshots s ON s.snapshot_id=w.active_intent_snapshot_id AND s.work_id=w.work_id
         WHERE w.work_id=?7 AND s.snapshot_id=?8",
        params![snapshot, intent, title, description, criteria, now, m.goal_id, goal.snapshot],
    )?;
    if inserted != 1 {
        return Err("Goal intent snapshot is missing".into());
    }
    tx.execute(
        "UPDATE work_execution_bindings SET invalidated_at=?1,
             status=CASE WHEN status='pending' AND attempt_id IS NULL AND submission_receipt IS NULL THEN 'invalidated' ELSE status END,
             settled_at=CASE WHEN status='pending' AND attempt_id IS NULL AND submission_receipt IS NULL THEN ?1 ELSE settled_at END
         WHERE work_id=?2 AND invalidated_at IS NULL AND status IN ('pending','submitted','running','unknown')",
        params![now, m.goal_id],
    )?;
    tx.execute(
        "UPDATE work_dispatch_requests SET state='cancelled',error=coalesce(error,'requirement_changed') WHERE work_id=?1 AND state='pending'",
        [&m.goal_id],
    )?;
    tx.execute(
        "UPDATE work_deliverables SET status='superseded' WHERE work_id=?1 AND intent_revision<>?2 AND status IN ('proposed','accepted')",
        params![m.goal_id, intent],
    )?;
    Ok(snapshot)
}

fn update_ledger(
    tx: &Connection,
    m: &GoalMutation,
    goal: &Goal,
    intent: i64,
    lifecycle: &str,
    budget: Option<i64>,
    now: i64,
) -> Result<()> {
    let reset = intent != goal.intent_revision;
    let used = if reset { 0 } else { goal.tokens_used };
    let newly_exhausted = m.token_budget.is_some()
        && budget
            .or(m.default_token_budget)
            .is_some_and(|limit| used >= limit);
    let resume =
        goal.lifecycle == "paused" && lifecycle == "active" && goal.ledger_state == "deferred";
    let (state, reason, deferred_at) = if matches!(lifecycle, "closed" | "closing") {
        ("deferred", Some("manual_stop"), Some(now))
    } else if newly_exhausted {
        ("exhausted", Some("budget"), Some(now))
    } else if lifecycle == "paused"
        && (reset || matches!(goal.ledger_state.as_str(), "idle" | "igniting"))
    {
        ("deferred", Some("manual_stop"), Some(now))
    } else if reset || resume {
        ("idle", None, None)
    } else {
        (
            goal.ledger_state.as_str(),
            goal.ledger_reason.as_deref(),
            goal.ledger_deferred_at,
        )
    };
    let changed = tx.execute(
        "UPDATE conversation_goal_continuations SET intent_revision=?1,tokens_budget=?2,tokens_used=?3,state=?4,
            defer_reason=?5,deferred_at=?6,updated_at=?7,
            attempts=CASE WHEN ?8 THEN 0 ELSE attempts END,
            usage_cursor=CASE WHEN ?8 THEN greatest(usage_cursor,(SELECT coalesce(sum(tokens),0)
                FROM conversation_goal_usage_events u WHERE u.task_id=?9)) ELSE usage_cursor END,
            progress_fingerprint=CASE WHEN ?8 OR ?10 THEN NULL ELSE progress_fingerprint END,
            progress_stalls=CASE WHEN ?8 OR ?10 THEN 0 ELSE progress_stalls END,
            run_cursor=CASE WHEN ?8 THEN 0 ELSE run_cursor END
         WHERE task_id=?9 AND work_id=?11 AND intent_revision=?12",
        params![intent, budget, used, state, reason, deferred_at, now, reset, m.task_id, resume, m.goal_id, goal.intent_revision],
    )?;
    if changed != 1 {
        return Err("Goal continuation authority changed during its mutation".into());
    }
    Ok(())
}

fn publish_change(
    tx: &Transaction<'_>,
    m: &GoalMutation,
    operation_id: &str,
    change_id: &str,
    lifecycle: &str,
    conclusion: Option<&str>,
    event: &str,
    intent: i64,
    revision: i64,
    now: i64,
) -> Result<()> {
    let event_id = format!("goal-changed-{change_id}");
    let payload = json!({ "taskId": m.task_id, "workId": m.goal_id, "stateVersion": revision,
        "intentRevision": intent, "ownerEpoch": m.expected_owner_epoch, "lifecycle": lifecycle, "conclusion": conclusion }).to_string();
    tx.execute(
        "INSERT INTO work_events_outbox(event_id,dedupe_key,event_type,work_id,intent_revision,state_version,owner_epoch,request_id,payload_json,created_at)
         VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![event_id, event, m.goal_id, intent, revision, m.expected_owner_epoch, operation_id, payload, now],
    )?;
    append_outbox_group_in_tx(
        tx,
        &OutboxGroupDraft {
            group_id: format!("goal-change:{change_id}"),
            operation_id: operation_id.into(),
            batch_index: 0,
            entity_key: format!("work:{}", m.goal_id),
            entity_revision: Some(revision),
            previous_revision: Some(m.expected_state_version),
            depends_on_group_id: None,
            work_projection_user_id: Some(m.user_id.clone()),
        },
        &[OutboxEventDraft {
            event_id: format!("core:{event_id}"),
            owner_generation: current_core_generation(),
            domain: "work".into(),
            kind: "work.conversationGoalChanged".into(),
            task_id: Some(m.task_id.clone()),
            entity_id: m.goal_id.clone(),
            revision,
            command_id: Some(operation_id.into()),
            payload_json: payload,
        }],
        now,
    )?;
    Ok(())
}
