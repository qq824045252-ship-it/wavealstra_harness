use crate::{Result, library_index::has_table, library_text, scoped_notes};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{self, Metadata},
    io::ErrorKind,
    path::{Component, Path},
};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Item { id: String },
    Collection { id: String },
    Space { id: String },
}

fn space_writable(db: &Connection, id: &str, deleting_space: bool) -> Result<bool> {
    let row: Option<(String, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT kind,project_id,workspace_id FROM library_spaces WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((kind, project, workspace)) = row else {
        return Ok(false);
    };
    if deleting_space && kind == "personal" {
        return Ok(false);
    }
    Ok(scoped_notes::library_owner_writable(
        db,
        project.as_deref(),
        workspace.as_deref(),
    )?)
}

fn stage_target(db: &Connection, target: &Target) -> Result<bool> {
    match target {
        Target::Item { id } => {
            let space: Option<String> = db
                .query_row(
                    "SELECT space_id FROM library_items WHERE id=?1 AND trashed_at IS NULL",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(space) = space else {
                return Ok(false);
            };
            if !space_writable(db, &space, false)? {
                return Ok(false);
            }
            db.execute("INSERT INTO temp.library_delete_items SELECT id,space_id,kind,filename FROM library_items WHERE id=?1", [id])?;
            return Ok(true);
        }
        Target::Collection { id } => {
            let space: Option<String> = db
                .query_row(
                    "SELECT space_id FROM library_collections WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(space) = space else {
                return Ok(false);
            };
            if !space_writable(db, &space, false)? {
                return Ok(false);
            }
            db.execute(
                "WITH RECURSIVE tree(id) AS (
                   SELECT id FROM library_collections WHERE id=?1
                   UNION
                   SELECT c.id FROM library_collections c JOIN tree ON c.parent_id=tree.id WHERE c.space_id=?2
                 )
                 INSERT INTO temp.library_delete_collections SELECT id FROM tree",
                params![id, space],
            )?;
            db.execute(
                "INSERT INTO temp.library_delete_items SELECT id,space_id,kind,filename FROM library_items
                 WHERE space_id=?1 AND collection_id IN (SELECT id FROM temp.library_delete_collections)",
                [space],
            )?;
        }
        Target::Space { id } => {
            if !space_writable(db, id, true)? {
                return Ok(false);
            }
            db.execute("INSERT INTO temp.library_delete_spaces VALUES (?1)", [id])?;
        }
    }
    if matches!(target, Target::Space { .. }) {
        stage_space_contents(db)?;
    }
    scope_is_consistent(db)
}

fn stage_space_contents(db: &Connection) -> Result<()> {
    db.execute_batch(
        "INSERT INTO temp.library_delete_collections SELECT id FROM library_collections
           WHERE space_id IN (SELECT id FROM temp.library_delete_spaces);
         INSERT INTO temp.library_delete_items SELECT id,space_id,kind,filename FROM library_items
           WHERE space_id IN (SELECT id FROM temp.library_delete_spaces);",
    )?;
    Ok(())
}

fn scope_is_consistent(db: &Connection) -> Result<bool> {
    let crosses_scope: bool = db.query_row(
        "SELECT
           EXISTS (SELECT 1 FROM library_collections
                   WHERE parent_id IN (SELECT id FROM temp.library_delete_collections)
                     AND id NOT IN (SELECT id FROM temp.library_delete_collections))
           OR EXISTS (SELECT 1 FROM library_items
                      WHERE collection_id IN (SELECT id FROM temp.library_delete_collections)
                        AND id NOT IN (SELECT id FROM temp.library_delete_items))",
        [],
        |row| row.get(0),
    )?;
    Ok(!crosses_scope)
}

fn prepare_staging(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS library_delete_items(id TEXT PRIMARY KEY,space_id TEXT,kind TEXT,filename TEXT);
         CREATE TEMP TABLE IF NOT EXISTS library_delete_collections(id TEXT PRIMARY KEY);
         CREATE TEMP TABLE IF NOT EXISTS library_delete_spaces(id TEXT PRIMARY KEY);
         DELETE FROM temp.library_delete_items;
         DELETE FROM temp.library_delete_collections;
         DELETE FROM temp.library_delete_spaces;",
    )?;
    Ok(())
}

fn apply_staged(db: &Connection, root: &Path) -> Result<Vec<String>> {
    db.execute(
        "INSERT OR IGNORE INTO library_file_cleanup(root,space_id,item_id,filename)
         SELECT ?1,space_id,id,filename FROM temp.library_delete_items
         WHERE kind!='url' AND space_id NOT IN (SELECT id FROM temp.library_delete_spaces)
         UNION ALL SELECT ?1,id,'',NULL FROM temp.library_delete_spaces",
        [root_key(root)?],
    )?;
    for index in ["library_fts", "library_chunks_fts"] {
        if has_table(db, index)? {
            db.execute(
                &format!("DELETE FROM {index} WHERE item_id IN (SELECT id FROM temp.library_delete_items)"),
                [],
            )?;
        }
    }
    db.execute_batch(
        "DELETE FROM library_chunk_embeddings WHERE chunk_id IN
           (SELECT id FROM library_chunks WHERE item_id IN (SELECT id FROM temp.library_delete_items));
         DELETE FROM library_chunks WHERE item_id IN (SELECT id FROM temp.library_delete_items);
         DELETE FROM library_items WHERE id IN (SELECT id FROM temp.library_delete_items);
         DELETE FROM workspace_library_collection_links WHERE collection_id IN (SELECT id FROM temp.library_delete_collections)
           OR library_space_id IN (SELECT id FROM temp.library_delete_spaces);
         DELETE FROM workspace_library_links WHERE library_space_id IN (SELECT id FROM temp.library_delete_spaces);
         DELETE FROM library_collections WHERE id IN (SELECT id FROM temp.library_delete_collections);
         DELETE FROM library_spaces WHERE id IN (SELECT id FROM temp.library_delete_spaces);",
    )?;
    let ids = db
        .prepare("SELECT id FROM temp.library_delete_items")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    db.execute_batch(
        "DELETE FROM temp.library_delete_items;
         DELETE FROM temp.library_delete_collections;
         DELETE FROM temp.library_delete_spaces;",
    )?;
    Ok(ids)
}

pub(crate) fn delete_project_spaces(
    tx: &rusqlite::Transaction<'_>,
    root: &Path,
    project_id: &str,
) -> Result<Option<Vec<String>>> {
    prepare_staging(tx)?;
    tx.execute(
        "INSERT INTO temp.library_delete_spaces SELECT id FROM library_spaces WHERE project_id=?1",
        [project_id],
    )?;
    stage_space_contents(tx)?;
    if !scope_is_consistent(tx)? {
        return Ok(None);
    }
    Ok(Some(apply_staged(tx, root)?))
}

pub fn delete(db: &mut Connection, root: &Path, target: Target) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    prepare_staging(&tx)?;
    if !stage_target(&tx, &target)? {
        return Ok(json!({ "status": "scopeChanged" }));
    }
    let ids = apply_staged(&tx, root)?;
    tx.commit()?;
    if let Err(error) = drain(db, root) {
        eprintln!("Library file cleanup will retry: {error}");
    }
    Ok(json!({ "status": "deleted", "itemIds": ids }))
}

fn root_key(root: &Path) -> Result<&str> {
    if !root.is_absolute() {
        return Err("invalid library cleanup root".into());
    }
    Ok(root.to_str().ok_or("invalid library cleanup root")?)
}

struct CleanupJob {
    space: String,
    item: String,
    filename: Option<String>,
}

pub fn drain(db: &mut Connection, root: &Path) -> Result<usize> {
    let root_key = root_key(root)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let jobs = tx
        .prepare("SELECT space_id,item_id,filename FROM library_file_cleanup WHERE root=?1")?
        .query_map([root_key], |row| {
            Ok(CleanupJob {
                space: row.get(0)?,
                item: row.get(1)?,
                filename: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut completed = 0;
    for job in jobs {
        let occupied: bool = match &job.filename {
            Some(_) => tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_items WHERE id=?1)",
                [&job.item],
                |row| row.get(0),
            )?,
            None => tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_spaces WHERE id=?1)",
                [&job.space],
                |row| row.get(0),
            )?,
        };
        if !occupied {
            if let Err(error) = remove_managed(root, &job) {
                eprintln!("Retained library cleanup job for retry: {error}");
                continue;
            }
        }
        tx.execute(
            "DELETE FROM library_file_cleanup WHERE root=?1 AND space_id=?2 AND item_id=?3",
            params![root_key, job.space, job.item],
        )?;
        completed += 1;
    }
    tx.commit()?;
    Ok(completed)
}

fn is_path_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(value)) if value == name)
        && components.next().is_none()
}

fn metadata(path: &Path) -> std::io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn remove_managed(root: &Path, job: &CleanupJob) -> Result<()> {
    if !is_path_component(&job.space) {
        return Err("invalid library cleanup space".into());
    }
    let space = root.join(&job.space);
    let Some(space_info) = metadata(&space)? else {
        return Ok(());
    };
    if library_text::is_link(&space_info) || !space_info.is_dir() {
        return Err("unsafe library cleanup directory".into());
    }
    let Some(filename) = &job.filename else {
        fs::remove_dir_all(space)?;
        return Ok(());
    };
    if !is_path_component(&job.item) || !is_path_component(filename) {
        return Err("invalid library cleanup file".into());
    }
    let path = library_text::managed_path(root, &job.space, &job.item, filename);
    if let Some(info) = metadata(&path)? {
        if library_text::is_link(&info) || !info.is_file() {
            return Err("unsafe library cleanup file".into());
        }
        fs::remove_file(&path)?;
    }
    let mut versions = path.into_os_string();
    versions.push(".versions");
    let versions = Path::new(&versions);
    if let Some(info) = metadata(versions)? {
        if library_text::is_link(&info) {
            return Err("unsafe library cleanup versions directory".into());
        }
        if info.is_dir() {
            fs::remove_dir_all(versions)?;
        } else if info.is_file() {
            fs::remove_file(versions)?;
        } else {
            return Err("unsafe library cleanup versions path".into());
        }
    }
    Ok(())
}
