use crate::{Result, library_text, sqlite_rows::records};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

// Keep JSON replies below the worker's line limit even for control-heavy text.
const INLINE_TEXT_BYTES: usize = 4 * 1024 * 1024;

pub(crate) const ITEMS: &str =
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
    VersionBody {
        item_id: String,
        version: i64,
    },
    TextBody {
        item_id: String,
        root: PathBuf,
        max_chars: Option<usize>,
    },
    NoteWritesSupported,
    NoteRestoresSupported,
    TextSavesSupported,
    DeletesSupported,
    BackupsSupported,
    RestoreBackupsSupported,
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
        Query::VersionBody { item_id, version } => read_version_body(db, &item_id, version),
        Query::TextBody {
            item_id,
            root,
            max_chars,
        } => read_text_body(db, &item_id, &root, max_chars),
        Query::NoteWritesSupported
        | Query::NoteRestoresSupported
        | Query::TextSavesSupported
        | Query::DeletesSupported
        | Query::BackupsSupported
        | Query::RestoreBackupsSupported => Ok(Value::Bool(true)),
    }
}

fn read_text_body(
    db: &Connection,
    item_id: &str,
    root: &Path,
    max_chars: Option<usize>,
) -> Result<Value> {
    let Some(mut item) = records(
        db,
        &format!("SELECT {ITEMS} FROM library_items WHERE id=?1 AND trashed_at IS NULL"),
        [item_id],
    )?
    .pop() else {
        return Ok(json!({ "status": "missingItem" }));
    };
    let needs_host = || json!({ "status": "needsHost" });
    if !matches!(item["kind"].as_str(), Some("markdown" | "html" | "csv")) {
        return Ok(needs_host());
    }
    let space = item["space_id"].as_str().ok_or("missing library space")?;
    let filename = item["filename"]
        .as_str()
        .ok_or("missing library filename")?;
    let path = library_text::managed_path(root, space, item_id, filename);
    let Ok(Some(file)) = library_text::open_managed(root, &path, space, item_id) else {
        return Ok(needs_host());
    };
    let cap = match max_chars {
        Some(max) if max < INLINE_TEXT_BYTES / 4 => (max + 1) * 4,
        Some(_) => return Ok(needs_host()),
        None => INLINE_TEXT_BYTES + 1,
    };
    let mut bytes = Vec::new();
    if file.take(cap as u64).read_to_end(&mut bytes).is_err() {
        return Ok(needs_host());
    }
    let content = String::from_utf8_lossy(&bytes);
    if let Some(max) = max_chars {
        let mut units = 0;
        for (offset, character) in content.char_indices() {
            units += character.len_utf16();
            if units > max {
                return Ok(
                    json!({ "status": "ok", "item": item, "content": &content[..offset], "contentTruncated": true }),
                );
            }
        }
        return Ok(
            json!({ "status": "ok", "item": item, "content": content, "contentTruncated": false }),
        );
    }
    if bytes.len() > INLINE_TEXT_BYTES {
        return Ok(needs_host());
    }
    if !item["content_hash"]
        .as_str()
        .is_some_and(|hash| !hash.is_empty())
    {
        item["content_hash"] = json!(format!("{:x}", Sha256::digest(content.as_bytes())));
    }
    Ok(json!({ "status": "ok", "item": item, "content": content }))
}

fn read_version_body(db: &Connection, item_id: &str, version: i64) -> Result<Value> {
    let row = db
        .prepare_cached(
            "SELECT v.id, v.content_hash, CASE WHEN length(v.snapshot)<=?3 THEN v.snapshot END
         FROM library_items i LEFT JOIN library_versions v ON v.item_id=i.id AND v.version=?2
         WHERE i.id=?1 AND i.trashed_at IS NULL",
        )?
        .query_row(params![item_id, version, INLINE_TEXT_BYTES], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })
        .optional()?;
    Ok(match row {
        None => json!({ "status": "missingItem" }),
        Some((None, _, _)) => json!({ "status": "missingVersion" }),
        Some((_, Some(hash), Some(bytes))) => {
            if format!("{:x}", Sha256::digest(&bytes)) == hash {
                json!({ "status": "ok", "content": String::from_utf8_lossy(&bytes) })
            } else {
                json!({ "status": "unavailable" })
            }
        }
        Some(_) => json!({ "status": "needsHost" }),
    })
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
