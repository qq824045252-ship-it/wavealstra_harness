use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        task_id: String,
    },
    PendingCount {
        task_id: String,
    },
    Detail {
        task_id: String,
        id: String,
        max_preview_bytes: usize,
    },
}

#[derive(Serialize)]
struct FileRow {
    id: String,
    relative_path: String,
    before_present: bool,
    after_present: bool,
    additions: i64,
    deletions: i64,
    stats_available: bool,
    status: String,
    capture_reason: Option<String>,
    failure_reason: Option<String>,
}

impl FileRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            relative_path: row.get(1)?,
            before_present: row.get(2)?,
            after_present: row.get(3)?,
            additions: row.get(4)?,
            deletions: row.get(5)?,
            stats_available: row.get(6)?,
            status: row.get(7)?,
            capture_reason: row.get(8)?,
            failure_reason: row.get(9)?,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDetail {
    file: FileRow,
    too_large: bool,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Data {
    List { files: Vec<FileRow> },
    PendingCount { count: i64 },
    Detail { detail: Option<FileDetail> },
}

const FILE_FIELDS: &str = "r.id, r.relative_path, r.before_present, r.after_present, r.additions,
    r.deletions, r.stats_available, r.status, r.capture_reason, r.failure_reason";
const PREVIEW_TOO_LARGE: &str =
    "max(coalesce(length(r.before_bytes), 0), coalesce(length(r.after_bytes), 0)) > ?3";

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    let data = match query {
        Query::List { task_id } => {
            let mut statement = db.prepare_cached(&format!(
                "SELECT {FILE_FIELDS} FROM task_code_review r
                 JOIN tasks t ON t.id = r.task_id WHERE r.task_id = ?1
                 ORDER BY r.status != 'pending', r.relative_path",
            ))?;
            let files = statement
                .query_map([task_id], FileRow::from_row)?
                .collect::<rusqlite::Result<_>>()?;
            Data::List { files }
        }
        Query::PendingCount { task_id } => Data::PendingCount {
            count: db.query_row(
                "SELECT COUNT(*) FROM task_code_review WHERE task_id = ?1 AND status = 'pending'",
                [task_id],
                |row| row.get(0),
            )?,
        },
        Query::Detail {
            task_id,
            id,
            max_preview_bytes,
        } => {
            let detail = db
                .prepare_cached(&format!(
                    "SELECT {FILE_FIELDS}, {PREVIEW_TOO_LARGE},
                   CASE WHEN NOT ({PREVIEW_TOO_LARGE}) THEN r.before_bytes END,
                   CASE WHEN NOT ({PREVIEW_TOO_LARGE}) THEN r.after_bytes END
                 FROM task_code_review r JOIN tasks t ON t.id = r.task_id
                 WHERE r.task_id = ?1 AND r.id = ?2",
                ))?
                .query_row(params![task_id, id, max_preview_bytes], |row| {
                    Ok(FileDetail {
                        file: FileRow::from_row(row)?,
                        too_large: row.get(10)?,
                        before: preview_text(row.get(11)?),
                        after: preview_text(row.get(12)?),
                    })
                })
                .optional()?;
            Data::Detail { detail }
        }
    };
    let encoded = serde_json::to_vec(&data)?;
    if encoded.len() >= MAX_REPLY_BYTES - 128 {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&encoded)?)
}

fn preview_text(bytes: Option<Vec<u8>>) -> Option<String> {
    let bytes = bytes?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}
