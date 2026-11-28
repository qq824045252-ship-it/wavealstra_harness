use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Jobs,
    JobState {
        job_id: String,
    },
    Overview {
        limit: i64,
    },
    Runs {
        limit: i64,
        job_ids: Option<Vec<String>>,
    },
    Running,
    JobRuns {
        job_id: String,
        limit: i64,
        before: Option<RunCursor>,
    },
    RunInput {
        run_id: String,
    },
    DotsRunAuthorization {
        source: String,
        #[serde(flatten)]
        purpose: crate::cron_scheduler::DotsRunPurpose,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCursor {
    started_at: i64,
    id: String,
}

fn jobs(db: &Connection, job_id: Option<&str>) -> Result<Vec<Value>> {
    records(
        db,
        "SELECT c.*, (SELECT COUNT(*) FROM cron_runs WHERE job_id = c.id AND
                 CASE WHEN json_extract_string(c.execution_json, '$.reminder.kind') = 'bot-reminder'
                      THEN status = 'success' ELSE status != 'skipped' END) AS run_count
             FROM cron_jobs c WHERE ?1 IS NULL OR c.id=?1 ORDER BY c.updated_at DESC",
        [job_id],
    )
}

fn job_state(db: &Connection, job_id: &str) -> Result<Value> {
    let Some(row) = jobs(db, Some(job_id))?.pop() else {
        return Ok(Value::Null);
    };
    let (owner, unavailable) = crate::cron_scheduler::read_plan_context(db, job_id)?;
    let latest_run = records(
        db,
        "SELECT * FROM cron_runs WHERE job_id=? ORDER BY started_at DESC,id DESC LIMIT 1",
        [job_id],
    )?
    .pop();
    let active_run = records(db,
        "SELECT * FROM cron_runs WHERE job_id=? AND status='running' ORDER BY started_at DESC,id DESC LIMIT 1", [job_id],
    )?.pop();
    Ok(json!({
        "row": row, "owner": owner.map(|(task, space)| json!({ "taskId": task, "spaceId": space })),
        "unavailableReason": unavailable, "activeRun": active_run, "latestRun": latest_run,
    }))
}

fn runs(db: &Connection, limit: i64, job_ids: Option<Vec<String>>) -> Result<Vec<Value>> {
    match job_ids {
        Some(ids) if ids.is_empty() => Ok(Vec::new()),
        Some(ids) => {
            let ph = crate::database::placeholders(ids.len(), 2);
            let sql = format!(
                "SELECT * FROM cron_runs WHERE job_id IN ({ph}) ORDER BY started_at DESC, id DESC LIMIT ?1"
            );
            let mut boxed: Vec<duckdb::types::Value> = vec![duckdb::types::Value::BigInt(limit)];
            boxed.extend(ids.into_iter().map(duckdb::types::Value::Text));
            let refs: Vec<&dyn duckdb::ToSql> =
                boxed.iter().map(|v| v as &dyn duckdb::ToSql).collect();
            records(db, &sql, duckdb::params_from_iter(refs))
        }
        None => records(
            db,
            "SELECT * FROM cron_runs ORDER BY started_at DESC, id DESC LIMIT ?1",
            [limit],
        ),
    }
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Jobs => Ok(jobs(db, None)?.into()),
        Query::JobState { job_id } => job_state(db, &job_id),
        Query::Overview { limit } => {
            Ok(json!({ "jobs": jobs(db, None)?, "runs": runs(db, limit, None)? }))
        }
        Query::Runs { limit, job_ids } => Ok(runs(db, limit, job_ids)?.into()),
        Query::Running => Ok(records(
            db,
            "SELECT id, job_id AS \"jobId\", started_at AS \"startedAt\" FROM cron_runs WHERE status = 'running' ORDER BY started_at DESC, id DESC",
            [],
        )?
        .into()),
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
        Query::DotsRunAuthorization { source, purpose } => {
            let scope = crate::cron_scheduler::authorize_dots_run(db, &source, &purpose)?;
            Ok(json!({ "allowed": scope.is_some(), "ownerSpaceId": scope.flatten() }))
        }
    }
}
