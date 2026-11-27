use crate::Result;
use duckdb::{params, Connection, OptionalExt, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    r#type: String,
    name: String,
    config_json: String,
    connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_text: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteChannel {
    pub channel: Channel,
    expected: Option<Channel>,
    expected_revision: Option<i64>,
    transition: Option<Transition>,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Transition {
    Connect {
        account_key: Option<String>,
        personal_memory_owner_id: Option<String>,
    },
    Restore {
        account_key: Option<String>,
    },
    Disconnect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelState {
    channel: Option<Channel>,
    revision: i64,
    isolation_installed_at: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteReply {
    Saved,
    Conflict,
    Invalid,
    OperationReused,
}

const COLUMNS: &str = "id,type,name,config_json,connected,status_text";

fn row_to_channel(row: &Row<'_>) -> duckdb::Result<Channel> {
    Ok(Channel {
        id: row.get(0)?,
        r#type: row.get(1)?,
        name: row.get(2)?,
        config_json: row.get(3)?,
        connected: row.get::<_, i64>(4)? != 0,
        status_text: row.get(5)?,
    })
}

fn by_id(db: &Connection, id: &str) -> Result<Option<Channel>> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM gateway_channels WHERE id=?"),
            [id],
            row_to_channel,
        )
        .optional()?)
}

fn version(db: &Connection, id: &str) -> Result<i64> {
    Ok(db
        .query_row(
            "SELECT revision FROM gateway_channel_revisions WHERE channel_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

pub fn read_state(db: &mut Connection, id: &str) -> Result<Value> {
    let tx = db.transaction()?;
    let state = ChannelState {
        channel: by_id(&tx, id)?,
        revision: version(&tx, id)?,
        isolation_installed_at: tx.query_row(
            "SELECT installed_at FROM gateway_memory_isolation WHERE singleton=1",
            [],
            |row| row.get(0),
        )?,
    };
    tx.commit()?;
    Ok(serde_json::to_value(state)?)
}

pub fn bump_revision(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "INSERT INTO gateway_channel_revisions VALUES (?,1)
        ON CONFLICT(channel_id) DO UPDATE SET revision=gateway_channel_revisions.revision+1",
        [id],
    )?;
    Ok(())
}

pub fn read(db: &Connection, channel_id: Option<String>) -> Result<Vec<Channel>> {
    if let Some(id) = channel_id {
        return Ok(by_id(db, &id)?.into_iter().collect());
    }
    let mut stmt = db.prepare(&format!(
        "SELECT {COLUMNS} FROM gateway_channels ORDER BY id"
    ))?;
    Ok(stmt
        .query_map([], row_to_channel)?
        .collect::<duckdb::Result<_>>()?)
}

pub fn write(db: &mut Connection, operation_id: &str, draft: WriteChannel) -> Result<WriteReply> {
    if operation_id.trim().is_empty()
        || operation_id.len() > 200
        || draft.channel.id.trim().is_empty()
        || draft
            .expected
            .as_ref()
            .is_some_and(|prior| prior.id != draft.channel.id)
    {
        return Ok(WriteReply::Invalid);
    }
    let tx = db.transaction()?;
    match write_in_tx(&tx, operation_id, draft) {
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

fn write_in_tx(
    tx: &Transaction<'_>,
    operation_id: &str,
    draft: WriteChannel,
) -> Result<WriteReply> {
    let scope = format!("gateway-channel:{}", draft.channel.id);
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&draft)?));
    let prior: Option<(String, String)> = tx.query_row(
        "SELECT request_hash,result_json FROM operation_receipts WHERE caller_scope=? AND operation_id=? AND batch_index=0",
        params![scope, operation_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((prior_hash, result)) = prior {
        return if hash == prior_hash {
            Ok(serde_json::from_str(&result)?)
        } else {
            Ok(WriteReply::OperationReused)
        };
    }
    let channel = draft.channel;
    let now = i64::try_from(crate::request_control::now_ms())?;
    let actual_revision = draft
        .expected_revision
        .map(|_| version(tx, &channel.id))
        .transpose()?;
    let reply = if by_id(tx, &channel.id)? != draft.expected
        || actual_revision != draft.expected_revision
    {
        WriteReply::Conflict
    } else if !valid_transition(
        &channel,
        draft.expected.as_ref(),
        draft.expected_revision,
        draft.transition.as_ref(),
    ) {
        WriteReply::Invalid
    } else {
        tx.execute(
            "INSERT INTO gateway_channels(id,type,name,config_json,connected,status_text) VALUES (?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET type=excluded.type,name=excluded.name,config_json=excluded.config_json,
                 connected=excluded.connected,status_text=excluded.status_text",
            params![channel.id, channel.r#type, channel.name, channel.config_json, i64::from(channel.connected), channel.status_text],
        )?;
        bump_revision(tx, &channel.id)?;
        if let Some(transition) = draft.transition {
            apply_transition(tx, &channel, operation_id, transition, now)?;
        }
        WriteReply::Saved
    };
    tx.execute(
        "INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
         VALUES (?,?,0,?,'committed',?,?)",
        params![scope, operation_id, hash, serde_json::to_string(&reply)?, now],
    )?;
    Ok(reply)
}

fn valid_transition(
    channel: &Channel,
    before: Option<&Channel>,
    revision: Option<i64>,
    transition: Option<&Transition>,
) -> bool {
    let Some(transition) = transition else {
        return true;
    };
    if revision.is_none() {
        return false;
    }
    let valid_key = |key: &str| {
        key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    match transition {
        Transition::Disconnect => !channel.connected,
        Transition::Restore { account_key } => {
            channel.connected
                && before == Some(channel)
                && account_key.as_deref().is_none_or(valid_key)
        }
        Transition::Connect {
            account_key,
            personal_memory_owner_id,
        } => {
            if !channel.connected || !account_key.as_deref().is_none_or(valid_key) {
                return false;
            }
            let Some(owner) = personal_memory_owner_id else {
                return true;
            };
            let supported = matches!(
                (channel.id.as_str(), channel.r#type.as_str()),
                ("qq-default", "qq") | ("weixin-default", "weixin") | ("feishu-default", "feishu")
            );
            supported
                && account_key.is_some()
                && !owner.trim().is_empty()
                && owner.len() <= 1024
                && serde_json::from_str::<Value>(&channel.config_json)
                    .ok()
                    .and_then(|cfg| {
                        cfg["allowUsers"].as_array().map(|users| {
                            users
                                .iter()
                                .any(|id| id.as_str().is_some_and(|id| id.trim() == owner))
                        })
                    })
                    == Some(true)
        }
    }
}

fn apply_transition(
    tx: &Transaction<'_>,
    channel: &Channel,
    operation_id: &str,
    transition: Transition,
    now: i64,
) -> Result<()> {
    let (account_key, preserve, new_owner) = match transition {
        Transition::Connect {
            account_key,
            personal_memory_owner_id,
        } => (account_key, false, personal_memory_owner_id),
        Transition::Restore { account_key } => (account_key, true, None),
        Transition::Disconnect => (None, false, None),
    };
    tx.execute(
        "UPDATE gateway_dots_bindings SET active=0 WHERE channel_id=?1 AND active=1
        AND (NOT ?2 OR connection_key IS DISTINCT FROM ?3)",
        params![channel.id, preserve, account_key],
    )?;
    if let Some(owner) = new_owner {
        let key = account_key
            .as_deref()
            .ok_or("missing Gateway grant account")?;
        let id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "gateway-private-memory",
                &channel.id,
                operation_id
            ))?)
        );
        tx.execute(
            "INSERT INTO gateway_dots_bindings VALUES (?,?,?,?,1,?)",
            params![id, channel.id, key, owner, now],
        )?;
    }
    let connected = i64::from(channel.connected);
    let status = if channel.connected {
        "connected"
    } else {
        "disconnected"
    };
    tx.execute("INSERT INTO core_gateway_channels(channel_id,channel_type,account_key,enabled,paused,status,last_connected_at_ms,updated_at_ms)
         VALUES (?1,?2,?3,?4,1-?4,?5,CASE WHEN ?4=1 THEN ?6 END,?6)
         ON CONFLICT(channel_id) DO UPDATE SET channel_type=excluded.channel_type, account_key=excluded.account_key,
         enabled=excluded.enabled, paused=excluded.paused, status=excluded.status, generation=core_gateway_channels.generation+1,
         offline_attempts=0, next_reconnect_at_ms=NULL, next_recover_at_ms=NULL, in_flight=0, error_message=NULL,
         last_connected_at_ms=COALESCE(excluded.last_connected_at_ms,core_gateway_channels.last_connected_at_ms), updated_at_ms=excluded.updated_at_ms",
        params![channel.id,channel.r#type,account_key,connected,status,now])?;
    Ok(())
}
