use crate::workspace_preview;
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use same_file::Handle;
use serde::Serialize;
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STORED_BYTES: usize = (MAX_IMAGE_BYTES * 4).div_ceil(3) + 1024;
const IMAGE_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    Unavailable,
    Changed,
    TooLarge,
    Unsupported,
}

pub fn read(
    root: &Path,
    relative: &Path,
    managed: bool,
) -> Result<(Vec<u8>, &'static str), Failure> {
    let (handle, before, physical) =
        workspace_preview::open_file(root, relative, false).map_err(|_| Failure::Unavailable)?;
    let limit = if managed {
        MAX_STORED_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    if before.len() > limit as u64 {
        return Err(Failure::TooLarge);
    }

    let mut file = handle.as_file();
    let mut bytes = vec![0; before.len() as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| match error.kind() {
            ErrorKind::UnexpectedEof => Failure::Changed,
            _ => Failure::Unavailable,
        })?;
    let after = file.metadata().map_err(|_| Failure::Unavailable)?;
    let entry = if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let current = fs::canonicalize(entry).map_err(|_| Failure::Unavailable)?;
    let current_handle = Handle::from_path(&current).map_err(|_| Failure::Unavailable)?;
    // A sync client changing only the timestamp does not invalidate the image.
    if before.len() != after.len() || current != physical || current_handle != handle {
        return Err(Failure::Changed);
    }

    if managed {
        bytes = decode_managed(bytes).ok_or(Failure::Unsupported)?;
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Failure::TooLarge);
    }
    let mime = raster_mime(&bytes).ok_or(Failure::Unsupported)?;
    Ok((bytes, mime))
}

fn uri_whitespace(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

fn digit(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"+/".contains(&byte)
}

fn decode_managed(mut bytes: Vec<u8>) -> Option<Vec<u8>> {
    let raw = std::str::from_utf8(&bytes).ok()?;
    let trimmed_start = raw.trim_start_matches(uri_whitespace);
    let text = trimmed_start.trim_end_matches(uri_whitespace);
    let (header, body) = text.split_once(',')?;
    let (format, encoding) = header.split_once(';')?;
    let (prefix, kind) = format.split_once('/')?;
    if !prefix.eq_ignore_ascii_case("data:image")
        || !encoding.eq_ignore_ascii_case("base64")
        || !["png", "jpeg", "jpg", "gif", "webp", "bmp", "avif"]
            .iter()
            .any(|supported| supported.eq_ignore_ascii_case(kind))
        || body.is_empty()
        || !body
            .chars()
            .all(|c| uri_whitespace(c) || (c.is_ascii() && (digit(c as u8) || c == '=')))
    {
        return None;
    }
    let start = raw.len() - trimmed_start.len() + header.len() + 1;
    let end = body
        .as_bytes()
        .iter()
        .position(|&b| b == b'=')
        .unwrap_or(body.len());
    bytes.copy_within(start..start + end, 0);
    bytes.truncate(end);
    bytes.retain(|&b| digit(b));
    if bytes.len() % 4 == 1 {
        bytes.pop();
    }
    IMAGE_BASE64.decode(bytes).ok()
}

fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR" {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        Some("image/gif")
    } else if bytes.len() >= 16 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 16
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}
