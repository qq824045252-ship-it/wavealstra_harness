use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDotsBindingInput {
    pub id: String,
    pub connection_key: String,
    pub sender_id: String,
    pub bound_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRouteInput {
    pub scope_id: String,
    pub delivery_key: String,
    pub task_id: String,
    pub kind: String,
    pub accepted_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotsProactiveEnqueueInput {
    pub delivery_key: String,
    pub source: String,
    pub text: String,
    pub queued_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotsReplyObserveInput {
    pub event_key: String,
    pub operation_id: String,
    pub task_id: String,
    pub status: String,
    pub interaction_id: Option<String>,
    pub snapshot: String,
    pub restore_silently_settled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotsObsNextAtInput {
    pub operation_id: String,
    pub next_at: Option<i64>,
    pub only_if_null: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotsDependencyWaitInput {
    pub operation_id: String,
    pub prerequisite_id: String,
    pub title: String,
    pub deadline_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronHoldDotsInput {
    pub job_id: String,
    pub holder: String,
    pub pause: bool,
    pub now: i64,
    pub set_enabled: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronControlScheduleInput {
    pub job_id: String,
    pub action: String, // "holdPause" | "holdRelease" | "setDisabled"
    pub holder: Option<String>,
    pub now: i64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    // ---------- Notifications ----------
    NotificationCleanup {
        cutoff_at: i64,
        max_rows: i64,
    },
    NotificationSaveActivation {
        id: String,
        target_json: String,
        created_at: i64,
    },
    NotificationInsert {
        id: String,
        r#type: String,
        level: String,
        title: String,
        body: Option<String>,
        source_type: String,
        source_id: Option<String>,
        task_id: Option<String>,
        project_id: Option<String>,
        workspace_id: Option<String>,
        dedupe_key: Option<String>,
        created_at: i64,
        read_at: Option<i64>,
        dismissed_at: Option<i64>,
        target_json: Option<String>,
    },
    NotificationMarkRead {
        id: Option<String>,
        dedupe_key: Option<String>,
        all: bool,
        at: i64,
    },
    NotificationDismiss {
        id: Option<String>,
        all: bool,
        at: i64,
    },

    // ---------- Cron ----------
    CronStartupMigrate,
    CronUpsertJob {
        id: String,
        name: String,
        prompt: String,
        schedule_type: String,
        schedule_expr: String,
        timezone: String,
        space_id: Option<String>,
        cwd: Option<String>,
        enabled: i64,
        created_at: i64,
        updated_at: i64,
        last_run_at: Option<i64>,
        permission_mode: Option<String>,
        welcome_mode: Option<String>,
        model_id: Option<String>,
        expert_id: Option<String>,
        skill_ids_json: String,
        connector_ids_json: String,
        effective_from: Option<i64>,
        effective_to: Option<i64>,
        project_id: Option<String>,
        execution_json: String,
    },
    CronSetEnabled {
        id: String,
        enabled: i64,
        updated_at: i64,
    },
    CronRemoveJob {
        id: String,
    },
    CronInsertRun {
        id: String,
        job_id: String,
        started_at: i64,
        finished_at: Option<i64>,
        status: String,
        error: Option<String>,
        task_id: Option<String>,
    },
    CronRecoverRuns {
        finished_at: i64,
        error: String,
    },
    CronHoldDotsSchedule {
        id: String,
        holder: String,
        pause: bool,
        now: i64,
        set_enabled: Option<i64>,
    },
    CronSaveDotsProvenance {
        job_id: String,
        source: String,
        conversation_id: i64,
        entry_id: i64,
        owner_task_id: Option<String>,
        owner_space_id: Option<String>,
    },
    CronRecordDotsNotice {
        job_id: String,
        occurrence: i64,
    },

    // ---------- Gateway ----------
    GatewayBindConversationSpace {
        task_id: String,
        channel_id: String,
        root_space_id: String,
        root_space_name: String,
        child_space_id: String,
        child_space_name: String,
        child_space_path: String,
        bind_sidebar: bool,
        update_task_space: bool,
        now: i64,
    },
    GatewayUpsertChannel {
        id: String,
        r#type: String,
        name: String,
        config_json: String,
        connected: i64,
        status_text: Option<String>,
    },
    GatewayInsertMessage {
        channel_id: String,
        chat_id: String,
        direction: String,
        sender_id: Option<String>,
        sender_name: Option<String>,
        text: String,
        created_at: i64,
    },
    GatewayEnsureIsolation {
        installed_at: i64,
    },
    GatewayDotsReplace {
        channel_id: String,
        binding: Option<GatewayDotsBindingInput>,
    },
    GatewayDotsAdmit {
        channel_id: String,
        connection_key: String,
        chat_id: String,
        message_id: String,
        binding_id: Option<String>,
    },
    GatewayDotsBindTask {
        task_id: String,
        binding_id: String,
    },
    GatewayReserveConversation {
        scope_id: String,
        delivery_key: String,
        task_id: String,
        route_kind: String,
        accepted_at: i64,
    },
    GatewayRecordWorkTarget {
        target_key: String,
        user_id: String,
        conversation_id: String,
        source_message_id: String,
        channel_id: String,
        channel_type: String,
        connection_key: String,
        chat_id: String,
        sender_id: String,
        target_json: String,
        created_at: i64,
    },
    GatewayDeliveryOp {
        op: String,
        delivery_id: Option<String>,
        platform: Option<String>,
        channel_id: Option<String>,
        account_key: Option<String>,
        chat_id: Option<String>,
        session_key: Option<String>,
        message_id: Option<String>,
        payload_json: Option<String>,
        payload_hash: Option<String>,
        receipt_mode: Option<String>,
        reason: Option<String>,
        reply_text: Option<String>,
        reply_hash: Option<String>,
        operation_id: Option<String>,
        now: i64,
        retention_ms: Option<i64>,
        max_receipts: Option<i64>,
        route: Option<GatewayRouteInput>,
    },

    // ---------- Dots ----------
    DotsDeferredSave {
        id: String,
        conversation_id: i64,
        task_id: String,
        prerequisite_id: String,
        text: String,
    },
    DotsDeferredReserve {
        id: String,
        operation_id: String,
    },
    DotsDeferredAccepted {
        operation_id: String,
    },
    DotsReportSaveText {
        delivery_key: String,
        operation_id: String,
        body: String,
    },
    DotsProactiveEnqueueMany {
        items: Vec<DotsProactiveEnqueueInput>,
    },
    DotsProactiveSetDelivered {
        delivery_key: String,
        message_id: String,
        workspace: Option<String>,
    },
    DotsProactiveSetArchive {
        delivery_key: String,
        archived_at: Option<i64>,
        retry_at: Option<i64>,
    },
    DotsFileWatchCreate {
        id: String,
        task_id: String,
        space_id: String,
        root: String,
        file: String,
        instruction: String,
        source: String,
        baseline: String,
        input_version: String,
    },
    DotsFileWatchUpdate {
        id: Option<String>,
        task_id: Option<String>,
        state: String,
        note: Option<String>,
        input_version: Option<String>,
        resume_paused: bool,
    },
    DotsFileWatchNotice {
        watch_id: String,
        revision: String,
    },
    DotsFollowupSavePlan {
        operation_id: String,
        plan_json: String,
        overwrite: bool,
    },
    DotsFollowupSetCommitBase {
        operation_id: String,
        commit_base: String,
        commit_start_json: String,
    },
    DotsFollowupGoalAccepted {
        operation_id: String,
        plan_json: String,
        task_id: String,
        source_message_id: String,
        now: i64,
        request_json: String,
        goal_id: Option<String>,
    },
    DotsReplyRememberOrigin {
        source: String,
        conversation_id: i64,
        entry_id: i64,
    },
    DotsReplyTrack {
        operation_id: String,
        request_json: String,
    },
    DotsReplyObserve {
        obs: DotsReplyObserveInput,
    },
    DotsReplyObserveActivity {
        event_key: String,
        operation_id: String,
        task_id: String,
        snapshot: String,
    },
    DotsReplyObserveSample {
        previous_event_key: Option<String>,
        event_key: String,
        operation_id: String,
        task_id: String,
        snapshot: String,
    },
    DotsReplySetReply {
        event_key: String,
        reply_json: String,
    },
    DotsReplySettle {
        event_key: String,
        settled: i64,
        expected_snapshot: String,
        new_snapshot: String,
        delivered_activity_at: Option<i64>,
        delete_followup_request: bool,
        operation_id: String,
    },
    DotsDelegationObserveTool {
        task_id: String,
        operation_id: String,
        conversation: String,
        tool_task: i64,
        phase: String,
        at: i64,
        tool: String,
        next_at: Option<i64>,
    },
    DotsDelegationObserveProgress {
        task_id: String,
        operation_id: String,
        identity: String,
        at: i64,
    },
    DotsDelegationSetObservationNextAt {
        updates: Vec<DotsObsNextAtInput>,
    },
    DotsDelegationLink {
        operation_id: String,
        task_id: String,
        source_message_id: String,
        now: i64,
        supersedes: bool,
        request_json: Option<String>,
        goal_id: Option<String>,
        deferred: Option<crate::dots_deferred_data::Reservation>,
    },
    DotsDelegationUpdateCwd {
        seq: Option<i64>,
        operation_id: Option<String>,
        task_id: Option<String>,
        expected_status: Option<String>,
        expected_cwd: Option<String>,
        cwd: String,
        also_observe: Option<DotsReplyObserveInput>,
    },
    DotsDelegationUpdateText {
        seq: i64,
        text: String,
        updated_at: i64,
    },
    DotsDelegationFail {
        task_id: String,
        operation_id: Option<String>,
        reason: String,
        updated_at: i64,
        observations: Vec<DotsReplyObserveInput>,
    },
    DotsDelegationReconcile {
        seq: i64,
        task_id: String,
        operation_id: String,
        expected_updated_at: i64,
        status: String,
        text: String,
        interaction_id: Option<String>,
        files: String,
        updated_at: i64,
        dependency_wait: Option<DotsDependencyWaitInput>,
        verified_commit: Option<String>,
        clear_obs_next_at: bool,
        observation: Option<DotsReplyObserveInput>,
    },
    DotsActionContinuationTarget {
        source: String,
        task_id: String,
        prior_operation_id: Option<String>,
        assignment_quote: Option<String>,
    },
    DotsActionRecordAnswer {
        key: String,
        input_key: String,
        task_id: String,
    },
    DotsActionProactivePause {
        scope: String,
        pause: bool,
        timer_ids_json: Option<String>,
        receipt_key: String,
        receipt_json: String,
        holds: Vec<CronHoldDotsInput>,
    },
    DotsActionFailUndelegatedTask {
        task_id: String,
        updated_at: i64,
    },
    DotsActionSpaceReceipt {
        operation: String,
        space_id: String,
    },
    DotsActionControlReceipt {
        operation_id: String,
        target_task_id: String,
        outcome: String,
        insert_ignore: bool,
    },
    DotsActionControlUpdateOutcome {
        operation_id: String,
        outcome: String,
    },
    DotsActionControlBatchSave {
        id: String,
        selection_json: String,
    },
    DotsActionTargetControl {
        mode: String, // "deleteByOp" | "resume" | "control"
        task_id: String,
        operation_id: Option<String>,
        expected_operation_id: Option<String>,
        state: Option<String>,
        watches_action: Option<String>, // "resume" | "stop" | "pause"
        watches_input_version: Option<String>,
        schedule_ops: Vec<CronControlScheduleInput>,
        receipt_id: Option<String>,
        receipt_outcome: Option<String>,
    },
    DotsReplyStartupSync,
    DotsForegroundHandoff {
        input_id: String,
        data_json: String,
    },
    DotsForegroundLinked {
        input_id: String,
    },
    DotsForegroundFreeze {
        input_id: String,
        policy_json: String,
    },
    DotsForegroundCharge {
        input_id: String,
        policy_json: String,
        call_id: String,
        source: String,
        description: String,
        characters: i64,
        excerpt: Option<String>,
        mark_exhausted: bool,
    },
}

fn observe_reply_in_tx(tx: &Connection, obs: &DotsReplyObserveInput) -> Result<()> {
    tx.execute(
        "INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(event_key) DO UPDATE SET settled=0,snapshot=excluded.snapshot
         WHERE ?7 AND dots_reply_events.settled=1 AND dots_reply_events.reply IS NULL AND dots_reply_events.snapshot=''",
        params![
            obs.event_key,
            obs.operation_id,
            obs.task_id,
            obs.status,
            obs.interaction_id,
            obs.snapshot,
            i64::from(obs.restore_silently_settled)
        ],
    )?;
    Ok(())
}

pub(crate) fn ensure_gateway_space_in_tx(
    tx: &Connection,
    id: &str,
    name: &str,
    parent_id: Option<&str>,
    path: Option<&str>,
    now: i64,
) -> Result<()> {
    let existing_name: Option<String> = tx
        .query_row("SELECT name FROM spaces WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    let final_name = existing_name
        .map(|s| if s.trim().is_empty() { name.to_string() } else { s })
        .unwrap_or_else(|| name.to_string());
    let existing_meta: Option<(Option<String>, i64)> = tx
        .query_row(
            "SELECT parent_id, sort_order FROM spaces WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let sort_order = existing_meta
        .as_ref()
        .map(|(_, so)| *so)
        .unwrap_or_else(|| {
            let max_so: i64 = match parent_id {
                Some(pid) => tx
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), 0) FROM spaces WHERE parent_id=?1",
                        [pid],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
                None => tx
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), 0) FROM spaces WHERE parent_id IS NULL",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
            };
            max_so + 1000
        });
    tx.execute(
        "INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = COALESCE(excluded.path, spaces.path),
           parent_id = COALESCE(spaces.parent_id, excluded.parent_id),
           updated_at = excluded.updated_at",
        params![id, final_name, path, parent_id, sort_order, now],
    )?;
    Ok(())
}

pub fn run(db: &mut Connection, request: Request) -> Result<Value> {
    let tx = db.transaction()?;
    let out = match request {
        // ---------- Notifications ----------
        Request::NotificationCleanup {
            cutoff_at,
            max_rows,
        } => {
            tx.execute(
                "DELETE FROM notification_activation_targets WHERE created_at < ?1",
                [cutoff_at],
            )?;
            tx.execute(
                "DELETE FROM notification_activation_targets WHERE notification_id IN (
                   SELECT notification_id FROM notification_activation_targets ORDER BY created_at DESC LIMIT -1 OFFSET ?1
                 )",
                [max_rows],
            )?;
            tx.execute(
                "DELETE FROM notifications WHERE created_at < ?1",
                [cutoff_at],
            )?;
            tx.execute(
                "DELETE FROM notifications WHERE id IN (
                   SELECT id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET ?1
                 )",
                [max_rows],
            )?;
            json!({ "ok": true })
        }
        Request::NotificationSaveActivation {
            id,
            target_json,
            created_at,
        } => {
            tx.execute(
                "INSERT INTO notification_activation_targets VALUES (?1, ?2, ?3) ON CONFLICT(notification_id) DO UPDATE SET target_json=excluded.target_json, created_at=excluded.created_at",
                params![id, target_json, created_at],
            )?;
            json!({ "ok": true })
        }
        Request::NotificationInsert {
            id,
            r#type,
            level,
            title,
            body,
            source_type,
            source_id,
            task_id,
            project_id,
            workspace_id,
            dedupe_key,
            created_at,
            read_at,
            dismissed_at,
            target_json,
        } => {
            let changes = tx.execute(
                "INSERT INTO notifications (
                   id, type, level, title, body, source_type, source_id,
                   task_id, project_id, workspace_id, dedupe_key,
                   created_at, read_at, dismissed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT DO NOTHING",
                params![
                    id,
                    r#type,
                    level,
                    title,
                    body,
                    source_type,
                    source_id,
                    task_id,
                    project_id,
                    workspace_id,
                    dedupe_key,
                    created_at,
                    read_at,
                    dismissed_at
                ],
            )?;
            if changes > 0 {
                if let Some(tj) = target_json {
                    tx.execute(
                        "INSERT INTO notification_activation_targets VALUES (?1, ?2, ?3)
                         ON CONFLICT(notification_id) DO UPDATE SET target_json=excluded.target_json, created_at=excluded.created_at",
                        params![id, tj, created_at],
                    )?;
                }
            }
            json!({ "inserted": changes > 0 })
        }
        Request::NotificationMarkRead {
            id,
            dedupe_key,
            all,
            at,
        } => {
            let changes = if all {
                tx.execute(
                    "UPDATE notifications SET read_at = ?1 WHERE dismissed_at IS NULL AND read_at IS NULL",
                    [at],
                )?
            } else if let Some(nid) = id {
                tx.execute(
                    "UPDATE notifications SET read_at = COALESCE(read_at, ?1)
                     WHERE id = ?2 AND dismissed_at IS NULL AND read_at IS NULL",
                    params![at, nid],
                )?
            } else if let Some(dk) = dedupe_key {
                tx.execute(
                    "UPDATE notifications SET read_at = COALESCE(read_at, ?1)
                     WHERE dedupe_key = ?2 AND dismissed_at IS NULL AND read_at IS NULL",
                    params![at, dk],
                )?
            } else {
                0
            };
            json!({ "changes": changes })
        }
        Request::NotificationDismiss { id, all, at } => {
            let changes = if all {
                tx.execute(
                    "UPDATE notifications SET dismissed_at = ?1, read_at = COALESCE(read_at, ?1) WHERE dismissed_at IS NULL",
                    [at],
                )?
            } else if let Some(nid) = id {
                tx.execute(
                    "UPDATE notifications SET dismissed_at = ?1, read_at = COALESCE(read_at, ?1)
                     WHERE id = ?2 AND dismissed_at IS NULL",
                    params![at, nid],
                )?
            } else {
                0
            };
            json!({ "changes": changes })
        }

        // ---------- Cron ----------
        Request::CronStartupMigrate => {
            let pauses: Vec<(String, String)> = {
                let mut stmt = tx.prepare("SELECT scope, timer_ids FROM dots_proactive_pauses")?;
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<duckdb::Result<_>>()?
            };
            for (scope, timer_ids_raw) in pauses {
                let Ok(ids) = serde_json::from_str::<Vec<String>>(&timer_ids_raw) else {
                    continue;
                };
                if ids.is_empty() {
                    continue;
                }
                let slots = crate::database::anon_placeholders(ids.len());
                let holder = format!("proactive:{scope}");
                let sql = format!(
                    "INSERT INTO dots_schedule_holds(job_id, holder)
                     SELECT j.id, ? FROM cron_jobs j
                     WHERE j.id IN ({slots}) AND j.enabled=0
                       AND json_extract_string(j.execution_json,'$.cancelledAt') IS NULL
                       AND NOT EXISTS (SELECT 1 FROM dots_schedule_holds h WHERE h.job_id=j.id)
                     ON CONFLICT DO NOTHING"
                );
                let mut p: Vec<&dyn duckdb::ToSql> = vec![&holder];
                for id in &ids {
                    p.push(id);
                }
                tx.execute(&sql, duckdb::params_from_iter(p))?;
            }
            let inputs: Vec<(String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT run_id, request_json FROM cron_run_inputs
                     WHERE json_valid(request_json)
                       AND json_extract_string(request_json, '$.request.welcomeMode') = 'bot'",
                )?;
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<duckdb::Result<_>>()?
            };
            for (run_id, raw) in inputs {
                if let Ok(mut doc) = serde_json::from_str::<Value>(&raw)
                    && let Some(req) = doc.get_mut("request").and_then(Value::as_object_mut)
                {
                    req.insert("welcomeMode".into(), json!("general"));
                    let _ = tx.execute(
                        "UPDATE cron_run_inputs SET request_json = ?1 WHERE run_id = ?2",
                        params![serde_json::to_string(&doc)?, run_id],
                    );
                }
            }
            json!({ "ok": true })
        }
        Request::CronUpsertJob {
            id,
            name,
            prompt,
            schedule_type,
            schedule_expr,
            timezone,
            space_id,
            cwd,
            enabled,
            created_at,
            updated_at,
            last_run_at,
            permission_mode,
            welcome_mode,
            model_id,
            expert_id,
            skill_ids_json,
            connector_ids_json,
            effective_from,
            effective_to,
            project_id,
            execution_json,
        } => {
            tx.execute(
                "INSERT INTO cron_jobs (
                   id, name, prompt, schedule_type, schedule_expr, timezone, space_id, cwd, enabled, created_at,
                   updated_at, last_run_at, permission_mode, welcome_mode, model_id, expert_id, skill_ids_json,
                   connector_ids_json, effective_from, effective_to, project_id, execution_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, prompt=excluded.prompt, schedule_type=excluded.schedule_type,
                   schedule_expr=excluded.schedule_expr, timezone=excluded.timezone, space_id=excluded.space_id,
                   cwd=excluded.cwd, enabled=excluded.enabled, updated_at=excluded.updated_at,
                   last_run_at=excluded.last_run_at, permission_mode=excluded.permission_mode,
                   welcome_mode=excluded.welcome_mode, model_id=excluded.model_id, expert_id=excluded.expert_id,
                   skill_ids_json=excluded.skill_ids_json, connector_ids_json=excluded.connector_ids_json,
                   effective_from=excluded.effective_from, effective_to=excluded.effective_to,
                   project_id=excluded.project_id, execution_json=excluded.execution_json",
                params![
                    id, name, prompt, schedule_type, schedule_expr, timezone, space_id, cwd, enabled, created_at,
                    updated_at, last_run_at, permission_mode, welcome_mode, model_id, expert_id, skill_ids_json,
                    connector_ids_json, effective_from, effective_to, project_id, execution_json
                ],
            )?;
            json!({ "ok": true })
        }
        Request::CronSetEnabled {
            id,
            enabled,
            updated_at,
        } => {
            tx.execute(
                "UPDATE cron_jobs SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                params![enabled, updated_at, id],
            )?;
            json!({ "ok": true })
        }
        Request::CronRemoveJob { id } => {
            crate::cron_plan::remove_plan(&tx, &id)?;
            json!({ "ok": true })
        }
        Request::CronInsertRun {
            id,
            job_id,
            started_at,
            finished_at,
            status,
            error,
            task_id,
        } => {
            tx.execute(
                "INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, job_id, started_at, finished_at, status, error, task_id],
            )?;
            json!({ "ok": true })
        }
        Request::CronRecoverRuns { finished_at, error } => {
            tx.execute(
                "UPDATE cron_runs SET status = 'error', finished_at = ?1, error = ?2 WHERE status = 'running'",
                params![finished_at, error],
            )?;
            json!({ "ok": true })
        }
        Request::CronHoldDotsSchedule {
            id,
            holder,
            pause,
            now,
            set_enabled,
        } => {
            if pause {
                tx.execute(
                    "INSERT INTO dots_schedule_holds VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                    params![id, holder],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM dots_schedule_holds WHERE job_id=?1 AND holder=?2",
                    params![id, holder],
                )?;
            }
            if let Some(enabled) = set_enabled {
                tx.execute(
                    "UPDATE cron_jobs SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                    params![enabled, now, id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::CronSaveDotsProvenance {
            job_id,
            source,
            conversation_id,
            entry_id,
            owner_task_id,
            owner_space_id,
        } => {
            tx.execute(
                "INSERT INTO dots_schedule_origins VALUES(?1, ?2, ?3, ?4)",
                params![job_id, source, conversation_id, entry_id],
            )?;
            if owner_task_id.is_some() || owner_space_id.is_some() {
                tx.execute(
                    "INSERT INTO dots_schedule_scopes VALUES(?1, ?2, ?3)",
                    params![job_id, owner_task_id, owner_space_id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::CronRecordDotsNotice { job_id, occurrence } => {
            let changes = tx.execute(
                "INSERT INTO dots_schedule_notices VALUES(?1, ?2) ON CONFLICT(job_id)
                 DO UPDATE SET occurrence=excluded.occurrence WHERE occurrence<excluded.occurrence",
                params![job_id, occurrence],
            )?;
            json!({ "changed": changes > 0 })
        }

        // ---------- Gateway ----------
        Request::GatewayBindConversationSpace {
            task_id,
            channel_id,
            root_space_id,
            root_space_name,
            child_space_id,
            child_space_name,
            child_space_path,
            bind_sidebar,
            update_task_space,
            now,
        } => {
            ensure_gateway_space_in_tx(&tx, &root_space_id, &root_space_name, None, None, now)?;
            ensure_gateway_space_in_tx(
                &tx,
                &child_space_id,
                &child_space_name,
                Some(&root_space_id),
                Some(&child_space_path),
                now,
            )?;
            if bind_sidebar {
                tx.execute(
                    "INSERT INTO gateway_sidebar_conversations(task_id,channel_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                    params![task_id, channel_id],
                )?;
            }
            if update_task_space {
                tx.execute(
                    "UPDATE tasks SET space_id = ?1, space_sort_order = 0 WHERE id = ?2",
                    params![child_space_id, task_id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::GatewayUpsertChannel {
            id,
            r#type,
            name,
            config_json,
            connected,
            status_text,
        } => {
            tx.execute(
                "INSERT INTO gateway_channels (id, type, name, config_json, connected, status_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   type=excluded.type, name=excluded.name, config_json=excluded.config_json,
                   connected=excluded.connected, status_text=excluded.status_text",
                params![id, r#type, name, config_json, connected, status_text],
            )?;
            crate::gateway_channel_data::bump_revision(&tx, &id)?;
            json!({ "ok": true })
        }
        Request::GatewayInsertMessage {
            channel_id,
            chat_id,
            direction,
            sender_id,
            sender_name,
            text,
            created_at,
        } => {
            tx.execute(
                "INSERT INTO gateway_messages (channel_id, chat_id, direction, sender_id, sender_name, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![channel_id, chat_id, direction, sender_id, sender_name, text, created_at],
            )?;
            tx.execute(
                "DELETE FROM gateway_messages WHERE id NOT IN (
                   SELECT id FROM gateway_messages ORDER BY created_at DESC, id DESC LIMIT 3000
                 )",
                [],
            )?;
            json!({ "ok": true })
        }
        Request::GatewayEnsureIsolation { installed_at } => {
            tx.execute(
                "INSERT INTO gateway_memory_isolation VALUES(1, ?1) ON CONFLICT DO NOTHING",
                [installed_at],
            )?;
            json!({ "ok": true })
        }
        Request::GatewayDotsReplace {
            channel_id,
            binding,
        } => {
            tx.execute(
                "UPDATE gateway_dots_bindings SET active=0 WHERE channel_id=?1 AND active=1",
                [&channel_id],
            )?;
            if let Some(b) = binding {
                tx.execute(
                    "INSERT INTO gateway_dots_bindings VALUES(?1, ?2, ?3, ?4, 1, ?5)",
                    params![b.id, channel_id, b.connection_key, b.sender_id, b.bound_at],
                )?;
            }
            json!({ "ok": true })
        }
        Request::GatewayDotsAdmit {
            channel_id,
            connection_key,
            chat_id,
            message_id,
            binding_id,
        } => {
            tx.execute(
                "INSERT INTO gateway_dots_admissions VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                params![channel_id, connection_key, chat_id, message_id, binding_id],
            )?;
            json!({ "ok": true })
        }
        Request::GatewayDotsBindTask {
            task_id,
            binding_id,
        } => {
            tx.execute(
                "INSERT INTO gateway_dots_tasks VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                params![task_id, binding_id],
            )?;
            json!({ "ok": true })
        }
        Request::GatewayReserveConversation {
            scope_id,
            delivery_key,
            task_id,
            route_kind,
            accepted_at,
        } => {
            crate::gateway_admission::write_route(&tx, &scope_id, &delivery_key, &task_id, &route_kind, accepted_at)?;
            json!({ "ok": true })
        }
        Request::GatewayRecordWorkTarget {
            target_key,
            user_id,
            conversation_id,
            source_message_id,
            channel_id,
            channel_type,
            connection_key,
            chat_id,
            sender_id,
            target_json,
            created_at,
        } => {
            tx.execute(
                "INSERT INTO gateway_work_targets
                 (target_key,user_id,conversation_id,source_message_id,channel_id,channel_type,connection_key,chat_id,sender_id,target_json,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT DO NOTHING",
                params![
                    target_key, user_id, conversation_id, source_message_id, channel_id,
                    channel_type, connection_key, chat_id, sender_id, target_json, created_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::GatewayDeliveryOp {
            op,
            delivery_id,
            platform,
            channel_id,
            account_key,
            chat_id,
            session_key,
            message_id,
            payload_json,
            payload_hash,
            receipt_mode,
            reason,
            reply_text,
            reply_hash,
            operation_id,
            now,
            retention_ms,
            max_receipts,
            route,
        } => {
            match op.as_str() {
                "enqueue" => {
                    if let (Some(ret), Some(max_r)) = (retention_ms, max_receipts) {
                        tx.execute(
                            "DELETE FROM gateway_inbox WHERE status='completed' AND updated_at<?1",
                            [now - ret],
                        )?;
                        let count: i64 = tx.query_row(
                            "SELECT COUNT(*) FROM gateway_inbox WHERE status='completed'",
                            [],
                            |r| r.get(0),
                        )?;
                        if count >= max_r {
                            tx.execute(
                                "DELETE FROM gateway_inbox WHERE delivery_id IN (
                                   SELECT delivery_id FROM gateway_inbox WHERE status='completed' ORDER BY updated_at,delivery_id LIMIT ?1
                                 )",
                                [count - max_r + 1],
                            )?;
                        }
                    }
                    let did = delivery_id.ok_or("missing delivery_id")?;
                    tx.execute(
                        "INSERT INTO gateway_inbox (delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,
                           payload_json,payload_hash,status,retry_count,receipt_mode,created_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',0,?10,?11,?11)",
                        params![
                            did,
                            platform.unwrap_or_default(),
                            channel_id.unwrap_or_default(),
                            account_key.unwrap_or_default(),
                            chat_id.unwrap_or_default(),
                            session_key.unwrap_or_default(),
                            message_id.unwrap_or_default(),
                            payload_json.unwrap_or_default(),
                            payload_hash.unwrap_or_default(),
                            receipt_mode.unwrap_or_else(|| "none".to_string()),
                            now
                        ],
                    )?;
                    if let Some(r) = route {
                        crate::gateway_admission::write_route(&tx, &r.scope_id, &r.delivery_key, &r.task_id, &r.kind, r.accepted_at)?;
                    }
                }
                "continueReply" => {
                    let did = delivery_id.ok_or("missing delivery_id")?;
                    let rt = reply_text.ok_or("missing reply_text")?;
                    let rh = reply_hash.ok_or("missing reply_hash")?;
                    let oid = operation_id.ok_or("missing operation_id")?;
                    tx.execute(
                        "INSERT INTO gateway_inbox(delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,
                           payload_json,payload_hash,status,retry_count,receipt_mode,created_at,updated_at)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'reply_pending',0,'none',?10,?10)",
                        params![
                            did,
                            platform.unwrap_or_default(),
                            channel_id.unwrap_or_default(),
                            account_key.unwrap_or_default(),
                            chat_id.unwrap_or_default(),
                            session_key.unwrap_or_default(),
                            message_id.unwrap_or_default(),
                            payload_json.unwrap_or_default(),
                            payload_hash.unwrap_or_default(),
                            now
                        ],
                    )?;
                    tx.execute(
                        "INSERT INTO gateway_outbox (delivery_id,reply_text,reply_hash,status,created_at,updated_at)
                         VALUES (?1,?2,?3,'pending',?4,?4)",
                        params![did, rt, rh, now],
                    )?;
                    tx.execute(
                        "UPDATE gateway_inbox SET status='reply_pending',last_error=NULL,updated_at=?1 WHERE delivery_id=?2",
                        params![now, did],
                    )?;
                    tx.execute(
                        "INSERT INTO bot_gateway_continuations VALUES(?1,?2) ON CONFLICT DO NOTHING",
                        params![did, oid],
                    )?;
                }
                "recoverInterrupted" => {
                    crate::gateway_delivery_control::recover_interrupted(&tx, &crate::business_protocol::current_core_generation(), now)?;
                }
                "blockUnclaimed" => {
                    let did = delivery_id.ok_or("missing delivery_id")?;
                    tx.execute(
                        "UPDATE gateway_inbox i SET status='blocked',last_error=?2,updated_at=?3
                         WHERE i.delivery_id=?1 AND i.status IN ('pending','blocked','reply_pending')
                           AND NOT EXISTS (SELECT 1 FROM gateway_outbox o
                               WHERE o.delivery_id=i.delivery_id AND o.status NOT IN ('pending','blocked'))",
                        params![did, reason.unwrap_or_default(), now],
                    )?;
                }
                other => return Err(format!("unknown gatewayDeliveryOp: {other}").into()),
            }
            json!({ "ok": true })
        }

        // ---------- Dots ----------
        Request::DotsDeferredSave {
            id,
            conversation_id,
            task_id,
            prerequisite_id,
            text,
        } => {
            tx.execute(
                "INSERT INTO dots_deferred_requirements (id,conversationId,taskId,prerequisiteId,text) VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
                params![id, conversation_id, task_id, prerequisite_id, text],
            )?;
            json!({ "ok": true })
        }
        Request::DotsDeferredReserve { id, operation_id } => {
            let changes = tx.execute(
                "UPDATE dots_deferred_requirements SET operationId=?1 WHERE id=?2 AND
                 (operationId=?1 OR (applied=0 AND (operationId IS NULL OR EXISTS
                 (SELECT 1 FROM dots_delegations d WHERE d.operation_id=dots_deferred_requirements.operationId AND d.status='failed'))))",
                params![operation_id, id],
            )?;
            if changes == 0 {
                return Err("这条待办已关联其他交办，请核对原任务。".into());
            }
            json!({ "ok": true })
        }
        Request::DotsDeferredAccepted { operation_id } => {
            tx.execute(
                "UPDATE dots_deferred_requirements SET applied=1 WHERE operationId=?1 AND applied=0",
                [operation_id],
            )?;
            json!({ "ok": true })
        }
        Request::DotsReportSaveText {
            delivery_key,
            operation_id,
            body,
        } => {
            tx.execute(
                "INSERT INTO dots_report_text VALUES(?1, ?2, ?3) ON CONFLICT DO NOTHING",
                params![delivery_key, operation_id, body],
            )?;
            let (owner, text): (String, String) = tx.query_row("SELECT operation_id,text FROM dots_report_text WHERE delivery_key=?",
                [delivery_key], |row| Ok((row.get(0)?,row.get(1)?)))?;
            if owner != operation_id { return Err("Dots 回报键已被另一委派占用".into()); }
            json!({ "ok": true, "text": text })
        }
        Request::DotsProactiveEnqueueMany { items } => {
            for item in items {
                tx.execute(
                    "INSERT INTO dots_proactive_delivery(delivery_key,source,text,queued_at) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                    params![item.delivery_key, item.source, item.text, item.queued_at],
                )?;
            }
            json!({ "ok": true })
        }
        Request::DotsProactiveSetDelivered {
            delivery_key,
            message_id,
            workspace,
        } => {
            tx.execute(
                "UPDATE dots_proactive_delivery SET message_id=?1,workspace=?2 WHERE delivery_key=?3",
                params![message_id, workspace, delivery_key],
            )?;
            json!({ "ok": true })
        }
        Request::DotsProactiveSetArchive {
            delivery_key,
            archived_at,
            retry_at,
        } => {
            if let Some(at) = archived_at {
                tx.execute(
                    "UPDATE dots_proactive_delivery SET archived_at=?1 WHERE delivery_key=?2",
                    params![at, delivery_key],
                )?;
            } else if let Some(rt) = retry_at {
                tx.execute(
                    "UPDATE dots_proactive_delivery SET archive_retry_at=?1 WHERE delivery_key=?2",
                    params![rt, delivery_key],
                )?;
            }
            json!({ "ok": true })
        }
        Request::DotsFileWatchCreate {
            id,
            task_id,
            space_id,
            root,
            file,
            instruction,
            source,
            baseline,
            input_version,
        } => {
            tx.execute(
                "INSERT INTO dots_file_watches
                 (id,task_id,space_id,root,file,instruction,source,baseline,input_version,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'watching') ON CONFLICT DO NOTHING",
                params![id, task_id, space_id, root, file, instruction, source, baseline, input_version],
            )?;
            json!({ "ok": true })
        }
        Request::DotsFileWatchUpdate {
            id,
            task_id,
            state,
            note,
            input_version,
            resume_paused,
        } => {
            let changes = if resume_paused {
                let tid = task_id.ok_or("missing task_id")?;
                let ver = input_version.ok_or("missing input_version")?;
                tx.execute(
                    "UPDATE dots_file_watches SET state='watching',note='',input_version=?1 WHERE task_id=?2 AND state='paused'",
                    params![ver, tid],
                )?
            } else {
                let wid = id.ok_or("missing watch id")?;
                let note_val = note.unwrap_or_default();
                tx.execute(
                    "UPDATE dots_file_watches SET state=?1, note=?2 WHERE id=?3 AND (state<>?1 OR note<>?2)",
                    params![state, note_val, wid],
                )?
            };
            json!({ "changes": changes })
        }
        Request::DotsFileWatchNotice { watch_id, revision } => {
            let changes = tx.execute(
                "INSERT INTO dots_file_watch_notices VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                params![watch_id, revision],
            )?;
            json!({ "changed": changes > 0 })
        }
        Request::DotsFollowupSavePlan {
            operation_id,
            plan_json,
            overwrite,
        } => {
            if overwrite {
                tx.execute(
                    "UPDATE dots_followup_plans SET plan=?1 WHERE operation_id=?2",
                    params![plan_json, operation_id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO dots_followup_plans VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                    params![operation_id, plan_json],
                )?;
            }
            json!({ "ok": true })
        }
        Request::DotsFollowupSetCommitBase {
            operation_id,
            commit_base,
            commit_start_json,
        } => {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT plan FROM dots_followup_plans WHERE operation_id=?1",
                    [&operation_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(raw) = existing {
                let doc: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
                if doc.get("commitBase").is_none_or(Value::is_null) {
                    let start_val: Value =
                        serde_json::from_str(&commit_start_json).unwrap_or(Value::Null);
                    let patched = crate::database::patch_json_fields(
                        &raw,
                        &[("commitBase", json!(commit_base)), ("commitStart", start_val)],
                    );
                    tx.execute(
                        "UPDATE dots_followup_plans SET plan=?1 WHERE operation_id=?2",
                        params![patched, operation_id],
                    )?;
                }
            }
            json!({ "ok": true })
        }
        Request::DotsFollowupGoalAccepted {
            operation_id,
            plan_json,
            task_id,
            source_message_id,
            now,
            request_json,
            goal_id,
        } => {
            tx.execute(
                "INSERT INTO dots_followup_plans VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                params![operation_id, plan_json],
            )?;
            crate::dots_delegation_data::link(&tx, crate::dots_delegation_data::Link {
                operation_id: &operation_id, task_id: &task_id, source_message_id: &source_message_id,
                now, supersedes: false, request_json: Some(&request_json), goal_id: goal_id.as_deref(),
            })?;
            json!({ "ok": true })
        }
        Request::DotsReplyRememberOrigin {
            source,
            conversation_id,
            entry_id,
        } => {
            tx.execute(
                "INSERT INTO dots_reply_origins VALUES(?1, ?2, ?3) ON CONFLICT DO NOTHING",
                params![source, conversation_id, entry_id],
            )?;
            let matched: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_reply_origins WHERE source=?1 AND conversation=?2 AND entry=?3)",
                params![source, conversation_id, entry_id],
                |r| r.get(0),
            )?;
            if !matched {
                return Err("原始 Dots 消息归属冲突".into());
            }
            json!({ "ok": true })
        }
        Request::DotsReplyTrack {
            operation_id,
            request_json,
        } => {
            tx.execute(
                "INSERT INTO dots_followup_requests VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                params![operation_id, request_json],
            )?;
            json!({ "ok": true })
        }
        Request::DotsReplyObserve { obs } => {
            observe_reply_in_tx(&tx, &obs)?;
            json!({ "ok": true })
        }
        Request::DotsReplyObserveActivity {
            event_key,
            operation_id,
            task_id,
            snapshot,
        } => {
            let active_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_reply_events WHERE operation_id=?1 AND status='activity' AND settled=0)",
                [&operation_id],
                |r| r.get(0),
            )?;
            let changes = if active_exists {
                0
            } else {
                tx.execute(
                    "INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot)
                     VALUES(?1,?2,?3,'activity',NULL,?4) ON CONFLICT DO NOTHING",
                    params![event_key, operation_id, task_id, snapshot],
                )?
            };
            json!({ "changed": changes > 0 })
        }
        Request::DotsReplyObserveSample {
            previous_event_key,
            event_key,
            operation_id,
            task_id,
            snapshot,
        } => {
            if let Some(prev) = previous_event_key {
                tx.execute(
                    "UPDATE dots_reply_events SET settled=1,snapshot='' WHERE event_key=?1",
                    [prev],
                )?;
            }
            tx.execute(
                "INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot)
                 VALUES(?1,?2,?3,'sample',NULL,?4)",
                params![event_key, operation_id, task_id, snapshot],
            )?;
            json!({ "ok": true })
        }
        Request::DotsReplySetReply {
            event_key,
            reply_json,
        } => {
            tx.execute(
                "UPDATE dots_reply_events SET reply=?1 WHERE event_key=?2 AND settled=0 AND reply IS NULL",
                params![reply_json, event_key],
            )?;
            json!({ "ok": true })
        }
        Request::DotsReplySettle {
            event_key,
            settled,
            expected_snapshot,
            new_snapshot,
            delivered_activity_at,
            delete_followup_request,
            operation_id,
        } => {
            let changes = tx.execute(
                "UPDATE dots_reply_events SET settled=1,reply=NULL,snapshot=?1 WHERE event_key=?2 AND settled=?3 AND snapshot=?4",
                params![new_snapshot, event_key, settled, expected_snapshot],
            )?;
            if changes > 0 {
                if let Some(at) = delivered_activity_at {
                    tx.execute(
                        "UPDATE dots_tool_observations SET last_report_at=?1 WHERE operation_id=?2",
                        params![at, operation_id],
                    )?;
                }
                if delete_followup_request {
                    tx.execute(
                        "DELETE FROM dots_followup_requests WHERE operation_id=?1",
                        [&operation_id],
                    )?;
                }
            }
            json!({ "changed": changes > 0 })
        }
        Request::DotsDelegationObserveTool {
            task_id,
            operation_id,
            conversation,
            tool_task,
            phase,
            at,
            tool,
            next_at,
        } => {
            let receipt_changes = tx.execute(
                "INSERT INTO dots_tool_observation_receipts SELECT operation_id,?2,?3,?4 FROM dots_delegations
                 WHERE operation_id=?1 AND task_id=?5 AND status IN ('pending','running') ON CONFLICT DO NOTHING",
                params![operation_id, conversation, tool_task, phase, task_id],
            )?;
            if receipt_changes > 0 {
                tx.execute(
                    "INSERT INTO dots_tool_observations(operation_id,\"at\",tool,phase,next_at) VALUES(?1,?2,?3,?4,?5)
                     ON CONFLICT(operation_id) DO UPDATE SET \"at\"=excluded.\"at\",tool=excluded.tool,phase=excluded.phase
                     WHERE excluded.\"at\">=dots_tool_observations.\"at\"",
                    params![operation_id, at, tool, phase, next_at],
                )?;
            }
            json!({ "changed": receipt_changes > 0 })
        }
        Request::DotsDelegationObserveProgress {
            task_id,
            operation_id,
            identity,
            at,
        } => {
            let changes = tx.execute(
                "INSERT INTO dots_verified_progress(operation_id,identity,\"at\")
                 SELECT operation_id,?1,?2 FROM dots_delegations WHERE task_id=?3 AND operation_id=?4
                 AND status IN ('pending','running','blocked','completed') ON CONFLICT DO NOTHING",
                params![identity, at, task_id, operation_id],
            )?;
            json!({ "changed": changes > 0 })
        }
        Request::DotsDelegationSetObservationNextAt { updates } => {
            for u in updates {
                if u.only_if_null {
                    tx.execute(
                        "UPDATE dots_tool_observations SET next_at=?1 WHERE operation_id=?2 AND next_at IS NULL",
                        params![u.next_at, u.operation_id],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE dots_tool_observations SET next_at=?1 WHERE operation_id=?2",
                        params![u.next_at, u.operation_id],
                    )?;
                }
            }
            json!({ "ok": true })
        }
        Request::DotsDelegationLink {
            operation_id,
            task_id,
            source_message_id,
            now,
            supersedes,
            request_json,
            goal_id,
            deferred,
        } => {
            let inserted = crate::dots_delegation_data::link(&tx, crate::dots_delegation_data::Link {
                operation_id: &operation_id, task_id: &task_id, source_message_id: &source_message_id,
                now, supersedes, request_json: request_json.as_deref(), goal_id: goal_id.as_deref(),
            })?;
            if let Some(reservation) = deferred {
                crate::dots_deferred_data::reserve_in_transaction(&tx, &reservation, &task_id, &operation_id, &source_message_id)?;
            }
            json!({ "inserted": inserted })
        }
        Request::DotsDelegationUpdateCwd {
            seq,
            operation_id,
            task_id,
            expected_status,
            expected_cwd,
            cwd,
            also_observe,
        } => {
            let changes = if let (Some(s), Some(st), Some(ecwd)) = (seq, expected_status, expected_cwd) {
                tx.execute(
                    "UPDATE dots_delegations SET cwd=?1 WHERE seq=?2 AND status=?3 AND cwd IS NULL
                     AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=dots_delegations.task_id AND t.cwd=?4)",
                    params![cwd, s, st, ecwd],
                )?
            } else if let (Some(oid), Some(tid)) = (operation_id, task_id) {
                tx.execute(
                    "UPDATE dots_delegations SET cwd=?1 WHERE operation_id=?2 AND task_id=?3 AND status='pending' AND cwd IS NULL",
                    params![cwd, oid, tid],
                )?
            } else {
                0
            };
            if changes > 0 {
                if let Some(obs) = also_observe {
                    observe_reply_in_tx(&tx, &obs)?;
                }
            }
            json!({ "changes": changes })
        }
        Request::DotsDelegationUpdateText {
            seq,
            text,
            updated_at,
        } => {
            let changes = tx.execute(
                "UPDATE dots_delegations SET text=?1,updated_at=?2 WHERE seq=?3 AND text<>?1",
                params![text, updated_at, seq],
            )?;
            json!({ "changes": changes })
        }
        Request::DotsDelegationFail {
            task_id,
            operation_id,
            reason,
            updated_at,
            observations,
        } => {
            let changes = if let Some(oid) = operation_id {
                tx.execute(
                    "UPDATE dots_delegations SET status='failed',text=?1,request_json=NULL,updated_at=?2
                     WHERE task_id=?3 AND operation_id=?4 AND status='pending'",
                    params![reason, updated_at, task_id, oid],
                )?
            } else {
                tx.execute(
                    "UPDATE dots_delegations SET status='failed',text=?1,interaction_id=NULL,request_json=NULL,updated_at=?2
                     WHERE task_id=?3 AND status IN ('pending','running','blocked')",
                    params![reason, updated_at, task_id],
                )?
            };
            if changes > 0 {
                for obs in observations {
                    observe_reply_in_tx(&tx, &obs)?;
                }
            }
            json!({ "changes": changes })
        }
        Request::DotsDelegationReconcile {
            seq,
            task_id,
            operation_id,
            expected_updated_at,
            status,
            text,
            interaction_id,
            files,
            updated_at,
            dependency_wait,
            verified_commit,
            clear_obs_next_at,
            observation,
        } => {
            let basis = crate::dots_delegation_data::reconcile_basis(&tx, seq, &task_id, &operation_id)?;
            let stale_snapshot = basis.is_some_and(|(current, _, _)| current != expected_updated_at);
            let updated_at = updated_at.max(expected_updated_at.saturating_add(1));
            let changes = if basis.is_some() && !stale_snapshot { tx.execute(
                "UPDATE dots_delegations SET status=?1,text=?2,interaction_id=?3,files=?4,request_json=NULL,updated_at=?5
                 WHERE seq=?6 AND task_id=?7 AND operation_id=?8 AND updated_at=?9 AND status IN ('pending','running','blocked')
                   AND (status<>?1 OR interaction_id IS DISTINCT FROM ?3 OR text<>?2 OR files<>?4)",
                params![status, text, interaction_id, files, updated_at, seq, task_id, operation_id, expected_updated_at],
            )? } else { 0 };
            if changes > 0 {
                if let Some(dw) = dependency_wait {
                    if dw.operation_id != operation_id { return Err("Dots prerequisite has a different operation".into()); }
                    tx.execute(
                        "INSERT INTO dots_dependency_waits VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                        params![dw.operation_id, dw.prerequisite_id, dw.title, dw.deadline_at],
                    )?;
                }
                if let Some(sha) = verified_commit {
                    tx.execute(
                        "INSERT INTO dots_verified_commits VALUES(?1,?2) ON CONFLICT DO NOTHING",
                        params![operation_id, sha],
                    )?;
                }
                if let Some(obs) = observation {
                    if obs.operation_id != operation_id || obs.task_id != task_id || obs.status != status
                        || obs.interaction_id != interaction_id {
                        return Err("Dots observation does not match the reconciled result".into());
                    }
                    observe_reply_in_tx(&tx, &obs)?;
                }
                if clear_obs_next_at {
                    tx.execute(
                        "UPDATE dots_tool_observations SET next_at=NULL WHERE operation_id=?1",
                        [&operation_id],
                    )?;
                }
                if let Some((_, created_at, true)) = basis {
                    tx.execute(
                        "UPDATE dots_delegations SET status='superseded',interaction_id=NULL,request_json=NULL,updated_at=?1
                         WHERE task_id=?2 AND seq<?3 AND (status IN ('pending','running','blocked') OR (status='completed' AND updated_at>=?4))",
                        params![updated_at, task_id, seq, created_at],
                    )?;
                }
            }
            json!({ "changed": changes > 0, "staleSnapshot": stale_snapshot })
        }
        Request::DotsActionContinuationTarget {
            source,
            task_id,
            prior_operation_id,
            assignment_quote,
        } => {
            tx.execute(
                "INSERT INTO dots_continuation_targets VALUES(?1,?2,?3,?4)
                 ON CONFLICT(source,task_id) DO UPDATE SET assignment_quote=COALESCE(assignment_quote,excluded.assignment_quote)",
                params![source, task_id, prior_operation_id, assignment_quote],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionRecordAnswer {
            key,
            input_key,
            task_id,
        } => {
            tx.execute(
                "INSERT INTO dots_control_receipts VALUES(?1, ?2, 'answered') ON CONFLICT DO NOTHING",
                params![key, task_id],
            )?;
            tx.execute(
                "INSERT INTO dots_control_receipts VALUES(?1, ?2, 'answered') ON CONFLICT DO NOTHING",
                params![input_key, task_id],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionProactivePause {
            scope,
            pause,
            timer_ids_json,
            receipt_key,
            receipt_json,
            holds,
        } => {
            if pause {
                tx.execute(
                    "INSERT INTO dots_proactive_pauses VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                    params![scope, timer_ids_json.unwrap_or_else(|| "[]".to_string())],
                )?;
            } else {
                tx.execute("DELETE FROM dots_proactive_pauses WHERE scope=?1", [&scope])?;
            }
            for h in holds {
                if h.pause {
                    tx.execute(
                        "INSERT INTO dots_schedule_holds VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                        params![h.job_id, h.holder],
                    )?;
                } else {
                    tx.execute(
                        "DELETE FROM dots_schedule_holds WHERE job_id=?1 AND holder=?2",
                        params![h.job_id, h.holder],
                    )?;
                }
                if let Some(enabled) = h.set_enabled {
                    tx.execute(
                        "UPDATE cron_jobs SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                        params![enabled, h.now, h.job_id],
                    )?;
                }
            }
            tx.execute(
                "INSERT INTO dots_control_receipts VALUES(?1, 'dots-assistant', ?2) ON CONFLICT DO NOTHING",
                params![receipt_key, receipt_json],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionFailUndelegatedTask {
            task_id,
            updated_at,
        } => {
            let changes = tx.execute(
                "UPDATE tasks SET status='failed',updated_at=?1 WHERE id=?2 AND (status IS NULL OR status IN ('planning','pending'))",
                params![updated_at, task_id],
            )?;
            json!({ "changes": changes })
        }
        Request::DotsActionSpaceReceipt {
            operation,
            space_id,
        } => {
            tx.execute(
                "INSERT INTO dots_control_receipts VALUES(?1, ?2, 'space_changed') ON CONFLICT DO NOTHING",
                params![operation, space_id],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionControlReceipt {
            operation_id,
            target_task_id,
            outcome,
            insert_ignore,
        } => {
            if insert_ignore {
                tx.execute(
                    "INSERT INTO dots_control_receipts VALUES(?1, ?2, ?3) ON CONFLICT DO NOTHING",
                    params![operation_id, target_task_id, outcome],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO dots_control_receipts VALUES(?1, ?2, ?3)",
                    params![operation_id, target_task_id, outcome],
                )?;
            }
            json!({ "ok": true })
        }
        Request::DotsActionControlUpdateOutcome {
            operation_id,
            outcome,
        } => {
            tx.execute(
                "UPDATE dots_control_receipts SET outcome=?1 WHERE operation_id=?2",
                params![outcome, operation_id],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionControlBatchSave { id, selection_json } => {
            tx.execute(
                "INSERT INTO dots_control_batches VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                params![id, selection_json],
            )?;
            json!({ "ok": true })
        }
        Request::DotsActionTargetControl {
            mode,
            task_id,
            operation_id,
            expected_operation_id,
            state,
            watches_action,
            watches_input_version,
            schedule_ops,
            receipt_id,
            receipt_outcome,
        } => {
            match mode.as_str() {
                "deleteByOp" => {
                    let op = operation_id.ok_or("missing operation_id")?;
                    let changes = tx.execute(
                        "DELETE FROM dots_target_controls WHERE task_id=?1 AND operation_id=?2",
                        params![task_id, op],
                    )?;
                    if changes > 0 {
                        if let Some(wa) = watches_action.as_deref() {
                            if wa == "resume" {
                                let ver = watches_input_version.unwrap_or_default();
                                tx.execute(
                                    "UPDATE dots_file_watches SET state='watching',note='',input_version=?1 WHERE task_id=?2 AND state='paused'",
                                    params![ver, task_id],
                                )?;
                            } else if wa == "stop" {
                                tx.execute(
                                    "UPDATE dots_file_watches SET state='cancelled', note='原事项已停止'
                                     WHERE task_id=?1 AND state IN ('watching','sending','paused') AND (state<>'cancelled' OR note<>'原事项已停止')",
                                    [&task_id],
                                )?;
                            }
                        }
                        for sop in schedule_ops {
                            if sop.action == "holdRelease" {
                                if let Some(holder) = sop.holder {
                                    let del = tx.execute(
                                        "DELETE FROM dots_schedule_holds WHERE job_id=?1 AND holder=?2",
                                        params![sop.job_id, holder],
                                    )?;
                                    if del > 0 {
                                        tx.execute(
                                            "UPDATE cron_jobs SET enabled=1,updated_at=?1 WHERE id=?2",
                                            params![sop.now, sop.job_id],
                                        )?;
                                    }
                                }
                            }
                        }
                    }
                    json!({ "changes": changes })
                }
                "resume" => {
                    let rid = receipt_id.ok_or("missing receipt_id")?;
                    let rout = receipt_outcome.ok_or("missing receipt_outcome")?;
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM dots_control_receipts WHERE operation_id=?1 AND target_task_id=?2 AND outcome=?3)",
                        params![rid, task_id, rout],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        let current_ctrl_op: Option<String> = tx
                            .query_row(
                                "SELECT operation_id FROM dots_target_controls WHERE task_id=?1",
                                [&task_id],
                                |r| r.get(0),
                            )
                            .optional()?;
                        if current_ctrl_op != expected_operation_id {
                            return Err("恢复期间事项已变化，请查询原任务".into());
                        }
                        tx.execute(
                            "DELETE FROM dots_target_controls WHERE task_id=?1",
                            [&task_id],
                        )?;
                        let ver = watches_input_version.unwrap_or_default();
                        tx.execute(
                            "UPDATE dots_file_watches SET state='watching',note='',input_version=?1 WHERE task_id=?2 AND state='paused'",
                            params![ver, task_id],
                        )?;
                        for sop in schedule_ops {
                            if let Some(holder) = sop.holder {
                                let del = tx.execute(
                                    "DELETE FROM dots_schedule_holds WHERE job_id=?1 AND holder=?2",
                                    params![sop.job_id, holder],
                                )?;
                                if del > 0 {
                                    tx.execute(
                                        "UPDATE cron_jobs SET enabled=1,updated_at=?1 WHERE id=?2",
                                        params![sop.now, sop.job_id],
                                    )?;
                                }
                            }
                        }
                        tx.execute(
                            "INSERT INTO dots_control_receipts VALUES(?1, ?2, ?3)",
                            params![rid, task_id, rout],
                        )?;
                    }
                    json!({ "ok": true })
                }
                "control" => {
                    let st = state.ok_or("missing state")?;
                    let op = operation_id.ok_or("missing operation_id")?;
                    let (wstate, wnote) = if st == "paused" {
                        ("paused", "原事项已暂停")
                    } else {
                        ("cancelled", "原事项已停止")
                    };
                    tx.execute(
                        "UPDATE dots_file_watches SET state=?1, note=?2
                         WHERE task_id=?3 AND state IN ('watching','sending','paused') AND (state<>?1 OR note<>?2)",
                        params![wstate, wnote, task_id],
                    )?;
                    for sop in schedule_ops {
                        match sop.action.as_str() {
                            "setDisabled" => {
                                tx.execute(
                                    "UPDATE cron_jobs SET enabled=0,updated_at=?1 WHERE id=?2",
                                    params![sop.now, sop.job_id],
                                )?;
                            }
                            "holdPause" => {
                                if let Some(holder) = sop.holder {
                                    tx.execute(
                                        "INSERT INTO dots_schedule_holds VALUES(?1, ?2) ON CONFLICT DO NOTHING",
                                        params![sop.job_id, holder],
                                    )?;
                                    tx.execute(
                                        "UPDATE cron_jobs SET enabled=0,updated_at=?1 WHERE id=?2",
                                        params![sop.now, sop.job_id],
                                    )?;
                                }
                            }
                            _ => {}
                        }
                    }
                    tx.execute(
                        "INSERT INTO dots_control_receipts(operation_id,target_task_id,outcome) VALUES(?1,?2,'stop_outcome_unknown')",
                        params![op, task_id],
                    )?;
                    tx.execute(
                        "INSERT INTO dots_target_controls(task_id,state,operation_id) VALUES(?1,?2,?3)
                         ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id",
                        params![task_id, st, op],
                    )?;
                    json!({ "ok": true })
                }
                "updateOp" => {
                    let op = operation_id.ok_or("missing operation_id")?;
                    tx.execute(
                        "UPDATE dots_target_controls SET operation_id=?1 WHERE task_id=?2",
                        params![op, task_id],
                    )?;
                    json!({ "ok": true })
                }
                other => return Err(format!("unknown DotsActionTargetControl mode: {other}").into()),
            }
        }
        Request::DotsReplyStartupSync => {
            tx.execute(
                "INSERT INTO dots_followup_requests SELECT operation_id,request_json FROM dots_delegations
                 WHERE request_json IS NOT NULL AND status IN ('pending','running','blocked') ON CONFLICT DO NOTHING",
                [],
            )?;
            json!({ "ok": true })
        }
        Request::DotsForegroundHandoff { input_id, data_json } => {
            tx.execute(
                "INSERT INTO dots_foreground_handoffs(input_id,data) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                params![input_id, data_json],
            )?;
            json!({ "ok": true })
        }
        Request::DotsForegroundLinked { input_id } => {
            tx.execute(
                "UPDATE dots_foreground_handoffs SET linked=1 WHERE input_id=?1",
                [input_id],
            )?;
            json!({ "ok": true })
        }
        Request::DotsForegroundFreeze {
            input_id,
            policy_json,
        } => {
            tx.execute(
                "INSERT INTO dots_foreground_policies(input_id,policy) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                params![input_id, policy_json],
            )?;
            json!({ "ok": true })
        }
        Request::DotsForegroundCharge {
            input_id,
            policy_json,
            call_id,
            source,
            description,
            characters,
            excerpt,
            mark_exhausted,
        } => {
            tx.execute(
                "INSERT INTO dots_foreground_policies(input_id,policy) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                params![input_id, policy_json],
            )?;
            if characters >= 0 {
                tx.execute(
                    "INSERT INTO dots_foreground_reads(input_id,call_id,source,description,characters,excerpt)
                     VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
                    params![input_id, call_id, source, description, characters, excerpt],
                )?;
            }
            if mark_exhausted {
                tx.execute(
                    "UPDATE dots_foreground_policies SET exhausted=1 WHERE input_id=?1",
                    [input_id],
                )?;
            }
            json!({ "ok": true })
        }
    };
    tx.commit()?;
    Ok(out)
}
