use crate::Result;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Open {
        path: PathBuf,
    },
    Select {
        sql: String,
        parameters: Vec<Value>,
        first: bool,
    },
    Head {
        conversation_id: i64,
        max_tokens: f64,
    },
    Questions {
        conversation_id: i64,
        before_entry_id: Option<i64>,
    },
    Close,
}

pub fn read(
    sessions: &mut HashMap<String, Connection>,
    session: String,
    action: Action,
) -> Result<Value> {
    match action {
        Action::Open { path } => {
            if sessions.len() >= 16 || sessions.contains_key(&session) {
                return Err("cannot admit another Durable snapshot".into());
            }
            sessions.insert(session, open_snapshot(&path)?);
            return Ok(Value::Bool(true));
        }
        Action::Close => {
            sessions.remove(&session);
            return Ok(Value::Bool(true));
        }
        _ => {}
    }
    let db = sessions.get(&session).ok_or("Durable snapshot is closed")?;
    match action {
        Action::Select {
            sql,
            parameters,
            first,
        } => select(db, &sql, parameters, first),
        Action::Head {
            conversation_id,
            max_tokens,
        } => head(db, conversation_id, max_tokens).map(Value::String),
        Action::Questions {
            conversation_id,
            before_entry_id,
        } => questions(db, conversation_id, before_entry_id),
        _ => unreachable!(),
    }
}

fn open_snapshot(path: &Path) -> Result<Connection> {
    // A read-only SQLite WAL connection can create sidecars. Durable uses DELETE journals.
    let mut header = [0_u8; 20];
    File::open(path)?.read_exact(&mut header)?;
    if &header[..16] != b"SQLite format 3\0" || header[18..] != [1, 1] {
        return Err("Durable snapshot requires a rollback-journal SQLite file".into());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.execute_batch("PRAGMA query_only = ON; BEGIN")?;
    Ok(db)
}

fn parameter(value: Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(text) => SqlValue::Text(text),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => SqlValue::Real(number.as_f64().ok_or("invalid SQLite parameter")?),
        },
        _ => return Err("unsupported SQLite parameter".into()),
    })
}

fn select(db: &Connection, sql: &str, parameters: Vec<Value>, first: bool) -> Result<Value> {
    // Only the existing passive Pi SQLite reader uses this internal adapter.
    if !sql
        .trim_start()
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("select "))
    {
        return Err("expected a Durable SELECT".into());
    }
    let mut statement = db.prepare_cached(sql)?;
    if !statement.readonly() {
        return Err("Durable query has side effects".into());
    }
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let parameters = parameters
        .into_iter()
        .map(parameter)
        .collect::<Result<Vec<_>>>()?;
    let mut rows = statement.query(params_from_iter(parameters))?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(integer) => integer.into(),
                ValueRef::Real(number) => number.into(),
                ValueRef::Text(text) => std::str::from_utf8(text)?.into(),
                ValueRef::Blob(_) => return Err("unsupported SQLite result column".into()),
            };
            record.insert(name.clone(), value);
        }
        if first {
            return Ok(Value::Object(record));
        }
        records.push(Value::Object(record));
    }
    Ok(if first { Value::Null } else { records.into() })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Parent {
    conversation_id: i64,
    at: i64,
}

#[derive(Deserialize)]
struct Conversation {
    parent: Option<Parent>,
}

fn visit_entries(
    db: &Connection,
    conversation_id: i64,
    mut upper: i64,
    oldest_first: bool,
    limit: usize,
    mut visit: impl FnMut(i64, &str) -> Result<bool>,
) -> Result<()> {
    let mut segments = Vec::new();
    let mut current = conversation_id;
    loop {
        let record: Option<String> = db
            .query_row(
                "SELECT record FROM conversations WHERE id=?1",
                [current],
                |row| row.get(0),
            )
            .optional()?;
        let conversation: Conversation =
            serde_json::from_str(&record.ok_or("missing Durable conversation")?)?;
        segments.push((current, upper));
        let Some(parent) = conversation.parent else {
            break;
        };
        if parent.conversation_id >= current {
            return Err("invalid Durable branch parent".into());
        }
        current = parent.conversation_id;
        upper = upper.min(parent.at);
    }
    let direction = if oldest_first {
        segments.reverse();
        "ASC"
    } else {
        "DESC"
    };
    let mut statement = db.prepare(&format!(
        "SELECT id,record FROM entries WHERE conversation_id=?1 AND id<=?2 ORDER BY id {direction} LIMIT ?3",
    ))?;
    let mut remaining = limit;
    for (conversation, ceiling) in segments {
        let mut rows = statement.query(params![conversation, ceiling, remaining])?;
        while let Some(row) = rows.next()? {
            remaining -= 1;
            if !visit(row.get(0)?, row.get_ref(1)?.as_str()?)? || remaining == 0 {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn text(content: &Value) -> Result<String> {
    if let Some(plain) = content.as_str() {
        return Ok(plain.to_owned());
    }
    let mut text = String::new();
    if let Some(parts) = content.as_array() {
        for part in parts.iter().filter(|part| part["type"] == "text") {
            text.push_str(part["text"].as_str().ok_or("invalid history text block")?);
        }
    }
    Ok(text)
}

fn trim(text: &str) -> &str {
    text.trim_matches(crate::javascript_whitespace)
}

fn head(db: &Connection, conversation_id: i64, max_tokens: f64) -> Result<String> {
    let mut parts = Vec::new();
    let mut estimated = 0;
    visit_entries(db, conversation_id, i64::MAX, true, 4000, |_, raw| {
        let entry: Value = serde_json::from_str(raw)?;
        if !matches!(
            entry["kind"].as_str(),
            Some("pi.user" | "mybuddy.user" | "pi.assistant")
        ) {
            return Ok(true);
        }
        for message in entry["model"].as_array().into_iter().flatten() {
            let prefix = match message["role"].as_str() {
                Some("user") => "用户",
                Some("assistant") => "助手",
                _ => continue,
            };
            let content = text(&message["content"])?;
            let content = trim(&content);
            if content.is_empty() {
                continue;
            }
            let cjk = content.chars().filter(|ch| matches!(ch,
                '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}' | '\u{3040}'..='\u{30ff}' | '\u{ac00}'..='\u{d7af}'
            )).count();
            estimated += cjk + (content.encode_utf16().count() - cjk).div_ceil(4);
            parts.push(format!("{prefix}：{content}"));
            if estimated as f64 >= max_tokens {
                return Ok(false);
            }
        }
        Ok(true)
    })?;
    Ok(parts.join("\n\n"))
}

fn questions(db: &Connection, conversation_id: i64, before_entry_id: Option<i64>) -> Result<Value> {
    let mut questions = Vec::new();
    let mut next_before = None;
    let mut scanned = 0;
    visit_entries(
        db,
        conversation_id,
        before_entry_id.unwrap_or(i64::MAX),
        false,
        2001,
        |id, raw| {
            if questions.len() == 200 || scanned == 2000 {
                next_before = Some(id);
                return Ok(false);
            }
            scanned += 1;
            let entry: Value = serde_json::from_str(raw)?;
            if !matches!(entry["kind"].as_str(), Some("pi.user" | "mybuddy.user")) {
                return Ok(true);
            }
            let Some(message) = entry["model"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|value| value["role"] == "user")
            else {
                return Ok(true);
            };
            let input = &entry["data"]["mybuddyInput"];
            let display = input["displayText"]
                .as_str()
                .filter(|_| input["text"].is_string() && input["attachments"].is_array());
            let content = match display {
                Some(display) => display.to_owned(),
                None => text(&message["content"])?,
            };
            if !trim(&content).is_empty() {
                questions.push(json!({ "id": format!("durable-{id}"), "text": content }));
            }
            Ok(true)
        },
    )?;
    questions.reverse();
    Ok(json!({ "questions": questions, "nextBefore": next_before }))
}
