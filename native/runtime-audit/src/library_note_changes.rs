use crate::{
    Result, library_index, library_metadata::ITEMS, library_text, scoped_notes,
    sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const MAX_INLINE_RESTORE_BYTES: usize = 4 * library_text::LARGE_TEXT_BYTES;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    id: String,
    space_id: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    SaveArtifact { save: crate::library_artifact_save::Save },
    Import {batch:crate::library_import::Batch},
    Create {document:crate::library_create_document::Document},
    Metadata {
        owner: Option<crate::library_backup::Owner>,
        item: Target,
        tags: Option<Vec<String>>,
        pinned: Option<bool>,
    },
    Move {
        owner: Option<crate::library_backup::Owner>,
        items: Vec<Target>,
        collection_id: Option<String>,
    },
    Trash {
        owner: Option<crate::library_backup::Owner>,
        items: Vec<Target>,
    },
    Restore {
        owner: Option<crate::library_backup::Owner>,
        items: Vec<Target>,
        root: PathBuf,
        chunk_size: usize,
        overlap: usize,
    },
}

fn writable(db: &Connection, item: &Target, include_trash: bool) -> Result<bool> {
    let scope = db.prepare(
        "SELECT s.project_id,s.workspace_id FROM library_items i JOIN library_spaces s ON s.id=i.space_id
         WHERE i.id=?1 AND i.space_id=?2 AND (?3 OR i.trashed_at IS NULL)"
    )?.query_row(params![item.id, item.space_id, include_trash], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))
    }).optional()?;
    let Some((project, workspace)) = scope else {
        return Ok(false);
    };
    Ok(scoped_notes::library_owner_writable(
        db,
        project.as_deref(),
        workspace.as_deref(),
    )?)
}

pub fn write(db: &mut Connection, change: Change, updated_at: i64) -> Result<Value> {
    if let Change::SaveArtifact { save }=change { return crate::library_artifact_save::write(db,save,updated_at); }
    if let Change::Import {batch}=change {return crate::library_import::apply(db,batch,updated_at);}
    if let Change::Create {document}=change { return crate::library_create_document::create(db,document,updated_at); }
    let tx = db.transaction()?;
    let items = match &change {
        Change::SaveArtifact {..} | Change::Import {..} | Change::Create {..} => unreachable!(),
        Change::Metadata { item, .. } => std::slice::from_ref(item),
        Change::Move { items, .. } | Change::Trash { items, .. } | Change::Restore { items, .. } => {
            items
        }
    };
    let include_trash = matches!(&change, Change::Trash { .. } | Change::Restore { .. });
    let owner = match &change {
        Change::Metadata { owner, .. } | Change::Move { owner, .. } | Change::Trash { owner, .. } | Change::Restore { owner, .. } => owner,
        _ => unreachable!(),
    };
    let spaces = owner.as_ref().map(|owner| crate::library_backup::spaces(&tx, owner)).transpose()?;
    for item in items {
        if spaces.as_ref().is_some_and(|ids| !ids.contains(&item.space_id)) || !writable(&tx, item, include_trash)? {
            return Ok(json!({ "status": "scopeChanged" }));
        }
    }
    let response = match change {
        Change::SaveArtifact {..} | Change::Import {..} | Change::Create {..} => unreachable!(),
        Change::Metadata { item, tags, pinned, .. } => {
            let metadata: Option<String> = tx.query_row(
                "SELECT note_metadata FROM library_items WHERE id=?1",
                [&item.id],
                |row| row.get(0),
            )?;
            let mut metadata = metadata
                .as_deref()
                .filter(|text| !text.is_empty())
                .map(serde_json::from_str::<Map<String, Value>>)
                .transpose()?
                .unwrap_or_default();
            if let Some(tags) = tags {
                metadata.insert("tags".into(), json!(tags));
            }
            if let Some(pinned) = pinned {
                metadata.insert("pinned".into(), json!(pinned));
            }
            tx.execute(
                "UPDATE library_items SET note_metadata=?1,updated_at=?2 WHERE id=?3",
                params![serde_json::to_string(&metadata)?, updated_at, item.id],
            )?;
            let row = records(
                &tx,
                &format!("SELECT {ITEMS} FROM library_items WHERE id=?1"),
                [&item.id],
            )?
            .pop()
            .ok_or("updated note missing")?;
            json!({ "status": "updated", "item": row })
        }
        Change::Move {
            items,
            collection_id, ..
        } => {
            if let Some(id) = &collection_id {
                let space: Option<String> = tx
                    .query_row(
                        "SELECT space_id FROM library_collections WHERE id=?1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if space.is_none()
                    || items
                        .iter()
                        .any(|item| Some(&item.space_id) != space.as_ref())
                {
                    return Ok(json!({ "status": "folderChanged" }));
                }
            }
            let mut update = tx.prepare(
                "UPDATE library_items SET collection_id=?1,updated_at=?2 WHERE id=?3",
            )?;
            for item in items {
                update.execute(params![collection_id, updated_at, item.id])?;
            }
            json!({ "status": "updated" })
        }
        Change::Trash { items, .. } => {
            let mut update = tx.prepare(
                "UPDATE library_items SET trashed_at=?1,updated_at=?1 WHERE id=?2 AND coalesce(trashed_at,0)=0"
            )?;
            for item in items {
                update.execute(params![updated_at, item.id])?;
            }
            json!({ "status": "updated" })
        }
        Change::Restore {
            items,
            root,
            chunk_size,
            overlap, ..
        } => {
            if !root.is_absolute() {
                return Err("invalid library restore root".into());
            }
            library_text::validate_chunk_sizes(chunk_size, overlap)?;
            let mut indexed = Vec::new();
            for item in items {
                match restore_item(&tx, &item, &root, updated_at, chunk_size, overlap)? {
                    RestoreItem::Indexed => indexed.push(item.id),
                    RestoreItem::NeedsHost => return Ok(json!({ "status": "needsHost" })),
                    RestoreItem::SourceUnavailable => {
                        return Ok(json!({ "status": "sourceUnavailable" }));
                    }
                    RestoreItem::Unindexed => {}
                }
            }
            json!({ "status": "updated", "indexed": indexed })
        }
    };
    tx.commit()?;
    Ok(response)
}

enum RestoreItem {
    Indexed,
    Unindexed,
    NeedsHost,
    SourceUnavailable,
}

fn restore_item(
    db: &Connection,
    item: &Target,
    root: &Path,
    updated_at: i64,
    chunk_size: usize,
    overlap: usize,
) -> Result<RestoreItem> {
    let row = db
        .prepare(
            "UPDATE library_items SET trashed_at=NULL,updated_at=GREATEST(updated_at, ?1)
         WHERE id=?2 AND coalesce(trashed_at,0)!=0 RETURNING kind,filename,size_bytes",
        )?
        .query_row(params![updated_at, item.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .optional()?;
    let Some((kind, filename, size)) = row else {
        return Ok(RestoreItem::Unindexed);
    };
    if !matches!(kind.as_str(), "markdown" | "html" | "csv") {
        return Ok(RestoreItem::Unindexed);
    }
    let path = library_text::managed_path(root, &item.space_id, &item.id, &filename);
    let source = library_text::open_managed(root, &path, &item.space_id, &item.id);
    if size > library_text::LARGE_TEXT_BYTES as i64 {
        let Ok(Some(mut file)) = source else {
            return Ok(RestoreItem::SourceUnavailable);
        };
        library_index::index_streamed_text(
            db, &item.id, &mut file, updated_at, chunk_size, overlap,
        )?;
    } else {
        // The original small-text index also permits missing or unreadable bodies.
        let mut bytes = Vec::new();
        if let Ok(Some(file)) = source {
            if file
                .take((MAX_INLINE_RESTORE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .is_err()
            {
                bytes.clear();
            }
        }
        if bytes.len() > MAX_INLINE_RESTORE_BYTES {
            // The file was changed outside MyBuddy and its catalog size no longer describes it.
            return Ok(RestoreItem::NeedsHost);
        }
        let body = String::from_utf8_lossy(&bytes);
        let chunks = library_index::document_chunks(&body, chunk_size, overlap)?;
        library_index::index_inline_text(db, &item.id, &body, &chunks, updated_at)?;
    }
    Ok(RestoreItem::Indexed)
}
