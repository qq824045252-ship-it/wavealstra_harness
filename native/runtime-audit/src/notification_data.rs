use crate::Result;
use duckdb::types::Value as SqlValue;
use duckdb::{Connection, params, params_from_iter};
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
    Activation {
        id: String,
        now: i64,
    },
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
        Query::Activation { id, now } => activation(db, &id, now),
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

const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const DESKTOP_DEDUPE_MS: i64 = 6 * 60 * 60 * 1000;

fn activation(db: &Connection, id: &str, now: i64) -> Result<Value> {
    // Selection and existence checks use the same snapshot, including the bot and team binding.
    let target: Option<String> = db.query_row(
        "WITH stored AS (
           SELECT target_json FROM notification_activation_targets WHERE notification_id=?1 AND created_at>=?2
         ), candidate AS (
           SELECT CASE WHEN json_valid(target_json) THEN target_json END AS target_json FROM stored
           UNION ALL
           SELECT CAST(CASE
             WHEN task_id <> '' THEN json_object('kind','task','taskId',task_id)
             WHEN project_id <> '' THEN json_object('kind','project','projectId',project_id)
             WHEN source_type IN ('automation','runtime') THEN json_object('kind',source_type)
           END AS VARCHAR)
           FROM notifications WHERE id=?1 AND created_at>=?2 AND NOT EXISTS (SELECT 1 FROM stored)
         ), target AS (
           SELECT target_json, json_extract_string(target_json,'$.kind') AS kind FROM candidate
         )
         SELECT (SELECT target_json FROM target WHERE
           kind IN ('automation','runtime') OR
           (kind='task' AND EXISTS (SELECT 1 FROM tasks WHERE id=json_extract_string(target_json,'$.taskId'))) OR
           (kind='project' AND EXISTS (SELECT 1 FROM projects WHERE id=json_extract_string(target_json,'$.projectId'))) OR
           (kind='work' AND EXISTS (SELECT 1 FROM works w JOIN bots b ON b.bot_id=w.owner_bot_id
             WHERE w.work_id=json_extract_string(target_json,'$.workId'))) OR
           (kind='botConversation' AND EXISTS (SELECT 1 FROM bot_conversations c JOIN bots b ON b.bot_id=c.bot_id
             WHERE c.conversation_id=json_extract_string(target_json,'$.conversationId')
               AND c.bot_id=json_extract_string(target_json,'$.botId')
               AND c.team_id IS NOT DISTINCT FROM json_extract_string(target_json,'$.teamId'))))",
        params![id, now.saturating_sub(RETENTION_MS)],
        |row| row.get(0),
    )?;
    Ok(
        serde_json::json!({ "target": target.map(|json| serde_json::from_str::<Value>(&json)).transpose()? }),
    )
}

pub(crate) fn unread_count(db: &Connection) -> duckdb::Result<i64> {
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
        bindings.extend([
            SqlValue::Double(cursor.created_at),
            SqlValue::Text(cursor.id),
        ]);
        if !grouped {
            predicates.push("(created_at, id) < (?, ?)".into());
        }
    }
    bindings.push(SqlValue::BigInt(i64::from(limit)));
    let predicate = predicates.join(" AND ");
    let sql = if grouped {
        grouped_sql(&predicate, has_cursor)
    } else {
        format!(
            "SELECT n.*, (SELECT a.target_json FROM notification_activation_targets a WHERE a.notification_id = n.id) AS target_json
             FROM notifications n WHERE {predicate} ORDER BY created_at DESC, id DESC LIMIT ?"
        )
    };
    let mut statement = db.prepare(&sql)?;
    let mut cursor = statement.query(params_from_iter(bindings))?;
    let columns = cursor
        .as_ref()
        .map(|stmt| stmt.column_names())
        .unwrap_or_default();
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value = crate::database::value_ref_to_json(row.get_ref(index)?)?;
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
           SELECT *, CAST(CASE
             WHEN json_extract_string(target_json, '$.kind') = 'work'
               THEN json_array('work', json_extract_string(target_json, '$.workId'))
             WHEN json_extract_string(target_json, '$.kind') = 'botConversation'
               THEN json_array('conversation', json_extract_string(target_json, '$.botId'),
                 json_extract_string(target_json, '$.teamId'), json_extract_string(target_json, '$.conversationId'))
             WHEN COALESCE(json_extract_string(target_json, '$.taskId'), task_id) IS NOT NULL
               THEN json_array('task', COALESCE(json_extract_string(target_json, '$.taskId'), task_id), json_extract_string(target_json, '$.workId'))
             ELSE json_array('notification', id)
           END AS VARCHAR) AS group_key FROM visible
         ), ranked AS (
           SELECT *, count(*) OVER members AS group_count, COUNT(*) FILTER (WHERE read_at IS NULL) OVER members AS unread_count,
             row_number() OVER (PARTITION BY group_key ORDER BY created_at DESC, id DESC) AS position,
             first_value(id) OVER focus AS activation_id
           FROM grouped
           WINDOW members AS (PARTITION BY group_key),
             focus AS (PARTITION BY group_key ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END,
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
    Cleanup {
        now: i64,
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
    pub id: String,
    #[serde(rename = "type")]
    pub notification_type: String,
    pub level: String,
    pub title: String,
    pub body: Option<String>,
    pub source_type: String,
    pub source_id: Option<String>,
    pub task_id: Option<String>,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub dedupe_key: Option<String>,
    pub created_at: i64,
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
    let tx = db.transaction()?;
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
        Mutation::Cleanup { now } => cleanup(&tx, now)?,
        Mutation::Publish { record, target_json, in_app, desktop } => {
            insert(&tx, &record, target_json.as_deref(), in_app, desktop)?
        }
    };
    let count = unread_count(&tx)?;
    crate::request_control::commit(tx)?;
    Ok((changed, count))
}

fn cleanup(db: &Connection, now: i64) -> Result<bool> {
    let cutoff = now.saturating_sub(RETENTION_MS);
    db.execute(
        "DELETE FROM notification_desktop_claims WHERE claimed_at<?1",
        [now.saturating_sub(DESKTOP_DEDUPE_MS)],
    )?;
    db.execute(
        "DELETE FROM notification_activation_targets WHERE created_at<?1 OR notification_id IN
          (SELECT notification_id FROM notification_activation_targets ORDER BY created_at DESC, notification_id DESC OFFSET 1000)",
        [cutoff],
    )?;
    Ok(db.execute(
        "DELETE FROM notifications WHERE created_at<?1 OR id IN
          (SELECT id FROM notifications ORDER BY created_at DESC, id DESC OFFSET 1000)",
        [cutoff],
    )? > 0)
}

pub(crate) fn insert(
    db: &Connection,
    record: &Notification,
    target_json: Option<&str>,
    in_app: bool,
    desktop: bool,
) -> Result<bool> {
    let now = crate::core_lease::now_ms() as i64;
    let cutoff = now.saturating_sub(DESKTOP_DEDUPE_MS);
    if let Some(key) = record.dedupe_key.as_deref() {
        let recent_claim: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM notification_desktop_claims WHERE dedupe_key=?1 AND claimed_at>=?2)",
            params![key, cutoff],
            |row| row.get(0),
        )?;
        if recent_claim {
            return Ok(false);
        }
        if !in_app && desktop {
            let in_bell: bool = db.query_row(
                "SELECT EXISTS (SELECT 1 FROM notifications WHERE dedupe_key=?1)",
                [key],
                |row| row.get(0),
            )?;
            if in_bell {
                return Ok(false);
            }
            db.execute(
                "INSERT INTO notification_desktop_claims VALUES (?1,?2)
                 ON CONFLICT(dedupe_key) DO UPDATE SET claimed_at=excluded.claimed_at",
                params![key, now],
            )?;
        }
    }
    let inserted = in_app && db.execute(
        "INSERT INTO notifications
         (id,type,level,title,body,source_type,source_id,task_id,project_id,workspace_id,dedupe_key,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT DO NOTHING",
        params![record.id, record.notification_type, record.level, record.title, record.body,
            record.source_type, record.source_id, record.task_id, record.project_id, record.workspace_id,
            record.dedupe_key, record.created_at],
    )? > 0;
    let accepted = inserted || (!in_app && desktop);
    if let Some(target_json) = target_json.filter(|_| accepted) {
        db.execute(
            "INSERT INTO notification_activation_targets (notification_id,target_json,created_at) VALUES (?1,?2,?3)
             ON CONFLICT(notification_id) DO UPDATE SET target_json = excluded.target_json, created_at = excluded.created_at",
            params![record.id, target_json, record.created_at],
        )?;
    }
    Ok(accepted)
}
