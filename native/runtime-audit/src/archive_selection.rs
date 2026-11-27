use crate::Result;
use duckdb::Connection;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTaskCandidate {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_file: Option<String>,
}

pub fn read(
    db: &Connection,
    dots_task_id: &str,
    task_ids: &[String],
    space_ids: &[String],
) -> Result<Vec<ArchiveTaskCandidate>> {
    if task_ids.is_empty() && space_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut clauses = Vec::new();
    let mut params_vec: Vec<duckdb::types::Value> = vec![duckdb::types::Value::Text(dots_task_id.to_owned())];
    let mut idx = 2;
    if !task_ids.is_empty() {
        let ph = crate::database::placeholders(task_ids.len(), idx);
        idx += task_ids.len();
        clauses.push(format!("id IN ({ph})"));
        params_vec.extend(task_ids.iter().cloned().map(duckdb::types::Value::Text));
    }
    if !space_ids.is_empty() {
        let ph = crate::database::placeholders(space_ids.len(), idx);
        clauses.push(format!("space_id IN ({ph})"));
        params_vec.extend(space_ids.iter().cloned().map(duckdb::types::Value::Text));
    }
    let sql = format!(
        "SELECT id,space_id,project_id,archived,cwd,session_file FROM tasks
         WHERE id != ?1 AND ({})
         ORDER BY updated_at DESC, id",
        clauses.join(" OR ")
    );
    let refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|v| v as &dyn duckdb::ToSql).collect();
    let mut statement = db.prepare(&sql)?;
    let rows = statement.query_map(duckdb::params_from_iter(refs), |row| {
        Ok(ArchiveTaskCandidate {
            id: row.get(0)?,
            space_id: row.get(1)?,
            project_id: row.get(2)?,
            archived: row.get(3)?,
            cwd: row.get(4)?,
            session_file: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}
