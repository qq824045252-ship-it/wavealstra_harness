use crate::{Result, library_text, sqlite_rows::records};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
};

// Keep JSON replies below the worker's line limit even for control-heavy text.
const INLINE_TEXT_BYTES: usize = 4 * 1024 * 1024;

pub(crate) const ITEMS: &str =
    "id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
    favorite, url, source_type, source_task_id, source_artifact_id, original_path, content_hash,
    extract_status, created_at, updated_at, last_visited_at, trashed_at, note_metadata";

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
        owner: Option<CatalogOwner>,
    },
    TaskScope {
        task_id: Option<String>,
        project_id: Option<String>,
        workspace_id: Option<String>,
        item_ids: Option<Vec<String>>,
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
    IndexCandidates {
        work: IndexWork,
        after: Option<String>,
        limit: usize,
    },
    NoteWritesSupported,
    NoteRestoresSupported,
    TextSavesSupported,
    DeletesSupported,
    BackupsSupported,
    RestoreBackupsSupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexWork {
    Documents,
    Text,
    Chunks,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CatalogOwner {
    Personal,
    Project { project_id: String },
    Workspace { workspace_id: String },
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Catalog { space_ids, item_id, owner } => catalog(db, space_ids, item_id, owner),
        Query::IndexCandidates { work, after, limit } => index_candidates(db, work, after, limit),
        Query::TaskScope { task_id, project_id, workspace_id, item_ids } => {
            task_scope(db, task_id.as_deref(), project_id, workspace_id, item_ids)
        }
        Query::Trash { space_ids } => {
            if space_ids.is_empty() {
                return Ok(Value::Array(Vec::new()));
            }
            let slots = crate::database::anon_placeholders(space_ids.len());
            let mut rows = records(
                db,
                &format!(
                    "SELECT {ITEMS} FROM library_items i
                     WHERE trashed_at IS NOT NULL AND trashed_at != 0 AND space_id IN ({slots})
                     ORDER BY lower(title), rowid"
                ),
                duckdb::params_from_iter(space_ids.iter()),
            )?;
            let order: std::collections::HashMap<&str, usize> = space_ids
                .iter()
                .enumerate()
                .map(|(idx, id)| (id.as_str(), idx))
                .collect();
            rows.sort_by_key(|item| {
                item.get("space_id")
                    .and_then(Value::as_str)
                    .and_then(|s| order.get(s).copied())
                    .unwrap_or(usize::MAX)
            });
            Ok(rows.into())
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

fn index_candidates(
    db: &Connection,
    work: IndexWork,
    after: Option<String>,
    limit: usize,
) -> Result<Value> {
    let predicate = match work {
        IndexWork::Documents => "kind IN ('office','pdf') AND (
            extract_status IS NULL OR extract_status IN ('pending','error')
            OR (extract_status='extracted' AND NOT EXISTS (
                SELECT 1 FROM search_documents d WHERE d.doc_key='library:' || i.id)))",
        IndexWork::Text => "kind IN ('markdown','html','csv') AND NOT EXISTS (
            SELECT 1 FROM search_documents d WHERE d.doc_key='library:' || i.id)",
        IndexWork::Chunks => "(kind IN ('markdown','html','csv') OR
            (kind IN ('office','pdf') AND extract_status='extracted')) AND NOT EXISTS (
            SELECT 1 FROM library_chunks c WHERE c.item_id=i.id)",
    };
    Ok(records(
        db,
        &format!("SELECT {ITEMS} FROM library_items i
            WHERE trashed_at IS NULL AND (?1 IS NULL OR id>?1) AND ({predicate})
            ORDER BY id LIMIT ?2"),
        params![after, limit.clamp(1, 100) as i64],
    )?.into())
}

fn task_scope(
    db: &Connection,
    task_id: Option<&str>,
    project_id: Option<String>,
    workspace_id: Option<String>,
    item_ids: Option<Vec<String>>,
) -> Result<Value> {
    let task_id = task_id.map(str::trim).filter(|id| !id.is_empty());
    let nullable_id = |id: String| {
        let id = id.trim();
        (!id.is_empty()).then(|| id.to_owned())
    };
    let (project_id, workspace_id): (Option<String>, Option<String>) = if let Some(task_id) = task_id {
        let Some(task) = db.query_row(
            "SELECT project_id, space_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()? else { return Ok(Value::Null) };
        task
    } else {
        (project_id.and_then(nullable_id), workspace_id.and_then(nullable_id))
    };
    let owner_exists: bool = db.query_row(
        "SELECT (?1 IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ?1))
             AND (?2 IS NULL OR EXISTS (SELECT 1 FROM spaces WHERE id = ?2))",
        params![&project_id, &workspace_id],
        |row| row.get(0),
    )?;
    if !owner_exists {
        return Ok(Value::Null);
    }

    let mut args: Vec<duckdb::types::Value> = vec![
        project_id.clone().into(),
        workspace_id.clone().into(),
        task_id.map(str::to_owned).into(),
    ];
    let item_filter = match item_ids {
        Some(ids) if ids.is_empty() => "AND FALSE".into(),
        Some(ids) => {
            let slots = crate::database::placeholders(ids.len(), args.len() + 1);
            args.extend(ids.into_iter().map(duckdb::types::Value::Text));
            format!("AND i.id IN ({slots})")
        }
        None => String::new(),
    };
    let items = records(db, &format!(
        "WITH RECURSIVE chain(id, parent_id, archived) AS (
           SELECT id, parent_id, archived FROM spaces WHERE id = ?2
           UNION SELECT s.id, s.parent_id, s.archived FROM spaces s JOIN chain c ON s.id = c.parent_id
         ), active_workspaces(id) AS (
           SELECT id FROM chain WHERE NOT EXISTS (SELECT 1 FROM chain WHERE archived <> 0)
         ), allowed_spaces(id) AS (
           SELECT l.id FROM library_spaces l WHERE (l.project_id IS NULL OR l.project_id = ?1)
             AND (l.workspace_id IS NULL OR (l.project_id IS NULL AND EXISTS(SELECT 1 FROM spaces WHERE id = l.workspace_id)))
             AND (l.kind <> 'personal' OR (l.project_id IS NULL AND l.workspace_id IS NULL))
         ), full_spaces(id) AS (
           SELECT l.id FROM library_spaces l WHERE l.project_id = ?1 OR l.workspace_id IN (SELECT id FROM active_workspaces)
           UNION SELECT library_space_id FROM workspace_library_links WHERE workspace_id IN (SELECT id FROM active_workspaces)
         ), linked_folders(space_id, id) AS (
           SELECT c.space_id, c.id FROM workspace_library_collection_links w
             JOIN library_collections c ON c.id = w.collection_id AND c.space_id = w.library_space_id
             WHERE w.workspace_id IN (SELECT id FROM active_workspaces)
           UNION SELECT c.space_id, c.id FROM library_collections c JOIN linked_folders p ON c.parent_id = p.id AND c.space_id = p.space_id
         )
         SELECT {ITEMS} FROM library_items i WHERE i.trashed_at IS NULL
           AND i.space_id IN (SELECT id FROM allowed_spaces)
           AND (i.space_id IN (SELECT id FROM full_spaces)
             OR EXISTS (SELECT 1 FROM linked_folders f WHERE f.id = i.collection_id AND f.space_id = i.space_id)
             OR EXISTS (SELECT 1 FROM task_library_references a WHERE a.task_id = ?3 AND a.item_id = i.id)
             OR EXISTS (SELECT 1 FROM project_context_pins p WHERE p.project_id = ?1 AND p.item_id = i.id))
           {item_filter} ORDER BY lower(i.title), i.rowid"
    ), duckdb::params_from_iter(args))?;
    let visible_items: BTreeSet<_> = items.iter().filter_map(|item| item["id"].as_str()).collect();
    let visible_spaces: BTreeSet<_> = items.iter().filter_map(|item| item["space_id"].as_str()).collect();
    let spaces = if visible_spaces.is_empty() {
        Vec::new()
    } else {
        let slots = crate::database::anon_placeholders(visible_spaces.len());
        records(db, &format!(
            "SELECT id, name, kind, project_id, workspace_id, created_at, updated_at FROM library_spaces
             WHERE id IN ({slots}) ORDER BY created_at, rowid"
        ), duckdb::params_from_iter(visible_spaces))?
    };
    let reference_ids = |sql: &str, owner_id: Option<&str>| -> Result<Vec<String>> {
        let Some(owner_id) = owner_id else { return Ok(Vec::new()) };
        let mut stmt = db.prepare(sql)?;
        let ids = stmt.query_map([owner_id], |row| row.get::<_, String>(0))?.collect::<duckdb::Result<Vec<_>>>()?;
        Ok(ids.into_iter().filter(|id| visible_items.contains(id.as_str())).collect())
    };
    let attached_item_ids = reference_ids(
        "SELECT item_id FROM task_library_references WHERE task_id = ?1 ORDER BY added_at DESC, rowid", task_id,
    )?;
    let pinned_item_ids = reference_ids(
        "SELECT item_id FROM project_context_pins WHERE project_id = ?1 ORDER BY created_at DESC, rowid", project_id.as_deref(),
    )?;
    Ok(json!({
        "projectId": project_id, "workspaceId": workspace_id, "spaces": spaces, "items": items,
        "attachedItemIds": attached_item_ids, "pinnedItemIds": pinned_item_ids,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_scope_preserves_attachments_pins_and_folder_boundaries() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch(crate::database::CANONICAL_DUCKDB_SCHEMA_SQL)?;
        db.execute_batch(
            "INSERT INTO projects (id,name,created_at,updated_at) VALUES ('ours','Ours',1,1),('other','Other',1,1);
             INSERT INTO spaces (id,name,parent_id,created_at,updated_at) VALUES ('parent','Parent',NULL,1,1),('child','Child','parent',1,1);
             INSERT INTO tasks (id,title,project_id,space_id,updated_at) VALUES ('task','Task','ours','child',1);
             INSERT INTO library_spaces (id,name,kind,project_id,workspace_id,created_at,updated_at) VALUES
               ('own','Own','team','ours',NULL,1,1),('foreign','Foreign','team','other',NULL,1,1),
               ('personal','Personal','personal',NULL,NULL,1,1),('shelf','Shelf','team',NULL,NULL,1,1);
             INSERT INTO library_collections (id,space_id,parent_id,name,created_at,updated_at) VALUES
               ('tree','shelf',NULL,'Tree',1,1),('subtree','shelf','tree','Subtree',1,1),('unshared','shelf',NULL,'Unshared',1,1);
             INSERT INTO workspace_library_collection_links VALUES ('parent','shelf','tree',1);
             INSERT INTO library_items (id,space_id,collection_id,kind,title,filename,created_at,updated_at) VALUES
               ('project-item','own',NULL,'markdown','Charlie','c.md',1,1),
               ('secret','foreign',NULL,'markdown','Foreign','foreign.md',1,1),
               ('attachment','personal',NULL,'markdown','Delta','d.md',1,1),
               ('pin','personal',NULL,'markdown','Alpha','a.md',1,1),
               ('linked','shelf','subtree','markdown','Bravo','b.md',1,1),
               ('sibling','shelf','unshared','markdown','Sibling','sibling.md',1,1);
             INSERT INTO task_library_references (task_id,item_id,added_at,added_by) VALUES
               ('task','attachment',1,'user'),('task','secret',2,'user');
             INSERT INTO project_context_pins (id,project_id,item_id,created_at) VALUES ('pin-link','ours','pin',2);",
        )?;
        let snapshot = db.transaction()?;
        let catalog = task_scope(&snapshot, Some("task"), Some("other".into()), None, None)?;
        assert_eq!(catalog["projectId"], "ours");
        assert_eq!(catalog["workspaceId"], "child");
        let ids: Vec<_> = catalog["items"].as_array().unwrap().iter().filter_map(|item| item["id"].as_str()).collect();
        assert_eq!(ids, ["pin", "linked", "project-item", "attachment"]);
        assert_eq!(catalog["attachedItemIds"], json!(["attachment"]));
        assert_eq!(catalog["pinnedItemIds"], json!(["pin"]));
        let witness = task_scope(&snapshot, Some("task"), None, None, Some(vec!["secret".into(), "pin".into()]))?;
        assert_eq!(witness["items"].as_array().unwrap().len(), 1);
        assert_eq!(witness["items"][0]["id"], "pin");
        assert_eq!(witness["attachedItemIds"], json!([]));
        assert_eq!(task_scope(&snapshot, Some("missing"), Some("ours".into()), None, None)?, Value::Null);
        snapshot.commit()?;

        db.execute("UPDATE spaces SET archived = 1 WHERE id = 'parent'", [])?;
        db.execute("DELETE FROM task_library_references WHERE item_id = 'attachment'", [])?;
        let updated = task_scope(&db, Some("task"), None, None, None)?;
        let ids: Vec<_> = updated["items"].as_array().unwrap().iter().filter_map(|item| item["id"].as_str()).collect();
        assert_eq!(ids, ["pin", "project-item"]);
        assert_eq!(updated["attachedItemIds"], json!([]));
        Ok(())
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
        .prepare(
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
    mut space_ids: Option<Vec<String>>,
    item_id: Option<String>,
    owner: Option<CatalogOwner>,
) -> Result<Value> {
    let owner_name: String = db.query_row(
        "SELECT coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我')", [], |row| row.get(0),
    )?;
    if let Some(owner) = owner {
        let (sql, id) = match &owner {
            CatalogOwner::Personal => ("SELECT id FROM library_spaces WHERE project_id IS NULL AND workspace_id IS NULL", None),
            CatalogOwner::Project { project_id } => ("SELECT l.id FROM library_spaces l JOIN projects p ON p.id=l.project_id WHERE p.id=?", Some(project_id.trim())),
            CatalogOwner::Workspace { workspace_id } => ("SELECT l.id FROM library_spaces l JOIN spaces s ON s.id=l.workspace_id WHERE s.id=?", Some(workspace_id.trim())),
        };
        let mut stmt = db.prepare(sql)?;
        let mut owned = stmt.query_map(duckdb::params_from_iter(id), |row| row.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        if let Some(requested) = &space_ids {
            owned.retain(|id| requested.contains(id));
        }
        space_ids = Some(owned);
    }
    if let Some(ids) = &space_ids
        && ids.is_empty()
    {
        return Ok(Value::Object(Map::from_iter([
            ("spaces".into(), Value::Array(Vec::new())),
            ("items".into(), Value::Array(Vec::new())),
            ("collections".into(), Value::Array(Vec::new())),
            ("recentIds".into(), Value::Array(Vec::new())),
            ("usedBytes".into(), Value::from(0)),
            ("ownerName".into(), owner_name.into()),
            ("artifacts".into(), Value::Array(Vec::new())),
        ])));
    }
    let items = {
        let mut conds = vec!["trashed_at IS NULL".to_owned()];
        let mut p: Vec<duckdb::types::Value> = Vec::new();
        if let Some(ids) = &space_ids {
            conds.push(format!("space_id IN ({})", crate::database::anon_placeholders(ids.len())));
            p.extend(ids.iter().cloned().map(duckdb::types::Value::Text));
        }
        if let Some(id) = &item_id {
            conds.push("id = ?".to_owned());
            p.push(duckdb::types::Value::Text(id.clone()));
        }
        records(
            db,
            &format!(
                "SELECT {ITEMS} FROM library_items WHERE {} ORDER BY lower(title), rowid",
                conds.join(" AND ")
            ),
            duckdb::params_from_iter(p),
        )?
    };
    let spaces = {
        let mut conds = Vec::new();
        let mut p: Vec<duckdb::types::Value> = Vec::new();
        if let Some(ids) = &space_ids {
            conds.push(format!("l.id IN ({})", crate::database::anon_placeholders(ids.len())));
            p.extend(ids.iter().cloned().map(duckdb::types::Value::Text));
        }
        if let Some(id) = &item_id {
            conds.push(
                "l.id = (SELECT space_id FROM library_items WHERE id = ? AND trashed_at IS NULL)"
                    .to_owned(),
            );
            p.push(duckdb::types::Value::Text(id.clone()));
        }
        let where_clause = if conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conds.join(" AND "))
        };
        records(
            db,
            &format!(
                "SELECT l.id, l.name, l.kind, l.project_id, l.workspace_id, l.created_at, l.updated_at,
                        p.name AS project_name, w.name AS workspace_name
                 FROM library_spaces l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN spaces w ON w.id = l.workspace_id
                 {where_clause}
                 ORDER BY CASE l.kind WHEN 'personal' THEN 0 ELSE 1 END, l.created_at, l.rowid"
            ),
            duckdb::params_from_iter(p),
        )?
    };
    let collections = if item_id.is_some() {
        Vec::new()
    } else if let Some(ids) = &space_ids {
        let slots = crate::database::anon_placeholders(ids.len());
        records(
            db,
            &format!(
                "SELECT id, space_id, parent_id, name, owner, created_at, updated_at
                 FROM library_collections WHERE space_id IN ({slots}) ORDER BY lower(name), rowid"
            ),
            duckdb::params_from_iter(ids.iter()),
        )?
    } else {
        records(
            db,
            "SELECT id, space_id, parent_id, name, owner, created_at, updated_at
             FROM library_collections ORDER BY lower(name), rowid",
            [],
        )?
    };
    let recent_ids = if item_id.is_some() {
        Vec::new()
    } else if let Some(ids) = &space_ids {
        let slots = crate::database::anon_placeholders(ids.len());
        let mut statement = db.prepare(&format!(
            "SELECT id FROM (SELECT id, space_id FROM library_items
             WHERE trashed_at IS NULL AND kind != 'url' AND last_visited_at IS NOT NULL
             ORDER BY last_visited_at DESC, updated_at DESC LIMIT 40)
             WHERE space_id IN ({slots})"
        ))?;
        statement
            .query_map(duckdb::params_from_iter(ids.iter()), |row| row.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?
    } else {
        let mut statement = db.prepare(
            "SELECT id FROM library_items
             WHERE trashed_at IS NULL AND kind != 'url' AND last_visited_at IS NOT NULL
             ORDER BY last_visited_at DESC, updated_at DESC LIMIT 40",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?
    };
    let used_bytes: i64 = if space_ids.is_none() && item_id.is_none() {
        db.query_row(
            "SELECT CAST(coalesce(sum(size_bytes),0) AS BIGINT) FROM library_items",
            [],
            |row| row.get(0),
        )?
    } else {
        items
            .iter()
            .filter_map(|item| item.get("size_bytes")?.as_i64())
            .sum()
    };
    let artifacts = if space_ids.is_none() && item_id.is_none() {
        records(db,
            "SELECT a.id, a.task_id, a.space_id, a.kind, a.title, a.updated_at, t.title AS task_title, s.name AS space_name
             FROM artifacts a LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN spaces s ON s.id=a.space_id
             ORDER BY a.updated_at DESC, a.id LIMIT 200", [])?
    } else {
        Vec::new()
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
        ("ownerName".into(), owner_name.into()),
        ("artifacts".into(), artifacts.into()),
    ])))
}
