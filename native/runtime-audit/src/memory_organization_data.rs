use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;

pub fn latest(db: &Connection) -> Result<Option<String>> {
    let run = db
        .prepare(
            "SELECT CAST(json_extract(state_json,'$.run') AS VARCHAR)
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
    let Some(existing_json): Option<String> = db
        .prepare(
            "SELECT state_json FROM memory_organization_runs
             WHERE id=?1 AND json_extract_string(state_json,'$.scanId')=?2
               AND json_extract_string(state_json,'$.run.status')='scanning'",
        )?
        .query_row(params![progress.id, progress.scan_id], |row| row.get(0))
        .optional()?
    else {
        return Ok(false);
    };
    let run_val: serde_json::Value = serde_json::from_str(&progress.run_json)?;
    let patched = crate::database::patch_json_fields(&existing_json, &[("run", run_val)]);
    let changes = db
        .prepare(
            "UPDATE memory_organization_runs
             SET updated_at=?3,state_json=?4
             WHERE id=?1 AND json_extract_string(state_json,'$.scanId')=?2
               AND json_extract_string(state_json,'$.run.status')='scanning'",
        )?
        .execute(params![
            progress.id,
            progress.scan_id,
            progress.updated_at,
            patched,
        ])?;
    Ok(changes != 0)
}
