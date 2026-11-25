use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    channel_id: Option<String>,
    chat_id: Option<String>,
    limit: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    id: i64,
    channel_id: String,
    chat_id: String,
    direction: String,
    sender_id: Option<String>,
    sender_name: Option<String>,
    text: String,
    at: f64,
}

pub fn read(db: &Connection, query: Query) -> Result<Option<Vec<Message>>> {
    let mut sql = String::from(
        "SELECT id,channel_id,chat_id,direction,sender_id,sender_name,text,created_at
         FROM gateway_messages WHERE 1=1",
    );
    let mut params = Vec::new();
    if let Some(channel) = query.channel_id.filter(|id| !id.is_empty()) {
        sql.push_str(" AND channel_id=?");
        params.push(Value::Text(channel));
    }
    if let Some(chat) = query.chat_id.filter(|id| !id.is_empty()) {
        sql.push_str(" AND chat_id=?");
        params.push(Value::Text(chat));
    }
    sql.push_str(" ORDER BY created_at DESC,id DESC LIMIT ?");
    params.push(Value::Integer(query.limit.clamp(1, 1_000)));
    let mut stmt = db.prepare_cached(&sql)?;
    let messages = stmt.query_map(params_from_iter(params), |row| {
        Ok(Message {
            id: row.get(0)?,
            channel_id: row.get(1)?,
            chat_id: row.get(2)?,
            direction: row.get(3)?,
            sender_id: row.get(4)?,
            sender_name: row.get(5)?,
            text: row.get(6)?,
            at: row.get(7)?,
        })
    })?;
    let mut result = Vec::new();
    let mut bytes = 128;
    for message in messages {
        let message = message?;
        bytes += serde_json::to_vec(&message)?.len() + 1;
        if bytes >= MAX_REPLY_BYTES {
            return Ok(None);
        }
        result.push(message);
    }
    result.reverse();
    Ok(Some(result))
}
