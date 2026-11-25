use crate::{Result, sqlite_rows::records};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Start {
        run: Run,
        expected_job: Value,
        input_json: String,
        new_task: Option<GeneratedTask>,
        required_tasks: Vec<String>,
        required_projects: Vec<String>,
    },
    Record {
        run: Run,
    },
    Finish {
        run_id: String,
        finished_at: i64,
        status: String,
        error: Option<String>,
        task_id: Option<String>,
        generated_task_title: Option<String>,
        skipped_start: Option<SkippedStart>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    id: String,
    job_id: String,
    started_at: i64,
    finished_at: Option<i64>,
    status: String,
    error: Option<String>,
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedTask {
    id: String,
    title: String,
    space_id: Option<String>,
    project_id: Option<String>,
    updated_at: i64,
    cwd: Option<String>,
    welcome_mode: Option<String>,
    model_id: Option<String>,
    permission_mode: Option<String>,
    expert_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedStart {
    job_id: String,
    started_at: i64,
    previous_last_run_at: Option<i64>,
    previous_updated_at: i64,
}

fn insert(db: &Connection, run: &Run) -> Result<()> {
    db.execute(
        "INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![run.id, run.job_id, run.started_at, run.finished_at, run.status, run.error, run.task_id],
    )?;
    Ok(())
}

fn identified(db: &Connection, run: &Run) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM cron_runs WHERE id = ?1 AND job_id = ?2 AND started_at = ?3
        AND finished_at IS ?4 AND status = ?5 AND error IS ?6 AND task_id IS ?7)",
        params![
            run.id,
            run.job_id,
            run.started_at,
            run.finished_at,
            run.status,
            run.error,
            run.task_id
        ],
        |row| row.get(0),
    )?)
}

fn existing(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM cron_runs WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?)
}

fn active(db: &Connection, sql: &str, ids: &[String]) -> Result<bool> {
    let mut statement = db.prepare_cached(sql)?;
    for id in ids {
        if statement.query_row([id], |_| Ok(())).optional()?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn start(
    db: &Connection,
    run: Run,
    expected_job: Value,
    input_json: &str,
    new_task: Option<GeneratedTask>,
    required_tasks: &[String],
    required_projects: &[String],
) -> Result<bool> {
    if existing(db, &run.id)? {
        let saved = db
            .query_row(
                "SELECT request_json FROM cron_run_inputs WHERE run_id = ?1",
                [&run.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        return Ok(saved.as_deref() == Some(input_json) && identified(db, &run)?);
    }
    let job = records(db, "SELECT * FROM cron_jobs WHERE id = ?1", [&run.job_id])?;
    if job.first() != Some(&expected_job)
        || !active(
            db,
            "SELECT 1 FROM tasks WHERE id = ?1 AND archived = 0",
            required_tasks,
        )?
        || !active(
            db,
            "SELECT 1 FROM projects WHERE id = ?1 AND archived = 0",
            required_projects,
        )?
    {
        return Ok(false);
    }
    if let Some(task) = new_task {
        db.execute("INSERT INTO tasks (id, title, space_id, project_id, status, updated_at, cwd, welcome_mode, model_id, permission_mode, expert_id)
            VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)",
            params![task.id, task.title, task.space_id, task.project_id, task.updated_at, task.cwd,
                task.welcome_mode, task.model_id, task.permission_mode, task.expert_id])?;
    }
    insert(db, &run)?;
    db.execute(
        "INSERT INTO cron_run_inputs (run_id, request_json) VALUES (?1, ?2)",
        params![run.id, input_json],
    )?;
    db.execute(
        "UPDATE cron_jobs SET last_run_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![run.started_at, run.job_id],
    )?;
    Ok(true)
}

fn finish(
    db: &Connection,
    run_id: &str,
    finished_at: i64,
    status: &str,
    error: Option<&str>,
    task_id: Option<&str>,
    title: Option<&str>,
    skipped_start: Option<&SkippedStart>,
) -> Result<bool> {
    let row = db
        .query_row(
            "SELECT status, finished_at, error, task_id FROM cron_runs WHERE id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((prior_status, prior_at, prior_error, prior_task)) = &row {
        if prior_status != "running" {
            return Ok(prior_status == status
                && *prior_at == Some(finished_at)
                && prior_error.as_deref() == error
                && (task_id.is_none() || prior_task.as_deref() == task_id));
        }
    }
    db.execute(
        "UPDATE cron_runs SET finished_at = ?1, status = ?2, error = ?3,
         task_id = CASE WHEN ?4 THEN NULL ELSE COALESCE(?5, task_id) END WHERE id = ?6",
        params![
            finished_at,
            status,
            error,
            skipped_start.is_some(),
            task_id,
            run_id
        ],
    )?;
    if let Some(skipped) = skipped_start.filter(|_| row.is_some()) {
        db.execute("DELETE FROM cron_run_inputs WHERE run_id = ?1", [run_id])?;
        db.execute("UPDATE cron_jobs SET last_run_at = ?1, updated_at = CASE WHEN updated_at = ?2 THEN ?3 ELSE updated_at END
          WHERE id = ?4 AND last_run_at = ?2", params![skipped.previous_last_run_at, skipped.started_at,
            skipped.previous_updated_at, skipped.job_id])?;
    }
    if let (Some(title), Some(task_id)) = (title, task_id) {
        let task_status = if status == "success" {
            "completed"
        } else {
            "failed"
        };
        db.execute(
            "UPDATE tasks SET title = CASE WHEN ?1 = '' THEN title ELSE ?1 END, status = ?2,
            updated_at = MAX(updated_at, ?3) WHERE id = ?4",
            params![title, task_status, finished_at, task_id],
        )?;
    }
    Ok(true)
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let committed = match mutation {
        Mutation::Start {
            run,
            expected_job,
            input_json,
            new_task,
            required_tasks,
            required_projects,
        } => start(
            &tx,
            run,
            expected_job,
            &input_json,
            new_task,
            &required_tasks,
            &required_projects,
        )?,
        Mutation::Record { run } => {
            if existing(&tx, &run.id)? {
                identified(&tx, &run)?
            } else if active(
                &tx,
                "SELECT 1 FROM cron_jobs WHERE id = ?1",
                std::slice::from_ref(&run.job_id),
            )? {
                insert(&tx, &run)?;
                true
            } else {
                false
            }
        }
        Mutation::Finish {
            run_id,
            finished_at,
            status,
            error,
            task_id,
            generated_task_title,
            skipped_start,
        } => finish(
            &tx,
            &run_id,
            finished_at,
            &status,
            error.as_deref(),
            task_id.as_deref(),
            generated_task_title.as_deref(),
            skipped_start.as_ref(),
        )?,
    };
    tx.commit()?;
    Ok(committed)
}
