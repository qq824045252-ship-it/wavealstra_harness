use crate::{Result, gadget_files::valid_windows_component, library_text::is_link};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    io::{Error, ErrorKind, Read},
    path::{Component, Path, PathBuf},
};

const TEXT_LIMIT: usize = 256 * 1024;
const JPEG_HEADER_LIMIT: u64 = 128 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    ImageHeader,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Preview {
    Text {
        content: String,
        bytes: u64,
        truncated: bool,
    },
    ImageHeader {
        base64: String,
        bytes: u64,
    },
    Missing,
    Failed {
        message: String,
    },
}

pub fn read(root: &Path, relative: &Path, kind: Kind) -> Preview {
    match preview(root, relative, kind) {
        Ok(preview) => preview,
        Err(error)
            if error
                .downcast_ref::<Error>()
                .is_some_and(|e| e.kind() == ErrorKind::NotFound) =>
        {
            Preview::Missing
        }
        Err(error) => Preview::Failed {
            message: error.to_string(),
        },
    }
}

fn preview(root: &Path, relative: &Path, kind: Kind) -> Result<Preview> {
    let (file, info, _) = open_file(root, relative, matches!(kind, Kind::Text))?;
    let bytes = info.len();
    let mut file = file.as_file();
    match kind {
        Kind::Text => {
            let mut buffer = Vec::new();
            file.take((TEXT_LIMIT + 1) as u64)
                .read_to_end(&mut buffer)?;
            let truncated = buffer.len() > TEXT_LIMIT;
            buffer.truncate(TEXT_LIMIT);
            let content = match std::str::from_utf8(&buffer) {
                Ok(text) => text,
                Err(error) if truncated && error.error_len().is_none() => {
                    std::str::from_utf8(&buffer[..error.valid_up_to()])?
                }
                Err(_) => return Err("文件不是有效的 UTF-8 文本，无法内置预览".into()),
            };
            if content.contains('\0') {
                return Err("文件包含二进制内容，无法内置预览".into());
            }
            Ok(Preview::Text {
                content: content.strip_prefix('\u{feff}').unwrap_or(content).into(),
                bytes,
                truncated,
            })
        }
        Kind::ImageHeader => {
            let mut header = Vec::new();
            file.by_ref().take(32).read_to_end(&mut header)?;
            if header.starts_with(&[0xff, 0xd8]) {
                file.take(JPEG_HEADER_LIMIT - header.len() as u64)
                    .read_to_end(&mut header)?;
            }
            Ok(Preview::ImageHeader {
                base64: STANDARD.encode(header),
                bytes,
            })
        }
    }
}

pub(crate) fn open_file(
    root: &Path,
    relative: &Path,
    reject_file_link: bool,
) -> Result<(Handle, Metadata, PathBuf)> {
    if !root.is_absolute()
        || relative.components().any(|part| {
            !matches!(part, Component::Normal(name) if name.to_str().is_some_and(|name|
                !name.contains('\0') && (!cfg!(windows) || valid_windows_component(name))))
        })
    {
        return Err("文件不在当前工作区内".into());
    }
    let target = if relative.as_os_str().is_empty() {
        root.to_owned()
    } else {
        root.join(relative)
    };
    let root = fs::canonicalize(root)?;
    let real = fs::canonicalize(&target)?;
    if !real.starts_with(&root) {
        return Err("文件不在当前工作区内".into());
    }
    let info = fs::symlink_metadata(&target)?;
    if (reject_file_link && is_link(&info)) || !fs::metadata(&real)?.is_file() {
        return Err("不是普通文件".into());
    }
    let file = Handle::from_file(File::open(&real)?)?;
    let info = file.as_file().metadata()?;
    if !info.is_file() {
        return Err("不是普通文件".into());
    }
    if fs::canonicalize(&target)? != real || Handle::from_path(&real)? != file {
        return Err("文件路径已变化，请重新打开".into());
    }
    Ok((file, info, real))
}
