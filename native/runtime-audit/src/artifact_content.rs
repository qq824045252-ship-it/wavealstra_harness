use crate::{
    Result,
    gadget_files::{
        collect_manifest, gadget_root, manifest_token, read_at_most, valid_windows_component,
    },
    gadget_source_save::recover_if_pending,
    library_text::is_link,
    remote_image, workspace_preview,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{Cursor, ErrorKind, Read as _, Seek, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OWNER: &str = ".mybuddy-artifact-write";
const MAX_READ_BYTES: usize = 20 * 1024 * 1024;
const CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Content {
    Text {
        content: String,
    },
    Gadget {
        root: PathBuf,
        id: String,
        entry: String,
        token: String,
    },
}

impl Content {
    pub fn bytes(self, db: &Connection, task_id: &str) -> Result<Vec<u8>> {
        match self {
            Self::Text { content } => Ok(content.into_bytes()),
            Self::Gadget {
                root,
                id,
                entry,
                token,
            } => {
                if !crate::workbench_data::task_can_access_gadget(db, &id, task_id)? {
                    return Err("Gadget 作用域已变化，无法导出".into());
                }
                recover_if_pending(db, &root, &id)?;
                let gadget = gadget_root(&root, &id)?;
                let manifest = collect_manifest(&gadget)?.ok_or("Gadget 配置超过读取限制")?;
                if manifest_token(&manifest) != token {
                    return Err("Gadget 配置已变化，请重新导出".into());
                }
                let code = physical_directory(&gadget.join("code"), &gadget)?;
                if entry.split('/').any(|part| !valid_windows_component(part)) {
                    return Err("Gadget 入口路径无效".into());
                }
                let source = fs::canonicalize(code.join(&entry))
                    .map_err(|_| format!("Gadget 入口不存在：{entry}"))?;
                if !source.starts_with(&code) || !fs::metadata(&source)?.is_file() {
                    return Err(format!("Gadget 入口符号链接越界或不是文件：{entry}").into());
                }
                let bytes = fs::read(source)?;
                match String::from_utf8(bytes) {
                    Ok(text) => Ok(text.into_bytes()),
                    Err(error) => Ok(String::from_utf8_lossy(error.as_bytes())
                        .into_owned()
                        .into_bytes()),
                }
            }
        }
    }
}

pub struct Pending {
    directory: PathBuf,
    task: PathBuf,
}

impl Pending {
    pub fn prepare(
        root: &Path,
        relative: &str,
        task_id: &str,
        artifact_id: &str,
        operation_id: &str,
    ) -> Result<(Self, PathBuf)> {
        let [task, artifact, entry] = artifact_components(relative)?;
        if task != task_id || artifact != artifact_id {
            return Err("成果目录与任务或成果 ID 不一致".into());
        }
        if !root.is_absolute() {
            return Err("成果存储目录必须是绝对路径".into());
        }
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let task = root.join(task);
        ensure_folder(&task)?;
        let task = physical_directory(&task, &root)?;
        let directory = task.join(artifact);
        match fs::create_dir(&directory) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                physical_directory(&directory, &task)?;
                // An interrupted reservation can leave an empty directory before the marker is written.
                let marker = directory.join(OWNER);
                if fs::read_dir(&directory)?.next().is_some() {
                    let info = fs::symlink_metadata(&marker)?;
                    if !info.is_file()
                        || is_link(&info)
                        || info.len() != operation_id.len() as u64
                        || fs::read(&marker)? != operation_id.as_bytes()
                    {
                        return Err("成果目录已存在".into());
                    }
                    fs::remove_dir_all(&directory)?;
                    fs::create_dir(&directory)?;
                }
            }
            Err(error) => return Err(error.into()),
        }
        let target = directory.join(entry);
        let pending = Self { directory, task };
        if let Err(error) = write_new(&pending.directory.join(OWNER), operation_id.as_bytes()) {
            pending.discard();
            return Err(error);
        }
        Ok((pending, target))
    }

    pub fn finish(self) {
        let _ = fs::remove_file(self.directory.join(OWNER));
    }

    pub fn discard(self) {
        if let Err(error) = fs::remove_dir_all(&self.directory) {
            eprintln!("[Artifact] incomplete content cleanup deferred: {error}");
        }
        let _ = fs::remove_dir(&self.task);
    }
}

fn artifact_components(relative: &str) -> Result<[&str; 3]> {
    let path = Path::new(relative);
    let mut parts = path.components();
    let mut names = [""; 3];
    for name in &mut names {
        let Some(Component::Normal(part)) = parts.next() else {
            return Err("成果路径不在受管目录内".into());
        };
        *name = part
            .to_str()
            .filter(|part| valid_windows_component(part))
            .ok_or("成果路径不在受管目录内")?;
    }
    if parts.next().is_some() || !names[2].starts_with("index.") {
        return Err("成果路径不在受管目录内".into());
    }
    Ok(names)
}

fn ensure_folder(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn physical_directory(path: &Path, root: &Path) -> Result<PathBuf> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() || is_link(&info) {
        return Err("成果目录必须是真实文件夹，不能是符号链接".into());
    }
    let real = fs::canonicalize(path)?;
    if !real.starts_with(root) {
        return Err("成果目录越界".into());
    }
    Ok(real)
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Read {
    Content {
        base64: String,
    },
    Chunk {
        base64: String,
        done: bool,
    },
    #[serde(rename_all = "camelCase")]
    Opened {
        bytes: u64,
        modified_ms: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    ImageOpened {
        mime_type: String,
    },
    #[serde(rename_all = "camelCase")]
    RemoteImageOpened {
        mime_type: &'static str,
        bytes: usize,
    },
    RemoteImageRejected {
        failure: remote_image::Failure,
    },
    Raster,
    Missing,
    NeedsHost,
    Failed {
        message: String,
    },
}

#[derive(Default)]
pub struct Reads(HashMap<String, ActiveRead>);

enum ActiveRead {
    File(OpenContent),
    ValidatedImage(Cursor<Vec<u8>>),
}

impl ActiveRead {
    fn chunk(&mut self) -> Result<Read> {
        match self {
            Self::File(file) => file.chunk(),
            Self::ValidatedImage(image) => {
                let bytes = image.get_ref();
                let start = image.position() as usize;
                let end = (start + CHUNK_BYTES).min(bytes.len());
                let part = Read::Chunk {
                    base64: STANDARD.encode(&bytes[start..end]),
                    done: end == bytes.len(),
                };
                image.set_position(end as u64);
                Ok(part)
            }
        }
    }
}

struct OpenContent {
    file: File,
    length: u64,
    modified: Option<SystemTime>,
    remaining: u64,
    body: Body,
}

enum Body {
    Raw,
    Base64(Vec<u8>),
}

impl OpenContent {
    fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let info = file.metadata()?;
        if !info.is_file() {
            return Err("成果内容必须是受管目录中的普通文件".into());
        }
        Ok(Self::from_file(file, info))
    }

    fn from_file(file: File, info: Metadata) -> Self {
        Self {
            file,
            length: info.len(),
            modified: info.modified().ok(),
            remaining: info.len(),
            body: Body::Raw,
        }
    }

    fn check_unchanged(&self) -> Result<()> {
        let info = self.file.metadata()?;
        if info.len() != self.length || info.modified().ok() != self.modified {
            return Err("成果内容已变化，请重新读取".into());
        }
        Ok(())
    }

    fn chunk(&mut self) -> Result<Read> {
        self.check_unchanged()?;
        let count = self.remaining.min(CHUNK_BYTES as u64) as usize;
        let mut bytes = match &mut self.body {
            Body::Raw => Vec::new(),
            Body::Base64(carry) => std::mem::take(carry),
        };
        let start = bytes.len();
        bytes.resize(start + count, 0);
        self.file.read_exact(&mut bytes[start..])?;
        self.check_unchanged()?;
        self.remaining -= count as u64;
        let base64 = match &mut self.body {
            Body::Raw => STANDARD.encode(bytes),
            Body::Base64(carry) => {
                // Match Buffer.from on standard and URL-safe payloads. A padding
                // character ends the data, and separators don't count as digits.
                if let Some(end) = bytes.iter().position(|&byte| byte == b'=') {
                    bytes.truncate(end);
                    self.remaining = 0;
                }
                bytes.retain(|byte| byte.is_ascii_alphanumeric() || b"+/-_".contains(byte));
                if self.remaining != 0 {
                    *carry = bytes.split_off(bytes.len() / 4 * 4);
                }
                String::from_utf8(bytes)?
            }
        };
        Ok(Read::Chunk {
            base64,
            done: self.remaining == 0,
        })
    }

    fn base64_data_uri(&mut self) -> Result<Option<String>> {
        const HEADER_LIMIT: u64 = 4096;
        self.check_unchanged()?;
        let mut header = vec![0; self.length.min(HEADER_LIMIT) as usize];
        self.file.read_exact(&mut header)?;
        self.check_unchanged()?;
        let Some(comma) = header.iter().position(|&byte| byte == b',') else {
            return Ok(None);
        };
        let Ok(label) = std::str::from_utf8(&header[..comma]) else {
            return Ok(None);
        };
        let label = label.trim_start_matches(|c: char| {
            c == '\u{feff}' || c.is_ascii_whitespace() || c == '\u{b}'
        });
        let Some((mime, encoding)) = label.get(5..).and_then(|label| label.split_once(';')) else {
            return Ok(None);
        };
        if !label[..5].eq_ignore_ascii_case("data:")
            || !encoding.eq_ignore_ascii_case("base64")
            || !mime.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Ok(None);
        }
        let data_start = (comma + 1) as u64;
        self.file.seek(std::io::SeekFrom::Start(data_start))?;
        self.remaining = self.length - data_start;
        self.body = Body::Base64(Vec::new());
        Ok(Some(if mime.is_empty() {
            "application/octet-stream".into()
        } else {
            mime.into()
        }))
    }

    fn inline_raster(&mut self) -> Result<bool> {
        const PREFIXES: [&[u8]; 7] = [
            b"data:image/png;base64,",
            b"data:image/jpeg;base64,",
            b"data:image/gif;base64,",
            b"data:image/webp;base64,",
            b"data:image/bmp;base64,",
            b"data:image/avif;base64,",
            b"data:image/x-icon;base64,",
        ];
        self.check_unchanged()?;
        let mut header = [0; 32];
        let head = &mut header[..self.length.min(32) as usize];
        self.file.read_exact(head)?;
        self.check_unchanged()?;
        if PREFIXES.iter().any(|prefix| {
            head.get(..prefix.len())
                .is_some_and(|bytes| bytes.eq_ignore_ascii_case(prefix))
        }) {
            return Ok(true);
        }
        self.file.rewind()?;
        Ok(false)
    }
}

impl Reads {
    pub fn start(
        &mut self,
        root: &Path,
        relative: &str,
        cursor: Option<String>,
        inline_raster: bool,
    ) -> Read {
        read_result(self.open(root, relative, cursor, inline_raster))
    }

    pub fn start_workspace(
        &mut self,
        root: &Path,
        relative: &Path,
        cursor: Option<String>,
    ) -> Read {
        read_result(self.open_workspace(root, relative, cursor))
    }

    pub fn start_image(&mut self, root: &Path, relative: &str, cursor: Option<String>) -> Read {
        read_result(self.open_image(root, relative, cursor))
    }

    fn open_image(&mut self, root: &Path, relative: &str, cursor: Option<String>) -> Result<Read> {
        if !root.is_absolute() {
            return Ok(Read::NeedsHost);
        }
        let Some(target) = content_path(root, relative)? else {
            return Ok(Read::Missing);
        };
        let mut image = OpenContent::open(&target)?;
        let Some(mime_type) = image.base64_data_uri()? else {
            return Ok(Read::NeedsHost);
        };
        if let Some(cursor) = cursor {
            if self.0.contains_key(&cursor) {
                return Err("成果读取标识已存在".into());
            }
            self.0.insert(cursor, ActiveRead::File(image));
        }
        Ok(Read::ImageOpened { mime_type })
    }

    pub fn start_remote_image(
        &mut self,
        root: &Path,
        relative: &Path,
        managed: bool,
        cursor: Option<String>,
    ) -> Read {
        let (image, mime_type) = match remote_image::read(root, relative, managed) {
            Ok(image) => image,
            Err(failure) => return Read::RemoteImageRejected { failure },
        };
        let bytes = image.len();
        if let Some(cursor) = cursor {
            if self.0.contains_key(&cursor) {
                return Read::RemoteImageRejected {
                    failure: remote_image::Failure::Unavailable,
                };
            }
            self.0
                .insert(cursor, ActiveRead::ValidatedImage(Cursor::new(image)));
        }
        Read::RemoteImageOpened { mime_type, bytes }
    }

    fn open_workspace(
        &mut self,
        root: &Path,
        relative: &Path,
        cursor: Option<String>,
    ) -> Result<Read> {
        let (handle, info, _) = workspace_preview::open_file(root, relative, false)?;
        let opened = Read::Opened {
            bytes: info.len(),
            modified_ms: info.modified().ok().map(|modified| {
                match modified.duration_since(UNIX_EPOCH) {
                    Ok(duration) => duration.as_secs_f64() * 1_000.0,
                    Err(error) => -error.duration().as_secs_f64() * 1_000.0,
                }
            }),
        };
        if let Some(cursor) = cursor {
            if self.0.contains_key(&cursor) {
                return Err("成果读取标识已存在".into());
            }
            self.0.insert(
                cursor,
                ActiveRead::File(OpenContent::from_file(handle.as_file().try_clone()?, info)),
            );
        }
        Ok(opened)
    }

    fn open(
        &mut self,
        root: &Path,
        relative: &str,
        cursor: Option<String>,
        inline_raster: bool,
    ) -> Result<Read> {
        if !root.is_absolute() {
            return Ok(Read::NeedsHost);
        }
        let Some(target) = content_path(root, relative)? else {
            return Ok(Read::Missing);
        };
        if let Some(cursor) = cursor {
            if self.0.contains_key(&cursor) {
                return Err("成果读取标识已存在".into());
            }
            let mut open = OpenContent::open(&target)?;
            if inline_raster && open.inline_raster()? {
                return Ok(Read::Raster);
            }
            let first = open.chunk()?;
            if let Read::Chunk { base64, done: true } = first {
                return Ok(Read::Content { base64 });
            }
            self.0.insert(cursor, ActiveRead::File(open));
            return Ok(first);
        }

        // Requests from older hosts still use the bounded single-response contract.
        if fs::metadata(&target)?.len() > MAX_READ_BYTES as u64 {
            return Ok(Read::NeedsHost);
        }
        let bytes = read_at_most(&target, MAX_READ_BYTES)?;
        if bytes.len() > MAX_READ_BYTES {
            return Ok(Read::NeedsHost);
        }
        Ok(Read::Content {
            base64: STANDARD.encode(bytes),
        })
    }

    pub fn next(&mut self, cursor: &str) -> Read {
        let Some(open) = self.0.get_mut(cursor) else {
            return Read::Failed {
                message: "成果读取已关闭，请重新打开".into(),
            };
        };
        let result = open.chunk();
        if !matches!(result, Ok(Read::Chunk { done: false, .. })) {
            self.close(cursor);
        }
        result.unwrap_or_else(|error| Read::Failed {
            message: error.to_string(),
        })
    }

    pub fn close(&mut self, cursor: &str) {
        self.0.remove(cursor);
    }
}

fn read_result(result: Result<Read>) -> Read {
    match result {
        Ok(read) => read,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            Read::Missing
        }
        Err(error) => Read::Failed {
            message: error.to_string(),
        },
    }
}

fn content_path(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let mut parts = Path::new(relative).components().peekable();
    if parts.peek().is_none()
        || parts.clone().any(|part| {
            !matches!(part, Component::Normal(name) if name.to_str().is_some_and(|name|
            !name.contains('\0') && (!cfg!(windows) || valid_windows_component(name))))
        })
    {
        return Ok(None);
    }
    let root = fs::canonicalize(root)?;
    let mut target = root.clone();
    while let Some(Component::Normal(part)) = parts.next() {
        target.push(part);
        if parts.peek().is_some() {
            target = physical_directory(&target, &root)?;
        }
    }
    let info = fs::symlink_metadata(&target)?;
    if is_link(&info) {
        return Err("成果内容必须是受管目录中的普通文件".into());
    }
    if !info.is_file() {
        return Ok(None);
    }
    Ok(Some(target))
}
