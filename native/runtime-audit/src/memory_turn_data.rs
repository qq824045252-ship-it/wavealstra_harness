use crate::Result;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        task_id: Option<String>,
        extraction_state: Option<String>,
        query: Option<String>,
        limit: u32,
    },
    Detail {
        id: String,
    },
    Tasks,
    SkillLearningStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: String,
    task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_title: Option<String>,
    task_trashed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assistant_message_id: Option<String>,
    user_text: String,
    assistant_text: String,
    content_hash: String,
    captured_at: f64,
    extraction_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    extracted_at: Option<f64>,
    attempt_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    metadata_json: String,
}

#[derive(Serialize)]
struct TurnTask {
    id: String,
    title: String,
    trashed: bool,
}

const TURN_COLUMNS: &str = "m.id,m.task_id,m.session_id,m.user_message_id,m.assistant_message_id,
    m.user_text,m.assistant_text,m.content_hash,m.captured_at,m.extraction_state,m.extracted_at,
    m.attempt_count,m.last_error,m.metadata_json";
const TASK_TITLE: &str =
    "CASE WHEN b.bot_id IS NOT NULL THEN 'Bot 对话' ELSE NULLIF(t.title,'') END";
const TASK_JOINS: &str = "LEFT JOIN tasks t ON t.id=m.task_id
    LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
    LEFT JOIN bot_conversations c ON c.conversation_id=m.task_id AND c.user_id=?1 AND COALESCE(t.title,'')=''
    LEFT JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id";

pub fn read(db: &Connection, query: Query, user_id: &str) -> Result<Json> {
    let select = || {
        format!(
            "SELECT {TURN_COLUMNS},{TASK_TITLE},COALESCE(w.state='trashed',0) FROM memory_turns m {TASK_JOINS}"
        )
    };
    match query {
        Query::List {
            task_id,
            extraction_state,
            query,
            limit,
        } => {
            let mut sql = select();
            let mut values = vec![Value::Text(user_id.to_owned())];
            let mut conditions = Vec::new();
            if let Some(id) = task_id.filter(|id| !id.is_empty()) {
                conditions.push("m.task_id=?");
                values.push(Value::Text(id));
            }
            if let Some(state) = extraction_state.filter(|state| !state.is_empty()) {
                conditions.push("m.extraction_state=?");
                values.push(Value::Text(state));
            }
            if let Some(query) = query.filter(|query| !query.is_empty()) {
                conditions.push("(m.user_text LIKE ? OR m.assistant_text LIKE ?)");
                let pattern = Value::Text(format!("%{query}%"));
                values.extend([pattern.clone(), pattern]);
            }
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            sql.push_str(" ORDER BY m.captured_at DESC,m.rowid DESC LIMIT ?");
            values.push(Value::Integer(i64::from(limit.clamp(1, 2000))));
            let turns = db
                .prepare_cached(&sql)?
                .query_map(params_from_iter(values), map_turn)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"kind": "list", "turns": turns}))
        }
        Query::Detail { id } => {
            let turn = db
                .prepare_cached(&format!("{} WHERE m.id=?2", select()))?
                .query_row(params![user_id, id], map_turn)
                .optional()?;
            Ok(json!({"kind": "detail", "turn": turn}))
        }
        Query::Tasks => {
            let sql = format!("SELECT m.task_id,COALESCE({TASK_TITLE},'原任务已删除'),COALESCE(w.state='trashed',0)
                FROM (SELECT DISTINCT task_id FROM memory_turns) m {TASK_JOINS} ORDER BY t.title,m.task_id");
            let tasks = db
                .prepare_cached(&sql)?
                .query_map([user_id], |row| {
                    Ok(TurnTask {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        trashed: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"kind": "tasks", "tasks": tasks}))
        }
        Query::SkillLearningStatus => skill_learning_status(db, user_id),
    }
}

const SKILL_LEARNING_STATUS: &str = "
    WITH latest_procedures AS (
        SELECT id FROM memory_records WHERE kind='procedure' AND status='active'
        ORDER BY updated_at DESC,id DESC LIMIT 2000
    ), procedure_counts AS (
        SELECT COUNT(*) AS total, COUNT(*) FILTER (
            WHERE EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type<>'task')
        ) AS reusable FROM latest_procedures m
    ), pending_sources AS (
        SELECT task_id, COUNT(*) FILTER (WHERE extraction_state='failed') AS failed,
            COUNT(*) FILTER (WHERE extraction_state='pending' OR attempt_count<3) AS pending
        FROM memory_turns WHERE extraction_state IN ('pending','failed') GROUP BY task_id
    ), extraction_sources AS (
        SELECT m.failed,m.pending,CASE WHEN b.bot_id IS NOT NULL THEN b.status='active'
            ELSE t.id IS NOT NULL AND w.state IS NOT 'trashed'
                AND (NULLIF(t.project_id,'') IS NULL OR p.archived=0)
            END AS eligible
        FROM pending_sources m
        LEFT JOIN bot_conversations c ON c.conversation_id=m.task_id AND c.user_id=?1
        LEFT JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
        LEFT JOIN tasks t ON t.id=m.task_id
        LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
        LEFT JOIN projects p ON p.id=t.project_id
    ), turn_counts AS (
        SELECT COALESCE(SUM(failed),0) AS failed,
            COALESCE(SUM(failed) FILTER (WHERE eligible),0) AS retryable,
            COALESCE(SUM(pending) FILTER (WHERE eligible),0) AS pending
        FROM extraction_sources
    )
    SELECT p.total,p.reusable,t.failed,t.retryable,t.pending,
        (SELECT last_error FROM memory_turns WHERE extraction_state='failed' ORDER BY captured_at DESC LIMIT 1)
    FROM procedure_counts p CROSS JOIN turn_counts t";

fn skill_learning_status(db: &Connection, user_id: &str) -> Result<Json> {
    Ok(db
        .prepare_cached(SKILL_LEARNING_STATUS)?
        .query_row([user_id], |r| {
            Ok(json!({
                "kind": "skillLearningStatus",
                "procedures": r.get::<_, i64>(0)?,
                "reusableProcedures": r.get::<_, i64>(1)?,
                "failedTurns": r.get::<_, i64>(2)?,
                "retryableFailedTurns": r.get::<_, i64>(3)?,
                "pendingTurns": r.get::<_, i64>(4)?,
                "latestError": r.get::<_, Option<String>>(5)?
            }))
        })?)
}

fn nonempty(row: &Row<'_>, column: usize) -> rusqlite::Result<Option<String>> {
    Ok(row
        .get::<_, Option<String>>(column)?
        .filter(|value| !value.is_empty()))
}

fn map_turn(row: &Row<'_>) -> rusqlite::Result<Turn> {
    Ok(Turn {
        id: row.get(0)?,
        task_id: row.get(1)?,
        session_id: nonempty(row, 2)?,
        user_message_id: nonempty(row, 3)?,
        assistant_message_id: nonempty(row, 4)?,
        user_text: row.get(5)?,
        assistant_text: row.get(6)?,
        content_hash: row.get(7)?,
        captured_at: row.get(8)?,
        extraction_state: row.get(9)?,
        extracted_at: row.get(10)?,
        attempt_count: row.get(11)?,
        last_error: nonempty(row, 12)?,
        metadata_json: row.get(13)?,
        task_title: row.get(14)?,
        task_trashed: row.get(15)?,
    })
}
