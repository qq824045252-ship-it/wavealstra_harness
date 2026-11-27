use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSharedData {
    current_space_id: Option<String>,
    spaces: Vec<Space>,
    items_by_space: Vec<WorkspaceItems>,
    task_items: Vec<ContextItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Space {
    id: String,
    name: String,
    parent_id: Option<String>,
    archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceItems {
    space_id: String,
    items: Vec<ContextItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextItem {
    id: String,
    space_id: String,
    content: String,
    created_at: i64,
    updated_at: i64,
    kind: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    promoted_from: Option<Promotion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Promotion {
    space_id: String,
    item_id: String,
}

pub fn read(
    db: &mut Connection,
    current_space_id: Option<&str>,
    task_id: Option<&str>,
    include_memories: bool,
) -> Result<WorkspaceSharedData> {
    let snapshot = db.transaction()?;
    let task_space = if let Some(id) = task_id.filter(|id| !id.is_empty()) {
        snapshot
            .query_row("SELECT space_id FROM tasks WHERE id=?1", [id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten()
    } else {
        None
    };
    let current_space_id = current_space_id
        .map(str::to_owned)
        .or_else(|| task_space.clone());
    let spaces = {
        let mut statement = snapshot.prepare(
            "SELECT id,name,parent_id,archived FROM spaces ORDER BY updated_at DESC,rowid",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Space {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                archived: row.get::<_, i64>(3)? != 0,
            })
        })?;
        rows.collect::<duckdb::Result<Vec<_>>>()?
    };
    let mut items_by_space = Vec::new();
    let mut task_items = Vec::new();
    if include_memories {
        for space_id in visible_chain(&spaces, current_space_id.as_deref()) {
            items_by_space.push(WorkspaceItems {
                space_id: space_id.to_owned(),
                items: read_items(&snapshot, "workspace", space_id, space_id, 500)?,
            });
        }
        if let Some(id) = task_id.filter(|id| !id.is_empty()) {
            let space_id = task_space.unwrap_or_else(|| format!("task:{id}"));
            task_items = read_items(&snapshot, "task", id, &space_id, 200)?;
        }
    }
    snapshot.commit()?;
    Ok(WorkspaceSharedData {
        current_space_id,
        spaces,
        items_by_space,
        task_items,
    })
}

fn visible_chain<'a>(spaces: &'a [Space], current_space_id: Option<&str>) -> Vec<&'a str> {
    let by_id: HashMap<&str, &Space> = spaces
        .iter()
        .map(|space| (space.id.as_str(), space))
        .collect();
    let mut current = current_space_id.and_then(|id| by_id.get(id).copied());
    let mut seen = HashSet::new();
    let mut chain = Vec::new();
    while let Some(space) = current {
        if !seen.insert(space.id.as_str()) {
            break;
        }
        if space.archived {
            return Vec::new();
        }
        chain.push(space.id.as_str());
        current = space
            .parent_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied());
    }
    chain
}

fn read_items(
    db: &Connection,
    scope: &str,
    scope_id: &str,
    space_id: &str,
    limit: i64,
) -> Result<Vec<ContextItem>> {
    let mut statement = db.prepare(
        "SELECT m.id,m.title,m.content,m.created_at,m.updated_at,m.kind,m.source_type,m.source_task_id,
           CASE WHEN ?1='workspace' THEN (
             SELECT b.binding FROM memory_scopes b WHERE b.memory_id=m.id AND b.scope_type=?1 AND b.scope_id=?2
             ORDER BY b.created_at,b.rowid LIMIT 1
           ) END,
           CASE WHEN ?1='workspace' THEN (
             SELECT b.scope_id FROM memory_scopes b WHERE b.memory_id=m.id AND b.scope_type='workspace'
               AND b.binding='owned' ORDER BY b.created_at,b.rowid LIMIT 1
           ) END
         FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
         WHERE s.scope_type=?1 AND s.scope_id=?2 AND m.status='active'
         ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT ?3",
    )?;
    let rows = statement.query_map(params![scope, scope_id, limit], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let body: String = row.get(2)?;
        let source_type: String = row.get(6)?;
        let promoted = row.get::<_, Option<String>>(8)?.as_deref() == Some("promoted");
        let origin: Option<String> = row.get(9)?;
        Ok(ContextItem {
            promoted_from: origin
                .filter(|id| promoted && !id.is_empty())
                .map(|space_id| Promotion {
                    space_id,
                    item_id: id.clone(),
                }),
            id,
            space_id: space_id.to_owned(),
            content: if body.is_empty() {
                title
            } else {
                format!("{title} — {body}")
            },
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            kind: row.get(5)?,
            source: if promoted {
                "promoted"
            } else if source_type == "agent" {
                "automatic"
            } else {
                "manual"
            },
            source_task_id: row.get(7)?,
        })
    })?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for row in rows {
        let item = row?;
        if seen.insert(item.id.clone()) {
            items.push(item);
        }
    }
    Ok(items)
}
