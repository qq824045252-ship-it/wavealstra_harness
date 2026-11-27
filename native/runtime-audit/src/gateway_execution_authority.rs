use crate::{Result, batch4a_writes::ensure_gateway_space_in_tx, gateway_admission};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const ROOT_SPACE: &str = "sp-gw-root";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Materialize {
    origin: MaterializeOrigin,
    task_id: String,
    model_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterializeOrigin {
    #[serde(flatten)]
    source: gateway_admission::Origin,
    audience: String,
    personal_memory_binding_id: Option<String>,
}

impl Materialize {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn channel_id(&self) -> &str {
        &self.origin.source.channel_id
    }
}

#[derive(PartialEq)]
struct ExecutionIdentity {
    channel_id: String,
    connection_key: String,
    chat_id: String,
    sender_id: String,
    platform: String,
    audience: String,
    binding_id: Option<String>,
}

struct TaskScope {
    channel_id: Option<String>,
    space_id: Option<String>,
    archived_or_trashed: bool,
    has_conflicting_scope: bool,
}

fn channel_name(channel: &str) -> Option<&'static str> {
    Some(match channel {
        "qq-default" => "QQ",
        "weixin-default" => "个人微信",
        "telegram-default" => "Telegram",
        "dingtalk-default" => "钉钉",
        "discord-default" => "Discord",
        "feishu-default" => "飞书",
        "wecom-default" => "企微",
        "wechat-default" => "微信公众号",
        "slack-default" => "Slack",
        _ => return None,
    })
}

fn denied(code: &str) -> Value {
    json!({ "status": "denied", "code": code })
}

fn revoked() -> Value {
    json!({ "status": "denied", "code": "MEMORY_REVOKED", "memory": "revoked" })
}

pub(crate) fn gateway_task_id(task_id: &str) -> bool {
    task_id.strip_prefix("gateway-chat-").is_some_and(|id| {
        id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn channel_path(db: &Connection, channel: &str) -> Result<PathBuf> {
    let database: String = db.query_row(
        "SELECT path FROM duckdb_databases() WHERE database_name=current_database()",
        [],
        |row| row.get(0),
    )?;
    let directory = Path::new(&database).parent().ok_or("Gateway database path has no parent")?;
    Ok(directory.join("gateway").join("spaces").join(channel))
}

// Missing spaces may be created by ordinary inbound admission. Existing spaces
// must already belong to the canonical hierarchy and host-owned directory.
fn space_state(db: &Connection, id: &str, parent: Option<&str>, path: Option<&Path>) -> Result<Option<bool>> {
    Ok(db.query_row(
        "SELECT parent_id,path,archived FROM spaces WHERE id=?",
        [id],
        |row| {
            let existing_parent: Option<String> = row.get(0)?;
            let existing_path: Option<String> = row.get(1)?;
            let archived: i64 = row.get(2)?;
            Ok(archived == 0 && existing_parent.as_deref() == parent
                && existing_path.as_deref().map(Path::new) == path)
        },
    ).optional()?)
}

fn task_scope(db: &Connection, task_id: &str) -> Result<Option<TaskScope>> {
    Ok(db.query_row(
        "SELECT s.channel_id,t.space_id,t.archived<>0 OR coalesce(w.state='trashed',false),
            t.project_id IS NOT NULL OR t.session_file IS NOT NULL OR t.external_agent_pin_json IS NOT NULL
            OR EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
         FROM tasks t LEFT JOIN gateway_sidebar_conversations s ON s.task_id=t.id
         LEFT JOIN task_execution_workspace_state w ON w.task_id=t.id WHERE t.id=?",
        [task_id],
        |row| Ok(TaskScope { channel_id: row.get(0)?, space_id: row.get(1)?,
            archived_or_trashed: row.get(2)?, has_conflicting_scope: row.get(3)? }),
    ).optional()?)
}

fn owns_scope(task: &TaskScope, channel: &str, space: &str) -> bool {
    !task.has_conflicting_scope && task.channel_id.as_deref() == Some(channel)
        && task.space_id.as_deref() == Some(space)
}

fn read_identity(db: &Connection, task_id: &str) -> Result<Option<ExecutionIdentity>> {
    Ok(db.query_row(
        "SELECT channel_id,connection_key,chat_id,sender_id,platform,audience,personal_memory_binding_id
         FROM gateway_execution_sources WHERE task_id=?",
        [task_id],
        |row| Ok(ExecutionIdentity { channel_id: row.get(0)?, connection_key: row.get(1)?,
            chat_id: row.get(2)?, sender_id: row.get(3)?, platform: row.get(4)?,
            audience: row.get(5)?, binding_id: row.get(6)? }),
    ).optional()?)
}

fn task_grant(db: &Connection, task_id: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT binding_id FROM gateway_dots_tasks WHERE task_id=?",
        [task_id], |row| row.get(0)).optional()?)
}

pub fn read(db: &mut Connection, task_id: &str) -> Result<Value> {
    let tx = db.transaction()?;
    let result = read_authority(&tx, task_id)?;
    tx.commit()?;
    Ok(result)
}

fn read_authority(db: &Connection, task_id: &str) -> Result<Value> {
    if !gateway_task_id(task_id) {
        return Ok(denied("INVALID_TASK"));
    }
    let Some(task) = task_scope(db, task_id)? else {
        return Ok(denied("TASK_MISSING"));
    };
    if task.archived_or_trashed {
        return Ok(denied("TASK_ARCHIVED_OR_TRASHED"));
    }
    let Some(identity) = read_identity(db, task_id)? else {
        return Ok(denied("SOURCE_MISSING"));
    };
    let grant = task_grant(db, task_id)?;
    let binding = identity.binding_id.as_deref();
    if binding != grant.as_deref() {
        return Ok(revoked());
    }
    let source = gateway_admission::Origin {
        channel_id: identity.channel_id,
        connection_key: identity.connection_key,
        chat_id: identity.chat_id,
        sender_id: identity.sender_id,
        message_id: String::new(),
    };
    if let Some(id) = binding {
        let active: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM gateway_dots_bindings WHERE id=? AND channel_id=?
                AND connection_key=? AND sender_id=? AND active=1)",
            params![id, source.channel_id, source.connection_key, source.sender_id],
            |row| row.get(0),
        )?;
        if !active || identity.audience != "private" {
            return Ok(revoked());
        }
    }
    let channel = &source.channel_id;
    let space = format!("sp-gw-{channel}");
    if channel_name(channel).is_none() || !owns_scope(&task, channel, &space)
        || space_state(db, ROOT_SPACE, None, None)? != Some(true)
        || space_state(db, &space, Some(ROOT_SPACE), Some(&channel_path(db, channel)?))? != Some(true) {
        return Ok(denied("TASK_SCOPE_CHANGED"));
    }
    if !gateway_admission::channel_allows(db, &source, &identity.platform)? {
        return Ok(if binding.is_some() { revoked() } else { denied("CHANNEL_AUTHORIZATION_CHANGED") });
    }
    Ok(json!({ "status": "allowed", "channelId": channel, "connectionKey": source.connection_key,
        "chatId": source.chat_id, "senderId": source.sender_id, "audience": identity.audience,
        "memory": if binding.is_some() { "active" } else { "none" }, "bindingId": binding }))
}

pub fn write(db: &mut Connection, request: Materialize) -> Result<Value> {
    let tx = db.transaction()?;
    match materialize(&tx, request) {
        Ok(result) => {
            crate::request_control::commit(tx)?;
            Ok(result)
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            Err(error)
        }
    }
}

fn materialize(db: &Connection, request: Materialize) -> Result<Value> {
    let Materialize { origin, task_id, model_id } = request;
    let source = &origin.source;
    let channel = &source.channel_id;
    let Some(name) = channel_name(channel) else {
        return Ok(denied("INVALID_CHANNEL"));
    };
    if !gateway_task_id(&task_id) {
        return Ok(denied("INVALID_TASK"));
    }
    let assignment = gateway_admission::assignment(db, source.clone())?;
    if assignment["status"] != "assigned" || assignment["taskId"] != task_id || assignment["command"] != false
        || assignment["personalMemoryBindingId"].as_str() != origin.personal_memory_binding_id.as_deref() {
        return Ok(denied("ASSIGNMENT_CHANGED"));
    }
    let (platform, audience, text): (String, String, String) = db.query_row(
        "SELECT platform,coalesce(json_extract_string(payload_json,'$.audience'),'shared'),
            json_extract_string(payload_json,'$.text') FROM gateway_inbox
         WHERE channel_id=? AND account_key=? AND chat_id=? AND message_id=?",
        params![channel, source.connection_key, source.chat_id, source.message_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if audience != origin.audience || !matches!(audience.as_str(), "private" | "shared")
        || (audience == "shared" && origin.personal_memory_binding_id.is_some()) {
        return Ok(denied("AUDIENCE_CHANGED"));
    }

    let child_id = format!("sp-gw-{channel}");
    let path = channel_path(db, channel)?;
    let root_owned = space_state(db, ROOT_SPACE, None, None)?;
    let child_owned = space_state(db, &child_id, Some(ROOT_SPACE), Some(&path))?;
    if root_owned == Some(false) || child_owned == Some(false) {
        return Ok(denied("TASK_SCOPE_CHANGED"));
    }
    let task = task_scope(db, &task_id)?;
    if let Some(task) = &task {
        if task.archived_or_trashed {
            return Ok(denied("TASK_ARCHIVED_OR_TRASHED"));
        }
        if !owns_scope(task, channel, &child_id) || root_owned != Some(true) || child_owned != Some(true) {
            return Ok(denied("TASK_SCOPE_CHANGED"));
        }
    } else {
        if assignment["currentTaskId"] != task_id {
            return Ok(denied("GENERATION_CHANGED"));
        }
        let occupied: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM gateway_sidebar_conversations WHERE task_id=?1)
                 OR EXISTS(SELECT 1 FROM work_execution_bindings WHERE task_id=?1)
                 OR EXISTS(SELECT 1 FROM task_execution_workspace_state WHERE task_id=?1)
                 OR EXISTS(SELECT 1 FROM durable_bot_bindings WHERE task_id=?1)",
            [&task_id], |row| row.get(0),
        )?;
        if occupied {
            return Ok(denied("TASK_SCOPE_CHANGED"));
        }
    }
    let identity = ExecutionIdentity { channel_id: channel.clone(), connection_key: source.connection_key.clone(),
        chat_id: source.chat_id.clone(), sender_id: source.sender_id.clone(), platform, audience,
        binding_id: origin.personal_memory_binding_id };
    if task_grant(db, &task_id)? != identity.binding_id {
        return Ok(revoked());
    }
    let recorded_identity = read_identity(db, &task_id)?;
    if recorded_identity.as_ref().is_some_and(|previous| previous != &identity) {
        return Ok(denied("SOURCE_CHANGED"));
    }
    let created = task.is_none();
    if created {
        let now = i64::try_from(crate::request_control::now_ms())?;
        if root_owned.is_none() {
            ensure_gateway_space_in_tx(db, ROOT_SPACE, "网关助理", None, None, now)?;
        }
        if child_owned.is_none() {
            ensure_gateway_space_in_tx(db, &child_id, name, Some(ROOT_SPACE), path.to_str(), now)?;
        }
        let title: String = text.trim().chars().take(60).collect();
        db.execute(
            "INSERT INTO tasks(id,title,space_id,updated_at,welcome_mode,mode_preset_id,model_id)
             VALUES (?,?,?,?,'working','general-office',?)",
            params![task_id, if title.is_empty() { "助理" } else { &title }, child_id, now, model_id],
        )?;
        db.execute("INSERT INTO gateway_sidebar_conversations(task_id,channel_id) VALUES (?,?)", params![task_id, channel])?;
    }
    if recorded_identity.is_none() {
        db.execute("INSERT INTO gateway_execution_sources VALUES (?,?,?,?,?,?,?,?)",
            params![task_id, identity.channel_id, identity.connection_key, identity.chat_id,
                identity.sender_id, identity.platform, identity.audience, identity.binding_id])?;
    }
    Ok(json!({ "status": "ready", "created": created }))
}
