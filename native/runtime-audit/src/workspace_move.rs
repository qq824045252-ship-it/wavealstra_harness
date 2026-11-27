use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Space,
    Task,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    kind: Kind,
    id: String,
    target_parent_id: Option<String>,
    target_index: Option<i64>,
    target_sort_order: Option<i64>,
    now: i64,
    gateway: bool,
    gateway_channel: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    id: String,
    archived: bool,
    at: i64,
    #[serde(flatten)]
    target: ArchiveTarget,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ArchiveTarget {
    Space,
    Task { directory_name: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ArchiveReply {
    Saved,
    Trashed,
    Rejected { message: String },
}

pub fn archive(db: &mut Connection, request: Archive) -> ArchiveReply {
    match apply_archive(db, request) {
        Ok(reply) => reply,
        Err(error) => ArchiveReply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply_archive(db: &mut Connection, request: Archive) -> Result<ArchiveReply> {
    let Archive {
        id,
        archived,
        at,
        target,
    } = request;
    match target {
        ArchiveTarget::Space => {
            db.execute(
                "UPDATE spaces SET archived=?2, updated_at=GREATEST(updated_at, ?3) WHERE id=?1",
                params![id, archived, at],
            )?;
        }
        ArchiveTarget::Task { directory_name } => {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "INSERT INTO task_execution_workspace_state
                    (task_id,directory_name,state,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?4)
                 ON CONFLICT(task_id) DO UPDATE SET
                    directory_name=excluded.directory_name, state=excluded.state,
                    updated_at=GREATEST(task_execution_workspace_state.updated_at, excluded.updated_at),
                    trashed_at=NULL, purge_after=NULL, trash_path=NULL
                 WHERE task_execution_workspace_state.state!='trashed'",
                params![
                    id,
                    directory_name,
                    if archived { "archived" } else { "active" },
                    at
                ],
            )?;
            if changed == 0 {
                return Ok(ArchiveReply::Trashed);
            }
            tx.execute(
                "UPDATE tasks SET archived=?2, updated_at=GREATEST(updated_at, ?3) WHERE id=?1",
                params![id, archived, at],
            )?;
            tx.commit()?;
        }
    }
    Ok(ArchiveReply::Saved)
}

struct Tree {
    table: &'static str,
    parent: &'static str,
    sort: &'static str,
    stable_order: &'static str,
    insertion_order: &'static str,
}

impl Kind {
    fn tree(self) -> Tree {
        match self {
            Self::Space => Tree {
                table: "spaces",
                parent: "parent_id",
                sort: "sort_order",
                stable_order: "sort_order ASC, created_at ASC, id ASC",
                insertion_order: "sort_order ASC, created_at ASC, id ASC",
            },
            Self::Task => Tree {
                table: "tasks",
                parent: "space_id",
                sort: "space_sort_order",
                stable_order: "space_sort_order ASC, updated_at ASC, id ASC",
                insertion_order:
                    "is_favorited DESC, CASE WHEN space_sort_order > 0 THEN 0 ELSE 1 END,
                    space_sort_order ASC, updated_at DESC, id ASC",
            },
        }
    }
}

pub fn write(db: &mut Connection, movement: Move) -> Reply {
    match apply(db, movement) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, movement: Move) -> Result<()> {
    let tx = db.transaction()?;
    let tree = movement.kind.tree();
    let previous = validate(&tx, &movement)?;
    let target = movement.target_parent_id.as_deref();
    if let Some(explicit) = movement.target_sort_order {
        move_row(&tx, &tree, &movement, explicit)?;
        if (matches!(movement.kind, Kind::Space) || target.is_some())
            && has_collision(&tx, &tree, target, &movement.id, explicit)?
        {
            renumber(&tx, &tree, target)?;
        }
    } else if let Some(index) = movement.target_index {
        insert_at(&tx, &tree, &movement, index)?;
    } else {
        let order = if matches!(movement.kind, Kind::Task) && target.is_none() {
            0
        } else {
            tx.query_row(
                &format!(
                    "SELECT coalesce(max({}),0)+1000 FROM {} WHERE {} IS NOT DISTINCT FROM ?1",
                    tree.sort, tree.table, tree.parent
                ),
                [target],
                |row| row.get(0),
            )?
        };
        move_row(&tx, &tree, &movement, order)?;
    }
    if previous.as_deref() != target && (matches!(movement.kind, Kind::Space) || previous.is_some())
    {
        renumber(&tx, &tree, previous.as_deref())?;
    }
    tx.commit()?;
    Ok(())
}

fn validate(db: &Connection, movement: &Move) -> Result<Option<String>> {
    let target = movement.target_parent_id.as_deref();
    let mut source_archived = false;
    let previous: Option<String> = match movement.kind {
        Kind::Space => db
            .query_row(
                "SELECT parent_id FROM spaces WHERE id=?1",
                [&movement.id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| format!("空间不存在：{}", movement.id))?,
        Kind::Task => {
            if movement.gateway {
                let verified: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM gateway_sidebar_conversations WHERE task_id=?1 AND channel_id=?2)",
                    params![movement.id, movement.gateway_channel], |row| row.get(0),
                )?;
                if !verified {
                    return Err("网关对话不能移入其他空间或解除渠道归属".into());
                }
            }
            let (parent, archived) = db.query_row(
                "SELECT space_id, archived != 0 OR EXISTS(
                    SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=tasks.id AND w.state='trashed'
                ) FROM tasks WHERE id=?1",
                [&movement.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?.ok_or_else(|| format!("任务不存在：{}", movement.id))?;
            source_archived = archived;
            parent
        }
    };
    let (target_exists, target_archived, contains_source) = space_chain(db, target, &movement.id)?;
    if let Some(target) = target {
        if !target_exists {
            return Err(format!("空间不存在：{target}").into());
        }
        if matches!(movement.kind, Kind::Space) && contains_source {
            return Err(if target == movement.id {
                "不能把空间移动到其自身之下（cycle）"
            } else {
                "不能把空间移动到其子孙空间之下（cycle）"
            }
            .into());
        }
    }
    let from = match movement.kind {
        Kind::Space => Some(movement.id.as_str()),
        Kind::Task => previous.as_deref(),
    };
    if source_archived || space_chain(db, from, &movement.id)?.1 {
        return Err(match movement.kind {
            Kind::Space => "已归档空间不能移动",
            Kind::Task => "已归档或已回收任务不能移动",
        }
        .into());
    }
    if target_archived {
        return Err("不能移动到已归档空间".into());
    }
    Ok(previous)
}

fn space_chain(db: &Connection, first: Option<&str>, source: &str) -> Result<(bool, bool, bool)> {
    let Some(first) = first.filter(|first| !first.is_empty()) else {
        return Ok((false, false, false));
    };
    Ok(db.query_row(
        "WITH RECURSIVE ancestors(id, parent_id, archived) AS (
             SELECT id,parent_id,archived FROM spaces WHERE id=?1
             UNION
             SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
         )
         SELECT count(*)>0, coalesce(max(archived!=0),0), coalesce(max(id=?2),0) FROM ancestors",
        params![first, source],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?)
}

fn move_row(db: &Connection, tree: &Tree, movement: &Move, sort: i64) -> Result<()> {
    let timestamp = if matches!(movement.kind, Kind::Space) {
        ", updated_at=GREATEST(updated_at, ?4)"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE {} SET {}=?2, {}=?3{} WHERE id=?1",
        tree.table, tree.parent, tree.sort, timestamp
    );
    if matches!(movement.kind, Kind::Space) {
        db.execute(
            &sql,
            params![movement.id, movement.target_parent_id, sort, movement.now],
        )?;
    } else {
        db.execute(&sql, params![movement.id, movement.target_parent_id, sort])?;
    }
    Ok(())
}

fn has_collision(
    db: &Connection,
    tree: &Tree,
    parent: Option<&str>,
    id: &str,
    sort: i64,
) -> Result<bool> {
    Ok(db.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE {} IS NOT DISTINCT FROM ?1 AND id != ?2 AND {}=?3)",
            tree.table, tree.parent, tree.sort
        ),
        params![parent, id, sort],
        |row| row.get(0),
    )?)
}

fn renumber(db: &Connection, tree: &Tree, parent: Option<&str>) -> Result<()> {
    db.execute(
        &format!(
            "WITH siblings AS MATERIALIZED (
            SELECT id, row_number() OVER (ORDER BY {}) * 1000 AS sort FROM {} WHERE {} IS NOT DISTINCT FROM ?1
         )
         UPDATE {} AS item SET {}=siblings.sort FROM siblings WHERE item.id=siblings.id",
            tree.stable_order, tree.table, tree.parent, tree.table, tree.sort,
        ),
        [parent],
    )?;
    Ok(())
}

fn insert_at(db: &Connection, tree: &Tree, movement: &Move, index: i64) -> Result<()> {
    let timestamp = if matches!(movement.kind, Kind::Space) {
        ", updated_at=GREATEST(item.updated_at, ?4)"
    } else {
        ""
    };
    let sql = format!(
        "WITH siblings AS MATERIALIZED (
            SELECT id, row_number() OVER (ORDER BY {}) - 1 AS slot
            FROM {} WHERE {} IS NOT DISTINCT FROM ?2 AND id != ?1
         ), insertion AS (SELECT min(GREATEST(?3, 0),count(*)) AS slot FROM siblings),
         ordered AS (
            SELECT id, (siblings.slot + (siblings.slot>=insertion.slot) + 1)*1000 AS sort
                FROM siblings CROSS JOIN insertion
            UNION ALL SELECT ?1, (slot+1)*1000 FROM insertion
         )
         UPDATE {} AS item SET {}=?2, {}=ordered.sort{} FROM ordered WHERE item.id=ordered.id",
        tree.insertion_order,
        tree.table,
        tree.parent,
        tree.table,
        tree.parent,
        tree.sort,
        timestamp,
    );
    if matches!(movement.kind, Kind::Space) {
        db.execute(
            &sql,
            params![movement.id, movement.target_parent_id, index, movement.now],
        )?;
    } else {
        db.execute(&sql, params![movement.id, movement.target_parent_id, index])?;
    }
    Ok(())
}
