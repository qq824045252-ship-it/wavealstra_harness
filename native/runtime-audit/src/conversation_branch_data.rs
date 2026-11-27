use crate::{Result, business_protocol::ClientContext};
use duckdb::{Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Info { task_id: String },
    Children { task_id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchInfo {
    child_task_id: String,
    parent_task_id: String,
    root_task_id: String,
    parent_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_title: Option<String>,
    source_user_message_index: i64,
    source_position: String,
    workspace_strategy: String,
    created_at: i64,
    parent_exists: bool,
}

pub fn read(db: &Connection, query: Query, client: Option<&ClientContext>) -> Result<Value> {
    if !client.is_some_and(|identity| identity.role == "ui") {
        return Err("conversation branch lineage is restricted to the desktop UI client".into());
    }
    let (task_id, filter) = match query {
        Query::Info { task_id } => (task_id, "b.child_task_id = ?1"),
        Query::Children { task_id } => (task_id, "b.parent_task_id = ?1"),
    };
    let mut statement = db.prepare(&format!(
        "SELECT b.child_task_id, b.parent_task_id, b.root_task_id, b.parent_title_snapshot,
                child.title, b.source_user_message_index, b.source_position, b.workspace_strategy,
                b.created_at, (parent.id IS NOT NULL) AS parent_exists
           FROM conversation_branches b
           LEFT JOIN tasks child ON child.id = b.child_task_id
           LEFT JOIN tasks parent ON parent.id = b.parent_task_id
          WHERE {filter}
            AND NOT EXISTS (
                SELECT 1 FROM task_execution_workspace_state w
                 WHERE w.task_id = b.child_task_id AND w.state = 'trashed'
            )
          ORDER BY b.created_at, b.child_task_id"
    ))?;
    let rows = statement
        .query_map([task_id], map_branch)?
        .collect::<duckdb::Result<Vec<_>>>()?;
    Ok(json!({ "rows": rows }))
}

fn map_branch(row: &Row<'_>) -> duckdb::Result<BranchInfo> {
    Ok(BranchInfo {
        child_task_id: row.get(0)?,
        parent_task_id: row.get(1)?,
        root_task_id: row.get(2)?,
        parent_title: row.get(3)?,
        child_title: row.get(4)?,
        source_user_message_index: row.get(5)?,
        source_position: row.get(6)?,
        workspace_strategy: row.get(7)?,
        created_at: row.get(8)?,
        parent_exists: row.get(9)?,
    })
}
