use crate::{
    Result,
    gadget_files::{
        InputFile, checked_directory, collect_source, decode_source_files, gadget_path,
        gadget_root, validate_source_path,
    },
    library_text::is_link,
    workbench_write::{Gadget, GadgetOrigin, create_gadget},
};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

const OWNER: &str = ".mybuddy-create";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Create {
    root: PathBuf,
    gadget: Gadget,
    source: Material,
    manifest: String,
    entry: String,
    backend_entry: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Material {
    Generated { files: Vec<InputFile> },
    Copy { source_id: String, token: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    root: PathBuf,
    id: String,
    token: String,
    task_directory: PathBuf,
    basename: String,
    manifest: String,
    entry: String,
    readme: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Created,
    Exported {
        directory: String,
        entry_path: String,
        file_count: usize,
    },
    ScopeChanged,
    SourceChanged,
    Failed {
        message: String,
    },
}

pub fn create(db: &mut Connection, input: Create) -> Reply {
    finish(create_files(db, input))
}

pub fn export(input: Export) -> Reply {
    finish(export_files(input))
}

fn finish(result: Result<Reply>) -> Reply {
    match result {
        Ok(reply) => reply,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn create_files(db: &mut Connection, input: Create) -> Result<Reply> {
    let id = input.gadget.id().to_owned();
    let target = gadget_path(&input.root, &id)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if exists_in_database(&tx, &id)? {
        // The generated ID is stable when a worker reply was lost.
        gadget_root(&input.root, &id)?;
        remove_owner(&target, &id);
        return Ok(Reply::Created);
    }
    let (origin, files) = match input.source {
        Material::Generated { files } => (GadgetOrigin::Generated, decode_source_files(files)?),
        Material::Copy { source_id, token } => {
            let Some(files) = snapshot(&input.root, &source_id, &token, &tx)? else {
                return Ok(Reply::SourceChanged);
            };
            (GadgetOrigin::Copy { source_id }, files)
        }
    };
    if create_gadget(&tx, input.gadget, origin)? != 1 {
        return Ok(Reply::ScopeChanged);
    }
    reserve_gadget(&target, &id)?;
    let attempt = (|| -> Result<()> {
        write_new(&target.join(OWNER), id.as_bytes())?;
        materialize_gadget(
            &target,
            &files,
            &input.manifest,
            &input.entry,
            input.backend_entry.as_deref(),
        )?;
        tx.commit()?;
        Ok(())
    })();
    if attempt.is_ok() {
        remove_owner(&target, &id);
        return Ok(Reply::Created);
    }
    let recovery = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if exists_in_database(&recovery, &id)? {
        remove_owner(&target, &id);
        return Ok(Reply::Created);
    }
    if let Err(error) = fs::remove_dir_all(&target) {
        eprintln!("[GadgetStorage] creation cleanup deferred: {error}");
    }
    attempt?;
    Err("Gadget 创建没有提交记录".into())
}

fn reserve_gadget(target: &Path, id: &str) -> Result<()> {
    match fs::create_dir(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            checked_directory(target, target.parent().ok_or("Gadget 目录无效")?, "root")?;
            if !is_owner(target, id) {
                return Err(format!("Gadget storage 已存在：{id}").into());
            }
            fs::remove_dir_all(target)?;
            fs::create_dir(target)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn exists_in_database(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM gadgets WHERE id=?1)",
        [id],
        |row| row.get(0),
    )?)
}

fn is_owner(target: &Path, id: &str) -> bool {
    let marker = target.join(OWNER);
    fs::symlink_metadata(&marker).is_ok_and(|metadata| {
        metadata.is_file() && !is_link(&metadata) && metadata.len() == id.len() as u64
    }) && fs::read(&marker).is_ok_and(|bytes| bytes == id.as_bytes())
}

fn remove_owner(target: &Path, id: &str) {
    if is_owner(target, id) {
        let _ = fs::remove_file(target.join(OWNER));
    }
}

fn snapshot(
    root: &Path,
    id: &str,
    token: &str,
    db: &Connection,
) -> Result<Option<Vec<(String, Vec<u8>)>>> {
    crate::gadget_source_save::recover_if_pending(db, root, id)?;
    let Some(tree) = collect_source(&gadget_root(root, id)?)? else {
        return Ok(None);
    };
    Ok((tree.token() == token).then_some(tree.files))
}

fn materialize_source(target: &Path, files: &[(String, Vec<u8>)]) -> Result<PathBuf> {
    let code = target.join("code");
    fs::create_dir(&code)?;
    for (relative, bytes) in files {
        validate_source_path(relative)?;
        let mut cursor = code.clone();
        let mut parts = relative.split('/').peekable();
        while let Some(part) = parts.next() {
            let path = cursor.join(part);
            if parts.peek().is_none() {
                write_new(&path, bytes)?;
            } else {
                match fs::create_dir(&path) {
                    Ok(()) => (),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                        checked_directory(&path, &code, "source")?;
                    }
                    Err(error) => return Err(error.into()),
                }
                cursor = path;
            }
        }
    }
    Ok(code)
}

pub(crate) fn materialize_gadget(
    target: &Path,
    files: &[(String, Vec<u8>)],
    manifest: &str,
    entry: &str,
    backend_entry: Option<&str>,
) -> Result<()> {
    let code = materialize_source(target, files)?;
    check_entry(&code, entry, "入口文件")?;
    if let Some(backend_entry) = backend_entry {
        check_entry(&code, backend_entry, "后台入口")?;
    }
    fs::create_dir(target.join("data"))?;
    write_new(&target.join("gadget.json"), manifest.as_bytes())
}

pub(crate) fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn check_entry(code: &Path, entry: &str, label: &str) -> Result<PathBuf> {
    validate_source_path(entry)?;
    let path = code.join(entry);
    let metadata = fs::symlink_metadata(&path);
    if !metadata.is_ok_and(|metadata| metadata.is_file() && !is_link(&metadata))
        || !fs::canonicalize(&path)?.starts_with(code)
    {
        return Err(format!("Gadget {label}不存在：{entry}").into());
    }
    Ok(path)
}

fn export_files(input: Export) -> Result<Reply> {
    validate_source_path(&input.basename)?;
    if input.basename.contains('/') {
        return Err("Gadget 副本名称无效".into());
    }
    let gadget = gadget_root(&input.root, &input.id)?;
    if crate::gadget_source_save::has_pending(&input.root, &input.id)? {
        return Ok(Reply::SourceChanged);
    }
    let Some(tree) = collect_source(&gadget)? else {
        return Ok(Reply::SourceChanged);
    };
    if tree.token() != input.token {
        return Ok(Reply::SourceChanged);
    }

    if !input.task_directory.is_absolute() {
        return Err("任务工作目录必须是绝对路径".into());
    }
    let root = fs::canonicalize(&input.task_directory)?;
    let parent = root.join("gadgets");
    match fs::create_dir(&parent) {
        Ok(()) => (),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&parent)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("Gadgets 保存目录必须是真实文件夹，不能是符号链接".into());
    }
    if fs::canonicalize(&parent)? != parent {
        return Err("Gadgets 保存目录越界".into());
    }
    let directory = reserve_copy(&parent, &input.basename)?;
    let result = (|| {
        let code = materialize_source(&directory, &tree.files)?;
        let entry = check_entry(&code, &input.entry, "入口文件")?;
        write_new(&directory.join("gadget.json"), input.manifest.as_bytes())?;
        write_new(&directory.join("README.md"), input.readme.as_bytes())?;
        Ok(Reply::Exported {
            directory: workspace_path(&directory),
            entry_path: workspace_path(&entry),
            file_count: tree.files.len(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result
}

fn reserve_copy(parent: &Path, basename: &str) -> Result<PathBuf> {
    for version in 1..=10_000 {
        let candidate = if version == 1 {
            parent.join(basename)
        } else {
            parent.join(format!("{basename}-{version}"))
        };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    Err("保存副本过多，请整理任务工作目录后重试".into())
}

fn workspace_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!("\\\\{unc}");
        }
        if let Some(drive) = path.strip_prefix(r"\\?\") {
            return drive.to_owned();
        }
    }
    path.into_owned()
}
