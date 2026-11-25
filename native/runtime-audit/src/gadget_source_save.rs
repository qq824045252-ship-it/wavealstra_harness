use crate::{
    Result,
    gadget_files::{
        InputFile, MAX_MANIFEST_BYTES, Source, SourceTree, checked_directory, collect_manifest,
        collect_source, decode_source_files, gadget_root, manifest_token, validate_source_path,
    },
    library_text::is_link,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

const JOURNAL: &str = ".mybuddy-source-save";
const PREPARED: &str = "prepared.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    root: PathBuf,
    id: String,
    operation_id: String,
    token: String,
    updated_at: i64,
    files: Vec<InputFile>,
    manifest: Option<String>,
    update: Option<GadgetMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GadgetMetadata {
    name: String,
    description: Option<String>,
    metadata_json: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved { source: Source },
    ManifestSaved,
    Conflict,
    Failed { message: String },
    NeedsHost,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    operation_id: String,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    // None addresses the manifest outside code/.
    path: Option<String>,
    existed: bool,
}

enum Current {
    Source(SourceTree),
    Manifest(Vec<u8>),
}

impl Current {
    fn read(gadget: &Path, manifest_only: bool) -> Result<Self> {
        let current = if manifest_only {
            collect_manifest(gadget)?.map(Self::Manifest)
        } else {
            collect_source(gadget)?.map(Self::Source)
        };
        current.ok_or_else(|| "Gadget manifest 超过读取限制".into())
    }

    fn token(&self) -> String {
        match self {
            Self::Source(tree) => tree.token(),
            Self::Manifest(bytes) => manifest_token(bytes),
        }
    }

    fn saved(self) -> Reply {
        match self {
            Self::Source(tree) => Reply::Saved {
                source: tree.source(),
            },
            Self::Manifest(_) => Reply::ManifestSaved,
        }
    }
}

pub fn save(db: &mut Connection, save: Save) -> Reply {
    match apply_save(db, save) {
        Ok(reply) => reply,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn apply_save(db: &mut Connection, save: Save) -> Result<Reply> {
    let gadget = gadget_root(&save.root, &save.id)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let committed = committed_operation(&tx, &save.id)?;
    let journal_dir = gadget.join(JOURNAL);
    recover(&gadget, &journal_dir, committed.as_deref())?;
    let manifest_only = save.update.is_some();
    let current = Current::read(&gadget, manifest_only)?;
    if committed.as_deref() == Some(save.operation_id.as_str()) {
        return Ok(current.saved());
    }
    if current.token() != save.token {
        return Ok(Reply::Conflict);
    }
    if save
        .manifest
        .as_ref()
        .is_some_and(|manifest| manifest.len() > MAX_MANIFEST_BYTES)
    {
        return Ok(Reply::NeedsHost);
    }
    drop(current);
    let patches = if manifest_only {
        if !save.files.is_empty() {
            return Err("Gadget 配置保存不能同时替换源码文件".into());
        }
        vec![(
            None,
            save.manifest
                .ok_or("Gadget 配置保存缺少 manifest")?
                .into_bytes(),
        )]
    } else {
        decode_patches(save.files, save.manifest)?
    };

    fs::create_dir(&journal_dir)?;
    let attempt: Result<_> = (|| {
        let journal = prepare(&gadget, &journal_dir, &save.operation_id, patches)?;
        apply(&gadget, &journal_dir, &journal)?;
        let current = Current::read(&gadget, manifest_only)?;
        let changed = match save.update {
            Some(update) => crate::workbench_write::update_gadget(
                &tx,
                &save.id,
                &update.name,
                update.description.as_deref(),
                &update.metadata_json,
                save.updated_at,
            )?,
            None => tx.execute(
                "UPDATE gadgets SET updated_at=max(updated_at,?2) WHERE id=?1",
                params![save.id, save.updated_at],
            )?,
        };
        if changed != 1 {
            return Err("Gadget 不存在".into());
        }
        tx.execute(
            "INSERT INTO gadget_source_commits(gadget_id,operation_id) VALUES(?1,?2)
             ON CONFLICT(gadget_id) DO UPDATE SET operation_id=excluded.operation_id",
            params![save.id, save.operation_id],
        )?;
        tx.commit()?;
        Ok(current)
    })();

    if let Ok(tree) = attempt {
        // Once SQLite commits, an interrupted cleanup must still acknowledge the saved edit.
        if let Err(error) = cleanup_saved(db, &gadget, &journal_dir, &save.id) {
            eprintln!("[GadgetSource] journal cleanup deferred: {error}");
        }
        return Ok(tree.saved());
    }

    let recovery = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let committed = committed_operation(&recovery, &save.id)?;
    let cleanup = recover(&gadget, &journal_dir, committed.as_deref());
    if committed.as_deref() == Some(save.operation_id.as_str()) {
        // The committed receipt still protects a journal that could not be removed.
        if let Err(error) = cleanup {
            eprintln!("[GadgetSource] journal cleanup deferred: {error}");
        }
        return Ok(Current::read(&gadget, manifest_only)?.saved());
    }
    cleanup?;
    attempt?;
    Err("Gadget 保存没有提交记录".into())
}

fn cleanup_saved(db: &mut Connection, gadget: &Path, journal: &Path, id: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    recover(gadget, journal, committed_operation(&tx, id)?.as_deref())
}

fn committed_operation(db: &Connection, id: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT operation_id FROM gadget_source_commits WHERE gadget_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

fn decode_patches(
    files: Vec<InputFile>,
    manifest: Option<String>,
) -> Result<Vec<(Option<String>, Vec<u8>)>> {
    let mut patches: Vec<_> = decode_source_files(files)?
        .into_iter()
        .map(|(path, bytes)| (Some(path), bytes))
        .collect();
    if let Some(manifest) = manifest {
        patches.push((None, manifest.into_bytes()));
    }
    Ok(patches)
}

fn prepare(
    gadget: &Path,
    dir: &Path,
    operation_id: &str,
    patches: Vec<(Option<String>, Vec<u8>)>,
) -> Result<Journal> {
    let mut journal = Journal {
        operation_id: operation_id.into(),
        entries: Vec::new(),
    };
    for (index, (path, bytes)) in patches.into_iter().enumerate() {
        let target = destination(gadget, path.as_deref(), false)?;
        let existed = regular_file_exists(&target)?;
        if existed {
            let backup = dir.join(format!("old-{index}"));
            write_new(&backup, &fs::read(&target)?)?;
        }
        write_new(&dir.join(format!("new-{index}")), &bytes)?;
        journal.entries.push(Entry { path, existed });
    }
    let temporary = dir.join("plan.json");
    write_new(&temporary, &serde_json::to_vec(&journal)?)?;
    fs::rename(temporary, dir.join(PREPARED))?;
    Ok(journal)
}

fn apply(gadget: &Path, dir: &Path, journal: &Journal) -> Result<()> {
    // The preview process may hold code/ as its cwd. The individual files can be replaced.
    for (index, entry) in journal.entries.iter().enumerate() {
        let target = destination(gadget, entry.path.as_deref(), true)?;
        regular_file_exists(&target)?;
        fs::rename(dir.join(format!("new-{index}")), target)?;
    }
    Ok(())
}

pub(crate) fn has_pending(root: &Path, id: &str) -> Result<bool> {
    let gadget = gadget_root(root, id)?;
    path_exists(&gadget.join(JOURNAL))
}

pub(crate) fn recover_if_pending(db: &Connection, root: &Path, id: &str) -> Result<()> {
    let gadget = gadget_root(root, id)?;
    let dir = gadget.join(JOURNAL);
    if !path_exists(&dir)? {
        return Ok(());
    }
    recover(&gadget, &dir, committed_operation(db, id)?.as_deref())
}

fn recover(gadget: &Path, dir: &Path, committed: Option<&str>) -> Result<()> {
    if !path_exists(dir)? {
        return Ok(());
    }
    checked_directory(dir, gadget, "source journal")?;
    let marker = dir.join(PREPARED);
    if regular_file_exists(&marker)? {
        let journal: Journal = serde_json::from_reader(File::open(&marker)?)?;
        if committed != Some(journal.operation_id.as_str()) {
            for (index, entry) in journal.entries.iter().enumerate().rev() {
                // An unconsumed staged file was never renamed into the code tree.
                if regular_file_exists(&dir.join(format!("new-{index}")))? {
                    continue;
                }
                let target = destination(gadget, entry.path.as_deref(), false)?;
                if entry.existed {
                    let backup = dir.join(format!("old-{index}"));
                    if !regular_file_exists(&backup)? {
                        return Err("Gadget 源码恢复缺少原文件".into());
                    }
                    let restore = dir.join(format!("restore-{index}"));
                    if regular_file_exists(&restore)? {
                        fs::remove_file(&restore)?;
                    }
                    regular_file_exists(&target)?;
                    write_new(&restore, &fs::read(backup)?)?;
                    fs::rename(restore, target)?;
                } else if regular_file_exists(&target)? {
                    fs::remove_file(target)?;
                }
            }
        }
        fs::remove_file(marker)?;
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn regular_file_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !is_link(&metadata) && metadata.is_file() => Ok(true),
        Ok(_) => Err("Gadget 源码路径不得是符号链接或非普通文件".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn destination(gadget: &Path, path: Option<&str>, create_parents: bool) -> Result<PathBuf> {
    let Some(path) = path else {
        return Ok(gadget.join("gadget.json"));
    };
    validate_source_path(path)?;
    let mut parent = checked_directory(&gadget.join("code"), gadget, "source")?;
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        let next = parent.join(part);
        if parts.peek().is_none() {
            return Ok(next);
        }
        if path_exists(&next)? {
            parent = checked_directory(&next, gadget, "source")?;
        } else {
            if create_parents {
                fs::create_dir(&next)?;
            }
            parent = next;
        }
    }
    Err("Gadget 文件路径无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn startup_recovers_an_interrupted_save_from_its_commit() -> Result<()> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mybuddy-gadget-source-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).map_err(|error| format!("create {}: {error}", root.display()))?;
        let root = TestDirectory(root);
        let gadget = root.0.join("gdt-fixture");
        let code = gadget.join("code");
        fs::create_dir(&gadget)?;
        fs::create_dir(&code)?;
        fs::create_dir(gadget.join("data"))
            .map_err(|error| format!("create data fixture: {error}"))?;
        let gadget = gadget_root(&root.0, "gdt-fixture")
            .map_err(|error| format!("locate fixture: {error}"))?;
        let code = gadget.join("code");
        let db_path = root.0.join("app.db");
        let db = Connection::open(&db_path)?;
        db.execute_batch(
            "CREATE TABLE gadgets (id TEXT PRIMARY KEY);
             INSERT INTO gadgets VALUES ('gdt-fixture');
             CREATE TABLE gadget_source_commits (gadget_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
        )?;
        drop(db);

        for committed in [false, true] {
            fs::write(code.join("index.html"), b"before")?;
            fs::write(gadget.join("gadget.json"), br#"{"name":"before"}"#)?;
            let journal_dir = gadget.join(JOURNAL);
            fs::create_dir(&journal_dir)?;
            let journal = prepare(
                &gadget,
                &journal_dir,
                "save-fixture",
                vec![
                    (Some("index.html".into()), b"after".to_vec()),
                    (Some("new.txt".into()), b"new".to_vec()),
                    (None, br#"{"name":"after"}"#.to_vec()),
                ],
            )
            .map_err(|error| format!("prepare fixture: {error}"))?;
            let mut db = Connection::open(&db_path)?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            apply(&gadget, &journal_dir, &journal)
                .map_err(|error| format!("apply fixture: {error}"))?;
            tx.execute(
                "INSERT INTO gadget_source_commits VALUES ('gdt-fixture', 'save-fixture')",
                [],
            )?;
            if committed {
                tx.commit()?;
            } else {
                // On termination SQLite discards the uncommitted receipt, while the file replacements survive.
                drop(tx);
            }
            drop(db);
            assert_eq!(fs::read(code.join("index.html"))?, b"after");

            let mut reopened = Connection::open(&db_path)?;
            assert_eq!(
                crate::gadget_files::reconcile(&mut reopened, &root.0)?,
                Vec::<String>::new()
            );
            assert_eq!(
                crate::gadget_files::reconcile(&mut reopened, &root.0)?,
                Vec::<String>::new()
            );
            if committed {
                assert_eq!(fs::read_to_string(code.join("index.html"))?, "after");
                assert_eq!(
                    fs::read_to_string(gadget.join("gadget.json"))?,
                    r#"{"name":"after"}"#
                );
                assert_eq!(fs::read_to_string(code.join("new.txt"))?, "new");
            } else {
                assert_eq!(fs::read_to_string(code.join("index.html"))?, "before");
                assert_eq!(
                    fs::read_to_string(gadget.join("gadget.json"))?,
                    r#"{"name":"before"}"#
                );
                assert!(!code.join("new.txt").exists());
            }
        }
        Ok(())
    }
}
