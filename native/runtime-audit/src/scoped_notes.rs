use crate::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Project,
    Workspace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    content: String,
    revision: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    content: String,
    expected_revision: i64,
    updated_at: i64,
}

fn owner(db: &Connection, scope: Scope, id: &str) -> rusqlite::Result<Option<bool>> {
    let sql = match scope {
        Scope::Project => "SELECT archived != 0 FROM projects WHERE id=?1",
        Scope::Workspace => {
            "WITH RECURSIVE ancestors(id, parent_id, archived) AS (
                SELECT id, parent_id, archived FROM spaces WHERE id=?1
                UNION
                SELECT s.id, s.parent_id, s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
             )
             SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived != 0)
             WHERE EXISTS(SELECT 1 FROM ancestors)"
        }
    };
    db.prepare_cached(sql)?
        .query_row([id], |row| row.get(0))
        .optional()
}

pub(crate) fn library_owner_writable(
    db: &Connection,
    project: Option<&str>,
    workspace: Option<&str>,
) -> rusqlite::Result<bool> {
    if let Some(id) = project {
        if owner(db, Scope::Project, id)? == Some(true) {
            return Ok(false);
        }
    }
    if let Some(id) = workspace {
        return Ok(owner(db, Scope::Workspace, id)? == Some(false));
    }
    Ok(true)
}

fn read_note(db: &Connection, scope: Scope, id: &str) -> rusqlite::Result<Note> {
    let sql = match scope {
        Scope::Project => {
            "SELECT content, revision, updated_at FROM project_notes WHERE project_id=?1"
        }
        Scope::Workspace => {
            "SELECT content, revision, updated_at FROM workspace_notes WHERE workspace_id=?1"
        }
    };
    Ok(db
        .prepare_cached(sql)?
        .query_row([id], |row| {
            Ok(Note {
                content: row.get(0)?,
                revision: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .optional()?
        .unwrap_or_else(|| Note {
            content: String::new(),
            revision: 0,
            updated_at: 0,
        }))
}

pub fn read(db: &Connection, scope: Scope, id: &str) -> Result<Value> {
    if owner(db, scope, id)?.is_none() {
        return Ok(json!({ "status": "missing" }));
    }
    Ok(json!({ "status": "ok", "note": read_note(db, scope, id)? }))
}

pub fn save(db: &mut Connection, scope: Scope, id: &str, save: Save) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match owner(&tx, scope, id)? {
        None => return Ok(json!({ "status": "missing" })),
        Some(true) => return Ok(json!({ "status": "archived" })),
        Some(false) => {}
    }
    let revision_sql = match scope {
        Scope::Project => "SELECT revision FROM project_notes WHERE project_id=?1",
        Scope::Workspace => "SELECT revision FROM workspace_notes WHERE workspace_id=?1",
    };
    let revision: i64 = tx
        .prepare_cached(revision_sql)?
        .query_row([id], |row| row.get(0))
        .optional()?
        .unwrap_or(0);
    if revision != save.expected_revision {
        return Ok(json!({ "status": "conflict" }));
    }
    let sql = match scope {
        Scope::Project => "INSERT INTO project_notes(project_id, content, revision, updated_at) VALUES (?1,?2,?3,?4)
            ON CONFLICT(project_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at",
        Scope::Workspace => "INSERT INTO workspace_notes(workspace_id, content, revision, updated_at) VALUES (?1,?2,?3,?4)
            ON CONFLICT(workspace_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at",
    };
    let note = Note {
        content: save.content,
        revision: revision + 1,
        updated_at: save.updated_at,
    };
    tx.execute(
        sql,
        params![id, note.content, note.revision, note.updated_at],
    )?;
    tx.commit()?;
    Ok(json!({ "status": "ok", "note": note }))
}
