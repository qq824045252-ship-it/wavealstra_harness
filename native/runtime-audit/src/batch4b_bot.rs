use crate::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum BotOp {
    #[serde(rename_all = "camelCase")]
    BotUpsert {
        bot_id: String,
        user_id: String,
        display_name: String,
        responsibility_summary: String,
        expert_profile_json: String,
        memory_scope_json: String,
        authorization_json: String,
        foreground_allowed_tools_json: String,
        notification_policy_json: String,
        status: String,
        now: i64,
        active_version: i64,
        expert_id: String,
        source_revision: String,
        system_prompt_hash: String,
        allowed_mcp_ids_json: String,
        allowed_skill_ids_json: String,
        allowed_connector_ids_json: String,
        configuration_json: Option<String>,
        skill_packages_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotPrimaryRoleEnsure {
        user_id: String,
        bot_id: String,
        assigned_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotChannelBind {
        channel_type: String,
        channel_identifier: String,
        bot_id: String,
        bound_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotExpertStage {
        bot_id: String,
        supersede_version: Option<i64>,
        version: i64,
        expert_id: String,
        source_revision: String,
        system_prompt_hash: String,
        allowed_mcp_ids_json: String,
        allowed_skill_ids_json: String,
        allowed_connector_ids_json: String,
        staged_by: String,
        configuration_json: Option<String>,
        skill_packages_json: String,
        expert_profile_json: String,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotExpertAdopt {
        bot_id: String,
        version: i64,
        expert_profile_json: String,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotDisable { bot_id: String, now: i64 },
    #[serde(rename_all = "camelCase")]
    BotDelete { bot_id: String },
    #[serde(rename_all = "camelCase")]
    BotConvInsert {
        conversation_id: String,
        bot_id: String,
        user_id: String,
        team_id: Option<String>,
        ingress_kind: String,
        source_kind: String,
        archived_at: Option<i64>,
        created_at: i64,
        updated_at: i64,
        or_ignore: bool,
    },
    #[serde(rename_all = "camelCase")]
    BotConvTouch { conversation_id: String, now: i64 },
    #[serde(rename_all = "camelCase")]
    BotConvBumpRevision {
        conversation_id: String,
        user_id: Option<String>,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotConvArchive { conversation_id: String, now: i64 },
    #[serde(rename_all = "camelCase")]
    BotMsgInsert {
        message_id: String,
        conversation_id: String,
        bot_id: String,
        request_id: String,
        role: String,
        text: String,
        status: String,
        work_ids_json: String,
        created_at: i64,
        updated_at: i64,
        or_ignore: bool,
        attachments_json: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    BotMsgUpdate {
        message_id: String,
        status: String,
        text: String,
        error: Option<String>,
        updated_at: i64,
        segments_json: Option<String>,
        tools: Option<BotMsgToolsInput>,
        activity_json: Option<String>,
        clear_work_reads: Option<BotWorkReadScope>,
    },
    #[serde(rename_all = "camelCase")]
    BotMsgTextUpdate {
        message_id: String,
        text: String,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotMsgWorkIdsUpdate {
        message_id: String,
        work_ids_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotSendReceiptInsert {
        user_id: String,
        bot_id: String,
        request_id: String,
        payload_hash: String,
        conversation_id: String,
        user_message_id: String,
        assistant_message_id: String,
        selected_work_id: Option<String>,
        reference_message_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    BotClarificationAnswerInsert {
        question_message_id: String,
        goal_id: String,
        answer_message_id: String,
    },
    #[serde(rename_all = "camelCase")]
    BotWorkReadsPruneTerminal { user_id: String },
    #[serde(rename_all = "camelCase")]
    BotWorkUserInputInsert {
        work_id: String,
        source_message_id: String,
        intent_revision: i64,
        source_version: i64,
        messages_json: String,
        references_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotWorkAttachmentsInsert {
        work_id: String,
        input_snapshot_id: String,
        attachments_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotWorkFeedbackUpsert {
        message_id: String,
        metadata_json: String,
        overwrite: bool,
    },
    #[serde(rename_all = "camelCase")]
    BotWorkConvReplaceDelivery {
        work_id: String,
        conversation_id: String,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotForegroundUsageUpsert {
        message_id: String,
        generation_id: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotForegroundMetricsUpsert {
        message_id: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotPeerCallInsert {
        call_id: String,
        parent_message_id: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotPeerCallUpdate { call_id: String, value_json: String },
    #[serde(rename_all = "camelCase")]
    BotGatewayConvInsert {
        conversation_id: String,
        user_id: String,
        bot_id: String,
        channel_id: String,
        connection_key: String,
        chat_id: String,
        audience: String,
    },
    #[serde(rename_all = "camelCase")]
    BotTurnOriginInsert {
        user_message_id: String,
        user_id: String,
        bot_id: String,
        conversation_id: String,
        origin_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabInsert {
        collaboration_id: String,
        user_id: String,
        source_bot_id: String,
        source_conversation_id: String,
        target_bot_id: String,
        initiation_key: String,
        initiation_hash: String,
        value_json: String,
        created_at: i64,
        updated_at: i64,
        status: String,
        times_json: String,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabUpdateWork {
        user_id: String,
        collaboration_id: String,
        work_id: String,
        times_json: String,
        status: String,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabRequestInsert {
        collaboration_id: String,
        conversation_id: String,
        request_id: String,
        user_message_id: String,
        assistant_message_id: String,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabMessageInsert {
        message_id: String,
        collaboration_id: String,
        operation_key: String,
        ordinal: i64,
        payload_hash: String,
        value_json: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabEventInsert {
        event_id: String,
        collaboration_id: String,
        operation_key: String,
        ordinal: i64,
        payload_hash: String,
        value_json: String,
        kind: String,
        times_json: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabPreviewUpsert {
        collaboration_id: String,
        exchange_id: String,
        value_json: String,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotCollabPreviewDelete {
        collaboration_id: String,
        exchange_id: String,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotNavSpaceUpsert {
        space_id: String,
        auto_name: String,
    },
    #[serde(rename_all = "camelCase")]
    BotSpaceCreate {
        id: String,
        name: String,
        parent_id: Option<String>,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotSpaceUpdate {
        id: String,
        name: String,
        parent_id: Option<String>,
        update_parent: bool,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    BotTaskAssignSpace { task_id: String, space_id: String },
    #[serde(rename_all = "camelCase")]
    WorkMessageRefInsert {
        work_id: String,
        conversation_id: String,
        message_id: String,
    },
    #[serde(rename_all = "camelCase")]
    GoalWakeUpsert {
        work_id: String,
        task_id: String,
        intent_revision: i64,
        trigger: String,
        at: i64,
    },
    #[serde(rename_all = "camelCase")]
    GoalCheckUpsert {
        work_id: String,
        task_id: String,
        intent_revision: i64,
        trigger: String,
        reason: String,
        at: i64,
    },
    #[serde(rename_all = "camelCase")]
    GoalContinuationUpsert {
        work_id: String,
        task_id: String,
        intent_revision: i64,
        attempts: i64,
        attempt_serial: i64,
        tokens_used: i64,
        tokens_budget: Option<i64>,
        time_used_seconds: i64,
        usage_cursor: i64,
        progress_fingerprint: Option<String>,
        progress_stalls: i64,
        run_cursor: i64,
        last_token_at: Option<i64>,
        last_continuation_at: Option<i64>,
        state: String,
        defer_reason: Option<String>,
        deferred_at: Option<i64>,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    GoalUsageEventInsert {
        event_key: String,
        task_id: String,
        tokens: i64,
        recorded_at: i64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotMsgToolsInput {
    pub task_id: String,
    pub tools_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotWorkReadScope {
    pub conversation_id: String,
    pub request_id: String,
}

pub fn apply_tx(tx: &Transaction<'_>, op: BotOp) -> Result<Value> {
    let conn: &Connection = tx;
    match op {
        BotOp::BotUpsert {
            bot_id,
            user_id,
            display_name,
            responsibility_summary,
            expert_profile_json,
            memory_scope_json,
            authorization_json,
            foreground_allowed_tools_json,
            notification_policy_json,
            status,
            now,
            active_version,
            expert_id,
            source_revision,
            system_prompt_hash,
            allowed_mcp_ids_json,
            allowed_skill_ids_json,
            allowed_connector_ids_json,
            configuration_json,
            skill_packages_json,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bots (
                    bot_id,user_id,display_name,responsibility_summary,expert_profile_json,memory_scope_json,
                    authorization_json,foreground_allowed_tools_json,notification_policy_json,status,created_at,updated_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
                params![
                    bot_id,
                    user_id,
                    display_name,
                    responsibility_summary,
                    expert_profile_json,
                    memory_scope_json,
                    authorization_json,
                    foreground_allowed_tools_json,
                    notification_policy_json,
                    status,
                    now
                ],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO bot_expert_versions (
                    bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
                    allowed_skill_ids_json,allowed_connector_ids_json,configuration_json,skill_packages_json,staged_by,created_at,adopted_at
                ) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,'host',?11,?11)",
                params![
                    bot_id,
                    active_version,
                    expert_id,
                    source_revision,
                    system_prompt_hash,
                    allowed_mcp_ids_json,
                    allowed_skill_ids_json,
                    allowed_connector_ids_json,
                    configuration_json,
                    skill_packages_json,
                    now
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotPrimaryRoleEnsure {
            user_id,
            bot_id,
            assigned_at,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_identity_roles(user_id,role,bot_id,assigned_at) VALUES(?1,'primary',?2,?3)",
                params![user_id, bot_id, assigned_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotChannelBind {
            channel_type,
            channel_identifier,
            bot_id,
            bound_at,
        } => {
            conn.execute(
                "INSERT INTO bot_channel_bindings (channel_type,channel_identifier,bot_id,bound_at)
                 VALUES (?1,?2,?3,?4) ON CONFLICT(channel_type,channel_identifier)
                 DO UPDATE SET bot_id=excluded.bot_id, bound_at=excluded.bound_at",
                params![channel_type, channel_identifier, bot_id, bound_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotExpertStage {
            bot_id,
            supersede_version,
            version,
            expert_id,
            source_revision,
            system_prompt_hash,
            allowed_mcp_ids_json,
            allowed_skill_ids_json,
            allowed_connector_ids_json,
            staged_by,
            configuration_json,
            skill_packages_json,
            expert_profile_json,
            now,
        } => {
            if let Some(prev) = supersede_version {
                conn.execute(
                    "UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=?1 AND version=?2",
                    params![bot_id, prev],
                )?;
            }
            conn.execute(
                "INSERT INTO bot_expert_versions (
                    bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
                    allowed_skill_ids_json,allowed_connector_ids_json,staged_by,created_at,configuration_json,skill_packages_json
                ) VALUES (?1,?2,'pending',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    bot_id,
                    version,
                    expert_id,
                    source_revision,
                    system_prompt_hash,
                    allowed_mcp_ids_json,
                    allowed_skill_ids_json,
                    allowed_connector_ids_json,
                    staged_by,
                    now,
                    configuration_json,
                    skill_packages_json
                ],
            )?;
            conn.execute(
                "UPDATE bots SET expert_profile_json=?1, updated_at=?2 WHERE bot_id=?3",
                params![expert_profile_json, now, bot_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotExpertAdopt {
            bot_id,
            version,
            expert_profile_json,
            now,
        } => {
            conn.execute(
                "UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=?1 AND state='active'",
                [&bot_id],
            )?;
            conn.execute(
                "UPDATE bot_expert_versions SET state='active', adopted_at=?1 WHERE bot_id=?2 AND version=?3",
                params![now, bot_id, version],
            )?;
            conn.execute(
                "UPDATE bots SET expert_profile_json=?1, updated_at=?2 WHERE bot_id=?3",
                params![expert_profile_json, now, bot_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotDisable { bot_id, now } => {
            conn.execute(
                "UPDATE bots SET status='disabled', updated_at=?1 WHERE bot_id=?2",
                params![now, bot_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotDelete { bot_id } => {
            conn.execute("DELETE FROM bot_channel_bindings WHERE bot_id=?1", [&bot_id])?;
            conn.execute("DELETE FROM bot_expert_versions WHERE bot_id=?1", [&bot_id])?;
            conn.execute("DELETE FROM bots WHERE bot_id=?1", [&bot_id])?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotConvInsert {
            conversation_id,
            bot_id,
            user_id,
            team_id,
            ingress_kind,
            source_kind,
            archived_at,
            created_at,
            updated_at,
            or_ignore,
        } => {
            let verb = if or_ignore {
                "INSERT OR IGNORE INTO"
            } else {
                "INSERT INTO"
            };
            conn.execute(
                &format!(
                    "{verb} bot_conversations(conversation_id,bot_id,user_id,team_id,ingress_kind,source_kind,archived_at,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"
                ),
                params![
                    conversation_id,
                    bot_id,
                    user_id,
                    team_id,
                    ingress_kind,
                    source_kind,
                    archived_at,
                    created_at,
                    updated_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotConvTouch { conversation_id, now } => {
            conn.execute(
                "UPDATE bot_conversations SET revision=revision+1,updated_at=?1 WHERE conversation_id=?2",
                params![now, conversation_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotConvBumpRevision {
            conversation_id,
            user_id,
            now,
        } => {
            if let Some(uid) = user_id {
                conn.execute(
                    "UPDATE bot_conversations SET revision=revision+1,updated_at=?1 WHERE conversation_id=?2 AND user_id=?3",
                    params![now, conversation_id, uid],
                )?;
            } else {
                conn.execute(
                    "UPDATE bot_conversations SET revision=revision+1,updated_at=?1 WHERE conversation_id=?2",
                    params![now, conversation_id],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        BotOp::BotConvArchive { conversation_id, now } => {
            conn.execute(
                "UPDATE bot_conversations SET archived_at=?1 WHERE conversation_id=?2",
                params![now, conversation_id],
            )?;
            conn.execute(
                "UPDATE bot_conversations SET revision=revision+1,updated_at=?1 WHERE conversation_id=?2",
                params![now, conversation_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotMsgInsert {
            message_id,
            conversation_id,
            bot_id,
            request_id,
            role,
            text,
            status,
            work_ids_json,
            created_at,
            updated_at,
            or_ignore,
            attachments_json,
        } => {
            let verb = if or_ignore {
                "INSERT OR IGNORE INTO"
            } else {
                "INSERT INTO"
            };
            let changes = conn.execute(
                &format!(
                    "{verb} bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,work_ids_json,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
                ),
                params![
                    message_id,
                    conversation_id,
                    bot_id,
                    request_id,
                    role,
                    text,
                    status,
                    work_ids_json,
                    created_at,
                    updated_at
                ],
            )?;
            if let Some(att) = attachments_json {
                conn.execute(
                    "INSERT OR IGNORE INTO bot_message_attachments(message_id,attachments_json) VALUES (?1,?2)",
                    params![message_id, att],
                )?;
            }
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotMsgUpdate {
            message_id,
            status,
            text,
            error,
            updated_at,
            segments_json,
            tools,
            activity_json,
            clear_work_reads,
        } => {
            conn.execute(
                "UPDATE bot_messages SET status=?1,text=?2,error=?3,updated_at=?4 WHERE message_id=?5",
                params![status, text, error, updated_at, message_id],
            )?;
            if let Some(segs) = segments_json {
                conn.execute(
                    "INSERT OR REPLACE INTO bot_message_segments(message_id,segments_json) VALUES (?1,?2)",
                    params![message_id, segs],
                )?;
            }
            if let Some(t) = tools {
                conn.execute(
                    "INSERT OR REPLACE INTO bot_message_tools(message_id,task_id,tools_json) VALUES (?1,?2,?3)",
                    params![message_id, t.task_id, t.tools_json],
                )?;
            }
            if let Some(act) = activity_json {
                conn.execute(
                    "INSERT OR REPLACE INTO bot_message_activity(message_id,activity_json) VALUES (?1,?2)",
                    params![message_id, act],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM bot_message_activity WHERE message_id=?1",
                    [&message_id],
                )?;
            }
            if let Some(scope) = clear_work_reads {
                conn.execute(
                    "DELETE FROM bot_work_reads WHERE conversation_id=?1 AND request_id=?2",
                    params![scope.conversation_id, scope.request_id],
                )?;
            }
            conn.execute(
                "UPDATE bot_conversations SET revision=revision+1,updated_at=?1
                 WHERE conversation_id=(SELECT conversation_id FROM bot_messages WHERE message_id=?2)",
                params![updated_at, message_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotMsgTextUpdate {
            message_id,
            text,
            updated_at,
        } => {
            let changes = conn.execute(
                "UPDATE bot_messages SET text=?1,updated_at=?2 WHERE message_id=?3 AND text<>?1",
                params![text, updated_at, message_id],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotMsgWorkIdsUpdate {
            message_id,
            work_ids_json,
        } => {
            conn.execute(
                "UPDATE bot_messages SET work_ids_json=?1 WHERE message_id=?2",
                params![work_ids_json, message_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotSendReceiptInsert {
            user_id,
            bot_id,
            request_id,
            payload_hash,
            conversation_id,
            user_message_id,
            assistant_message_id,
            selected_work_id,
            reference_message_id,
        } => {
            conn.execute(
                "INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,
                 assistant_message_id,selected_work_id,reference_message_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    user_id,
                    bot_id,
                    request_id,
                    payload_hash,
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    selected_work_id,
                    reference_message_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotClarificationAnswerInsert {
            question_message_id,
            goal_id,
            answer_message_id,
        } => {
            conn.execute(
                "INSERT INTO bot_clarification_answers(question_message_id,goal_id,answer_message_id) VALUES (?1,?2,?3)",
                params![question_message_id, goal_id, answer_message_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotWorkReadsPruneTerminal { user_id } => {
            let changes = conn.execute(
                "DELETE FROM bot_work_reads WHERE EXISTS (
                    SELECT 1 FROM bot_send_receipts r
                    JOIN bot_conversations c ON c.conversation_id=r.conversation_id
                    JOIN bot_messages m ON m.message_id=r.assistant_message_id
                    WHERE r.user_id=?1 AND c.user_id=r.user_id
                      AND r.conversation_id=bot_work_reads.conversation_id AND r.request_id=bot_work_reads.request_id
                      AND m.conversation_id=r.conversation_id AND m.bot_id=r.bot_id AND m.request_id=r.request_id
                      AND m.role='assistant' AND m.status IN ('completed','cancelled','failed')
                )",
                [user_id],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotWorkUserInputInsert {
            work_id,
            source_message_id,
            intent_revision,
            source_version,
            messages_json,
            references_json,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_work_user_inputs(work_id,source_message_id,intent_revision,source_version,messages_json,references_json)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    work_id,
                    source_message_id,
                    intent_revision,
                    source_version,
                    messages_json,
                    references_json
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotWorkAttachmentsInsert {
            work_id,
            input_snapshot_id,
            attachments_json,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_work_attachments(work_id,input_snapshot_id,attachments_json) VALUES (?1,?2,?3)",
                params![work_id, input_snapshot_id, attachments_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotWorkFeedbackUpsert {
            message_id,
            metadata_json,
            overwrite,
        } => {
            let changes = if overwrite {
                conn.execute(
                    "INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?1,?2)
                     ON CONFLICT(message_id) DO UPDATE SET metadata_json=excluded.metadata_json
                     WHERE bot_work_feedback.metadata_json<>excluded.metadata_json",
                    params![message_id, metadata_json],
                )?
            } else {
                conn.execute(
                    "INSERT OR IGNORE INTO bot_work_feedback(message_id,metadata_json) VALUES (?1,?2)",
                    params![message_id, metadata_json],
                )?
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotWorkConvReplaceDelivery {
            work_id,
            conversation_id,
            now,
        } => {
            conn.execute(
                "DELETE FROM work_conversations WHERE work_id=?1 AND channel_type='bot-delivery' AND conversation_id LIKE 'bot-inbox-%'",
                [&work_id],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES (?1,?2,'bot-delivery',?3)
                 ON CONFLICT(work_id,conversation_id) DO UPDATE SET channel_type='bot-delivery'",
                params![work_id, conversation_id, now],
            )?;
            conn.execute(
                "UPDATE bot_conversations SET revision=revision+1,updated_at=?1 WHERE conversation_id=?2",
                params![now, conversation_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotForegroundUsageUpsert {
            message_id,
            generation_id,
            value_json,
        } => {
            conn.execute(
                "INSERT OR REPLACE INTO bot_foreground_usage VALUES(?1,?2,?3)",
                params![message_id, generation_id, value_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotForegroundMetricsUpsert {
            message_id,
            value_json,
        } => {
            conn.execute(
                "INSERT OR REPLACE INTO bot_foreground_metrics VALUES(?1,?2)",
                params![message_id, value_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotPeerCallInsert {
            call_id,
            parent_message_id,
            value_json,
        } => {
            conn.execute(
                "INSERT INTO bot_peer_calls(call_id,parent_message_id,value_json) VALUES (?1,?2,?3)",
                params![call_id, parent_message_id, value_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotPeerCallUpdate {
            call_id,
            value_json,
        } => {
            conn.execute(
                "UPDATE bot_peer_calls SET value_json=?1 WHERE call_id=?2",
                params![value_json, call_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotGatewayConvInsert {
            conversation_id,
            user_id,
            bot_id,
            channel_id,
            connection_key,
            chat_id,
            audience,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_gateway_conversations
                 (conversation_id,user_id,bot_id,channel_id,connection_key,chat_id,audience) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    conversation_id,
                    user_id,
                    bot_id,
                    channel_id,
                    connection_key,
                    chat_id,
                    audience
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotTurnOriginInsert {
            user_message_id,
            user_id,
            bot_id,
            conversation_id,
            origin_json,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_turn_origins(user_message_id,user_id,bot_id,conversation_id,origin_json)
                 VALUES(?1,?2,?3,?4,?5)",
                params![user_message_id, user_id, bot_id, conversation_id, origin_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabInsert {
            collaboration_id,
            user_id,
            source_bot_id,
            source_conversation_id,
            target_bot_id,
            initiation_key,
            initiation_hash,
            value_json,
            created_at,
            updated_at,
            status,
            times_json,
        } => {
            conn.execute(
                "INSERT INTO bot_collaborations(collaboration_id,user_id,source_bot_id,source_conversation_id,target_bot_id,
                 initiation_key,initiation_hash,value_json,created_at,updated_at,status,times_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    collaboration_id,
                    user_id,
                    source_bot_id,
                    source_conversation_id,
                    target_bot_id,
                    initiation_key,
                    initiation_hash,
                    value_json,
                    created_at,
                    updated_at,
                    status,
                    times_json
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabUpdateWork {
            user_id,
            collaboration_id,
            work_id,
            times_json,
            status,
        } => {
            conn.execute(
                "UPDATE bot_collaborations SET work_id=?1,times_json=?2,status=?3 WHERE user_id=?4 AND collaboration_id=?5",
                params![work_id, times_json, status, user_id, collaboration_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabRequestInsert {
            collaboration_id,
            conversation_id,
            request_id,
            user_message_id,
            assistant_message_id,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO bot_collaboration_requests
                 (collaboration_id,conversation_id,request_id,user_message_id,assistant_message_id) VALUES (?1,?2,?3,?4,?5)",
                params![
                    collaboration_id,
                    conversation_id,
                    request_id,
                    user_message_id,
                    assistant_message_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabMessageInsert {
            message_id,
            collaboration_id,
            operation_key,
            ordinal,
            payload_hash,
            value_json,
            created_at,
        } => {
            conn.execute(
                "UPDATE bot_collaborations SET next_ordinal=MAX(next_ordinal+1, ?1+1), updated_at=MAX(updated_at,?2) WHERE collaboration_id=?3",
                params![ordinal, created_at, collaboration_id],
            )?;
            conn.execute(
                "INSERT INTO bot_collaboration_messages(message_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    message_id,
                    collaboration_id,
                    operation_key,
                    ordinal,
                    payload_hash,
                    value_json
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabEventInsert {
            event_id,
            collaboration_id,
            operation_key,
            ordinal,
            payload_hash,
            value_json,
            kind,
            times_json,
            created_at,
        } => {
            conn.execute(
                "UPDATE bot_collaborations SET next_ordinal=MAX(next_ordinal+1, ?1+1) WHERE collaboration_id=?2",
                params![ordinal, collaboration_id],
            )?;
            conn.execute(
                "INSERT INTO bot_collaboration_events(event_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    event_id,
                    collaboration_id,
                    operation_key,
                    ordinal,
                    payload_hash,
                    value_json
                ],
            )?;
            conn.execute(
                "UPDATE bot_collaborations SET status=?1,times_json=?2,updated_at=MAX(updated_at,?3) WHERE collaboration_id=?4",
                params![kind, times_json, created_at, collaboration_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotCollabPreviewUpsert {
            collaboration_id,
            exchange_id,
            value_json,
            updated_at,
        } => {
            let changes = conn.execute(
                "INSERT INTO bot_collaboration_previews(collaboration_id,exchange_id,value_json) VALUES (?1,?2,?3)
                 ON CONFLICT(collaboration_id,exchange_id) DO UPDATE SET value_json=excluded.value_json WHERE value_json<>excluded.value_json",
                params![collaboration_id, exchange_id, value_json],
            )?;
            if changes > 0 {
                conn.execute(
                    "UPDATE bot_collaborations SET updated_at=MAX(updated_at,?1) WHERE collaboration_id=?2",
                    params![updated_at, collaboration_id],
                )?;
            }
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotCollabPreviewDelete {
            collaboration_id,
            exchange_id,
            now,
        } => {
            let changes = conn.execute(
                "DELETE FROM bot_collaboration_previews WHERE collaboration_id=?1 AND exchange_id=?2",
                params![collaboration_id, exchange_id],
            )?;
            if changes > 0 {
                conn.execute(
                    "UPDATE bot_collaborations SET updated_at=MAX(updated_at,?1) WHERE collaboration_id=?2",
                    params![now, collaboration_id],
                )?;
            }
            Ok(json!({ "ok": true, "changes": changes }))
        }
        BotOp::BotNavSpaceUpsert {
            space_id,
            auto_name,
        } => {
            conn.execute(
                "INSERT INTO bot_workspace_navigation_spaces VALUES(?1,?2)
                 ON CONFLICT(space_id) DO UPDATE SET auto_name=excluded.auto_name",
                params![space_id, auto_name],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotSpaceCreate {
            id,
            name,
            parent_id,
            updated_at,
        } => {
            conn.execute(
                "INSERT INTO spaces(id,name,parent_id,sort_order,created_at,updated_at)
                 VALUES(?1,?2,?3,0,?4,?4)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, updated_at=excluded.updated_at",
                params![id, name, parent_id, updated_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::BotSpaceUpdate {
            id,
            name,
            parent_id,
            update_parent,
            updated_at,
        } => {
            if update_parent {
                conn.execute(
                    "UPDATE spaces SET parent_id=?1,name=?2,updated_at=?3 WHERE id=?4",
                    params![parent_id, name, updated_at, id],
                )?;
            } else {
                conn.execute(
                    "UPDATE spaces SET name=?1,updated_at=?2 WHERE id=?3",
                    params![name, updated_at, id],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        BotOp::BotTaskAssignSpace { task_id, space_id } => {
            conn.execute(
                "UPDATE tasks SET space_id=?1 WHERE id=?2 AND space_id IS NOT ?1",
                params![space_id, task_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::WorkMessageRefInsert {
            work_id,
            conversation_id,
            message_id,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO work_message_refs(work_id,conversation_id,message_id) VALUES (?1,?2,?3)",
                params![work_id, conversation_id, message_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::GoalWakeUpsert {
            work_id,
            task_id,
            intent_revision,
            trigger,
            at,
        } => {
            conn.execute(
                "INSERT INTO conversation_goal_last_wake(work_id,task_id,intent_revision,trigger,at)
                 SELECT work_id,task_id,intent_revision,?1,?2 FROM conversation_goal_continuations
                 WHERE work_id=?3 AND task_id=?4 AND intent_revision=?5
                 ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
                   trigger=excluded.trigger,at=excluded.at",
                params![trigger, at, work_id, task_id, intent_revision],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::GoalCheckUpsert {
            work_id,
            task_id,
            intent_revision,
            trigger,
            reason,
            at,
        } => {
            conn.execute(
                "INSERT INTO conversation_goal_last_check(work_id,task_id,intent_revision,trigger,reason,at)
                 SELECT work_id,task_id,intent_revision,?1,?2,?3 FROM conversation_goal_continuations
                 WHERE work_id=?4 AND task_id=?5 AND intent_revision=?6
                 ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
                   trigger=excluded.trigger,reason=excluded.reason,at=excluded.at",
                params![trigger, reason, at, work_id, task_id, intent_revision],
            )?;
            Ok(json!({ "ok": true }))
        }
        BotOp::GoalContinuationUpsert {
            work_id,
            task_id,
            intent_revision,
            attempts,
            attempt_serial,
            tokens_used,
            tokens_budget,
            time_used_seconds,
            usage_cursor,
            progress_fingerprint,
            progress_stalls,
            run_cursor,
            last_token_at,
            last_continuation_at,
            state,
            defer_reason,
            deferred_at,
            updated_at,
        } => {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM conversation_goal_continuations WHERE work_id=?1",
                    [&work_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                conn.execute(
                    "UPDATE conversation_goal_continuations SET
                     task_id=?1,intent_revision=?2,attempts=?3,attempt_serial=?4,tokens_used=?5,
                     tokens_budget=?6,time_used_seconds=?7,usage_cursor=?8,progress_fingerprint=?9,
                     progress_stalls=?10,run_cursor=?11,last_token_at=?12,last_continuation_at=?13,
                     state=?14,defer_reason=?15,deferred_at=?16,updated_at=?17
                     WHERE work_id=?18",
                    params![
                        task_id,
                        intent_revision,
                        attempts,
                        attempt_serial,
                        tokens_used,
                        tokens_budget,
                        time_used_seconds,
                        usage_cursor,
                        progress_fingerprint,
                        progress_stalls,
                        run_cursor,
                        last_token_at,
                        last_continuation_at,
                        state,
                        defer_reason,
                        deferred_at,
                        updated_at,
                        work_id
                    ],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO conversation_goal_continuations(
                     work_id,task_id,intent_revision,attempts,attempt_serial,tokens_used,tokens_budget,
                     time_used_seconds,usage_cursor,progress_fingerprint,progress_stalls,run_cursor,
                     last_token_at,last_continuation_at,state,defer_reason,deferred_at,updated_at
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                    params![
                        work_id,
                        task_id,
                        intent_revision,
                        attempts,
                        attempt_serial,
                        tokens_used,
                        tokens_budget,
                        time_used_seconds,
                        usage_cursor,
                        progress_fingerprint,
                        progress_stalls,
                        run_cursor,
                        last_token_at,
                        last_continuation_at,
                        state,
                        defer_reason,
                        deferred_at,
                        updated_at
                    ],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        BotOp::GoalUsageEventInsert {
            event_key,
            task_id,
            tokens,
            recorded_at,
        } => {
            conn.execute(
                "INSERT OR IGNORE INTO conversation_goal_usage_events(event_key,task_id,tokens,recorded_at) VALUES (?1,?2,?3,?4)",
                params![event_key, task_id, tokens, recorded_at],
            )?;
            Ok(json!({ "ok": true }))
        }
    }
}
