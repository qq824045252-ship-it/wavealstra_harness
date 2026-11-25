use crate::{
    Result, library_delete,
    project_memory_forget::{self, Withdrawal},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::path::Path;

pub fn delete(
    db: &mut Connection,
    operation_id: &str,
    id: &str,
    root: &Path,
    withdrawal: Withdrawal,
) -> Result<Value> {
    let write_guard = crate::write_gate::enter()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT result_json FROM project_delete_receipts WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(result) = prior {
        return Ok(serde_json::from_str(&result)?);
    }
    if !project_memory_forget::is_current(&tx, id, None, &withdrawal)? {
        return Ok(json!({ "status": "memoryChanged" }));
    }
    let Some(item_ids) = library_delete::delete_project_spaces(&tx, root, id)? else {
        return Ok(json!({ "status": "libraryScopeChanged" }));
    };
    project_memory_forget::detach(&tx, id, None, &withdrawal)?;
    let job_ids = tx
        .prepare("SELECT id FROM cron_jobs WHERE project_id=?1 ORDER BY id")?
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute(
        "DELETE FROM cron_runs WHERE job_id IN (SELECT id FROM cron_jobs WHERE project_id=?1)",
        [id],
    )?;
    tx.execute("DELETE FROM cron_jobs WHERE project_id=?1", [id])?;
    tx.execute(
        "DELETE FROM work_graph_edges WHERE
           (from_type='project' AND from_id=?1) OR (to_type='project' AND to_id=?1)
           OR (from_type='plan' AND from_id IN (SELECT id FROM project_todos WHERE project_id=?1))
           OR (to_type='plan' AND to_id IN (SELECT id FROM project_todos WHERE project_id=?1))",
        [id],
    )?;
    tx.execute("UPDATE tasks SET project_id=NULL WHERE project_id=?1", [id])?;
    tx.execute("DELETE FROM projects WHERE id=?1", [id])?;
    let result = json!({ "status": "deleted", "itemIds": item_ids, "jobIds": job_ids });
    tx.execute(
        "INSERT INTO project_delete_receipts(operation_id,result_json) VALUES (?1,?2)",
        params![operation_id, result.to_string()],
    )?;
    tx.execute(
        "DELETE FROM project_delete_receipts WHERE rowid <= last_insert_rowid()-2048",
        [],
    )?;
    crate::request_control::commit(tx)?;
    drop(write_guard);
    Ok(result)
}
