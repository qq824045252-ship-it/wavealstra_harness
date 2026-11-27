use crate::Result;
use duckdb::{Connection, OptionalExt, named_params, params};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    id: String,
    name: String,
    path: Option<String>,
    #[serde(default, deserialize_with = "supplied")]
    parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "supplied")]
    sort_order: Option<Option<f64>>,
    at: i64,
}

#[derive(Deserialize)]
pub struct TaskWorkspaceFallback {
    name: String,
    path: Option<String>,
}

fn supplied<'de, D, T>(value: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(value).map(Some)
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Saved {
        parent_id: Option<String>,
        sort_order: f64,
    },
    Rejected {
        message: String,
    },
}

pub fn write(db: &mut Connection, request: Mutation) -> Reply {
    match apply(db, request) {
        Ok((parent_id, sort_order)) => Reply::Saved {
            parent_id,
            sort_order,
        },
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Mutation) -> Result<(Option<String>, f64)> {
    let tx = db.transaction()?;
    let saved = save(&tx, request)?;
    crate::request_control::commit(tx)?;
    Ok(saved)
}

fn save(db: &Connection, request: Mutation) -> Result<(Option<String>, f64)> {
    let has_parent = request.parent_id.is_some();
    let parent_id = request.parent_id.flatten();
    let has_sort_order = request.sort_order.is_some();
    let sort_order = request.sort_order.flatten();

    if let Some(parent) = parent_id.as_deref().filter(|id| !id.is_empty()) {
        let parent_exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
            [parent],
            |row| row.get(0),
        )?;
        if !parent_exists {
            return Err(format!("空间不存在：{parent}").into());
        }
    }

    Ok(db.query_row(
        "INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at)
         VALUES ($id, $name, $path,
           CASE WHEN $hasParent THEN $parent ELSE (SELECT parent_id FROM spaces WHERE id = $id) END,
           CASE WHEN $hasSortOrder THEN $sortOrder ELSE COALESCE(
             (SELECT sort_order FROM spaces WHERE id = $id),
             (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM spaces WHERE parent_id IS NOT DISTINCT FROM $parent)
           ) END,
           $at, $at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           parent_id = excluded.parent_id,
           sort_order = excluded.sort_order,
           updated_at = GREATEST(spaces.updated_at, excluded.updated_at)
         RETURNING parent_id, sort_order",
        named_params! {
            "id": request.id,
            "name": request.name,
            "path": request.path,
            "hasParent": has_parent,
            "parent": parent_id,
            "hasSortOrder": has_sort_order,
            "sortOrder": sort_order,
            "at": request.at,
        },
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

pub(crate) fn resolve_missing_task_workspace(
    db: &Connection,
    requested_id: &str,
    fallback: &TaskWorkspaceFallback,
    at: i64,
) -> Result<String> {
    let path = fallback.path.as_deref();
    if let Some(path) = path {
        let matched_path: Option<String> = db
            .query_row(
                "SELECT id FROM spaces WHERE path=?1 COLLATE NOCASE ORDER BY rowid LIMIT 1",
                [path],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = matched_path {
            return Ok(id);
        }
    }
    let existing: Option<(String, Option<String>)> = db.query_row(
        "SELECT id,path FROM spaces WHERE parent_id IS NULL AND name=?1 COLLATE NOCASE ORDER BY rowid LIMIT 1",
        [&fallback.name], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let name = if let Some((id, bound)) = existing {
        if path.is_none()
            || bound
                .as_deref()
                .is_none_or(|bound| bound.trim_end_matches(['/', '\\']) == path.unwrap_or_default())
        {
            return Ok(id);
        }
        available_root_name(db, &fallback.name, at)?
    } else {
        fallback.name.clone()
    };
    save(
        db,
        Mutation {
            id: requested_id.into(),
            name,
            path: fallback.path.clone(),
            parent_id: Some(None),
            sort_order: None,
            at,
        },
    )?;
    Ok(requested_id.into())
}

fn available_root_name(db: &Connection, base: &str, at: i64) -> Result<String> {
    let mut used = db.prepare(
        "SELECT EXISTS (SELECT 1 FROM spaces WHERE parent_id IS NULL AND name=? COLLATE NOCASE)",
    )?;
    for suffix in 2..1000 {
        let candidate = format!("{base} ({suffix})");
        if !used.query_row(params![candidate], |row| row.get::<_, bool>(0))? {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{at}"))
}
