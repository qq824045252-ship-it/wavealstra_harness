use crate::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

pub fn latest(db: &Connection) -> Result<Option<String>> {
    let run = db
        .prepare_cached(
            "SELECT json_extract(state_json,'$.run')
             FROM memory_organization_runs ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )?
        .query_row([], |row| row.get(0))
        .optional()?;
    Ok(run)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    id: String,
    scan_id: String,
    updated_at: i64,
    run_json: String,
}

pub fn write_progress(db: &Connection, progress: Progress) -> Result<bool> {
    // Keeping the scanned inputs in SQLite avoids shipping the full checkpoint every batch.
    // UPDATE can neither recreate a forgotten preview nor overwrite a paused or resumed scan.
    let changes = db
        .prepare_cached(
            "UPDATE memory_organization_runs
             SET updated_at=?3,state_json=json_set(state_json,'$.run',json(?4))
             WHERE id=?1 AND json_extract(state_json,'$.scanId')=?2
               AND json_extract(state_json,'$.run.status')='scanning'",
        )?
        .execute(params![
            progress.id,
            progress.scan_id,
            progress.updated_at,
            progress.run_json,
        ])?;
    Ok(changes != 0)
}
