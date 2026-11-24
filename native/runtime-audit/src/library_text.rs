use crate::Result;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions, symlink_metadata},
    io::{BufWriter, Read, Write},
    path::PathBuf,
};

const READ_BYTES: usize = 64 * 1024;

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
    if !(200..=4000).contains(&request.chunk_size) || request.overlap > request.chunk_size / 2 {
        return Err("invalid library chunk configuration".into());
    }
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
    let mut write_chunk = |units: &[u16], offset: usize| -> Result<()> {
        if let Some((text, hash)) = chunk_content(units)? {
            insert.execute(params![chunk_count, text, offset, hash])?;
            chunk_count += 1;
        }
        Ok(())
    };

    let mut digest = Sha256::new();
    let mut buffer = vec![0; READ_BYTES + 3];
    let mut carry = 0;
    let mut units = Vec::with_capacity(READ_BYTES + request.chunk_size);
    let mut offset = 0;
    let mut read_bytes = 0;
    let mut previous_byte = None;
    let step = request.chunk_size - request.overlap;
    loop {
        let len = file.read(&mut buffer[carry..carry + READ_BYTES])?;
        if len == 0 {
            break;
        }
        read_bytes += len as u64;
        if read_bytes > request.expected_size {
            return Err("library source grew during indexing".into());
        }
        let bytes = &buffer[carry..carry + len];
        if request.refuse_markdown_links
            && (previous_byte == Some(b']') && bytes.first() == Some(&b'(')
                || bytes.windows(2).any(|pair| pair == b"]("))
        {
            return Ok(Stage::NeedsLinkRewrite);
        }
        previous_byte = bytes.last().copied();
        if let Some(target) = &mut copy {
            target.write_all(bytes)?;
        }
        digest.update(bytes);
        let total = carry + len;
        carry = decode(&buffer[..total], &mut units);
        buffer.copy_within(total - carry..total, 0);
        let start = visit_windows(&units, request.chunk_size, step, |window, start| {
            write_chunk(window, offset + start)
        })?;
        units.drain(..start);
        offset += start;
    }
    units.extend(String::from_utf8_lossy(&buffer[..carry]).encode_utf16());
    write_chunk(&units, offset)?;

    let after = file.metadata()?;
    if read_bytes != request.expected_size
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err("library source changed during indexing".into());
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
