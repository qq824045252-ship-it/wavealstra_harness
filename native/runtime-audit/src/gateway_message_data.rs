use crate::database::{DbError, classify_duckdb_error};
use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{Connection, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

/// Rows the log keeps; the host write prunes to the same bound.
const RETAINED_MESSAGES: i64 = 3000;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Append {
    channel_id: String,
    chat_id: String,
    direction: String,
    sender_id: Option<String>,
    sender_name: Option<String>,
    text: String,
    at: f64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteReply {
    Saved,
    NeedsHost,
}

/// Appends one log row, then prunes to the retained bound.
///
/// A transport retry replays the identical event, so the append is idempotent on the
/// event identity. A different text at the same instant is a different event and still
/// appends. A busy log is reported as `needsHost` instead of a lost row: the host write
/// owns its own connection, so it can still land.
pub fn append(db: &mut Connection, message: &Append) -> Result<WriteReply> {
    match apply(db, message) {
        Ok(()) => Ok(WriteReply::Saved),
        Err(error) if matches!(classify_duckdb_error(&error.to_string()), DbError::Busy(_)) => {
            Ok(WriteReply::NeedsHost)
        }
        Err(error) => Err(error.into()),
    }
}

fn apply(db: &mut Connection, message: &Append) -> duckdb::Result<()> {
    let tx = db.transaction()?;
    let next_id: i64 = tx.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM gateway_messages", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO gateway_messages (id, channel_id, chat_id, direction, sender_id, sender_name, text, created_at)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8
         WHERE NOT EXISTS (
           SELECT 1 FROM gateway_messages
           WHERE channel_id=?2 AND chat_id=?3 AND direction=?4 AND created_at=?8 AND text=?7
             AND coalesce(sender_id,'')=coalesce(?5,''))",
        params![
            next_id,
            message.channel_id,
            message.chat_id,
            message.direction,
            message.sender_id,
            message.sender_name,
            message.text,
            message.at,
        ],
    )?;
    tx.execute(
        "DELETE FROM gateway_messages WHERE id NOT IN (
           SELECT id FROM gateway_messages ORDER BY created_at DESC, id DESC LIMIT ?1
         )",
        params![RETAINED_MESSAGES],
    )?;
    tx.commit()
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
    params.push(Value::BigInt(query.limit.clamp(1, 1_000)));
    let mut stmt = db.prepare(&sql)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let db = Connection::open_in_memory().expect("open fixture database");
        db.execute_batch(
            "CREATE TABLE gateway_messages (
               id BIGINT PRIMARY KEY,
               channel_id VARCHAR NOT NULL,
               chat_id VARCHAR NOT NULL DEFAULT '',
               direction VARCHAR NOT NULL,
               sender_id VARCHAR,
               sender_name VARCHAR,
               text VARCHAR NOT NULL,
               created_at BIGINT NOT NULL
             );
             CREATE INDEX idx_gateway_messages_chat
               ON gateway_messages(channel_id, chat_id, created_at);",
        )
        .expect("create gateway_messages fixture");
        db
    }

    fn event(text: &str, at: f64) -> Append {
        Append {
            channel_id: "telegram-default".into(),
            chat_id: "123".into(),
            direction: "in".into(),
            sender_id: None,
            sender_name: None,
            text: text.into(),
            at,
        }
    }

    fn count(db: &Connection) -> i64 {
        let sql = "SELECT count(*) FROM gateway_messages";
        db.query_row(sql, [], |row| row.get(0)).expect("count rows")
    }

    fn saved(db: &mut Connection, message: &Append) {
        assert!(matches!(append(db, message), Ok(WriteReply::Saved)));
    }

    #[test]
    fn replaying_an_identical_event_stores_one_row() {
        let mut db = database();
        saved(&mut db, &event("你好", 1000.0));
        saved(&mut db, &event("你好", 1000.0));
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn a_different_text_at_the_same_instant_still_appends() {
        let mut db = database();
        saved(&mut db, &event("先", 1000.0));
        saved(&mut db, &event("后", 1000.0));
        assert_eq!(count(&db), 2);
    }

    #[test]
    fn a_sender_change_is_a_different_event() {
        let mut db = database();
        let anonymous = event("hi", 1000.0);
        let mut identified = event("hi", 1000.0);
        identified.sender_id = Some("456".into());
        saved(&mut db, &anonymous);
        saved(&mut db, &identified);
        assert_eq!(count(&db), 2);
    }

    #[test]
    fn the_log_prunes_to_the_retained_bound() {
        let mut db = database();
        for index in 0..RETAINED_MESSAGES + 10 {
            let message = event(&format!("msg-{index}"), 1_000.0 + index as f64);
            saved(&mut db, &message);
        }
        assert_eq!(count(&db), RETAINED_MESSAGES);
        let oldest: String = db
            .query_row(
                "SELECT text FROM gateway_messages ORDER BY created_at, id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read oldest row");
        assert_eq!(oldest, "msg-10");
    }
}
