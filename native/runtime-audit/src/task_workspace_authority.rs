use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Space {
    id: String,
    parent_id: Option<String>,
    path: Option<String>,
    archived: bool,
    #[serde(skip)]
    updated_at: i64,
}

#[derive(Serialize)]
struct Binding {
    directory: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMove {
    from_cwd: String,
    to_cwd: String,
}

#[derive(Serialize)]
struct WorkspaceState {
    state: String,
    directory_name: String,
    created_at: i64,
    updated_at: i64,
    trashed_at: Option<i64>,
    trash_path: Option<String>,
}

struct Authority {
    space_id: Option<String>,
    cwd: Option<String>,
    archived: bool,
    updated_at: i64,
    state: Option<WorkspaceState>,
    space_chain: Vec<Space>,
    binding: Option<Binding>,
    workspace_move: Option<WorkspaceMove>,
    complete_chain: bool,
}

impl Authority {
    fn version(&self, task_id: &str) -> Result<String> {
        let ancestor_revisions: Vec<_> = self.space_chain.iter().map(|space| space.updated_at).collect();
        let guard = json!([task_id, self.space_id, self.cwd, self.archived, self.updated_at, self.state,
            self.space_chain, ancestor_revisions, self.binding, self.workspace_move]);
        let hash = Sha256::digest(serde_json::to_vec(&guard)?);
        Ok(format!("{hash:x}"))
    }

    fn unavailable(&self) -> bool {
        self.state.as_ref().is_some_and(|state| state.state != "active")
    }

    fn view(&self, task_id: &str) -> Result<Value> {
        Ok(json!({"version":self.version(task_id)?, "spaceId":self.space_id, "cwd":self.cwd,
            "archived":self.archived, "trashed":self.unavailable(), "spaceChain":self.space_chain,
            "binding":self.binding, "workspaceMove":self.workspace_move}))
    }
}

fn authority(db: &Connection, task_id: &str) -> Result<Option<Authority>> {
    let task = db.query_row(
        "SELECT t.space_id,t.cwd,t.archived,t.updated_at,s.state,s.directory_name,s.created_at,s.updated_at,s.trashed_at,s.trash_path,
           b.directory,b.cwd,m.from_cwd,m.to_cwd
         FROM tasks t LEFT JOIN task_execution_workspace_state s ON s.task_id=t.id
         LEFT JOIN durable_bot_bindings b ON b.task_id=t.id
         LEFT JOIN durable_bot_workspace_moves m ON m.task_id=t.id WHERE t.id=?",
        [task_id], |row| {
            let state = if let Some(state) = row.get(4)? {
                Some(WorkspaceState { state, directory_name: row.get(5)?, created_at: row.get(6)?,
                    updated_at: row.get(7)?, trashed_at: row.get(8)?, trash_path: row.get(9)? })
            } else { None };
            let directory: Option<String> = row.get(10)?;
            let binding_cwd: Option<String> = row.get(11)?;
            let from: Option<String> = row.get(12)?;
            let to: Option<String> = row.get(13)?;
            Ok(Authority { space_id: row.get(0)?, cwd: row.get(1)?, archived: row.get::<_, i64>(2)? != 0,
                updated_at: row.get(3)?, state, space_chain: Vec::new(), complete_chain: true,
                binding: directory.zip(binding_cwd).map(|(directory,cwd)| Binding { directory, cwd }),
                workspace_move: from.zip(to).map(|(from_cwd,to_cwd)| WorkspaceMove { from_cwd,to_cwd }) })
        },
    ).optional()?;
    let Some(mut task) = task else { return Ok(None); };
    let mut space = task.space_id.clone();
    let mut seen = HashSet::new();
    let mut lookup = db.prepare("SELECT parent_id,path,archived,updated_at FROM spaces WHERE id=?")?;
    while let Some(id) = space.take() {
        if !seen.insert(id.clone()) {
            task.complete_chain = false;
            break;
        }
        let row = lookup.query_row([&id], |row| Ok(Space { id: id.clone(), parent_id: row.get(0)?,
            path: row.get(1)?, archived: row.get::<_, i64>(2)? != 0, updated_at: row.get(3)? })).optional()?;
        let Some(row) = row else {
            task.complete_chain = false;
            break;
        };
        space = row.parent_id.clone();
        task.space_chain.push(row);
    }
    Ok(Some(task))
}

pub fn read(db: &Connection, task_id: &str) -> Result<Value> {
    let snapshot = db.unchecked_transaction()?;
    authority(&snapshot, task_id)?.map_or(Ok(Value::Null), |state| state.view(task_id))
}

pub fn bind(db: &mut Connection, task_id: &str, expected_version: &str, cwd: &str, at: i64) -> Result<String> {
    if !Path::new(cwd).is_absolute() {
        return Err("任务工作目录必须是绝对路径".into());
    }
    let tx = db.transaction()?;
    let mut current = authority(&tx, task_id)?.ok_or("任务已删除")?;
    if current.archived || current.unavailable() || !current.complete_chain
        || current.space_chain.iter().any(|space| space.archived)
        || current.version(task_id)? != expected_version {
        return Err("任务或工作空间已变化，请核对后重新发送".into());
    }
    if current.cwd.as_deref() != Some(cwd) {
        current.updated_at = at.max(current.updated_at.saturating_add(1));
        tx.execute("UPDATE tasks SET cwd=?1,updated_at=?2 WHERE id=?3", params![cwd, current.updated_at, task_id])?;
        current.cwd = Some(cwd.to_owned());
    }
    let version = current.version(task_id)?;
    crate::request_control::commit(tx)?;
    Ok(version)
}
