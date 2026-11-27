use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

const SELECT_BOT: &str = "SELECT b.*, (r.bot_id IS NOT NULL) AS is_primary FROM bots b
    LEFT JOIN bot_identity_roles r ON r.bot_id=b.bot_id AND r.user_id=b.user_id AND r.role='primary'";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Bot {
        bot_id: String,
    },
    List {
        user_id: String,
    },
    Channel {
        user_id: String,
        channel_type: String,
        channel_identifier: String,
    },
}

pub fn bot(db: &Connection, id: &str) -> Result<Value> {
    Ok(
        records(db, &format!("{SELECT_BOT} WHERE b.bot_id=?"), [id])?
            .pop()
            .unwrap_or(Value::Null),
    )
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Bot { bot_id } => bot(db, &bot_id),
        Query::List { user_id } => Ok(json!(records(
            db,
            &format!(
                "{SELECT_BOT}
            WHERE b.user_id=? ORDER BY b.created_at,b.bot_id"
            ),
            [user_id]
        )?)),
        Query::Channel {
            user_id,
            channel_type,
            channel_identifier,
        } => Ok(records(
            db,
            &format!(
                "{SELECT_BOT}
            JOIN bot_channel_bindings c ON c.bot_id=b.bot_id
            WHERE b.user_id=?1 AND c.channel_type=?2 AND c.channel_identifier=?3"
            ),
            params![user_id, channel_type, channel_identifier],
        )?
        .pop()
        .unwrap_or(Value::Null)),
    }
}
