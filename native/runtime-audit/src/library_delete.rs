use crate::{Result, library_text, scoped_notes};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
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

#[derive(Default)]
struct StagedDelete {
    items: Vec<(String, String, String, String)>,
    item_ids: HashSet<String>,
    collections: HashSet<String>,
    spaces: HashSet<String>,
}

impl StagedDelete {
    fn push_item(&mut self, row: (String, String, String, String)) {
        if self.item_ids.insert(row.0.clone()) {
            self.items.push(row);
        }
    }
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

fn stage_target(db: &Connection, target: &Target, staged: &mut StagedDelete) -> Result<bool> {
    match target {
        Target::Item { id } => {
            let row: Option<(String, String, String, String)> = db
                .query_row(
                    "SELECT id,space_id,kind,filename FROM library_items WHERE id=?1 AND trashed_at IS NULL",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let Some(item) = row else {
                return Ok(false);
            };
            if !space_writable(db, &item.1, false)? {
                return Ok(false);
            }
            staged.push_item(item);
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
            let mut stmt = db.prepare(
                "WITH RECURSIVE tree(id) AS (
                   SELECT id FROM library_collections WHERE id=?1
                   UNION
                   SELECT c.id FROM library_collections c JOIN tree ON c.parent_id=tree.id WHERE c.space_id=?2
                 )
                 SELECT id FROM tree",
            )?;
            let col_ids: Vec<String> = stmt
                .query_map(params![id, space], |r| r.get(0))?
                .collect::<duckdb::Result<_>>()?;
            staged.collections.extend(col_ids);
            if !staged.collections.is_empty() {
                let col_vec: Vec<String> = staged.collections.iter().cloned().collect();
                let slots = crate::database::anon_placeholders(col_vec.len());
                let mut q = db.prepare(&format!(
                    "SELECT id,space_id,kind,filename FROM library_items
                     WHERE space_id=? AND collection_id IN ({slots})"
                ))?;
                let mut p: Vec<&dyn duckdb::ToSql> = vec![&space];
                for cid in &col_vec {
                    p.push(cid);
                }
                let mut rows = q.query(duckdb::params_from_iter(p))?;
                while let Some(r) = rows.next()? {
                    staged.push_item((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
                }
            }
        }
        Target::Space { id } => {
            if !space_writable(db, id, true)? {
                return Ok(false);
            }
            staged.spaces.insert(id.clone());
        }
    }
    if matches!(target, Target::Space { .. }) {
        stage_space_contents(db, staged)?;
    }
    scope_is_consistent(db, staged)
}

fn stage_space_contents(db: &Connection, staged: &mut StagedDelete) -> Result<()> {
    if staged.spaces.is_empty() {
        return Ok(());
    }
    let space_vec: Vec<String> = staged.spaces.iter().cloned().collect();
    let slots = crate::database::anon_placeholders(space_vec.len());
    {
        let mut stmt = db.prepare(&format!(
            "SELECT id FROM library_collections WHERE space_id IN ({slots})"
        ))?;
        let cols: Vec<String> = stmt
            .query_map(duckdb::params_from_iter(space_vec.iter()), |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?;
        staged.collections.extend(cols);
    }
    {
        let mut stmt = db.prepare(&format!(
            "SELECT id,space_id,kind,filename FROM library_items WHERE space_id IN ({slots})"
        ))?;
        let mut rows = stmt.query(duckdb::params_from_iter(space_vec.iter()))?;
        while let Some(r) = rows.next()? {
            staged.push_item((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
        }
    }
    Ok(())
}

fn scope_is_consistent(db: &Connection, staged: &StagedDelete) -> Result<bool> {
    if staged.collections.is_empty() {
        return Ok(true);
    }
    let mut stmt = db.prepare("SELECT id, parent_id FROM library_collections WHERE parent_id IS NOT NULL")?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let parent_id: String = r.get(1)?;
        if staged.collections.contains(&parent_id) && !staged.collections.contains(&id) {
            return Ok(false);
        }
    }
    let mut i_stmt = db.prepare("SELECT id, collection_id FROM library_items WHERE collection_id IS NOT NULL")?;
    let mut i_rows = i_stmt.query([])?;
    while let Some(r) = i_rows.next()? {
        let id: String = r.get(0)?;
        let collection_id: String = r.get(1)?;
        if staged.collections.contains(&collection_id) && !staged.item_ids.contains(&id) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn apply_staged(db: &Connection, root: &Path, staged: &StagedDelete) -> Result<Vec<String>> {
    let rk = root_key(root)?;
    {
        let mut ins = db.prepare(
            "INSERT INTO library_file_cleanup(root,space_id,item_id,filename)
             VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
        )?;
        for (id, space_id, kind, filename) in &staged.items {
            if kind != "url" && !staged.spaces.contains(space_id) {
                ins.execute(params![rk, space_id, id, filename])?;
            }
        }
        for space_id in &staged.spaces {
            ins.execute(params![rk, space_id, "", Option::<String>::None])?;
        }
    }
    let item_vec: Vec<String> = staged.items.iter().map(|(id, _, _, _)| id.clone()).collect();
    if !item_vec.is_empty() {
        for id in &item_vec {
            let doc_key = format!("library:{id}");
            crate::search_postings::delete_document_postings_in_tx(db, &doc_key)?;
        }
        let slots = crate::database::anon_placeholders(item_vec.len());
        db.execute(
            &format!(
                "DELETE FROM library_chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM library_chunks WHERE item_id IN ({slots}))"
            ),
            duckdb::params_from_iter(item_vec.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM library_chunks WHERE item_id IN ({slots})"),
            duckdb::params_from_iter(item_vec.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM library_versions WHERE item_id IN ({slots})"),
            duckdb::params_from_iter(item_vec.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM library_text_saves WHERE item_id IN ({slots})"),
            duckdb::params_from_iter(item_vec.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM library_items WHERE id IN ({slots})"),
            duckdb::params_from_iter(item_vec.iter()),
        )?;
    }
    if !staged.collections.is_empty() {
        let col_vec: Vec<String> = staged.collections.iter().cloned().collect();
        let slots = crate::database::anon_placeholders(col_vec.len());
        db.execute(
            &format!(
                "DELETE FROM workspace_library_collection_links WHERE collection_id IN ({slots})"
            ),
            duckdb::params_from_iter(col_vec.iter()),
        )?;
    }
    if !staged.spaces.is_empty() {
        let space_vec: Vec<String> = staged.spaces.iter().cloned().collect();
        let slots = crate::database::anon_placeholders(space_vec.len());
        db.execute(
            &format!(
                "DELETE FROM workspace_library_collection_links WHERE library_space_id IN ({slots})"
            ),
            duckdb::params_from_iter(space_vec.iter()),
        )?;
        db.execute(
            &format!("DELETE FROM workspace_library_links WHERE library_space_id IN ({slots})"),
            duckdb::params_from_iter(space_vec.iter()),
        )?;
    }
    if !staged.collections.is_empty() {
        let col_vec: Vec<String> = staged.collections.iter().cloned().collect();
        let slots = crate::database::anon_placeholders(col_vec.len());
        db.execute(
            &format!("DELETE FROM library_collections WHERE id IN ({slots})"),
            duckdb::params_from_iter(col_vec.iter()),
        )?;
    }
    if !staged.spaces.is_empty() {
        let space_vec: Vec<String> = staged.spaces.iter().cloned().collect();
        let slots = crate::database::anon_placeholders(space_vec.len());
        db.execute(
            &format!("DELETE FROM library_spaces WHERE id IN ({slots})"),
            duckdb::params_from_iter(space_vec.iter()),
        )?;
    }
    Ok(item_vec)
}

pub(crate) fn delete_project_spaces(
    tx: &duckdb::Transaction<'_>,
    root: &Path,
    project_id: &str,
) -> Result<Option<Vec<String>>> {
    let mut staged = StagedDelete::default();
    {
        let mut stmt = tx.prepare("SELECT id FROM library_spaces WHERE project_id=?1")?;
        let space_ids: Vec<String> = stmt
            .query_map([project_id], |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?;
        staged.spaces.extend(space_ids);
    }
    stage_space_contents(tx, &mut staged)?;
    if !scope_is_consistent(tx, &staged)? {
        return Ok(None);
    }
    Ok(Some(apply_staged(tx, root, &staged)?))
}

pub fn delete(db: &mut Connection, root: &Path, target: Target) -> Result<Value> {
    let tx = match db.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            crate::request_control::known_failure();
            return Err(error.into());
        }
    };
    let mut staged_data = StagedDelete::default();
    let staged = match stage_target(&tx, &target, &mut staged_data) {
        Ok(true) => Ok(Some(apply_staged(&tx, root, &staged_data)?)),
        Ok(false) => Ok(None),
        Err(error) => Err(error),
    };
    let ids = match staged {
        Ok(Some(ids)) => ids,
        Ok(None) => {
            tx.rollback()?;
            return Ok(json!({ "status": "scopeChanged" }));
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            return Err(error);
        }
    };
    crate::request_control::commit(tx)?;
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
    let tx = db.transaction()?;
    let jobs = tx
        .prepare("SELECT space_id,item_id,filename FROM library_file_cleanup WHERE root=?1")?
        .query_map([root_key], |row| {
            Ok(CleanupJob {
                space: row.get(0)?,
                item: row.get(1)?,
                filename: row.get(2)?,
            })
        })?
        .collect::<duckdb::Result<Vec<_>>>()?;
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
    crate::request_control::commit(tx)?;
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
