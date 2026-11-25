use crate::Result;
use rusqlite::{Connection, TransactionBehavior, named_params};
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
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let has_parent = request.parent_id.is_some();
    let parent_id = request.parent_id.flatten();
    let has_sort_order = request.sort_order.is_some();
    let sort_order = request.sort_order.flatten();

    if let Some(parent) = parent_id.as_deref().filter(|id| !id.is_empty()) {
        let parent_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
            [parent],
            |row| row.get(0),
        )?;
        if !parent_exists {
            return Err(format!("空间不存在：{parent}").into());
        }
    }

    let saved = tx.query_row(
        "INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at)
         VALUES (:id, :name, :path,
           CASE WHEN :hasParent THEN :parent ELSE (SELECT parent_id FROM spaces WHERE id = :id) END,
           CASE WHEN :hasSortOrder THEN :sortOrder ELSE COALESCE(
             (SELECT sort_order FROM spaces WHERE id = :id),
             (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM spaces WHERE parent_id IS :parent)
           ) END,
           :at, :at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           parent_id = excluded.parent_id,
           sort_order = excluded.sort_order,
           updated_at = max(spaces.updated_at, excluded.updated_at)
         RETURNING parent_id, sort_order",
        named_params! {
            ":id": request.id,
            ":name": request.name,
            ":path": request.path,
            ":hasParent": has_parent,
            ":parent": parent_id,
            ":hasSortOrder": has_sort_order,
            ":sortOrder": sort_order,
            ":at": request.at,
        },
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    tx.commit()?;
    Ok(saved)
}
