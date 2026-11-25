use crate::Result;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    List {
        project_id: String,
    },
    Pin {
        project_id: String,
        item_id: String,
        id: String,
        note: Option<String>,
        created_at: i64,
    },
    Unpin {
        project_id: String,
        item_id: String,
    },
}

impl Request {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::List { .. })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    id: String,
    project_id: String,
    item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    created_by: String,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Listed { pins: Vec<Pin> },
    Pinned { pin: Pin },
    Removed,
    Archived,
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    match apply(db, request) {
        Ok(reply) => reply,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Request) -> Result<Reply> {
    if let Request::List { project_id } = request {
        let mut select = db.prepare_cached(
            "SELECT p.id, p.project_id, p.item_id, i.title, i.kind,
                    p.note, p.created_by, p.created_at
             FROM project_context_pins p
             LEFT JOIN library_items i ON i.id = p.item_id
             WHERE p.project_id = ?1
             ORDER BY p.created_at DESC",
        )?;
        let pins = select
            .query_map([project_id], map_pin)?
            .collect::<rusqlite::Result<_>>()?;
        return Ok(Reply::Listed { pins });
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let reply = match request {
        Request::List { .. } => unreachable!(),
        Request::Pin {
            project_id,
            item_id,
            id,
            note,
            created_at,
        } => {
            if project_archived(&tx, &project_id)? {
                return Ok(Reply::Archived);
            }
            let existing = tx
                .prepare_cached(
                    "SELECT p.id, p.project_id, p.item_id, i.title, i.kind,
                            p.note, p.created_by, p.created_at
                     FROM project_context_pins p
                     LEFT JOIN library_items i ON i.id = p.item_id
                     WHERE p.project_id = ?1 AND p.item_id = ?2",
                )?
                .query_row(params![project_id, item_id], map_pin)
                .optional()?;
            if let Some(pin) = existing {
                return Ok(Reply::Pinned { pin });
            }
            let (item_title, item_kind, item_project) = tx
                .prepare_cached(
                    "SELECT i.title, i.kind, CASE WHEN s.kind = 'personal' THEN NULL ELSE s.project_id END
                     FROM library_items i
                     LEFT JOIN library_spaces s ON s.id = i.space_id
                     WHERE i.id = ?1",
                )?
                .query_row([&item_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<String>>(2)?))
                })
                .optional()?
                .ok_or("资料条目不存在")?;
            if item_project
                .as_deref()
                .is_some_and(|owner| owner != project_id)
            {
                return Err("不能固定其他项目的资料（跨项目隔离）".into());
            }
            let created_by: String = tx
                .query_row("SELECT name FROM soul WHERE id = 1", [], |row| row.get(0))
                .optional()
                .unwrap_or_default()
                .unwrap_or_else(|| "我".to_owned());
            tx.execute(
                "INSERT INTO project_context_pins (id, project_id, item_id, note, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, project_id, item_id, note, created_by, created_at],
            )?;
            Reply::Pinned {
                pin: Pin {
                    id,
                    project_id,
                    item_id,
                    item_title,
                    item_kind,
                    note,
                    created_by,
                    created_at,
                },
            }
        }
        Request::Unpin {
            project_id,
            item_id,
        } => {
            if project_archived(&tx, &project_id)? {
                return Ok(Reply::Archived);
            }
            tx.execute(
                "DELETE FROM project_context_pins WHERE project_id = ?1 AND item_id = ?2",
                params![project_id, item_id],
            )?;
            Reply::Removed
        }
    };
    tx.commit()?;
    Ok(reply)
}

fn project_archived(db: &Connection, project_id: &str) -> Result<bool> {
    db.prepare_cached("SELECT archived != 0 FROM projects WHERE id = ?1")?
        .query_row([project_id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| format!("项目不存在：{project_id}").into())
}

fn map_pin(row: &Row<'_>) -> rusqlite::Result<Pin> {
    Ok(Pin {
        id: row.get(0)?,
        project_id: row.get(1)?,
        item_id: row.get(2)?,
        item_title: row.get(3)?,
        item_kind: row.get(4)?,
        note: row.get(5)?,
        created_by: row.get(6)?,
        created_at: row.get(7)?,
    })
}
