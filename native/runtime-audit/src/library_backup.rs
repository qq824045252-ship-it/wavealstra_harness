use crate::{
    Result, javascript_whitespace, library_metadata::ITEMS, library_text, sqlite_rows::records,
};
use base64::{engine::general_purpose::STANDARD, write::EncoderWriter};
use flate2::{Compression, write::GzEncoder};
use rusqlite::{Connection, DatabaseName};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path},
};

pub(crate) const BACKUP_LIMIT: usize = 256 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Owner {
    Personal,
    Project { project_id: String },
    Workspace { workspace_id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Saved,
    TooLarge,
    SourceUnavailable,
    InvalidMetadata,
}

pub(crate) fn spaces(db: &Connection, owner: &Owner) -> Result<Vec<String>> {
    let (condition, owner_id) = match owner {
        Owner::Personal => (
            "coalesce(project_id,'')='' AND coalesce(workspace_id,'')=''",
            None,
        ),
        Owner::Project { project_id } => (
            "project_id=?1 AND EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            Some(project_id.as_str()),
        ),
        Owner::Workspace { workspace_id } => (
            "workspace_id=?1 AND EXISTS(SELECT 1 FROM spaces WHERE id=?1)",
            Some(workspace_id.as_str()),
        ),
    };
    let mut query = db.prepare(&format!(
        "SELECT id FROM library_spaces WHERE {condition} ORDER BY CASE kind WHEN 'personal' THEN 0 ELSE 1 END,created_at,rowid",
    ))?;
    let map = |row: &rusqlite::Row<'_>| row.get::<_, String>(0);
    Ok(if let Some(id) = owner_id {
        query
            .query_map([id.trim_matches(javascript_whitespace)], map)?
            .collect::<rusqlite::Result<_>>()?
    } else {
        query.query_map([], map)?.collect::<rusqlite::Result<_>>()?
    })
}

struct ArchiveWriter<W> {
    inner: W,
    bytes: usize,
    exceeded: bool,
}

impl<W: Write> Write for ArchiveWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > BACKUP_LIMIT - self.bytes {
            self.exceeded = true;
            return Err(io::Error::other("library backup exceeds size limit"));
        }
        let written = self.inner.write(bytes)?;
        self.bytes += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write> ArchiveWriter<W> {
    fn write_body(&mut self, input: &mut impl Read, len: u64) -> io::Result<()> {
        if len.div_ceil(3).saturating_mul(4).saturating_add(2) > (BACKUP_LIMIT - self.bytes) as u64
        {
            self.exceeded = true;
            return Err(io::Error::other("library backup exceeds size limit"));
        }
        self.write_all(b"\"")?;
        let mut encoder = EncoderWriter::new(&mut *self, &STANDARD);
        let copied = io::copy(&mut input.take(len + 1), &mut encoder)?;
        encoder.finish()?;
        drop(encoder);
        if copied != len {
            return Err(io::Error::other("library backup source size changed"));
        }
        self.write_all(b"\"")
    }
}

fn item_fields(row: &Value) -> Result<Value> {
    let mut fields = Map::new();
    for (column, key) in [
        ("id", "id"),
        ("space_id", "spaceId"),
        ("collection_id", "collectionId"),
        ("kind", "kind"),
        ("title", "title"),
        ("filename", "filename"),
        ("mime_type", "mimeType"),
        ("size_bytes", "sizeBytes"),
        ("owner", "owner"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
        ("last_visited_at", "lastVisitedAt"),
    ] {
        fields.insert(key.into(), row[column].clone());
    }
    for (column, key) in [
        ("url", "url"),
        ("source_type", "sourceType"),
        ("content_hash", "contentHash"),
        ("trashed_at", "trashedAt"),
    ] {
        if !row[column].is_null() {
            fields.insert(key.into(), row[column].clone());
        }
    }
    fields.insert(
        "favorite".into(),
        Value::Bool(row["favorite"].as_i64().unwrap_or(0) != 0),
    );
    if let Some(metadata) = row["note_metadata"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        let metadata: Value = serde_json::from_str(metadata)?;
        for key in ["tags", "pinned"] {
            if let Some(value) = metadata.get(key) {
                fields.insert(key.into(), value.clone());
            }
        }
        if let Some(clip) = metadata.get("clipSource").and_then(Value::as_object) {
            let allowed: Map<String, Value> = ["title", "url", "capturedAt", "failedImages"]
                .into_iter()
                .filter_map(|key| clip.get(key).map(|value| (key.into(), value.clone())))
                .collect();
            fields.insert("clipSource".into(), Value::Object(allowed));
        }
    }
    Ok(Value::Object(fields))
}

pub(crate) fn valid_filename(filename: &str) -> bool {
    !filename.is_empty()
        && !filename
            .bytes()
            .any(|byte| byte < 0x20 || matches!(byte, b'/' | b'\\' | b':'))
}

pub(crate) fn valid_mime(mime: &str) -> bool {
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let (kind, parameter) = mime
        .split_once(';')
        .map_or((mime, None), |(kind, parameter)| (kind, Some(parameter)));
    !kind.is_empty()
        && kind
            .bytes()
            .all(|byte| word(byte) || matches!(byte, b'.' | b'+' | b'/' | b'-'))
        && parameter.is_none_or(|value| {
            value
                .strip_prefix(' ')
                .unwrap_or(value)
                .strip_prefix("charset=")
                .is_some_and(|charset| {
                    !charset.is_empty() && charset.bytes().all(|byte| word(byte) || byte == b'-')
                })
        })
}

fn open_history(root: &Path, path: &Path) -> Option<File> {
    let relative = path.strip_prefix(root).ok()?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        let Component::Normal(part) = part else {
            return None;
        };
        current.push(part);
        if library_text::is_link(&fs::symlink_metadata(&current).ok()?) {
            return None;
        }
    }
    if current != root && fs::metadata(&current).ok()?.is_file() {
        return File::open(&current).ok();
    }
    None
}

fn write_version_body(
    out: &mut ArchiveWriter<impl Write>,
    mut input: impl Read + Seek,
    size: u64,
    expected_hash: &str,
) -> Result<()> {
    // A valid snapshot cannot fit when its base64 alone exceeds the archive limit.
    // Verify historical content first because a mismatched snapshot is exported as null.
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0;
    while total <= size {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        digest.update(&buffer[..n]);
    }
    if total == size && format!("{:x}", digest.finalize()) == expected_hash {
        input.seek(SeekFrom::Start(0))?;
        out.write_body(&mut input, size)?;
    } else {
        out.write_all(b"null")?;
    }
    Ok(())
}

fn write_history(
    db: &Connection,
    root: &Path,
    item_id: &str,
    out: &mut ArchiveWriter<impl Write>,
) -> Result<()> {
    let versions = records(db,
        "SELECT id,version,content_hash AS contentHash,created_by AS createdBy,created_at AS createdAt,
                rowid,path,snapshot IS NOT NULL AS has_snapshot
         FROM library_versions WHERE item_id=?1 ORDER BY version DESC",
        [item_id],
    )?;
    out.write_all(b"[")?;
    for (index, version) in versions.iter().enumerate() {
        if index > 0 {
            out.write_all(b",")?;
        }
        out.write_all(b"{")?;
        for key in ["id", "version", "contentHash", "createdBy", "createdAt"] {
            serde_json::to_writer(&mut *out, key)?;
            out.write_all(b":")?;
            serde_json::to_writer(&mut *out, &version[key])?;
            out.write_all(b",")?;
        }
        out.write_all(b"\"body\":")?;
        let hash = version["contentHash"]
            .as_str()
            .ok_or("invalid library version hash")?;
        if version["has_snapshot"].as_i64() == Some(1) {
            let rowid = version["rowid"]
                .as_i64()
                .ok_or("missing library snapshot")?;
            let snapshot = db.blob_open(
                DatabaseName::Main,
                "library_versions",
                "snapshot",
                rowid,
                true,
            )?;
            let len = snapshot.len();
            write_version_body(out, snapshot, len as u64, hash)?;
        } else if let Some(file) = version["path"]
            .as_str()
            .and_then(|path| open_history(root, Path::new(path)))
        {
            let len = file.metadata()?.len();
            write_version_body(out, file, len, hash)?;
        } else {
            out.write_all(b"null")?;
        }
        out.write_all(b"}")?;
    }
    out.write_all(b"]")?;
    Ok(())
}

fn write_archive(
    db: &Connection,
    root: &Path,
    spaces: &[String],
    out: &mut ArchiveWriter<impl Write>,
) -> Result<Status> {
    out.write_all(b"{\"format\":\"mybuddy-notes\",\"version\":1,\"folders\":[")?;
    let mut first = true;
    for id in spaces {
        for folder in records(db,
            "SELECT id,space_id AS spaceId,parent_id AS parentId,name,owner,created_at AS createdAt,updated_at AS updatedAt
             FROM library_collections WHERE space_id=?1 ORDER BY name COLLATE NOCASE,rowid",
            [id],
        )? {
            if !first {
                out.write_all(b",")?;
            }
            first = false;
            serde_json::to_writer(&mut *out, &folder)?;
        }
    }
    out.write_all(b"],\"items\":[")?;
    first = true;
    for space in spaces {
        for row in records(
            db,
            &format!(
                "SELECT {ITEMS} FROM library_items WHERE space_id=?1 ORDER BY title COLLATE NOCASE,rowid",
            ),
            [space],
        )? {
            if !first {
                out.write_all(b",")?;
            }
            first = false;
            let id = row["id"].as_str().ok_or("missing library item ID")?;
            let filename = row["filename"].as_str().ok_or("missing library filename")?;
            if !valid_filename(filename) || !row["mime_type"].as_str().is_some_and(valid_mime) {
                return Ok(Status::InvalidMetadata);
            }
            out.write_all(b"{\"item\":")?;
            serde_json::to_writer(&mut *out, &item_fields(&row)?)?;
            out.write_all(b",\"body\":")?;
            if row["kind"].as_str() == Some("url") {
                out.write_all(b"null")?;
            } else {
                let path = library_text::managed_path(root, space, id, filename);
                let Ok(Some(mut file)) = library_text::open_managed(root, &path, space, id) else {
                    return Ok(Status::SourceUnavailable);
                };
                let before = file.metadata()?;
                out.write_body(&mut file, before.len())?;
                let after = file.metadata()?;
                if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
                    return Ok(Status::SourceUnavailable);
                }
            }
            out.write_all(b",\"history\":")?;
            write_history(db, root, id, out)?;
            out.write_all(b"}")?;
        }
    }
    out.write_all(b"]}")?;
    Ok(Status::Saved)
}

pub fn export(db: &Connection, root: &Path, owner: Owner, staging: &Path) -> Result<Status> {
    if !root.is_absolute() || !staging.is_absolute() {
        return Err("library backup requires absolute paths".into());
    }
    let spaces = spaces(db, &owner)?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(staging)?;
    let mut out = ArchiveWriter {
        inner: GzEncoder::new(BufWriter::new(file), Compression::default()),
        bytes: 0,
        exceeded: false,
    };
    let result = write_archive(db, root, &spaces, &mut out);
    if out.exceeded {
        return Ok(Status::TooLarge);
    }
    let status = result?;
    if matches!(status, Status::Saved) {
        out.inner.finish()?.into_inner()?.sync_all()?;
    }
    Ok(status)
}
