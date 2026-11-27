use crate::outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx};
use crate::{Result, conversation_runtime_data::goal_rows};
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_CRITERIA: usize = 12;
const AUTHORIZATION: &str = r#"{"allowedScopes":[],"targetWhitelist":[],"allowGitBranchOrWorktree":true,"allowRedelegation":true}"#;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    task_id: String,
    conversation_id: String,
    message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_request_id: Option<String>,
    role: String,
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGoal {
    pub user_id: String,
    pub task_id: String,
    default_bot_id: String,
    title: String,
    description: Option<String>,
    criteria: Vec<String>,
    source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<GoalAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_message_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum GoalAuthor {
    Bot,
}

fn hash(input: &[u8]) -> String {
    format!("{:x}", Sha256::digest(input))
}

fn rejected(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

fn read_goal(tx: &Connection, draft: &CreateGoal, id: &str, replayed: bool) -> Result<Value> {
    let goal = goal_rows(tx, &draft.task_id, &draft.user_id, Some(id))?
        .pop()
        .ok_or("Goal is missing from its conversation after creation")?;
    Ok(json!({ "ok": true, "replayed": replayed, "goal": goal }))
}

pub fn create(db: &mut Connection, operation_id: &str, draft: CreateGoal) -> Result<Value> {
    let tx = db.transaction()?;
    let result = create_in_tx(&tx, operation_id, &draft);
    match result {
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

fn create_in_tx(tx: &Transaction<'_>, operation_id: &str, draft: &CreateGoal) -> Result<Value> {
    if operation_id.trim().is_empty()
        || operation_id.len() > 200
        || draft.user_id.is_empty()
        || draft.task_id.is_empty()
        || draft.title.trim().is_empty()
    {
        return Ok(rejected(
            "invalid_request",
            "Task、目标标题和操作身份不能为空",
        ));
    }
    let scope = format!("conversation-goal:{}", draft.user_id);
    let fingerprint = hash(&serde_json::to_vec(draft)?);
    let prior: Option<(String, String)> = tx.query_row(
        "SELECT request_hash,result_json FROM operation_receipts WHERE caller_scope=?1 AND operation_id=?2 AND batch_index=0",
        params![scope, operation_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((saved_hash, result_json)) = prior {
        if saved_hash != fingerprint {
            return Ok(rejected("conflict", "该操作身份已用于另一项 Goal 请求"));
        }
        let mut result: Value = serde_json::from_str(&result_json)?;
        if result["ok"] == true {
            result["replayed"] = true.into();
        }
        return Ok(result);
    }

    let now = i64::try_from(crate::request_control::now_ms())?;
    let reply = apply_create(tx, operation_id, &scope, draft, now)?;
    tx.execute(
        "INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
         VALUES (?1,?2,0,?3,'committed',?4,?5)",
        params![scope, operation_id, fingerprint, serde_json::to_string(&reply)?, now],
    )?;
    Ok(reply)
}

fn apply_create(
    tx: &Transaction<'_>,
    operation_id: &str,
    scope: &str,
    draft: &CreateGoal,
    now: i64,
) -> Result<Value> {
    let allowed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)
            AND NOT EXISTS(SELECT 1 FROM work_execution_bindings WHERE task_id=?1)
            AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state WHERE task_id=?1 AND state='trashed')",
        [&draft.task_id], |row| row.get(0),
    )?;
    if !allowed {
        return Ok(rejected("not_found", "找不到可以建立 Goal 的对话"));
    }

    if let Some(source) = &draft.source {
        if source.task_id != draft.task_id
            || source.message_id.is_empty()
            || source.conversation_id.is_empty()
            || !matches!(source.role.as_str(), "assistant" | "user")
        {
            return Ok(rejected(
                "invalid_request",
                "该消息不能作为当前对话的目标来源",
            ));
        }
        let original: Option<String> = tx.query_row(
            "SELECT s.work_id FROM conversation_goal_sources s
             JOIN works w ON w.work_id=s.work_id AND w.user_id=?1
             JOIN work_conversations c ON c.work_id=w.work_id AND c.conversation_id=?2
             WHERE json_extract_string(s.source_json, '$.taskId')=?2
               AND json_extract_string(s.source_json, '$.conversationId')=?3
               AND coalesce(json_extract_string(s.source_json, '$.entryId'), json_extract_string(s.source_json, '$.messageId'))=?4
             ORDER BY w.created_at,s.work_id LIMIT 1",
            params![draft.user_id, draft.task_id, source.conversation_id, source.entry_id.as_ref().unwrap_or(&source.message_id)],
            |row| row.get(0),
        ).optional()?;
        if let Some(id) = original {
            return read_goal(tx, draft, &id, true);
        }
    }

    let busy: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_conversations c JOIN works w ON w.work_id=c.work_id
         WHERE c.conversation_id=? AND w.lifecycle<>'closed')",
        [&draft.task_id],
        |row| row.get(0),
    )?;
    if busy {
        return Ok(rejected(
            "conflict",
            "当前对话已有进行中的事项，请先更新或结束它",
        ));
    }

    let channel = serde_json::to_string(&[&draft.user_id, &draft.task_id])?;
    let source_message = draft
        .source
        .as_ref()
        .map(|source| &source.message_id)
        .or(draft.origin_message_id.as_ref());
    let created_by = if draft.created_by.is_some() {
        "bot"
    } else {
        "user"
    };
    let owner: Option<(String, String)> = tx.query_row(
        "SELECT b.bot_id, COALESCE(m.profile_json, CAST(json_object('expertId',v.expert_id,'revision',v.source_revision,'version',v.version,
            'systemPromptHash',v.system_prompt_hash,'allowedMcpIds',CAST(v.allowed_mcp_ids_json AS JSON),
            'allowedSkillIds',CAST(v.allowed_skill_ids_json AS JSON),'allowedConnectorIds',CAST(v.allowed_connector_ids_json AS JSON),
            'configuration',CAST(v.configuration_json AS JSON),'skillPackages',CAST(v.skill_packages_json AS JSON),
            'capturedAt',coalesce(v.adopted_at,v.created_at)) AS VARCHAR))
         FROM bots b JOIN bot_expert_versions v ON v.bot_id=b.bot_id AND v.state='active'
         LEFT JOIN bot_message_execution_settings m ON m.bot_id=b.bot_id AND m.message_id=?4
         WHERE b.user_id=?1 AND b.status='active' AND b.bot_id=COALESCE((SELECT bot_id FROM bot_channel_bindings
            WHERE channel_type='desktop' AND channel_identifier=?2),?3)
         ORDER BY v.version DESC LIMIT 1",
        params![draft.user_id, channel, draft.default_bot_id, source_message], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    let Some((bot_id, expert_snapshot)) = owner else {
        return Ok(rejected("not_found", "当前渠道的 Bot 或专家版本不可用"));
    };
    let identity = serde_json::to_vec(&[scope, operation_id])?;
    let id = format!("work-{}", hash(&identity));
    let title: String = draft.title.trim().chars().take(240).collect();
    let description = draft
        .description
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(2_000).collect::<String>());
    let criteria: Vec<Value> = draft.criteria.iter().take(MAX_CRITERIA).map(|text| text.trim())
        .filter(|text| !text.is_empty()).enumerate().map(|(index, text)| json!({
            "id": format!("criterion-{id}-{index}"), "text": text.chars().take(500).collect::<String>(),
            "status": "pending", "requiredIntentRevision": 1, "requiresRealEnvironmentCheck": false,
            "evidenceRefs": [],
        })).collect();
    let criteria = serde_json::to_string(&criteria)?;
    let intent_id = format!("snap-{id}-r1-s1");
    let source_json = draft
        .source
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let input_id = source_json
        .as_deref()
        .map(|encoded| format!("message:sha256:{}", hash(encoded.as_bytes())))
        .unwrap_or_else(|| format!("conversation:{}", draft.task_id));

    tx.execute(
        "INSERT INTO works(work_id,user_id,source_message_id,owner_bot_id,title,goal_description,criteria_json,
            authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
        params![id,draft.user_id,source_message,bot_id,title,description,criteria,AUTHORIZATION,intent_id,input_id,created_by,now],
    )?;
    tx.execute(
        "INSERT INTO work_intent_snapshots(snapshot_id,work_id,intent_revision,source_version,title,goal_description,
            constraints_json,criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,
            created_by,source_message_id,created_at)
         VALUES (?1,?2,1,1,?3,?4,'[]',?5,?6,?7,?8,?9,?10,?11)",
        params![intent_id,id,title,description,criteria,AUTHORIZATION,expert_snapshot,input_id,created_by,source_message,now],
    )?;
    tx.execute(
        "INSERT INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES (?1,?2,'desktop',?3)",
        params![id, draft.task_id, now],
    )?;
    if let Some(source_json) = source_json {
        tx.execute(
            "INSERT INTO conversation_goal_sources(work_id,source_json) VALUES (?1,?2)",
            params![id, source_json],
        )?;
    }
    tx.execute(
        "INSERT INTO conversation_goal_continuations(work_id,task_id,intent_revision,usage_cursor,updated_at)
         SELECT ?1,?2,1,COALESCE(SUM(tokens),0),?3 FROM conversation_goal_usage_events WHERE task_id=?2",
        params![id,draft.task_id,now],
    )?;
    let outbox_id = format!("instruction-{id}-created");
    let payload =
        json!({"workId": id, "title": title, "mode": "once", "workerMode": "general-codemode-v1"})
            .to_string();
    tx.execute(
        "INSERT INTO work_events_outbox(event_id,dedupe_key,event_type,work_id,intent_revision,state_version,owner_epoch,
            request_id,payload_json,created_at) VALUES (?1,?1,'work.created',?2,1,1,1,?3,?4,?5)",
        params![outbox_id,id,operation_id,payload,now],
    )?;
    append_outbox_group_in_tx(
        tx,
        &OutboxGroupDraft {
            group_id: format!("created:{id}"),
            operation_id: operation_id.into(),
            batch_index: 0,
            entity_key: format!("work:{id}"),
            entity_revision: Some(1),
            previous_revision: None,
            depends_on_group_id: None,
            work_projection_user_id: Some(draft.user_id.clone()),
        },
        &[OutboxEventDraft {
            event_id: format!("core:{outbox_id}"),
            owner_generation: crate::business_protocol::current_core_generation(),
            domain: "work".into(),
            kind: "work.created".into(),
            task_id: Some(draft.task_id.clone()),
            entity_id: id.clone(),
            revision: 1,
            command_id: Some(operation_id.into()),
            payload_json: payload,
        }],
        now,
    )?;

    read_goal(tx, draft, &id, false)
}
