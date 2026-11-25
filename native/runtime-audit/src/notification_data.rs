use crate::Result;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, TransactionBehavior, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        limit: u32,
        types: Option<Vec<String>>,
        query: String,
        unread_only: bool,
        grouped: bool,
        before: Option<Cursor>,
    },
    UnreadCount,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    created_at: f64,
    id: String,
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::UnreadCount => Ok(unread_count(db)?.into()),
        Query::List {
            limit,
            types,
            query,
            unread_only,
            grouped,
            before,
        } => list(
            db,
            limit.clamp(1, 500),
            types,
            query,
            unread_only,
            grouped,
            before,
        ),
    }
}

fn unread_count(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT count(*) FROM notifications WHERE dismissed_at IS NULL AND read_at IS NULL",
        [],
        |row| row.get(0),
    )
}

fn list(
    db: &Connection,
    limit: u32,
    types: Option<Vec<String>>,
    query: String,
    unread_only: bool,
    grouped: bool,
    before: Option<Cursor>,
) -> Result<Value> {
    let mut predicates = vec!["dismissed_at IS NULL".to_owned()];
    let mut bindings = Vec::new();
    if unread_only {
        predicates.push("read_at IS NULL".into());
    }
    if let Some(types) = types {
        if types.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let types = types.into_iter().take(32).collect::<Vec<_>>();
        let slots = vec!["?"; types.len()].join(", ");
        predicates.push(format!("type IN ({slots})"));
        bindings.extend(types.into_iter().map(SqlValue::Text));
    }
    if !query.is_empty() {
        predicates
            .push("(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)".into());
        bindings.extend([SqlValue::Text(query.clone()), SqlValue::Text(query)]);
    }
    let has_cursor = before.is_some();
    if let Some(cursor) = before {
        bindings.extend([SqlValue::Real(cursor.created_at), SqlValue::Text(cursor.id)]);
        if !grouped {
            predicates.push("(created_at, id) < (?, ?)".into());
        }
    }
    bindings.push(SqlValue::Integer(i64::from(limit)));
    let predicate = predicates.join(" AND ");
    let sql = if grouped {
        grouped_sql(&predicate, has_cursor)
    } else {
        format!(
            "SELECT n.*, (SELECT a.target_json FROM notification_activation_targets a WHERE a.notification_id = n.id) AS target_json
             FROM notifications n WHERE {predicate} ORDER BY created_at DESC, id DESC LIMIT ?"
        )
    };
    let mut statement = db.prepare_cached(&sql)?;
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut cursor = statement.query(params_from_iter(bindings))?;
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => Value::from(value),
                ValueRef::Real(value) => Value::from(value),
                ValueRef::Text(value) => Value::from(str::from_utf8(value)?),
                ValueRef::Blob(_) => return Err("unexpected binary notification column".into()),
            };
            object.insert(name.clone(), value);
        }
        result.push(Value::Object(object));
    }
    Ok(Value::Array(result))
}

fn grouped_sql(predicate: &str, has_cursor: bool) -> String {
    let cursor_filter = if has_cursor {
        "AND (created_at, id) < (?, ?)"
    } else {
        ""
    };
    format!(
        "WITH visible AS (
           SELECT n.*, CASE WHEN json_valid(a.target_json) THEN a.target_json END AS target_json
           FROM notifications n LEFT JOIN notification_activation_targets a ON a.notification_id = n.id
           WHERE {predicate}
         ), grouped AS (
           SELECT *, CASE
             WHEN json_extract(target_json, '$.kind') = 'work'
               THEN json_array('work', json_extract(target_json, '$.workId'))
             WHEN json_extract(target_json, '$.kind') = 'botConversation'
               THEN json_array('conversation', json_extract(target_json, '$.botId'),
                 json_extract(target_json, '$.teamId'), json_extract(target_json, '$.conversationId'))
             WHEN COALESCE(json_extract(target_json, '$.taskId'), task_id) IS NOT NULL
               THEN json_array('task', COALESCE(json_extract(target_json, '$.taskId'), task_id), json_extract(target_json, '$.workId'))
             ELSE json_array('notification', id)
           END AS group_key FROM visible
         ), ranked AS (
           SELECT *, count(*) OVER members AS group_count, sum(read_at IS NULL) OVER members AS unread_count,
             row_number() OVER (PARTITION BY group_key ORDER BY created_at DESC, id DESC) AS position,
             first_value(id) OVER focus AS activation_id
           FROM grouped
           WINDOW members AS (PARTITION BY group_key),
             focus AS (PARTITION BY group_key ORDER BY read_at IS NOT NULL,
               CASE WHEN read_at IS NULL THEN created_at END ASC,
               CASE WHEN read_at IS NULL THEN id END ASC, created_at DESC, id DESC)
         ), page AS (
           SELECT * FROM ranked WHERE position = 1 {cursor_filter}
           ORDER BY created_at DESC, id DESC LIMIT ?
         )
         SELECT p.*, a.target_json AS activation_json, a.title AS activation_title,
           a.body AS activation_body, a.created_at AS activation_created_at, a.task_id AS activation_task_id,
           a.project_id AS activation_project_id, a.source_type AS activation_source_type
         FROM page p JOIN visible a ON a.id = p.activation_id
         ORDER BY p.created_at DESC, p.id DESC"
    )
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    MarkRead {
        id: String,
        at: f64,
    },
    MarkReadByDedupeKey {
        dedupe_key: String,
        at: f64,
    },
    MarkAllRead {
        at: f64,
    },
    Dismiss {
        id: String,
        at: f64,
    },
    DismissAll {
        at: f64,
    },
    Publish {
        record: Notification,
        target_json: Option<String>,
        in_app: bool,
        desktop: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    id: String,
    #[serde(rename = "type")]
    notification_type: String,
    level: String,
    title: String,
    body: Option<String>,
    source_type: String,
    source_id: Option<String>,
    task_id: Option<String>,
    project_id: Option<String>,
    workspace_id: Option<String>,
    dedupe_key: Option<String>,
    created_at: f64,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Saved { changed: bool, unread_count: i64 },
    Rejected { message: String },
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Reply {
    match apply(db, mutation) {
        Ok((changed, unread_count)) => Reply::Saved {
            changed,
            unread_count,
        },
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, mutation: Mutation) -> Result<(bool, i64)> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = match mutation {
        Mutation::MarkRead { id, at } => tx.execute(
            "UPDATE notifications SET read_at=?1 WHERE id=?2 AND dismissed_at IS NULL AND read_at IS NULL",
            params![at, id],
        )? > 0,
        Mutation::MarkReadByDedupeKey { dedupe_key, at } => tx.execute(
            "UPDATE notifications SET read_at=?1 WHERE dedupe_key=?2 AND dismissed_at IS NULL AND read_at IS NULL",
            params![at, dedupe_key],
        )? > 0,
        Mutation::MarkAllRead { at } => tx.execute(
            "UPDATE notifications SET read_at=?1 WHERE dismissed_at IS NULL AND read_at IS NULL", [at],
        )? > 0,
        Mutation::Dismiss { id, at } => tx.execute(
            "UPDATE notifications SET dismissed_at=?1,read_at=coalesce(read_at,?1) WHERE id=?2 AND dismissed_at IS NULL",
            params![at, id],
        )? > 0,
        Mutation::DismissAll { at } => tx.execute(
            "UPDATE notifications SET dismissed_at=?1,read_at=coalesce(read_at,?1) WHERE dismissed_at IS NULL", [at],
        )? > 0,
        Mutation::Publish { record, target_json, in_app, desktop } => {
            insert(&tx, record, target_json, in_app, desktop)?
        }
    };
    let count = unread_count(&tx)?;
    tx.commit()?;
    Ok((changed, count))
}

fn insert(
    db: &Connection,
    record: Notification,
    target_json: Option<String>,
    in_app: bool,
    desktop: bool,
) -> Result<bool> {
    let inserted = in_app && db.execute(
        "INSERT OR IGNORE INTO notifications
         (id,type,level,title,body,source_type,source_id,task_id,project_id,workspace_id,dedupe_key,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![record.id, record.notification_type, record.level, record.title, record.body,
            record.source_type, record.source_id, record.task_id, record.project_id, record.workspace_id,
            record.dedupe_key, record.created_at],
    )? > 0;
    if let Some(target_json) = target_json.filter(|_| inserted || (!in_app && desktop)) {
        db.execute(
            "INSERT OR REPLACE INTO notification_activation_targets (notification_id,target_json,created_at) VALUES (?1,?2,?3)",
            params![record.id, target_json, record.created_at],
        )?;
    }
    Ok(inserted)
}
