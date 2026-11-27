use crate::{Result, library_text::is_link};
use base64::{Engine, engine::general_purpose::STANDARD};
use regex_lite::Regex;
use duckdb::{Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) const MAX_FILES: usize = 512;
pub(crate) const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SourceReply {
    Read(Source),
    Inspected(SourceInfo),
    Manifest {
        manifest: String,
        token: String,
    },
    Captured {
        manifest: String,
        files: Vec<SourceFile>,
    },
    Rejected {
        message: String,
    },
    NeedsHost,
}

#[derive(Serialize)]
pub struct SourceInfo {
    manifest: String,
    paths: Vec<String>,
    token: String,
}

#[derive(Deserialize)]
pub struct InputFile {
    path: String,
    base64: String,
}

#[derive(Serialize)]
pub struct Source {
    manifest: String,
    files: Vec<SourceFile>,
    token: String,
}

#[derive(Serialize)]
pub(crate) struct SourceFile {
    path: String,
    // Base64 bounds the wire size even for UTF-8 source containing control characters.
    content: String,
    text: bool,
}

pub(crate) struct SourceTree {
    manifest: Vec<u8>,
    pub(crate) files: Vec<(String, Vec<u8>)>,
}

impl SourceTree {
    pub(crate) fn token(&self) -> String {
        let mut hash = Sha256::new();
        let mut files: Vec<_> = self.files.iter().collect();
        files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        hash.update(Sha256::digest(&self.manifest));
        for (path, bytes) in files {
            hash.update((path.len() as u64).to_le_bytes());
            hash.update(path.as_bytes());
            hash.update(Sha256::digest(bytes));
        }
        format!("{:x}", hash.finalize())
    }

    pub(crate) fn source(self) -> Source {
        Source {
            token: self.token(),
            manifest: String::from_utf8_lossy(&self.manifest).into_owned(),
            files: self
                .files
                .into_iter()
                .map(|(path, bytes)| encode_file(path, &bytes))
                .collect(),
        }
    }

    fn inspect(self) -> SourceInfo {
        SourceInfo {
            token: self.token(),
            manifest: String::from_utf8_lossy(&self.manifest).into_owned(),
            paths: self.files.into_iter().map(|(path, _)| path).collect(),
        }
    }
}

pub(crate) fn encode_file(path: String, bytes: &[u8]) -> SourceFile {
    SourceFile {
        path,
        content: STANDARD.encode(bytes),
        text: std::str::from_utf8(bytes).is_ok(),
    }
}

pub(crate) fn manifest_token(manifest: &[u8]) -> String {
    format!("{:x}", Sha256::digest(manifest))
}

pub fn read_manifest(root: &Path, id: &str) -> SourceReply {
    reply(gadget_root(root, id).and_then(|gadget| {
        checked_directory(&gadget.join("code"), &gadget, "source")?;
        checked_directory(&gadget.join("data"), &gadget, "data")?;
        Ok(match collect_manifest(&gadget)? {
            Some(bytes) => SourceReply::Manifest {
                token: manifest_token(&bytes),
                manifest: String::from_utf8_lossy(&bytes).into_owned(),
            },
            None => SourceReply::NeedsHost,
        })
    }))
}

pub fn capture_blueprint(root: &Path, id: &str, deny: &Regex) -> SourceReply {
    reply(gadget_root(root, id).and_then(|gadget| {
        Ok(match collect_with_filter(&gadget, Some(deny))? {
            Some(tree) => SourceReply::Captured {
                manifest: String::from_utf8_lossy(&tree.manifest).into_owned(),
                files: tree
                    .files
                    .into_iter()
                    .map(|(path, bytes)| encode_file(path, &bytes))
                    .collect(),
            },
            None => SourceReply::NeedsHost,
        })
    }))
}

fn reply(result: Result<SourceReply>) -> SourceReply {
    result.unwrap_or_else(|error| SourceReply::Rejected {
        message: error.to_string(),
    })
}

pub fn read_source(root: &Path, id: &str, inspect: bool) -> SourceReply {
    match gadget_root(root, id).and_then(|gadget| collect_source(&gadget)) {
        Ok(Some(tree)) if inspect => SourceReply::Inspected(tree.inspect()),
        Ok(Some(tree)) => SourceReply::Read(tree.source()),
        Ok(None) => SourceReply::NeedsHost,
        Err(error) => SourceReply::Rejected {
            message: error.to_string(),
        },
    }
}

pub(crate) fn gadget_root(root: &Path, id: &str) -> Result<PathBuf> {
    let path = gadget_path(root, id)?;
    checked_directory(
        &path,
        path.parent().ok_or("Gadget storage 路径无效")?,
        "root",
    )
}

pub(crate) fn gadget_path(root: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Gadget id 无效".into());
    }
    Ok(physical_root(root)?.join(id))
}

pub(crate) fn collect_source(gadget: &Path) -> Result<Option<SourceTree>> {
    collect_with_filter(gadget, None)
}

fn collect_with_filter(gadget: &Path, capture: Option<&Regex>) -> Result<Option<SourceTree>> {
    let code = checked_directory(&gadget.join("code"), gadget, "source")?;
    checked_directory(&gadget.join("data"), gadget, "data")?;
    let Some(manifest) = collect_manifest(gadget)? else {
        return Ok(None);
    };
    let mut files = Vec::new();
    let mut total = 0;
    collect_files(&code, &code, &mut total, &mut files, capture)?;
    Ok(Some(SourceTree { manifest, files }))
}

pub(crate) fn collect_manifest(gadget: &Path) -> Result<Option<Vec<u8>>> {
    let manifest_path = fs::canonicalize(gadget.join("gadget.json"))?;
    if !manifest_path.starts_with(gadget) || !fs::metadata(&manifest_path)?.is_file() {
        return Err("Gadget manifest 符号链接越界或不是普通文件".into());
    }
    let manifest = read_at_most(&manifest_path, MAX_MANIFEST_BYTES)?;
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Ok(None);
    }
    Ok(Some(manifest))
}

fn collect_files(
    root: &Path,
    dir: &Path,
    total: &mut usize,
    files: &mut Vec<(String, Vec<u8>)>,
    capture: Option<&Regex>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if capture.is_some_and(|deny| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(".cache") || deny.is_match(&name)
        }) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if is_link(&metadata) {
            if capture.is_some() {
                continue;
            }
            return Err("Gadget 源码包含符号链接，不能编辑".into());
        }
        let real = fs::canonicalize(&path)?;
        if !real.starts_with(root) {
            return Err("Gadget 文件路径越界".into());
        }
        if metadata.is_dir() {
            collect_files(root, &real, total, files, capture)?;
            continue;
        }
        if !metadata.is_file() {
            if capture.is_some() {
                continue;
            }
            return Err("Gadget 源码包含非普通文件".into());
        }
        let limit = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES - *total);
        if metadata.len() > limit as u64 || files.len() >= MAX_FILES {
            return Err("Gadget 源码超过读取大小限制".into());
        }
        let bytes = read_at_most(&real, limit)?;
        if bytes.len() > limit {
            return Err("Gadget 源码超过读取大小限制".into());
        }
        *total += bytes.len();
        let relative = path
            .strip_prefix(root)?
            .to_str()
            .ok_or("Gadget 文件路径不是 UTF-8")?;
        files.push((relative.replace('\\', "/"), bytes));
    }
    Ok(())
}

pub(crate) fn read_at_most(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(crate) fn physical_root(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err("Gadget storage 路径必须是绝对路径".into());
    }
    checked_directory(root, &fs::canonicalize(root)?, "root")
}

pub(crate) fn decode_source_files(files: Vec<InputFile>) -> Result<Vec<(String, Vec<u8>)>> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("Gadget 源码文件数量无效".into());
    }
    let mut total = 0;
    let mut unique = HashSet::new();
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        validate_source_path(&file.path)?;
        if !unique.insert(file.path.to_lowercase()) {
            return Err("Gadget 源码路径重复".into());
        }
        if file.base64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
            return Err("Gadget 源码超过写入大小限制".into());
        }
        let bytes = STANDARD.decode(file.base64)?;
        total += bytes.len();
        if bytes.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return Err("Gadget 源码超过写入大小限制".into());
        }
        decoded.push((file.path, bytes));
    }
    Ok(decoded)
}

pub(crate) fn validate_source_path(path: &str) -> Result<()> {
    for part in path.split('/') {
        if !valid_windows_component(part)
            || matches!(
                part,
                "node_modules" | "cache" | ".next" | "dist" | "build" | ".mybuddy-task.json"
            )
        {
            return Err(format!("Gadget 文件路径无效：{path}").into());
        }
    }
    Ok(())
}

pub(crate) fn valid_windows_component(part: &str) -> bool {
    let base = part.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (base.starts_with("com") || base.starts_with("lpt"))
            && base.len() == 4
            && matches!(base.as_bytes()[3], b'1'..=b'9');
    !part.is_empty()
        && !part.ends_with(['.', ' '])
        && !reserved
        && !part
            .bytes()
            .any(|byte| byte < 32 || b"<>:\"|?*\\".contains(&byte))
}

pub(crate) fn checked_directory(path: &Path, root: &Path, label: &str) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(format!("Gadget {label} storage 不得是符号链接或非目录").into());
    }
    let real = fs::canonicalize(path)?;
    if !real.starts_with(root) {
        return Err(format!("Gadget {label} storage 越界").into());
    }
    Ok(real)
}

pub fn reconcile(db: &mut Connection, root: &Path) -> Result<Vec<String>> {
    let root = physical_root(root)?;
    let transaction = db.transaction()?;
    let ids = {
        let mut query = transaction.prepare("SELECT id FROM gadgets")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<duckdb::Result<HashSet<_>>>()?
    };
    let mut failed = Vec::new();
    let mut generation = None;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if ids.contains(name) {
            if let Err(error) = crate::gadget_source_save::recover_if_pending(
                &transaction,
                &root,
                name,
            )
            .and_then(|()| {
                crate::blueprint_storage::cleanup_committed_marker(&transaction, &entry.path())
            }) {
                failed.push(format!("{name}: {error}"));
            }
            continue;
        }
        let Some(suffix) = name.strip_prefix("gdt-") else {
            continue;
        };
        if suffix.is_empty()
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            continue;
        }
        let path = entry.path();
        if generation.is_none() {
            generation = Some(crate::managed_storage_owner::generation(&transaction)?);
        }
        if !crate::managed_storage_owner::matches(&path, generation.as_deref().unwrap_or_default()) {
            continue;
        }
        if let Err(error) =
            fs::symlink_metadata(&path).and_then(|metadata| remove_orphan(&path, &metadata))
        {
            failed.push(format!("{name}: {error}"));
        }
    }
    transaction.commit()?;
    Ok(failed)
}

pub(crate) fn remove_orphan(path: &Path, metadata: &Metadata) -> std::io::Result<()> {
    if is_link(metadata) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x10 != 0 {
                return fs::remove_dir(path);
            }
        }
        return fs::remove_file(path);
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

pub(crate) fn remove_unregistered(db: &mut Connection, root: &Path, id: &str) -> Result<bool> {
    let target = gadget_path(root, id)?;
    let tx = db.transaction()?;
    let registered: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM gadgets WHERE id=?1)",
        [id],
        |row| row.get(0),
    )?;
    if registered {
        return Ok(false);
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) => remove_orphan(&target, &metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(true)
}
