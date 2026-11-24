use crate::{Result, sqlite_rows::records};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value};

const ITEMS: &str =
    "id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
    favorite, url, source_type, source_task_id, source_artifact_id, original_path, content_hash,
    extract_status, created_at, updated_at, last_visited_at, trashed_at, note_metadata";
const ELIGIBLE: &str = "(?1 IS NULL OR space_id IN (SELECT value FROM json_each(?1)))";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Catalog {
        space_ids: Option<Vec<String>>,
        item_id: Option<String>,
    },
    Trash {
        space_ids: Vec<String>,
    },
    Versions {
        item_id: String,
    },
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Catalog { space_ids, item_id } => catalog(db, space_ids, item_id),
        Query::Trash { space_ids } => {
            // Keep the scope's space order, then the normal title order within each space.
            Ok(records(db, &format!(
                "SELECT {ITEMS} FROM library_items i
                 WHERE trashed_at IS NOT NULL AND trashed_at != 0 AND space_id IN (SELECT value FROM json_each(?1))
                 ORDER BY (SELECT key FROM json_each(?1) WHERE value = i.space_id), title COLLATE NOCASE, rowid"
            ), [serde_json::to_string(&space_ids)?])?.into())
        }
        Query::Versions { item_id } => {
            let available: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_items WHERE id = ?1 AND trashed_at IS NULL)",
                [&item_id],
                |row| row.get(0),
            )?;
            if !available {
                return Ok(Value::Null);
            }
            Ok(records(db,
                "SELECT id, item_id, version, content_hash, path, created_by, source_task_id, created_at
                 FROM library_versions WHERE item_id = ?1 ORDER BY version DESC",
                [&item_id],
            )?.into())
        }
    }
}

fn catalog(
    db: &Connection,
    space_ids: Option<Vec<String>>,
    item_id: Option<String>,
) -> Result<Value> {
    let spaces_param = space_ids.as_ref().map(serde_json::to_string).transpose()?;
    let items = records(
        db,
        &format!(
            "SELECT {ITEMS} FROM library_items WHERE {ELIGIBLE} AND trashed_at IS NULL
         AND (?2 IS NULL OR id = ?2) ORDER BY title COLLATE NOCASE, rowid"
        ),
        rusqlite::params![spaces_param, item_id],
    )?;
    let spaces = records(db,
        "SELECT l.id, l.name, l.kind, l.project_id, l.workspace_id, l.created_at, l.updated_at,
                p.name AS project_name, w.name AS workspace_name
         FROM library_spaces l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN spaces w ON w.id = l.workspace_id
         WHERE (?1 IS NULL OR l.id IN (SELECT value FROM json_each(?1)))
           AND (?2 IS NULL OR l.id = (SELECT space_id FROM library_items WHERE id = ?2 AND trashed_at IS NULL))
         ORDER BY CASE l.kind WHEN 'personal' THEN 0 ELSE 1 END, l.created_at, l.rowid",
        rusqlite::params![spaces_param, item_id],
    )?;
    let collections = if item_id.is_some() {
        Vec::new()
    } else {
        records(
            db,
            &format!(
                "SELECT id, space_id, parent_id, name, owner, created_at, updated_at
             FROM library_collections WHERE {ELIGIBLE} ORDER BY name COLLATE NOCASE, rowid"
            ),
            [&spaces_param],
        )?
    };
    let recent_ids = if item_id.is_some() {
        Vec::new()
    } else {
        let mut statement = db.prepare_cached(
            "SELECT id FROM (SELECT id, space_id FROM library_items
             WHERE trashed_at IS NULL AND kind != 'url' AND last_visited_at IS NOT NULL
             ORDER BY last_visited_at DESC, updated_at DESC LIMIT 40)
             WHERE (?1 IS NULL OR space_id IN (SELECT value FROM json_each(?1)))",
        )?;
        statement
            .query_map([&spaces_param], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let used_bytes: i64 = if spaces_param.is_none() && item_id.is_none() {
        db.query_row(
            "SELECT coalesce(sum(size_bytes),0) FROM library_items",
            [],
            |row| row.get(0),
        )?
    } else {
        items
            .iter()
            .filter_map(|item| item.get("size_bytes")?.as_i64())
            .sum()
    };
    Ok(Value::Object(Map::from_iter([
        ("spaces".into(), spaces.into()),
        ("items".into(), items.into()),
        ("collections".into(), collections.into()),
        (
            "recentIds".into(),
            Value::Array(recent_ids.into_iter().map(Value::String).collect()),
        ),
        ("usedBytes".into(), used_bytes.into()),
    ])))
}
