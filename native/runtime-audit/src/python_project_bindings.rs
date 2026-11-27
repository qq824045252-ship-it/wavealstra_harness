use crate::{Result, sqlite_rows::records};
use duckdb::Connection;
use serde_json::Value;

pub fn read(db: &Connection, ancestors: Option<Vec<String>>) -> Result<Value> {
    let rows = match ancestors {
        Some(keys) => records(db,
            "SELECT b.dir_key,b.project_dir,b.python_path,b.python_version,b.manifest_path,b.bound_at
             FROM json_each(?) candidate JOIN python_project_bindings b
                 ON b.dir_key=json_extract_string(candidate.value,'$')
             ORDER BY CAST(candidate.key AS BIGINT) LIMIT 1",
            [serde_json::to_string(&keys)?],
        )?,
        None => records(db,
            "SELECT dir_key,project_dir,python_path,python_version,manifest_path,bound_at
             FROM python_project_bindings ORDER BY bound_at DESC,dir_key",
            [],
        )?,
    };
    Ok(rows.into())
}
