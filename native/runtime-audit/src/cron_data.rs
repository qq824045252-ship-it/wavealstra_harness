use crate::{Result, sqlite_rows::records};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Jobs,
    Runs {
        limit: i64,
        job_ids: Option<Vec<String>>,
    },
    JobRuns {
        job_id: String,
        limit: i64,
        before: Option<RunCursor>,
    },
    RunInput {
        run_id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCursor {
    started_at: i64,
    id: String,
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Jobs => Ok(records(
            db,
            "SELECT c.*, (SELECT COUNT(id) FROM cron_runs WHERE job_id = c.id AND
                 CASE WHEN json_extract(c.execution_json, '$.reminder.kind') = 'bot-reminder'
                      THEN status = 'success' ELSE status != 'skipped' END) AS run_count
             FROM cron_jobs c ORDER BY c.updated_at DESC",
            [],
        )?
        .into()),
        Query::Runs { limit, job_ids } => {
            let rows = match job_ids {
                Some(ids) => records(
                    db,
                    "SELECT * FROM cron_runs WHERE job_id IN (SELECT value FROM json_each(?1))
                     ORDER BY started_at DESC, id DESC LIMIT ?2",
                    params![serde_json::to_string(&ids)?, limit],
                )?,
                None => records(
                    db,
                    "SELECT * FROM cron_runs ORDER BY started_at DESC, id DESC LIMIT ?1",
                    [limit],
                )?,
            };
            Ok(rows.into())
        }
        Query::JobRuns {
            job_id,
            limit,
            before,
        } => {
            let rows = match before {
                Some(cursor) => records(
                    db,
                    "SELECT * FROM cron_runs WHERE job_id = ?1 AND (started_at, id) < (?2, ?3)
                     ORDER BY started_at DESC, id DESC LIMIT ?4",
                    params![job_id, cursor.started_at, cursor.id, limit],
                )?,
                None => records(
                    db,
                    "SELECT * FROM cron_runs WHERE job_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2",
                    params![job_id, limit],
                )?,
            };
            Ok(rows.into())
        }
        Query::RunInput { run_id } => {
            let input = db
                .query_row(
                    "SELECT request_json FROM cron_run_inputs WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(input.map_or(Value::Null, Value::String))
        }
    }
}
