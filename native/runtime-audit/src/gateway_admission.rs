use crate::Result;
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub platform: String,
    pub account_key: String,
    pub session_key: String,
    payload_json: String,
    replay_native_receipts: bool,
    max_pending: i64,
    max_receipts: i64,
    retention_ms: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub(crate) channel_id: String,
    pub(crate) connection_key: String,
    pub(crate) chat_id: String,
    pub(crate) sender_id: String,
    pub(crate) message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    version: u8,
    channel_id: String,
    chat_id: String,
    message_id: String,
    sender: Sender,
    text: String,
    audience: Option<String>,
    reply_route: Option<Value>,
}

#[derive(Deserialize)]
struct Sender {
    id: String,
}

type Route = (String, String);

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identity(value: Value) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&value)?))
}

fn scope_id(source: &Origin, binding: Option<&str>) -> Result<String> {
    let mut scope = vec![
        "conversation-v1",
        &source.channel_id,
        &source.connection_key,
        &source.chat_id,
        &source.sender_id,
    ];
    scope.extend(binding);
    Ok(format!("gateway-chat-{}", identity(json!(scope))?))
}

fn origin(message: &Payload, account_key: &str) -> Origin {
    Origin {
        channel_id: message.channel_id.clone(),
        chat_id: message.chat_id.clone(),
        sender_id: message.sender.id.clone(),
        message_id: message.message_id.clone(),
        connection_key: account_key.to_owned(),
    }
}

fn rejected(code: &str) -> Value {
    json!({ "status": "rejected", "code": code })
}

pub(crate) fn channel_allows(db: &Connection, origin: &Origin, platform: &str) -> Result<bool> {
    let config: Option<String> = db.query_row(
        "SELECT c.config_json FROM gateway_channels c LEFT JOIN core_gateway_channels g ON g.channel_id=c.id
         WHERE c.id=? AND c.type=? AND c.connected=1
           AND (g.channel_id IS NULL OR (g.paused=0 AND (g.account_key IS NULL OR g.account_key=?)))",
        params![origin.channel_id, platform, origin.connection_key],
        |row| row.get(0),
    ).optional()?;
    let Some(parsed) = config.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
        return Ok(false);
    };
    Ok(parsed["allowUsers"].as_array().is_some_and(|users| {
        users.iter().any(|value| match value {
            Value::String(id) => id.trim() == origin.sender_id,
            Value::Number(id) => id.to_string() == origin.sender_id,
            _ => false,
        })
    }))
}

fn private_route(message: &Payload) -> bool {
    let Some(route) = message.reply_route.as_ref() else {
        return false;
    };
    if message.audience.as_deref() != Some("private") {
        return false;
    }
    match (message.channel_id.as_str(), route["kind"].as_str()) {
        ("qq-default", Some("qq")) => {
            route["group"] == false
                && route["recipient"] == message.sender.id
                && message.chat_id == format!("c2c:{}", message.sender.id)
        }
        ("weixin-default", Some("weixin")) => {
            route["peer"] == message.sender.id && message.chat_id == message.sender.id
        }
        ("feishu-default", Some("feishu")) => {
            matches!(route.get("inThread"), None | Some(Value::Bool(false)))
                && route["chatId"] == message.chat_id
        }
        _ => false,
    }
}

fn private_admission(db: &Connection, origin: &Origin) -> Result<Option<Option<String>>> {
    Ok(db
        .query_row(
            "SELECT binding_id FROM gateway_dots_admissions
        WHERE channel_id=? AND connection_key=? AND chat_id=? AND message_id=?",
            params![
                origin.channel_id,
                origin.connection_key,
                origin.chat_id,
                origin.message_id
            ],
            |row| row.get(0),
        )
        .optional()?)
}

fn binding_current(db: &Connection, source: &Origin, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM gateway_dots_bindings
        WHERE id=? AND channel_id=? AND connection_key=? AND sender_id=? AND active=1)",
        params![
            id,
            source.channel_id,
            source.connection_key,
            source.sender_id
        ],
        |r| r.get(0),
    )?)
}

fn read_route(db: &Connection, scope: &str, delivery_key: &str) -> Result<Option<Route>> {
    Ok(db.query_row("SELECT task_id,kind FROM gateway_conversation_routes WHERE scope_id=? AND delivery_key=?",
        params![scope, delivery_key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?)
}

fn latest_task(db: &Connection, scope: &str) -> Result<String> {
    Ok(db.query_row("SELECT task_id FROM gateway_conversation_routes WHERE scope_id=? AND kind='new' ORDER BY seq DESC LIMIT 1",
        [scope], |row| row.get(0)).optional()?.unwrap_or_else(|| scope.to_owned()))
}

pub fn write_route(
    db: &Connection,
    scope: &str,
    receipt: &str,
    task: &str,
    kind: &str,
    at: i64,
) -> Result<()> {
    db.execute("INSERT INTO gateway_conversation_routes(seq,scope_id,delivery_key,task_id,kind,accepted_at)
        SELECT coalesce(max(seq),0)+1,?1,?2,?3,?4,?5 FROM gateway_conversation_routes
        ON CONFLICT(scope_id,delivery_key) DO NOTHING", params![scope, receipt, task, kind, at])?;
    Ok(())
}

pub(crate) fn retire_task_routes(db: &Connection, task_id: &str) -> Result<()> {
    let scopes = db.prepare(
        "SELECT DISTINCT scope_id FROM gateway_conversation_routes WHERE task_id=?",
    )?.query_map([task_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let now = i64::try_from(crate::request_control::now_ms())?;
    let receipt = identity(json!(["gateway-task-retirement-v1", task_id]))?;
    for scope in &scopes {
        if latest_task(db, scope)? != task_id {
            continue;
        }
        let next = format!(
            "gateway-chat-{}",
            identity(json!(["gateway-conversation-generation-v1", scope, receipt]))?
        );
        write_route(db, scope, &receipt, &next, "new", now)?;
    }
    Ok(())
}

pub fn inbox(db: &Connection, delivery: &str) -> Result<Value> {
    Ok(crate::sqlite_rows::records(
        db,
        "SELECT * FROM gateway_inbox WHERE delivery_id=?",
        [delivery],
    )?
    .into_iter()
    .next()
    .unwrap_or(Value::Null))
}

pub fn assignment(db: &Connection, source: Origin) -> Result<Value> {
    let saved: Option<(String, String)> = db.query_row(
        "SELECT platform,payload_json FROM gateway_inbox WHERE channel_id=? AND account_key=? AND chat_id=? AND message_id=?",
        params![source.channel_id,source.connection_key,source.chat_id,source.message_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional()?;
    let Some((platform, payload)) = saved else {
        return Ok(rejected("NOT_ADMITTED"));
    };
    let saved: Payload = serde_json::from_str(&payload)?;
    if saved.sender.id != source.sender_id || !channel_allows(db, &source, &platform)? {
        return Ok(rejected("AUTHORIZATION_CHANGED"));
    }
    let binding = private_admission(db, &source)?.flatten();
    if let Some(id) = binding.as_deref()
        && !binding_current(db, &source, id)?
    {
        return Ok(rejected("AUTHORIZATION_CHANGED"));
    }
    let scope = scope_id(&source, binding.as_deref())?;
    let receipt = identity(json!(["gateway-delivery-route-v1", source.message_id]))?;
    let Some((task, kind)) = read_route(db, &scope, &receipt)? else {
        return Ok(rejected("NOT_ADMITTED"));
    };
    let current = latest_task(db, &scope)?;
    let old_available = if task == current || kind != "turn" {
        true
    } else {
        db.query_row("SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=?1 AND t.archived=0
            AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed'))",
            [&task], |r| r.get(0))?
    };
    Ok(
        json!({ "status":"assigned", "taskId":task, "currentTaskId":current, "command":kind!="turn",
        "oldTaskAvailable":old_available, "personalMemoryBindingId":binding }),
    )
}

pub fn admit(db: &mut Connection, request: Admission) -> Result<Value> {
    let tx = db.transaction()?;
    match apply(&tx, request) {
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

fn apply(tx: &Transaction<'_>, request: Admission) -> Result<Value> {
    if request.payload_json.len() > 256 * 1024
        || request.max_pending < 1
        || request.max_receipts < 1
        || request.retention_ms < 1
        || request.account_key.len() != 64
        || !request
            .account_key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(rejected("INVALID_INPUT"));
    }
    let message: Payload = serde_json::from_str(&request.payload_json)?;
    if message.version != 1
        || [
            &message.channel_id,
            &message.chat_id,
            &message.message_id,
            &message.sender.id,
        ]
        .iter()
        .any(|part| part.trim().is_empty() || part.len() > 8192)
        || request.session_key.is_empty()
    {
        return Ok(rejected("INVALID_INPUT"));
    }
    let source = origin(&message, &request.account_key);
    if !channel_allows(tx, &source, &request.platform)? {
        return Ok(rejected("AUTHORIZATION_CHANGED"));
    }
    let delivery = identity(json!([
        "gateway-delivery-v1",
        request.platform,
        message.channel_id,
        request.account_key,
        message.chat_id,
        message.message_id
    ]))?;
    let previous = inbox(tx, &delivery)?;
    if !previous.is_null() {
        let stored: Payload = serde_json::from_str(
            previous["payload_json"]
                .as_str()
                .ok_or("missing stored Gateway payload")?,
        )?;
        if stored.text != message.text
            || stored.sender.id != message.sender.id
            || previous["session_key"] != request.session_key
        {
            return Ok(rejected("PAYLOAD_CONFLICT"));
        }
        let restored = assignment(tx, source)?;
        if restored["status"] != "assigned" {
            return Ok(restored);
        }
        if restored["personalMemoryBindingId"].is_string() && !private_route(&message) {
            return Ok(rejected("AUTHORIZATION_CHANGED"));
        }
        return Ok(json!({ "status":"accepted", "duplicate":true, "entry":previous }));
    }

    let count: i64 = tx.query_row(
        "SELECT count(*) FROM gateway_inbox WHERE status!='completed'",
        [],
        |r| r.get(0),
    )?;
    if count >= request.max_pending {
        return Ok(rejected("CAPACITY"));
    }
    let now = i64::try_from(crate::request_control::now_ms())?;
    let private = private_route(&message) && !message.message_id.starts_with("local:");
    let old_binding = if private {
        private_admission(tx, &source)?
    } else {
        None
    };
    let binding = match old_binding.as_ref() {
        Some(Some(id)) if !binding_current(tx, &source, id)? => {
            return Ok(rejected("AUTHORIZATION_CHANGED"));
        }
        Some(id) => id.clone(),
        None if private => tx
            .query_row(
                "SELECT id FROM gateway_dots_bindings WHERE channel_id=? AND connection_key=?
            AND sender_id=? AND active=1 AND bound_at<=?",
                params![
                    source.channel_id,
                    source.connection_key,
                    source.sender_id,
                    now
                ],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    if !private && private_admission(tx, &source)?.flatten().is_some() {
        return Ok(rejected("AUTHORIZATION_CHANGED"));
    }
    let scope = scope_id(&source, binding.as_deref())?;
    let receipt = identity(json!(["gateway-delivery-route-v1", source.message_id]))?;
    let command = message.text.trim() == "/new" && !message.message_id.starts_with("local:");
    let (task, kind) = match read_route(tx, &scope, &receipt)? {
        Some((task, kind)) if (kind != "turn") == command => (task, kind),
        Some(_) => return Ok(rejected("PAYLOAD_CONFLICT")),
        None if command => (
            format!(
                "gateway-chat-{}",
                identity(json!([
                    "gateway-conversation-generation-v1",
                    scope,
                    receipt
                ]))?
            ),
            "new".into(),
        ),
        None => (latest_task(tx, &scope)?, "turn".into()),
    };
    if let Some(id) = binding.as_deref()
        && kind == "turn"
    {
        let current: Option<String> = tx
            .query_row(
                "SELECT binding_id FROM gateway_dots_tasks WHERE task_id=?",
                [&task],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref().is_some_and(|existing| existing != id) {
            return Ok(rejected("AUTHORIZATION_CHANGED"));
        }
        tx.execute(
            "INSERT INTO gateway_dots_tasks VALUES (?,?) ON CONFLICT DO NOTHING",
            params![task, id],
        )?;
    }
    if private && old_binding.is_none() {
        tx.execute(
            "INSERT INTO gateway_dots_admissions VALUES (?,?,?,?,?)",
            params![
                source.channel_id,
                source.connection_key,
                source.chat_id,
                source.message_id,
                binding
            ],
        )?;
    }
    prune(
        tx,
        now.saturating_sub(request.retention_ms),
        request.max_receipts,
    )?;
    write_route(tx, &scope, &receipt, &task, &kind, now)?;
    let last_accepted: Option<i64> = tx.query_row(
        "SELECT max(created_at) FROM gateway_inbox WHERE channel_id=? AND account_key=? AND session_key=?",
        params![source.channel_id, source.connection_key, request.session_key], |row| row.get(0),
    )?;
    let ordered_at = last_accepted.map_or(now, |prior| now.max(prior.saturating_add(1)));
    let hash = digest(request.payload_json.as_bytes());
    let mode = if request.replay_native_receipts {
        "pi-durable"
    } else {
        "none"
    };
    tx.execute("INSERT INTO gateway_inbox(delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,payload_json,payload_hash,status,receipt_mode,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10,?11,?11)",
        params![delivery,request.platform,source.channel_id,source.connection_key,source.chat_id,request.session_key,source.message_id,request.payload_json,hash,mode,ordered_at])?;
    Ok(json!({ "status":"accepted", "duplicate":false, "entry":inbox(tx,&delivery)? }))
}

fn prune(tx: &Connection, cutoff: i64, max_receipts: i64) -> Result<()> {
    let ids = "SELECT delivery_id FROM gateway_inbox WHERE status='completed' AND updated_at<?1 UNION
        SELECT delivery_id FROM (SELECT delivery_id,row_number() OVER (ORDER BY updated_at DESC,delivery_id DESC) AS rank
          FROM gateway_inbox WHERE status='completed') WHERE rank>=?2";
    for table in [
        "gateway_outbox",
        "bot_gateway_continuations",
        "gateway_inbox",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE delivery_id IN ({ids})"),
            params![cutoff, max_receipts],
        )?;
    }
    Ok(())
}
