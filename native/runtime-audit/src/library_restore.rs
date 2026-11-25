use crate::{Result, library_backup, library_index, library_text, scoped_notes};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use flate2::read::MultiGzDecoder;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufReader, ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Deserialize)]
pub struct Backup {
    format: String,
    version: u32,
    folders: Vec<Folder>,
    items: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    space_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    parent_id: Option<String>,
    name: String,
    owner: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct Entry {
    item: Item,
    #[serde(deserialize_with = "Option::deserialize")]
    body: Option<String>,
    history: Vec<Version>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    space_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    collection_id: Option<String>,
    kind: String,
    title: String,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    owner: String,
    favorite: bool,
    #[serde(default, deserialize_with = "optional")]
    url: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    source_type: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    content_hash: Option<String>,
    created_at: i64,
    updated_at: i64,
    #[serde(deserialize_with = "Option::deserialize")]
    last_visited_at: Option<i64>,
    #[serde(default, deserialize_with = "optional")]
    trashed_at: Option<i64>,
    #[serde(flatten)]
    note: NoteMetadata,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteMetadata {
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pinned: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    tags: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    clip_source: Option<ClipSource>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipSource {
    url: String,
    title: String,
    captured_at: i64,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    failed_images: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    id: String,
    version: i64,
    content_hash: String,
    created_by: String,
    created_at: i64,
    #[serde(deserialize_with = "Option::deserialize")]
    body: Option<String>,
}

fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    input: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(input).map(Some)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_date(value: i64) -> bool {
    (0..=9_007_199_254_740_991).contains(&value)
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_web_url(value: &str) -> bool {
    value.split_once("://").is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) && url::Url::parse(value).is_ok_and(|url| url.has_host())
}

fn valid_base64(value: &str) -> bool {
    let body = value.trim_end_matches('=');
    value.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn decode_base64(value: &str) -> Result<Vec<u8>> {
    let value = value.trim_end_matches('=');
    // Legacy restore used Buffer.from, which ignores one dangling base64 digit.
    let len = value.len() - usize::from(value.len() % 4 == 1);
    Ok(BASE64.decode(&value.as_bytes()[..len])?)
}

impl Backup {
    fn validate(&self) -> Result<()> {
        if self.format != "mybuddy-notes"
            || self.version != 1
            || self.folders.iter().any(|folder| {
                folder.name.is_empty()
                    || !valid_id(&folder.id)
                    || !valid_id(&folder.space_id)
                    || !folder.parent_id.as_deref().is_none_or(valid_id)
                    || !valid_date(folder.created_at)
                    || !valid_date(folder.updated_at)
            })
            || self.items.iter().any(|entry| !entry.valid())
        {
            return Err("这不是有效的 MyBuddy 笔记备份".into());
        }
        if self
            .folders
            .iter()
            .map(|folder| &folder.id)
            .collect::<HashSet<_>>()
            .len()
            != self.folders.len()
            || self
                .items
                .iter()
                .map(|entry| &entry.item.id)
                .collect::<HashSet<_>>()
                .len()
                != self.items.len()
        {
            return Err("备份中存在重复的资料 ID".into());
        }
        Ok(())
    }
}

impl Entry {
    fn valid(&self) -> bool {
        let item = &self.item;
        valid_id(&item.id)
            && valid_id(&item.space_id)
            && item.collection_id.as_deref().is_none_or(valid_id)
            && matches!(
                item.kind.as_str(),
                "markdown" | "html" | "csv" | "office" | "pdf" | "image" | "file" | "url"
            )
            && library_backup::valid_filename(&item.filename)
            && library_backup::valid_mime(&item.mime_type)
            && valid_date(item.size_bytes)
            && valid_date(item.created_at)
            && valid_date(item.updated_at)
            && item.last_visited_at.is_none_or(valid_date)
            && item.trashed_at.is_none_or(valid_date)
            && item.content_hash.as_deref().is_none_or(valid_hash)
            && item.url.as_deref().is_none_or(valid_web_url)
            && item
                .source_type
                .as_deref()
                .is_none_or(|source| matches!(source, "created" | "uploaded" | "artifact" | "url"))
            && item
                .note
                .clip_source
                .as_ref()
                .is_none_or(|clip| valid_date(clip.captured_at) && valid_web_url(&clip.url))
            && self.body.as_deref().is_none_or(valid_base64)
            && self.history.iter().all(|version| {
                valid_id(&version.id)
                    && version.version > 0
                    && valid_date(version.version)
                    && valid_date(version.created_at)
                    && valid_hash(&version.content_hash)
                    && version.body.as_deref().is_none_or(valid_base64)
            })
    }
}

pub fn prepare(source: &Path) -> Result<Backup> {
    let file = File::open(source)?;
    let metadata = file.metadata()?;
    let limit = library_backup::BACKUP_LIMIT as u64;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("备份文件过大或无法读取".into());
    }
    let mut input = MultiGzDecoder::new(file.take(limit + 1)).take(limit + 1);
    let parsed = serde_json::from_reader::<_, Backup>(BufReader::new(&mut input));
    if input.limit() == 0 || input.into_inner().into_inner().limit() == 0 {
        return Err("备份文件过大".into());
    }
    let backup = parsed.map_err(|_| "这不是有效的 MyBuddy 笔记备份")?;
    backup.validate()?;
    Ok(backup)
}

fn folder_order(backup: &Backup) -> Result<Vec<usize>> {
    let indices: HashMap<&str, usize> = backup
        .folders
        .iter()
        .enumerate()
        .map(|(index, folder)| (folder.id.as_str(), index))
        .collect();
    let mut ready = VecDeque::new();
    let mut children = vec![Vec::new(); backup.folders.len()];
    for (index, folder) in backup.folders.iter().enumerate() {
        match folder.parent_id.as_deref().and_then(|id| indices.get(id)) {
            Some(parent) => children[*parent].push(index),
            None => ready.push_back(index),
        }
    }
    let mut order = Vec::with_capacity(indices.len());
    while let Some(index) = ready.pop_front() {
        order.push(index);
        ready.extend(children[index].iter().copied());
    }
    if order.len() != indices.len() {
        return Err("备份中的文件夹层级无效".into());
    }
    Ok(order)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    pub operation_id: String,
    root: PathBuf,
    owner: library_backup::Owner,
    default_space_id: String,
    chunk_size: usize,
    overlap: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    restored: usize,
    skipped: usize,
    indexed_text: bool,
    pending_extraction: bool,
}

#[derive(PartialEq, Eq)]
struct Destination {
    index: usize,
    space: String,
}

#[derive(PartialEq, Eq)]
struct Plan {
    folders: Vec<Destination>,
    items: Vec<Destination>,
    skipped: usize,
}

fn require_writable(db: &Connection, space: &str, checked: &mut HashSet<String>) -> Result<()> {
    if !checked.insert(space.to_owned()) {
        return Ok(());
    }
    let owners: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT project_id,workspace_id FROM library_spaces WHERE id=?1",
            [space],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((project, workspace)) = owners {
        if scoped_notes::library_owner_writable(db, project.as_deref(), workspace.as_deref())? {
            return Ok(());
        }
    }
    Err("目标资料位置已归档或不可用".into())
}

fn require_folder(
    db: &Connection,
    planned: &HashMap<&str, String>,
    folder: Option<&str>,
    space: &str,
) -> Result<()> {
    let Some(id) = folder else {
        return Ok(());
    };
    let current = match planned.get(id) {
        Some(space) => Some(space.clone()),
        None => db
            .query_row(
                "SELECT space_id FROM library_collections WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?,
    };
    if current.as_deref() != Some(space) {
        return Err("目标集合不存在或不属于同一空间（禁止跨项目/跨作用域移动）".into());
    }
    Ok(())
}

fn plan(db: &Connection, backup: &Backup, order: &[usize], request: &Restore) -> Result<Plan> {
    let spaces: HashSet<String> = library_backup::spaces(db, &request.owner)?
        .into_iter()
        .collect();
    if !spaces.contains(&request.default_space_id) {
        return Err("目标不属于当前查看范围".into());
    }
    let remap = |space: &str| {
        spaces
            .get(space)
            .unwrap_or(&request.default_space_id)
            .clone()
    };
    let mut checked = HashSet::new();
    let mut folders = Vec::new();
    let mut planned = HashMap::new();
    for &index in order {
        let folder = &backup.folders[index];
        let space = remap(&folder.space_id);
        require_writable(db, &space, &mut checked)?;
        require_folder(db, &planned, folder.parent_id.as_deref(), &space)?;
        let existing: Option<String> = db
            .query_row(
                "SELECT space_id FROM library_collections WHERE id=?1",
                [&folder.id],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            Some(id) if id != space => return Err("备份文件夹 ID 与其他范围的资料冲突".into()),
            None => folders.push(Destination {
                index,
                space: space.clone(),
            }),
            Some(_) => {}
        }
        planned.insert(folder.id.as_str(), space);
    }
    let mut items = Vec::new();
    let mut skipped = 0;
    for (index, entry) in backup.items.iter().enumerate() {
        let item = &entry.item;
        let existing: Option<String> = db
            .query_row(
                "SELECT space_id FROM library_items WHERE id=?1",
                [&item.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(space) = existing {
            if !spaces.contains(&space) {
                return Err("备份笔记 ID 与其他范围的资料冲突".into());
            }
            skipped += 1;
            continue;
        }
        let space = remap(&item.space_id);
        require_writable(db, &space, &mut checked)?;
        require_folder(db, &planned, item.collection_id.as_deref(), &space)?;
        let has_content = if item.kind == "url" {
            item.url.is_some() && entry.body.is_none()
        } else {
            entry.body.is_some()
        };
        if !has_content {
            return Err("备份缺少资料内容".into());
        }
        if entry.body.is_some() {
            let path = library_text::managed_path(&request.root, &space, &item.id, &item.filename);
            if library_text::open_managed(&request.root, &path, &space, &item.id)?.is_some() {
                return Err("本地存在同名受管文件，无法安全恢复".into());
            }
        }
        items.push(Destination { index, space });
    }
    Ok(Plan {
        folders,
        items,
        skipped,
    })
}

fn verify_history(backup: &Backup, plan: &Plan) -> Result<()> {
    for destination in &plan.items {
        for version in &backup.items[destination.index].history {
            if let Some(body) = &version.body {
                let content = decode_base64(body)?;
                if format!("{:x}", Sha256::digest(&content)) != version.content_hash {
                    return Err("备份版本校验失败".into());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn valid_operation(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

pub fn restore(db: &mut Connection, backup: Backup, request: Restore) -> Result<Option<Receipt>> {
    if !request.root.is_absolute() || !valid_operation(&request.operation_id) {
        return Err("备份恢复位置无效".into());
    }
    library_text::validate_chunk_sizes(request.chunk_size, request.overlap)?;
    let order = folder_order(&backup)?;
    let root = request.root.to_str().ok_or("备份恢复路径无效")?;
    let interrupted: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_restore_files WHERE root=?1)",
        [root],
        |row| row.get(0),
    )?;
    if interrupted {
        recover(db, &request.root, None)?;
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let planned = plan(&tx, &backup, &order, &request)?;
    // Reserve exact paths before handing any files to the managed library.
    for destination in &planned.items {
        let entry = &backup.items[destination.index];
        if entry.body.is_some() {
            reserve_file(
                &tx,
                root,
                &request.operation_id,
                &destination.space,
                &entry.item.id,
                &entry.item.filename,
            )?;
        }
    }
    tx.commit()?;

    let applied = verify_history(&backup, &planned)
        .and_then(|()| apply(db, backup, &order, &planned, &request));
    let cleanup = recover(db, &request.root, Some(&request.operation_id));
    match applied {
        Ok(receipt) => {
            if let Err(error) = cleanup {
                eprintln!("Library restore cleanup will retry: {error}");
            }
            Ok(Some(receipt))
        }
        Err(error) if error.is::<UnsupportedLink>() && matches!(cleanup, Ok(0)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn apply(
    db: &mut Connection,
    mut backup: Backup,
    order: &[usize],
    planned: &Plan,
    request: &Restore,
) -> Result<Receipt> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if plan(&tx, &backup, order, request)? != *planned {
        return Err("资料位置或内容已变化，请刷新后重试".into());
    }
    for destination in &planned.folders {
        let folder = &backup.folders[destination.index];
        tx.execute(
            "INSERT INTO library_collections(id,space_id,parent_id,name,owner,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![&folder.id, &destination.space, &folder.parent_id, &folder.name, &folder.owner, folder.created_at, folder.updated_at],
        )?;
    }
    let mut receipt = Receipt {
        restored: planned.items.len(),
        skipped: planned.skipped,
        indexed_text: false,
        pending_extraction: false,
    };
    for destination in &planned.items {
        let entry = &mut backup.items[destination.index];
        apply_item(&tx, entry, &destination.space, request, &mut receipt)?;
    }
    tx.execute(
        "INSERT INTO library_restore_receipts(root,operation_id,result_json) VALUES(?1,?2,?3)
         ON CONFLICT(root) DO UPDATE SET operation_id=excluded.operation_id,result_json=excluded.result_json",
        params![request.root.to_str(), &request.operation_id, serde_json::to_string(&receipt)?],
    )?;
    tx.commit()?;
    Ok(receipt)
}

fn apply_item(
    db: &Connection,
    entry: &mut Entry,
    space: &str,
    request: &Restore,
    receipt: &mut Receipt,
) -> Result<()> {
    let item = &entry.item;
    let path = library_text::managed_path(&request.root, space, &item.id, &item.filename);
    let bytes = entry
        .body
        .take()
        .map(|body| decode_base64(&body))
        .transpose()?;
    if let Some(bytes) = &bytes {
        publish(&path, bytes, &request.operation_id, &item.id)?;
    }
    let visible = item.trashed_at.unwrap_or(0) == 0;
    let text = matches!(item.kind.as_str(), "markdown" | "html" | "csv");
    let extract = visible && matches!(item.kind.as_str(), "office" | "pdf");
    let extraction_status = if !visible || text {
        None
    } else if extract {
        Some("pending")
    } else {
        Some("unsupported")
    };
    db.execute(
        "INSERT INTO library_items(id,space_id,collection_id,kind,title,filename,mime_type,size_bytes,
            owner,favorite,url,source_type,content_hash,extract_status,created_at,updated_at,last_visited_at,trashed_at,note_metadata)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![
            &item.id, space, &item.collection_id, &item.kind, &item.title, &item.filename, &item.mime_type,
            bytes.as_ref().map_or(0, Vec::len), &item.owner, item.favorite, &item.url,
            item.source_type.as_deref().unwrap_or("created"),
            bytes.as_deref().map(|bytes| format!("{:x}", Sha256::digest(bytes))), extraction_status,
            item.created_at, item.updated_at, item.last_visited_at, item.trashed_at, serde_json::to_string(&item.note)?,
        ],
    )?;
    if visible && text {
        let bytes = bytes.as_deref().unwrap_or_default();
        if bytes.len() > library_text::LARGE_TEXT_BYTES {
            library_index::index_streamed_text(
                db,
                &item.id,
                &mut File::open(&path)?,
                item.updated_at,
                request.chunk_size,
                request.overlap,
            )?;
        } else {
            let body = String::from_utf8_lossy(bytes);
            let chunks =
                library_index::document_chunks(&body, request.chunk_size, request.overlap)?;
            library_index::index_inline_text(db, &item.id, &body, &chunks, item.updated_at)?;
        }
        receipt.indexed_text = true;
    }
    drop(bytes);
    receipt.pending_extraction |= extract;
    for version in entry.history.drain(..) {
        let snapshot = version.body.map(|body| decode_base64(&body)).transpose()?;
        let version_path = if item.kind == "url" {
            ""
        } else {
            path.to_str().ok_or("历史版本路径无效")?
        };
        db.execute(
            "INSERT INTO library_versions(id,item_id,version,content_hash,path,created_by,created_at,snapshot)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![version.id, &item.id, version.version, version.content_hash, version_path, version.created_by, version.created_at, snapshot],
        )?;
    }
    Ok(())
}

fn staging_path(path: &Path, operation: &str, item: &str) -> PathBuf {
    path.with_file_name(format!(".mybuddy-restore-{operation}-{item}.tmp"))
}

#[derive(Debug)]
pub(crate) struct UnsupportedLink;
impl std::fmt::Display for UnsupportedLink {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("资料库文件系统不支持原子恢复")
    }
}
impl std::error::Error for UnsupportedLink {}

pub(crate) fn reserve_file(
    db: &Connection,
    root: &str,
    operation: &str,
    space: &str,
    item: &str,
    filename: &str,
) -> rusqlite::Result<()> {
    let inserted = db.execute(
        "INSERT INTO library_restore_files(root,operation_id,space_id,item_id,filename) VALUES(?1,?2,?3,?4,?5)",
        params![root, operation, space, item, filename],
    )?;
    if inserted != 1 {
        return Err(rusqlite::Error::StatementChangedRows(inserted));
    }
    Ok(())
}

pub(crate) fn publish(path: &Path, bytes: &[u8], operation: &str, item: &str) -> Result<()> {
    let parent = path.parent().ok_or("恢复目录不存在")?;
    if let Err(error) = fs::create_dir(parent) {
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }
    let parent_info = fs::symlink_metadata(parent)?;
    if library_text::is_link(&parent_info) || !parent_info.is_dir() {
        return Err("恢复目录不可安全写入".into());
    }
    let temp = staging_path(path, operation, item);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    match fs::hard_link(&temp, path) {
        Ok(()) => {}
        Err(error)
            if error.kind() == ErrorKind::Unsupported
                || cfg!(windows) && error.raw_os_error() == Some(50) =>
        {
            return Err(UnsupportedLink.into());
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

struct RestoreFile {
    operation: String,
    space: String,
    item: String,
    filename: String,
}

fn safe_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !library_text::is_link(&metadata) => Ok(true),
        Ok(_) => Err("恢复清理路径不可安全访问".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn cleanup_file(db: &Connection, root: &Path, job: &RestoreFile) -> Result<()> {
    if !valid_operation(&job.operation)
        || !valid_id(&job.space)
        || !valid_id(&job.item)
        || !library_backup::valid_filename(&job.filename)
    {
        return Err("恢复清理记录包含无效路径".into());
    }
    let path = library_text::managed_path(root, &job.space, &job.item, &job.filename);
    let parent = path.parent().ok_or("恢复目录不存在")?;
    match fs::symlink_metadata(parent) {
        Ok(info) if info.is_dir() && !library_text::is_link(&info) => {}
        Ok(_) => return Err("恢复清理目录不可安全访问".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let temp = staging_path(&path, &job.operation, &job.item);
    if safe_file(&temp)? {
        let occupied: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_items WHERE id=?1)",
            [&job.item],
            |row| row.get(0),
        )?;
        // The staging link proves the destination belongs to this operation even after a crash.
        if !occupied && safe_file(&path)? && same_file::is_same_file(&temp, &path)? {
            fs::remove_file(&path)?;
        }
        fs::remove_file(temp)?;
    }
    let has_space: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_spaces WHERE id=?1)",
        [&job.space],
        |row| row.get(0),
    )?;
    if !has_space {
        match fs::remove_dir(parent) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub fn recover(db: &mut Connection, root: &Path, operation: Option<&str>) -> Result<usize> {
    if !root.is_absolute() {
        return Err("恢复清理根目录无效".into());
    }
    let root_key = root.to_str().ok_or("恢复清理路径无效")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let jobs = tx
        .prepare(
            "SELECT operation_id,space_id,item_id,filename FROM library_restore_files
         WHERE root=?1 AND (?2 IS NULL OR operation_id=?2)",
        )?
        .query_map(params![root_key, operation], |row| {
            Ok(RestoreFile {
                operation: row.get(0)?,
                space: row.get(1)?,
                item: row.get(2)?,
                filename: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut retained = 0;
    for job in jobs {
        match cleanup_file(&tx, root, &job) {
            Ok(()) => {
                tx.execute(
                "DELETE FROM library_restore_files WHERE root=?1 AND item_id=?2 AND operation_id=?3",
                params![root_key, job.item, job.operation],
            )?;
            }
            Err(error) => {
                eprintln!("Library restore file cleanup will retry: {error}");
                retained += 1;
            }
        }
    }
    tx.commit()?;
    Ok(retained)
}
