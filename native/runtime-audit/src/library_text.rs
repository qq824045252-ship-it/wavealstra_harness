use crate::Result;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{File, Metadata, OpenOptions, symlink_metadata},
    io::{BufWriter, ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
};

const READ_BYTES: usize = 64 * 1024;
pub(crate) const LARGE_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    path: PathBuf,
    staging_path: PathBuf,
    expected_size: u64,
    chunk_size: usize,
    overlap: usize,
    copy_to: Option<PathBuf>,
    #[serde(default)]
    refuse_markdown_links: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stage {
    Ready {
        content_hash: String,
        chunk_count: usize,
    },
    NeedsLinkRewrite,
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub(crate) fn open_managed(
    root: &Path,
    path: &Path,
    space_id: &str,
    item_id: &str,
) -> Result<Option<File>> {
    let mut components = path.strip_prefix(root)?.components();
    if !root.is_absolute()
        || !matches!(components.next(), Some(Component::Normal(space)) if space == space_id)
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || path.file_stem().is_none_or(|stem| stem != item_id)
    {
        return Err("managed library text path outside its space".into());
    }
    let parent = path.parent().ok_or("missing library space directory")?;
    let metadata = match symlink_metadata(parent) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if is_link(&metadata) || !metadata.is_dir() {
        return Err("managed library text directory is unsafe".into());
    }
    match symlink_metadata(path) {
        Ok(metadata) if is_link(&metadata) || !metadata.is_file() => {
            Err("managed library text file is unsafe".into())
        }
        Ok(_) => Ok(Some(File::open(path)?)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn managed_path(root: &Path, space_id: &str, item_id: &str, filename: &str) -> PathBuf {
    let mut leaf = OsString::from(item_id);
    if let Some(ext) = Path::new(filename).extension() {
        leaf.push(".");
        leaf.push(ext);
    }
    root.join(space_id).join(leaf)
}

pub(crate) fn validate_chunk_sizes(chunk_size: usize, overlap: usize) -> Result<()> {
    if !(200..=4000).contains(&chunk_size) || overlap > chunk_size / 2 {
        return Err("invalid library chunk configuration".into());
    }
    Ok(())
}

fn decode(bytes: &[u8], output: &mut Vec<u16>) -> usize {
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                output.extend(text.encode_utf16());
                return 0;
            }
            Err(error) => {
                let (valid, invalid) = rest.split_at(error.valid_up_to());
                output.extend(std::str::from_utf8(valid).unwrap().encode_utf16());
                let Some(length) = error.error_len() else {
                    return invalid.len();
                };
                output.push(0xfffd);
                rest = &invalid[length..];
            }
        }
    }
}

fn low_surrogate(units: &[u16], at: usize) -> bool {
    units
        .get(at)
        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
}

pub fn chunk_content(units: &[u16]) -> Result<Option<(String, String)>> {
    let text = String::from_utf16(units)?;
    if text.trim_matches(crate::javascript_whitespace).is_empty() {
        return Ok(None);
    }
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok(Some((text, hash[..16].to_owned())))
}

pub fn visit_windows(
    units: &[u16],
    chunk_size: usize,
    step: usize,
    mut visit: impl FnMut(&[u16], usize) -> Result<()>,
) -> Result<usize> {
    let mut start = 0;
    while units.len() - start > chunk_size {
        let end = start + chunk_size;
        visit(
            &units[start..end + usize::from(low_surrogate(units, end))],
            start,
        )?;
        start += step;
        if low_surrogate(units, start) {
            start -= 1;
        }
    }
    Ok(start)
}

pub fn stage(request: Request) -> Result<Stage> {
    validate_chunk_sizes(request.chunk_size, request.overlap)?;
    if !symlink_metadata(&request.path)?.is_file() {
        return Err("library source must be a regular file".into());
    }
    let mut file =
        File::open(&request.path).map_err(|error| format!("open library source: {error}"))?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() != request.expected_size {
        return Err("library source changed before indexing".into());
    }

    let mut copy = request
        .copy_to
        .as_ref()
        .map(|path| {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map(BufWriter::new)
                .map_err(|error| format!("create managed library copy: {error}"))
        })
        .transpose()?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&request.staging_path)
        .map_err(|error| format!("create library index stage: {error}"))?;
    let mut staging =
        Connection::open_with_flags(&request.staging_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    // This database is unpublished and can be discarded if the process is interrupted.
    staging.execute_batch(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
         CREATE TABLE chunks (
           chunk_index INTEGER PRIMARY KEY, content TEXT NOT NULL,
           char_offset INTEGER NOT NULL, hash TEXT NOT NULL
         );",
    )?;
    let transaction = staging.transaction()?;
    let mut insert = transaction.prepare("INSERT INTO chunks VALUES (?1,?2,?3,?4)")?;
    let mut chunk_count = 0;
    let write_chunk = |units: &[u16], offset: usize| -> Result<()> {
        if let Some((text, hash)) = chunk_content(units)? {
            insert.execute(params![chunk_count, text, offset, hash])?;
            chunk_count += 1;
        }
        Ok(())
    };

    let mut digest = Sha256::new();
    let mut previous_byte = None;
    let all_indexed = stream_document(
        &mut file,
        &before,
        request.chunk_size,
        request.overlap,
        |bytes| {
            if request.refuse_markdown_links
                && (previous_byte == Some(b']') && bytes.first() == Some(&b'(')
                    || bytes.windows(2).any(|pair| pair == b"]("))
            {
                return Ok(false);
            }
            previous_byte = bytes.last().copied();
            if let Some(target) = &mut copy {
                target.write_all(bytes)?;
            }
            digest.update(bytes);
            Ok(true)
        },
        write_chunk,
    )?;
    if !all_indexed {
        return Ok(Stage::NeedsLinkRewrite);
    }
    if let Some(target) = &mut copy {
        target.flush()?;
    }
    drop(insert);
    transaction.commit()?;
    Ok(Stage::Ready {
        content_hash: format!("{:x}", digest.finalize()),
        chunk_count,
    })
}

pub(crate) fn stream_document(
    file: &mut File,
    before: &Metadata,
    chunk_size: usize,
    overlap: usize,
    mut visit_bytes: impl FnMut(&[u8]) -> Result<bool>,
    mut visit_chunk: impl FnMut(&[u16], usize) -> Result<()>,
) -> Result<bool> {
    validate_chunk_sizes(chunk_size, overlap)?;
    let mut buffer = vec![0; READ_BYTES + 3];
    let mut carry = 0;
    let mut units = Vec::with_capacity(READ_BYTES + chunk_size);
    let mut offset = 0;
    let mut read_bytes = 0;
    let step = chunk_size - overlap;
    loop {
        let len = file.read(&mut buffer[carry..carry + READ_BYTES])?;
        if len == 0 {
            break;
        }
        read_bytes += len as u64;
        if read_bytes > before.len() {
            return Err("library source grew during indexing".into());
        }
        if !visit_bytes(&buffer[carry..carry + len])? {
            return Ok(false);
        }
        let total = carry + len;
        carry = decode(&buffer[..total], &mut units);
        buffer.copy_within(total - carry..total, 0);
        let start = visit_windows(&units, chunk_size, step, |window, start| {
            visit_chunk(window, offset + start)
        })?;
        units.drain(..start);
        offset += start;
    }
    units.extend(String::from_utf8_lossy(&buffer[..carry]).encode_utf16());
    visit_chunk(&units, offset)?;

    let after = file.metadata()?;
    if read_bytes != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err("library source changed during indexing".into());
    }
    Ok(true)
}
