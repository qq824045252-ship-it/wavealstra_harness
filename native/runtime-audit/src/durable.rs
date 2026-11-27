use crate::Result;
use crate::database::{DuckDbEngine, ensure_readonly_sql_safe, value_ref_to_json};
use duckdb::{Connection, OptionalExt, params, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
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
        path: Option<PathBuf>,
        store_id: Option<String>,
        expected_incarnation: Option<String>,
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

pub(crate) struct HistorySession {
    store_id: String,
    incarnation: String,
}

pub fn store_id_for_path(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches(['/', '\\']).to_owned()
}

pub fn read(
    engine: &DuckDbEngine,
    sessions: &mut HashMap<String, HistorySession>,
    session: String,
    action: Action,
) -> Result<Value> {
    match action {
        Action::Open { path, store_id, expected_incarnation } => {
            if sessions.len() >= 16 || sessions.contains_key(&session) {
                return Err("cannot admit another Durable snapshot".into());
            }
            let resolved_store = match store_id {
                Some(id) if !id.is_empty() => id,
                _ => {
                    let p = path.ok_or("Durable Open requires storeId or path")?;
                    store_id_for_path(&p)
                }
            };
            let reader = engine.checkout_reader(Duration::from_secs(2))?;
            let incarnation = crate::pi_storage::live_incarnation_key(reader.conn(), &resolved_store)?
                .ok_or("Durable store is unavailable")?;
            if expected_incarnation.is_some_and(|expected| expected != incarnation) {
                return Err("Durable store was replaced before the snapshot opened".into());
            }
            sessions.insert(session, HistorySession { store_id: resolved_store, incarnation });
            return Ok(Value::Bool(true));
        }
        Action::Close => {
            sessions.remove(&session);
            return Ok(Value::Bool(true));
        }
        _ => {}
    }
    let handle = sessions
        .get(&session)
        .ok_or("Durable snapshot is closed")?;
    let mut conn = engine.checkout_reader(Duration::from_secs(5))?;
    let snapshot = conn.conn_mut().transaction()?;
    let current = crate::pi_storage::live_incarnation_key(&snapshot, &handle.store_id)?;
    if current.as_deref() != Some(handle.incarnation.as_str()) {
        sessions.remove(&session);
        return Err("Durable snapshot was retired".into());
    }
    let result = match action {
        Action::Select {
            sql,
            parameters,
            first,
        } => select(&snapshot, &handle.store_id, &sql, parameters, first),
        Action::Head {
            conversation_id,
            max_tokens,
        } => head(&snapshot, &handle.store_id, conversation_id, max_tokens).map(Value::String),
        Action::Questions {
            conversation_id,
            before_entry_id,
        } => questions(&snapshot, &handle.store_id, conversation_id, before_entry_id),
        _ => unreachable!(),
    }?;
    snapshot.rollback()?;
    Ok(result)
}

fn parameter(value: Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(text) => SqlValue::Text(text),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::BigInt(integer),
            None => SqlValue::Double(number.as_f64().ok_or("invalid DuckDB parameter")?),
        },
        Value::Bool(b) => SqlValue::Boolean(b),
        _ => return Err("unsupported DuckDB parameter".into()),
    })
}

fn select(
    db: &Connection,
    store_id: &str,
    sql: &str,
    parameters: Vec<Value>,
    first: bool,
) -> Result<Value> {
    ensure_readonly_sql_safe(sql)?;
    let _ = store_id;
    let mut statement = db.prepare(sql)?;
    let boxed = parameters
        .into_iter()
        .map(parameter)
        .collect::<Result<Vec<_>>>()?;
    let refs: Vec<&dyn duckdb::ToSql> = boxed.iter().map(|v| v as &dyn duckdb::ToSql).collect();
    let mut rows = statement.query(params_from_iter(refs))?;
    let names: Vec<String> = rows
        .as_ref()
        .map(|s| s.column_names())
        .unwrap_or_default();
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = value_ref_to_json(row.get_ref(index)?)?;
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
    store_id: &str,
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
                "SELECT record_json FROM durable_conversations WHERE store_id=?1 AND id=?2",
                params![store_id, current],
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
        "SELECT id, record_json FROM durable_entries WHERE store_id=?1 AND conversation_id=?2 AND id<=?3 ORDER BY id {direction} LIMIT ?4",
    ))?;
    let mut remaining = limit;
    for (conversation, ceiling) in segments {
        let mut rows = statement.query(params![store_id, conversation, ceiling, remaining as i64])?;
        while let Some(row) = rows.next()? {
            remaining -= 1;
            let entry_id: i64 = row.get(0)?;
            let raw: String = row.get(1)?;
            if !visit(entry_id, &raw)? || remaining == 0 {
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

fn head(db: &Connection, store_id: &str, conversation_id: i64, max_tokens: f64) -> Result<String> {
    let mut parts = Vec::new();
    let mut estimated = 0;
    visit_entries(db, store_id, conversation_id, i64::MAX, true, 4000, |_, raw| {
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
            let cjk = content
                .chars()
                .filter(|ch| {
                    matches!(
                        ch,
                        '\u{3400}'..='\u{9fff}'
                            | '\u{f900}'..='\u{faff}'
                            | '\u{3040}'..='\u{30ff}'
                            | '\u{ac00}'..='\u{d7af}'
                    )
                })
                .count();
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

fn questions(
    db: &Connection,
    store_id: &str,
    conversation_id: i64,
    before_entry_id: Option<i64>,
) -> Result<Value> {
    let mut questions = Vec::new();
    let mut next_before = None;
    let mut scanned = 0;
    visit_entries(
        db,
        store_id,
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
